# SEO Suite

Production-grade SEO tooling for the Page Builder CMS. Automatically injects per-page meta tags, Open Graph tags, Twitter card tags, and JSON-LD structured data into every published page. Generates a sitemap.xml and robots.txt that search engines can discover. Optionally generates OG images via a configurable provider endpoint.

---

## What it does

- **Per-page meta injection** — title override, meta description, OG/Twitter tags, canonical URL, noindex/nofollow, and custom JSON-LD are injected into every published page's `<head>` immediately before `</head>`.
- **Automatic page discovery** — the sitemap enumerates pages directly via `api.cms.pages.list()`, so it is complete immediately after install without requiring any pages to be re-published. Per-page metadata (title, canonical URL, no-index flag) is captured from the `publish.html` filter on each publish and stored in the page index for the admin dashboard.
- **Sitemap.xml** — generated from the page index, skipping `no-index` pages. Updated every publish.
- **Robots.txt** — operator-editable content with the `Sitemap:` directive appended automatically.
- **OG image generation** — a daily 02:30 UTC job calls your provider endpoint for any page that has been rendered but has no OG image set.
- **Admin dashboard** — at-a-glance SEO health for every discovered page, with an inline editor for all SEO fields.

---

## Install

1. Build the plugin from the repo root:
   ```sh
   bun run pb-plugin build examples/plugins/seo-suite
   ```
   This produces `examples/plugins/seo-suite.plugin.zip`.

2. In the admin, go to **Plugins → Upload** and select the zip.

3. Grant all requested permissions.

4. Open the plugin's **Settings** and set at minimum **Site URL** (required).

---

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `siteName` | text | — | Used in JSON-LD `WebSite` schema and fallback OG site name. |
| `siteUrl` | url | **yes** | Canonical root URL (no trailing slash). Example: `https://example.com`. |
| `defaultOgImage` | url | — | Fallback OG image when a page has no specific OG image. |
| `twitterHandle` | text | — | Site-level `@handle` for `twitter:site`. Include the `@`. |
| `robotsTxt` | textarea | — | Full `robots.txt` content (the `Sitemap:` line is appended automatically). Default: `User-agent: *\nAllow: /`. |
| `ogImageProviderUrl` | url | — | POST endpoint for OG image generation (see [OG Image Provider](#og-image-provider)). |
| `enableJsonLd` | toggle | — | Inject `WebPage` + `WebSite` JSON-LD on every page. Default: `true`. |
| `defaultNoIndex` | toggle | — | No-index all pages by default unless individually set to indexable. Default: `false`. |

---

## Routes exposed

| Route | Auth | Description |
|-------|------|-------------|
| `GET /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/sitemap.xml` | none | XML sitemap |
| `GET /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/robots.txt` | none | robots.txt |
| `GET /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/seo-entries` | admin | List all SEO entries (used by admin dashboard) |
| `POST /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/seo-entries` | admin | Upsert a SEO entry (used by admin dashboard) |
| `GET /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/page-index` | admin | List the page index (used by admin dashboard) |

### Reverse-proxy to the site root

Search engines expect sitemap.xml and robots.txt at the site root. Proxy the plugin routes there.

**Caddy:**
```caddyfile
example.com {
  handle /sitemap.xml {
    rewrite * /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/sitemap.xml
    reverse_proxy localhost:5173
  }
  handle /robots.txt {
    rewrite * /admin/api/cms/plugins/pagebuilder.seo-suite/runtime/robots.txt
    reverse_proxy localhost:5173
  }
  reverse_proxy localhost:5173
}
```

**nginx:**
```nginx
server {
  listen 80;
  server_name example.com;

  location = /sitemap.xml {
    proxy_pass http://localhost:5173/admin/api/cms/plugins/pagebuilder.seo-suite/runtime/sitemap.xml;
  }

  location = /robots.txt {
    proxy_pass http://localhost:5173/admin/api/cms/plugins/pagebuilder.seo-suite/runtime/robots.txt;
  }

  location / {
    proxy_pass http://localhost:5173;
  }
}
```

---

## OG Image Provider

The daily job POSTs to `ogImageProviderUrl` for pages that have been rendered but have no OG image.

**Request:**
```json
POST https://og.example.com/generate
Content-Type: application/json

{
  "title": "My Page Title",
  "description": "Short description of the page.",
  "siteName": "My Website",
  "url": "https://example.com/my-page"
}
```

**Response:**
```json
200 OK
Content-Type: application/json

{ "url": "https://og.example.com/result/abc123.png" }
```

Self-hosted example: [vercel/og](https://github.com/vercel/og) (runs on Edge Runtime; deploy as a separate service and point `ogImageProviderUrl` at its `/api/og` route).

---

## Security notes

### `networkAllowedHosts` is empty by default

The `network.outbound` permission is requested, but `networkAllowedHosts` is **empty** — meaning all outbound calls are denied even after the permission is granted. This is a fail-closed design: a plugin that ships with an empty allowlist cannot phone home unexpectedly.

To enable OG image generation:

1. Edit `pb-plugin.config.ts` and add your provider's hostname:
   ```ts
   networkAllowedHosts: ['og.example.com'],
   ```
2. Rebuild the plugin:
   ```sh
   bun run pb-plugin build examples/plugins/seo-suite
   ```
3. Re-upload the new zip from `/admin/plugins`.

The `networkAllowedHosts` list is part of the signed manifest — operators review it at install time.

### HTML escaping

All operator-controlled values (settings + seo-entry fields) are escaped through `escapeAttr()` before insertion into HTML attributes. JSON-LD content has `</` sequences escaped to `<\/` to prevent script-tag-close injection.

### Page discovery

The sitemap uses `api.cms.pages.list()` to enumerate all published pages directly. No pages need to be re-published after install for the sitemap to be complete. The `publish.html` filter captures per-page metadata (title, canonical URL, last-published timestamp) and stores it in the page index for the admin dashboard's SEO health view.

---

## Architecture notes

The server entrypoint (`server/index.ts`) is split into feature modules:

| File | Responsibility |
|------|---------------|
| `server/sitemap.ts` | `sitemap.xml` + `robots.txt` public routes |
| `server/headInjection.ts` | `publish.html` filter + `page-index` maintenance |
| `server/ogImage.ts` | Daily OG image generation scheduled job |
| `server/seoEntriesRoutes.ts` | Admin REST routes consumed by the dashboard |
| `admin/dashboard.tsx` | Admin dashboard React app |
