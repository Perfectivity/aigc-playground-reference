/* =============================================
   VOD AIGC Chat — Main Application Script
   Handles: LLM Chat, Image Gen, Video Gen
   ============================================= */

// ---- State ----
let isLoading = false;
let debugPanelOpen = false;
let currentAbortController = null;  // for LLM
// Per-card AbortControllers — keyed by card DOM id.
// Multiple image/video generation requests can run concurrently; each card
// owns its own abort controller so that clicking the in-card ✕ Stop button
// only cancels that specific request.
const imageAbortMap = new Map();    // cardId -> AbortController
const videoAbortMap = new Map();    // cardId -> AbortController

// De-dupe guard — a Generate click is ignored if an identical
// (engine + prompt + refs) request was submitted less than DEDUPE_MS ago.
// This blocks accidental double-clicks / double-fire Enter events without
// preventing the user from firing the SAME prompt again after a short
// delay or firing a DIFFERENT request in parallel.
//
// Bumped to 1500ms because the very first click sometimes fires twice in
// rapid succession on Chromium (button onclick + textarea Enter handler
// stacking when the user presses Enter while the button has focus).
const DEDUPE_MS = 1500;
const lastSubmit = {
  image: { key: '', ts: 0 },
  video: { key: '', ts: 0 },
  music: { key: '', ts: 0 },
  threed: { key: '', ts: 0 },
  imgBattle: { ts: 0 },
  vidBattle: { ts: 0 },
};

function _isDuplicateSubmit(kind, key) {
  const now = Date.now();
  const last = lastSubmit[kind];
  if (last.key === key && (now - last.ts) < DEDUPE_MS) return true;
  last.key = key;
  last.ts = now;
  return false;
}

// Attached image URLs for i2i / i2v.
// Keys:
//   'image' / 'video'         — single-engine modes
//   'image-battle' / 'video-battle' — battle modes (shared across all engines)
const attachedImages = { image: [], video: [], 'image-battle': [], 'video-battle': [], threed: [] };

// Attached images for LLM chat (base64 data URIs)
const chatAttachedImages = [];

const defaultStats = { requests: 0, input: 0, output: 0, total: 0, cached: 0, reasoning: 0, images: 0, video_sec: 0 };
const cumulativeStats = Object.assign({}, defaultStats);

// ---- Conversation History (browser memory only) ----
let conversationHistory = [];
const MAX_HISTORY_TURNS = 20;

// ---- DOM Elements ----
const messagesEl  = document.getElementById('messages');
const emptyState  = document.getElementById('empty-state');
const messageInput = document.getElementById('message-input');
const sendBtn     = document.getElementById('send-btn');

// ---- Helpers ----

function fmt(n) {
  return n.toLocaleString();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Safely parse a fetch Response that *should* return JSON.
 *
 * The Tencent MPS API for some engines (notably OG image2_high) can take
 * longer than gunicorn's worker timeout, in which case nginx returns a
 * 504 Gateway Timeout HTML page. Calling `await resp.json()` on that
 * body throws the famous "Unexpected token '<', "<html> <h"... is not
 * valid JSON" error, leaking confusing internals to the user.
 *
 * This helper inspects status code and Content-Type, returning a normalized
 * `{ error: "..." }` shape so callers can render a friendly message.
 */
async function safeJson(resp) {
  const ctype = resp.headers.get('content-type') || '';
  // A Response body can only be consumed ONCE. Read it a single time as text,
  // then JSON.parse from that string — never call resp.json()/resp.text()
  // twice on the same response (that throws "body stream already read").
  let raw = '';
  try { raw = await resp.text(); } catch (_) {}
  const bodyText = (raw || '').slice(0, 200);

  // Happy path: OK status with JSON content-type.
  if (resp.ok && ctype.includes('application/json')) {
    try { return JSON.parse(raw); }
    catch (e) { return { error: 'Invalid JSON in response: ' + (e && e.message) }; }
  }
  if (resp.status === 504 || /gateway\s*time-?out/i.test(bodyText)) {
    return { error: 'Gateway Timeout — the engine took too long to respond. Try a lower-quality preset (e.g. image2_low) or retry shortly.' };
  }
  if (resp.status === 502) {
    return { error: 'Bad Gateway — the upstream worker dropped the connection (likely too slow). Try a faster engine or retry.' };
  }
  if (resp.status >= 500) {
    return { error: `Server error ${resp.status}. ${bodyText ? '(snippet: ' + bodyText.replace(/\s+/g, ' ').slice(0, 120) + ')' : ''}` };
  }
  // Non-OK status (e.g. 400 compliance errors) or odd content-type: try to
  // parse the text we already read so the server's `{error: ...}` survives.
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
  } catch (_) {}
  if (!ctype.includes('application/json')) {
    return { error: `Unexpected non-JSON response (status ${resp.status}). The server may be restarting.` };
  }
  return { error: `Invalid JSON in response (status ${resp.status}).` };
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setLoading(state) {
  isLoading = state;
  messageInput.disabled = state;
  if (state) {
    sendBtn.textContent = '■';
    sendBtn.classList.add('stop-mode');
    sendBtn.disabled = false;
    sendBtn.onclick = stopGeneration;
  } else {
    sendBtn.textContent = '➤';
    sendBtn.classList.remove('stop-mode');
    sendBtn.disabled = false;
    sendBtn.onclick = sendMessage;
  }
}

function stopGeneration() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  setLoading(false);
}

function toggleToken() {
  // Token input removed — server-side only
}

/* ============================================================
 *  IME-safe Enter guard
 * ------------------------------------------------------------
 *  In Korean/Japanese/Chinese IME, pressing Enter to commit the
 *  in-progress composition ALSO fires a `keydown` Enter event.
 *  Naively calling sendMessage() there causes a split request:
 *  the textarea value at keydown still misses the last syllable
 *  (e.g. "기뻐하는 콜라곰 이미지 만들어"), then the IME commits
 *  the trailing char ("줘") into the textarea, which gets sent
 *  on the very next Enter — producing TWO requests.
 *
 *  We block that case via:
 *    1. e.isComposing                (modern browsers)
 *    2. e.keyCode === 229            (older / Safari quirks)
 *    3. compositionstart/end flag    (extra safety; some Korean
 *       IMEs on macOS Safari skip both signals above on the
 *       composition-finalizing Enter).
 *  Only when ALL three say "not composing" do we send.
 * ============================================================ */
const _imeStateMap = new WeakMap();   // textarea -> {composing: bool, endedAt: number}

function _markComposing(el)   { _imeStateMap.set(el, { composing: true,  endedAt: 0 }); }
function _markComposed(el)    { _imeStateMap.set(el, { composing: false, endedAt: Date.now() }); }
function _isImeBusy(el) {
  const st = _imeStateMap.get(el);
  if (!st) return false;
  if (st.composing) return true;
  // Some IMEs fire compositionend immediately followed by Enter keydown;
  // swallow Enter for ~50ms after composition end to avoid the duplicate.
  if (st.endedAt && (Date.now() - st.endedAt) < 50) return true;
  return false;
}

/** Returns true when this Enter event must NOT trigger a send (IME busy). */
function _enterIsIme(e) {
  if (e.isComposing) return true;
  if (e.keyCode === 229) return true;
  if (_isImeBusy(e.target)) return true;
  return false;
}

/** Attach IME tracking to a textarea exactly once. Idempotent. */
function _attachImeTracking(el) {
  if (!el || el.__imeBound) return;
  el.__imeBound = true;
  el.addEventListener('compositionstart', () => _markComposing(el));
  el.addEventListener('compositionend',   () => _markComposed(el));
}

/** Enter to send (Shift+Enter = new line) for LLM Chat */
function handleKeyDown(e) {
  _attachImeTracking(e.target);
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (_enterIsIme(e)) return;          // <-- the actual fix
  e.preventDefault();
  sendMessage();
}

/** Enter to send for Image/Video Gen */
function handleGenKeyDown(e, type) {
  _attachImeTracking(e.target);
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (_enterIsIme(e)) return;
  e.preventDefault();
  if (type === 'image') generateImage();
  else if (type === 'video') generateVideo();
  else if (type === 'music') generateMusic();
  else if (type === 'threed') generate3D();
}

// ---- LLM Chat Image Attach ----

/** Read file as base64 data URI */
function readFileAsDataURI(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Attach image via file picker for LLM chat */
function attachChatImage() {
  if (!_assertModelVisionOrAlert()) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  input.multiple = true;
  input.addEventListener('change', async function () {
    if (!this.files || this.files.length === 0) return;
    for (const file of this.files) {
      if (!file.type.startsWith('image/')) continue;
      const dataUri = await readFileAsDataURI(file);
      chatAttachedImages.push(dataUri);
    }
    renderChatAttachPreview();
  });
  input.click();
}

// === 멀티모달 지원 여부 — 모델 옵션의 data-vision 으로 판단 ===
function _currentModelSupportsVision() {
  const sel = document.getElementById('model');
  if (!sel) return true;  // 안전 fallback
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return true;
  return opt.getAttribute('data-vision') === '1';
}
function _currentModelLabel() {
  const sel = document.getElementById('model');
  const opt = sel && sel.options[sel.selectedIndex];
  return (opt && opt.textContent) ? opt.textContent.trim() : '선택한 모델';
}
function _assertModelVisionOrAlert() {
  if (_currentModelSupportsVision()) return true;
  alert(`'${_currentModelLabel()}' 은(는) 멀티모달을 지원하지 않습니다.\n이미지를 함께 보낼 수 있는 모델(이름 옆에 "· Multimodal" 표시)을 선택해 주세요.`);
  return false;
}

/** Render preview thumbnails for chat-attached images */
function renderChatAttachPreview() {
  const container = document.getElementById('chat-attach-preview');
  const btn = document.getElementById('chat-attach-btn');
  container.innerHTML = chatAttachedImages.map((uri, i) => `
    <div class="chat-attach-thumb">
      <img src="${uri}" alt="img ${i + 1}">
      <button class="chat-attach-remove" onclick="removeChatAttach(${i})">✕</button>
    </div>
  `).join('');
  if (chatAttachedImages.length > 0) {
    btn.classList.add('has-file');
  } else {
    btn.classList.remove('has-file');
  }
}

/** Remove a chat-attached image */
function removeChatAttach(index) {
  chatAttachedImages.splice(index, 1);
  renderChatAttachPreview();
}

/** Clear all chat-attached images */
function clearChatAttach() {
  chatAttachedImages.length = 0;
  renderChatAttachPreview();
}

/**
 * 만료된 결과 카드만 일괄 삭제.
 *
 * scope: 'image' | 'video' | 'image-battle' | 'video-battle' | 'all'
 *
 * "만료" 의 정의:
 *   1) AigcHistory.isExpired(entry) === true  (saved 가 아니고 expires_at 지남)
 *   2) 또는 카드 내부에 .battle-cell-error / .error-msg 가 있음
 *      (이미지/영상 onerror 로 깨진 경우)
 *
 * DOM 카드 제거 + AigcHistory 에서도 entry 제거 (브라우저 새로고침 시
 * 자동 복원 안 됨).  Gallery 영구 저장 항목은 영향 없음.
 */
function clearExpired(scope) {
  scope = scope || 'all';
  const targets = (scope === 'all')
    ? ['image-results', 'video-results', 'image-battle-results', 'video-battle-results']
    : (scope === 'image')        ? ['image-results']
    : (scope === 'video')        ? ['video-results']
    : (scope === 'image-battle') ? ['image-battle-results']
    : (scope === 'video-battle') ? ['video-battle-results']
    : [];

  // 카드 만료 판정
  const isCardExpired = (card) => {
    // 명시적으로 깨진 미디어 에러 표시 — 가장 강한 시그널
    if (card.querySelector('.battle-cell-error')) return true;
    if (card.querySelector('.error-msg'))         return true;
    // history entry 확인
    const hid = card.dataset && card.dataset.historyId;
    if (!hid || !window.AigcHistory) return false;
    const entry = (window.AigcHistory.all() || []).find(e => e && e.id === hid);
    if (!entry) return false;
    try { return !!window.AigcHistory.isExpired(entry); } catch (_) { return false; }
  };

  let removedCards = 0;
  const removedHids = [];
  let removedRounds = 0;

  for (const tid of targets) {
    const root = document.getElementById(tid);
    if (!root) continue;

    // 1) 단일 결과 카드 (.result-card.restored 또는 일반 .result-card)
    root.querySelectorAll('.result-card').forEach(card => {
      if (!isCardExpired(card)) return;
      const hid = card.dataset.historyId;
      if (hid) removedHids.push(hid);
      card.remove();
      removedCards++;
    });

    // 2) 배틀 셀 (.battle-cell)
    root.querySelectorAll('.battle-cell').forEach(card => {
      if (!isCardExpired(card)) return;
      const hid = card.dataset.historyId;
      if (hid) removedHids.push(hid);
      card.remove();
      removedCards++;
    });

    // 3) 빈 라운드(.battle-round) 정리 — 셀이 모두 사라진 라운드는 통째로 제거
    root.querySelectorAll('.battle-round').forEach(round => {
      const grid = round.querySelector('.battle-round-grid');
      if (grid && grid.children.length === 0) {
        round.remove();
        removedRounds++;
      }
    });

    // 4) 라운드/카드가 모두 비었으면 empty-state 복원
    const stillHas = root.querySelector('.result-card, .battle-cell, .battle-round');
    if (!stillHas) {
      const empties = {
        'image-results':         { id: 'image-empty',         icon: '🎨',
          text: '엔진과 프롬프트를 선택하고 이미지를 생성하세요.' },
        'video-results':         { id: 'video-empty',         icon: '🎬',
          text: '엔진과 프롬프트를 선택하고 영상을 생성하세요.' },
        'image-battle-results':  { id: 'image-battle-empty',  icon: '',
          text: '엔진을 선택하고 프롬프트를 입력하면 동시에 그림을 그립니다.' },
        'video-battle-results':  { id: 'video-battle-empty',  icon: '',
          text: '엔진을 선택하고 프롬프트를 입력하면 동시에 영상을 만듭니다.' },
      };
      const e = empties[tid];
      if (e) {
        root.innerHTML = e.icon
          ? `<div class="gen-empty" id="${e.id}">
               <div class="empty-icon">${e.icon}</div>
               <div class="empty-text">${e.text}</div>
             </div>`
          : `<div class="gen-empty" id="${e.id}">
               <div class="empty-text">${e.text}</div>
             </div>`;
      }
    }
  }

  // 5) localStorage history 에서도 일괄 제거 (재로드 시 복원 막음)
  try {
    if (removedHids.length && window.AigcHistory) {
      window.AigcHistory.removeManyByIds(removedHids);
    }
  } catch (_) {}

  // 6) 사용자에게 결과 알림 (조용한 toast 대신 짧은 inline 메시지)
  const total = removedCards + removedRounds;
  if (total === 0) {
    alert('만료된 항목이 없습니다.');
  } else {
    const btn = document.querySelector('.header-clear-expired-btn');
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = `✓ ${removedCards} cleared`;
      btn.classList.add('is-done');
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.classList.remove('is-done');
      }, 2000);
    }
  }
}


/**
 * 전체 세션 초기화 — Text/Image/Video/Battle 의 모든 결과를 한 번에 비운다.
 * Gallery (영구 저장) 는 영향 없음. AI Studio 는 별도 reset 버튼이 따로
 * 있으므로 여기서 건드리지 않는다 (사용자가 의도치 않은 손실을 막기 위함).
 *
 * 정리 대상:
 *   - chat:        #messages (대화 모두 + empty-state 복원)
 *   - image gen:   #image-results (단일 이미지 결과 카드 모두)
 *   - video gen:   #video-results (단일 비디오 결과 카드 모두)
 *   - image battle:#image-battle-results (모든 라운드)
 *   - video battle:#video-battle-results (모든 라운드)
 *   - history:     localStorage 의 history entries (브라우저 새로고침 시
 *                  자동 복원되는 데이터까지 함께 비움)
 *   - debug logs:  진단 패널의 누적 로그 (있다면)
 */
