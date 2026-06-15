// =============================================
//  Async progress helpers (shared by image / video)
//  - Polls /api/{kind}/status until DONE / FAIL / timeout
//  - Renders elapsed time, progress bar, stage messages
//  - Handles RequestLimitExceeded with automatic backoff retries
//  - Supports parallel requests via per-card AbortController
// =============================================

// Per-engine average completion time (seconds). Used to drive the progress
// bar when the backend doesn't expose a real progress value (MPS doesn't).
const ENGINE_AVG_SEC = {
  // Image
  gem31: 22, gem30: 22, gem25: 18,
  hunyuan30: 30, hunyuan: 30,
  qwen0925: 20, qwen: 20,
  seedream40: 28, seedream45: 32, seedream50lite: 28,
  jimeng_img_40: 25, mjv7: 35, viduq2_img: 24,
  kling_img_30: 30, kling_img_30o: 30, kling_img_o1: 28, kling_img_21: 26,
  og_img_low: 18, og_img_medium: 24, og_img_high: 32,
  // Video
  kling30omni: 120, kling30: 120, kling21: 100, kling20: 100, kling16: 100,
  vidu_q1: 90, vidu_q2: 110,
  hailuo: 130, hailuo_pro: 140,
  hunyuan_video: 120, hunyuan_video2: 120,
  jimeng_vid_30: 110, jimeng_vid: 100,
  veo3_fast: 90, veo3: 150, veo: 120,
  seedance_lite: 80, seedance_pro: 110,
  mj_video: 130,
  default: 60,
};

const STAGE_MESSAGES = [
  { until: 0.10, text: '준비 중…' },
  { until: 0.35, text: '모델이 그리는 중…' },
  { until: 0.65, text: '디테일을 다듬는 중…' },
  { until: 0.90, text: '거의 다 됐어요…' },
  { until: 99,   text: '마무리 중…' },
];
function pickStage(ratio) {
  for (const s of STAGE_MESSAGES) if (ratio < s.until) return s.text;
  return '마무리 중…';
}

// Map<cardId, AbortController> — exposed globally so the Stop (✕) button
// in each progress card can abort its own request without leaking refs.
window.__aigcAbortMap = window.__aigcAbortMap || new Map();

window.cancelAigcCard = function(cardId) {
  const ctl = window.__aigcAbortMap.get(cardId);
  if (ctl) {
    try { ctl.abort(); } catch (_) {}
    window.__aigcAbortMap.delete(cardId);
  }
};

/**
 * Run an async generation flow with polling + automatic concurrency retries.
 *
 * @param {object} opts
 *   kind        : 'image' | 'video'
 *   payload     : POST body for /api/{kind}/start
 *   engine      : engine id
 *   prompt      : user prompt (for re-rendering)
 *   meta        : extra info-tags HTML
 *   abortCtl    : AbortController instance (used to cancel polling)
 *   cardId      : DOM id of the in-progress result card
 *   onSuccess   : ({task_id, image_url|video_url, ...}) => HTML
 *   onError     : (errMsg) => HTML
 */
