/**
 * utils.js — Shared helpers for Maps Reviews Extractor
 * Loaded before content.js by the manifest.
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
  // Strip "Edited "/"Updated " prefix (Google Maps adds it to edited reviews)
  const s = text.trim().toLowerCase().replace(/^(edited|updated)\s+/, '');
  const raw = text.trim().replace(/^(edited|updated)\s+/i, '');
  // Patterns MUST be anchored — otherwise a review body like
  // "I went there 3 days ago" would false-positive as a date.
  return (
    s === 'just now'
    || s === 'moments ago'
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
  // Strip "Edited "/"Updated " prefix before parsing
  const s = text.trim().replace(/^(edited|updated)\s+/i, '');
  const lower = s.toLowerCase();

  if (lower === 'just now' || lower === 'moments ago' || s === 'ახლახანს') {
    const d = new Date();
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
