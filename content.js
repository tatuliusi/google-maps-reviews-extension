'use strict';

// ─── Module state ─────────────────────────────────────────────────────────────
let _state   = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
let _shadow  = null;
let _lastUrl = location.href;
let _adapter = null;

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(level, ...args) {
  const tag = _adapter ? `[Reviews:${_adapter.name}]` : '[Reviews]';
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](tag, ...args);
}

// ─── Adapter selection ────────────────────────────────────────────────────────
function pickAdapter() {
  const registered = window.REVIEW_ADAPTERS || [];
  for (const a of registered) {
    try {
      if (a.detect()) return a;
    } catch (e) {
      // A bad detect() shouldn't break the whole extension.
      console.warn('[Reviews] adapter detect() threw:', a?.name, e);
    }
  }
  return null;
}

// ─── Panel CSS ────────────────────────────────────────────────────────────────
function buildCSS() {
  return `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    #panel {
      pointer-events: auto;
      position: fixed; top: 80px; right: 16px; z-index: 2147483647;
      width: 272px; background: #fff; border-radius: 8px;
      box-shadow: 0 2px 16px rgba(0,0,0,.28); overflow: hidden;
      font-family: 'Google Sans', Roboto, Arial, sans-serif;
    }
    #header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; background: #4285f4; color: #fff;
      cursor: default; user-select: none;
    }
    #title { font-size: 13px; font-weight: 600; }
    #minimize-btn {
      background: none; border: none; color: #fff;
      font-size: 20px; line-height: 1; cursor: pointer; padding: 0 2px;
    }
    #body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
    #body.hidden { display: none; }
    .field-row { display: flex; align-items: center; gap: 8px; }
    .field-row label {
      width: 32px; font-size: 12px; color: #5f6368; flex-shrink: 0;
    }
    .field-row input[type="date"] {
      flex: 1; border: 1px solid #dadce0; border-radius: 4px;
      padding: 5px 8px; font-size: 12px; outline: none; color: #202124;
    }
    .field-row input[type="date"]:focus { border-color: #4285f4; }
    #btn-row { display: flex; gap: 6px; }
    button {
      flex: 1; padding: 7px 4px; border: none; border-radius: 4px;
      font-size: 12px; font-weight: 600; cursor: pointer;
      transition: opacity .15s;
    }
    button:disabled { opacity: .40; cursor: default; }
    #start-btn { background: #34a853; color: #fff; }
    #pause-btn { background: #fbbc04; color: #222; }
    #stop-btn  { background: #ea4335; color: #fff; }
    #status { font-size: 11px; color: #5f6368; min-height: 15px; }
    #count  { font-size: 12px; color: #202124; font-weight: 600; min-height: 16px; }
  `;
}

// ─── Panel HTML ───────────────────────────────────────────────────────────────
function buildHTML(title) {
  return `
    <div id="panel">
      <div id="header">
        <span id="title">${title}</span>
        <button id="minimize-btn" title="Minimize">−</button>
      </div>
      <div id="body">
        <div class="field-row">
          <label>From</label>
          <input type="date" id="from-date">
        </div>
        <div class="field-row">
          <label>To</label>
          <input type="date" id="to-date">
        </div>
        <div id="btn-row">
          <button id="start-btn">Start</button>
          <button id="pause-btn" disabled>Pause</button>
          <button id="stop-btn"  disabled>Stop</button>
        </div>
        <div id="status">Ready</div>
        <div id="count"></div>
      </div>
    </div>
  `;
}

// ─── Panel lifecycle ──────────────────────────────────────────────────────────
function injectPanel(title) {
  const host = document.createElement('div');
  host.id = 'reviews-extractor-host';
  host.style.cssText = 'position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;overflow:visible!important;z-index:2147483647!important;pointer-events:none!important;';
  document.body.appendChild(host);

  new MutationObserver(() => {
    if (host.inert) {
      host.inert = false;
      log('info', 'Removed inert attribute from panel host');
    }
  }).observe(host, { attributes: true, attributeFilter: ['inert'] });

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = buildCSS();
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = buildHTML(title).trim();
  shadow.appendChild(wrapper.firstElementChild);

  _shadow = shadow;
  return shadow;
}

function setStatus(msg) {
  const el = _shadow?.querySelector('#status');
  if (el) el.textContent = msg;
}

function setCount(n) {
  const el = _shadow?.querySelector('#count');
  if (el) el.textContent = n > 0 ? `${n} review${n === 1 ? '' : 's'} collected` : '';
}

