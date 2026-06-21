'use strict';

// ─── Module state ─────────────────────────────────────────────────────────────
let _state   = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
let _shadow  = null;
let _lastUrl = location.href;

// ─── Logging ──────────────────────────────────────────────────────────────────
function log(level, ...args) {
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
  // Confirmed from HTML: Maps has NO <h1>. Name is in aria-label on role="main",
  // and as the first part of <title> ("Radio City - Google Maps").
  return (
    document.querySelector('[role="main"]')?.getAttribute('aria-label')?.trim()
    || document.querySelector('h1.DUwDvf')?.textContent?.trim()
    || document.querySelector('h1')?.textContent?.trim()
    || document.title.split(' - ')[0].trim()
    || 'unknown'
  );
}

// Confirmed from HTML: role="feed" does NOT exist in Maps.
// The scrollable pane is .m6QErb[tabindex] or found via overflow walk-up.
async function findReviewsContainer() {
  // Strategy 1: confirmed tabindex scrollable pane (seen in real Maps HTML)
  const tabPane = document.querySelector('.m6QErb[tabindex]');
  if (tabPane) return tabPane;

  // Strategy 2: walk up from a review card looking for scrollable ancestor
  let review;
  try {
    review = await waitForElement('.jftiEf[data-review-id]', 15000);
  } catch {
    return null;
  }

  let el = review.parentElement;
  while (el && el !== document.body) {
    const ov = window.getComputedStyle(el).overflowY;
    if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }

  // Strategy 3: any .m6QErb as last resort
  return document.querySelector('.m6QErb') || null;
}

// Open the sort menu and click "Newest".
async function sortByNewest() {
  const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));

  // Confirmed from HTML: Maps uses data-value="Sort" (capital S)
  const sortBtn =
    document.querySelector('[data-value="Sort"]')
    || allButtons.find(el => {
        const label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase().trim();
        return label === 'sort' || label === 'sort reviews';
      });

  if (!sortBtn) return false;

  sortBtn.click();

  // Wait for the sort dropdown to render (roles confirmed in Maps: menuitemcheckbox)
  const MENU_ROLES = '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="radio"]';
  try {
    await waitForElement(MENU_ROLES, 3000);
  } catch {
    // menu may use a different structure — fall through to text search
  }

  // Strategy 1: ARIA role-based (menuitemcheckbox is confirmed present in Maps HTML)
  let newestOpt = Array.from(document.querySelectorAll(MENU_ROLES))
    .find(el => /newest/i.test(el.textContent));

  // Strategy 2: any jsaction-bearing element with "Newest" as its short text
  if (!newestOpt) {
    newestOpt = Array.from(document.querySelectorAll('[jsaction]'))
      .find(el => {
        const t = el.textContent.trim();
        return t.length < 25 && /newest/i.test(t);
      });
  }

  // Strategy 3: TreeWalker — find the "Newest" text node and click its parent
  if (!newestOpt) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (/^Newest$/i.test(node.nodeValue.trim())) {
        newestOpt = node.parentElement;
        break;
      }
    }
  }

  if (!newestOpt) {
    document.body.click();
    return false;
  }

  newestOpt.click();
  await sleep(1500);
  return true;
}

// Click all un-expanded "More" buttons inside review cards in one pass.
// IMPORTANT: Maps already sets data-mr-expanded="1" on its own elements,
// so we use data-rext-expanded to avoid the conflict.
async function expandVisibleMoreButtons() {
  let clicked = 0;
  for (const reviewEl of document.querySelectorAll('.jftiEf[data-review-id]')) {
    if (reviewEl.dataset.rextExpanded) continue;
    reviewEl.dataset.rextExpanded = '1';

    const btns = Array.from(reviewEl.querySelectorAll('button, [role="button"]'));
    const moreBtn = btns.find(b => {
      const text = b.textContent.trim().toLowerCase();
      return text === 'more' || text === 'მეტი';
    });
    if (moreBtn) {
      moreBtn.click();
      clicked++;
    }
  }
  if (clicked > 0) await sleep(500);
}

// ─── Review extraction ────────────────────────────────────────────────────────
function extractStars(el) {
  // Confirmed from HTML: <span class="kvMYJc" role="img" aria-label="5 stars">
  const starEl =
    el.querySelector('.kvMYJc[role="img"]')
    || el.querySelector('span[role="img"][aria-label*="star"]');
  if (!starEl) return null;
  const m = (starEl.getAttribute('aria-label') || '').match(/(\d)/);
  return m ? parseInt(m[1], 10) : null;
}

function extractReviewer(el) {
  // Confirmed from HTML: reviewer name is in <div class="d4r55"> inside
  // a <button class="al6Kxe" data-href="...maps/contrib/...">
  // There is NO <a href> — the link is a button with data-href.
  return el.querySelector('.d4r55')?.textContent?.trim() || null;
}

