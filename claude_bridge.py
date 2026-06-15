"""Bridge: route requests with model id starting with "cd-" to Anthropic /v1/messages.

Non-streaming: returns an OpenAI-like dict so app.py's /api/chat return contract stays identical.
Streaming:    emits FLAT events {content, usage, done, elapsed, debug_request} to match the
              exact format the existing frontend parser (app.js /api/stream loop) expects.
"""
from __future__ import annotations
import json
import time
import requests

MESSAGES_URL = "https://text-aigc.vod-qcloud.com/v1/messages"
ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_MAX_TOKENS = 4096


def is_claude(model):
    return isinstance(model, str) and model.startswith("cd-")


def _split_system(messages):
    sys_parts = []
    rest = []
    for m in messages or []:
        if m.get("role") == "system":
            c = m.get("content", "")
            if isinstance(c, list):
                for blk in c:
                    if isinstance(blk, dict) and blk.get("type") == "text":
                        sys_parts.append(blk.get("text", ""))
            else:
                sys_parts.append(str(c))
        else:
            rest.append(m)
    return ("\n\n".join([s for s in sys_parts if s]), rest)


def _build_payload(model, messages, temperature, max_tokens):
    system, rest = _split_system(messages)
    payload = {
        "model": model,
        "max_tokens": int(max_tokens or DEFAULT_MAX_TOKENS),
        "messages": rest,
    }
    if system:
        payload["system"] = system
    if temperature is not None:
        try:
            t = float(temperature)
            if 0 <= t <= 1:
                payload["temperature"] = t
        except (TypeError, ValueError):
            pass
    return payload


def _headers(token):
    return {
        "x-api-key": token,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
    }


def _content_to_text(content_blocks):
    if isinstance(content_blocks, str):
        return content_blocks
    if not isinstance(content_blocks, list):
        return ""
    out = []
    for blk in content_blocks:
        if isinstance(blk, dict) and blk.get("type") == "text":
            out.append(blk.get("text", ""))
    return "".join(out)


def call_messages(model, messages, temperature, token, max_tokens=None, timeout=120):
    """Non-streaming. Returns (status_code, openai_like_payload_or_None, raw, debug_request)."""
    payload = _build_payload(model, messages, temperature, max_tokens)
    debug_request = {
        "url": MESSAGES_URL,
        "method": "POST",
        "headers": {"x-api-key": "***masked***", "anthropic-version": ANTHROPIC_VERSION,
                    "Content-Type": "application/json"},
        "body": payload,
    }
    start = time.time()
    resp = requests.post(MESSAGES_URL, json=payload, headers=_headers(token), timeout=timeout)
    elapsed = round(time.time() - start, 2)
    try:
        raw = resp.json()
    except ValueError:
        raw = {"raw_text": resp.text[:2000]}
    if resp.status_code != 200:
        return resp.status_code, None, raw, debug_request

    answer = _content_to_text(raw.get("content"))
    usage = raw.get("usage") or {}
    out = {
        "answer": answer,
        "model": raw.get("model", model),
        "usage": {
            "prompt_tokens":     int(usage.get("input_tokens", 0) or 0),
            "completion_tokens": int(usage.get("output_tokens", 0) or 0),
            "total_tokens":      int((usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)),
            "cached_tokens":     int(usage.get("cache_read_input_tokens", 0) or 0),
            "reasoning_tokens":  0,
        },
        "elapsed": elapsed,
        "request_id": raw.get("id", ""),
        "debug": {"request": debug_request, "response": raw},
    }
    return 200, out, raw, debug_request


def stream_messages(model, messages, temperature, token, max_tokens=None, timeout=120):
    """Streaming generator — emits FLAT events matching the frontend parser:
         {debug_request: ...}         — first
         {content: "text chunk"}      — many
         {usage: {...}, done: true, elapsed: N, debug_response: raw_events}  — final
         {error: "..."}               — on failure
    """
    payload = dict(_build_payload(model, messages, temperature, max_tokens))
    payload["stream"] = True
    debug_request = {
        "url": MESSAGES_URL,
        "method": "POST",
        "headers": {"x-api-key": "***masked***", "anthropic-version": ANTHROPIC_VERSION,
                    "Content-Type": "application/json"},
        "body": payload,
    }
    yield "data: " + json.dumps({"debug_request": debug_request}) + "\n\n"

    start = time.time()
    try:
        resp = requests.post(MESSAGES_URL, json=payload, headers=_headers(token),
                             timeout=timeout, stream=True)
    except requests.exceptions.Timeout:
        yield "data: " + json.dumps({"error": "요청 시간이 초과되었습니다."}) + "\n\n"
        return
    except requests.exceptions.ConnectionError:
        yield "data: " + json.dumps({"error": "API 서버에 연결할 수 없습니다."}) + "\n\n"
        return
    except Exception as e:
        yield "data: " + json.dumps({"error": "오류 발생: " + str(e)}) + "\n\n"
        return

    if resp.status_code != 200:
        msg = None
        try:
            err = resp.json()
            if isinstance(err, dict):
                msg = (err.get("error") or {}).get("message")
        except Exception:
            pass
        yield "data: " + json.dumps({"error": "API Error " + str(resp.status_code) + ": " + (msg or resp.text[:300])}) + "\n\n"
        return

    raw_events = []
    in_tokens = 0
    out_tokens = 0
    cached = 0

    for line in resp.iter_lines():
        if not line:
            continue
        s = line.decode("utf-8", errors="ignore")
        if s.startswith("event:"):
            continue
        if not s.startswith("data: "):
            continue
        body = s[6:].strip()
        if not body:
            continue
        try:
            ev = json.loads(body)
        except json.JSONDecodeError:
            continue

        raw_events.append(ev)
        et = ev.get("type")

        if et == "message_start":
            msg = ev.get("message", {}) or {}
            usage = msg.get("usage", {}) or {}
            in_tokens = int(usage.get("input_tokens", in_tokens) or in_tokens)
            cached = int(usage.get("cache_read_input_tokens", cached) or cached)
        elif et == "content_block_delta":
            delta = ev.get("delta", {}) or {}
            if delta.get("type") == "text_delta":
                text = delta.get("text", "")
                if text:
                    yield "data: " + json.dumps({"content": text}) + "\n\n"
        elif et == "message_delta":
            usage = ev.get("usage", {}) or {}
            out_tokens = int(usage.get("output_tokens", out_tokens) or out_tokens)
        elif et == "message_stop":
            elapsed = round(time.time() - start, 2)
            final = {
                "usage": {
                    "prompt_tokens": in_tokens,
                    "completion_tokens": out_tokens,
                    "total_tokens": in_tokens + out_tokens,
                    "cached_tokens": cached,
                    "reasoning_tokens": 0,
                },
                "done": True,
                "elapsed": elapsed,
                "debug_response": raw_events,
            }
            yield "data: " + json.dumps(final) + "\n\n"
            return
        # ignore: ping, content_block_start, content_block_stop

    # Fallback if stream ended without message_stop
    elapsed = round(time.time() - start, 2)
    yield "data: " + json.dumps({
        "usage": {
            "prompt_tokens": in_tokens,
            "completion_tokens": out_tokens,
            "total_tokens": in_tokens + out_tokens,
            "cached_tokens": cached,
            "reasoning_tokens": 0,
        },
        "done": True,
        "elapsed": elapsed,
        "debug_response": raw_events,
    }) + "\n\n"