function setButtons(state) {
  const startBtn = _shadow?.querySelector('#start-btn');
  const pauseBtn = _shadow?.querySelector('#pause-btn');
  const stopBtn  = _shadow?.querySelector('#stop-btn');
  if (!startBtn) return;

  if (state === 'running') {
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    stopBtn.disabled  = false;
    startBtn.textContent = 'Start';
  } else if (state === 'paused') {
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled  = false;
    startBtn.textContent = 'Resume';
  } else {
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    stopBtn.disabled  = true;
    startBtn.textContent = 'Start';
  }
}

// ─── Download ─────────────────────────────────────────────────────────────────
function downloadJSON(payload) {
  const rawName = _adapter.getBusinessName().replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  const dateSuffix = localDateStr(new Date());
  const filename = `${rawName}_${_adapter.name}_reviews_${dateSuffix}.json`;

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  log('info', `Downloaded ${payload.totalReviews} reviews as ${filename}`);
}

// ─── Crawl ────────────────────────────────────────────────────────────────────
const MAX_CONSECUTIVE_TOO_OLD = 5;
const MAX_EMPTY_SCROLLS = 6;

async function runCrawl() {
  _state = 'running';
  setButtons('running');
  setCount(0);

  const fromVal = _shadow.querySelector('#from-date').value;
  const toVal   = _shadow.querySelector('#to-date').value;
  if (!fromVal || !toVal) {
    setStatus('Please set both dates.');
    _state = 'idle';
    setButtons('idle');
    return;
  }

  // Append time so the browser parses the date in LOCAL time, not UTC midnight.
  const fromDate = new Date(fromVal + 'T00:00:00');
  const toDate   = new Date(toVal   + 'T23:59:59.999');

  const reviews = [];
  const seenIds = new Set();
  let seenTooNew        = false;
  let consecutiveTooOld = 0;
  let emptyScrolls      = 0;
  let skippedUndated    = 0;

  setStatus('Sorting reviews by newest…');
  let sorted = false;
  try {
    sorted = await _adapter.sortByNewest();
  } catch (e) {
    log('warn', 'sortByNewest threw:', e);
  }
  if (!sorted) {
    log('warn', 'Sort by newest failed — early-stop disabled, will scan full list');
    setStatus('Sort not applied — scanning full list…');
  }

  setStatus('Locating reviews…');
  const container = await _adapter.findReviewsContainer();
  if (!container) {
    setStatus('Reviews not found. Navigate to the reviews section first.');
    _state = 'idle';
    setButtons('idle');
    return;
  }

  setStatus('Crawling…');

  crawlLoop: while (_state === 'running') {
    // Expand truncated reviews before scraping this batch.
    try {
      await _adapter.expandVisibleMoreButtons();
    } catch (e) {
      log('warn', 'expandVisibleMoreButtons threw:', e);
    }

    const reviewEls = _adapter.getReviewElements();
    let newIdsThisIter = 0;

    for (const el of reviewEls) {
      if (_state !== 'running') break crawlLoop;

      let review;
      try {
        review = _adapter.extractReview(el);
      } catch (e) {
        log('warn', 'extractReview threw:', e);
        continue;
      }

      const id = review.id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      newIdsThisIter++;

      // Parse the raw dateText afresh — adapter already stored review.date
      // as a string, but we need the Date object for range comparison.
      const date = parseAnyDate(review.dateText);

      if (date === null) {
        skippedUndated++;
        log('warn', `Skipped review ${id}: date text not recognised (dateText=${JSON.stringify(review.dateText)})`);
      } else if (date > toDate) {
        log('info', `Skipped (too new): ${review.reviewer || '?'} — dateText=${JSON.stringify(review.dateText)}, parsed=${review.date}`);
        seenTooNew = true;
        consecutiveTooOld = 0;
      } else if (date < fromDate) {
        log('info', `Skipped (too old): ${review.reviewer || '?'} — dateText=${JSON.stringify(review.dateText)}, parsed=${review.date}`);
        consecutiveTooOld++;
        if (sorted && consecutiveTooOld >= MAX_CONSECUTIVE_TOO_OLD && (seenTooNew || reviews.length > 0)) {
          log('info', `Stopping: ${MAX_CONSECUTIVE_TOO_OLD} consecutive reviews older than from-date.`);
          break crawlLoop;
        }
      } else {
        log('info', `Collected: ${review.reviewer || '?'} — dateText=${JSON.stringify(review.dateText)}, parsed=${review.date}`);
        consecutiveTooOld = 0;
        seenTooNew = true;
        reviews.push(review);
        setCount(reviews.length);
      }
    }

    // Safeguard: if the DOM has cards but we didn't add any NEW ids this
    // iteration, the page didn't actually turn. Treat as stalled instead
    // of advancing again — otherwise we'd click "next" repeatedly and
    // skip whole pages of reviews.
    if (reviewEls.length > 0 && newIdsThisIter === 0) {
      emptyScrolls++;
      if (emptyScrolls >= MAX_EMPTY_SCROLLS) {
        log('info', 'No new reviews after several attempts — stopping.');
        break;
      }
      await sleep(1000);
      continue;
    }

    // Ask the adapter to advance (scroll / next-page / show-more).
    let progress;
    try {
      progress = await _adapter.advance(container);
    } catch (e) {
      log('warn', 'advance threw:', e);
      progress = 'stalled';
    }

    if (progress === 'stalled') {
      emptyScrolls++;
      if (emptyScrolls >= MAX_EMPTY_SCROLLS) {
        log('info', 'Reached end of reviews list.');
        break;
      }
    } else {
      emptyScrolls = 0;
    }

    while (_state === 'paused') await sleep(300);
  }

  const finalState = _state;
  _state = 'idle';
  setButtons('idle');

  const suffix = skippedUndated > 0 ? ` (${skippedUndated} skipped — date unreadable)` : '';
  const msg = finalState === 'stopped'
    ? `Stopped. ${reviews.length} review${reviews.length === 1 ? '' : 's'} collected.${suffix}`
    : `Done — ${reviews.length} review${reviews.length === 1 ? '' : 's'} collected.${suffix}`;
  setStatus(msg);

  if (reviews.length > 0) {
    downloadJSON({
      source:          _adapter.name,
      business:        _adapter.getBusinessName(),
      url:             location.href,
      dateRange:       { from: fromVal, to: toVal },
      extractedAt:     new Date().toISOString(),
      totalReviews:    reviews.length,
      skippedUndated,
      reviews,
    });
  }
}

