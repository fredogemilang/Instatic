# Search Plugin for Page Builder

Full-text search for your Page Builder site. Indexes published pages via **MeiliSearch** or **Typesense** and exposes a fast, rate-limited public search API.

---

## What it does

- **Indexes pages on publish** — when you publish a page, the Search plugin extracts its title, headings, and plain-text content and upserts a document into the configured search engine.
- **Public search API** — a public, rate-limited route (`/admin/api/cms/plugins/pagebuilder.search/runtime/search`) accepts `?q=`, `?page=`, and `?per-page=` parameters and returns JSON results.
- **Canvas modules** — two drag-and-drop blocks you can place on any page:
  - **Search Box** — a labelled `<input type="search">` with an instant-results dropdown.
  - **Search Results** — a full-page results list with pagination (place this on your `/search` page).
- **Admin dashboard** — four tabs: Stats, Documents, Analytics (query log), Index management (reindex / clear).
- **One-click reindex** — the Index management tab has a **Reindex all pages** button that calls `api.cms.pages.republishAll()` server-side, re-running the full publish pipeline for every published page and rebuilding the index from scratch.
- **Query analytics** — optionally stores anonymised queries in plugin storage and shows top-10 queries and top-10 no-result queries in the Analytics tab.

---

## Supported backends

| Backend | Auth header | Notes |
|---|---|---|
| [MeiliSearch](https://www.meilisearch.com/) | `Authorization: Bearer <key>` | Self-hosted or Meilisearch Cloud |
| [Typesense](https://typesense.org/) | `X-TYPESENSE-API-KEY: <key>` | Self-hosted or Typesense Cloud |

---

## Install

1. Build the plugin zip: `bun run pb-plugin build examples/plugins/search`
2. Upload `examples/plugins/search.plugin.zip` from `/admin/plugins`.
3. Grant the requested permissions (the install dialog will list them).
4. Open the plugin's **Settings** and configure:
   - **Search backend** — `meilisearch` or `typesense`
   - **Search engine endpoint** — your instance URL (e.g. `https://xyz.meilisearch.io`)
   - **Admin API key** — key with write access (used for indexing)
   - **Search (public) API key** — read-only key (used by the public `/search` route)
5. The plugin will create the index automatically on activation.

---

## Obtaining credentials

### MeiliSearch

1. Sign up at [cloud.meilisearch.com](https://cloud.meilisearch.com) or self-host.
2. Copy your **Host** URL (e.g. `https://ms-xyz.meilisearch.io`).
3. Copy the **Master Key** (or generate scoped Admin/Search API keys from the Meilisearch dashboard).
4. Use the **Master Key** or a write-capable **Admin API Key** as the Admin API key.
5. Use the **Default Search API Key** (or a scoped read-only key) as the Search (public) API key.

### Typesense

1. Sign up at [cloud.typesense.org](https://cloud.typesense.org) or self-host.
2. Copy your **Node URL** (e.g. `https://xyz.a1.typesense.net`).
3. In the Typesense dashboard → API Keys → generate an **Admin** key and a **Search-only** key.
4. Use the Admin key as the **Admin API key** and the Search-only key as the **Search (public) API key**.

---

## networkAllowedHosts — audit boundary

The plugin's manifest declares:

```json
"networkAllowedHosts": [
  "*.meilisearch.io",
  "cloud.typesense.org",
  "*.typesense.net"
]
```

This list is the **audit boundary** for outbound network access from the plugin's sandbox. Even with the `network.outbound` permission granted, the host's gated fetch will reject requests to any host not in this list.

**If you self-host your search engine on a custom domain**, you must fork this plugin (or publish a new version) and add your domain to `networkAllowedHosts`. You cannot change the allowlist at runtime — it is part of the plugin manifest that site operators audit at install time. This is by design: any plugin that can make arbitrary outbound requests to unlimited hosts is a supply-chain risk.

---

## Placing modules on a page

### Search Box

1. In the Page Builder editor, open the module library.
2. Find **Search Box** under the **Search** category.
3. Drop it where you want the search input to appear.
4. Configure in the Properties Panel:
   - **Placeholder** — input hint text
   - **Results page path** — URL of the full results page (default `/search`)
   - **Input label** — accessible label (visually hidden)

The Search Box fetches from the plugin's public route and renders up to 5 results inline. It links to the Results page for "View all results".

### Search Results

1. Create a page at path `/search` (or your preferred path).
2. Drop the **Search Results** module onto the page.
3. Configure:
   - **Results per page** — 1–50 (default 10)
   - **No-results message** — text shown when zero hits are returned
4. The module reads `?q=` and `?page=` from the URL on page load.

---

## Public search API

```
GET /admin/api/cms/plugins/pagebuilder.search/runtime/search
```

No authentication required.

### Query parameters

| Param | Type | Default | Notes |
|---|---|---|---|
| `q` | string | (required) | Search query, max 200 chars |
| `page` | integer | 1 | Page number (1-indexed) |
| `per-page` | integer | 10 | Results per page, max 50 |

### Successful response (200)

```json
{
  "results": [
    { "id": "blog_hello-world", "slug": "/blog/hello-world", "title": "Hello World", "excerpt": "…" }
  ],
  "total": 42,
  "took_ms": 8,
  "query": "hello"
}
```

### Rate limiting (429)

```json
{ "error": "Too many requests", "retry_after": 15 }
```

The `Retry-After` response header is set to the same value. Rate limit: 60 requests per minute per client IP.

---

## Privacy — query analytics opt-out

When **Log search queries** is enabled (default), the plugin stores the query string, result count, and timestamp in plugin storage. **No personal data is stored** — queries are stored as-is without any user identifier.

To disable, open plugin Settings and turn off **Log search queries**. Existing logs can be cleared by uninstalling and reinstalling the plugin (uninstall removes all storage records).

---

## Architecture notes

- **Per-publish indexing** — the `publish.html` filter receives `{ pageId, slug }` directly from the host. The plugin extracts title/headings/content from the rendered HTML and upserts a document into the search engine.
- **Bulk reindex** — `POST /reindex` calls `api.cms.pages.republishAll()`, which re-runs the full publish pipeline (including the `publish.html` filter) for every published page. The admin dashboard's **Reindex all pages** button triggers this route.
- **Document ID** — each page's search document id is derived from its URL slug (slashes → underscores, leading slash stripped). This is stable across republishes.

---

## Caveats

- The `networkAllowedHosts` list covers Meilisearch Cloud and Typesense Cloud hostnames. Self-hosted instances require a custom plugin version with the correct domain in the allowlist.
