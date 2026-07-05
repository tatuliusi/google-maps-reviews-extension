/**
 * utils.js — Shared helpers for Reviews Extractor
 * Loaded before all adapter and content scripts by the manifest.
 */

'use strict';

// ─── Sleep ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── DOM waiting ──────────────────────────────────────────────────────────────

function waitForElement(selector, timeout = 5000, root = document) {
  return new Promise((resolve, reject) => {
    const existing = root.querySelector(selector);
    if (existing) { resolve(existing); return; }
    const deadline = Date.now() + timeout;
    const interval = setInterval(() => {
      const el = root.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error(`waitForElement timed out: ${selector}`));
      }
    }, 200);
  });
}

function waitForElements(selector, timeout = 5000, root = document) {
  return new Promise((resolve, reject) => {
    const existing = root.querySelectorAll(selector);
    if (existing.length) { resolve(existing); return; }
    const deadline = Date.now() + timeout;
    const interval = setInterval(() => {
      const els = root.querySelectorAll(selector);
      if (els.length) {
        clearInterval(interval);
        resolve(els);
      } else if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error(`waitForElements timed out: ${selector}`));
      }
    }, 200);
  });
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

// Format a Date as YYYY-MM-DD using LOCAL calendar (not UTC), so dates don't
// shift backwards for users in UTC+ timezones when we call toISOString().
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dateInRange(date, from, to) {
  if (!date) return true; // conservative inclusion when unparseable
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const f = new Date(from); f.setHours(0, 0, 0, 0);
  const t = new Date(to);   t.setHours(0, 0, 0, 0);
  return d >= f && d <= t;
}

/**
 * Return true if `text` looks like a relative date string that
 * parseRelativeDate() knows how to handle.
 *
 * Handles English: "2 months ago", "a week ago", "just now"
 * Handles Georgian: "3 კვირის წინ", "ახლახანს"
 *
 * @param {string} text
 * @returns {boolean}
 */
function isRelativeDate(text) {
  if (!text) return false;
  // Strip common review-prefix words. Maps uses "Edited"/"Updated";
  // TripAdvisor/Expedia use "Reviewed"/"Posted"/"Written"/"Stayed" (optionally
  // followed by "on"). All get stripped so the anchored pattern below matches.
  const PREFIX_RE = /^(edited|updated|reviewed|posted|written|stayed)(\s+on)?\s+/i;
  const s = text.trim().toLowerCase().replace(PREFIX_RE, '');
  const raw = text.trim().replace(PREFIX_RE, '');
  // Patterns MUST be anchored — otherwise a review body like
  // "I went there 3 days ago" would false-positive as a date.
  return (
    s === 'just now'
    || s === 'moments ago'
    || s === 'today'
    || s === 'yesterday'
    || /^\d+\s+(minute|hour|day|week|month|year)s?\s+ago$/.test(s)
    || /^(a|an)\s+(minute|hour|day|week|month|year)\s+ago$/.test(s)
    || /^\d+\s+(წამის|წუთის|საათის|დღის|კვირის|თვის|წლის)\s+წინ$/.test(raw)
    || raw === 'ახლახანს'
  );
}

/**
 * Convert a Google Maps relative date string to an approximate Date.
 * Returns null if the string is not recognised.
 *
 * English examples: "2 months ago", "a week ago", "just now"
 * Georgian examples: "3 კვირის წინ", "1 დღის წინ", "ახლახანს"
 *
 * @param {string} text
 * @returns {Date|null}
 */
