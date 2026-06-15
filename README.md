# Tencent Media AIGC Playground — UI Reference Build

A lightweight, **reference-only** web UI for experimenting with Tencent Cloud
media-AIGC capabilities from a single page:

- **Image Gen** — text-to-image / image-to-image
- **Text Gen** — LLM chat & streaming
- **Video Gen** — text-to-video / image-to-video
- **Music Gen** — music & sound-effect generation
- **3D Gen** — 3D panorama / scene generation
- **Image / Video Battle** — run the same prompt across multiple engines side by side

This package is meant as a **UI / integration reference** that you can run and
adapt. It is intentionally trimmed down and contains **no credentials, no
account identifiers, and no persistence layer**.

---

## ⚠️ Billing warning (read first)

Every generation call in this app invokes a **paid** Tencent Cloud API
(MPS / VOD AIGC / LLM) and is billed against **your own** Tencent Cloud
account. There is **no built-in authentication or rate limiting** in this
reference build.

> **Do NOT expose this server directly to the public internet.**
> Anyone who can reach it can spend your money.

Before deploying anywhere reachable by others, add at minimum:
authentication, per-user rate limiting, and a spending budget/alert on your
Tencent Cloud account.

---

## Bring your own keys

This repository ships with **all secrets blanked out on purpose**. The code
reads everything from environment variables (see `.env.example`). Nothing
identifiable (keys, bucket names, APPID, host, domain) is hardcoded.

1. Copy the example env file and fill in your own values:
   ```bash
   cp .env.example .env
   # edit .env — at minimum TENCENTCLOUD_SECRET_ID / SECRET_KEY
   #             and the two COS buckets (reference-image + output)
   ```
2. Use a **least-privilege sub-account**, never your root credentials.

You will need:

| Purpose                | Env var(s)                                   |
|------------------------|----------------------------------------------|
| Tencent Cloud auth     | `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY` |
| Reference-image bucket | `AIGC_REF_BUCKET`, `AIGC_REF_REGION`         |
| Output bucket          | `AIGC_COS_BUCKET`, `AIGC_COS_REGION`         |
| VOD sub-app / region   | `AIGC_SUB_APP_ID`, `AIGC_VOD_REGION`         |

> **Why two buckets?** Image-to-image / image-to-video reference images must be
> fetchable by MPS over the public internet, so the app uploads them to a COS
> bucket you own and passes MPS a **pre-signed URL** (valid 1 hour). The bucket
> itself does not need to be public.

---

## Run locally

Requirements: Python 3.10+.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # then edit .env with your values
set -a; source .env; set +a

# Development:
python3 app.py              # serves on http://127.0.0.1:5050

# Production-style:
gunicorn -c gunicorn.conf.py app:app
```

Open <http://127.0.0.1:5050>.

---

## Architecture

```
app.py             Flask backend. Proxies requests to Tencent Cloud
                   MPS / VOD AIGC / LLM APIs. Reads ALL secrets from env.
claude_bridge.py   Optional Anthropic-style chat bridge.
gunicorn.conf.py   Production server config.
templates/
  index.html       Single-page UI (sidebar + content + debug panel).
static/
  js/app.js              Main front-end logic (vanilla JS).
  js/engine_picker.js    Engine/model selector widget.
  js/aigc_progress.js    Progress/polling UI.
  js/vendor/             marked.min.js, purify.min.js (markdown + sanitize).
  css/                   style.css, engine_picker.css, style_typography.css.
  img/ , icons/          Logo and placeholder assets.
```

API routes exposed by `app.py`:

| Route                  | Purpose                       |
|------------------------|-------------------------------|
| `GET  /`               | Serve the UI                  |
| `POST /api/chat`       | LLM chat (non-streaming)      |
| `POST /api/stream`     | LLM chat (streaming)          |
| `POST /api/upload`     | Stage a reference image to COS|
| `POST /api/image/generate` | Image generation          |
| `POST /api/video/generate` | Video generation          |
| `POST /api/music/generate` | Music / SFX generation    |
| `POST /api/threed/generate`| 3D panorama / scene       |

---

## What was removed from the full app (and why)

To keep this reference small and safe, the following were stripped out:

- **AI Studio** (multi-step storyboarding workflow) — `forge.js`, `studio.js`
- **Gallery / temporary-save** persistence — `history.js`, `app-persistence.js`
- **Local database** — all SQLite usage and the cumulative-usage stats panel
- All real credentials, bucket names, APPID, internal IPs, and the private API-guide links (blanked + commented in place)

The remaining code degrades gracefully without those modules.

---

## License / usage

Provided as an implementation reference. You are responsible for your own
Tencent Cloud usage, costs, security hardening, and compliance.
