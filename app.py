#!/usr/bin/env python3
"""
VOD AIGC Chat Web UI - Flask Backend
Proxies chat requests to Tencent Cloud VOD AIGC API and returns
the full response including token usage.
"""

import html
import json
import os
import re
import time
import requests
from claude_bridge import is_claude, call_messages, stream_messages
from flask import Flask, render_template, request, jsonify, Response, stream_with_context, url_for

app = Flask(__name__)

# -------------------------------------------------------------
# Cache-busting for static assets.
#
# Problem: 배포 후 사용자가 일반 새로고침만 하면 브라우저가 캐시된 옛
# JS/CSS를 그대로 써서 새 기능이 안 보임 → "Cmd+Shift+R 권장" 안내가
#필요했음. 그러나 hard reload는 사용자에게 번거롭다.
#
# Solution: url_for('static', filename=...) 결과에 ?v=<mtime>을 자동으로
# 부착한다. 파일이 바뀌면 mtime이 달라져 query string이 갱신되고,
# 브라우저는 그걸 다른 리소스로 인식해 즉시 새로 받는다. 일반 새로고침
# (F5 / Cmd+R)만으로도 새 코드가 적용된다.
#
# localStorage / cookies / 세션은 URL 쿼리에 영향을 받지 않으므로 사용자
# 데이터는 100% 보존된다.
# -------------------------------------------------------------
@app.context_processor
def _override_url_for():
    return dict(url_for=_dated_url_for)

def _dated_url_for(endpoint, **values):
    if endpoint == 'static':
        filename = values.get('filename')
        if filename:
            try:
                full_path = os.path.join(app.static_folder, filename)
                mtime = int(os.path.getmtime(full_path))
                values.setdefault('v', mtime)
            except (OSError, TypeError):
                pass
    return url_for(endpoint, **values)

# ---- File upload for image references ----
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


# ---- COS client (lazy) for reference-image uploads ----
# image-to-image / image-to-video reference images need a publicly reachable
# URL because Tencent MPS fetches the image from the open internet. A private
# or LAN-only address cannot be resolved by MPS and fails with
# `ImageDownloadFailure`.
#
# We therefore upload to your own COS bucket and hand MPS a *pre-signed* URL
# (valid 1 hour). This avoids requiring the bucket itself to be public —
# MPS only needs to be able to fetch within that signed window.
_cos_client = None

# Bucket used specifically for staging reference images (image-to-image /
# image-to-video). MPS fetches the image over the public internet, so this
# must be a COS bucket you own.
# !!! SECURITY: set these via environment variables. Defaults left BLANK on
#     purpose so nothing identifiable ships in the source.
#     e.g. AIGC_REF_BUCKET="your-bucket-1250000000"  AIGC_REF_REGION="ap-seoul"
REF_COS_BUCKET = os.environ.get("AIGC_REF_BUCKET", "")   # e.g. "your-bucket-<APPID>"
REF_COS_REGION = os.environ.get("AIGC_REF_REGION", "")   # e.g. "ap-seoul"
REF_COS_PATH   = os.environ.get("AIGC_REF_PATH",   "aigc-playground/uploads")
REF_URL_EXPIRES_SECONDS = 3600     # 1h is plenty for MPS to download

def _get_cos_client():
    global _cos_client
    if _cos_client is not None:
        return _cos_client
    try:
        from qcloud_cos import CosConfig, CosS3Client
        secret_id  = os.environ.get("TENCENTCLOUD_SECRET_ID", "")
        secret_key = os.environ.get("TENCENTCLOUD_SECRET_KEY", "")
        if not secret_id or not secret_key:
            return None
        cfg = CosConfig(Region=REF_COS_REGION, SecretId=secret_id, SecretKey=secret_key)
        _cos_client = CosS3Client(cfg)
        return _cos_client
    except Exception as e:
        print(f"[cos] init failed: {e}")
        return None


def _upload_to_cos(local_path: str, remote_filename: str):
    """Upload a local file to COS and return a publicly fetchable URL.

    Strategy: PUT into our own bucket (ACL untouched — bucket may be private),
    then issue a 1-hour pre-signed GET URL for MPS to fetch.

    Returns None on failure so caller can fall back.
    """
    client = _get_cos_client()
    if client is None:
        return None
    base_path = REF_COS_PATH.strip("/")
    key = f"{base_path}/{remote_filename}" if base_path else remote_filename
    try:
        with open(local_path, "rb") as fp:
            client.put_object(Bucket=REF_COS_BUCKET, Body=fp, Key=key)
    except Exception as e:
        print(f"[cos] put_object failed for {remote_filename}: {e}")
        return None

    # Pre-signed GET URL — valid REF_URL_EXPIRES_SECONDS, no auth needed by MPS.
    try:
        url = client.get_presigned_url(
            Method='GET',
            Bucket=REF_COS_BUCKET,
            Key=key,
            Expired=REF_URL_EXPIRES_SECONDS,
        )
        return url
    except Exception as e:
        print(f"[cos] presign failed for {remote_filename}: {e}")
        return None


@app.route("/api/upload", methods=["POST"])
def upload_file():
    """Upload a reference image and return a publicly accessible URL.

    Primary path: upload to Tencent COS so the URL is reachable from
    Tencent MPS (fixes ImageDownloadFailure).
    Fallback: save locally + return /static/uploads URL (only useful for
    in-browser preview; MPS will not be able to fetch it).
    """
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    f = request.files["file"]
    if not f.filename:
        return jsonify({"error": "Empty filename"}), 400
    import uuid
    ext = os.path.splitext(f.filename)[1] or ".jpg"
    filename = f"{uuid.uuid4().hex}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    f.save(filepath)

    # Try COS first.
    cos_url = _upload_to_cos(filepath, filename)
    if cos_url:
        # Local copy is no longer needed once it's on COS.
        try: os.remove(filepath)
        except Exception: pass
        return jsonify({"url": cos_url, "filename": filename, "via": "cos"})

    # Fallback — local URL. NOTE: a private/LAN URL is NOT reachable by Tencent
    # MPS, so image-to-image / image-to-video would fail with ImageDownloadFailure.
    # Configure COS (above) for reference-image features to work end to end.
    # !!! Set EXTERNAL_HOST to your own publicly reachable origin if you rely on
    #     the local fallback. Default left BLANK on purpose.
    external_host = os.environ.get("EXTERNAL_HOST", "")  # e.g. "https://your-host.example.com"
    url = f"{external_host}/static/uploads/{filename}"
    return jsonify({
        "url": url,
        "filename": filename,
        "via": "local",
        "warning": "COS upload unavailable; reference image may not be reachable by MPS.",
    })


@app.after_request
def add_no_cache_headers(response):
    """Prevent browser from caching HTML/CSS/JS so updates appear immediately."""
    if response.content_type and (
        "text/html" in response.content_type
        or "text/css" in response.content_type
        or "javascript" in response.content_type
    ):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

# ---- (Removed) SQLite cumulative-stats DB ----
# The original Playground persisted cumulative token/usage stats in SQLite.
# This reference build is a stateless test page: the DB layer and the
# /api/stats endpoints have been removed entirely. No database is required.

AIGC_ENDPOINT = "https://text-aigc.vod-qcloud.com/v1/chat/completions"

# ============================================================================
# Tencent Cloud credentials
# ----------------------------------------------------------------------------
# !!! SECURITY — NEVER hard-code real SecretId / SecretKey here, and NEVER
#     commit them to git. Provide them ONLY through environment variables
#     (see .env.example). Values below are intentionally left BLANK.
#
#     A leaked SecretId/SecretKey lets anyone run pay-as-you-go Tencent Cloud
#     APIs on YOUR account. If a key was ever committed, rotate it immediately
#     in the Tencent Cloud console.
# ============================================================================
HARD_SECRET_ID  = os.environ.get("TENCENTCLOUD_SECRET_ID", "")   # set via env only
HARD_SECRET_KEY = os.environ.get("TENCENTCLOUD_SECRET_KEY", "")  # set via env only
HARD_SUB_APP_ID = int(os.environ.get("AIGC_SUB_APP_ID", "0"))

# Make sure the SDK clients can read the same credentials from the environment.
if HARD_SECRET_ID:
    os.environ.setdefault("TENCENTCLOUD_SECRET_ID", HARD_SECRET_ID)
if HARD_SECRET_KEY:
    os.environ.setdefault("TENCENTCLOUD_SECRET_KEY", HARD_SECRET_KEY)

# ---- Auto-create AIGC Token on startup ----
SERVER_AIGC_TOKEN = None

def _create_aigc_token_on_startup():
    """Acquire an AIGC API token at server start.

    The Tencent VOD AIGC API caps the number of tokens per SubApp at 50.
    Once that limit is hit, ``CreateAigcApiToken`` returns ``LimitExceeded``
    and we used to silently end up with ``SERVER_AIGC_TOKEN = None`` — which
    made every ``/api/chat`` request fail with "토큰과 메시지를 입력해주세요"
    even though plenty of usable tokens already exist on the account.

    New behaviour:
      1. List existing tokens via ``DescribeAigcApiTokens`` and reuse the
         first one if any are present. (The chat endpoint accepts any of
         them and they don't expire on their own.)
      2. Only if the account has zero tokens do we try ``CreateAigcApiToken``
         to mint a fresh one.
      3. Any unexpected error is logged but does not crash the worker.
    """
    global SERVER_AIGC_TOKEN
    # No credentials configured yet (fresh checkout / env not set) → skip quietly.
    if not HARD_SECRET_ID or not HARD_SECRET_KEY:
        print("[INFO] No Tencent Cloud credentials set; skipping AIGC token bootstrap. "
              "Set TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY to enable generation.")
        return
    try:
        from tencentcloud.common import credential as _cred
        from tencentcloud.vod.v20180717 import vod_client as _vod, models as _vod_models
        cred = _cred.Credential(HARD_SECRET_ID, HARD_SECRET_KEY)
        client = _vod.VodClient(cred, "")

        # 1) Reuse an existing token whenever possible.
        try:
            list_req = _vod_models.DescribeAigcApiTokensRequest()
            list_req.SubAppId = HARD_SUB_APP_ID
            list_resp = client.DescribeAigcApiTokens(list_req)
            existing = json.loads(list_resp.to_json_string()).get("ApiTokens") or []
            if existing:
                SERVER_AIGC_TOKEN = existing[0]
                print(f"[OK] AIGC Token reused (have {len(existing)}): "
                      f"{SERVER_AIGC_TOKEN[:20]}...")
                return
        except Exception as e:
            # Listing failure shouldn't be fatal; fall through to create.
            print(f"[WARN] DescribeAigcApiTokens failed: {e}")

        # 2) Otherwise, create a brand-new token.
        req = _vod_models.CreateAigcApiTokenRequest()
        req.SubAppId = HARD_SUB_APP_ID
        resp = client.CreateAigcApiToken(req)
        data = json.loads(resp.to_json_string())
        token = data.get("ApiToken") or data.get("Token") or ""
        if token:
            SERVER_AIGC_TOKEN = token
            print(f"[OK] AIGC Token created: {token[:20]}...")
        else:
            print(f"[WARN] Token creation returned no token: {data}")
    except Exception as e:
        # Last-ditch retry: maybe Create hit LimitExceeded *between* list+create.
        try:
            from tencentcloud.common import credential as _cred2
            from tencentcloud.vod.v20180717 import vod_client as _vod2, models as _vod_models2
            cred = _cred2.Credential(HARD_SECRET_ID, HARD_SECRET_KEY)
            client = _vod2.VodClient(cred, "")
            list_req = _vod_models2.DescribeAigcApiTokensRequest()
            list_req.SubAppId = HARD_SUB_APP_ID
            existing = json.loads(
                client.DescribeAigcApiTokens(list_req).to_json_string()
            ).get("ApiTokens") or []
            if existing:
                SERVER_AIGC_TOKEN = existing[0]
                print(f"[OK] AIGC Token reused after Create error "
                      f"(have {len(existing)}): {SERVER_AIGC_TOKEN[:20]}...")
                return
        except Exception:
            pass
        print(f"[WARN] Failed to obtain AIGC token: {e}")