function extractDateText(el) {
  // Strategy 1: known Maps date class names
  for (const sel of ['.rsqaWe', '.dehysf']) {
    const node = el.querySelector(sel);
    if (node) {
      const raw = node.textContent.trim();
      if (raw && isRelativeDate(raw)) return raw;
    }
  }

  // Strategy 2: walk raw text nodes — works even when class names change.
  // Text nodes give us the leaf string without sibling/ancestor contamination.
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let textNode;
  while ((textNode = walker.nextNode())) {
    const t = textNode.nodeValue.trim();
    if (t.length > 2 && t.length < 70 && isRelativeDate(t)) return t;
  }

  // Strategy 3: aria-label attributes (Maps encodes dates here on some layouts)
  for (const child of el.querySelectorAll('[aria-label]')) {
    const label = (child.getAttribute('aria-label') || '').trim();
    if (label.length < 70 && isRelativeDate(label)) return label;
  }

  return null;
}

function extractReviewText(el) {
  // Confirmed from HTML: <span class="wiI7pd"> inside <div class="MyEned">
  // jsname="bN97Pc" does NOT exist in real Maps HTML — removed.
  const knownEl = el.querySelector('.wiI7pd') || el.querySelector('[class*="wiI7pd"]');
  if (knownEl) return knownEl.textContent.trim() || null;

  // Fallback: longest span that isn't a date string
  let best = '';
  for (const span of el.querySelectorAll('span')) {
    const t = span.textContent.trim();
    if (!isRelativeDate(t) && t.length > best.length && t.length > 20) best = t;
  }
  return best || null;
}

// Format a Date as YYYY-MM-DD using LOCAL calendar (not UTC), so dates don't
// shift backwards for users in UTC+ timezones when we call toISOString().
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function extractReview(el) {
  const dateText  = extractDateText(el);
  const parsedDate = parseRelativeDate(dateText);
  return {
    id:         el.getAttribute('data-review-id'),
    reviewer:   extractReviewer(el),
    stars:      extractStars(el),
    dateText,
    date:       parsedDate ? localDateStr(parsedDate) : null,
    reviewText: extractReviewText(el),
  };
}

// ─── Download ─────────────────────────────────────────────────────────────────
function downloadJSON(payload) {
  const rawName = getBusinessName().replace(/[^a-z0-9]/gi, '_').slice(0, 60);
  const dateSuffix = new Date().toISOString().slice(0, 10);
  const filename = `${rawName}_reviews_${dateSuffix}.json`;

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
  // Without this, "2026-06-15" becomes June 15 00:00 UTC which is June 15 04:00
  // local in GMT+4 — causing off-by-one comparisons against locally-computed dates.
  const fromDate = new Date(fromVal + 'T00:00:00');
  const toDate   = new Date(toVal   + 'T23:59:59.999');

  const reviews = [];
  const seenIds = new Set();
  let seenTooNew        = false;
  let consecutiveTooOld = 0;
  let emptyScrolls      = 0;
  let skippedUndated    = 0;

  setStatus('Sorting reviews by newest…');
  const sorted = await sortByNewest();
  if (!sorted) log('warn', 'Sort by newest failed — proceeding without sorting');

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
    // Expand truncated reviews before scraping this batch
    await expandVisibleMoreButtons();

    // Use .jftiEf to target only the outer review card element.
    // Maps puts data-review-id on ~9 elements per review (buttons, inner divs, etc.)
    // — scoping to .jftiEf ensures we process each review exactly once.
    const reviewEls = document.querySelectorAll('.jftiEf[data-review-id]');

    for (const el of reviewEls) {
      if (_state !== 'running') break crawlLoop;

      const id = el.getAttribute('data-review-id');
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const review = extractReview(el);
      const date   = parseRelativeDate(review.dateText);

      if (date === null) {
        // Could not parse date — skip but don't let it trigger early-stop
        skippedUndated++;
        log('warn', `Skipped review ${id}: date text not recognised (dateText=${JSON.stringify(review.dateText)})`);
      } else if (date > toDate) {
        seenTooNew = true;
        consecutiveTooOld = 0;
      } else if (date < fromDate) {
        consecutiveTooOld++;
        if (consecutiveTooOld >= MAX_CONSECUTIVE_TOO_OLD && (seenTooNew || reviews.length > 0)) {
          log('info', `Stopping: ${MAX_CONSECUTIVE_TOO_OLD} consecutive reviews older than from-date.`);
          break crawlLoop;
        }
      } else {
        // Date is within [fromDate, toDate]
        consecutiveTooOld = 0;
        seenTooNew = true;
        reviews.push(review);
        setCount(reviews.length);
      }
    }

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
      business:        getBusinessName(),
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
  const host = document.getElementById('maps-reviews-extractor-host');
  if (!host) {
    init();
  } else {
    const panel = _shadow?.querySelector('#panel');
    if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
  }
});

// ─── SPA navigation guard ─────────────────────────────────────────────────────
// Google Maps is a SPA; content scripts don't re-run on in-app navigation.
function watchForNavigation() {
  setInterval(() => {
    if (location.href === _lastUrl) return;
    _lastUrl = location.href;
    // Wait for Maps to finish rendering the new page
    setTimeout(() => {
      if (!document.getElementById('maps-reviews-extractor-host')) init();
    }, 2000);
  }, 1000);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
function init() {
  if (document.getElementById('maps-reviews-extractor-host')) return;

  const shadow = injectPanel();
  wireButtons(shadow);

  const today          = new Date();
  const firstOfMonth   = new Date(today.getFullYear(), today.getMonth(), 1);

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
