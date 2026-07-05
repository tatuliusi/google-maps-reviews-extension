/**
 * adapters/tripadvisor.js — TripAdvisor reviews adapter.
 *
 * TripAdvisor A/B tests DOM constantly, so every field uses a chain of
 * selectors + a text-node walker fallback. Sort is optional — the user is
 * expected to sort manually if needed (the crawler disables early-stop
 * when sortByNewest() returns false).
 */

'use strict';

(function () {
  // Review card candidate selectors — first hit wins. Ordered new→old.
  // Kept tight on purpose: previously we included short class-name fallbacks
  // (.YibKl, .QcJgh, .WAllg) but those match unrelated cards on some layouts,
  // causing the crawler to advance past the real review list.
  const CARD_SELECTORS = [
    '[data-automation="reviewCard"]',
    '[data-test-target="HR_CC_CARD"]',
    '[data-test-target="reviews-tab"] [data-reviewid]',
    'div[data-reviewid]',
    '.review-container',
  ];

  function _findCards() {
    for (const sel of CARD_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length) return nodes;
    }
    return [];
  }

  const adapter = {
    name: 'tripadvisor',
    label: 'TripAdvisor Reviews Extractor',

    detect() {
      // Covers .com, .co.uk, .fr, .de, etc.
      return /^https?:\/\/(www\.)?tripadvisor\.[a-z.]+\//i.test(location.href);
    },

    getBusinessName() {
      const raw = (
        document.querySelector('h1[data-automation="mainH1"]')?.textContent?.trim()
        || document.querySelector('h1.biGQs')?.textContent?.trim()
        || document.querySelector('h1')?.textContent?.trim()
        || document.title.split('|')[0].split(' - ')[0].trim()
        || 'unknown'
      );
      // TripAdvisor inlines flags/badges next to the H1 (e.g. "Someone from
      // this business manages the listing.", "Contact accommodation") that
      // .textContent picks up. Cut them off.
      return raw
        .replace(/Someone from this business.*$/i, '')
        .replace(/Contact\s+accommodation.*$/i, '')
        .replace(/Manage\s+this\s+(business|property).*$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || 'unknown';
    },

    // TripAdvisor generally paginates; the "container" is the whole document.
    // Return document.scrollingElement so the crawler can scroll into view
    // if scrolling is what advance() ends up doing.
    async findReviewsContainer() {
      try {
        await waitForElement(CARD_SELECTORS.join(','), 15000);
      } catch {
        return null;
      }
      return document.scrollingElement || document.documentElement;
    },

    async sortByNewest() {
      // If sort is ALREADY newest (URL param, or dropdown label), skip work
      // and report sorted=true so the crawler can early-stop.
      if (_taSortIsNewest()) return true;

      const candidates = Array.from(document.querySelectorAll(
        'button, [role="button"], [data-test-target*="sort"], select'
      ));

      const sortCtrl = candidates.find(el => {
        const t = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
        return /sort|most recent|newest/.test(t) && t.length < 60;
      });
      if (!sortCtrl) {
        // TA hotel/restaurant/attraction pages default to "Most recent".
        // Instead of giving up (which disables the crawler's early-stop),
        // sample the first few visible cards' publish dates and treat the
        // list as sorted iff those dates are non-increasing. sortByNewest
        // runs BEFORE findReviewsContainer, so wait for the cards ourselves
        // — otherwise the heuristic sees an empty DOM and returns false,
        // silently disabling early-stop.
        try {
          await waitForElement(CARD_SELECTORS.join(','), 10000);
        } catch {
          return false;
        }
        return _taFirstCardsAreDescending();
      }

      const beforeMarker = _taFirstCardMarker();

      // <select> path: set value directly.
      if (sortCtrl.tagName === 'SELECT') {
        const newestOpt = Array.from(sortCtrl.options).find(o =>
          /newest|most recent/i.test(o.textContent)
        );
        if (!newestOpt) return false;
        sortCtrl.value = newestOpt.value;
        sortCtrl.dispatchEvent(new Event('change', { bubbles: true }));
        await _taWaitForCardsToChange(beforeMarker, 6000);
        return _taSortIsNewest() || _taFirstCardMarker() !== beforeMarker;
      }

      sortCtrl.click();
      await sleep(400);

      const MENU_ROLES = '[role="menuitem"], [role="option"], [role="radio"], li, button';
      const newest = Array.from(document.querySelectorAll(MENU_ROLES))
        .find(el => {
          const t = el.textContent.trim();
          return t.length < 40 && /^(newest|most recent)$/i.test(t);
        });

      if (!newest) {
        document.body.click(); // close menu
        return false;
      }
      newest.click();
      // Wait for the list to actually re-render before the crawler starts
      // extracting — otherwise page-1's stale cards get processed and we
      // then click "next", effectively skipping the freshly-sorted first page.
      await _taWaitForCardsToChange(beforeMarker, 6000);
      return _taSortIsNewest() || _taFirstCardMarker() !== beforeMarker;
    },

    async expandVisibleMoreButtons() {
      let clicked = 0;
      for (const card of _findCards()) {
        if (card.dataset.rextExpanded) continue;
        card.dataset.rextExpanded = '1';

        const btns = Array.from(card.querySelectorAll('button, span[role="button"], a'));
        const moreBtn = btns.find(b => {
          const t = b.textContent.trim().toLowerCase();
          return t === 'read more' || t === 'more' || t === 'show more' || t === 'read full review';
        });
        if (moreBtn) {
          moreBtn.click();
          clicked++;
        }
      }
      if (clicked > 0) await sleep(500);
    },

    getReviewElements() {
      return _findCards();
    },

    extractReview(el) {
      const dateText = _taExtractDateText(el);
      const parsedDate = parseAnyDate(dateText);
      return {
        id:         _taExtractId(el),
        reviewer:   _taExtractReviewer(el),
        stars:      _taExtractStars(el),
        dateText,
        date:       parsedDate ? localDateStr(parsedDate) : null,
        reviewText: _taExtractReviewText(el),
      };
    },

    async advance(container) {
      // TripAdvisor paginates. Prefer clicking "next page"; if absent, scroll.
      const nextBtn = _taFindNextPageButton();
      if (nextBtn && !nextBtn.disabled && nextBtn.getAttribute('aria-disabled') !== 'true') {
        const prevMarker = _taFirstCardMarker();
        nextBtn.scrollIntoView({ block: 'center' });
        nextBtn.click();
        // Wait until the first card is NON-NULL and DIFFERENT — mid-redraw
        // gives us a transient null, and treating that as "progressed" was
        // making us click Next again before page 1 had settled, so we'd
        // effectively skip the first few pages.
        const ok = await _taWaitForCardsToChange(prevMarker, 8000);
        return ok ? 'progressed' : 'stalled';
      }

      // No pagination — scroll the window.
      const prev = window.scrollY;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1200);
      return window.scrollY === prev ? 'stalled' : 'progressed';
    },
  };

  // ─── Private helpers ───────────────────────────────────────────────────────

  // Sample publish dates of the first cards; return true only if strictly
  // non-increasing. Used as a fallback signal that the list is sorted newest
  // when TA hides its sort control.
  function _taFirstCardsAreDescending() {
    const cards = _findCards();
    if (cards.length < 2) return false;
    const dates = [];
    for (let i = 0; i < Math.min(5, cards.length); i++) {
      const t = _taExtractDateText(cards[i]);
      const d = t ? parseAnyDate(t) : null;
      if (d) dates.push(d);
    }
    if (dates.length < 2) return false;
    for (let i = 1; i < dates.length; i++) {
      if (dates[i] > dates[i - 1]) return false;
    }
    return true;
  }

  function _taFirstCardMarker() {
    const cards = _findCards();
    if (!cards.length) return null;
    const first = cards[0];
    return first.getAttribute('data-reviewid')
      || first.getAttribute('data-automation')
      || first.textContent.slice(0, 60);
  }

  // Poll until the first-card marker is non-null AND different from `prev`.
  // Returns true if the change was observed within the timeout.
  async function _taWaitForCardsToChange(prev, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(300);
      const now = _taFirstCardMarker();
      if (now && now !== prev) return true;
    }
    return false;
  }

  // Return true if the page is currently sorted by newest — from either the
  // URL (?sortType=NEWEST etc.) or a visible sort control's label. Lets the
  // crawler early-stop even when the user sorted manually.
  function _taSortIsNewest() {
    const params = new URLSearchParams(location.search);
    const sortParam = (params.get('sortType') || params.get('sort') || '').toLowerCase();
    if (/newest|mostrecent|most_recent|date/.test(sortParam)) return true;

    // Sort dropdown text
    const sortCtrl = (
      document.querySelector('[data-test-target*="sort"]')
      || document.querySelector('[data-automation*="sort"]')
    );
    if (sortCtrl) {
      const t = sortCtrl.textContent.trim().toLowerCase();
      if (/newest|most recent/.test(t) && t.length < 120) return true;
    }
    return false;
  }

  function _taFindNextPageButton() {
    // Try common "next" affordances. Kept specific: `a[aria-label="Next"]`
    // is intentionally omitted because it matches carousel arrows too.
    return (
      document.querySelector('a.nav.next:not(.disabled)')
      || document.querySelector('a[data-smoke-attr="pagination-next-arrow"]')
      || document.querySelector('[data-test-target="page-nav-next-btn"]')
      || document.querySelector('button[aria-label="Next page"]')
      || document.querySelector('a[aria-label="Next page"]')
      || null
    );
  }

  function _taExtractId(el) {
    const explicit = el.getAttribute('data-reviewid') || el.getAttribute('data-review-id');
    if (explicit) return explicit;
    // Look inside for a link that carries a review id.
    const link = el.querySelector('a[href*="ShowUserReviews"], a[href*="-r"]');
    if (link) {
      const m = link.getAttribute('href').match(/-r(\d+)-/);
      if (m) return m[1];
    }
    // Fallback: content-hash-ish key (stable across scrolls in one session).
    const reviewer = _taExtractReviewer(el) || '';
    const dt = _taExtractDateText(el) || '';
    const txt = (el.textContent || '').slice(0, 60);
    return `ta:${reviewer}|${dt}|${txt.length}`;
  }

  function _taExtractReviewer(el) {
    // A card typically has TWO /Profile/ links: the avatar (image-only, empty
    // text) and the name link. Iterate and pick the first with real text —
    // querying only the first link returns the avatar and yields null.
    const links = el.querySelectorAll('a[href*="/Profile/"]');
    for (const link of links) {
      const span = link.querySelector('span');
      const raw = ((span?.textContent) || link.textContent || '').trim();
      if (!raw) continue;
      const first = raw.split('\n')[0].trim();
      if (first && first.length < 80) return first;
    }
    const cand = (
      el.querySelector('[data-automation="reviewer-name"]')
      || el.querySelector('.info_text .username')
      || el.querySelector('.info_text a')
      || el.querySelector('.username')
    );
    return cand?.textContent?.trim() || null;
  }

  function _taExtractStars(el) {
    // Current TA layout: <svg><title>5.0 of 5 bubbles</title></svg>
    const titleEl = el.querySelector('svg title');
    if (titleEl) {
      const m = titleEl.textContent.match(/(\d+(?:\.\d+)?)\s*of\s*5(\s*bubbles)?/i);
      if (m) return Math.round(parseFloat(m[1]));
    }
    // Legacy: class="ui_bubble_rating bubble_50" (bubble_50 = 5)
    const bubble = el.querySelector('[class*="bubble_"]');
    if (bubble) {
      const m = bubble.className.match(/bubble_(\d0)/);
      if (m) return parseInt(m[1], 10) / 10;
    }
    // Aria-label on svg or wrapper
    const aria = el.querySelector(
      '[aria-label*="of 5 bubbles"], [aria-label*="out of 5"], [aria-label*="bubbles"]'
    );
    if (aria) {
      const m = (aria.getAttribute('aria-label') || '').match(/(\d+(?:\.\d+)?)/);
      if (m) return Math.round(parseFloat(m[1]));
    }
    // Text-based "5/5" or "5.0/5"
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const m = n.nodeValue.trim().match(/^([1-5](?:\.\d)?)\s*\/\s*5$/);
      if (m) return Math.round(parseFloat(m[1]));
    }
    return null;
  }

  function _taExtractDateText(el) {
    // Prefer a <time datetime="..."> if present.
    const time = el.querySelector('time[datetime]');
    if (time) {
      const dt = time.getAttribute('datetime').trim();
      if (dt) return dt;
    }

    // Pass 1 (dominant on current TA): find the smallest element whose
    // flattened textContent ends with "wrote a review <date>". Walking
    // ELEMENTS (not text nodes) is critical — TA sometimes wraps the date
    // itself in an inner <span>, which splits the phrase across two
    // sibling text nodes and defeats a text-node scan. This approach works
    // whether the date is bare text or wrapped, because the parent element's
    // flattened textContent contains the whole phrase either way.
    const WROTE_RE = /wrote\s+a\s+review\s+(.+?)\s*$/i;
    let best = null;
    for (const c of el.querySelectorAll('div, span, p, li')) {
      const flat = (c.textContent || '').replace(/\s+/g, ' ').trim();
      if (!flat || flat.length > 80) continue;
      const m = flat.match(WROTE_RE);
      if (!m) continue;
      const datePart = m[1].trim();
      if (!datePart || datePart.length > 30) continue;
      const normalized = _taNormalizeWroteDate(datePart);
      // Only accept captures that actually parse. This filters out cases
      // where the regex accidentally matched something longer than the date
      // (e.g. "Today 1 contribution" when a wider container was scanned).
      if (!parseAnyDate(normalized)) continue;
      if (!best || flat.length < best.flatLen) {
        best = { normalized, flatLen: flat.length };
      }
    }
    if (best) return best.normalized;

    // Collect text nodes for legacy-format fallbacks.
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || '').trim();
      if (t && t.length <= 80) nodes.push(t);
    }

    // Pass 2 (legacy TA): "Reviewed October 15, 2026" / "Written 3 days ago".
    // NOT "Stayed …" — that's the stay date, which we must never treat as
    // the publish date on hotel cards.
    const LEGACY_PREFIX_RE = /^(written|reviewed|posted)\b/i;
    for (const t of nodes) {
      if (LEGACY_PREFIX_RE.test(t) && isAnyDate(t)) return t;
    }

    // Pass 3: relative dates only. We deliberately do NOT fall back to bare
    // absolute dates — on hotels the only bare absolute in the card is the
    // "Date of stay: July 2026" value, and picking that up made every review
    // look like it was published on the check-in month.
    for (const t of nodes) {
      if (/date\s+of\s+stay/i.test(t)) continue;
      if (isRelativeDate(t)) return t;
    }

    return null;
  }

  function _taNormalizeWroteDate(s) {
    if (/^today$/i.test(s)) return 'today';
    if (/^yesterday$/i.test(s)) return 'yesterday';
    // "Jul 1" — TA drops the year for current-year reviews. Add the current
    // year; if that lands in the future, it's actually last year.
    if (/^[A-Za-z]{3,9}\s+\d{1,2}$/.test(s)) {
      const now = new Date();
      const cy = now.getFullYear();
      const guess = parseAbsoluteDate(`${s} ${cy}`);
      if (guess && guess > now) return `${s} ${cy - 1}`;
      return `${s} ${cy}`;
    }
    return s;
  }

  // TA appends a boilerplate disclaimer to every card. We must never treat
  // it as the review body.
  function _isTaDisclaimer(text) {
    return /this review is the subjective opinion/i.test(text)
        || /read our transparency report/i.test(text)
        || /industry-leading trust\s*&\s*safety/i.test(text);
  }

  function _taExtractReviewText(el) {
    // <q> is TripAdvisor's semantic body wrapper on current layouts.
    const q = el.querySelector('q');
    if (q) {
      const t = q.textContent.trim();
      if (t.length > 10 && !_isTaDisclaimer(t)) return t;
    }

    const candidates = [
      '[data-automation="reviewText"]',
      '[data-test-target="review-body"]',
      '.JguWG',       // current body span
      '.fIrGe',       // current body container
      '.partial_entry',
      '.entry',
      '.QewHA',
      '.orRIx',
    ];
    for (const sel of candidates) {
      const node = el.querySelector(sel);
      if (node) {
        const t = node.textContent.trim();
        if (t.length > 10 && !_isTaDisclaimer(t)) return t;
      }
    }

    // Fallback: longest paragraph-like child, skipping dates AND disclaimer.
    let best = '';
    for (const span of el.querySelectorAll('span, p, div')) {
      const t = span.textContent.trim();
      if (!t || isAnyDate(t) || _isTaDisclaimer(t)) continue;
      if (t.length > best.length && t.length > 40 && span.children.length < 6) best = t;
    }
    return best || null;
  }

  window.REVIEW_ADAPTERS = window.REVIEW_ADAPTERS || [];
  window.REVIEW_ADAPTERS.push(adapter);
})();