_create_aigc_token_on_startup()


def _get_token(data):
    """Get token: use server token, fall back to client-provided token."""
    client_token = data.get("token", "")
    if client_token and client_token != "__SERVER__":
        return client_token
    return SERVER_AIGC_TOKEN or ""


# =====================================================================
#  GLM 5.1 web_search — OpenAI-style function calling
#
#  The Tencent VOD AIGC gateway only allows `tools[].type == "function"`,
#  so we expose ONE function (`web_search`) and run a 2-pass loop:
#    1) call glm-5.1 with [tool: web_search] → model returns tool_calls
#    2) we execute the search, append the result as role="tool"
#    3) call glm-5.1 again → final natural-language answer
#
#  Search backend priority:
#    Serper.dev   (SERPER_API_KEY)   ← preferred, native Google results
#    Google CSE   (GOOGLE_API_KEY + GOOGLE_CSE_ID)
#    DuckDuckGo Lite                 ← no-key fallback
# =====================================================================

SERPER_API_KEY = os.environ.get("SERPER_API_KEY", "")
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
GOOGLE_CSE_ID  = os.environ.get("GOOGLE_CSE_ID", "")

GLM_WEB_SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "web_search",
        "description": (
            "Search the public web for current, recent, or factual "
            "information. Use this for time-sensitive topics: news, prices, "
            "weather, recent events, or any fact that may have changed."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "max_results": {"type": "integer", "default": 5},
            },
            "required": ["query"],
        },
    },
}


def _last_user_text(messages):
    for msg in reversed(messages or []):
        if msg.get("role") != "user":
            continue
        content = msg.get("content", "")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    parts.append(item.get("text", ""))
            return "\n".join(parts)
    return ""