async function runAigcWithProgress(opts) {
  const {
    kind, payload, engine, prompt, meta, abortCtl, cardId, onSuccess, onError,
  } = opts;
  const avgSec = ENGINE_AVG_SEC[engine] || ENGINE_AVG_SEC.default;
  const startUrl  = `/api/${kind}/start`;
  const statusUrl = `/api/${kind}/status`;

  // Register controller so the per-card ✕ button can find it
  window.__aigcAbortMap.set(cardId, abortCtl);

  // ---- Phase 1: create task (with auto-retry on RequestLimitExceeded) ----
  let taskId = null, startResp = null;
  const RETRY_DELAYS = [5000, 10000, 20000];
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (abortCtl.signal.aborted) { window.__aigcAbortMap.delete(cardId); return; }
    try {
      const r = await fetch(startUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortCtl.signal,
      });
      const j = await r.json();
      if (r.status === 503 && j && j.code === 'RequestLimitExceeded' && attempt < RETRY_DELAYS.length) {
        const wait = RETRY_DELAYS[attempt];
        renderRetrying(cardId, engine, meta, prompt, attempt + 1, RETRY_DELAYS.length, Math.ceil(wait / 1000));
        await sleep(wait, abortCtl.signal);
        continue;
      }
      if (!r.ok || j.error) {
        document.getElementById(cardId).innerHTML = onError(j.error || `HTTP ${r.status}`);
        window.__aigcAbortMap.delete(cardId);
        return;
      }
      taskId = j.task_id;
      startResp = j;
      break;
    } catch (e) {
      if (e.name === 'AbortError') { window.__aigcAbortMap.delete(cardId); return; }
      if (attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt], abortCtl.signal);
        continue;
      }
      document.getElementById(cardId).innerHTML = onError(`Network error: ${e.message}`);
      window.__aigcAbortMap.delete(cardId);
      return;
    }
  }
  if (!taskId) { window.__aigcAbortMap.delete(cardId); return; }

  // ---- Phase 2: progress UI tick + status poll ----
  const startedAt = Date.now();
  let lastStatus = 'PROCESSING';
  let lastErrorMsg = '';
  let pollInFlight = false;

  function tick() {
    const elapsed = (Date.now() - startedAt) / 1000;
    const ratio = Math.min(0.92, 1 - Math.exp(-elapsed / avgSec));
    renderProgress(cardId, engine, meta, prompt, {
      elapsedSec: elapsed,
      avgSec,
      ratio,
      stage: pickStage(elapsed / avgSec),
    });
  }
  const tickHandle = setInterval(tick, 200);
  tick();

  let result = null;
  let pollHandle = null;
  await new Promise((resolve) => {
    pollHandle = setInterval(async () => {
      if (abortCtl.signal.aborted) return;
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const r = await fetch(`${statusUrl}?task_id=${encodeURIComponent(taskId)}`,
                              { signal: abortCtl.signal });
        const j = await r.json();
        if (j.error) { lastErrorMsg = j.error; lastStatus = 'FAIL'; resolve(); return; }
        lastStatus = j.status || 'PROCESSING';
        if (lastStatus === 'DONE') { result = j; resolve(); return; }
        if (lastStatus === 'FAIL' || lastStatus === 'FAILED') {
          lastErrorMsg = j.message || 'Generation failed';
          resolve(); return;
        }
      } catch (e) {
        if (e.name === 'AbortError') { resolve(); return; }
      } finally {
        pollInFlight = false;
      }
    }, 1500);
    const safety = setTimeout(() => { lastStatus = 'TIMEOUT'; resolve(); }, 10 * 60 * 1000);
    abortCtl.signal.addEventListener('abort', () => { clearTimeout(safety); resolve(); });
  });
  clearInterval(pollHandle);
  clearInterval(tickHandle);
  window.__aigcAbortMap.delete(cardId);

  if (abortCtl.signal.aborted) {
    // Render a friendly cancelled card instead of leaving last progress frame
    const card = document.getElementById(cardId);
    if (card) {
      card.innerHTML = `
        <div class="result-card-header">
          <div class="result-card-status">
            <span class="status-dot" style="background:#888"></span>
            <span style="font-size:13px; font-weight:600;">중단됨</span>
          </div>
          <div class="result-card-info">${meta}</div>
        </div>
        <div class="result-card-body">
          <div class="result-prompt">${escapeHtml(prompt)}</div>
        </div>
      `;
    }
    return;
  }

  // ---- Phase 3: final render ----
  const card = document.getElementById(cardId);
  if (!card) return;
  if (lastStatus === 'DONE' && result) {
    card.innerHTML = onSuccess({ ...startResp, ...result });
  } else if (lastStatus === 'TIMEOUT') {
    card.innerHTML = onError('생성 시간이 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도해 주세요.');
  } else {
    card.innerHTML = onError(lastErrorMsg || '알 수 없는 오류');
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); });
  });
}

// Cancel button shown in the progress card header (per-card)
function cancelBtnHtml(cardId) {
  return `
    <button class="aigc-cancel-btn" title="이 요청 중단"
            onclick="cancelAigcCard('${cardId}')">✕</button>
  `;
}

function renderProgress(cardId, engine, metaHtml, prompt, p) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const pct = Math.round(p.ratio * 100);
  const elapsed = Math.round(p.elapsedSec);
  const remaining = Math.max(0, Math.round(p.avgSec - p.elapsedSec));
  card.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot processing"></span>
        <span style="font-size:13px; font-weight:600;">${escapeHtml(p.stage)}</span>
      </div>
      <div class="result-card-info">
        ${metaHtml}
        ${cancelBtnHtml(cardId)}
      </div>
    </div>
    <div class="result-card-body">
      <div class="result-prompt">${escapeHtml(prompt)}</div>
      <div class="aigc-progress">
        <div class="aigc-progress-bar"><div class="aigc-progress-fill" style="width:${pct}%"></div></div>
        <div class="aigc-progress-meta">
          <span>${pct}%</span>
          <span>·</span>
          <span>${elapsed}s 경과</span>
          <span>·</span>
          <span>예상 약 ${p.avgSec}s ${remaining > 0 ? `(남은 ${remaining}s)` : ''}</span>
        </div>
      </div>
    </div>
  `;
}

function renderRetrying(cardId, engine, metaHtml, prompt, attempt, total, waitSec) {
  const card = document.getElementById(cardId);
  if (!card) return;
  card.innerHTML = `
    <div class="result-card-header">
      <div class="result-card-status">
        <span class="status-dot processing"></span>
        <span style="font-size:13px; font-weight:600;">대기 중… (요청이 몰려서 잠시 기다리는 중)</span>
      </div>
      <div class="result-card-info">
        ${metaHtml}
        ${cancelBtnHtml(cardId)}
      </div>
    </div>
    <div class="result-card-body">
      <div class="result-prompt">${escapeHtml(prompt)}</div>
      <div class="aigc-retry-notice">
        ⏳ ${waitSec}초 후 자동 재시도합니다 (${attempt}/${total})
      </div>
    </div>
  `;
}
