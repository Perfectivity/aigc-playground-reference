# Tencent Media AIGC Playground — UI 참고용 빌드

🐯🐯관련 문의는 Tencent korea justinkim을 찾아주세요🐯🐯

Tencent Cloud의 AIGC (MaaS) 기능들을 한 페이지에서 실험해볼 수 있는 **참고용(reference-only)** 경량 웹 UI입니다.

- **Image Gen** — 텍스트→이미지 / 이미지→이미지
- **Text Gen** — LLM 채팅 및 스트리밍
- **Video Gen** — 텍스트→영상 / 이미지→영상
- **Music Gen** — 음악 및 효과음 생성
- **3D Gen** — 3D 파노라마 / 씬 생성
- **Image / Video Battle** — 동일 프롬프트를 여러 엔진에 동시에 돌려 나란히 비교

이 패키지는 직접 실행하고 수정해볼 수 있는 **UI / 연동 참고용**입니다, **자격증명·계정 식별자·DB관련 코드가 전혀 포함되어 있지 않습니다.**

---

## ⚠️ 과금 경고 (먼저 읽어주세요)

이 앱의 모든 생성 호출은 **유료** Tencent Cloud API(MPS / VOD AIGC / LLM)를 호출하며, **해당 Tencent Cloud 계정**으로 과금됩니다. 이 참고용 빌드에는 **인증이나 호출 제한(rate limiting)이 내장되어 있지 않습니다.**
채널 고객사에서 사용하시는 경우 과금 제어가 가능한 AKSK를 입력하여 주시길 바랍니다. 

---

## 고객사의 키를 직접 넣어 사용 (Bring your own keys)

이 저장소는 **모든 비밀값이 의도적으로 비워진 상태**로 배포됩니다. 코드는 모든 값을 환경변수에서 읽어옵니다(`.env.example` 참고). 키, 버킷 이름, APPID, 호스트, 도메인 등 식별 가능한 정보는 하드코딩되어 있지 않습니다.

1. 예제 env 파일을 복사해 고객사의 값으로 채웁니다:
   ```bash
   cp .env.example .env
   # .env 편집 — 최소한 TENCENTCLOUD_SECRET_ID / SECRET_KEY
   #             그리고 COS 버킷 2개(참조 이미지용 + 출력용)
   ```
2. 루트 자격증명이 아니라 **최소 권한의 서브 계정(sub-account)** 을 사용하세요.

필요한 항목:

| 용도                    | 환경변수                                       |
|-------------------------|-----------------------------------------------|
| Tencent Cloud 인증      | `TENCENTCLOUD_SECRET_ID`, `TENCENTCLOUD_SECRET_KEY` |
| 참조 이미지 버킷        | `AIGC_REF_BUCKET`, `AIGC_REF_REGION`          |
| 출력 버킷               | `AIGC_COS_BUCKET`, `AIGC_COS_REGION`          |
| VOD 서브앱 / 리전       | `AIGC_SUB_APP_ID`, `AIGC_VOD_REGION`          |

> **왜 버킷이 2개인가요?** 이미지→이미지 / 이미지→영상에 쓰이는 참조 이미지는 MPS가 퍼블릭 망을 통해 가져갈 수 있어야 합니다. 그래서 앱이 본인 소유의 COS 버킷에 업로드한 뒤, MPS에 **미리 서명된 URL(pre-signed URL, 유효 1시간)** 을 전달합니다. 버킷 자체를 공개로 둘 필요는 없습니다.

---

## 로컬에서 실행하기

요구사항: Python 3.10 이상.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env        # 그런 다음 .env 를 본인 값으로 편집
set -a; source .env; set +a

# 개발용:
python3 app.py              # http://127.0.0.1:5050 에서 동작

# 운영(production) 스타일:
gunicorn -c gunicorn.conf.py app:app
```

브라우저에서 <http://127.0.0.1:5050> 접속.

---

## 아키텍처

```
app.py             Flask 백엔드. Tencent Cloud MPS / VOD AIGC / LLM API로
                   요청을 중계. 모든 비밀값을 환경변수에서 읽음.
claude_bridge.py   선택적 Anthropic 스타일 채팅 브리지.
gunicorn.conf.py   운영 서버 설정.
templates/
  index.html       단일 페이지 UI (사이드바 + 콘텐츠 + 디버그 패널).
static/
  js/app.js              메인 프론트엔드 로직 (바닐라 JS).
  js/engine_picker.js    엔진/모델 선택 위젯.
  js/aigc_progress.js    진행 상태/폴링 UI.
  js/vendor/             marked.min.js, purify.min.js (마크다운 + 새니타이즈).
  css/                   style.css, engine_picker.css, style_typography.css.
  img/ , icons/          로고 및 플레이스홀더 자산.
```

`app.py` 가 제공하는 API 라우트:

| 라우트                  | 용도                          |
|-------------------------|-------------------------------|
| `GET  /`                | UI 제공                       |
| `POST /api/chat`        | LLM 채팅 (비스트리밍)         |
| `POST /api/stream`      | LLM 채팅 (스트리밍)           |
| `POST /api/upload`      | 참조 이미지를 COS에 스테이징  |
| `POST /api/image/generate` | 이미지 생성                |
| `POST /api/video/generate` | 영상 생성                  |
| `POST /api/music/generate` | 음악 / 효과음 생성         |
| `POST /api/threed/generate`| 3D 파노라마 / 씬           |

---

## 라이선스 / 사용

구현 참고용으로 제공됩니다. 사용자의 Tencent Cloud 사용량, 비용, 보안 강화, 컴플라이언스에 대한 책임은 사용자 본인에게 있으며, 텐센트는 해당 코드의 예기치 못한 동작이나 관련 유지보수의 의무가 없습니다.