def _serper_search(query, max_results):
    """Google results via Serper.dev (preferred when SERPER_API_KEY is set)."""
    try:
        r = requests.post(
            "https://google.serper.dev/search",
            headers={"X-API-KEY": SERPER_API_KEY, "Content-Type": "application/json"},
            json={"q": query, "num": max_results},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        return {"error": str(e), "results": []}
    out = []
    for item in (data.get("organic") or [])[:max_results]:
        out.append({
            "title": item.get("title", ""),
            "url": item.get("link", ""),
            "snippet": item.get("snippet", ""),
        })
    return {"results": out}


def _google_cse_search(query, max_results):
    """Official Google Custom Search JSON API."""
    try:
        r = requests.get(
            "https://www.googleapis.com/customsearch/v1",
            params={
                "key": GOOGLE_API_KEY,
                "cx": GOOGLE_CSE_ID,
                "q": query,
                "num": min(max_results, 10),
            },
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        return {"error": str(e), "results": []}
    out = []
    for item in (data.get("items") or [])[:max_results]:
        out.append({
            "title": item.get("title", ""),
            "url": item.get("link", ""),
            "snippet": item.get("snippet", ""),
        })
    return {"results": out}


def _ddg_lite_search(query, max_results):
    """No-key fallback: DuckDuckGo Lite HTML scraping with UA rotation."""
    user_agents = [
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    ]
    text, last_err = "", ""
    for ua in user_agents:
        try:
            resp = requests.get(
                "https://lite.duckduckgo.com/lite/",
                params={"q": query},
                headers={"User-Agent": ua, "Accept-Language": "en-US,en;q=0.9,ko;q=0.8"},
                timeout=12,
            )
            if resp.status_code == 200 and 'rel="nofollow"' in resp.text:
                text = resp.text
                break
            last_err = f"status={resp.status_code}"
        except Exception as e:
            last_err = str(e)
    if not text:
        return {"error": last_err or "no usable response", "results": []}

    def _clean(s):
        return html.unescape(re.sub(r"<.*?>", "", s or "")).strip()

    def _decode(url):
        url = (url or "").strip()
        if url.startswith("//"):
            url = "https:" + url
        m = re.search(r"[?&]uddg=([^&]+)", url)
        if m:
            try:
                from urllib.parse import unquote
                return unquote(m.group(1))
            except Exception:
                return url
        return url

    links = list(re.finditer(
        r'<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', text, re.S))
    snips = list(re.finditer(
        r"class=['\"]result-snippet['\"][^>]*>(.*?)</td>", text, re.S))
    out = []
    for lm in links[:max_results]:
        snippet = ""
        for sm in snips:
            if sm.start() > lm.end():
                snippet = _clean(sm.group(1))
                break
        out.append({
            "title": _clean(lm.group(2)),
            "url": _decode(lm.group(1)),
            "snippet": snippet,
        })
    return {"results": out}


def _web_search(query, max_results=5):
    """Dispatch a web search using whichever backend is available."""
    max_results = max(1, min(int(max_results or 5), 10))
    if SERPER_API_KEY:
        result = _serper_search(query, max_results)
        backend = "serper"
    elif GOOGLE_API_KEY and GOOGLE_CSE_ID:
        result = _google_cse_search(query, max_results)
        backend = "google_cse"
    else:
        result = _ddg_lite_search(query, max_results)
        backend = "ddg_lite"
    return {
        "query": query,
        "backend": backend,
        "results": result.get("results", []),
        "error": result.get("error", ""),
    }


def _extract_text_tool_call(content):
    """GLM sometimes emits a textual `<tool_call>...</tool_call>` block in
    `message.content` instead of using the structured `tool_calls` field.
    Return parsed args dict, or None if not detected.
    """
    if not content:
        return None
    m = re.search(r"<tool_call>(.*?)</tool_call>", content, re.S)
    if not m:
        return None
    payload = m.group(1).strip()
    # Try direct JSON.
    try:
        obj = json.loads(payload)
        if isinstance(obj, dict):
            if "arguments" in obj:
                a = obj["arguments"]
                return json.loads(a) if isinstance(a, str) else a
            if "query" in obj:
                return obj
    except Exception:
        pass
    # Try `web_search({...})` / `web_search("...")`.
    inner = re.search(r"web_search\((.*)\)", payload, re.S)
    if inner:
        body = inner.group(1).strip()
        try:
            v = json.loads(body)
            if isinstance(v, dict):
                return v
            if isinstance(v, str):
                return json.loads(v)
        except Exception:
            return {"query": body.strip(' "\'')}
    return None


def _glm51_with_web_search(token, messages, temperature, max_tokens=None):
    """OpenAI-style 2-pass function-calling loop, glm-5.1 only."""
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    system = {
        "role": "system",
        "content": (
            "You have access to one tool: `web_search(query)`. "
            "Call it when the user needs current, recent, or factual "
            "web information. After the tool result is returned, reply "
            "in natural language in the user's language and cite 1-2 "
            "source URLs at the end. Never paste raw <tool_call> syntax "
            "in your reply."
        ),
    }
    convo = [system] + list(messages)
    base = {
        "model": "glm-5.1",
        "messages": convo,
        "temperature": temperature,
        "stream": False,
        "tools": [GLM_WEB_SEARCH_TOOL],
        "tool_choice": "auto",
    }
    if max_tokens:
        base["max_tokens"] = max_tokens

    debug = []
    r1 = requests.post(AIGC_ENDPOINT, json=base, headers=headers, timeout=120)
    debug.append({"step": "first_call", "status": r1.status_code})
    if r1.status_code != 200:
        return r1.status_code, None, r1.text, debug
    first = r1.json()
    msg = first.get("choices", [{}])[0].get("message", {}) or {}
    tool_calls = msg.get("tool_calls") or []

    # Fallback: textual <tool_call> in content.
    if not tool_calls:
        args = _extract_text_tool_call(msg.get("content"))
        if args and args.get("query"):
            tool_calls = [{
                "id": "web_search_text_1",
                "type": "function",
                "function": {
                    "name": "web_search",
                    "arguments": json.dumps(args, ensure_ascii=False),
                },
            }]
            msg["content"] = ""

    # No search needed → return as-is.
    if not tool_calls:
        return 200, first, first, debug

    # Execute searches and collect raw results to inject into a final
    # follow-up turn. We don't rely solely on role="tool" because some GLM
    # variants keep trying to call the tool again; pinning the result as a
    # user-visible context block + explicit instructions is more reliable.
    convo.append({k: v for k, v in msg.items() if k in ("role", "content", "tool_calls")})
    collected_results = []
    for call in tool_calls[:3]:
        fn = call.get("function", {}) or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except Exception:
            args = {}
        result = _web_search(args.get("query", ""), args.get("max_results", 5))
        collected_results.append(result)
        convo.append({
            "role": "tool",
            "tool_call_id": call.get("id", "web_search_1"),
            "name": fn.get("name", "web_search"),
            "content": json.dumps(result, ensure_ascii=False),
        })
        debug.append({"step": "tool_call", "call": call, "result": result})

    # Build a compact human-readable summary of search results to push as a
    # final user-visible context. This guarantees the model has the results
    # visible even if it tries to ignore the tool message.
    lines = []
    total_hits = 0
    for r in collected_results:
        hits = r.get("results", []) or []
        total_hits += len(hits)
        for h in hits:
            lines.append(f"- {h.get('title','')} — {h.get('url','')}\n  {h.get('snippet','')}")
    results_block = "\n".join(lines) if lines else "(no results)"

    no_hit_hint = ""
    if total_hits == 0:
        no_hit_hint = (
            " The web_search returned 0 results. Tell the user nothing was "
            "found and suggest different keywords. Do NOT fabricate facts."
        )

    final_payload = {
        "model": "glm-5.1",
        "messages": convo + [
            {
                "role": "user",
                "content": (
                    "Web search results are below. Write the final answer in "
                    "the user's language (Korean if the original question was "
                    "Korean, else English). Cite 1-2 source URLs at the end. "
                    "Do NOT write <tool_call>, <arg_key>, <arg_value>, or "
                    "any function-call syntax. Just answer naturally."
                    + no_hit_hint
                    + "\n\nResults:\n" + results_block
                ),
            },
        ],
        "temperature": 0.2,
        "stream": False,
    }
    if max_tokens:
        final_payload["max_tokens"] = max_tokens
    r2 = requests.post(AIGC_ENDPOINT, json=final_payload, headers=headers, timeout=120)
    debug.append({"step": "second_call", "status": r2.status_code})
    if r2.status_code != 200:
        return r2.status_code, None, r2.text, debug
    final_json = r2.json()

    # Scrub any residual tool-call / function-call syntax in the final answer.
    try:
        ans = final_json["choices"][0]["message"].get("content", "") or ""
        original = ans
        ans = re.sub(r"<tool_call>.*?(?:</tool_call>|$)", "", ans, flags=re.S)
        ans = re.sub(r"</?arg_(?:key|value)>", "", ans)
        ans = re.sub(r"\bweb_search\s*\([^)]*\)", "", ans)
        ans = ans.strip()
        if ans != original.strip():
            debug.append({"step": "scrubbed", "raw_content": original})
            if not ans:
                ans = (
                    "웹 검색에서 관련 정보를 찾지 못했습니다. "
                    "다른 키워드로 다시 시도해주세요."
                )
            final_json["choices"][0]["message"]["content"] = ans
    except Exception:
        pass
    return 200, final_json, final_json, debug

MODELS = [
    # ===== Gemini (Google) — all multimodal =====
    {"id": "gemini-3.5-flash",              "name": "Gemini 3.5 Flash",              "group": "Gemini",   "badge": "NEW", "vision": True},
    {"id": "gemini-3.1-pro-preview",        "name": "Gemini 3.1 Pro Preview",        "group": "Gemini",   "vision": True},
    {"id": "gemini-3.1-flash-lite",         "name": "Gemini 3.1 Flash Lite",         "group": "Gemini",   "badge": "NEW", "vision": True},
    {"id": "gemini-3.1-flash-lite-preview", "name": "Gemini 3.1 Flash Lite Preview", "group": "Gemini",   "vision": True},
    {"id": "gemini-3-flash-preview",        "name": "Gemini 3 Flash Preview",        "group": "Gemini",   "vision": True},
    {"id": "gemini-2.5-pro",                "name": "Gemini 2.5 Pro",                "group": "Gemini",   "vision": True},
    {"id": "gemini-2.5-flash",              "name": "Gemini 2.5 Flash",              "group": "Gemini",   "vision": True},

    # ===== OpenAI =====
    {"id": "gpt-5.5",      "name": "GPT-5.5 (new)", "group": "OpenAI", "badge": "NEW", "vision": True},
    {"id": "gpt-5.4",      "name": "GPT-5.4",       "group": "OpenAI", "vision": True},
    {"id": "gpt-5.3-chat", "name": "GPT-5.3 Chat",  "group": "OpenAI", "badge": "NEW", "vision": True},
    {"id": "gpt-5.2",      "name": "GPT-5.2",       "group": "OpenAI", "vision": True},
    {"id": "gpt-5.2-chat", "name": "GPT-5.2 Chat",  "group": "OpenAI", "badge": "NEW", "vision": True},
    {"id": "gpt-5.1",      "name": "GPT-5.1",       "group": "OpenAI", "vision": True},
    {"id": "gpt-5-chat",   "name": "GPT-5 Chat",    "group": "OpenAI", "vision": True},
    {"id": "gpt-5-nano",   "name": "GPT-5 Nano",    "group": "OpenAI", "vision": False},
    {"id": "gpt-4.1",      "name": "GPT-4.1",       "group": "OpenAI", "badge": "NEW", "vision": True},
    {"id": "gpt-4o",       "name": "GPT-4o",        "group": "OpenAI", "vision": True},

    # ===== Claude (Anthropic) — all multimodal =====
    {"id": "cd-opus-4.8",   "name": "Claude Opus 4.8",   "group": "Claude", "badge": "NEW", "vision": True},
    {"id": "cd-opus-4.7",   "name": "Claude Opus 4.7",   "group": "Claude", "vision": True},
    {"id": "cd-sonnet-4.6", "name": "Claude Sonnet 4.6", "group": "Claude", "vision": True},
    {"id": "cd-opus-4.6",   "name": "Claude Opus 4.6",   "group": "Claude", "vision": True},
    {"id": "cd-opus-4.5",   "name": "Claude Opus 4.5",   "group": "Claude", "vision": True},
    {"id": "cd-haiku-4.5",  "name": "Claude Haiku 4.5",  "group": "Claude", "vision": True},

    # ===== xAI =====
    {"id": "gk-4.3",                "name": "Grok 4.3",                "group": "xAI", "badge": "NEW", "vision": True},
    {"id": "gk-4-20-reasoning",     "name": "Grok 4.20 Reasoning",     "group": "xAI", "badge": "NEW", "vision": True},
    {"id": "gk-4-1-fast-reasoning", "name": "Grok 4.1 Fast Reasoning", "group": "xAI", "vision": True},

    # ===== Moonshot =====
    {"id": "kimi-k2.5", "name": "Kimi K2.5", "group": "Moonshot", "vision": True},

    # ===== Zhipu =====
    {"id": "glm-5.1",     "name": "GLM-5.1",     "group": "Zhipu AI", "badge": "NEW", "vision": True},
    {"id": "glm-5",       "name": "GLM-5",       "group": "Zhipu AI", "vision": True},
    {"id": "glm-5-turbo", "name": "GLM-5 Turbo", "group": "Zhipu AI", "vision": False},

    # ===== MiniMax =====
    {"id": "minimax-m2.7", "name": "MiniMax M2.7", "group": "MiniMax", "badge": "NEW", "vision": True},
    {"id": "minimax-m2.5", "name": "MiniMax M2.5", "group": "MiniMax", "vision": True},

    # ===== DeepSeek — text only =====
    {"id": "deepseek-v3.2", "name": "DeepSeek V3.2", "group": "DeepSeek", "badge": "NEW", "vision": False},
]
@app.route("/")
def index():
    return render_template("index.html", models=MODELS)


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json()
    token = _get_token(data)
    model = data.get("model", "gemini-2.5-flash")
    temperature = data.get("temperature", 0.7)
    # gpt-5.5 only supports temperature=1
    if isinstance(model, str) and model.startswith("gpt-5.5"):
        temperature = 1
    # gpt-5-nano only supports temperature=1.0 (API default); force override
    if model == "gpt-5-nano" and temperature != 1.0:
        temperature = 1.0

    # Accept messages array directly from frontend (includes history)
    messages = data.get("messages", [])

    # Backward compat: if old-style single "message" field is sent
    if not messages:
        message = data.get("message", "")
        system_prompt = data.get("system", "")
        if not token or not message:
            return jsonify({"error": "토큰과 메시지를 입력해주세요."}), 400
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": message})
    else:
        if not token or not messages:
            return jsonify({"error": "토큰과 메시지를 입력해주세요."}), 400

    # claude-bridge: cd-* -> Anthropic messages (chat)
    if is_claude(model):
        if not token or not messages:
            return jsonify({"error": "토큰과 메시지를 입력해주세요."}), 400
        try:
            status, out, raw, _dbg = call_messages(
                model=model,
                messages=messages,
                temperature=temperature,
                token=token,
                max_tokens=data.get("max_tokens"),
            )
        except requests.exceptions.Timeout:
            return jsonify({"error": "요청 시간이 초과되었습니다. (120초)"}), 504
        except requests.exceptions.ConnectionError as _ce:
            print(f"[chat] ConnectionError model={model}: {_ce}", flush=True)
            return jsonify({"error": f"API 서버에 연결할 수 없습니다 (model={model}, detail={str(_ce)[:200]})"}), 502
        except Exception as e:
            return jsonify({"error": f"오류 발생: {e}"}), 500
        if status != 200:
            err_msg = "API Error " + str(status)
            try:
                if isinstance(raw, dict):
                    err_msg += ": " + str((raw.get("error") or {}).get("message") or raw)[:300]
            except Exception:
                pass
            return jsonify({"error": err_msg}), status
        return jsonify(out)

    # glm-5.1 only: add server-side web_search tool loop.
    if model == "glm-5.1":
        start_time = time.time()
        try:
            status, result, raw, steps = _glm51_with_web_search(
                token=token,
                messages=messages,
                temperature=temperature,
                max_tokens=data.get("max_tokens"),
            )
        except requests.exceptions.Timeout:
            return jsonify({"error": "요청 시간이 초과되었습니다. (120초)"}), 504
        except requests.exceptions.ConnectionError as _ce:
            print(f"[chat] ConnectionError model={model}: {_ce}", flush=True)
            return jsonify({"error": f"API 서버에 연결할 수 없습니다 (model={model}, detail={str(_ce)[:200]})"}), 502
        except Exception as e:
            return jsonify({"error": f"GLM 5.1 web-search error: {e}"}), 500
        elapsed = round(time.time() - start_time, 2)
        if status != 200:
            return jsonify({"error": f"API Error {status}: {str(raw)[:300]}", "debug": {"tool_steps": steps}}), status
        answer = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = result.get("usage", {})
        prompt_details = usage.get("prompt_tokens_details", {})
        completion_details = usage.get("completion_tokens_details", {})
        debug_request = {
            "url": AIGC_ENDPOINT,
            "method": "POST",
            "headers": {"Authorization": "Bearer ***masked***", "Content-Type": "application/json"},
            "body": {"model": model, "messages": "<omitted>", "tools": [GLM_WEB_SEARCH_TOOL], "tool_choice": "auto"},
        }
        return jsonify({
            "answer": answer,
            "model": result.get("model", model),
            "usage": {
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "cached_tokens": prompt_details.get("cached_tokens", 0),
                "reasoning_tokens": completion_details.get("reasoning_tokens", 0),
            },
            "elapsed": elapsed,
            "request_id": result.get("id", ""),
            "debug": {"request": debug_request, "response": result, "tool_steps": steps},
        })

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }

    # Pass-through optional tools (e.g. web_search)
    tools = data.get("tools")
    if tools:
        payload["tools"] = tools
    web_search = data.get("web_search")
    if web_search is not None:
        payload["web_search"] = web_search

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    start_time = time.time()
    try:
        resp = requests.post(
            AIGC_ENDPOINT,
            json=payload,
            headers=headers,
            timeout=120,
        )
        elapsed = round(time.time() - start_time, 2)

        if resp.status_code != 200:
            error_msg = f"API Error {resp.status_code}"
            try:
                err_body = resp.json()
                error_msg += f": {err_body.get('error', {}).get('message', resp.text[:200])}"
            except Exception:
                error_msg += f": {resp.text[:200]}"
            return jsonify({"error": error_msg}), resp.status_code

        result = resp.json()
        answer = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        usage = result.get("usage", {})
        prompt_details = usage.get("prompt_tokens_details", {})
        completion_details = usage.get("completion_tokens_details", {})

        # Sanitise raw request for debug panel (mask token)
        debug_request = {
            "url": AIGC_ENDPOINT,
            "method": "POST",
            "headers": {"Authorization": "Bearer ***masked***", "Content-Type": "application/json"},
            "body": payload,
        }

        return jsonify({
            "answer": answer,
            "model": result.get("model", model),
            "usage": {
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "cached_tokens": prompt_details.get("cached_tokens", 0),
                "reasoning_tokens": completion_details.get("reasoning_tokens", 0),
            },
            "elapsed": elapsed,
            "request_id": result.get("id", ""),
            "debug": {
                "request": debug_request,
                "response": result,
            },
        })

    except requests.exceptions.Timeout:
        return jsonify({"error": "요청 시간이 초과되었습니다. (120초)"}), 504
    except requests.exceptions.ConnectionError as _ce:
        print(f"[chat] ConnectionError model={model}: {_ce}", flush=True)
        return jsonify({"error": f"API 서버에 연결할 수 없습니다 (model={model}, detail={str(_ce)[:200]})"}), 502
    except Exception as e:
        return jsonify({"error": f"오류 발생: {str(e)}"}), 500


@app.route("/api/stream", methods=["POST"])
def stream_chat():
    data = request.get_json()
    token = _get_token(data)
    model = data.get("model", "gemini-2.5-flash")
    temperature = data.get("temperature", 0.7)
    # gpt-5.5 only supports temperature=1
    if isinstance(model, str) and model.startswith("gpt-5.5"):
        temperature = 1
    # gpt-5-nano only supports temperature=1.0 (API default); force override
    if model == "gpt-5-nano" and temperature != 1.0:
        temperature = 1.0

    # Accept messages array directly from frontend (includes history)
    messages = data.get("messages", [])

    # Backward compat: if old-style single "message" field is sent
    if not messages:
        message = data.get("message", "")
        system_prompt = data.get("system", "")
        if not token or not message:
            return jsonify({"error": "토큰과 메시지를 입력해주세요."}), 400
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": message})
    else:
        if not token or not messages:
            return jsonify({"error": "토큰과 메시지를 입력해주세요."}), 400

    # claude-bridge: cd-* -> Anthropic messages (stream)
    if is_claude(model):
        if not token or not messages:
            return jsonify({"error": "토큰과 메시지를 입력해주세요."}), 400
        gen = stream_messages(
            model=model,
            messages=messages,
            temperature=temperature,
            token=token,
            max_tokens=data.get("max_tokens"),
        )
        return Response(gen, mimetype="text/event-stream",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # glm-5.1 only: use the same web-search function calling path. The final
    # answer is emitted as one SSE content event so the existing frontend works
    # without adding a second streaming tool-call protocol.
    if model == "glm-5.1":
        def glm51_generate():
            start_time = time.time()
            debug_request = {
                "url": AIGC_ENDPOINT,
                "method": "POST",
                "headers": {"Authorization": "Bearer ***masked***", "Content-Type": "application/json"},
                "body": {"model": model, "messages": "<omitted>", "tools": [GLM_WEB_SEARCH_TOOL], "tool_choice": "auto"},
            }
            yield f"data: {json.dumps({'debug_request': debug_request})}\n\n"
            try:
                status, result, raw, steps = _glm51_with_web_search(
                    token=token,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=data.get("max_tokens"),
                )
                if status != 200:
                    yield f"data: {json.dumps({'error': f'API Error {status}: {str(raw)[:300]}'})}\n\n"
                    return
                answer = result.get("choices", [{}])[0].get("message", {}).get("content", "")
                usage = result.get("usage", {})
                prompt_details = usage.get("prompt_tokens_details", {})
                completion_details = usage.get("completion_tokens_details", {})
                if answer:
                    yield f"data: {json.dumps({'content': answer})}\n\n"
                yield f"data: {json.dumps({'usage': {
                    'prompt_tokens': usage.get('prompt_tokens', 0),
                    'completion_tokens': usage.get('completion_tokens', 0),
                    'total_tokens': usage.get('total_tokens', 0),
                    'cached_tokens': prompt_details.get('cached_tokens', 0),
                    'reasoning_tokens': completion_details.get('reasoning_tokens', 0),
                }})}\n\n"
                elapsed = round(time.time() - start_time, 2)
                yield f"data: {json.dumps({'done': True, 'elapsed': elapsed, 'debug_response': {'response': result, 'tool_steps': steps}})}\n\n"
            except Exception as e:
                yield f"data: {json.dumps({'error': str(e)})}\n\n"
        return Response(
            stream_with_context(glm51_generate()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    def generate():
        start_time = time.time()
        # Debug: capture raw request for the debug panel
        debug_request = {
            "url": AIGC_ENDPOINT,
            "method": "POST",
            "headers": {"Authorization": "Bearer ***masked***", "Content-Type": "application/json"},
            "body": payload,
        }
        # Send debug request info as the very first SSE event
        yield f"data: {json.dumps({'debug_request': debug_request})}\n\n"
        raw_chunks = []
        try:
            resp = requests.post(
                AIGC_ENDPOINT,
                json=payload,
                headers=headers,
                timeout=120,
                stream=True,
            )

            if resp.status_code != 200:
                error_msg = f"API Error {resp.status_code}: {resp.text[:200]}"
                yield f"data: {json.dumps({'error': error_msg})}\n\n"
                return

            for line in resp.iter_lines():
                if not line:
                    continue
                decoded = line.decode("utf-8")
                if not decoded.startswith("data: "):
                    continue
                payload_str = decoded[6:]
                if payload_str.strip() == "[DONE]":
                    elapsed = round(time.time() - start_time, 2)
                    yield f"data: {json.dumps({'done': True, 'elapsed': elapsed, 'debug_response': raw_chunks})}\n\n"
                    break
                try:
                    chunk = json.loads(payload_str)
                    raw_chunks.append(chunk)
                    # Check for usage in the chunk
                    usage = chunk.get("usage")
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")

                    out = {}
                    if content:
                        out["content"] = content
                    if usage:
                        prompt_details = usage.get("prompt_tokens_details", {})
                        completion_details = usage.get("completion_tokens_details", {})
                        out["usage"] = {
                            "prompt_tokens": usage.get("prompt_tokens", 0),
                            "completion_tokens": usage.get("completion_tokens", 0),
                            "total_tokens": usage.get("total_tokens", 0),
                            "cached_tokens": prompt_details.get("cached_tokens", 0),
                            "reasoning_tokens": completion_details.get("reasoning_tokens", 0),
                        }
                    if out:
                        yield f"data: {json.dumps(out)}\n\n"
                except json.JSONDecodeError:
                    continue

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ---- (Removed) Cumulative Stats API ----
# The /api/stats GET/POST/reset endpoints depended on the SQLite DB and have
# been removed for this stateless reference build.


# ---- MPS AIGC Image / Video Generation ----
# Uses Tencent Cloud MPS SDK (CreateAigcImageTask / CreateAigcVideoTask)
# Server-side credentials loaded from environment variables.

try:
    from tencentcloud.common import credential
    from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
    from tencentcloud.mps.v20190612 import mps_client, models as mps_models
    MPS_SDK_AVAILABLE = True
except ImportError:
    MPS_SDK_AVAILABLE = False

# ─────────────────────────────────────────────────────────────────
# MPS AIGC supported models
# Verified by live probing against mps.tencentcloudapi.com
# (the official docs at /862/126966 and /862/126965 list fewer models
#  than the live API actually accepts, so the list below is based on
#  real CreateAigcImageTask / CreateAigcVideoTask responses).
# ─────────────────────────────────────────────────────────────────


# =============================================================
# Resolution 미지원 에러 친근화
# -------------------------------------------------------------
# 사용자 방침: 모든 영상/이미지 엔진 UI 에 720P/1080P/2K/4K 4단계를 일괄
# 노출하고, 실제로 거부하는 엔진이 있으면 그 에러를 그대로 사용자에게
# "해당 해상도는 지원하지 않습니다" 형태로 안내한다.
#
# MPS AIGC 가 해상도 미지원을 반환하는 패턴은 엔진마다 제각각이므로
# 광범위한 키워드 매칭으로 잡아낸다. (영문/중문/숫자 모두 커버)
# 매치되면 한국어 친근 메시지 + 원문(괄호) 형태로 반환한다.
# =============================================================
_RES_REJECT_PATTERNS = [
    "resolution",
    "unsupported resolution",
    "invalid resolution",
    "not support",
    "not supported",
    "support",
    "4k", "2k", "1080p", "720p",
    "分辨率",        # 중문: 해상도
    "不支持",        # 중문: 지원 안 함
    "暂不支持",      # 중문: 잠시 지원 안 함
    "无效",          # 중문: 무효
    "参数错误",      # 중문: 파라미터 오류
]

def _friendly_resolution_error(raw_msg: str, requested_res: str = "") -> str:
    """
    MPS API 의 에러 메시지가 해상도 거부일 경우 한국어로 친근하게 변환.
    해상도와 무관해 보이면 원본을 그대로 반환한다.
    """
    if not raw_msg:
        return raw_msg
    low = raw_msg.lower()
    # resolution / 분辨率 같은 직접 키워드 + (4K/2K 등 라벨 또는 WxH 형태)
    has_res_kw = any(k in low for k in ("resolution", "分辨率"))
    has_label  = any(k in low for k in ("4k", "2k", "1080p", "720p"))
    reject_kw  = any(k in low for k in ("not support", "unsupported", "invalid", "不支持", "暂不支持", "无效"))
    looks_like_res_reject = (has_res_kw and reject_kw) or (has_label and reject_kw)

    if looks_like_res_reject:
        label = f"'{requested_res}' " if requested_res else ""
        return (
            f"해당 해상도 {label}는 이 엔진이 지원하지 않습니다. "
            f"다른 해상도(720P / 1080P / 2K / 4K)를 선택해 다시 시도해 주세요. "
            f"(원문: {raw_msg})"
        )
    return raw_msg


def _friendly_aspect_error(raw_msg: str, requested_aspect: str = "",
                           has_refs: bool = False) -> str:
    """
    'Image aspect ratio is invalid' 류 에러를 한국어로 친근하게 변환.

    Kling/Vidu 등의 i2i 모델은 reference image 의 aspect 와 요청 aspect 가
    일치하지 않으면 이 에러를 뱉는다. 메시지 자체는 "request 의 aspect 가
    이상하다"처럼 들리지만 실제 원인은 ref-vs-request 불일치인 경우가 대부분.
    has_refs=True 면 그 진짜 원인을 친절히 안내한다.
    """
    if not raw_msg:
        return raw_msg
    low = raw_msg.lower()
    if "aspect" not in low and "比例" not in raw_msg:
        return raw_msg
    looks_like_reject = any(k in low for k in (
        "invalid", "unsupported", "not support", "out of range",
        "不支持", "暂不支持", "无效",
    ))
    if not looks_like_reject:
        return raw_msg

    if has_refs:
        return (
            f"Reference 이미지의 비율과 요청 비율('{requested_aspect}')이 "
            f"일치하지 않아 모델이 거부했습니다. "
            f"Reference 이미지의 비율에 맞춰 Aspect 를 변경하시거나, "
            f"Reference 이미지를 제거한 후 다시 시도해 주세요. "
            f"(원문: {raw_msg})"
        )
    return (
        f"이 엔진은 비율 '{requested_aspect}' 을(를) 지원하지 않습니다. "
        f"16:9 / 9:16 / 1:1 / 4:3 / 3:4 중에서 다시 골라보세요. "
        f"(원문: {raw_msg})"
    )


# Engine name → (ModelName, ModelVersion) mapping for Image engines.
# "" version means "use the API's default stable version for that model".
IMAGE_ENGINE_MAP = {
    # ---- Officially documented ----
    # GEM (Google Gemini image)
    "gem31":          ("GEM", "3.1"),
    "gem30":          ("GEM", "3.0"),
    "gem25":          ("GEM", "2.5"),
    # Hunyuan (混元)
    "hunyuan30":      ("Hunyuan", "3.0"),
    "hunyuan":        ("Hunyuan", ""),
    # Qwen (通义万相)
    "qwen0925":       ("Qwen", "0925"),
    "qwen":           ("Qwen", ""),
    # ---- Undocumented but live-API supported ----
    # Seedream (字节 即梦 Image — alias Dreamina)
    "seedream50lite": ("Seedream", "5.0-lite"),
    "seedream45":     ("Seedream", "4.5"),
    "seedream40":     ("Seedream", "4.0"),
    # Kling (快手 可灵 Image)
    "kling_img_30o":  ("Kling", "3.0-Omni"),
    "kling_img_30":   ("Kling", "3.0"),
    "kling_img_o1":   ("Kling", "O1"),
    "kling_img_21":   ("Kling", "2.1"),
    # ── Raw (compliance-check OFF) variant of latest Kling image only ──
    # 내부 테스트 전용. ExtraParameters 로 EnableInputComplianceCheck=False,
    # EnableOutputComplianceCheck=False 를 주입한다 (호출 분기에서 처리).
    "kling_img_30o_raw": ("Kling", "3.0-Omni"),
    # Jimeng (即梦 Image, separate from Seedream)
    "jimeng_img_40":  ("Jimeng", "4.0"),
    # MJ (Midjourney)
    "mjv7":           ("MJ", "v7"),
    # Vidu Image
    "viduq2_img":     ("Vidu", "q2"),
    # ── Raw (compliance-check OFF) variant of latest Vidu image only ──
    "viduq2_img_raw": ("Vidu", "q2"),
    # OG (OpenAI Image — gpt-image)
    "og_img_low":     ("OG", "image2_low"),
    "og_img_medium":  ("OG", "image2_medium"),
    "og_img_high":    ("OG", "image2_high"),
}

# Engine name → (ModelName, ModelVersion) mapping for Video engines.
VIDEO_ENGINE_MAP = {
    # ---- Officially documented ----
    # Kling (可灵)
    "kling16":        ("Kling", "1.6"),
    "kling20":        ("Kling", "2.0"),
    "kling21":        ("Kling", "2.1"),
    "kling25":        ("Kling", "2.5"),
    "kling26":        ("Kling", "2.6"),
    "kling30":        ("Kling", "3.0"),
    "kling30omni":    ("Kling", "3.0-Omni"),
    "klingo1":        ("Kling", "O1"),
    # ── Raw (compliance-check OFF) variant of latest Kling video only ──
    "kling30omni_raw": ("Kling", "3.0-Omni"),
    # Hailuo (海螺)
    "hailuo02":       ("Hailuo", "02"),
    "hailuo23":       ("Hailuo", "2.3"),
    "hailuo23fast":   ("Hailuo", "2.3-fast"),
    # Vidu
    "viduq2":         ("Vidu", "q2"),
    "viduq2pro":      ("Vidu", "q2-pro"),
    "viduq2turbo":    ("Vidu", "q2-turbo"),
    "viduq3":         ("Vidu", "q3"),
    "viduq3pro":      ("Vidu", "q3-pro"),
    "viduq3turbo":    ("Vidu", "q3-turbo"),
    "viduq3mix":      ("Vidu", "q3-mix"),
    # ── Raw (compliance-check OFF) variant of latest Vidu video only ──
    "viduq3_raw":     ("Vidu", "q3"),
    # GV (Google Veo)
    "gv31":           ("GV", "3.1"),
    "gv31fast":       ("GV", "3.1-fast"),
    # OS (Sora)
    "osv20":          ("OS", "2.0"),
    # PixVerse
    "pixversev56":    ("PixVerse", "v5.6"),
    "pixversev6":     ("PixVerse", "v6"),
    "pixversec1":     ("PixVerse", "c1"),
    # Hunyuan (混元)
    "hunyuan15":      ("Hunyuan", "1.5"),
    "hunyuan_vid":    ("Hunyuan", ""),
    # H2 (Happyhorse / 海马) — verified 2026-05-07 via live MPS probe
    # ("Not support ModelName" for HH/Happyhorse, only "H2"/"1.0" passes).
    "h2_10":          ("H2", "1.0"),
    "h2":             ("H2", "1.0"),
    # ---- Undocumented but live-API supported ----
    # Jimeng (即梦)
    "jimeng30pro":    ("Jimeng", "3.0pro"),
    "jimeng_vid":     ("Jimeng", ""),
    # Seedance (字节)
    "seedance15pro":   ("Seedance", "1.5-pro"),
    "seedance10pro":   ("Seedance", "1.0-pro"),
    "seedance10profast": ("Seedance", "1.0-pro-fast"),
    # Mingmou (明眸)
    "mingmou10":      ("Mingmou", "1.0"),
    # Wan (阿里万相)
    "wan22":          ("Wan", "2.2"),
}

# COS bucket for storing AIGC results (image/video/music/3D output).
# !!! SECURITY: configure via environment variables. Defaults left BLANK so no
#     account-specific bucket / APPID ships in the source.
#     e.g. AIGC_COS_BUCKET="your-output-bucket-1250000000"
COS_BUCKET_NAME   = os.environ.get("AIGC_COS_BUCKET", "")            # e.g. "your-output-bucket-<APPID>"
COS_BUCKET_REGION = os.environ.get("AIGC_COS_REGION", "")            # e.g. "ap-guangzhou"
COS_BUCKET_PATH   = os.environ.get("AIGC_COS_PATH", "aigc-playground")


def _get_mps_client():
    """Create an MPS client using environment credentials."""
    secret_id = os.environ.get("TENCENTCLOUD_SECRET_ID", "")
    secret_key = os.environ.get("TENCENTCLOUD_SECRET_KEY", "")
    if not secret_id or not secret_key:
        return None
    cred = credential.Credential(secret_id, secret_key)
    return mps_client.MpsClient(cred, "")


@app.route("/api/image/generate", methods=["POST"])
def generate_image():
    """Create an AIGC image generation task and poll for the result."""
    if not MPS_SDK_AVAILABLE:
        return jsonify({"error": "MPS SDK not installed on server. pip install tencentcloud-sdk-python"}), 500

    data = request.get_json()
    token = _get_token(data)
    prompt = data.get("prompt", "")
    engine = data.get("engine", "gem31")
    aspect_ratio = data.get("aspect_ratio", "1:1")
    resolution = data.get("resolution", "1080P")
    ref_image_urls = data.get("image_urls", [])  # reference images for i2i
    negative_prompt = data.get("negative_prompt", "")

    if not prompt and not ref_image_urls:
        return jsonify({"error": "Prompt or reference image is required."}), 400

    if engine not in IMAGE_ENGINE_MAP:
        return jsonify({
            "error": f"Unsupported image engine '{engine}'. Supported engines: "
                     f"{', '.join(sorted(IMAGE_ENGINE_MAP.keys()))}"
        }), 400

    # ─────────────────────────────────────────────────────────────
    # i2i (image-to-image) 미지원 엔진 자동 fallback.
    #
    # 실측(2026-05-29):
    #   * Kling 이미지 모델 전체 (kling_img_30o, kling_img_30,
    #     kling_img_o1, kling_img_21, 그리고 _raw 변종)는 reference
    #     image 를 첨부하면 'Image aspect ratio is invalid' 또는
    #     'Something went wrong when we tried to get the contents of
    #     the file' 로 거부 → 사실상 t2i 전용.
    #   * GEM 3.1, Hunyuan 3.0, Seedream, Jimeng 등은 ref 정상 수용.
    #
    # 사용자가 i2i 미지원 엔진을 선택했는데 ref 가 첨부된 경우, 침묵
    # 거부 대신 i2i 가능 동급 엔진으로 자동 라우팅하고 응답에 명시한다.
    # 사용자가 어떤 엔진을 선택했는지 의도가 보존되도록 fallback 정보를
    # 명확히 노출 (UX: "왜 다른 모델이 나왔지?" 의문 즉시 해소).
    # ─────────────────────────────────────────────────────────────
    I2I_BLOCKED = {
        "kling_img_30o",      "kling_img_30",
        "kling_img_o1",       "kling_img_21",
        "kling_img_30o_raw",
        "og_img_low", "og_img_medium", "og_img_high",   # gpt-image t2i 전용
    }
    # 엔진별 i2i fallback (같은 톤/품질대로 가능하면 매핑)
    I2I_FALLBACK = {
        "kling_img_30o":     "gem31",     # 가장 안정적인 i2i
        "kling_img_30":      "gem31",
        "kling_img_o1":      "gem31",
        "kling_img_21":      "gem31",
        "kling_img_30o_raw": "gem31",
        "og_img_low":        "gem31",
        "og_img_medium":     "gem31",
        "og_img_high":       "gem31",
    }
    fallback_info = None
    if ref_image_urls and engine in I2I_BLOCKED:
        new_engine = I2I_FALLBACK.get(engine, "gem31")
        if new_engine in IMAGE_ENGINE_MAP:
            fallback_info = {
                "from": engine,
                "to":   new_engine,
                "reason": (
                    f"'{engine}' 모델은 reference image (i2i) 를 지원하지 "
                    f"않아 '{new_engine}' 로 자동 변경되었습니다."
                ),
            }
            print(
                f"[image/generate] ⤷ i2i fallback: {engine} → {new_engine} "
                f"(refs={len(ref_image_urls)})",
                flush=True,
            )
            engine = new_engine

    model_name, model_version = IMAGE_ENGINE_MAP[engine]

    client = _get_mps_client()
    if not client:
        return jsonify({"error": "Server credentials not configured (TENCENTCLOUD_SECRET_ID / SECRET_KEY)."}), 500

    # Resolution handling is engine-specific:
    # * GEM accepts preset labels (720P / 1080P / 2K / 4K) via ExtraParameters.Resolution.
    # * Hunyuan 3.0 and Qwen 0925 expect a custom "WxH" via AdditionalParameters.
    # * Seedream (SI/Seedream) models require minimum 1920x1920 and also use "WxH".
    # * For other engines (Kling / Jimeng / MJ / Vidu / OG) leave resolution unset
    #   and let the model default decide — custom resolution semantics are per model.
    #
    # NEW (사용자 요청): 프론트가 "720P / 1080P / 2K / 4K" 라벨을 보내든,
    #   "1024x1024" 같은 WxH 를 보내든 양쪽 모두 받아 정규화한다.
    LABEL_TO_WH = {
        "720P":  (1280, 720),
        "1080P": (1920, 1080),
        "2K":    (2560, 1440),
        "4K":    (3840, 2160),
    }
    def _parse_wh(res_str):
        if not res_str:
            return None
        s = str(res_str).strip()
        # 라벨 우선
        up = s.upper().replace(" ", "")
        if up in LABEL_TO_WH:
            return LABEL_TO_WH[up]
        # WxH (e.g. "1024x1024", "1920×1080")
        try:
            w, h = map(int, s.lower().replace("×", "x").split("x"))
            return w, h
        except Exception:
            return None

    def _wh_to_label(wh):
        if not wh:
            return "1080P"
        w, h = wh
        pixels = w * h
        if   pixels <= 1280 * 720:   return "720P"
        elif pixels <= 1920 * 1080:  return "1080P"
        elif pixels <= 2560 * 1440:  return "2K"
        else:                        return "4K"

    wh = _parse_wh(resolution)

    try:
        req = mps_models.CreateAigcImageTaskRequest()
        req.ModelName = model_name
        if model_version:
            req.ModelVersion = model_version
        if prompt:
            req.Prompt = prompt
        if negative_prompt:
            req.NegativePrompt = negative_prompt
        req.EnhancePrompt = True  # bool

        # Reference images (image-to-image)
        if ref_image_urls:
            img_infos = []
            for url in ref_image_urls[:14]:  # limits vary per engine, up to 14
                info = mps_models.AigcImageInfo()
                info.ImageUrl = url
                img_infos.append(info)
            req.ImageInfos = img_infos

        # ─────────────────────────────────────────────────────────────
        # Per-engine AspectRatio whitelist + auto-fallback.
        # MPS 모델별로 받는 aspect enum 이 다르다. 호출자가 보낸 값이
        # 화이트리스트에 없으면 가장 가까운 허용값으로 자동 스냅 →
        # 'Image aspect ratio is invalid' 거부를 사전에 차단.
        #
        # 실측 (2026-05) :
        #   * Kling 3.0-Omni : 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3 (7종 OK)
        #   * GEM 3.x        : 16:9 / 9:16 / 1:1 / 4:3 / 3:4         (3:2, 2:3 거부)
        #   * MJ v7          : 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 3:2 / 2:3
        #   * Vidu Image     : 16:9 / 9:16 / 1:1 / 4:3 / 3:4
        #   * Qwen           : 16:9 / 9:16 / 1:1 / 4:3 / 3:4
        #   * Jimeng Image   : 16:9 / 9:16 / 1:1 / 4:3 / 3:4
        #   * OG (gpt-image) : 16:9 / 9:16 / 1:1                       (3종)
        #   * Hunyuan / Seedream : AspectRatio 자체를 안 받음 (size 파라미터로 처리)
        # 모르는 엔진은 가장 좁은 5종(16:9/9:16/1:1/4:3/3:4)으로 둠.
        # ─────────────────────────────────────────────────────────────
        ASPECT_WHITELIST = {
            "GEM":      ["16:9", "9:16", "1:1", "4:3", "3:4"],
            "Kling":    ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
            "Jimeng":   ["16:9", "9:16", "1:1", "4:3", "3:4"],
            "MJ":       ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
            "Vidu":     ["16:9", "9:16", "1:1", "4:3", "3:4"],
            "Qwen":     ["16:9", "9:16", "1:1", "4:3", "3:4"],
            "OG":       ["16:9", "9:16", "1:1"],
        }
        ASPECT_VALUES = {
            "16:9": 16/9, "9:16": 9/16, "1:1": 1.0,
            "4:3":  4/3,  "3:4":  3/4,
            "3:2":  3/2,  "2:3":  2/3,
        }

        def _snap_aspect(asp_in, model):
            """엔진이 받는 aspect 화이트리스트 안에서 가장 가까운 값으로 스냅."""
            wl = ASPECT_WHITELIST.get(model, ["16:9", "9:16", "1:1", "4:3", "3:4"])
            if not asp_in:
                return wl[0]
            if asp_in in wl:
                return asp_in
            target = ASPECT_VALUES.get(asp_in)
            if target is None:
                return wl[0]
            best, best_diff = wl[0], float("inf")
            import math
            for cand in wl:
                v = ASPECT_VALUES.get(cand)
                if v is None:
                    continue
                d = abs(math.log(v) - math.log(target))   # log-space distance
                if d < best_diff:
                    best_diff = d; best = cand
            print(
                f"[image/generate] aspect snap: model={model} "
                f"requested={asp_in} → {best}",
                flush=True,
            )
            return best

        snapped_aspect = _snap_aspect(aspect_ratio, model_name) if aspect_ratio else ""

        # Per-engine resolution / aspect-ratio handling
        extra = mps_models.AigcImageExtraParam()
        use_extra = False
        if model_name == "GEM":
            # GEM uses preset labels
            extra.Resolution = _wh_to_label(wh)
            if snapped_aspect:
                extra.AspectRatio = snapped_aspect
            use_extra = True
        elif model_name in ("Hunyuan", "Seedream"):
            # These accept free width/height via AdditionalParameters {"size": "WxH"}
            if wh:
                w, h = wh
                if model_name == "Hunyuan":
                    # Hunyuan 3.0: [512, 2048], w*h ≤ 1024*1024
                    w = max(512, min(2048, w))
                    h = max(512, min(2048, h))
                    if w * h > 1024 * 1024:
                        scale = (1024 * 1024 / (w * h)) ** 0.5
                        w = max(512, int(w * scale))
                        h = max(512, int(h * scale))
                elif model_name == "Seedream":
                    # Seedream 4.5 / 5.0-lite require ≥ 2560*1440 = 3686400 px
                    if w * h < 2560 * 1440:
                        scale = (2560 * 1440 / (w * h)) ** 0.5
                        w = int(w * scale); h = int(h * scale)
                req.AdditionalParameters = json.dumps({"size": f"{w}x{h}"})
        elif model_name == "Qwen":
            # Qwen 0925 rejects {"size":"WxH"} via AdditionalParameters (ret:100).
            # Empirically, the model works best with no size override at all —
            # let MPS pick the model's native default (tested: DONE in ~18s).
            # If an AspectRatio was provided, forward it via ExtraParameters.
            if snapped_aspect:
                extra.AspectRatio = snapped_aspect
                use_extra = True
        else:
            # Kling / Jimeng / MJ / Vidu / OG: let the model choose its default;
            # only forward AspectRatio if the caller provided it.
            if snapped_aspect:
                extra.AspectRatio = snapped_aspect
                use_extra = True

        # ─────────────────────────────────────────────────────────────
        # Compliance-check bypass (internal testing only).
        # 엔진 키가 '_raw' 로 끝나면 ExtraParameters 에 compliance check 두
        # 필드를 False 로 주입한다. Kling / Vidu 가드레일을 낮춘 모델 호출
        # 용. 진단 로그에 항상 명시적으로 남겨 사후 추적 가능하게 한다.
        #
        # NOTE: MPS Python SDK 의 AigcImageExtraParam 객체는 사전 정의된
        # attribute 만 직렬화하므로, EnableInput/OutputComplianceCheck
        # 필드는 SDK 객체 attribute 로 셋하면 모르는 키로 거부된다.
        # 따라서 raw 케이스에서만 SDK 객체 대신 dict 로 ExtraParameters 를
        # 직접 박는 우회를 한다.
        # ─────────────────────────────────────────────────────────────
        if engine.endswith("_raw"):
            # 기존 SDK 객체에 set 된 값을 dict 로 덤프 후 compliance 키 추가.
            try:
                extra_dict = json.loads(extra.to_json_string())
            except Exception:
                extra_dict = {}
            # SDK 직렬화는 set 안 된 attribute 도 null 로 포함시키므로 제거.
            extra_dict = {k: v for k, v in extra_dict.items() if v is not None}
            extra_dict["EnableInputComplianceCheck"]  = False
            extra_dict["EnableOutputComplianceCheck"] = False
            req.ExtraParameters = extra_dict
            use_extra = False  # 아래 if use_extra 블록을 스킵
            print(
                f"[image/generate] ⚠ COMPLIANCE OFF engine={engine} "
                f"model={model_name}/{model_version} "
                f"extra={extra_dict}",
                flush=True,
            )

        if use_extra:
            req.ExtraParameters = extra

        # 진단 로그 — 어느 엔진 / aspect / resolution 으로 호출됐는지 추적용
        print(
            f"[image/generate] engine={engine} model={model_name}/{model_version} "
            f"aspect_in={aspect_ratio} aspect_used={snapped_aspect or '<none>'} "
            f"resolution={resolution} refs={len(ref_image_urls or [])} "
            f"prompt_len={len(prompt or '')}",
            flush=True,
        )

        # COS storage
        store = mps_models.AigcStoreCosParam()
        store.CosBucketName = COS_BUCKET_NAME
        store.CosBucketRegion = COS_BUCKET_REGION
        store.CosBucketPath = COS_BUCKET_PATH
        req.StoreCosParam = store

        resp = client.CreateAigcImageTask(req)
        result = json.loads(resp.to_json_string())
        task_id = result.get("TaskId", "")

        if not task_id:
            return jsonify({"error": "Failed to create image task", "detail": result}), 500

        # Poll for result (max ~120s)
        image_url = ""
        status = "PROCESSING"
        for _ in range(300):
            time.sleep(2)
            desc_req = mps_models.DescribeAigcImageTaskRequest()
            desc_req.TaskId = task_id
            desc_resp = client.DescribeAigcImageTask(desc_req)
            desc_result = json.loads(desc_resp.to_json_string())
            status = desc_result.get("Status", "PROCESSING")

            if status == "DONE":
                urls = desc_result.get("ImageUrls", [])
                if isinstance(urls, list) and urls:
                    image_url = urls[0]
                break
            elif status in ("FAIL", "FAILED"):
                raw = desc_result.get('Message', 'Unknown error')
                # aspect-ratio 거부면 ref 유무에 따라 친절 메시지로 변환,
                # 그 외엔 resolution 거부 변환을 시도.
                friendly = _friendly_aspect_error(
                    raw,
                    requested_aspect=(snapped_aspect or aspect_ratio or ""),
                    has_refs=bool(ref_image_urls),
                )
                if friendly == raw:
                    friendly = _friendly_resolution_error(raw, requested_res=resolution)
                # 엔진/aspect 정보를 같이 노출해 디버깅을 쉽게 한다.
                ctx = (f" [engine={engine} aspect_used={snapped_aspect or 'auto'} "
                       f"res={resolution} refs={len(ref_image_urls or [])}]")
                print(
                    f"[image/generate] FAIL engine={engine} aspect_in={aspect_ratio} "
                    f"aspect_used={snapped_aspect} refs={len(ref_image_urls or [])} "
                    f"raw={raw[:200]}",
                    flush=True,
                )
                return jsonify({"error": f"Image generation failed: {friendly}{ctx}", "task_id": task_id}), 500
            elif status == "STOP":
                msg = desc_result.get("Message") or "Task stopped by content safety policy (check prompt / reference image)."
                return jsonify({"error": f"Image generation stopped: {msg}", "task_id": task_id, "status": "STOP"}), 400

        if status != "DONE":
            return jsonify({"error": "Image generation timed out (600s). Task may still be processing.", "task_id": task_id}), 504

        resp_payload = {
            "image_url": image_url,
            "task_id": task_id,
            "engine": engine,
            "model": f"{model_name} {model_version}".strip(),
        }
        if fallback_info:
            resp_payload["fallback"] = fallback_info
        return jsonify(resp_payload)

    except TencentCloudSDKException as e:
        # 해상도 미지원 등 사용자가 의미를 이해할 수 있게 변환
        friendly = _friendly_resolution_error(str(e), requested_res=resolution)
        return jsonify({"error": friendly}), 500
    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500


@app.route("/api/video/generate", methods=["POST"])
def generate_video():
    """Create an AIGC video generation task and poll for the result."""
    if not MPS_SDK_AVAILABLE:
        return jsonify({"error": "MPS SDK not installed on server. pip install tencentcloud-sdk-python"}), 500

    data = request.get_json()
    token = _get_token(data)
    prompt = data.get("prompt", "")
    engine = data.get("engine", "kling30omni")
    aspect_ratio = data.get("aspect_ratio", "16:9")
    resolution = data.get("resolution", "720P")
    duration_str = data.get("duration", "5s")
    start_frame_url = data.get("start_frame_url", "")
    end_frame_url = data.get("end_frame_url", "")
    ref_image_urls = data.get("ref_image_urls", [])
    negative_prompt = data.get("negative_prompt", "")

    # Diagnostic log — confirms i2v inputs reaching the server.
    # NOTE: helps debug "AI didn't seem to use my image" reports from battle UI.
    print(
        f"[video/generate] engine={engine} prompt_len={len(prompt or '')} "
        f"start_frame_url={'<set>' if start_frame_url else '<empty>'} "
        f"start_frame_host={(start_frame_url.split('/')[2] if start_frame_url and '://' in start_frame_url else '')} "
        f"end_frame_url={'<set>' if end_frame_url else '<empty>'} "
        f"ref_count={len(ref_image_urls or [])}",
        flush=True,
    )

    if not prompt and not start_frame_url:
        return jsonify({"error": "Prompt or start frame image is required."}), 400

    if engine not in VIDEO_ENGINE_MAP:
        return jsonify({
            "error": f"Unsupported video engine '{engine}'. MPS AIGC supports only: "
                     f"{', '.join(sorted(VIDEO_ENGINE_MAP.keys()))}"
        }), 400

    # Parse duration string like "5s" → 5
    try:
        duration_sec = int(str(duration_str).replace("s", "").strip())
    except (ValueError, AttributeError):
        duration_sec = 5

    model_name, model_version = VIDEO_ENGINE_MAP[engine]

    client = _get_mps_client()
    if not client:
        return jsonify({"error": "Server credentials not configured (TENCENTCLOUD_SECRET_ID / SECRET_KEY)."}), 500

    try:
        req = mps_models.CreateAigcVideoTaskRequest()
        req.ModelName = model_name
        if model_version:
            req.ModelVersion = model_version
        if prompt:
            req.Prompt = prompt
        if negative_prompt:
            req.NegativePrompt = negative_prompt
        req.EnhancePrompt = True  # bool
        req.Duration = duration_sec

        # Start frame (image-to-video)
        if start_frame_url:
            req.ImageUrl = start_frame_url
        # End frame (only certain models support this)
        if end_frame_url:
            req.LastImageUrl = end_frame_url
        # Reference images (max 3 per MPS spec)
        if ref_image_urls:
            img_infos = []
            for url in ref_image_urls[:3]:
                info = mps_models.AigcVideoReferenceImageInfo()
                info.ImageUrl = url
                img_infos.append(info)
            req.ImageInfos = img_infos

        # Extra parameters
        extra = mps_models.AigcVideoExtraParam()
        if resolution:
            extra.Resolution = resolution
        if aspect_ratio:
            extra.AspectRatio = aspect_ratio
        # ─────────────────────────────────────────────────────────────
        # Compliance-check bypass (internal testing only).
        # 엔진 키가 '_raw' 로 끝나면 두 compliance 필드를 False 로 주입.
        # SDK 객체는 모르는 attribute 라 거부하므로 dict 로 우회한다.
        # ─────────────────────────────────────────────────────────────
        if engine.endswith("_raw"):
            try:
                extra_dict = json.loads(extra.to_json_string())
            except Exception:
                extra_dict = {}
            # SDK 직렬화는 set 안 된 attribute 도 null 로 포함시키므로 제거.
            extra_dict = {k: v for k, v in extra_dict.items() if v is not None}
            extra_dict["EnableInputComplianceCheck"]  = False
            extra_dict["EnableOutputComplianceCheck"] = False
            req.ExtraParameters = extra_dict
            print(
                f"[video/generate] ⚠ COMPLIANCE OFF engine={engine} "
                f"model={model_name}/{model_version} "
                f"extra={extra_dict}",
                flush=True,
            )
        else:
            req.ExtraParameters = extra

        # COS storage
        store = mps_models.AigcStoreCosParam()
        store.CosBucketName = COS_BUCKET_NAME
        store.CosBucketRegion = COS_BUCKET_REGION
        store.CosBucketPath = COS_BUCKET_PATH
        req.StoreCosParam = store

        resp = client.CreateAigcVideoTask(req)
        result = json.loads(resp.to_json_string())
        task_id = result.get("TaskId", "")

        # 진단: task_id + 요청 핵심 파라미터를 로그에 남겨, 클라이언트가 일찍 끊겨도
        # 해당 task의 진행상황을 별도로 폴링/추적 가능하게 한다. (4K/2K 지원 조사용)
        print(
            f"[video/generate] CREATED engine={engine} model={model_name}/{model_version} "
            f"resolution={resolution} aspect={aspect_ratio} duration={duration_sec}s "
            f"task_id={task_id}",
            flush=True,
        )

        if not task_id:
            return jsonify({"error": "Failed to create video task", "detail": result}), 500

        # Poll for result (max ~300s = 5 min, video takes longer)
        video_url = ""
        status = "PROCESSING"
        for _ in range(300):
            time.sleep(2)
            desc_req = mps_models.DescribeAigcVideoTaskRequest()
            desc_req.TaskId = task_id
            desc_resp = client.DescribeAigcVideoTask(desc_req)
            desc_result = json.loads(desc_resp.to_json_string())
            status = desc_result.get("Status", "PROCESSING")

            if status == "DONE":
                urls = desc_result.get("VideoUrls", [])
                if isinstance(urls, list) and urls:
                    video_url = urls[0]
                break
            elif status in ("FAIL", "FAILED"):
                raw = desc_result.get('Message', 'Unknown error')
                friendly = _friendly_resolution_error(raw, requested_res=resolution)
                return jsonify({"error": f"Video generation failed: {friendly}", "task_id": task_id}), 500
            elif status == "STOP":
                msg = desc_result.get("Message") or "Task stopped by content safety policy (check prompt / start frame / reference)."
                return jsonify({"error": f"Video generation stopped: {msg}", "task_id": task_id, "status": "STOP"}), 400

        if status != "DONE":
            return jsonify({"error": "Video generation timed out (600s). Task may still be processing.", "task_id": task_id}), 504

        return jsonify({
            "video_url": video_url,
            "task_id": task_id,
            "engine": engine,
            "model": f"{model_name} {model_version}".strip(),
            "duration": duration_sec,
        })

    except TencentCloudSDKException as e:
        # 해상도 미지원 등 사용자가 의미를 이해할 수 있게 변환
        friendly = _friendly_resolution_error(str(e), requested_res=resolution)
        return jsonify({"error": friendly}), 500
    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500


# =====================================================================
#  Music Gen  &  3D Gen  (Tencent VOD AIGC endpoint)
# ---------------------------------------------------------------------
#  Image/Video AIGC 는 MPS endpoint(mps_client) 의 typed request 로 가지만,
#  Music(CreateAigcAudioTask) 와 3D(panorama/scene) 는 VOD AIGC endpoint
#  로만 제공된다. MPS Python SDK 에는 CreateAigcAudioTaskRequest 가 없어
#  (실측) generic CommonClient.call_json 으로 호출한다.
#
#  검증 완료(2026-06, /usr/bin/python3 live smoke test):
#    [Music] Kling SFX / MiniMaxMusic 2.0·2.5·2.6 / GL 3.0-clip·3.0-pro
#    [3D]    Panorama = CreateAigcImageTask SceneType=3d_panorama
#            Scene    = CreateAigcVideoTask SceneType=3d_scene (장시간)
#
#  출력 경로 (DescribeTaskDetail):
#    Audio    : AigcAudioTask.Output.AudioInfos[].FileUrl
#    Panorama : AigcImageTask.Output.FileInfos[].FileUrl
#    Scene    : AigcVideoTask.Output.FileInfos[].FileUrl
# =====================================================================
VOD_REGION = os.environ.get("AIGC_VOD_REGION", "ap-seoul")


def _get_vod_common_client():
    """Generic VOD CommonClient for AIGC音乐/3D tasks (no typed SDK request)."""
    secret_id = os.environ.get("TENCENTCLOUD_SECRET_ID", "")
    secret_key = os.environ.get("TENCENTCLOUD_SECRET_KEY", "")
    if not secret_id or not secret_key:
        return None
    from tencentcloud.common import credential as _cred
    from tencentcloud.common.profile.client_profile import ClientProfile
    from tencentcloud.common.profile.http_profile import HttpProfile
    from tencentcloud.common.common_client import CommonClient
    cred = _cred.Credential(secret_id, secret_key)
    hp = HttpProfile()
    hp.endpoint = "vod.tencentcloudapi.com"
    cp = ClientProfile()
    cp.httpProfile = hp
    return CommonClient("vod", "2018-07-17", cred, VOD_REGION, profile=cp)


def _vod_poll_task(client, task_id, output_key, file_list_key, file_url_key="FileUrl",
                   max_loops=300, interval=2.0):
    """Poll VOD DescribeTaskDetail until terminal.

    output_key   : e.g. "AigcAudioTask" / "AigcImageTask" / "AigcVideoTask"
    file_list_key: e.g. "AudioInfos" / "ImageInfos" / "VideoInfos"
    Returns (status_ok: bool, url: str, err_msg: str, raw: dict).
    """
    for _ in range(max_loops):
        time.sleep(interval)
        desc = client.call_json("DescribeTaskDetail", {"TaskId": task_id})
        resp = desc.get("Response", {})
        task = resp.get(output_key) or {}
        status = task.get("Status", "PROCESSING")
        err_code = task.get("ErrCode", 0)
        if status in ("FINISH", "DONE"):
            if err_code and err_code != 0:
                return False, "", (task.get("Message") or f"ErrCode={err_code}"), resp
            out = task.get("Output") or {}
            # VOD AIGC output-info key varies by task type
            # (FileInfos / AudioInfos / ImageInfos / VideoInfos). Try the
            # caller's preferred key first, then fall back across all known
            # keys so we reliably extract the generated asset URL.
            url = ""
            candidate_keys = [file_list_key, "FileInfos", "AudioInfos",
                              "ImageInfos", "VideoInfos"]
            for k in candidate_keys:
                infos = out.get(k)
                if isinstance(infos, list) and infos:
                    url = infos[0].get(file_url_key) or infos[0].get("Url") or ""
                    if url:
                        break
            return True, url, "", resp
        if status in ("FAIL", "FAILED", "ERROR"):
            return False, "", (task.get("Message") or f"status={status}"), resp
    return False, "", "timeout", {}


def _is_compliance_error(msg):
    """True if a VOD AIGC failure message indicates input/output content
    moderation (审核/合规) rejection rather than a technical error.

    NOTE: do NOT match the bare word "提示词" (= "prompt") here — many
    *validation* messages (e.g. "请输入描述场景的提示词") also contain it but
    are about prompt quality, not moderation. Use _is_bad_prompt_error() for
    those. Keep these needles specific to genuine moderation rejections."""
    if not msg:
        return False
    m = str(msg)
    needles = (
        "输入提示词中包含", "包含敏感", "敏感词", "敏感信息", "违规", "违禁",
        "审核不通过", "审核未通过", "内容审核", "不合规", "涉政", "涉黄",
        "色情", "暴力", "政治", "compliance", "moderation", "sensitive",
        "prohibited", "violat",
    )
    return any(n in m for n in needles)


def _is_bad_prompt_error(msg):
    """True if the failure is a prompt-quality / validation issue (the model
    couldn't understand the prompt or needs a more concrete scene
    description) rather than a moderation rejection or technical fault."""
    if not msg:
        return False
    m = str(msg)
    needles = (
        "请输入描述", "描述场景", "请输入提示词", "提示词不能为空", "请输入",
        "无法识别", "无法理解", "prompt is required", "invalid prompt",
        "describe the scene", "empty prompt",
    )
    return any(n in m for n in needles)


# ---- Music engine map : key -> (ModelName, ModelVersion, kind) ----
#  kind: "music" (with optional lyrics) | "sfx" (sound effect, prompt only)
MUSIC_ENGINE_MAP = {
    "minimax_music_26": ("MiniMaxMusic", "2.6", "music"),
    "minimax_music_25": ("MiniMaxMusic", "2.5", "music"),
    "minimax_music_20": ("MiniMaxMusic", "2.0", "music"),
    "lyria_pro":        ("GL", "3.0-pro",  "music"),
    "lyria_clip":       ("GL", "3.0-clip", "music"),
    "kling_sfx":        ("Kling", "",      "sfx"),
}


@app.route("/api/music/generate", methods=["POST"])
def generate_music():
    """Create an AIGC audio (music / sfx) task via VOD CommonClient and poll."""
    if not MPS_SDK_AVAILABLE:
        return jsonify({"error": "Tencent Cloud SDK not installed on server."}), 500

    data = request.get_json() or {}
    engine = data.get("engine", "minimax_music_25")
    prompt = (data.get("prompt") or "").strip()
    lyrics = (data.get("lyrics") or "").strip()
    instrumental = bool(data.get("instrumental", False))
    duration = data.get("duration")  # seconds, optional (mainly SFX)

    if engine not in MUSIC_ENGINE_MAP:
        return jsonify({
            "error": f"Unsupported music engine '{engine}'. Supported: "
                     f"{', '.join(sorted(MUSIC_ENGINE_MAP.keys()))}"
        }), 400

    if not prompt:
        return jsonify({"error": "Prompt is required."}), 400

    model_name, model_version, kind = MUSIC_ENGINE_MAP[engine]

    client = _get_vod_common_client()
    if not client:
        return jsonify({"error": "Server credentials not configured."}), 500

    try:
        params = {
            "SubAppId": HARD_SUB_APP_ID,
            "ModelName": model_name,
            "SceneType": kind,            # REQUIRED: "music" | "sfx"
            "Prompt": prompt,
        }
        if model_version:
            params["ModelVersion"] = model_version

        # OutputConfig is required by CreateAigcAudioTask.
        if kind == "sfx":
            output_config = {"StorageMode": "Temporary"}
            # SFX Duration belongs INSIDE OutputConfig, not top-level.
            if duration:
                try:
                    output_config["Duration"] = int(duration)
                except (ValueError, TypeError):
                    pass
        else:
            output_config = {"StorageMode": "Temporary", "OutputAudioFormat": "mp3"}
        params["OutputConfig"] = output_config

        # AdditionalParameters: model-specific extras (music only).
        addl = {}
        if kind == "music":
            # MiniMaxMusic / GL Lyria accept lyrics + instrumental flag.
            if lyrics:
                addl["lyrics"] = lyrics
            if instrumental:
                addl["instrumental"] = True
        if addl:
            params["AdditionalParameters"] = json.dumps(addl, ensure_ascii=False)

        print(
            f"[music/generate] engine={engine} model={model_name}/{model_version} "
            f"kind={kind} prompt_len={len(prompt)} lyrics={'Y' if lyrics else 'N'} "
            f"instrumental={instrumental}",
            flush=True,
        )

        created = client.call_json("CreateAigcAudioTask", params)
        task_id = (created.get("Response") or {}).get("TaskId", "")
        if not task_id:
            return jsonify({"error": "Failed to create audio task", "detail": created}), 500

        ok, url, err, _raw = _vod_poll_task(
            client, task_id, "AigcAudioTask", "AudioInfos",
            max_loops=300, interval=2.0,
        )
        if not ok:
            if err == "timeout":
                return jsonify({"error": "Music generation timed out.", "task_id": task_id}), 504
            if _is_bad_prompt_error(err):
                return jsonify({
                    "error": "음악 생성을 위해 더 구체적인 설명이 필요합니다. "
                             "장르·분위기·악기 등을 적어 주세요. "
                             "(예: \"잔잔한 피아노 발라드, 비 오는 밤 분위기\")",
                    "detail": err, "task_id": task_id, "bad_prompt": True,
                }), 400
            if _is_compliance_error(err):
                return jsonify({
                    "error": "프롬프트가 콘텐츠 검수에서 거부되었습니다. "
                             "다른 표현으로 다시 시도해 주세요.",
                    "detail": err, "task_id": task_id, "compliance": True,
                }), 400
            return jsonify({"error": f"Music generation failed: {err}", "task_id": task_id}), 500

        return jsonify({
            "audio_url": url,
            "task_id": task_id,
            "engine": engine,
            "model": f"{model_name} {model_version}".strip(),
            "kind": kind,
        })
    except TencentCloudSDKException as e:
        return jsonify({"error": f"VOD AIGC audio error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500


@app.route("/api/threed/generate", methods=["POST"])
def generate_threed():
    """Create an AIGC 3D task (panorama / scene) via VOD CommonClient and poll.

    kind == "panorama" : CreateAigcImageTask SceneType=3d_panorama  (~1min)
    kind == "scene"    : CreateAigcVideoTask SceneType=3d_scene     (장시간)
    """
    if not MPS_SDK_AVAILABLE:
        return jsonify({"error": "Tencent Cloud SDK not installed on server."}), 500

    data = request.get_json() or {}
    kind = (data.get("kind") or "panorama").strip()
    prompt = (data.get("prompt") or "").strip()
    image_url = (data.get("image_url") or "").strip()

    if kind not in ("panorama", "scene"):
        return jsonify({"error": f"Unsupported 3D kind '{kind}'. Use 'panorama' or 'scene'."}), 400
    if not prompt and not image_url:
        return jsonify({"error": "Prompt or reference image is required."}), 400

    client = _get_vod_common_client()
    if not client:
        return jsonify({"error": "Server credentials not configured."}), 500

    try:
        if kind == "panorama":
            action = "CreateAigcImageTask"
            scene_type = "3d_panorama"
            output_key = "AigcImageTask"
            file_list_key = "ImageInfos"
            output_config = {"StorageMode": "Temporary"}
            max_loops, interval = 180, 3.0
        else:
            action = "CreateAigcVideoTask"
            scene_type = "3d_scene"
            output_key = "AigcVideoTask"
            file_list_key = "VideoInfos"
            output_config = {"StorageMode": "Temporary", "Resolution": "1080P"}
            max_loops, interval = 600, 4.0

        params = {
            "SubAppId": HARD_SUB_APP_ID,
            "ModelName": "Hunyuan",
            "ModelVersion": "3d_2.0",
            "SceneType": scene_type,
            "OutputConfig": output_config,
        }
        if prompt:
            params["Prompt"] = prompt
        if image_url:
            params["ImageInfos"] = [{"ImageUrl": image_url}]

        print(
            f"[threed/generate] kind={kind} action={action} scene={scene_type} "
            f"prompt_len={len(prompt)} has_image={'Y' if image_url else 'N'}",
            flush=True,
        )

        created = client.call_json(action, params)
        task_id = (created.get("Response") or {}).get("TaskId", "")
        if not task_id:
            return jsonify({"error": "Failed to create 3D task", "detail": created}), 500

        ok, url, err, _raw = _vod_poll_task(
            client, task_id, output_key, file_list_key,
            max_loops=max_loops, interval=interval,
        )
        if not ok:
            if err == "timeout":
                # Scene 은 매우 오래 걸려 timeout 이어도 task_id 로 추후 조회 가능.
                return jsonify({
                    "error": "3D generation timed out. Task may still be processing.",
                    "task_id": task_id, "kind": kind,
                }), 504
            if _is_bad_prompt_error(err):
                return jsonify({
                    "error": "3D 생성은 구체적인 '장면' 묘사가 필요합니다. "
                             "'아름다운 세상'처럼 추상적인 표현 대신 장소·사물·"
                             "분위기를 자세히 적어 주세요. "
                             "(예: \"노을 지는 해변, 야자수와 모래사장, 잔잔한 파도\")",
                    "detail": err, "task_id": task_id, "bad_prompt": True,
                }), 400
            if _is_compliance_error(err):
                return jsonify({
                    "error": "프롬프트가 콘텐츠 검수에서 거부되었습니다. "
                             "다른 표현으로 다시 시도해 주세요.",
                    "detail": err, "task_id": task_id, "compliance": True,
                }), 400
            return jsonify({"error": f"3D generation failed: {err}", "task_id": task_id}), 500

        return jsonify({
            "url": url,
            "task_id": task_id,
            "kind": kind,
        })
    except TencentCloudSDKException as e:
        return jsonify({"error": f"VOD AIGC 3D error: {str(e)}"}), 500
    except Exception as e:
        return jsonify({"error": f"Server error: {str(e)}"}), 500

# =============================================================================
# (Removed) AI Studio / Forge / Save-to-Gallery / Gallery endpoints
# -----------------------------------------------------------------------------
# This reference build keeps ONLY the five core generators:
#   Text (chat/stream), Image, Video, Music, 3D.
# The following feature endpoints from the full Playground were removed:
#   /api/dub/voices, /api/forge/split_grid, /api/forge/concat,
#   /api/save_permanent, /api/gallery/list|save|delete
# =============================================================================


if __name__ == "__main__":
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    host = os.environ.get("FLASK_HOST", "127.0.0.1")
    port = int(os.environ.get("FLASK_PORT", "5050"))
    app.run(host=host, port=port, debug=debug)
