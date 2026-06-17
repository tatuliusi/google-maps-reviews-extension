/**
 * content.js — Google Maps Reviews Extractor
 * Injects a floating panel, crawls the reviews list, and downloads a JSON file.
 */

'use strict';

// ─── Module state ─────────────────────────────────────────────────────────────
let _state  = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
let _shadow = null;

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(level, ...args) {
  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
    '[MapsReviews]', ...args
  );
}

// ─── Panel CSS ────────────────────────────────────────────────────────────────
function buildCSS() {
  return `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    #panel {
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
function buildHTML() {
  return `
    <div id="panel">
      <div id="header">
        <span id="title">Maps Reviews Extractor</span>
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
function injectPanel() {
  const host = document.createElement('div');
  host.id = 'maps-reviews-extractor-host';
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = buildCSS();
  shadow.appendChild(style);

  const wrapper = document.createElement('div');
  wrapper.innerHTML = buildHTML().trim();
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

// ─── Business / DOM helpers ───────────────────────────────────────────────────
function getBusinessName() {
  return (
    document.querySelector('h1.DUwDvf')?.textContent?.trim()
    || document.querySelector('[data-item-id] h1')?.textContent?.trim()
    || document.querySelector('h1')?.textContent?.trim()
    || 'business'
  );
}

/**
 * Walk up from the first [data-review-id] element to find the scrollable
 * container that holds all review cards.
 */
async function findReviewsContainer() {
  let review;
  try {
    review = await waitForElement('[data-review-id]', 15000);
  } catch {
    return null;
  }

  let el = review.parentElement;
  while (el && el !== document.body) {
    const ov = window.getComputedStyle(el).overflowY;
    if (ov === 'auto' || ov === 'scroll') return el;
    el = el.parentElement;
  }

  return document.querySelector('[role="feed"]') || null;
}

/**
 * Open the sort menu and click "Newest". Returns true on success.
 * Fails gracefully — crawl continues even without sorting.
 */
async function sortByNewest() {
  const allButtons = Array.from(
    document.querySelectorAll('button, [role="button"]')
  );

  const sortBtn = document.querySelector('[data-value="sort"]')
    || allButtons.find(el => {
        const label = (
          el.getAttribute('aria-label') || el.textContent || ''
        ).toLowerCase().trim();
        return label === 'sort' || label === 'sort reviews';
      });

  if (!sortBtn) return false;

  sortBtn.click();
  await sleep(700);

  const menuItems = Array.from(
    document.querySelectorAll('[role="menuitem"], [role="option"], [role="radio"]')
  );
  const newestOpt = menuItems.find(el => /newest/i.test(el.textContent));

  if (!newestOpt) {
    document.body.click(); // close menu
    return false;
  }

  newestOpt.click();
  await sleep(1500);
  return true;
}

// ─── Review extraction ────────────────────────────────────────────────────────
function extractStars(el) {
  const starEl =
    el.querySelector('[aria-label*="star"]')
    || el.querySelector('span[role="img"][aria-label]');
  if (!starEl) return null;
  const m = (starEl.getAttribute('aria-label') || '').match(/(\d)/);
  return m ? parseInt(m[1], 10) : null;
}

function extractReviewer(el) {
  // Google Maps links reviewer names to their contribution profile
  const profileLink = el.querySelector('a[href*="/maps/contrib/"]');
  if (profileLink) {
    const nameEl = profileLink.querySelector('div, span');
    const name = nameEl?.textContent?.trim() || profileLink.textContent.trim();
    if (name) return name;
  }
  // Fallback to known obfuscated class (degrades if Maps changes it)
  return el.querySelector('.d4r55')?.textContent?.trim() || null;
}

function extractDateText(el) {
  // Try the known class first
  const knownEl = el.querySelector('.rsqaWe');
  if (knownEl && isRelativeDate(knownEl.textContent)) {
    return knownEl.textContent.trim();
  }
  // Walk all inline elements for relative date text
  for (const child of el.querySelectorAll('span, div')) {
    const t = child.textContent.trim();
    // Avoid matching whole-review text blobs by checking length
    if (t.length < 40 && isRelativeDate(t)) return t;
  }
  return null;
}

function extractReviewText(el) {
  // Google Maps uses data-expandable-section or jsname="bN97Pc" for the full text
  const knownEl =
    el.querySelector('[jsname="bN97Pc"]')
    || el.querySelector('[class*="wiI7pd"]');
  if (knownEl) return knownEl.textContent.trim() || null;

  // Fallback: longest span that is not a relative date and has real length
  let best = '';
  for (const span of el.querySelectorAll('span')) {
    const t = span.textContent.trim();
    if (!isRelativeDate(t) && t.length > best.length && t.length > 20) best = t;
  }
  return best || null;
}

function extractReview(el) {
  return {
    id:         el.getAttribute('data-review-id'),
    reviewer:   extractReviewer(el),
    stars:      extractStars(el),
    dateText:   extractDateText(el),
    reviewText: extractReviewText(el),
  };
}

// ─── Download ─────────────────────────────────────────────────────────────────
function downloadJSON(reviews) {
  const rawName = getBusinessName().replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  const dateSuffix = new Date().toISOString().slice(0, 10);
  const filename = `${rawName}_reviews_${dateSuffix}.json`;

  const blob = new Blob([JSON.stringify(reviews, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  log('info', `Downloaded ${reviews.length} reviews as ${filename}`);
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

  const fromDate = new Date(fromVal);
  const toDate   = new Date(toVal);
  toDate.setHours(23, 59, 59, 999);

  const reviews = [];
  const seenIds = new Set();
  let seenTooNew        = false;
  let consecutiveTooOld = 0;
  let emptyScrolls      = 0;

  // Step 1 — sort by newest
  setStatus('Sorting reviews by newest…');
  const sorted = await sortByNewest();
  if (!sorted) log('warn', 'Sort by newest failed — proceeding without sorting');

  // Step 2 — locate the scrollable reviews pane
  setStatus('Locating reviews pane…');
  const container = await findReviewsContainer();
  if (!container) {
    setStatus('Reviews pane not found. Open a business page first.');
    _state = 'idle';
    setButtons('idle');
    return;
  }

  setStatus('Crawling…');

  crawlLoop: while (_state === 'running') {
    const reviewEls = document.querySelectorAll('[data-review-id]');
    let newFound = 0;

    for (const el of reviewEls) {
      if (_state !== 'running') break crawlLoop;

      const id = el.getAttribute('data-review-id');
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newFound++;

      const review = extractReview(el);
      const date   = parseRelativeDate(review.dateText);

      if (date && date > toDate) {
        // Review is newer than our range — keep scrolling
        seenTooNew = true;
        consecutiveTooOld = 0;
      } else if (date && date < fromDate) {
        // Review is older than our range
        consecutiveTooOld++;
        if (consecutiveTooOld >= MAX_CONSECUTIVE_TOO_OLD && (seenTooNew || reviews.length > 0)) {
          log('info', `Stopping: ${MAX_CONSECUTIVE_TOO_OLD} consecutive reviews older than from-date.`);
          break crawlLoop;
        }
      } else {
        // In range (or date is null → conservative include)
        consecutiveTooOld = 0;
        seenTooNew = true;
        reviews.push(review);
        setCount(reviews.length);
      }
    }

    // Scroll container down to load more reviews
    const prevScrollHeight = container.scrollHeight;
    container.scrollTop = container.scrollHeight;
    await sleep(1500);

    if (container.scrollHeight === prevScrollHeight) {
      emptyScrolls++;
      if (emptyScrolls >= MAX_EMPTY_SCROLLS) {
        log('info', 'Reached end of reviews list.');
        break;
      }
    } else {
      emptyScrolls = 0;
    }

    // Honour pause — spin until resumed or stopped
    while (_state === 'paused') await sleep(300);
  }

  const finalState = _state;
  _state = 'idle';
  setButtons('idle');

  const msg = finalState === 'stopped'
    ? `Stopped. ${reviews.length} review${reviews.length === 1 ? '' : 's'} collected.`
    : `Done — ${reviews.length} review${reviews.length === 1 ? '' : 's'} collected.`;
  setStatus(msg);

  if (reviews.length > 0) downloadJSON(reviews);
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

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  if (document.getElementById('maps-reviews-extractor-host')) return;

  const shadow = injectPanel();
  wireButtons(shadow);

  // Default date range: past 30 days → today
  const today = new Date();
  const past30 = new Date(today);
  past30.setDate(past30.getDate() - 30);

  shadow.querySelector('#to-date').value   = today.toISOString().slice(0, 10);
  shadow.querySelector('#from-date').value = past30.toISOString().slice(0, 10);

  log('info', 'Panel injected');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