// ─── Button wiring ────────────────────────────────────────────────────────────
function wireButtons(shadow) {
  shadow.querySelector('#start-btn').addEventListener('click', () => {
    if (_state === 'idle') {
      runCrawl();
    } else if (_state === 'paused') {
      _state = 'running';
      setButtons('running');
      setStatus('Resumed…');
    }
  });

  shadow.querySelector('#pause-btn').addEventListener('click', () => {
    if (_state === 'running') {
      _state = 'paused';
      setButtons('paused');
      setStatus('Paused.');
    }
  });

  shadow.querySelector('#stop-btn').addEventListener('click', () => {
    _state = 'stopped';
    setStatus('Stopping…');
  });

  shadow.querySelector('#minimize-btn').addEventListener('click', () => {
    const body = shadow.querySelector('#body');
    const btn  = shadow.querySelector('#minimize-btn');
    const isHidden = body.classList.toggle('hidden');
    btn.textContent = isHidden ? '+' : '−';
  });
}

// ─── Extension icon toggle ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'toggle-panel') return;
  const host = document.getElementById('reviews-extractor-host');
  if (!host || !_shadow?.host?.isConnected) {
    if (host) host.remove();
    _shadow = null;
    init();
  } else {
    host.inert = false;
    const panel = _shadow.querySelector('#panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }
});

// ─── SPA navigation guard ─────────────────────────────────────────────────────
// Maps and TripAdvisor/Expedia are SPAs; content scripts don't re-run on
// in-app navigation. Re-init the panel after URL changes.
function watchForNavigation() {
  setInterval(() => {
    if (location.href === _lastUrl) return;
    _lastUrl = location.href;
    setTimeout(() => {
      if (!document.getElementById('reviews-extractor-host')) init();
    }, 2000);
  }, 1000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  _adapter = pickAdapter();
  if (!_adapter) {
    console.warn('[Reviews] No adapter matched this URL — panel not injected.');
    return;
  }

  const existingHost = document.getElementById('reviews-extractor-host');
  if (existingHost && _shadow) return;
  // Stale host from a previous injection — remove so we can wire fresh listeners.
  if (existingHost) existingHost.remove();

  const shadow = injectPanel(_adapter.label || 'Reviews Extractor');
  wireButtons(shadow);

  const today        = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

  shadow.querySelector('#to-date').value   = localDateStr(today);
  shadow.querySelector('#from-date').value = localDateStr(firstOfMonth);

  log('info', 'Panel injected');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { init(); watchForNavigation(); });
} else {
  init();
  watchForNavigation();
}
