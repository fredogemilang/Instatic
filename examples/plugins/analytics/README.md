# Analytics Plugin

Self-hosted, privacy-first analytics for Page Builder. A Plausible/Fathom alternative built on the host's frontend tracker. **No third-party services. All data stays in your CMS database.**

## What it tracks

| Signal | How |
|---|---|
| Page views | Fires on every published page load via the host tracker IIFE |
| Link clicks | Fires on every `<a href>` click (outbound flag computed client-side) |
| Scroll depth | Fires at 25%, 50%, 75%, and 100% scroll landmarks |
| Web Vitals | LCP, CLS, FID — flushed on page hide / tab close |
| Bounce | Sessions with 0 interactions in < 10 s — flushed on page hide |

## Privacy guarantees

- **No IPs stored.** The host rate-limits on IP internally; the IP is never forwarded to the plugin.
- **No raw visitor IDs stored.** Each visitor gets a daily-rotating SHA-256 hash: `SHA-256(salt + visitorId + YYYY-MM-DD)`. The same visitor has a different hash every day. A compromised database reveals nothing about identity.
- **No User-Agent stored raw.** The UA is used server-side to classify the device (desktop/mobile/tablet/bot) and then discarded.
- **Do-Not-Track honoured by default.** When `respectDnt` is on, browsers with DNT=1 receive no tracking code.
- **Client-side opt-out.** Any visitor can opt out by running `localStorage.setItem('__pb_analytics_optout', '1')` in their browser console.

## Settings

| Setting | Default | Description |
|---|---|---|
| `salt` | Auto-generated 32-char hex | Secret used to hash visitor IDs. Changing this resets all visitor identity history. |
| `retentionDays` | 90 | Raw events older than this are deleted by the nightly prune job. |
| `respectDnt` | true | Honour the browser's Do-Not-Track signal. |
| `excludeAdmins` | true | Do not record events from admin sessions. |
| `excludePaths` | (empty) | Newline-separated glob patterns — matching page paths are ignored. Example: `/admin/*` |
| `excludeIps` | (empty) | Newline-separated IPs to ignore (matched against X-Forwarded-For). |
| `publicStatsToken` | (empty) | Non-empty enables the public stats endpoint. Keep this secret. |

### Excluding paths

Use Unix-style globs:

```
/admin/*
/api/**
/preview/*
```

`*` matches any single path segment. `**` matches any depth.

## Public stats endpoint

Set `publicStatsToken` to a secret value, then embed aggregate stats on any public page:

```
GET /admin/api/cms/plugins/pagebuilder.analytics/runtime/public-stats.json?token=<your-token>
```

Returns the same 30-day dashboard payload as the admin view.

Example widget using the endpoint:

```html
<div id="stats"></div>
<script>
  fetch('/admin/api/cms/plugins/pagebuilder.analytics/runtime/public-stats.json?token=YOUR_TOKEN')
    .then(r => r.json())
    .then(data => {
      document.getElementById('stats').textContent =
        `${data.summary.pageviews.toLocaleString()} page views in the last 30 days`
    })
</script>
```

## How to opt out of tracking

Visitors can opt out client-side by running this in the browser console:

```js
localStorage.setItem('__pb_analytics_optout', '1')
```

To opt back in:

```js
localStorage.removeItem('__pb_analytics_optout')
```

## Data model

**`events` resource** — raw tracker events, pruned after `retentionDays` days.

| Field | Type | Description |
|---|---|---|
| `name` | text | Event name (`page-view`, `link-click`, `scroll-depth`, `web-vitals`, `bounce`) |
| `path` | text | Page path (`/about`) |
| `visitor-hash` | text | Daily-rotating SHA-256 hash of visitor ID |
| `session` | text | Session storage session ID (resets on tab close) |
| `referrer` | text | `document.referrer` from the frontend |
| `device` | text | `desktop` \| `mobile` \| `tablet` \| `bot` |
| `country` | text | ISO 3166-1 alpha-2 code (from `CF-IPCountry` / `X-Country-Code` headers) |
| `payload` | longtext | JSON of remaining event-specific fields |
| `received-at` | date | Server-side ISO timestamp |

**`daily-stats` resource** — aggregated daily rollup. Read for fast range queries.

| Field | Description |
|---|---|
| `date` | YYYY-MM-DD |
| `pageviews` | Total page-view events |
| `visitors` | Unique visitor hashes |
| `sessions` | Unique session IDs |
| `bounce-rate` | % sessions with exactly one page view |
| `avg-session-seconds` | Mean session duration in seconds |
| `top-pages` | JSON array of `{label, count}` |
| `top-referrers` | JSON array of `{label, count}` |
| `top-countries` | JSON array of `{label, count}` |
| `top-devices` | JSON array of `{label, count}` |

## Architecture

```
frontend/tracker.ts  — IIFE, vanilla JS, bundled onto every published page
server/ingest.ts     — POST /ingest handler, hashing, device classification
server/rollup.ts     — daily aggregate job + retention prune
server/stats.ts      — dashboard query: merges daily-stats + live raw events
server/csv.ts        — RFC 4180 CSV export
admin/dashboard.tsx  — React admin page, custom SVG charts, live feed
```

The server entrypoint runs inside the QuickJS-WASM sandbox — no Node/Bun APIs. SHA-256 is computed via the host's `crypto.subtle` polyfill (falling back to a pure-JS implementation). Scheduled jobs use extended `maxDurationMs: 60_000` budgets.