function parseRelativeDate(text) {
  if (!text) return null;
  // Strip the same review-prefix words that isRelativeDate strips.
  const PREFIX_RE = /^(edited|updated|reviewed|posted|written|stayed)(\s+on)?\s+/i;
  const s = text.trim().replace(PREFIX_RE, '');
  const lower = s.toLowerCase();

  if (lower === 'just now' || lower === 'moments ago' || lower === 'today' || s === 'ახლახანს') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  if (lower === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // English: "2 months ago", "a week ago", "an hour ago"
  const enMatch = lower.match(
    /^(?:(\d+)|a|an)\s+(minute|hour|day|week|month|year)s?\s+ago$/
  );
  if (enMatch) {
    const n = enMatch[1] ? parseInt(enMatch[1], 10) : 1;
    const unit = enMatch[2];
    const d = new Date();
    if      (unit === 'minute') d.setMinutes(d.getMinutes() - n);
    else if (unit === 'hour')   d.setHours(d.getHours() - n);
    else if (unit === 'day')    d.setDate(d.getDate() - n);
    else if (unit === 'week')   d.setDate(d.getDate() - n * 7);
    else if (unit === 'month')  d.setMonth(d.getMonth() - n);
    else if (unit === 'year')   d.setFullYear(d.getFullYear() - n);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Georgian: "3 კვირის წინ"
  const geoMatch = s.match(
    /^(\d+)\s+(წამის|წუთის|საათის|დღის|კვირის|თვის|წლის)\s+წინ$/
  );
  if (geoMatch) {
    const n = parseInt(geoMatch[1], 10);
    const unit = geoMatch[2];
    const d = new Date();
    if      (unit === 'წამის') d.setSeconds(d.getSeconds() - n);
    else if (unit === 'წუთის') d.setMinutes(d.getMinutes() - n);
    else if (unit === 'საათის') d.setHours(d.getHours() - n);
    else if (unit === 'დღის')   d.setDate(d.getDate() - n);
    else if (unit === 'კვირის') d.setDate(d.getDate() - n * 7);
    else if (unit === 'თვის')   d.setMonth(d.getMonth() - n);
    else if (unit === 'წლის')   d.setFullYear(d.getFullYear() - n);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  return null;
}

// ─── Absolute-date helpers ────────────────────────────────────────────────────
// TripAdvisor / Expedia mix absolute and relative dates. We support the common
// English formats seen on those sites. Everything else falls back to null so
// the crawler can log-and-skip instead of guessing.

const MONTHS = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

// Strip review-prefix words like "Written", "Reviewed on", "Posted", "Stayed",
// "Date of stay:" — TripAdvisor/Expedia wrap the actual date in these.
function _stripDatePrefix(text) {
  return text
    .trim()
    .replace(/^(written|reviewed|posted|stayed|updated|edited)(\s+on)?\s+/i, '')
    .replace(/^date\s+of\s+(stay|review|visit)\s*[:\-]?\s*/i, '')
    .replace(/^stay\s+date\s*[:\-]?\s*/i, '')
    .replace(/,\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Return true if `text` looks like an absolute date we can parse.
 * @param {string} text
 * @returns {boolean}
 */
function isAbsoluteDate(text) {
  if (!text) return false;
  return parseAbsoluteDate(text) !== null;
}

/**
 * Parse an absolute English date. Returns null if not recognised.
 * Handles: "June 15, 2026", "Jun 15 2026", "15 June 2026",
 *          "2026-06-15", "06/15/2026", "June 2026" (→ first-of-month).
 *
 * @param {string} text
 * @returns {Date|null}
 */
function parseAbsoluteDate(text) {
  if (!text) return null;
  const s = _stripDatePrefix(text);
  if (!s) return null;

  // ISO: 2026-06-15
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    d.setHours(0, 0, 0, 0);
    return isNaN(d) ? null : d;
  }

  // Numeric: 6/15/2026 or 15/6/2026 — ambiguous, but TripAdvisor/Expedia US
  // locales use MM/DD/YYYY. Prefer that; fall back to DD/MM/YYYY if month > 12.
  const num = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (num) {
    let a = parseInt(num[1], 10);
    let b = parseInt(num[2], 10);
    let y = parseInt(num[3], 10);
    if (y < 100) y += 2000;
    let month, day;
    if (a > 12) { day = a; month = b; }        // must be DD/MM
    else if (b > 12) { month = a; day = b; }   // must be MM/DD
    else { month = a; day = b; }               // ambiguous — assume MM/DD (US)
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(y, month - 1, day);
    d.setHours(0, 0, 0, 0);
    return isNaN(d) ? null : d;
  }

  // Month-name formats. Split on whitespace, look for a month token.
  const parts = s.toLowerCase().split(/\s+/);
  let monthIdx = -1;
  let monthPos = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] in MONTHS) {
      monthIdx = MONTHS[parts[i]];
      monthPos = i;
      break;
    }
  }
  if (monthIdx < 0) return null;

  // Find a 4-digit year and (optional) 1–2-digit day anywhere in the tokens.
  let year = null;
  let day = null;
  for (let i = 0; i < parts.length; i++) {
    if (i === monthPos) continue;
    const n = parseInt(parts[i], 10);
    if (isNaN(n)) continue;
    if (n >= 1000 && n <= 9999) year = n;
    else if (n >= 1 && n <= 31 && day === null) day = n;
  }
  if (year === null) return null;
  if (day === null) day = 1; // month-only ("June 2026") → first-of-month

  const d = new Date(year, monthIdx, day);
  d.setHours(0, 0, 0, 0);
  return isNaN(d) ? null : d;
}

/**
 * Try relative-date first, then absolute. Returns Date or null.
 * Adapters should call this instead of the individual parsers when the
 * date format may be either style.
 *
 * @param {string} text
 * @returns {Date|null}
 */
function parseAnyDate(text) {
  return parseRelativeDate(text) || parseAbsoluteDate(text);
}

/**
 * Combined predicate: does this text look like *some* date we can parse?
 * @param {string} text
 * @returns {boolean}
 */
function isAnyDate(text) {
  return isRelativeDate(text) || isAbsoluteDate(text);
}