function wipeAllSession() {
  if (!confirm(
    '모든 세션 결과(Text / Image / Video / Battle)를 한 번에 비울까요?\n\n' +
    '· Gallery 는 영향 없음 (영구 저장)\n' +
    '· AI Studio 는 영향 없음 (별도 Reset 버튼 사용)\n' +
    '· 새로고침 후에도 결과 안 돌아옴 (history 도 함께 정리)'
  )) return;

  // 1) Chat 메시지 초기화 — empty-state 복원
  const msg = document.getElementById('messages');
  if (msg) {
    msg.innerHTML = `
      <div class="empty-state" id="empty-state">
        <div class="empty-icon">💬</div>
        <div class="empty-title">새 대화 시작</div>
        <div class="empty-sub">왼쪽에서 모델을 선택하고 메시지를 입력하세요.</div>
      </div>`;
  }

  // 2) 단일 Image / Video 결과
  const imgRes = document.getElementById('image-results');
  if (imgRes) {
    imgRes.innerHTML = `
      <div class="gen-empty" id="image-empty">
        <div class="empty-icon">🎨</div>
        <div class="empty-text">엔진과 프롬프트를 선택하고 이미지를 생성하세요.</div>
      </div>`;
  }
  const vidRes = document.getElementById('video-results');
  if (vidRes) {
    vidRes.innerHTML = `
      <div class="gen-empty" id="video-empty">
        <div class="empty-icon">🎬</div>
        <div class="empty-text">엔진과 프롬프트를 선택하고 영상을 생성하세요.</div>
      </div>`;
  }

  // 3) Battle 결과 — 라운드 전부 제거 + empty-state 복원
  const ibRes = document.getElementById('image-battle-results');
  if (ibRes) {
    ibRes.innerHTML = `
      <div class="gen-empty" id="image-battle-empty">
        <div class="empty-text">엔진을 선택하고 프롬프트를 입력하면 동시에 그림을 그립니다.</div>
      </div>`;
  }
  const vbRes = document.getElementById('video-battle-results');
  if (vbRes) {
    vbRes.innerHTML = `
      <div class="gen-empty" id="video-battle-empty">
        <div class="empty-text">엔진을 선택하고 프롬프트를 입력하면 동시에 영상을 만듭니다.</div>
      </div>`;
  }

  // 4) localStorage 의 history (브라우저 재로드 시 자동 복원되는 데이터)
  try {
    if (window.AigcHistory && typeof window.AigcHistory.clear === 'function') {
      window.AigcHistory.clear();
    }
  } catch (_) {}

  // 5) 디버그 패널 로그 (모든 모드)
  try {
    if (typeof clearDebugLog === 'function') {
      // 모든 모드의 디버그 로그를 한꺼번에 지우려면 여러 번 호출 필요할 수
      // 있지만, clearDebugLog 는 현재 모드 한정이므로 — 이 정도로 충분.
      clearDebugLog();
    }
  } catch (_) {}

  // 6) 첨부 미리보기들 정리
  try { clearChatAttach && clearChatAttach(); } catch (_) {}
  ['imgb-attach-preview', 'vidb-attach-preview',
   'image-attach-preview', 'video-attach-preview'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // 7) 작업 중인 fetch 들 abort (image/video 단일 + battle)
  try {
    if (typeof imageAbortMap !== 'undefined') {
      imageAbortMap.forEach(c => { try { c.abort(); } catch (_) {} });
      imageAbortMap.clear();
    }
    if (typeof videoAbortMap !== 'undefined') {
      videoAbortMap.forEach(c => { try { c.abort(); } catch (_) {} });
      videoAbortMap.clear();
    }
  } catch (_) {}

  // 살짝 시각 피드백
  const btn = document.querySelector('.header-wipe-btn');
  if (btn) {
    const orig = btn.innerHTML;
    btn.innerHTML = '✓ Cleared';
    btn.classList.add('is-done');
    setTimeout(() => {
      btn.innerHTML = orig;
      btn.classList.remove('is-done');
    }, 1500);
  }
}

/** Handle paste event — detect images from clipboard */
function handlePaste(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  // 클립보드에 이미지가 들어있는지 먼저 확인
  let hasImage = false;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) { hasImage = true; break; }
  }
  // 이미지가 있다면 모델 비전 지원 여부 가드
  if (hasImage && !_assertModelVisionOrAlert()) {
    // 텍스트 paste는 막지 않음 — 이미지만 무시
    return;
  }
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = function () {
        chatAttachedImages.push(reader.result);
        renderChatAttachPreview();
      };
      reader.readAsDataURL(file);
    }
  }
  // Don't prevent default for text paste
}

/** Attach a local image file — uploads to server, stores URL */
// Mode → DOM id mapping for attach button / preview container.
// Battle modes share one preview/button per battle kind.
function _attachIds(mode) {
  switch (mode) {
    case 'image':        return { btn: 'img-attach-btn',  preview: 'img-attach-preview'  };
    case 'video':        return { btn: 'vid-attach-btn',  preview: 'vid-attach-preview'  };
    case 'image-battle': return { btn: 'imgb-attach-btn', preview: 'imgb-attach-preview' };
    case 'video-battle': return { btn: 'vidb-attach-btn', preview: 'vidb-attach-preview' };
    case 'threed':       return { btn: 'threed-attach-btn', preview: 'threed-attach-preview' };
    default:             return { btn: 'img-attach-btn',  preview: 'img-attach-preview'  };
  }
}

function attachImage(mode) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp';
  input.addEventListener('change', async function () {
    if (!this.files || !this.files[0]) return;
    const file = this.files[0];
    const formData = new FormData();
    formData.append('file', file);

    const ids = _attachIds(mode);
    const btn = document.getElementById(ids.btn);
    if (btn) btn.textContent = '⏳';

    try {
      const resp = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await resp.json();
      if (data.error) { alert('Upload failed: ' + data.error); if (btn) btn.textContent = '📎'; return; }

      attachedImages[mode].push(data.url);
      if (btn) { btn.classList.add('has-file'); btn.textContent = '📎'; }
      renderAttachPreview(mode);
    } catch (err) {
      alert('Upload error: ' + err.message);
      if (btn) btn.textContent = '📎';
    }
  });
  input.click();
}

function renderAttachPreview(mode) {
  const ids = _attachIds(mode);
  const container = document.getElementById(ids.preview);
  if (!container) return;
  container.innerHTML = attachedImages[mode].map((url, i) => `
    <div class="attach-thumb">
      <img src="${escapeHtml(url)}" alt="ref ${i + 1}">
      <button class="attach-remove" onclick="removeAttach('${mode}', ${i})">✕</button>
    </div>
  `).join('');
}

function removeAttach(mode, index) {
  attachedImages[mode].splice(index, 1);
  renderAttachPreview(mode);
  const ids = _attachIds(mode);
  const btn = document.getElementById(ids.btn);
  if (btn && attachedImages[mode].length === 0) btn.classList.remove('has-file');
}

// ---- Mode Switching ----

function switchMode(mode, tabEl) {
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
  if (tabEl) tabEl.classList.add('active');

  // Sidebar: chat / image / video share their existing panels.
  // Battle modes reuse the chat sidebar (no per-engine selection on the
  // sidebar — battle has its own engine pickers inside the content area).
  const sidebarMode = (mode === 'image-battle' || mode === 'video-battle')
    ? 'chat'
    : mode;
  document.getElementById('sidebar-chat').classList.toggle('panel-hidden',  sidebarMode !== 'chat');
  document.getElementById('sidebar-image').classList.toggle('panel-hidden', sidebarMode !== 'image');
  document.getElementById('sidebar-video').classList.toggle('panel-hidden', sidebarMode !== 'video');
  const sbMusic = document.getElementById('sidebar-music');
  const sb3d = document.getElementById('sidebar-3d');
  if (sbMusic) sbMusic.classList.toggle('panel-hidden', sidebarMode !== 'music');
  if (sb3d) sb3d.classList.toggle('panel-hidden', sidebarMode !== 'threed');

  document.getElementById('content-chat').classList.toggle('active',         mode === 'chat');
  document.getElementById('content-image').classList.toggle('active',        mode === 'image');
  document.getElementById('content-video').classList.toggle('active',        mode === 'video');
  const cm = document.getElementById('content-music');
  const c3 = document.getElementById('content-3d');
  if (cm) cm.classList.toggle('active', mode === 'music');
  if (c3) c3.classList.toggle('active', mode === 'threed');
  const ib = document.getElementById('content-image-battle');
  const vb = document.getElementById('content-video-battle');
  if (ib) ib.classList.toggle('active', mode === 'image-battle');
  if (vb) vb.classList.toggle('active', mode === 'video-battle');

  // Battle modes: hide sidebar so the workspace spans the full width.
  const isWide = (mode === 'image-battle' || mode === 'video-battle');
  document.body.classList.toggle('battle-mode', isWide);

  // Debug panel: switch to this mode's own request log, so other modes'
  // history doesn't bleed into the current view.
  if (typeof setDebugMode === 'function') setDebugMode(mode);
}

// ---- Pill Selection ----
document.querySelectorAll('.pill-group').forEach(group => {
  group.addEventListener('click', e => {
    if (e.target.classList.contains('pill')) {
      group.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      e.target.classList.add('active');
    }
  });
});

