# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 extension (`manifest.json`) that scrapes reviews from Google Maps, TripAdvisor, Expedia, and Booking.com within a user-selected date range and downloads them as JSON. No build step, no tests, no package manager — plain JS files loaded directly as content scripts. The whole runtime is `utils.js` + one adapter per site + `content.js` + `background.js`.

## Load / run / iterate

- Load unpacked at `chrome://extensions` → Developer mode → "Load unpacked" → point at repo root.
- After editing any file, hit the reload icon on the extension card; content scripts re-inject on next page load (or via the "SPA navigation guard" — see below).
- The extension icon toggles the panel (`background.js` sends `toggle-panel`; if no content script is present it programmatically injects the whole list from `CONTENT_FILES`).
- Debug per-adapter in DevTools: logs are tagged `[Reviews:maps]`, `[Reviews:tripadvisor]`, etc.
- Version bumps: edit `manifest.json` `version`. Host permissions and content-script `matches` are duplicated in `manifest.json` — keep the two lists in sync when adding a new locale/TLD.

## Architecture: per-site adapter pattern

`content.js` is site-agnostic. All site-specific DOM knowledge lives in one file per platform under `adapters/`. Every adapter self-registers by pushing an object onto `window.REVIEW_ADAPTERS` (see the IIFE at the bottom of `adapters/maps.js`). At init, `content.js#pickAdapter` picks the first adapter whose `detect()` returns true for the current URL.

**Adapter contract** (all four adapters implement this — grep for the method to compare implementations):

| Method | Sync/Async | Purpose |
|---|---|---|
| `name`, `label` | prop | Short id (used in filenames + log tag) and panel title |
| `detect()` | sync | URL-based check; first truthy wins |
| `getBusinessName()` | sync | Used for the download filename |
| `findReviewsContainer()` | async | The scroll/pagination root passed to `advance()` |
| `sortByNewest()` | async | Returns `true` on success; `false` disables early-stop in `runCrawl` |
| `expandVisibleMoreButtons()` | async | Click "More" to un-truncate before extraction |
| `getReviewElements()` | sync | Returns a NodeList/Array of review card elements |
| `extractReview(el)` | sync | Returns `{ id, reviewer, stars, dateText, date, reviewText }` |
| `advance(container)` | async | Returns `'progressed'` or `'stalled'` — scroll, or click "next page" / "show more" |

`content.js#runCrawl` is the shared driver. Bug fixes to the crawl loop (sort handling, pagination stalls, early-stop, dedup, empty-scroll safeguards) belong in `content.js`; bug fixes to selectors or per-site quirks belong in the adapter.

## Load order matters

`manifest.json`'s `content_scripts.js` array is ordered:

```
utils.js → adapters/maps.js → adapters/tripadvisor.js → adapters/expedia.js → adapters/booking.js → content.js
```

All files run in the page's isolated world with `'use strict'` — they share the same global scope, so `utils.js` helpers (`sleep`, `waitForElement`, `parseAnyDate`, `parseRelativeDate`, `parseAbsoluteDate`, `isRelativeDate`, `isAbsoluteDate`, `localDateStr`) are called directly from adapters. Adapters wrap in an IIFE only to keep their private helpers out of the global scope; the adapter *object* is exported by pushing onto `window.REVIEW_ADAPTERS`. `background.js#CONTENT_FILES` must be kept in the same order as the manifest — it's the fallback injection path when the content script isn't present yet.

## Date parsing is the load-bearing part

Reviews mix relative ("2 months ago") and absolute ("June 15, 2026") formats, sometimes prefixed ("Reviewed on…", "Stayed…", "Date of stay:"). `utils.js` centralises this — never inline date parsing inside an adapter.

- `parseAnyDate(text)` — relative first, then absolute. This is what adapters call in `extractReview`. Maps uses `parseRelativeDate` directly (it's relative-only).
- `isAnyDate(text)` / `isRelativeDate(text)` — used to *identify* which text node holds the date when walking the review card. Patterns are **anchored** on purpose so a review body like "I went there 3 days ago" does not false-positive as a date. Do not remove the `^…$` anchors.
- `_stripDatePrefix` handles "Written/Reviewed/Posted/Stayed/Updated/Edited [on] …" and "Date of stay:" — extend this rather than the individual parsers when you see a new prefix.
- Georgian relative dates are supported (`კვირის წინ`, `ახლახანს`, etc.) — keep them when touching `parseRelativeDate` / `isRelativeDate`.
- Always format dates for display/output via `localDateStr(d)`, never `toISOString().slice(0,10)` — `toISOString` shifts the date back a day for users east of UTC.

## Crawl-loop invariants (`content.js#runCrawl`)

- Reviews are deduped by `review.id` in a `Set` — adapters must return a stable, unique id per card.
- Early-stop after `MAX_CONSECUTIVE_TOO_OLD` (=5) reviews older than the from-date, **but only when sorted-by-newest succeeded**. If `sortByNewest()` returns false, the crawler scans the whole list.
- `MAX_EMPTY_SCROLLS` (=6) guards against infinite loops when the DOM has cards but no new ids appear (page didn't actually turn) or `advance()` returns `'stalled'`.
- Reviews with unparseable dates are counted in `skippedUndated` and logged, not included.
- Date range is inclusive on both ends; the `To` input is expanded to `23:59:59.999` local time (see `runCrawl` — the `T00:00:00` / `T23:59:59.999` suffixes exist to force local-time parsing).

## SPA navigation

Maps/TripAdvisor/Expedia are SPAs — content scripts don't re-run on in-app navigation. `content.js#watchForNavigation` polls `location.href` every 1s and re-runs `init()` after URL changes. When adding a new adapter, verify it survives an in-app nav (search → click a listing → check panel re-injects).

## When adding a new site

1. Create `adapters/<site>.js` following the contract table above; end with `window.REVIEW_ADAPTERS.push(adapter)` inside an IIFE.
2. Add the file to `manifest.json#content_scripts.js` (before `content.js`) **and** to `background.js#CONTENT_FILES` in the same position.
3. Add every locale TLD you support to both `host_permissions` and `content_scripts.matches` in `manifest.json`.
4. If the site's dates use a new prefix or a new relative-date phrasing, extend `utils.js` — don't inline the parser.
