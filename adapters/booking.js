/**
 * adapters/booking.js — Booking.com reviews adapter.
 *
 * Booking presents reviews either inline on the property page or in a modal
 * ("See all reviews"). Both use the same review-card DOM. Scores are 1–10
 * on Booking, so we normalise to 1–5 stars to match the shared schema.
 *
 * Reviews split into "Liked" (positive) and "Disliked" (negative) sections —
 * we concatenate them so reviewText carries the full text.
 */

'use strict';

(function () {
  const CARD_SELECTORS = [
    '[data-testid="review-card"]',
    '[data-testid="review"]',
    '.c-review-block',           // legacy
    '.review_item',              // very old
    'li.review_list_new_item_block',
  ];

  function _findCards() {
    for (const sel of CARD_SELECTORS) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length) return nodes;
    }
    return [];
  }

  // Booking's review modal — when present, we scroll IT, not the window.
  function _findReviewScrollable() {
    const modal = document.querySelector(
      '[data-testid="review-modal"], [role="dialog"][aria-label*="review" i], .bui-modal__inner'
    );
    if (modal) {
      // Walk down to find the scrollable child.
      const candidates = modal.querySelectorAll('*');
      for (const el of candidates) {
        const ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) return el;
      }
      return modal;
    }
    return null;
  }

  const adapter = {
    name: 'booking',
    label: 'Booking.com Reviews Extractor',

    detect() {
      return /^https?:\/\/(www\.)?booking\.[a-z.]+\//i.test(location.href);
    },

    getBusinessName() {
      const raw = (
        document.querySelector('h2[data-testid="header-title"]')?.textContent?.trim()
        || document.querySelector('h2.pp-header__title')?.textContent?.trim()
        || document.querySelector('#hp_hotel_name')?.textContent?.trim()
        || document.querySelector('h1')?.textContent?.trim()
        || document.querySelector('h2')?.textContent?.trim()
        || document.title.split('|')[0].split(' - ')[0].trim()
        || 'unknown'
      );
      return raw.replace(/\s+/g, ' ').trim() || 'unknown';
    },

    async findReviewsContainer() {
      try {
        await waitForElement(CARD_SELECTORS.join(','), 15000);
      } catch {
        return null;
      }
      // Prefer the modal's scrollable body if the modal is open;
      // otherwise scroll the window.
      return _findReviewScrollable() || document.scrollingElement || document.documentElement;
    },

    async sortByNewest() {
      // Booking uses a "Sort by" dropdown. It's typically a <select> in the
      // modal, or a button that opens a menu on the property page.
      const selectEl = Array.from(document.querySelectorAll('select')).find(s => {
        const opts = Array.from(s.options || []);
        return opts.some(o => /newest first|date newer to older/i.test(o.textContent));
      });
      if (selectEl) {
        const newestOpt = Array.from(selectEl.options).find(o =>
          /newest first|date newer to older/i.test(o.textContent)
        );
        if (!newestOpt) return false;
        selectEl.value = newestOpt.value;
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1500);
        return true;
      }

      const sortBtn = Array.from(document.querySelectorAll('button, [role="button"]'))
        .find(el => {
          const label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
          return /sort/.test(label) && label.length < 60;
        });
      if (!sortBtn) return false;
      sortBtn.click();
      await sleep(400);

      const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], li, button');
      const newest = Array.from(menuItems).find(el => {
        const t = el.textContent.trim();
        return t.length < 40 && /^(newest first|newest|date newer to older|most recent)$/i.test(t);
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

        const btns = Array.from(card.querySelectorAll('button, [role="button"], span[role="button"]'));
        const moreBtn = btns.find(b => {
          const t = b.textContent.trim().toLowerCase();
          return t === 'read more' || t === 'show more' || t === 'more' || t === 'read full review';
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
      const dateText = _bkExtractDateText(el);
      const parsedDate = parseAnyDate(dateText);
      return {
        id:         _bkExtractId(el),
        reviewer:   _bkExtractReviewer(el),
        title:      _bkExtractTitle(el),
        stars:      _bkExtractStars(el),
        dateText,
        date:       parsedDate ? localDateStr(parsedDate) : null,
        reviewText: _bkExtractReviewText(el),
      };
    },

    async advance(container) {
      // Try pagination first — Booking's review modal has explicit next-page
      // buttons. If we're on the inline property view, "Show more reviews"
      // may be visible. Falls back to scrolling `container`.
      const nextBtn = _bkFindNextButton();
      if (nextBtn && !nextBtn.disabled && nextBtn.getAttribute('aria-disabled') !== 'true') {
        const prevMarker = _bkFirstCardMarker();
        nextBtn.scrollIntoView({ block: 'center' });
        nextBtn.click();
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          await sleep(400);
          if (_bkFirstCardMarker() !== prevMarker) return 'progressed';
        }
        return 'stalled';
      }

      const showMore = _bkFindShowMoreButton();
      if (showMore && !showMore.disabled) {
        const prevCount = _findCards().length;
        showMore.scrollIntoView({ block: 'center' });
        showMore.click();
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          await sleep(400);
          if (_findCards().length > prevCount) return 'progressed';
        }
        return 'stalled';
      }

      // Scroll fallback. If container is the window (documentElement/scrollingElement),
      // use window.scrollTo; otherwise scroll the element directly.
      const isWindowScroller =
        container === document.scrollingElement || container === document.documentElement;
      if (isWindowScroller) {
        const prev = window.scrollY;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(1200);
        return window.scrollY === prev ? 'stalled' : 'progressed';
      }
      const prev = container.scrollHeight;
      container.scrollTop = container.scrollHeight;
      await sleep(1200);
      return container.scrollHeight === prev ? 'stalled' : 'progressed';
    },
  };

  // ─── Private helpers ───────────────────────────────────────────────────────

  function _bkFirstCardMarker() {
    const first = _findCards()[0];
    if (!first) return null;
    return first.getAttribute('data-review-id')
      || first.getAttribute('data-testid')
      || first.textContent.slice(0, 60);
  }

  function _bkFindNextButton() {
    return (
      document.querySelector('[data-testid="pagination-next"]')
      || document.querySelector('button[aria-label="Next page"]')
      || document.querySelector('a[aria-label="Next page"]')
      || document.querySelector('.bui-pagination__next-arrow a')
      || null
    );
  }

  function _bkFindShowMoreButton() {
    return Array.from(document.querySelectorAll('button, [role="button"], a'))
      .find(b => {
        const t = b.textContent.trim().toLowerCase();
        return t === 'show more reviews' || t === 'read all reviews' || t === 'load more reviews';
      }) || null;
  }

  function _bkExtractId(el) {
    const explicit =
      el.getAttribute('data-review-id')
      || el.getAttribute('data-reviewid')
      || el.id;
    if (explicit) return explicit;
    const reviewer = _bkExtractReviewer(el) || '';
    const dt = _bkExtractDateText(el) || '';
    const title = _bkExtractTitle(el) || '';
    // Include title AND full-text length. Booking's empty-comment cards look
    // near-identical (same name, same date, same "Exceptional" title, same
    // "There are no comments…" placeholder), so we also fold in the review-
    // score element's text — the numeric score of empty-comment cards can
    // still differ, and even when it doesn't, the DOM order guarantees each
    // card gets a unique combined string via the parent hash below.
    const bodyLen = (el.textContent || '').length;
    return `bk:${reviewer}|${dt}|${title}|${bodyLen}`;
  }

  function _bkExtractTitle(el) {
    // <h4 data-testid="review-title">Exceptional</h4> — Booking's per-review
    // header ("Exceptional", "Wonderful", "Nice", or the guest's own
    // headline). Kept separate from `reviewer` so the reviewer field
    // actually carries the person's name.
    const h = el.querySelector('h4[data-testid="review-title"]')
      || el.querySelector('[data-testid="review-title"]');
    const t = h?.textContent?.trim();
    return t || null;
  }

  function _bkExtractReviewer(el) {
    // Preferred: explicit test IDs (present on newer layouts).
    const explicit = (
      el.querySelector('[data-testid="review-avatar-name"]')
      || el.querySelector('[data-testid="reviewer-name"]')
      || el.querySelector('.bui-avatar-block__title')
      || el.querySelector('.c-guest__name')
    );
    if (explicit?.textContent?.trim()) return explicit.textContent.trim();

    // Current Booking layout: the name is a leaf DIV sitting next to the
    // avatar circle inside [data-testid="review-avatar"]. We must NOT
    // fall through to h4 — that's the review title ("Exceptional",
    // "Wonderful", or the guest's own headline) and would masquerade as
    // the reviewer name.
    const avatar = el.querySelector('[data-testid="review-avatar"]');
    if (avatar) {
      for (const d of avatar.querySelectorAll('div')) {
        const txt = (d.textContent || '').trim();
        if (!txt || txt.length > 60) continue;
        // Skip the initial-letter circle (single char, e.g. "E").
        if (/^\p{L}$/u.test(txt)) continue;
        // Skip the meta line ("11 reviews", "Georgia", etc.) — that div
        // has child elements; the name div is a text-only leaf.
        if (d.querySelector('img, span, div, a')) continue;
        return txt;
      }
    }

    // Last-ditch: the vote button's aria-label reads
    // "Mark the review by <Name> from <Country> as helpful."
    const vote = el.querySelector('[data-testid="VOTE_HELPFUL"], [data-testid="VOTE_NOT_HELPFUL"]');
    if (vote) {
      const m = (vote.getAttribute('aria-label') || '').match(/by\s+(.+?)\s+from\s/i);
      if (m) return m[1].trim();
    }
    return null;
  }

  // Booking uses a 1–10 scale. Normalise to 1–5 (round half-up) so the
  // schema matches Maps/TripAdvisor/Expedia.
  function _bkExtractStars(el) {
    // Explicit score container — text is often just "8.5".
    const scoreEl = (
      el.querySelector('[data-testid="review-score"]')
      || el.querySelector('.bui-review-score__badge')
      || el.querySelector('.c-score-bar__score')
      || el.querySelector('.review-score-badge')
    );
    if (scoreEl) {
      const m = scoreEl.textContent.trim().match(/(\d+(?:[.,]\d+)?)/);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        if (val >= 0 && val <= 10) return Math.round(val / 2);
      }
    }
    // Aria label fallback: "Scored 8.5", "8.5 out of 10", "Rated 8.5"
    const aria = el.querySelector('[aria-label*="out of 10"], [aria-label*="Scored"], [aria-label*="Rated"]');
    if (aria) {
      const m = (aria.getAttribute('aria-label') || '').match(/(\d+(?:[.,]\d+)?)/);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        if (val >= 0 && val <= 10) return Math.round(val / 2);
      }
    }
    // Text-node walker for a bare "8.5" or "8,5"
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      const m = n.nodeValue.trim().match(/^(10|[0-9](?:[.,]\d)?)$/);
      if (m) {
        const val = parseFloat(m[1].replace(',', '.'));
        if (val >= 0 && val <= 10) return Math.round(val / 2);
      }
    }
    return null;
  }

  function _bkExtractDateText(el) {
    const time = el.querySelector('time[datetime]');
    if (time) {
      const dt = time.getAttribute('datetime').trim();
      if (dt) return dt;
    }
    const candidates = [
      '[data-testid="review-date"]',
      '.c-review-block__date',
      '.review-block__date',
    ];
    for (const sel of candidates) {
      const node = el.querySelector(sel);
      if (node) {
        const raw = node.textContent.trim();
        if (raw && isAnyDate(raw)) return raw;
        const stripped = raw.replace(/^(reviewed|posted|written|stayed)[:\s]+/i, '');
        if (stripped && isAnyDate(stripped)) return stripped;
      }
    }
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

  // Booking splits reviews into "Liked" and "Disliked". Merge them into one
  // string so the schema stays uniform with the other adapters.
  function _bkExtractReviewText(el) {
    const positive =
      el.querySelector('[data-testid="review-positive-text"]')?.textContent?.trim()
      || el.querySelector('.c-review__body--positive')?.textContent?.trim()
      || '';
    const negative =
      el.querySelector('[data-testid="review-negative-text"]')?.textContent?.trim()
      || el.querySelector('.c-review__body--negative')?.textContent?.trim()
      || '';

    if (positive || negative) {
      const parts = [];
      if (positive) parts.push(`Liked: ${positive}`);
      if (negative) parts.push(`Disliked: ${negative}`);
      return parts.join(' | ');
    }

    // Some templates put the whole review in a single body.
    const singleBody = (
      el.querySelector('[data-testid="review-text"]')?.textContent?.trim()
      || el.querySelector('.c-review')?.textContent?.trim()
    );
    if (singleBody && singleBody.length > 10) return singleBody;

    // Fallback: longest paragraph-like span/p/div.
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
