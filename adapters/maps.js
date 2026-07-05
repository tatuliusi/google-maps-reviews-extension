/**
 * adapters/maps.js — Google Maps reviews adapter.
 *
 * Self-registers into window.REVIEW_ADAPTERS. content.js picks the first
 * adapter whose detect() returns true.
 */

'use strict';

(function () {
  const REVIEW_CARD_SEL = '.jftiEf[data-review-id]';

  const adapter = {
    name: 'maps',
    label: 'Maps Reviews Extractor',

    detect() {
      return /^https:\/\/www\.google\.[^/]+\/maps(\/|$)/.test(location.href);
    },

    getBusinessName() {
      // Confirmed from HTML: Maps has NO <h1>. Name is in aria-label on
      // role="main", and as the first part of <title>.
      const raw = (
        document.querySelector('[role="main"]')?.getAttribute('aria-label')?.trim()
        || document.querySelector('h1.DUwDvf')?.textContent?.trim()
        || document.querySelector('h1')?.textContent?.trim()
        || document.title.split(' - ')[0].trim()
        || 'unknown'
      );
      // On the Reviews subview, aria-label can be "Reviews for X" / "Reviews of X"
      // (or the Georgian "X-ის მიმოხილვები"). Strip so the filename is clean.
      return raw
        .replace(/^Reviews\s+(for|of)\s+/i, '')
        .replace(/[-–—\s]*Google\s+Maps$/i, '')
        .replace(/\s+/g, ' ')
        .trim() || 'unknown';
    },

    // Confirmed from HTML: role="feed" does NOT exist in Maps.
    // The scrollable pane is .m6QErb[tabindex] or found via overflow walk-up.
    async findReviewsContainer() {
      const tabPane = document.querySelector('.m6QErb[tabindex]');
      if (tabPane) return tabPane;

      let review;
      try {
        review = await waitForElement(REVIEW_CARD_SEL, 15000);
      } catch {
        return null;
      }

      let el = review.parentElement;
      while (el && el !== document.body) {
        const ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll') && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
      }

      return document.querySelector('.m6QErb') || null;
    },

    async sortByNewest() {
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

      const MENU_ROLES = '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="radio"]';
      try {
        await waitForElement(MENU_ROLES, 3000);
      } catch {
        // menu may use a different structure — fall through to text search
      }

      const NEWEST_RE = /newest|უახლესი/i;

      let newestOpt = Array.from(document.querySelectorAll(MENU_ROLES))
        .find(el => NEWEST_RE.test(el.textContent));

      if (!newestOpt) {
        newestOpt = Array.from(document.querySelectorAll('[jsaction]'))
          .find(el => {
            const t = el.textContent.trim();
            return t.length < 25 && NEWEST_RE.test(t);
          });
      }

      if (!newestOpt) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          const t = node.nodeValue.trim();
          if (/^(Newest|უახლესი)$/i.test(t)) {
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
    },

    // Maps already sets data-mr-expanded="1" on its own elements,
    // so we use data-rext-expanded to avoid the conflict.
    async expandVisibleMoreButtons() {
      let clicked = 0;
      for (const reviewEl of document.querySelectorAll(REVIEW_CARD_SEL)) {
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
    },

    getReviewElements() {
      return document.querySelectorAll(REVIEW_CARD_SEL);
    },

    extractReview(el) {
      const dateText = _mapsExtractDateText(el);
      const parsedDate = parseRelativeDate(dateText);
      return {
        id:         el.getAttribute('data-review-id'),
        reviewer:   _mapsExtractReviewer(el),
        stars:      _mapsExtractStars(el),
        dateText,
        date:       parsedDate ? localDateStr(parsedDate) : null,
        reviewText: _mapsExtractReviewText(el),
      };
    },

    async advance(container) {
      const prevScrollHeight = container.scrollHeight;
      container.scrollTop = container.scrollHeight;
      await sleep(1500);
      return container.scrollHeight === prevScrollHeight ? 'stalled' : 'progressed';
    },
  };

  // ─── Maps field extractors (private) ───────────────────────────────────────
  function _mapsExtractStars(el) {
    // Standard Maps layout: <span class="kvMYJc" role="img" aria-label="5 stars">
    const starEl =
      el.querySelector('.kvMYJc[role="img"]')
      || el.querySelector('span[role="img"][aria-label*="star"]');
    if (starEl) {
      const m = (starEl.getAttribute('aria-label') || '').match(/(\d)/);
      if (m) return parseInt(m[1], 10);
    }
    // Hotel layout: <span class="fontBodyLarge fzvQIb">5/5</span>
    const hotelEl = el.querySelector('.fzvQIb');
    if (hotelEl) {
      const m = hotelEl.textContent.trim().match(/^(\d)\/5$/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function _mapsExtractReviewer(el) {
    // Confirmed from HTML: reviewer name is in <div class="d4r55">.
    return el.querySelector('.d4r55')?.textContent?.trim() || null;
  }

  function _mapsExtractDateText(el) {
    for (const sel of ['.rsqaWe', '.dehysf']) {
      const node = el.querySelector(sel);
      if (node) {
        const raw = node.textContent.trim();
        if (raw && isRelativeDate(raw)) return raw;
      }
    }

    // Walk text nodes — works even when class names change.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let textNode;
    while ((textNode = walker.nextNode())) {
      const t = textNode.nodeValue.trim();
      if (t.length > 2 && t.length < 70 && isRelativeDate(t)) return t;
    }

    for (const child of el.querySelectorAll('[aria-label]')) {
      const label = (child.getAttribute('aria-label') || '').trim();
      if (label.length < 70 && isRelativeDate(label)) return label;
    }

    return null;
  }

  function _mapsExtractReviewText(el) {
    // Confirmed from HTML: <span class="wiI7pd"> inside <div class="MyEned">.
    const knownEl = el.querySelector('.wiI7pd') || el.querySelector('[class*="wiI7pd"]');
    if (knownEl) return knownEl.textContent.trim() || null;

    // Fallback: longest span that isn't a date string.
    let best = '';
    for (const span of el.querySelectorAll('span')) {
      const t = span.textContent.trim();
      if (!isRelativeDate(t) && t.length > best.length && t.length > 20) best = t;
    }
    return best || null;
  }

  window.REVIEW_ADAPTERS = window.REVIEW_ADAPTERS || [];
  window.REVIEW_ADAPTERS.push(adapter);
})();