// ---- Duration Chip Selection ----
document.querySelectorAll('.duration-chips').forEach(group => {
  group.addEventListener('click', e => {
    const chip = e.target.closest('.duration-chip');
    if (chip) {
      group.querySelectorAll('.duration-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
    }
  });
});

// ---- Image Engine Options ----
// Engines that support reference image input (image-to-image).
// GEM/Seedream/Kling/Jimeng/MJ/Vidu/OG accept reference images.
// Only Hunyuan and Qwen are text-only in the current UI.
const imgRefEngines = [
  'gem31','gem30','gem25',
  'seedream50lite','seedream45','seedream40',
  'kling_img_30o','kling_img_30','kling_img_o1','kling_img_21',
  'jimeng_img_40',
  'mjv7',
  'viduq2_img',
  'og_img_low','og_img_medium','og_img_high',
];
// Legacy alias kept for any external references in code/templates.
const imgGemEngines = imgRefEngines;

function updateImageOptions() {
  const engineSel = document.getElementById('img-engine');
  const engine = engineSel.value;
  // _raw (compliance-check off) 옵션이 선택되면 select 자체에 빨간 글로우.
  engineSel.classList.toggle('is-raw', /_raw$/.test(engine));
  const refSection = document.getElementById('img-ref-section');
  const negSection = document.getElementById('img-negative-section');

  if (imgRefEngines.includes(engine)) {
    refSection.style.display = '';
    negSection.style.display = 'none';
  } else {
    refSection.style.display = 'none';
    negSection.style.display = '';
  }
}

// ---- Video Engine Options ----
// MPS AIGC 지원 엔진 (공식 + 실측):
//   Kling / Hailuo / Vidu / PixVerse / GV / OS / Hunyuan
//   + Jimeng / Seedance / Mingmou / Wan
const engineFeatures = {
  // Kling
  'kling16':       { endFrame: false, refFrames: false, refVideo: false, negative: true,  resolution: true,  durations: ['5s', '10s'] },
  'kling20':       { endFrame: false, refFrames: false, refVideo: false, negative: true,  resolution: true,  durations: ['5s', '10s'] },
  'kling21':       { endFrame: true,  refFrames: false, refVideo: false, negative: true,  resolution: true,  durations: ['5s', '10s'] },
  'kling25':       { endFrame: false, refFrames: false, refVideo: false, negative: true,  resolution: true,  durations: ['5s', '10s'] },
  'kling26':       { endFrame: false, refFrames: false, refVideo: false, negative: true,  resolution: true,  durations: ['5s', '10s'] },
  'kling30':       { endFrame: false, refFrames: false, refVideo: false, negative: true,  resolution: true,  durations: ['5s', '10s'] },
  'kling30omni':   { endFrame: false, refFrames: true,  refVideo: false, negative: true,  resolution: true,  durations: ['5s', '10s'] },
  'klingo1':       { endFrame: false, refFrames: true,  refVideo: true,  negative: true,  resolution: true,  durations: ['5s', '10s'] },
  // Hailuo
  'hailuo02':      { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['6s', '10s'] },
  'hailuo23':      { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['6s', '10s'] },
  'hailuo23fast':  { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['6s'] },
  // Vidu
  'viduq2':        { endFrame: false, refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s'] },
  'viduq2pro':     { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s'] },
  'viduq2turbo':   { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s'] },
  'viduq3':        { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s'] },
  'viduq3pro':     { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s'] },
  'viduq3turbo':   { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s'] },
  'viduq3mix':     { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s'] },
  // Seedance
  'seedance15pro': { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s', '10s'] },
  'seedance10pro': { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s', '10s'] },
  'seedance10profast': { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s', '10s'] },
  // PixVerse
  'pixversev56':   { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
  'pixversev6':    { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
  'pixversec1':    { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
  // Jimeng
  'jimeng30pro':   { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
  // GV (Google Veo)
  'gv31':          { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['8s'] },
  'gv31fast':      { endFrame: true,  refFrames: true,  refVideo: false, negative: false, resolution: true,  durations: ['8s'] },
  // OS (Sora)
  'osv20':         { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['4s', '8s', '12s'] },
  // Mingmou
  'mingmou10':     { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
  // Wan
  'wan22':         { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
  // Hunyuan
  'hunyuan15':     { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
  // H2 (Happyhorse / 海马) — server map: ("H2","1.0")
  'h2_10':         { endFrame: false, refFrames: false, refVideo: false, negative: false, resolution: true,  durations: ['5s'] },
};

function updateVideoOptions() {
  const engineSel = document.getElementById('vid-engine');
  const engine = engineSel.value;
  // _raw (compliance-check off) 옵션이 선택되면 select 자체에 빨간 글로우.
  engineSel.classList.toggle('is-raw', /_raw$/.test(engine));
  const feat = engineFeatures[engine] || {};

  document.getElementById('vid-end-frame').style.display = feat.endFrame ? '' : 'none';
  document.getElementById('vid-ref-frames').style.display = feat.refFrames ? '' : 'none';

  const refVid = document.getElementById('vid-ref-video');
  if (feat.refVideo) {
    refVid.classList.remove('panel-hidden');
    refVid.style.display = '';
  } else {
    refVid.style.display = 'none';
  }

  document.getElementById('vid-negative-section').style.display = feat.negative ? '' : 'none';
  document.getElementById('vid-resolution-section').style.display = feat.resolution ? '' : 'none';

  const durSection = document.getElementById('vid-duration-section');
  if (feat.durations && feat.durations.length > 0) {
    durSection.style.display = '';
    const container = durSection.querySelector('.duration-chips');
    container.innerHTML = feat.durations.map((d, i) =>
      `<div class="duration-chip ${i === 0 ? 'active' : ''}">${d}<small>${i === 0 ? 'default' : (d === '10s' || d === '12s' ? 'long' : '')}</small></div>`
    ).join('');

    container.addEventListener('click', e => {
      const chip = e.target.closest('.duration-chip');
      if (chip) {
        container.querySelectorAll('.duration-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      }
    });
  } else {
    durSection.style.display = 'none';
  }
}

// ---- Conversation History Helpers ----

function newConversation() {
  conversationHistory = [];
  messagesEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty-state';
  empty.id = 'empty-state';
  empty.innerHTML = `
    <div class="empty-icon">💬</div>
    <div class="empty-text">Ask Gemini, GPT, Kimi, GLM, MiniMax anything!</div>
  `;
  messagesEl.appendChild(empty);
  updateTurnCounter();
  messageInput.focus();
}

function trimHistory() {
  const maxMessages = MAX_HISTORY_TURNS * 2;
  if (conversationHistory.length > maxMessages) {
    conversationHistory = conversationHistory.slice(conversationHistory.length - maxMessages);
  }
}

function buildMessages(system, newUserMessage, imageDataURIs) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  for (const msg of conversationHistory) messages.push(msg);

  // If images attached, build multimodal content array
  if (imageDataURIs && imageDataURIs.length > 0) {
    const content = [{ type: 'text', text: newUserMessage }];
    for (const uri of imageDataURIs) {
      content.push({ type: 'image_url', image_url: { url: uri } });
    }
    messages.push({ role: 'user', content: content });
  } else {
    messages.push({ role: 'user', content: newUserMessage });
  }
  return messages;
}

function updateTurnCounter() {
  const el = document.getElementById('turn-counter');
  if (!el) return;
  const turns = Math.floor(conversationHistory.length / 2);
  el.textContent = `${turns} / ${MAX_HISTORY_TURNS}`;
  el.style.color = turns >= MAX_HISTORY_TURNS - 2 ? 'var(--orange)' : 'var(--text-dim)';
}

// ---- Debug Panel ----

function toggleDebugPanel() {
  const panel = document.getElementById('debug-panel');
  const btn = document.querySelector('.debug-toggle-btn');
  debugPanelOpen = !debugPanelOpen;
  panel.classList.toggle('open', debugPanelOpen);
  if (btn) btn.classList.toggle('active', debugPanelOpen);
}

function syntaxHighlight(json) {
  if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
  json = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // First pass: generic JSON token highlight.
  let html = json.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    function (match) {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'json-key' : 'json-string';
      } else if (/true|false/.test(match)) {
        cls = 'json-boolean';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    }
  );
  // Second pass: emphasise specific keys/values that matter for debugging.
  // engine — bold yellow on both key and value
  html = html.replace(
    /<span class="json-key">("engine":)<\/span>(\s*)<span class="json-string">("[^"]*")<\/span>/g,
    '<span class="json-engine-key">$1<\/span>$2<span class="json-engine">$3<\/span>'
  );
  // endpoint — cyan
  html = html.replace(
    /<span class="json-key">("endpoint":)<\/span>(\s*)<span class="json-string">("[^"]*")<\/span>/g,
    '<span class="json-engine-key" style="color:#4dd0e1">$1<\/span>$2<span class="json-endpoint">$3<\/span>'
  );
  // error — red key + red value
  html = html.replace(
    /<span class="json-key">("error":)<\/span>(\s*)<span class="json-string">("[^"]*")<\/span>/g,
    '<span class="json-error-key">$1<\/span>$2<span class="json-error-string">$3<\/span>'
  );
  return html;
}

// =====================================================================
// Debug Panel — multi-mode, multi-entry log.
// =====================================================================
// Each top-level mode keeps its own ordered list of (request, response)
// entries. The panel renders only the *currently selected* mode's list.
// switchMode() automatically swaps the visible list, fixing the bug where
// e.g. video-battle JSON would linger in Text Gen view.
const DEBUG_MODES = ['chat', 'image', 'video', 'image-battle', 'video-battle', 'story-forge'];
const debugLog = { chat: [], image: [], video: [], 'image-battle': [], 'video-battle': [], 'story-forge': [] };
const DEBUG_MAX_PER_MODE = 50;   // cap per mode to avoid unbounded growth
let currentDebugMode = 'chat';
let _debugSeq = 0;

function _modeForRoute(endpoint) {
  if (!endpoint) return currentDebugMode;
  if (endpoint.includes('/image/')) return 'image';
  if (endpoint.includes('/video/')) return 'video';
  return 'chat';
}

function _entryStatus(response) {
  if (!response) return 'pending';
  if (response.error) return 'error';
  return 'ok';
}

function pushDebugEntry(mode, debugData, meta) {
  meta = meta || {};
  const m = DEBUG_MODES.includes(mode) ? mode : 'chat';
  const arr = debugLog[m];
  const entry = {
    id:        ++_debugSeq,
    ts:        Date.now(),
    engine:    meta.engine || (debugData.request && debugData.request.body && debugData.request.body.engine) || '',
    endpoint:  (debugData.request && debugData.request.endpoint) || meta.endpoint || '',
    status:    _entryStatus(debugData.response),
    request:   debugData.request || null,
    response:  debugData.response || null,
  };
  arr.push(entry);
  while (arr.length > DEBUG_MAX_PER_MODE) arr.shift();
  _renderDebugCounts();
  if (m === currentDebugMode) renderDebugList();
}

// Backwards-compat shim: existing call sites just pass a single object.
// We infer the mode from the request endpoint.
function updateDebugPanel(debugData, modeHint) {
  const mode = modeHint || _modeForRoute(debugData && debugData.request && debugData.request.endpoint);
  pushDebugEntry(mode, debugData, {});
}

function setDebugMode(mode) {
  if (!DEBUG_MODES.includes(mode)) return;
  currentDebugMode = mode;
  document.querySelectorAll('.debug-mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  renderDebugList();
}

function clearDebugLog() {
  if (!debugLog[currentDebugMode]) return;
  debugLog[currentDebugMode].length = 0;
  _renderDebugCounts();
  renderDebugList();
}

function _renderDebugCounts() {
  DEBUG_MODES.forEach(m => {
    const el = document.getElementById('dbg-count-' + m);
    if (el) el.textContent = String(debugLog[m].length);
  });
}

function _fmtClock(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderDebugList() {
  const empty = document.getElementById('debug-empty');
  const list  = document.getElementById('debug-entries');
  if (!list) return;
  const arr = debugLog[currentDebugMode] || [];
  if (!arr.length) {
    if (empty) empty.style.display = '';
    list.innerHTML = '';
    return;
  }
  if (empty) empty.style.display = 'none';
  // Newest first.
  list.innerHTML = arr.slice().reverse().map(e => {
    const reqHtml = e.request  ? syntaxHighlight(e.request)  : '<span class="debug-placeholder">(no request body)</span>';
    const resHtml = e.response ? syntaxHighlight(e.response) : '<span class="debug-placeholder">(no response yet)</span>';
    const engineLabel = e.engine ? escapeHtml(e.engine) : '—';
    const endpointLabel = e.endpoint ? escapeHtml(e.endpoint) : '';
    const statusClass = e.status === 'ok' ? 'ok' : e.status === 'error' ? 'error' : 'pending';
    const statusText  = e.status === 'ok' ? 'OK' : e.status === 'error' ? 'ERROR' : 'PENDING';
    return `
      <div class="debug-entry status-${statusClass}" data-id="${e.id}">
        <div class="debug-entry-header" onclick="this.parentNode.classList.toggle('collapsed')">
          <span class="debug-entry-engine">${engineLabel}</span>
          <span class="debug-entry-endpoint">${endpointLabel}</span>
          <span class="debug-entry-status ${statusClass}">${statusText}</span>
          <span class="debug-entry-time">${_fmtClock(e.ts)}</span>
          <span class="debug-entry-caret">▾</span>
        </div>
        <div class="debug-entry-body">
          <span class="debug-section-label">Request</span>
          <pre class="debug-json">${reqHtml}</pre>
          <span class="debug-section-label">Response</span>
          <pre class="debug-json">${resHtml}</pre>
        </div>
      </div>`;
  }).join('');
}

// ---- (Removed) Cumulative Stats ----
// The original Playground tracked cumulative token/usage stats via a SQLite
// DB and the /api/stats endpoints. This stateless reference build has no DB,
// so all stats functions are no-ops kept only for call-site compatibility.
// (`cumulativeStats` is already declared near the top of this file.)

function renderCumulativeStats() { /* no-op: stats UI removed */ }
function updateCumulativeStats(_usage) { /* no-op: stats DB removed */ }
function confirmResetStats() { /* no-op: stats DB removed */ }
function resetCumulativeStats() { /* no-op: stats DB removed */ }
function loadCumulativeStats() { /* no-op: stats DB removed */ }

// ---- Message Rendering ----

// Markdown rendering for assistant replies.
// `marked` and `DOMPurify` are loaded as vendor scripts in index.html.
// We deliberately use a conservative configuration:
//   - GFM (fenced code, tables, ~~strike~~)
//   - newlines → <br>
//   - HTML sanitised through DOMPurify before insertion
//   - decorate code blocks: language label + Copy button
// If the libs failed to load for any reason we gracefully fall back to
// escaped plain text so user content always renders safely.
function renderMarkdown(rawText) {
  const text = String(rawText == null ? '' : rawText);
  const hasMarked = typeof window.marked !== 'undefined';
  const hasPurify = typeof window.DOMPurify !== 'undefined';
  if (!hasMarked) {
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
  try {
    if (window.marked.setOptions) {
      window.marked.setOptions({ gfm: true, breaks: true, headerIds: false, mangle: false });
    }
    let html = window.marked.parse(text);
    if (hasPurify) {
      html = window.DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
    }
    return html;
  } catch (e) {
    console.warn('renderMarkdown failed, falling back to plain text:', e);
    return escapeHtml(text).replace(/\n/g, '<br>');
  }
}

// After we drop a markdown-rendered chunk into the DOM, enhance every
// <pre><code> with a header (language + Copy button). Idempotent.
function enhanceCodeBlocks(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll('pre > code').forEach(code => {
    const pre = code.parentElement;
    if (!pre || pre.dataset.codeEnhanced === '1') return;
    pre.dataset.codeEnhanced = '1';
    // marked emits class="language-xyz" — strip prefix for the label.
    let lang = '';
    (code.className || '').split(/\s+/).forEach(c => {
      if (c.indexOf('language-') === 0) lang = c.slice(9);
    });
    pre.classList.add('code-block');
    const header = document.createElement('div');
    header.className = 'code-block-header';
    header.innerHTML =
      `<span class="code-block-lang">${escapeHtml(lang || 'code')}</span>` +
      `<button type="button" class="code-block-copy" title="Copy to clipboard">⧉ Copy</button>`;
    pre.insertBefore(header, code);
    const btn = header.querySelector('.code-block-copy');
    btn.addEventListener('click', () => {
      const txt = code.innerText;
      const done = () => {
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        btn.classList.add('done');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('done'); }, 1200);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(done).catch(() => {
          // Legacy fallback
          const ta = document.createElement('textarea');
          ta.value = txt; document.body.appendChild(ta); ta.select();
          try { document.execCommand('copy'); done(); } catch (_) {}
          document.body.removeChild(ta);
        });
      } else {
        const ta = document.createElement('textarea');
        ta.value = txt; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (_) {}
        document.body.removeChild(ta);
      }
    });
  });
}

function addMessage(role, content) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const msg = document.createElement('div');
  msg.className = `msg msg-${role}`;
  msg.innerHTML = `<div class="msg-bubble">${escapeHtml(content)}</div>`;
  messagesEl.appendChild(msg);
  scrollToBottom();
  return msg;
}

function addMessageWithImages(role, content, imageDataURIs) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const msg = document.createElement('div');
  msg.className = `msg msg-${role}`;

  let imagesHtml = '';
  if (imageDataURIs && imageDataURIs.length > 0) {
    imagesHtml = '<div class="msg-user-images">' +
      imageDataURIs.map(uri => `<img src="${uri}" alt="attached">`).join('') +
      '</div>';
  }

  msg.innerHTML = `${imagesHtml}<div class="msg-bubble">${content ? escapeHtml(content) : '<em style="opacity:0.5">Image attached</em>'}</div>`;
  messagesEl.appendChild(msg);
  scrollToBottom();
  return msg;
}

function addAssistantResult(content, usage, elapsed, model, requestId) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant';
  msg.innerHTML = `
    <div class="msg-bubble">${renderMarkdown(content)}</div>
    <div class="stats-card">
      <div class="stat-item">
        <div class="stat-value green">${fmt(usage.prompt_tokens)}</div>
        <div class="stat-label">Input</div>
      </div>
      <div class="stat-item">
        <div class="stat-value orange">${fmt(usage.completion_tokens)}</div>
        <div class="stat-label">Output</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${fmt(usage.total_tokens)}</div>
        <div class="stat-label">Total</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" style="color:var(--text)">${elapsed}s</div>
        <div class="stat-label">Time</div>
      </div>
    </div>
    <div class="msg-meta">
      <span>🤖 ${model}</span>
      <span>📋 ${requestId}</span>
    </div>
  `;
  messagesEl.appendChild(msg);
  enhanceCodeBlocks(msg);
  scrollToBottom();
}

function addLoading() {
  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant';
  msg.id = 'loading-msg';
  msg.innerHTML = `<div class="msg-bubble"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;
  messagesEl.appendChild(msg);
  scrollToBottom();
}

function removeLoading() {
  const el = document.getElementById('loading-msg');
  if (el) el.remove();
}

function addError(text) {
  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant';
  msg.innerHTML = `<div class="error-msg">⚠️ ${escapeHtml(text)}</div>`;
  messagesEl.appendChild(msg);
  scrollToBottom();
}

// ---- Send Logic (LLM Chat) ----

async function sendMessage() {
  if (isLoading) return;

  const token       = document.getElementById('token').value.trim();
  const model       = document.getElementById('model').value;
  const message     = messageInput.value.trim();
  const system      = document.getElementById('system-prompt').value.trim();
  const temperature = parseFloat(document.getElementById('temperature').value);
  const useStream   = document.getElementById('stream-mode').checked;

  // Grab attached images before clearing
  const images = chatAttachedImages.slice();

  if (!message && images.length === 0) { return; }

  // Show user message with image previews
  addMessageWithImages('user', message, images);
  messageInput.value = '';
  resetAutoResize(messageInput);
  clearChatAttach();

  const messages = buildMessages(system, message || 'What is this image?', images);

  setLoading(true);

  let assistantReply = '';
  if (useStream) {
    assistantReply = await sendStream(token, model, messages, temperature);
  } else {
    assistantReply = await sendNonStream(token, model, messages, temperature);
  }

  if (assistantReply) {
    // Store text-only in history (don't store base64 in history to save memory)
    conversationHistory.push({ role: 'user', content: message || 'What is this image?' });
    conversationHistory.push({ role: 'assistant', content: assistantReply });
    trimHistory();
    updateTurnCounter();
  }

  setLoading(false);
}

// ---- Non-Streaming Request ----

async function sendNonStream(token, model, messages, temperature) {
  addLoading();
  let assistantReply = '';

  currentAbortController = new AbortController();

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, model, messages, temperature }),
      signal: currentAbortController.signal,
    });

    removeLoading();
    const data = await safeJson(resp);

    if (data.error) {
      addError(data.error);
      return '';
    }

    addAssistantResult(data.answer, data.usage, data.elapsed, data.model, data.request_id);
    updateCumulativeStats(data.usage);
    assistantReply = data.answer;

    if (data.debug) updateDebugPanel(data.debug);
  } catch (err) {
    removeLoading();
    addError(`Network error: ${err.message}`);
  }

  return assistantReply;
}

// ---- Streaming Request ----

async function sendStream(token, model, messages, temperature) {
  const es = document.getElementById('empty-state');
  if (es) es.style.display = 'none';

  const msg = document.createElement('div');
  msg.className = 'msg msg-assistant';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  scrollToBottom();

  let fullContent = '';
  let usage = null;
  let elapsed = 0;
  let streamDebugRequest = null;

  currentAbortController = new AbortController();

  try {
    const resp = await fetch('/api/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, model, messages, temperature }),
      signal: currentAbortController.signal,
    });

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payloadStr = line.slice(6);

        try {
          const payload = JSON.parse(payloadStr);

          if (payload.error) {
            bubble.innerHTML = '';
            addError(payload.error);
            return '';
          }

          if (payload.debug_request) streamDebugRequest = payload.debug_request;

          if (payload.content) {
            fullContent += payload.content;
            bubble.textContent = fullContent;
            scrollToBottom();
          }

          if (payload.usage) usage = payload.usage;

          if (payload.done) {
            elapsed = payload.elapsed;
            // Streaming used `bubble.textContent` so partial fenced blocks
            // never render half-finished. Now that we have the full content,
            // re-render once with markdown + decorate code blocks.
            try {
              bubble.innerHTML = renderMarkdown(fullContent);
              enhanceCodeBlocks(bubble);
            } catch (e) { /* keep plain text fallback */ }
            updateDebugPanel({
              request: streamDebugRequest,
              response: payload.debug_response || null,
            });
          }
        } catch (_) { /* skip invalid JSON */ }
      }
    }

    if (usage) {
      let detailHtml = '';
      if (usage.cached_tokens > 0 || usage.reasoning_tokens > 0) {
        detailHtml = '<div class="stats-detail">';
        if (usage.cached_tokens > 0)    detailHtml += `<span class="detail-tag cached">💾 Cached: ${fmt(usage.cached_tokens)}</span>`;
        if (usage.reasoning_tokens > 0) detailHtml += `<span class="detail-tag reasoning">🧠 Reasoning: ${fmt(usage.reasoning_tokens)}</span>`;
        detailHtml += '</div>';
      }

      const statsHtml = `
        <div class="stats-card">
          <div class="stat-item"><div class="stat-value green">${fmt(usage.prompt_tokens)}</div><div class="stat-label">Input</div></div>
          <div class="stat-item"><div class="stat-value orange">${fmt(usage.completion_tokens)}</div><div class="stat-label">Output</div></div>
          <div class="stat-item"><div class="stat-value">${fmt(usage.total_tokens)}</div><div class="stat-label">Total</div></div>
          <div class="stat-item"><div class="stat-value" style="color:var(--text)">${elapsed}s</div><div class="stat-label">Time</div></div>
        </div>
        ${detailHtml}
        <div class="msg-meta"><span>🤖 ${model}</span></div>
      `;
      msg.insertAdjacentHTML('beforeend', statsHtml);
      updateCumulativeStats(usage);
    }
  } catch (err) {
    bubble.innerHTML = '';
    addError(`Streaming error: ${err.message}`);
  }

  return fullContent;
}

// =============================================
//  IMAGE GENERATION
// =============================================

async function generateImage() {
  const genBtn = document.getElementById('image-gen-btn');

  // Snapshot inputs at click time. Each click spawns an independent task,
  // so we capture prompt/engine/etc. up-front and then immediately clear
  // the inputs — that way the user can fire another request to a different
  // engine while this one is still running.
  const token = document.getElementById('token').value.trim();
  const prompt = document.getElementById('image-prompt').value.trim();
  const imageUrls = attachedImages.image.slice();  // reference images
  if (!prompt && imageUrls.length === 0) return;

  const engine = document.getElementById('img-engine').value;

  // Reject rapid duplicate submissions (double-click / Enter+Enter bursts)
  // of the identical engine+prompt+refs within DEDUPE_MS. A different
  // engine or a different prompt is always accepted, which preserves the
  // "concurrent requests" capability.
  const dedupeKey = 'img|' + engine + '|' + prompt + '|' + imageUrls.join(',');
  if (_isDuplicateSubmit('image', dedupeKey)) return;
  const aspectEl = document.querySelector('#img-aspect-ratio .pill.active');
  const aspectRatio = aspectEl ? aspectEl.getAttribute('data-value') : '1:1';
  const resEl = document.querySelector('#img-resolution .pill.active');
  const resolution = resEl ? resEl.getAttribute('data-value') : '1024x1024';

  const imageEmpty = document.getElementById('image-empty');
  if (imageEmpty) imageEmpty.style.display = 'none';

  const resultsContainer = document.getElementById('image-results');

  // Per-card AbortController — allows concurrent requests from the same UI.
  const cardId = 'img-card-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const abortCtrl = new AbortController();
  imageAbortMap.set(cardId, abortCtrl);

  // Show processing card with an inline ✕ Stop button (top-right of header).
  const processingCard = document.createElement('div');
  processingCard.className = 'result-card';
  processingCard.id = cardId;
  processingCard.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot processing"></span>
        <span style="font-size:13px; font-weight:600;">Generating image...</span>
      </div>
      <div class="result-card-info">
        <span class="info-tag engine">${escapeHtml(engine)}</span>
        <span class="info-tag">${escapeHtml(aspectRatio)}</span>
        <button class="card-stop-btn" data-card-id="${cardId}" title="Stop this request">✕ Stop</button>
      </div>
    </div>
    <div class="result-card-body">
      <div class="result-prompt">${escapeHtml(prompt)}</div>
    </div>
  `;
  resultsContainer.appendChild(processingCard);
  // Wire up the stop button for this card only.
  const stopBtn = processingCard.querySelector('.card-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      const ctrl = imageAbortMap.get(cardId);
      if (ctrl) ctrl.abort();
    });
  }

  // Clear inputs immediately so the user can queue another request right away.
  document.getElementById('image-prompt').value = '';
  resetAutoResize(document.getElementById('image-prompt'));
  attachedImages.image = [];
  renderAttachPreview('image');
  document.getElementById('img-attach-btn').classList.remove('has-file');
  resultsContainer.scrollTop = resultsContainer.scrollHeight;

  // Generate button stays as ▶ Generate — concurrent tasks are allowed.
  genBtn.disabled = false;
  genBtn.textContent = '▶ Generate';
  genBtn.classList.remove('stop-mode');
  genBtn.onclick = function() { generateImage(); };

  try {
    const resp = await fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        prompt,
        engine,
        aspect_ratio: aspectRatio,
        resolution,
        image_urls: imageUrls,
      }),
      signal: abortCtrl.signal,
    });

    const data = await safeJson(resp);
    const existingCard = document.getElementById(cardId);

    if (data.error) {
      if (existingCard) {
        existingCard.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot error"></span>
              <span style="font-size:13px; font-weight:600;">Error</span>
            </div>
            <div class="result-card-info">
              <span class="info-tag engine">${escapeHtml(engine)}</span>
            </div>
          </div>
          <div class="result-card-body">
            <div class="error-msg">⚠️ ${escapeHtml(data.error)}</div>
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>
        `;
      }
    } else {
      const imageUrl = data.image_url || data.url || '';
      // Persist into per-browser history.
      let _hid = '';
      if (imageUrl && window.AigcHistory) {
        try {
          _hid = window.AigcHistory.add({
            kind: 'image',
            engine,
            label: engine,
            prompt: prompt || '',
            url: imageUrl,
            refs: imageUrls || [],
            meta: { aspect_ratio: aspectRatio, resolution, source: 'single' },
          }) || '';
        } catch (_) {}
      }
      const saveBtn = '';  /* (Removed) 'Save to Gallery' button — gallery feature removed */
      if (existingCard) {
        existingCard.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot success"></span>
              <span style="font-size:13px; font-weight:600;">Complete</span>
            </div>
            <div class="result-card-info">
              <span class="info-tag engine">${escapeHtml(engine)}</span>
              <span class="info-tag">${escapeHtml(aspectRatio)} · ${escapeHtml(resolution)}</span>
              ${saveBtn}
            </div>
          </div>
          <div class="result-card-body">
            ${imageUrl ? `<img class="result-image" src="${escapeHtml(imageUrl)}" alt="Generated Image">
            <a class="result-download" href="${escapeHtml(imageUrl)}" download target="_blank">⬇ Download Image</a>` :
              `<div style="padding:20px;text-align:center;color:var(--text-dim);">Image generated (no preview URL available)</div>`}
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>
        `;
        if (_hid) existingCard.dataset.historyId = _hid;
      }
    }

    // (Removed) per-generation usage recording to /api/stats (DB removed).
    updateDebugPanel({
      request: { endpoint: '/api/image/generate', method: 'POST', body: { prompt, engine, aspect_ratio: aspectRatio, resolution } },
      response: data,
    });
  } catch (err) {
    const existingCard = document.getElementById(cardId);
    if (existingCard) {
      const isAbort = err && err.name === 'AbortError';
      existingCard.innerHTML = `
        <div class="result-card-header">
          <div class="result-card-status">
            <span class="status-dot error"></span>
            <span style="font-size:13px; font-weight:600;">${isAbort ? 'Stopped' : 'Error'}</span>
          </div>
          <div class="result-card-info">
            <span class="info-tag engine">${escapeHtml(engine)}</span>
          </div>
        </div>
        <div class="result-card-body">
          <div class="error-msg">${isAbort ? '⏹ Request stopped by user' : '⚠️ Network error: ' + escapeHtml(err.message)}</div>
          <div class="result-prompt">${escapeHtml(prompt)}</div>
        </div>
      `;
    }
  } finally {
    imageAbortMap.delete(cardId);
    const resultsEl = document.getElementById('image-results');
    resultsEl.scrollTop = resultsEl.scrollHeight;
  }
}

// =============================================
//  VIDEO GENERATION
// =============================================

async function generateVideo() {
  const genBtn = document.getElementById('video-gen-btn');

  // Snapshot inputs at click time. Each click spawns an independent task.
  const token = document.getElementById('token').value.trim();
  const prompt = document.getElementById('video-prompt').value.trim();
  const videoImageUrls = attachedImages.video.slice();  // start frame(s) for i2v
  if (!prompt && videoImageUrls.length === 0) return;

  const engine = document.getElementById('vid-engine').value;

  // Same dedupe guard as generateImage() — blocks rapid duplicate clicks
  // of the identical engine+prompt+refs, but allows a concurrent request
  // with a different engine or prompt.
  const dedupeKey = 'vid|' + engine + '|' + prompt + '|' + videoImageUrls.join(',');
  if (_isDuplicateSubmit('video', dedupeKey)) return;
  const aspectEl = document.querySelector('#vid-aspect-ratio .pill.active');
  const aspectRatio = aspectEl ? aspectEl.getAttribute('data-value') : '16:9';
  const resEl = document.querySelector('#vid-resolution .pill.active');
  const resolution = resEl ? resEl.getAttribute('data-value') : '720P';
  const durEl = document.querySelector('.duration-chip.active');
  const duration = durEl ? durEl.textContent.trim().replace(/\s+/g, '').replace(/default|long|기본|긴 영상/g, '') : '5s';

  const videoEmpty = document.getElementById('video-empty');
  if (videoEmpty) videoEmpty.style.display = 'none';

  const resultsContainer = document.getElementById('video-results');

  // Per-card AbortController — concurrent video tasks are allowed.
  const cardId = 'vid-card-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const abortCtrl = new AbortController();
  videoAbortMap.set(cardId, abortCtrl);

  // Show processing card with an inline ✕ Stop button.
  const processingCard = document.createElement('div');
  processingCard.className = 'result-card';
  processingCard.id = cardId;
  processingCard.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot processing"></span>
        <span style="font-size:13px; font-weight:600;">Generating video... (may take 2~5 min)</span>
      </div>
      <div class="result-card-info">
        <span class="info-tag engine">${escapeHtml(engine)}</span>
        <span class="info-tag">${escapeHtml(aspectRatio)} · ${escapeHtml(resolution)}</span>
        <button class="card-stop-btn" data-card-id="${cardId}" title="Stop this request">✕ Stop</button>
      </div>
    </div>
    <div class="result-card-body">
      <div class="result-prompt">${escapeHtml(prompt)}</div>
    </div>
  `;
  resultsContainer.appendChild(processingCard);
  const stopBtn = processingCard.querySelector('.card-stop-btn');
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      const ctrl = videoAbortMap.get(cardId);
      if (ctrl) ctrl.abort();
    });
  }

  // Clear inputs immediately so the user can queue another request.
  document.getElementById('video-prompt').value = '';
  resetAutoResize(document.getElementById('video-prompt'));
  attachedImages.video = [];
  renderAttachPreview('video');
  document.getElementById('vid-attach-btn').classList.remove('has-file');
  resultsContainer.scrollTop = resultsContainer.scrollHeight;

  // Generate button stays as ▶ Generate — concurrent tasks are allowed.
  genBtn.disabled = false;
  genBtn.textContent = '▶ Generate';
  genBtn.classList.remove('stop-mode');
  genBtn.onclick = function() { generateVideo(); };

  try {
    const resp = await fetch('/api/video/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        prompt,
        engine,
        aspect_ratio: aspectRatio,
        resolution,
        duration,
        start_frame_url: videoImageUrls[0] || '',
        end_frame_url: videoImageUrls[1] || '',
        ref_image_urls: videoImageUrls.slice(2),
      }),
      signal: abortCtrl.signal,
    });

    const data = await safeJson(resp);
    const existingCard = document.getElementById(cardId);

    if (data.error) {
      if (existingCard) {
        existingCard.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot error"></span>
              <span style="font-size:13px; font-weight:600;">Error</span>
            </div>
            <div class="result-card-info">
              <span class="info-tag engine">${escapeHtml(engine)}</span>
            </div>
          </div>
          <div class="result-card-body">
            <div class="error-msg">⚠️ ${escapeHtml(data.error)}</div>
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>
        `;
      }
    } else {
      const videoUrl = data.video_url || data.url || '';
      let _hid = '';
      if (videoUrl && window.AigcHistory) {
        try {
          _hid = window.AigcHistory.add({
            kind: 'video',
            engine,
            label: engine,
            prompt: prompt || '',
            url: videoUrl,
            refs: videoImageUrls || [],
            meta: { aspect_ratio: aspectRatio, resolution, duration, source: 'single' },
          }) || '';
        } catch (_) {}
      }
      const saveBtn = '';  /* (Removed) 'Save to Gallery' button — gallery feature removed */
      if (existingCard) {
        existingCard.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot success"></span>
              <span style="font-size:13px; font-weight:600;">Complete</span>
            </div>
            <div class="result-card-info">
              <span class="info-tag engine">${escapeHtml(engine)}</span>
              <span class="info-tag">${escapeHtml(aspectRatio)} · ${escapeHtml(resolution)}</span>
              ${saveBtn}
            </div>
          </div>
          <div class="result-card-body">
            ${videoUrl ? `<video class="result-video" controls autoplay loop muted playsinline src="${escapeHtml(videoUrl)}"></video>
            <a class="result-download" href="${escapeHtml(videoUrl)}" download target="_blank">⬇ Download Video</a>` :
              `<div style="padding:20px;text-align:center;color:var(--text-dim);">Video generated (no preview URL available)</div>`}
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>
        `;
        if (_hid) existingCard.dataset.historyId = _hid;
      }
    }

    // (Removed) per-generation usage recording to /api/stats (DB removed).
    updateDebugPanel({
      request: { endpoint: '/api/video/generate', method: 'POST', body: { prompt, engine, aspect_ratio: aspectRatio, resolution, duration } },
      response: data,
    });
  } catch (err) {
    const existingCard = document.getElementById(cardId);
    if (existingCard) {
      const isAbort = err && err.name === 'AbortError';
      existingCard.innerHTML = `
        <div class="result-card-header">
          <div class="result-card-status">
            <span class="status-dot error"></span>
            <span style="font-size:13px; font-weight:600;">${isAbort ? 'Stopped' : 'Error'}</span>
          </div>
          <div class="result-card-info">
            <span class="info-tag engine">${escapeHtml(engine)}</span>
          </div>
        </div>
        <div class="result-card-body">
          <div class="error-msg">${isAbort ? '⏹ Request stopped by user' : '⚠️ Network error: ' + escapeHtml(err.message)}</div>
          <div class="result-prompt">${escapeHtml(prompt)}</div>
        </div>
      `;
    }
  } finally {
    videoAbortMap.delete(cardId);
    const resultsEl = document.getElementById('video-results');
    resultsEl.scrollTop = resultsEl.scrollHeight;
  }
}

// =============================================
//  MUSIC GENERATION  (VOD AIGC Audio)
// =============================================

// Engine → which option sections apply + a one-line note. This is what makes
// MiniMax (lyrics/vocal) vs Google Lyria (instrumental-leaning) vs Kling SFX
// (sound effects, duration only) behave differently in the UI.
const musicEngineMeta = {
  'minimax_music_26': { lyrics: true,  instrumental: true,  duration: false, note: 'MiniMax 2.6 · 가사 입력 시 보컬 곡, 비우면 자동 작사.' },
  'minimax_music_25': { lyrics: true,  instrumental: true,  duration: false, note: 'MiniMax 2.5 · 가사 입력 시 보컬 곡, 비우면 자동 작사.' },
  'minimax_music_20': { lyrics: true,  instrumental: true,  duration: false, note: 'MiniMax 2.0 · 가사 입력 시 보컬 곡, 비우면 자동 작사.' },
  'lyria_pro':        { lyrics: false, instrumental: true,  duration: false, note: 'Lyria Pro · 고품질 연주곡 중심. 프롬프트로 장르·악기·분위기를 묘사하세요.' },
  'lyria_clip':       { lyrics: false, instrumental: true,  duration: false, note: 'Lyria Clip · 짧은 연주 클립에 최적화.' },
  'kling_sfx':        { lyrics: false, instrumental: false, duration: true,  note: 'Kling SFX · 효과음(SFX) 생성. 길이를 지정하세요.' },
};

function updateMusicOptions() {
  const sel = document.getElementById('music-engine');
  if (!sel) return;
  const meta = musicEngineMeta[sel.value] || { lyrics: true, instrumental: true, duration: false, note: '' };
  const lyrics = document.getElementById('music-lyrics-section');
  const instr  = document.getElementById('music-instrumental-section');
  const dur    = document.getElementById('music-duration-section');
  const note   = document.getElementById('music-engine-note');
  if (lyrics) lyrics.style.display = meta.lyrics ? '' : 'none';
  if (instr)  instr.style.display  = meta.instrumental ? '' : 'none';
  if (dur)    dur.style.display    = meta.duration ? '' : 'none';
  if (note)   note.textContent     = meta.note || '';
}

async function generateMusic() {
  const token = document.getElementById('token').value.trim();
  const promptEl = document.getElementById('music-prompt');
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  const engine = document.getElementById('music-engine').value;
  const meta = musicEngineMeta[engine] || {};
  const lyricsEl = document.getElementById('music-lyrics');
  const lyrics = (meta.lyrics && lyricsEl) ? lyricsEl.value.trim() : '';
  const instrEl = document.getElementById('music-instrumental');
  const instrumental = (meta.instrumental && instrEl) ? instrEl.checked : false;
  let duration = null;
  if (meta.duration) {
    const dEl = document.querySelector('#music-duration .pill.active');
    duration = dEl ? parseInt(dEl.getAttribute('data-value'), 10) : 5;
  }

  const dedupeKey = 'music|' + engine + '|' + prompt + '|' + lyrics;
  if (_isDuplicateSubmit('music', dedupeKey)) return;

  const empty = document.getElementById('music-empty');
  if (empty) empty.style.display = 'none';
  const resultsContainer = document.getElementById('music-results');

  const cardId = 'music-card-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const card = document.createElement('div');
  card.className = 'result-card';
  card.id = cardId;
  card.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot processing"></span>
        <span style="font-size:13px; font-weight:600;">Generating music...</span>
      </div>
      <div class="result-card-info">
        <span class="info-tag engine">${escapeHtml(engine)}</span>
      </div>
    </div>
    <div class="result-card-body">
      <div class="result-prompt">${escapeHtml(prompt)}</div>
    </div>`;
  resultsContainer.appendChild(card);

  promptEl.value = '';
  resetAutoResize(promptEl);
  resultsContainer.scrollTop = resultsContainer.scrollHeight;

  try {
    const resp = await fetch('/api/music/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, prompt, engine, lyrics, instrumental, duration }),
    });
    const data = await safeJson(resp);
    const existing = document.getElementById(cardId);
    if (data.error) {
      if (existing) {
        existing.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot error"></span>
              <span style="font-size:13px; font-weight:600;">Error</span>
            </div>
            <div class="result-card-info"><span class="info-tag engine">${escapeHtml(engine)}</span></div>
          </div>
          <div class="result-card-body">
            <div class="error-msg">⚠️ ${escapeHtml(data.error)}</div>
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>`;
      }
    } else {
      const audioUrl = data.audio_url || '';
      let _hid = '';
      if (audioUrl && window.AigcHistory) {
        try {
          _hid = window.AigcHistory.add({
            kind: 'audio', engine, label: engine, prompt: prompt || '',
            url: audioUrl, refs: [], meta: { lyrics, instrumental, source: 'music' },
          }) || '';
        } catch (_) {}
      }
      if (existing) {
        existing.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot success"></span>
              <span style="font-size:13px; font-weight:600;">Complete</span>
            </div>
            <div class="result-card-info"><span class="info-tag engine">${escapeHtml(engine)}</span></div>
          </div>
          <div class="result-card-body">
            ${audioUrl ? `<audio class="result-audio" controls preload="metadata" src="${escapeHtml(audioUrl)}"></audio>
            <a class="result-download" href="${escapeHtml(audioUrl)}" download target="_blank">⬇ Download Audio</a>` :
              `<div style="padding:20px;text-align:center;color:var(--text-dim);">Audio generated (no preview URL)</div>`}
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>`;
        if (_hid) existing.dataset.historyId = _hid;
      }
    }
    updateDebugPanel({
      request: { endpoint: '/api/music/generate', method: 'POST', body: { prompt, engine, lyrics, instrumental, duration } },
      response: data,
    });
  } catch (err) {
    const existing = document.getElementById(cardId);
    if (existing) {
      existing.innerHTML = `
        <div class="result-card-header">
          <div class="result-card-status">
            <span class="status-dot error"></span>
            <span style="font-size:13px; font-weight:600;">Error</span>
          </div>
          <div class="result-card-info"><span class="info-tag engine">${escapeHtml(engine)}</span></div>
        </div>
        <div class="result-card-body">
          <div class="error-msg">⚠️ Network error: ${escapeHtml(err.message)}</div>
          <div class="result-prompt">${escapeHtml(prompt)}</div>
        </div>`;
    }
  } finally {
    const el = document.getElementById('music-results');
    if (el) el.scrollTop = el.scrollHeight;
  }
}

// =============================================
//  3D GENERATION  (VOD AIGC — Panorama / Scene)
// =============================================

const threedModeMeta = {
  'panorama': '360° Panorama · 7680×3840 등장방형(equirectangular) 파노라마 이미지. 약 1분 소요.',
  'scene':    '3D Scene · 카메라가 움직이는 입체 공간 영상. 수 분 이상 소요될 수 있어요.',
};

function update3DOptions() {
  const el = document.querySelector('#threed-mode .pill.active');
  const kind = el ? el.getAttribute('data-value') : 'panorama';
  const note = document.getElementById('threed-mode-note');
  if (note) note.textContent = threedModeMeta[kind] || '';
}

async function generate3D() {
  const token = document.getElementById('token').value.trim();
  const promptEl = document.getElementById('threed-prompt');
  const prompt = promptEl.value.trim();
  const refs = (attachedImages.threed || []).slice();
  const imageUrl = refs[0] || '';
  if (!prompt && !imageUrl) return;

  const kindEl = document.querySelector('#threed-mode .pill.active');
  const kind = kindEl ? kindEl.getAttribute('data-value') : 'panorama';

  const dedupeKey = '3d|' + kind + '|' + prompt + '|' + imageUrl;
  if (_isDuplicateSubmit('threed', dedupeKey)) return;

  const empty = document.getElementById('threed-empty');
  if (empty) empty.style.display = 'none';
  const resultsContainer = document.getElementById('threed-results');

  const kindLabel = kind === 'scene' ? '3D Scene' : '360° Panorama';
  const waitNote = kind === 'scene'
    ? 'Generating 3D scene... (수 분 소요될 수 있어요)'
    : 'Generating 360° panorama... (~1분)';

  const cardId = '3d-card-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  const card = document.createElement('div');
  card.className = 'result-card';
  card.id = cardId;
  card.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot processing"></span>
        <span style="font-size:13px; font-weight:600;">${escapeHtml(waitNote)}</span>
      </div>
      <div class="result-card-info"><span class="info-tag engine">${escapeHtml(kindLabel)}</span></div>
    </div>
    <div class="result-card-body">
      <div class="result-prompt">${escapeHtml(prompt)}</div>
    </div>`;
  resultsContainer.appendChild(card);

  promptEl.value = '';
  resetAutoResize(promptEl);
  attachedImages.threed = [];
  renderAttachPreview('threed');
  const ab = document.getElementById('threed-attach-btn');
  if (ab) ab.classList.remove('has-file');
  resultsContainer.scrollTop = resultsContainer.scrollHeight;

  try {
    const resp = await fetch('/api/threed/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, prompt, kind, image_url: imageUrl }),
    });
    const data = await safeJson(resp);
    const existing = document.getElementById(cardId);
    if (data.error) {
      if (existing) {
        existing.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot error"></span>
              <span style="font-size:13px; font-weight:600;">Error</span>
            </div>
            <div class="result-card-info"><span class="info-tag engine">${escapeHtml(kindLabel)}</span></div>
          </div>
          <div class="result-card-body">
            <div class="error-msg">⚠️ ${escapeHtml(data.error)}</div>
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>`;
      }
    } else {
      const url = data.url || '';
      const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(url) || kind === 'scene';
      let _hid = '';
      if (url && window.AigcHistory) {
        try {
          _hid = window.AigcHistory.add({
            kind: isVideo ? 'video' : 'image', engine: '3d-' + kind, label: kindLabel,
            prompt: prompt || '', url, refs, meta: { source: '3d', threed_kind: kind },
          }) || '';
        } catch (_) {}
      }
      let media;
      if (!url) {
        media = `<div style="padding:20px;text-align:center;color:var(--text-dim);">3D generated (no preview URL)</div>`;
      } else if (isVideo) {
        media = `<video class="result-video" controls preload="metadata" src="${escapeHtml(url)}"></video>
          <a class="result-download" href="${escapeHtml(url)}" download target="_blank">⬇ Download</a>`;
      } else {
        media = `<img class="result-image" src="${escapeHtml(url)}" alt="3D Panorama">
          <a class="result-download" href="${escapeHtml(url)}" download target="_blank">⬇ Download (equirectangular)</a>`;
      }
      if (existing) {
        existing.innerHTML = `
          <div class="result-card-header">
            <div class="result-card-status">
              <span class="status-dot success"></span>
              <span style="font-size:13px; font-weight:600;">Complete</span>
            </div>
            <div class="result-card-info"><span class="info-tag engine">${escapeHtml(kindLabel)}</span></div>
          </div>
          <div class="result-card-body">
            ${media}
            <div class="result-prompt">${escapeHtml(prompt)}</div>
          </div>`;
        if (_hid) existing.dataset.historyId = _hid;
      }
    }
    updateDebugPanel({
      request: { endpoint: '/api/threed/generate', method: 'POST', body: { prompt, kind, image_url: imageUrl } },
      response: data,
    });
  } catch (err) {
    const existing = document.getElementById(cardId);
    if (existing) {
      existing.innerHTML = `
        <div class="result-card-header">
          <div class="result-card-status">
            <span class="status-dot error"></span>
            <span style="font-size:13px; font-weight:600;">Error</span>
          </div>
          <div class="result-card-info"><span class="info-tag engine">${escapeHtml(kindLabel)}</span></div>
        </div>
        <div class="result-card-body">
          <div class="error-msg">⚠️ Network error: ${escapeHtml(err.message)}</div>
          <div class="result-prompt">${escapeHtml(prompt)}</div>
        </div>`;
    }
  } finally {
    const el = document.getElementById('threed-results');
    if (el) el.scrollTop = el.scrollHeight;
  }
}

// =============================================
//  API Guide notice bars (per section, dismissable + persistent)
// =============================================
function dismissApiNotice(btn, section) {
  const bar = btn.closest('.api-notice');
  if (bar) bar.style.display = 'none';
  try { localStorage.setItem('apiNoticeDismissed:' + section, '1'); } catch (_) {}
}

function initApiNotices() {
  document.querySelectorAll('.api-notice').forEach(bar => {
    const section = bar.getAttribute('data-section');
    try {
      if (section && localStorage.getItem('apiNoticeDismissed:' + section) === '1') {
        bar.style.display = 'none';
      }
    } catch (_) {}
  });
}

// Keep the 3D mode note in sync with the panorama/scene pill selection.
(function _wire3DModeNote() {
  const grp = document.getElementById('threed-mode');
  if (grp) {
    grp.addEventListener('click', e => {
      if (e.target.classList.contains('pill')) update3DOptions();
    });
  }
  if (typeof update3DOptions === 'function') update3DOptions();
})();

// ---- Initialization ----

// 모든 프롬프트 textarea를 한 줄 시작 → 10줄까지 자동 확장 → 그 이후 스크롤.
// CSS 의 min-height(46px) / max-height(236px) 와 함께 동작.
// 외부에서 호출용으로 노출해 두면, .value = '' 직후에 resetAutoResize(el) 로 줄여줄 수 있음.
const _AUTO_RESIZE_MAX = 236;
function autoResize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, _AUTO_RESIZE_MAX) + 'px';
}
function resetAutoResize(el) {
  if (!el) return;
  el.style.height = '';   // CSS min-height(=46px)로 돌아감
}
function bindAutoResize(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', () => autoResize(el));
  // 초기 값이 placeholder만 있을 때도 정상 높이로
  autoResize(el);
}
[
  'message-input',
  'image-prompt',
  'video-prompt',
  'image-battle-prompt',
  'video-battle-prompt',
  'music-prompt',
  'threed-prompt',
].forEach(bindAutoResize);

// === info-icon 툴팁 — fixed 위치를 동적 계산하여 사이드바 overflow 무시 ===
// CSS 의 .info-tooltip { position: fixed } 와 한 쌍으로 동작.
// hover/focus 시 아이콘 우측 옆 또는 아래로 펼치되, 화면 밖으로 나가지 않도록 보정.
function _placeInfoTooltip(iconEl) {
  const tip = iconEl.querySelector('.info-tooltip');
  if (!tip) return;
  // 측정 위해 잠시 보이게 (visibility hidden 상태로 사이즈 측정)
  tip.style.left = '-9999px';
  tip.style.top  = '0px';
  // strong: layout 트리거
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const r = iconEl.getBoundingClientRect();
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 1순위: 아이콘 우측 옆 (수직 중앙 정렬)
  let left = r.right + margin;
  let top  = r.top + r.height / 2 - tipH / 2;

  // 우측이 viewport 밖으로 나가면 → 아이콘 아래로
  if (left + tipW > vw - 8) {
    left = Math.min(r.left, vw - tipW - 8);
    top  = r.bottom + margin;
  }
  // 하단도 잘리면 → 아이콘 위로
  if (top + tipH > vh - 8) {
    top = Math.max(8, r.top - tipH - margin);
  }
  // 좌/상단 가드
  if (left < 8) left = 8;
  if (top  < 8) top  = 8;

  tip.style.left = left + 'px';
  tip.style.top  = top + 'px';
}
document.querySelectorAll('.info-icon').forEach(icon => {
  const show = () => _placeInfoTooltip(icon);
  icon.addEventListener('mouseenter', show);
  icon.addEventListener('focus', show);
});

// Temperature slider display sync
document.getElementById('temperature').addEventListener('input', function () {
  document.getElementById('temp-display').textContent = this.value;
});

// === 모델 변경 시 첨부 버튼 상태 갱신 + 기존 첨부 이미지 가드 ===
function _updateChatAttachAvailability() {
  const btn = document.getElementById('chat-attach-btn');
  if (!btn) return;
  const vision = _currentModelSupportsVision();
  btn.disabled = !vision;
  btn.style.opacity = vision ? '' : '0.4';
  btn.style.cursor  = vision ? '' : 'not-allowed';
  btn.title = vision
    ? 'Attach image (or paste from clipboard)'
    : '이 모델은 멀티모달을 지원하지 않습니다';
  // 비전 미지원으로 바뀌었는데 이미 첨부된 이미지가 있다면 제거하고 안내
  if (!vision && chatAttachedImages.length > 0) {
    chatAttachedImages.length = 0;
    renderChatAttachPreview();
    alert(`'${_currentModelLabel()}' 은(는) 멀티모달을 지원하지 않아\n첨부된 이미지를 제거했습니다.`);
  }
}
const _modelSel = document.getElementById('model');
if (_modelSel) {
  _modelSel.addEventListener('change', _updateChatAttachAvailability);
  // 초기 상태 반영
  _updateChatAttachAvailability();
}

// Restore cumulative stats from server
loadCumulativeStats();

// Initialize turn counter
updateTurnCounter();

// Initialize engine options
updateImageOptions();
updateVideoOptions();

// Focus input on load
messageInput.focus();

// Clipboard paste handler for chat images
messageInput.addEventListener('paste', handlePaste);

// Pre-bind IME composition tracking on every prompt textarea so the
// duplicate-on-Enter bug cannot fire even on the very first keystroke.
[
  'message-input',
  'image-prompt',
  'video-prompt',
  'image-battle-prompt',
  'video-battle-prompt',
  'music-prompt',
  'threed-prompt',
].forEach(id => {
  const el = document.getElementById(id);
  if (el) _attachImeTracking(el);
});

// Drag & drop image onto chat input
messageInput.addEventListener('dragover', function(e) { e.preventDefault(); this.style.borderColor = 'var(--accent)'; });
messageInput.addEventListener('dragleave', function() { this.style.borderColor = ''; });
messageInput.addEventListener('drop', function(e) {
  e.preventDefault();
  this.style.borderColor = '';
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files) return;
  // 이미지가 한 개라도 포함되어 있고 모델이 비전을 지원하지 않으면 막음
  let hasImage = false;
  for (const file of files) {
    if (file.type && file.type.startsWith('image/')) { hasImage = true; break; }
  }
  if (hasImage && !_assertModelVisionOrAlert()) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = function() {
      chatAttachedImages.push(reader.result);
      renderChatAttachPreview();
    };
    reader.readAsDataURL(file);
  }
});

// ---- File Upload Handlers ----
// Make upload-area and upload-multi-item clickable to open file picker
document.querySelectorAll('.upload-area, .upload-multi-item').forEach(area => {
  area.addEventListener('click', function () {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*';
    input.style.display = 'none';
    input.addEventListener('change', function () {
      if (this.files && this.files[0]) {
        const file = this.files[0];
        const reader = new FileReader();
        reader.onload = function (e) {
          // Show thumbnail preview
          if (file.type.startsWith('image/')) {
            area.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`;
            area.dataset.fileUrl = e.target.result;
          } else {
            area.innerHTML = `<div style="font-size:11px;color:var(--accent-light);padding:4px;text-align:center;word-break:break-all;">${escapeHtml(file.name)}</div>`;
          }
        };
        reader.readAsDataURL(file);
      }
    });
    document.body.appendChild(input);
    input.click();
    document.body.removeChild(input);
  });
});

// =============================================
//  IMAGE / VIDEO BATTLE MODE
// =============================================
// One prompt → all engines (latest version each), shown as a grid.
// Cells start as "Running...", flip to image/video as each finishes.

const IMAGE_BATTLE_ENGINES = [
  { id: 'gem31',          label: 'GEM 3.1 (nano2)' },
  { id: 'seedream50lite', label: 'Seedream 5.0 Lite' },
  { id: 'kling_img_30o',  label: 'Kling 3.0 Omni' },
  { id: 'hunyuan30',      label: 'Hunyuan 3.0' },
  { id: 'qwen0925',       label: 'Qwen 0925' },
  { id: 'viduq2_img',     label: 'Vidu Q2' },
  { id: 'jimeng_img_40',  label: 'Jimeng 4.0' },
  { id: 'mjv7',           label: 'Midjourney v7' },
  { id: 'og_img_low',     label: 'GPT Image Low' },
];

const VIDEO_BATTLE_ENGINES = [
  { id: 'kling30omni',  label: 'Kling 3.0 Omni' },
  { id: 'hailuo23',     label: 'Hailuo 2.3' },
  { id: 'viduq3pro',    label: 'Vidu Q3 Pro' },
  { id: 'seedance15pro',label: 'Seedance 1.5 Pro' },
  { id: 'pixversev6',   label: 'PixVerse v6' },
  { id: 'jimeng30pro',  label: 'Jimeng 3.0 Pro' },
  { id: 'gv31',         label: 'Veo 3.1' },
  { id: 'osv20',        label: 'Sora 2.0' },
  { id: 'mingmou10',    label: 'Mingmou 1.0' },
  { id: 'wan22',        label: 'Wan 2.2' },
  { id: 'h2_10',        label: 'H2 1.0' },
  { id: 'hunyuan15',    label: 'Hunyuan 1.5' },
];

// =================================================================
//  Battle engine picker — 사용자가 어떤 엔진을 호출할지 직접 선택.
//  비용 절감용. 디폴트는 처음 4개만 ON. 선택 상태는 localStorage 영속.
// =================================================================
const BATTLE_PICKER_KEY = 'aigc-chat:battle-engines:v1';
// in-memory state — { image: Set<engineId>, video: Set<engineId> }
const _battlePickerState = { image: new Set(), video: new Set() };

function _loadBattlePickerState() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(BATTLE_PICKER_KEY) || 'null'); } catch (_) {}
  const init = (kind, list) => {
    const fromSnap = snap && Array.isArray(snap[kind]) ? snap[kind] : null;
    if (fromSnap && fromSnap.length > 0) {
      // saved snapshot — engine ID가 현재 카탈로그에 있는 것만 채택.
      const valid = new Set(list.map(e => e.id));
      _battlePickerState[kind] = new Set(fromSnap.filter(id => valid.has(id)));
      if (_battlePickerState[kind].size === 0) {
        // saved snapshot이 비어있는 비정상 — 첫 4개 default 로 채움.
        list.slice(0, 4).forEach(e => _battlePickerState[kind].add(e.id));
      }
    } else {
      // 디폴트 — 처음 4개만 ON (비용 절감 디폴트)
      _battlePickerState[kind] = new Set(list.slice(0, 4).map(e => e.id));
    }
  };
  init('image', IMAGE_BATTLE_ENGINES);
  init('video', VIDEO_BATTLE_ENGINES);
}

function _saveBattlePickerState() {
  try {
    localStorage.setItem(BATTLE_PICKER_KEY, JSON.stringify({
      image: Array.from(_battlePickerState.image),
      video: Array.from(_battlePickerState.video),
    }));
  } catch (_) {}
}

function _renderBattleEnginePicker(kind) {
  const list = kind === 'image' ? IMAGE_BATTLE_ENGINES : VIDEO_BATTLE_ENGINES;
  const sel = _battlePickerState[kind];
  const host = document.getElementById(kind === 'image' ? 'image-battle-engine-chips' : 'video-battle-engine-chips');
  if (!host) return;
  host.innerHTML = list.map(e => {
    const on = sel.has(e.id);
    return `
      <label class="battle-engine-chip ${on ? 'is-on' : ''}" data-kind="${kind}" data-engine="${escapeHtml(e.id)}" title="${escapeHtml(e.label)}">
        <input type="checkbox" ${on ? 'checked' : ''} onchange="_toggleBattleEngine('${escapeHtml(kind)}', '${escapeHtml(e.id)}', this.checked)">
        <span class="battle-engine-chip-label">${escapeHtml(e.label)}</span>
      </label>`;
  }).join('');
  _updateBattleStartButton(kind);
}

function _toggleBattleEngine(kind, engineId, on) {
  const sel = _battlePickerState[kind];
  if (on) sel.add(engineId); else sel.delete(engineId);
  _saveBattlePickerState();
  // chip CSS class 동기화
  const chip = document.querySelector(`.battle-engine-chip[data-kind="${kind}"][data-engine="${engineId}"]`);
  if (chip) chip.classList.toggle('is-on', !!on);
  _updateBattleStartButton(kind);
}

function battleEnginePickerAll(kind, on) {
  const list = kind === 'image' ? IMAGE_BATTLE_ENGINES : VIDEO_BATTLE_ENGINES;
  _battlePickerState[kind] = on ? new Set(list.map(e => e.id)) : new Set();
  _saveBattlePickerState();
  _renderBattleEnginePicker(kind);
}

function _updateBattleStartButton(kind) {
  const btn = document.getElementById(kind === 'image' ? 'image-battle-btn' : 'video-battle-btn');
  if (!btn) return;
  const n = _battlePickerState[kind].size;
  btn.textContent = n > 0 ? `▶ Battle (${n})` : '▶ Battle';
  btn.disabled = (n === 0);
  btn.title = n === 0 ? '엔진을 1개 이상 선택해 주세요' : `${n}개 엔진 호출`;
}

function _getSelectedBattleEngines(kind) {
  const all = kind === 'image' ? IMAGE_BATTLE_ENGINES : VIDEO_BATTLE_ENGINES;
  const sel = _battlePickerState[kind];
  return all.filter(e => sel.has(e.id));
}

// 초기화 — 페이지 로드 후 picker 한 번 그려준다.
document.addEventListener('DOMContentLoaded', () => {
  _loadBattlePickerState();
  _renderBattleEnginePicker('image');
  _renderBattleEnginePicker('video');
});

function handleBattleKeyDown(e, kind) {
  _attachImeTracking(e.target);
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (_enterIsIme(e)) return;
  e.preventDefault();
  if (kind === 'image') startImageBattle();
  else startVideoBattle();
}

function _battleGuard(kind) {
  // Coalesce double-clicks (same as image/video gen).
  const now = Date.now();
  const slot = kind === 'image' ? lastSubmit.imgBattle : lastSubmit.vidBattle;
  if ((now - slot.ts) < DEDUPE_MS) return true;
  slot.ts = now;
  return false;
}

function _renderBattleCell(cardId, engineLabel, prompt) {
  const promptAttr = escapeHtml(prompt || '');
  return `
    <div class="battle-cell running" id="${cardId}" data-prompt="${promptAttr}" data-size="1">
      <div class="battle-cell-header">
        <span class="battle-cell-engine">${escapeHtml(engineLabel)}</span>
        <span class="battle-cell-status running">Running…</span>
        <button type="button" class="battle-cell-prompt" onclick="_battleShowPromptFromCell(event, this)" title="이 셀의 prompt 보기">Prompt</button>
      </div>
      <div class="battle-cell-body">
        <div class="battle-spinner">대기 중</div>
      </div>
    </div>`;
}

// In-flight 가드: 같은 (kind+engine)이 이미 진행 중이면 새 요청 차단.
// jimeng 같은 엔진에서 동시에 task가 2개 발사되는 회귀 방지.
const _battleInFlight = new Set();

// 더미 placeholder — 에러나 빈 URL일 때 결과 영역에 깔끔한 카드를 보여줌.
// 사용자 요청: 결과가 없으면 monkey 이미지를 더미로 노출.
function _renderBattlePlaceholder(label, kind, hint) {
  const tag = kind === 'image' ? 'IMG' : 'VID';
  return `
    <div class="battle-cell-placeholder dummy-monkey">
      <div class="ph-icon">${tag} · DUMMY</div>
      <div class="ph-engine">${escapeHtml(label)}</div>
      <div class="ph-note">${escapeHtml(hint || 'preview unavailable')}</div>
    </div>`;
}

// 디버그 패널 갱신 — 배틀에서는 모드 + 엔진을 명시해 N개 요청이 모두 누적됨.
function _battleDebug(kind, engine, endpoint, body, data) {
  try {
    pushDebugEntry(
      kind === 'image' ? 'image-battle' : 'video-battle',
      { request: { endpoint, method: 'POST', body }, response: data },
      { engine, endpoint }
    );
  } catch (_) { /* noop */ }
}

async function _runOneBattle(kind, engine, label, prompt, roundGrid, opts) {
  const flightKey = `${kind}:${engine}`;
  // opts: { existingCardId, skipFlightGuard } — used by retry path so the
  // exact same cell can be re-driven, even when another (concurrent) round
  // already runs the same engine.
  const skipFlightGuard = !!(opts && opts.skipFlightGuard);
  if (!skipFlightGuard && _battleInFlight.has(flightKey)) {
    // 같은 엔진이 이미 진행 중 — 무시 (jimeng 등 중복 task 방지).
    return;
  }
  if (!skipFlightGuard) _battleInFlight.add(flightKey);

  // Reuse the same cell for retry (existingCardId), otherwise create a new one.
  let cardId = opts && opts.existingCardId;
  if (!cardId) {
    cardId = `battle-${kind}-${engine}-${Date.now()}`;
    const container = roundGrid || document.getElementById(
      kind === 'image' ? 'image-battle-results' : 'video-battle-results'
    );
    container.insertAdjacentHTML('beforeend', _renderBattleCell(cardId, label, prompt));
  } else {
    // Replace existing cell content with the running placeholder.
    const existing = document.getElementById(cardId);
    if (existing) {
      existing.classList.remove('placeholder', 'complete', 'error');
      existing.classList.add('running');
      existing.outerHTML = _renderBattleCell(cardId, label, prompt);
    }
  }

  const startedAt = Date.now();
  const endpoint = kind === 'image' ? '/api/image/generate' : '/api/video/generate';
  // Attach reference / start-frame images shared across all battle engines.
  // image battle → image_urls (i2i refs); video battle → start_frame_url + ref_image_urls (i2v).
  // For retry, prefer refs captured at original dispatch (saved on the card via
  // dataset). Otherwise fall back to the current attachedImages state.
  let battleRefs;
  if (opts && Array.isArray(opts.refs)) {
    battleRefs = opts.refs.slice();
  } else {
    battleRefs = (attachedImages[kind === 'image' ? 'image-battle' : 'video-battle'] || []).slice();
  }
  const body = kind === 'image'
    ? { token: '__SERVER__', prompt, engine, aspect_ratio: '1:1', resolution: '1024x1024', image_urls: battleRefs }
    : { token: '__SERVER__', prompt, engine, aspect_ratio: '16:9', resolution: '720P',
        duration: _resolveBattleDuration(engine, opts && opts.duration),
        start_frame_url: battleRefs[0] || '', end_frame_url: battleRefs[1] || '', ref_image_urls: battleRefs.slice(2) };

  // Persist dispatch info on the card so a future retry can re-issue the
  // exact same request without depending on the (now-cleared) input bar.
  const cardEl0 = document.getElementById(cardId);
  if (cardEl0) {
    cardEl0.dataset.kind = kind;
    cardEl0.dataset.engine = engine;
    cardEl0.dataset.label = label;
    cardEl0.dataset.prompt = prompt || '';
    if (kind === 'video') {
      cardEl0.dataset.duration = (opts && opts.duration) || '';
    }
    try { cardEl0.dataset.refs = JSON.stringify(battleRefs); } catch (_) { cardEl0.dataset.refs = '[]'; }
  }

  const promptAttr = escapeHtml(prompt || '');

  // 결과 카드를 placeholder 형태(완료/스타일)로 마무리하는 헬퍼.
  // status: 'done' | 'error' | 'network' | 'empty'
  const finishAsPlaceholder = (status, statusText, hint) => {
    const card = document.getElementById(cardId);
    if (!card) return;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';
    card.classList.remove('running');
    card.classList.add('placeholder');
    const isFailure = (status !== 'done' && status !== 'empty');
    if (status === 'done') card.classList.add('complete');
    else card.classList.add('error');
    const statusClass =
      status === 'done' ? 'complete' :
      status === 'network' ? 'error' :
      status === 'empty' ? 'complete' :
      'error';
    // For real failures show a Retry button — for "empty" (engine returned no
    // URL but no error) keep it as well so the user can re-roll.
    const showRetry = isFailure || status === 'empty';
    const retryBtn = showRetry
      ? `<button type="button" class="battle-cell-retry" onclick="_battleRetryFromCell('${cardId}')" title="같은 prompt/engine으로 재시도">▶ Retry</button>`
      : '';
    card.innerHTML = `
      <div class="battle-cell-header">
        <span class="battle-cell-engine">${escapeHtml(label)}</span>
        <span class="battle-cell-status ${statusClass}">${escapeHtml(statusText)} · ${elapsed}</span>
        ${retryBtn}
        <button type="button" class="battle-cell-prompt" onclick="_battleShowPromptFromCell(event, this)" title="이 셀의 prompt 보기">Prompt</button>
      </div>
      <div class="battle-cell-body">
        ${_renderBattlePlaceholder(label, kind, hint)}
      </div>`;
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await safeJson(resp);
    _battleDebug(kind, engine, endpoint, body, data);

    const card = document.getElementById(cardId);
    if (!card) return;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1) + 's';

    if (data && data.error) {
      // 에러 → 더미 placeholder + Retry 버튼
      const reason = String(data.error).slice(0, 60);
      finishAsPlaceholder('error', 'Failed', reason);
      return;
    }

    const url = data && (data.image_url || data.video_url || data.url) || '';
    if (!url) {
      finishAsPlaceholder('empty', 'No URL', 'engine returned empty');
      return;
    }

    card.classList.remove('running');
    card.classList.add('complete');

    // ---- Persist this result into per-browser history ----
    // Skip persistence if a restorer is the one constructing the cell
    // (opts.restoring=true). For new dispatches we add a fresh entry.
    let _historyId = '';
    if (!(opts && opts.restoring) && window.AigcHistory) {
      try {
        _historyId = window.AigcHistory.add({
          kind: kind === 'image' ? 'image-battle' : 'video-battle',
          engine,
          label,
          prompt: prompt || '',
          url,
          refs: battleRefs,
          meta: { source: 'battle' },
        }) || '';
      } catch (_) {}
    } else if (opts && opts.restoring && opts.historyId) {
      _historyId = opts.historyId;
    }

    // Gallery save button — 결과물을 서버 갤러리(public CDN)에 영구 등록.
    // 기존 ⭐(localStorage save) 로직은 제거. 만료 회피는 갤러리만 담당.
    const safeUrlAttr  = escapeHtml(url);
    const safeEngAttr  = escapeHtml(engine || '');
    const safePromAttr = escapeHtml(prompt || '');
    const safeRefAttr  = escapeHtml((battleRefs && battleRefs[0]) || '');
    // 배틀 모드는 aspect / duration 이 하드코딩되어 있음 (위 body 참조).
    const battleAspect   = kind === 'image' ? '1:1' : '16:9';
    const battleDuration = kind === 'video' ? '5'   : '';
    const saveBtn = '';  /* (Removed) 'Save to Gallery' button — gallery feature removed */

    if (kind === 'image') {
      // 이미지: 클릭 시 페이지 안 라이트박스 모달 (다운로드 X)
      // 로드 후엔 셀 내부 세로 스크롤을 가운데로 이동 (사용자 요청)
      card.innerHTML = `
        <div class="battle-cell-header">
          <span class="battle-cell-engine">${escapeHtml(label)}</span>
          <span class="battle-cell-status complete">Done · ${elapsed}</span>
          ${saveBtn}
          <button type="button" class="battle-cell-prompt" onclick="_battleShowPromptFromCell(event, this)" title="이 셀의 prompt 보기">Prompt</button>
        </div>
        <div class="battle-cell-body">
          <img src="${escapeHtml(url)}" alt="${escapeHtml(label)}"
               class="battle-img-clickable"
               onclick="openImageLightbox('${escapeHtml(url)}', '${escapeHtml(label)}')"
               onload="_centerBattleCellScroll(this)">
        </div>`;
    } else {
      // 비디오: 자동 무한루프 + 음소거 + 인라인 재생, controls는 미리보기 단계에서 숨김
      // 더블클릭 시 fullscreen + controls 활성화 (개별 재생 컨트롤은 fullscreen 한정)
      card.innerHTML = `
        <div class="battle-cell-header">
          <span class="battle-cell-engine">${escapeHtml(label)}</span>
          <span class="battle-cell-status complete">Done · ${elapsed}</span>
          ${saveBtn}
          <button type="button" class="battle-cell-prompt" onclick="_battleShowPromptFromCell(event, this)" title="이 셀의 prompt 보기">Prompt</button>
        </div>
        <div class="battle-cell-body battle-cell-video-clickable" title="클릭하여 원본 크기로 보기" onclick="openVideoLightbox('${escapeHtml(url)}', '${escapeHtml(label)}')">
          <video src="${escapeHtml(url)}" preload="metadata"
                 playsinline webkit-playsinline loop muted></video>
        </div>`;
    }
    // Persist history-id on the card so a future re-render preserves the link.
    if (_historyId) {
      const cardEl3 = document.getElementById(cardId);
      if (cardEl3) cardEl3.dataset.historyId = _historyId;
    }

    // (Removed) Cumulative Usage counting to /api/stats (DB removed).
    // Re-attach dispatch metadata so a (future, post-success) regen still works.
    const card2 = document.getElementById(cardId);
    if (card2) {
      card2.dataset.kind = kind;
      card2.dataset.engine = engine;
      card2.dataset.label = label;
      card2.dataset.prompt = prompt || '';
      try { card2.dataset.refs = JSON.stringify(battleRefs); } catch (_) {}
    }
  } catch (err) {
    _battleDebug(kind, engine, endpoint, body, { error: String(err && err.message || err) });
    finishAsPlaceholder('network', 'Network', String(err && err.message || err).slice(0, 60));
  } finally {
    if (!skipFlightGuard) _battleInFlight.delete(flightKey);
    _maybeUnlockBattleButtons();
  }
}

// Retry helper — re-runs the exact same dispatch in-place.
// `flightKey` guard is bypassed so a retry can fire even while another
// concurrent round (with a different cell) is still running the same engine.
function _battleRetryFromCell(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const kind = card.dataset.kind;
  const engine = card.dataset.engine;
  const label = card.dataset.label;
  const prompt = card.dataset.prompt || '';
  let refs = [];
  try { refs = JSON.parse(card.dataset.refs || '[]'); } catch (_) { refs = []; }
  if (!kind || !engine || !label) return;
  // Find the round-grid this cell lives in so a fresh placeholder render
  // (which `_runOneBattle` triggers via outerHTML rewrite) keeps the cell
  // in the right place.
  const roundGrid = card.closest('.battle-round-grid')
    || (kind === 'image'
          ? document.getElementById('image-battle-results')
          : document.getElementById('video-battle-results'));
  _runOneBattle(kind, engine, label, prompt, roundGrid, {
    existingCardId: cardId,
    refs,
    duration: card.dataset.duration || undefined,
    skipFlightGuard: true,
  });
}

// ⭐ Save — 셀의 결과를 영구 COS로 복사하고 entry.saved_url 갱신.
async function _battleSaveFromCell(ev, btnEl) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  if (!btnEl || !window.AigcHistory) return;
  const hid = btnEl.getAttribute('data-hid');
  if (!hid) return;
  if (btnEl.classList.contains('is-saved')) return;
  btnEl.disabled = true;
  btnEl.textContent = '⏳';
  try {
    await window.AigcHistory.saveToPermanent(hid);
    btnEl.classList.add('is-saved');
    btnEl.textContent = '✓';
    btnEl.title = '이 결과는 영구 저장되었습니다.';
  } catch (e) {
    btnEl.disabled = false;
    btnEl.textContent = '⭐';
    btnEl.title = 'Save 실패: ' + (e && e.message || e);
  }
}

// =================================================================
//  History — restorers (battle modes)
// =================================================================
function _restoreBattleEntry(entry) {
  if (!entry || !entry.url) return;
  const kind = entry.kind === 'image-battle' ? 'image' : 'video';
  const wantContainerId = entry.kind === 'image-battle'
    ? 'image-battle-results'
    : 'video-battle-results';
  const container = document.getElementById(wantContainerId);
  if (!container) return;
  // hide empty hint
  const empty = document.getElementById(
    entry.kind === 'image-battle' ? 'image-battle-empty' : 'video-battle-empty'
  );
  if (empty) empty.style.display = 'none';

  // Group restored items into a single "Restored" round per kind so the
  // grid layout stays consistent (4×3 for video, 9-col for image).
  const groupId = `restored-round-${entry.kind}`;
  let round = document.getElementById(groupId);
  let grid;
  if (!round) {
    round = document.createElement('div');
    round.id = groupId;
    round.className = 'battle-round battle-round-restored';
    round.innerHTML = `
      <div class="battle-round-head">
        <span class="battle-round-time">⟲ Restored</span>
        <span class="battle-round-engines">…</span>
      </div>
      <div class="battle-round-grid"></div>
    `;
    container.appendChild(round);
    grid = round.querySelector('.battle-round-grid');
  } else {
    grid = round.querySelector('.battle-round-grid');
  }

  const url = window.AigcHistory.pickUrl(entry);
  const expired = window.AigcHistory.isExpired(entry);
  const cardId = `restored-${entry.id}`;
  const promptAttr = escapeHtml(entry.prompt || '');
  const label = entry.label || entry.engine || '';
  // 만료된 경우만 별도 텍스트 노출, 정상 복원 결과는 status 자리에 표시 안 함
  // (사용자 요청: ⟲ restored 텍스트 제거, 대신 Prompt 버튼으로 대체)
  const statusBadge = expired
    ? `<span class="battle-cell-status complete">⚠ may be expired</span>`
    : '';
  const safeUrlAttr  = escapeHtml(url);
  const safeEngAttr  = escapeHtml(entry.engine || '');
  const safePromAttr = escapeHtml(entry.prompt || '');
  const safeRefAttr  = escapeHtml((entry.refs && entry.refs[0]) || '');
  // restored entry 의 meta 에서 가능한 정보 회수 — 없으면 배틀 기본값.
  const em = (entry.meta && typeof entry.meta === 'object') ? entry.meta : {};
  const aspAttr = escapeHtml(em.aspect_ratio || (kind === 'image' ? '1:1' : '16:9'));
  const durAttr = escapeHtml(String(em.duration || (kind === 'video' ? '5' : '')));
  const saveBtn = '';  /* (Removed) 'Save to Gallery' button — gallery feature removed */

  const cellHtml = (kind === 'image')
    ? `
      <div class="battle-cell complete placeholder restored" id="${cardId}"
           data-history-id="${entry.id}" data-kind="${entry.kind}"
           data-engine="${escapeHtml(entry.engine || '')}"
           data-label="${escapeHtml(label)}"
           data-prompt="${promptAttr}" data-size="1">
        <div class="battle-cell-header">
          <span class="battle-cell-engine">${escapeHtml(label)}</span>
          ${statusBadge}
          ${saveBtn}
          <button type="button" class="battle-cell-prompt" onclick="_battleShowPromptFromCell(event, this)" title="이 셀의 prompt 보기">Prompt</button>
        </div>
        <div class="battle-cell-body">
          <img src="${escapeHtml(url)}" alt="${escapeHtml(label)}"
               class="battle-img-clickable"
               onerror="this.parentElement.innerHTML='<div class=\\'battle-cell-error\\'>이미지 URL 만료 — Gallery 저장 항목만 영구 보존됩니다.</div>'"
               onclick="openImageLightbox('${escapeHtml(url)}', '${escapeHtml(label)}')">
        </div>
      </div>`
    : `
      <div class="battle-cell complete placeholder restored" id="${cardId}"
           data-history-id="${entry.id}" data-kind="${entry.kind}"
           data-engine="${escapeHtml(entry.engine || '')}"
           data-label="${escapeHtml(label)}"
           data-prompt="${promptAttr}" data-size="1">
        <div class="battle-cell-header">
          <span class="battle-cell-engine">${escapeHtml(label)}</span>
          ${statusBadge}
          ${saveBtn}
          <button type="button" class="battle-cell-prompt" onclick="_battleShowPromptFromCell(event, this)" title="이 셀의 prompt 보기">Prompt</button>
        </div>
        <div class="battle-cell-body battle-cell-video-clickable" title="클릭하여 원본 크기로 보기" onclick="openVideoLightbox('${escapeHtml(url)}', '${escapeHtml(label)}')">
          <video src="${escapeHtml(url)}" preload="metadata"
                 playsinline webkit-playsinline loop muted
                 onerror="this.parentElement.innerHTML='<div class=\\'battle-cell-error\\'>영상 URL 만료 — Gallery 저장 항목만 영구 보존됩니다.</div>'">
          </video>
        </div>
      </div>`;
  grid.insertAdjacentHTML('beforeend', cellHtml);
}

// 진행 중 셀이 한 개라도 있으면 "▶ Battle" 버튼을 disabled 시킴.
function _lockBattleButtons(kind) {
  const id = kind === 'image' ? 'image-battle-btn' : 'video-battle-btn';
  const btn = document.getElementById(id);
  if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
}
function _maybeUnlockBattleButtons() {
  const anyImg = Array.from(_battleInFlight).some(k => k.startsWith('image:'));
  const anyVid = Array.from(_battleInFlight).some(k => k.startsWith('video:'));
  const ib = document.getElementById('image-battle-btn');
  const vb = document.getElementById('video-battle-btn');
  if (ib && !anyImg) { ib.disabled = false; ib.classList.remove('is-busy'); }
  if (vb && !anyVid) { vb.disabled = false; vb.classList.remove('is-busy'); }
}

// 배틀 셀의 "Prompt" 버튼 → 그 셀의 prompt 를 모달로 표시.
// 셀의 data-prompt 어트리뷰트를 그대로 읽어와 보여준다.
function _battleShowPromptFromCell(ev, btn) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  const cell = btn && btn.closest('.battle-cell');
  if (!cell) return;
  const prompt = cell.getAttribute('data-prompt') || '';
  const engine = cell.getAttribute('data-engine')
    || cell.getAttribute('data-label')
    || '';
  _openPromptModal(prompt, engine);
}

// 셀의 prompt 를 보여주는 가벼운 모달 (이미지 라이트박스와 같은 톤).
// 외부 영역 / ESC / Close 버튼으로 닫기.
function _openPromptModal(promptText, engineLabel) {
  const old = document.getElementById('prompt-modal-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'prompt-modal-overlay';
  overlay.className = 'prompt-modal-overlay';
  overlay.innerHTML = `
    <div class="prompt-modal-card" onclick="event.stopPropagation()">
      <div class="prompt-modal-head">
        <span class="prompt-modal-title">Prompt${engineLabel ? ` · ${escapeHtml(engineLabel)}` : ''}</span>
        <div class="prompt-modal-actions">
          <button type="button" class="prompt-modal-copy" title="클립보드에 복사">Copy</button>
          <button type="button" class="prompt-modal-close" title="닫기 (Esc)">×</button>
        </div>
      </div>
      <div class="prompt-modal-body">
        <pre class="prompt-modal-text">${escapeHtml(promptText || '(prompt 없음)')}</pre>
      </div>
    </div>`;

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  overlay.addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.prompt-modal-close').addEventListener('click', (e) => {
    e.stopPropagation(); close();
  });
  overlay.querySelector('.prompt-modal-copy').addEventListener('click', (e) => {
    e.stopPropagation();
    try {
      navigator.clipboard.writeText(promptText || '');
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = orig; }, 1200);
    } catch (_) { /* noop */ }
  });

  document.body.appendChild(overlay);
}

// 이미지 라이트박스 모달 — 외부 영역(오버레이) 클릭으로 닫기. ESC 키로도 닫기.
function openImageLightbox(url, alt) {
  // 기존 모달이 있으면 제거
  const old = document.getElementById('img-modal-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.className = 'img-modal-overlay';
  overlay.id = 'img-modal-overlay';
  overlay.innerHTML = `
    <button type="button" class="img-modal-close" aria-label="닫기">✕</button>
    <img src="${escapeHtml(url)}" alt="${escapeHtml(alt || '')}">
  `;

  const closeFn = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeFn(); };

  // 외부 영역 클릭으로 닫기 (이미지 자체 클릭은 무시)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeFn();
  });
  overlay.querySelector('.img-modal-close').addEventListener('click', closeFn);
  // 이미지 클릭은 닫히지 않게
  const imgEl = overlay.querySelector('img');
  imgEl.addEventListener('click', (e) => { e.stopPropagation(); });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

// 비디오 라이트박스 — 셀 클릭 시 원본 크기 영상 모달.
// - 자동 재생 (muted) + controls 표시
// - 외부 클릭 / ✕ / Esc 로 닫기
// - 닫을 때 video를 pause + src 비워 메모리/네트워크 해제
function openVideoLightbox(url, label) {
  // 기존 모달이 있으면 제거
  const old = document.getElementById('vid-modal-overlay');
  if (old) {
    const oldVid = old.querySelector('video');
    if (oldVid) { try { oldVid.pause(); oldVid.removeAttribute('src'); oldVid.load(); } catch (_) {} }
    old.remove();
  }

  const overlay = document.createElement('div');
  overlay.className = 'img-modal-overlay vid-modal-overlay';
  overlay.id = 'vid-modal-overlay';
  overlay.innerHTML = `
    <button type="button" class="img-modal-close" aria-label="닫기">✕</button>
    ${label ? `<div class="vid-modal-label">${escapeHtml(label)}</div>` : ''}
    <video src="${escapeHtml(url)}" controls autoplay playsinline webkit-playsinline loop></video>
  `;

  const vidEl = overlay.querySelector('video');
  // 셀 미리보기는 muted였지만 라이트박스는 사용자가 원본 그대로 보고 싶을 것이므로
  // 시작은 muted 자동재생 (브라우저 정책) 후 사용자가 controls로 unmute 가능.
  vidEl.muted = true;

  const closeFn = () => {
    try { vidEl.pause(); vidEl.removeAttribute('src'); vidEl.load(); } catch (_) {}
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeFn(); };

  // 외부 영역 클릭으로 닫기 (비디오/라벨/닫기버튼 클릭은 무시)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeFn();
  });
  overlay.querySelector('.img-modal-close').addEventListener('click', closeFn);
  vidEl.addEventListener('click', (e) => { e.stopPropagation(); });
  const lbl = overlay.querySelector('.vid-modal-label');
  if (lbl) lbl.addEventListener('click', (e) => { e.stopPropagation(); });

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

// 비디오 배틀 — 셀들의 <video>를 동시에 재생/일시정지.
// scope: 'all'  → 전체 그리드 (기존 헤더 버튼)
//        Element → 특정 라운드 grid (새 라운드별 버튼)
//
// 버벅임 해결: 12개를 동시에 play()하면 모든 비디오가 동시에 다운로드 시작
// → 디코더/네트워크 폭주 → stall 반복. 그래서 재생 직전에 preload='auto'로
// 바꿔서 canplaythrough 이벤트를 기다린 뒤 한꺼번에 play()를 시작한다.
// 또 muted + playsinline은 자동재생 정책상 필수.
async function playAllBattleVideos(scope) {
  const root = (scope instanceof Element)
    ? scope
    : document.getElementById('video-battle-results');
  if (!root) return;
  const vids = Array.from(root.querySelectorAll('video'));
  if (!vids.length) return;

  // 토글: 하나라도 재생 중이면 전체 일시정지.
  const anyPlaying = vids.some(v => !v.paused && !v.ended);
  if (anyPlaying) {
    vids.forEach(v => { try { v.pause(); } catch (_) {} });
    _setPlayAllBtnState(root, false);
    return;
  }

  // 재생 시작 — 먼저 버튼 라벨을 로딩으로
  _setPlayAllBtnState(root, 'loading');

  // 1) 모든 비디오를 buffering 단계까지 끌어올린다 (병렬, 그러나 play()는 안 함).
  //    canplaythrough 이벤트를 6초 timeout으로 wait — 너무 느린 비디오는 그냥 진행.
  const buffered = vids.map(v => new Promise(resolve => {
    try {
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.preload = 'auto';
      v.currentTime = 0;
    } catch (_) {}

    if (v.readyState >= 3 /* HAVE_FUTURE_DATA */) { resolve(); return; }

    let done = false;
    const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
    const onCan = () => finish();
    const onErr = () => finish();
    const cleanup = () => {
      v.removeEventListener('canplaythrough', onCan);
      v.removeEventListener('canplay', onCan);
      v.removeEventListener('error', onErr);
    };
    v.addEventListener('canplaythrough', onCan, { once: true });
    v.addEventListener('canplay', onCan, { once: true });
    v.addEventListener('error', onErr, { once: true });

    // 6초 후엔 그냥 진행 — 너무 느린 비디오로 전체가 멈추지 않게.
    setTimeout(finish, 6000);

    // load() 호출로 buffering 트리거
    try { v.load(); } catch (_) {}
  }));

  await Promise.all(buffered);

  // 2) 일제히 play() — 이미 buffer가 차 있어서 stall 가능성이 크게 줄어듦.
  vids.forEach(v => {
    try {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) {}
  });

  _setPlayAllBtnState(root, true);
}

// Play All 버튼 상태 갱신 헬퍼.
// state: true = playing, false = paused, 'loading' = 버퍼링 중
function _setPlayAllBtnState(root, state) {
  // 라운드 헤더 안의 버튼 또는 전역 버튼.
  let btn = null;
  let isGlobal = false;
  if (root && root.classList && root.classList.contains('battle-round-grid')) {
    const head = root.parentElement && root.parentElement.querySelector('.battle-round-head');
    btn = head && head.querySelector('.round-playall');
  } else {
    btn = document.getElementById('video-battle-playall');
    isGlobal = true;
  }
  if (!btn) return;
  if (state === 'loading') {
    btn.textContent = '… buffering';
    btn.classList.remove('is-playing');
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  if (state) {
    btn.textContent = isGlobal ? '⏸ Pause All Rounds' : '⏸ Pause All';
    btn.classList.add('is-playing');
  } else {
    btn.textContent = isGlobal ? '▶ Play All Rounds' : '▶ Play All';
    btn.classList.remove('is-playing');
  }
}

// 이미지 배틀 셀 — 로드 완료 후 본문 스크롤을 가운데로 이동
function _centerBattleCellScroll(imgEl) {
  if (!imgEl) return;
  const body = imgEl.closest('.battle-cell-body');
  if (!body) return;
  // 셀이 화면에 그려진 후 정확한 scrollHeight 측정 가능
  requestAnimationFrame(() => {
    const max = body.scrollHeight - body.clientHeight;
    if (max > 0) body.scrollTop = max / 2;
  });
}

// 비디오 배틀 셀 — 단일 클릭으로 그 셀만 재생/일시정지 토글.
// (더블클릭으로 fullscreen 진입과 충돌하지 않도록 약간의 지연을 줌.)
let _singleClickTimer = null;
function _battleVideoToggleOne(bodyEl, ev) {
  // 더블클릭의 첫 클릭이면 무시 — dblclick 핸들러가 처리
  if (_singleClickTimer) {
    clearTimeout(_singleClickTimer);
    _singleClickTimer = null;
    return;
  }
  _singleClickTimer = setTimeout(() => {
    _singleClickTimer = null;
    const v = bodyEl && bodyEl.querySelector('video');
    if (!v) return;
    try {
      v.muted = true; v.loop = true;
      if (v.paused) {
        v.preload = 'auto';
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else {
        v.pause();
      }
    } catch (_) {}
  }, 220);  // dblclick threshold
}

// 비디오 배틀 셀 — 더블클릭 시 fullscreen + controls 활성화 (개별 재생 가능)
function _battleVideoFullscreen(bodyEl) {
  if (!bodyEl) return;
  const v = bodyEl.querySelector('video');
  if (!v) return;
  // controls는 fullscreen일 때만 보이게 — 빠져나오면 다시 숨김
  v.setAttribute('controls', '');
  const onFsChange = () => {
    const isFs = document.fullscreenElement === v
              || document.webkitFullscreenElement === v;
    if (!isFs) {
      v.removeAttribute('controls');
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    }
  };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);
  try {
    if (v.requestFullscreen) v.requestFullscreen();
    else if (v.webkitRequestFullscreen) v.webkitRequestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS Safari
  } catch (_) { /* noop */ }
}

// 라운드 그룹 element 생성 — battle-grid에 append, 셀들이 들어갈 grid 컨테이너 반환
function _createBattleRound(kind, prompt, engineCount) {
  const wrap = document.getElementById(
    kind === 'image' ? 'image-battle-results' : 'video-battle-results'
  );
  // empty 상태 표시 제거
  const empty = document.getElementById(
    kind === 'image' ? 'image-battle-empty' : 'video-battle-empty'
  );
  if (empty) empty.style.display = 'none';

  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');

  const round = document.createElement('div');
  round.className = 'battle-round';
  // 비디오 라운드는 헤더에 라운드 전용 "Play All" 버튼을 추가
  // (이 라운드의 비디오들만 동시에 재생 — 다른 라운드는 영향 없음).
  const playAllBtn = (kind === 'video')
    ? `<button type="button" class="round-playall" title="이 세션의 영상만 동시에 재생">▶ Play All</button>`
    : '';
  round.innerHTML = `
    <div class="battle-round-head">
      <span class="battle-round-time">${hh}:${mm}:${ss}</span>
      <span class="battle-round-engines">${engineCount} engines</span>
      ${playAllBtn}
    </div>
    <div class="battle-round-grid"></div>
  `;
  wrap.appendChild(round);
  const grid = round.querySelector('.battle-round-grid');
  // 라운드별 Play All 버튼을 grid에 한정해서 동작시킴.
  if (kind === 'video') {
    const btn = round.querySelector('.round-playall');
    if (btn) btn.addEventListener('click', () => playAllBattleVideos(grid));
  }
  // 새 라운드가 보이도록 결과 영역을 가장 아래로 스크롤
  requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; });
  return grid;
}

async function startImageBattle() {
  if (_battleGuard('image')) return;
  const promptEl = document.getElementById('image-battle-prompt');
  const prompt = promptEl.value.trim();
  // Allow ref-image-only (i2i) submissions when at least one ref is attached.
  const hasRefs = (attachedImages['image-battle'] || []).length > 0;
  if (!prompt && !hasRefs) return;
  // 진행 중인 이미지 배틀이 남아있으면 새 라운드 시작 차단
  if (Array.from(_battleInFlight).some(k => k.startsWith('image:'))) return;

  // 사용자가 picker 에서 선택한 엔진만 호출 (비용 절감)
  const engines = _getSelectedBattleEngines('image');
  if (engines.length === 0) {
    flashTopbar && flashTopbar('Image Battle: 엔진을 1개 이상 선택해 주세요');
    return;
  }

  // 새 라운드 그룹 생성 — 이전 라운드는 그대로 보존
  const roundGrid = _createBattleRound('image', prompt || '(image-only)', engines.length);

  promptEl.value = '';
  resetAutoResize(promptEl);
  _lockBattleButtons('image');
  // Fire selected engines concurrently — each cell updates independently.
  engines.forEach(e => {
    _runOneBattle('image', e.id, e.label, prompt, roundGrid);
  });
  // Clear attached refs after dispatch — next round starts clean.
  attachedImages['image-battle'] = [];
  renderAttachPreview('image-battle');
  const ibBtn = document.getElementById('imgb-attach-btn');
  if (ibBtn) ibBtn.classList.remove('has-file');
}

async function startVideoBattle() {
  if (_battleGuard('video')) return;
  const promptEl = document.getElementById('video-battle-prompt');
  const prompt = promptEl.value.trim();
  // Allow image-only (i2v) — accept dispatch when prompt is empty as long as
  // a start-frame image is attached. Pure-empty submissions are rejected.
  const hasRefs = (attachedImages['video-battle'] || []).length > 0;
  if (!prompt && !hasRefs) return;
  if (Array.from(_battleInFlight).some(k => k.startsWith('video:'))) return;

  // 사용자가 picker 에서 선택한 엔진만 호출 (비용 절감)
  const engines = _getSelectedBattleEngines('video');
  if (engines.length === 0) {
    flashTopbar && flashTopbar('Video Battle: 엔진을 1개 이상 선택해 주세요');
    return;
  }

  // 사용자가 고른 duration ('5s' / '10s' / 'max') — 엔진별로 _resolveBattleDuration
  // 안에서 engineFeatures.durations 에 맞게 자동 클램프된다.
  const durChip = document.querySelector(
    '#video-battle-duration-chips .duration-chip.active'
  );
  const requestedDuration = (durChip && durChip.dataset.value) || '5s';

  const roundGrid = _createBattleRound('video', prompt || '(image-only)', engines.length);

  promptEl.value = '';
  resetAutoResize(promptEl);
  _lockBattleButtons('video');
  engines.forEach(e => {
    _runOneBattle('video', e.id, e.label, prompt, roundGrid, { duration: requestedDuration });
  });
  // Clear attached start-frames after dispatch.
  attachedImages['video-battle'] = [];
  renderAttachPreview('video-battle');
  const vbBtn = document.getElementById('vidb-attach-btn');
  if (vbBtn) vbBtn.classList.remove('has-file');
}

/**
 * Resolve the per-engine duration for a Video Battle cell.
 *
 * Each engine declares its supported durations in `engineFeatures` (e.g.
 * ['5s','10s'] for Kling, ['4s','8s'] for Vidu, ['8s'] only for GV3.1, etc.).
 * The user's requested value may not be supported by every engine, so we
 * clamp:
 *   - 'max'      → pick the engine's longest supported duration
 *   - exact hit  → use as-is
 *   - 같은 값 X  → pick the engine's longest supported value that is ≤ req,
 *                  falling back to the shortest if nothing fits.
 *
 * Always returns a string like '5s'. Backend parses '5s' → 5.
 */
function _resolveBattleDuration(engine, requested) {
  const feat = (typeof engineFeatures !== 'undefined' && engineFeatures[engine]) || {};
  const supported = Array.isArray(feat.durations) && feat.durations.length
    ? feat.durations.slice()
    : ['5s'];
  // Parse 'Ns' → N for numeric comparison.
  const toSec = (s) => parseInt(String(s).replace(/s$/i, ''), 10) || 0;
  supported.sort((a, b) => toSec(a) - toSec(b));

  const longest  = supported[supported.length - 1];
  const shortest = supported[0];

  if (!requested || requested === 'max') return longest;
  if (supported.includes(requested))     return requested;

  // 사용자 요청을 초과하지 않는 가장 긴 값을 선택. 모두 더 길면 shortest.
  const reqSec = toSec(requested);
  let best = null;
  for (const v of supported) {
    if (toSec(v) <= reqSec) best = v;
  }
  return best || shortest;
}

// =================================================================
//  History — single-mode (image/video gen) save handler + restorers
// =================================================================
async function _singleSaveFromBtn(ev, btnEl) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  if (!btnEl || !window.AigcHistory) return;
  const hid = btnEl.getAttribute('data-hid');
  if (!hid) return;
  if (btnEl.classList.contains('is-saved')) return;
  btnEl.disabled = true;
  const orig = btnEl.textContent;
  btnEl.textContent = '⏳ Saving…';
  try {
    await window.AigcHistory.saveToPermanent(hid);
    btnEl.classList.add('is-saved');
    btnEl.textContent = '✓ Saved';
    btnEl.title = '영구 저장 완료';
  } catch (e) {
    btnEl.disabled = false;
    btnEl.textContent = orig;
    btnEl.title = 'Save 실패: ' + (e && e.message || e);
  }
}

function _restoreSingleImage(entry) {
  const c = document.getElementById('image-results');
  if (!c) return;
  const empty = document.getElementById('image-empty');
  if (empty) empty.style.display = 'none';
  const url = window.AigcHistory.pickUrl(entry);
  const expired = window.AigcHistory.isExpired(entry);
  const card = document.createElement('div');
  card.className = 'result-card restored';
  card.dataset.historyId = entry.id;
  const saveBtn = '';  /* (Removed) 'Save to Gallery' button — gallery feature removed */
  card.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot ${expired ? 'error' : 'success'}"></span>
        <span style="font-size:13px; font-weight:600;">${expired ? '⟲ Restored (may be expired)' : '⟲ Restored'}</span>
      </div>
      <div class="result-card-info">
        <span class="info-tag engine">${escapeHtml(entry.engine || '')}</span>
        ${saveBtn}
      </div>
    </div>
    <div class="result-card-body">
      <img class="result-image" src="${escapeHtml(url)}" alt="restored" onerror="this.outerHTML='<div class=\\'error-msg\\'>이미지 URL 만료 — Gallery 저장 항목만 영구 보존됩니다.</div>'">
      <div class="result-prompt">${escapeHtml(entry.prompt || '')}</div>
    </div>`;
  c.appendChild(card);
}

function _restoreSingleVideo(entry) {
  const c = document.getElementById('video-results');
  if (!c) return;
  const empty = document.getElementById('video-empty');
  if (empty) empty.style.display = 'none';
  const url = window.AigcHistory.pickUrl(entry);
  const expired = window.AigcHistory.isExpired(entry);
  const card = document.createElement('div');
  card.className = 'result-card restored';
  card.dataset.historyId = entry.id;
  const saveBtn = '';  /* (Removed) 'Save to Gallery' button — gallery feature removed */
  card.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot ${expired ? 'error' : 'success'}"></span>
        <span style="font-size:13px; font-weight:600;">${expired ? '⟲ Restored (may be expired)' : '⟲ Restored'}</span>
      </div>
      <div class="result-card-info">
        <span class="info-tag engine">${escapeHtml(entry.engine || '')}</span>
        ${saveBtn}
      </div>
    </div>
    <div class="result-card-body">
      <video class="result-video" controls autoplay loop muted playsinline src="${escapeHtml(url)}" onerror="this.outerHTML='<div class=\\'error-msg\\'>영상 URL 만료 — Gallery 저장 항목만 영구 보존됩니다.</div>'"></video>
      <div class="result-prompt">${escapeHtml(entry.prompt || '')}</div>
    </div>`;
  c.appendChild(card);
}

// Register restorers + run restore once history module is ready.
document.addEventListener('aigc-history-ready', () => {
  if (!window.AigcHistory) return;
  window.AigcHistory.registerRestorer('image',         _restoreSingleImage);
  window.AigcHistory.registerRestorer('video',         _restoreSingleVideo);
  window.AigcHistory.registerRestorer('image-battle',  _restoreBattleEntry);
  window.AigcHistory.registerRestorer('video-battle',  _restoreBattleEntry);
  // Forge restorers register themselves in forge.js (separately).
  // Run restore last so all kinds are mapped.
  setTimeout(() => { try { window.AigcHistory.restoreAll(); } catch (_) {} }, 0);
});

// =====================================================================
// (Removed) Gallery showcase
// ---------------------------------------------------------------------
// The full Playground had a server-backed Gallery (/api/gallery/*) that
// persisted picks to COS + CDN. This reference build is a stateless test
// page, so the Gallery view and all its client code were removed.
// =====================================================================
