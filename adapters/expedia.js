/**
 * adapters/expedia.js — Expedia reviews adapter.
 *
 * Expedia typically loads reviews in batches via a "Show more reviews"
 * button rather than infinite scroll. advance() clicks that button and
 * waits for new review cards to appear.
 */

'use strict';

(function () {
  const CARD_SELECTORS = [
    '[data-stid="review-list-review"]',
    '[data-stid="lodging-details-review"]',
    '[data-stid="ugc-review"]',
    '[data-stid="lodging-review-card"]',
    '[data-stid*="review-list-item"]',
    '[data-stid*="review-card"]',
    '[data-stid*="reviews-review"]',
    'article[data-stid*="review"]',
    // Fallback for older layouts:
    'div[itemprop="review"]',
    '[itemtype*="/Review"]',
  ];

  function _findCards() {
    for (const sel of CARD_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length) return nodes;
    }
    // Heuristic fallback for when Expedia renames every data-stid: locate
    // the "N/10 <Word>" score header (e.g. "10/10 Excellent") that leads
    // every review, then walk up to the smallest ancestor that also carries
    // the reviewer name / date. Scores are the most reliable landmark on
    // Expedia because search chips, filters, and translation links never
    // match that shape.
    const scope = _exFindReviewsScope() || document.body;
    const scoreEls = [];
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    let tn;
    while ((tn = walker.nextNode())) {
      const t = tn.nodeValue.trim();
      // "10/10 Excellent", "8.4/10 Very good", "9/10 Wonderful", …
      if (/^\d+(?:\.\d+)?\/10\s+[A-Za-z][A-Za-z ]{2,}$/.test(t) && t.length < 40) {
        scoreEls.push(tn.parentElement);
      }
    }
    const seen = new Set();
    const cards = [];
    const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
    for (const scoreEl of scoreEls) {
      let ancestor = scoreEl;
      for (let hops = 0; hops < 8 && ancestor && ancestor !== document.body; hops++) {
        ancestor = ancestor.parentElement;
        if (!ancestor) break;
        const txt = ancestor.textContent || '';
        // Card should include the score, a month/relative-date token, and be
        // reasonably sized (larger than the score, smaller than the whole
        // reviews list).
        if (txt.length > 120 && txt.length < 4000 && MONTH_RE.test(txt)) {
          break;
        }
      }
      if (ancestor && ancestor !== document.body && !seen.has(ancestor)) {
        seen.add(ancestor);
        cards.push(ancestor);
      }
    }
    return cards;
  }

  // Best-effort locator for the reviews modal / section — used to scope
  // the heuristic search and to pick the scrollable container for advance().
  function _exFindReviewsScope() {
    // Newer Expedia opens reviews in a dialog labeled "Guest reviews".
    const dialogs = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
    for (const d of dialogs) {
      const label = (d.getAttribute('aria-label') || '') + ' ' + (d.textContent || '').slice(0, 200);
      if (/guest reviews|all reviews|verified reviews/i.test(label)) return d;
    }
    // Inline reviews section on the property page.
    return (
      document.querySelector('[data-stid*="reviews-container"]')
      || document.querySelector('[data-stid*="reviews-list"]')
      || document.querySelector('section[aria-label*="review" i]')
      || null
    );
  }

  // If the reviews are in a modal, the modal itself scrolls — not the window.
  // Walk down to find the deepest scrollable child so advance() can scroll it.
  function _exFindScrollableModal() {
    const scope = _exFindReviewsScope();
    if (!scope) return null;
    if (!(scope.getAttribute('role') === 'dialog' || scope.getAttribute('aria-modal') === 'true')) {
      return null;
    }
    const nodes = scope.querySelectorAll('*');
    for (const el of nodes) {
      const ov = window.getComputedStyle(el).overflowY;
      if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return scope;
  }

  const adapter = {
    name: 'expedia',
    label: 'Expedia Reviews Extractor',

    detect() {
      return /^https?:\/\/(www\.)?expedia\.[a-z.]+\//i.test(location.href);
    },

    getBusinessName() {
      const raw = (
        document.querySelector('h1[data-stid="content-hotel-title"]')?.textContent?.trim()
        || document.querySelector('h1.uitk-heading')?.textContent?.trim()
        || document.querySelector('h1')?.textContent?.trim()
        || document.title.split('|')[0].split(' - ')[0].trim()
        || 'unknown'
      );
      return raw.replace(/\s+/g, ' ').trim() || 'unknown';
    },

    async findReviewsContainer() {
      // First try the fast path: any stid-based selector already matches.
      try {
        await waitForElement(CARD_SELECTORS.join(','), 3000);
        return _exFindScrollableModal() || document.scrollingElement || document.documentElement;
      } catch {
        /* fall through to heuristic */
      }
      // Slow path: poll _findCards() (which runs the score-header heuristic).
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (_findCards().length > 0) {
          return _exFindScrollableModal() || document.scrollingElement || document.documentElement;
        }
        await sleep(300);
      }
      return null;
    },

    async sortByNewest() {
      // Expedia's sort UI is typically a <select> or a menu labeled "Sort by".
      const selectEl = Array.from(document.querySelectorAll('select')).find(s => {
        const label = (s.getAttribute('aria-label') || '').toLowerCase();
        return /sort/i.test(label) || Array.from(s.options).some(o => /newest|most recent/i.test(o.textContent));
      });
      if (selectEl) {
        const newestOpt = Array.from(selectEl.options).find(o =>
          /newest|most recent/i.test(o.textContent)
        );
        if (!newestOpt) return false;
        selectEl.value = newestOpt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1500);
        return true;
      }

      // Button/menu style.
      const sortBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => /sort/i.test((el.getAttribute('aria-label') || el.textContent || '')));
      if (!sortBtn) return false;
      sortBtn.click();
      await sleep(400);

      const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], li, button');
      const newest = Array.from(menuItems).find(el => {
        const t = el.textContent.trim();
        return t.length < 40 && /^(newest|most recent)$/i.test(t);
      });
      if (!newest) {
        document.body.click();
        return false;
      }
      newest.click();
      await sleep(1500);
      return true;
    },

    async expandVisibleMoreButtons() {
      let clicked = 0;
      for (const card of _findCards()) {
        if (card.dataset.rextExpanded) continue;
        card.dataset.rextExpanded = '1';

        const btns = Array.from(card.querySelectorAll('button, [role="button"]'));
        const moreBtn = btns.find(b => {
          const t = b.textContent.trim().toLowerCase();
          return t === 'read more' || t === 'show more' || t === 'more' || t === 'see more';
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
      const dateText = _exExtractDateText(el);
      const parsedDate = parseAnyDate(dateText);
      return {
        id:           _exExtractId(el),
        reviewer:     _exExtractReviewer(el),
        stars:        _exExtractStars(el),
        travelerType: _exExtractTravelerType(el),
        dateText,
        date:         parsedDate ? localDateStr(parsedDate) : null,
        reviewText:   _exExtractReviewText(el),
      };
    },

    async advance(container) {
      // Preferred: click "Show more reviews".
      const showMore = _exFindShowMoreButton();
      if (showMore && !showMore.disabled) {
        const prevCount = _findCards().length;
        showMore.scrollIntoView({ block: 'center' });
        showMore.click();
        // Wait for new cards to appear.
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          await sleep(400);
          if (_findCards().length > prevCount) return 'progressed';
        }
        return 'stalled';
      }

      // Fallback: scroll. When the reviews live in a modal we must scroll
      // the MODAL, not the window — otherwise the modal never lazy-loads
      // its next batch.
      const isWindowScroller =
        container === document.scrollingElement || container === document.documentElement;
      if (isWindowScroller) {
        const prev = window.scrollY;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(1200);
        return window.scrollY === prev ? 'stalled' : 'progressed';
      }
      const prevCount = _findCards().length;
      container.scrollTop = container.scrollHeight;
      await sleep(1200);
      return _findCards().length > prevCount ? 'progressed' : 'stalled';
    },
  };

  // ─── Private helpers ───────────────────────────────────────────────────────

  function _exFindShowMoreButton() {
    // Text-based lookup — Expedia's stids for this button change often.
    return Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t === 'show more reviews' || t === 'load more reviews' || t === 'show more';
      }) || null;
  }

  function _exExtractId(el) {
    const explicit =
      el.getAttribute('data-review-id')
      || el.getAttribute('data-stid-review-id')
      || el.id;
    if (explicit) return explicit;
    const reviewer = _exExtractReviewer(el) || '';
    const dt = _exExtractDateText(el) || '';
    const txt = (el.textContent || '').slice(0, 60);
    return `ex:${reviewer}|${dt}|${txt.length}`;
  }

  function _exExtractReviewer(el) {
    const cand = (
      el.querySelector('[data-stid="review-author-name"]')
      || el.querySelector('[data-stid*="author"]')
      || el.querySelector('h4')
      || el.querySelector('h5')
      || el.querySelector('.uitk-type-500')
    );
    return cand?.textContent?.trim() || null;
  }

  function _exExtractStars(el) {
    // Aria labels like "5 out of 5" / "5.0 out of 5".
    const aria = el.querySelector('[aria-label*="out of 5"], [aria-label*="out of 10"]');
    if (aria) {
      const label = aria.getAttribute('aria-label') || '';
      const m = label.match(/(\d+(?:\.\d+)?)\s*out of\s*(\d+)/i);
      if (m) {
        const val = parseFloat(m[1]);
        const scale = parseInt(m[2], 10);
        // Normalise everything to a 1–5 star scale.
        return Math.round(scale === 10 ? val / 2 : val);
      }
    }
    // Text "5.0/5" or "8/10".
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const m = n.nodeValue.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(5|10)$/);
      if (m) {
        const val = parseFloat(m[1]);
        const scale = parseInt(m[2], 10);
        return Math.round(scale === 10 ? val / 2 : val);
      }
    }
    return null;
  }

  function _exExtractDateText(el) {
    // Prefer machine-readable <time datetime>.
    const time = el.querySelector('time[datetime]');
    if (time) {
      const dt = time.getAttribute('datetime').trim();
      if (dt) return dt;
    }

    const candidates = [
      '[data-stid="review-date"]',
      '[data-stid*="review-submission-time"]',
    ];
    for (const sel of candidates) {
      const node = el.querySelector(sel);
      if (node) {
        const raw = node.textContent.trim();
        if (raw && isAnyDate(raw)) return raw;
        const stripped = raw.replace(/^(reviewed|posted|written|stayed)(\s+on)?\s+/i, '');
        if (stripped && isAnyDate(stripped)) return stripped;
      }
    }

    // Walk text nodes.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let textNode;
    let bestAbsolute = null;
    while ((textNode = walker.nextNode())) {
      const t = textNode.nodeValue.trim();
      if (!t || t.length > 80) continue;
      if (isRelativeDate(t)) return t;
      if (!bestAbsolute && isAbsoluteDate(t)) bestAbsolute = t;
    }
    return bestAbsolute;
  }

  function _exExtractTravelerType(el) {
    // "Traveled with family" / "Traveled with partner" / "Traveled solo" /
    // "Traveled on business" / "Traveled with friends". Anchored so we
    // don't false-match sentences inside the review body.
    const RE = /^Traveled\s+(with\s+\S+|solo|on\s+business)\s*$/i;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || '').trim();
      if (!t || t.length > 40) continue;
      if (RE.test(t)) return t;
    }
    return null;
  }

  function _exExtractReviewText(el) {
    const candidates = [
      '[data-stid="review-text"]',
      '[data-stid*="review-body"]',
      'blockquote',
      '.uitk-text',
    ];
    for (const sel of candidates) {
      const nodes = el.querySelectorAll(sel);
      let best = '';
      for (const node of nodes) {
        const t = node.textContent.trim();
        if (t.length > best.length && t.length > 20 && !isAnyDate(t)) best = t;
      }
      if (best) return best;
    }
    // Fallback: longest paragraph-like span.
    let best = '';
    for (const span of el.querySelectorAll('span, p, div')) {
      const t = span.textContent.trim();
      if (!t || isAnyDate(t)) continue;
      if (t.length > best.length && t.length > 40 && span.children.length < 6) best = t;
    }
    return best || null;
  }

  window.REVIEW_ADAPTERS = window.REVIEW_ADAPTERS || [];
  window.REVIEW_ADAPTERS.push(adapter);
})();
