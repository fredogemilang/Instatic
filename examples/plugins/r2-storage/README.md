# Cloudflare R2 Storage

Official Page Builder plugin that routes uploaded media to **Cloudflare R2** — S3-compatible object storage with **zero egress fees**. Often the best default for self-hosted CMS deployments that serve a lot of media.

## Why R2 over generic S3?

- **No egress charges.** AWS S3 charges $0.09/GB out. R2 charges $0. For a media-heavy site, that's the line item that ends up dominating storage costs.
- **Single-vendor flow if you already use Cloudflare.** R2 + Cloudflare CDN + Workers in one dashboard.
- **S3 protocol** — same SDK code, same SigV4 signing, just a different endpoint.

This plugin is a sibling of the `Amazon S3 Storage` plugin (same underlying signer, different endpoint shape + auth model). Use this one if you're on R2; use the S3 plugin if you're on AWS or another S3-compatible provider.

## What it does

| Capability | What this plugin does |
|---|---|
| `media.storage.adapter` | Registers an exclusive storage adapter for the Originals + Variants roles. |
| `network.outbound` + `networkAllowedHosts` | Talks to `*.r2.cloudflarestorage.com` and `*.r2.dev` (public bucket host). |
| `crypto.subtle` | Computes AWS SigV4 (SHA-256 + HMAC-SHA256) for every presigned URL. |
| `settings` (with `secret: true`) | Stores R2 API token masked in the admin UI. |
| Adapter declares `cspOrigins` | The publisher adds `https://*.r2.cloudflarestorage.com` + `https://*.r2.dev` to the page CSP automatically. |

The plugin never touches the bytes of an upload — the host's executor streams bytes directly to the presigned PUT URL the plugin produced.

## Build

```bash
bun pb-plugin build examples/plugins/r2-storage
```

Produces `examples/plugins/r2-storage.plugin.zip` (~14 KB).

## Set up Cloudflare R2

1. **Create a bucket** in the [Cloudflare dashboard](https://dash.cloudflare.com/) under R2.
2. **Note the Account ID** — visible on the right rail of the dashboard, or under R2 → "Manage R2 API Tokens".
3. **Create an R2 API token**:
   - R2 → "Manage R2 API Tokens" → "Create API Token".
   - Permission: **Object Read & Write**.
   - Scope: select your bucket (or "All buckets" for a multi-bucket setup).
   - TTL: leave unset for a long-lived token (rotate by creating a new one + updating the plugin settings).
   - Save the **Access Key ID** + **Secret Access Key** Cloudflare shows you — the secret can't be recovered after this screen.
4. **Pick a serving mode**:
   - **Signed redirect** (recommended) — bucket stays private; the host signs read URLs on demand.
   - **Public URL** — enable "Public Bucket" on the R2 bucket (R2 → bucket → Settings → Public Access). Copy the `https://pub-<HASH>.r2.dev/` URL into the plugin's "Public URL base" setting. Alternatively front the bucket with a custom domain (R2 → bucket → Settings → Domains).

## Install in Page Builder

1. Upload `r2-storage.plugin.zip` from `/admin/plugins` and approve the requested permissions:
   - `media.storage.adapter`
   - `network.outbound`
2. Click **Settings** on the plugin card and fill in:
   - **Account ID** — from the R2 dashboard.
   - **R2 Access Key ID** + **R2 Secret Access Key** — from the API token you just created.
   - **Bucket name** — must already exist.
   - **Jurisdiction** — `standard` for most users; `eu` for EU-data-localised buckets; `fedramp` for US government compliance.
   - **Read serving mode** — `signed-redirect` for private buckets, `public-url` for `r2.dev` or custom-domain public buckets.
   - **Public URL base** — required only if `Read serving mode = public-url`.
   - **Object key prefix** — optional, e.g. `media/`.
3. Open Media → Storage panel. Click **Test connection** on the Cloudflare R2 row — the plugin issues a SigV4-signed HEAD against the bucket. You should see a green "OK".
4. **Elect** the adapter for `Originals` (and `Variants` if you want the responsive ladder on R2 too).
5. If you have existing local assets, click **Migrate N pending →** to move them.

## R2 token scopes

The plugin uses the R2 token's S3-compatible credentials (`Access Key ID` + `Secret Access Key`). It does NOT use Cloudflare API tokens (no `X-Auth-Email` / `X-Auth-Key` headers). All requests are authenticated via standard AWS SigV4 query parameters.

A token with **Object Read & Write** scoped to your bucket is exactly the surface this plugin needs:
- `PutObject` (uploads — `beginWrite` signs, host PUTs)
- `GetObject` (signed-redirect reads via `getReadUrl`)
- `DeleteObject` (`abortWrite` cleanup, hard purge)
- `HeadBucket` for the **Test connection** button

## R2 vs AWS S3 — the differences this plugin handles

| Concept | AWS S3 | Cloudflare R2 |
|---|---|---|
| Endpoint URL | `<bucket>.s3.<region>.amazonaws.com` (virtual-hosted-style) | `<accountId>.r2.cloudflarestorage.com/<bucket>/<key>` (path-style) |
| Region in SigV4 | the actual AWS region (e.g. `us-east-1`) | always `auto` |
| Service in SigV4 credential scope | `s3` | `s3` (same — anything else gets rejected) |
| Custom domains for presigned URLs | Not supported (use CloudFront with a behaviour) | Not supported (custom domains + presigned auth don't mix) |
| Bucket-name DNS restrictions | Wildcard cert requires single-segment bucket | N/A (bucket is in the path) |
| Public bucket URL | requires `s3:GetObject` ALLOW in bucket policy | `r2.dev` host (free) OR custom domain via DNS |
| Max presigned URL expiry | 7 days | 7 days (same) |
| Egress fees | $0.09 / GB out | $0 |

## Limitations (v1)

- **Single-PUT only** — no multipart upload. The CMS's 50 MB upload cap is well below R2's 5 GB single-PUT limit.
- **Custom domains can't be used for `signed-redirect`** — Cloudflare doesn't support presigned authentication on custom domains. Use `public-url` mode with a custom domain instead (public bucket + DNS).
- **Settings hot-reload requires plugin restart** — pre-existing limitation affecting every plugin.

## Trust model

- Plugin runs in QuickJS-WASM with no access to Node/Bun built-ins, no filesystem, no network outside `*.r2.cloudflarestorage.com` + `*.r2.dev`.
- R2 token secret stored as a `secret: true` setting — masked in the admin UI; the plugin reads the actual value via `api.cms.settings.get(...)`.
- The plugin signs URLs in the sandbox; the host streams bytes outside the sandbox. Same byte path the local-disk adapter uses.

## Tests

```bash
bun test src/__tests__/plugins/r2-sigv4.test.ts
```

Verifies:
- Credential scope uses `auto/s3` (R2's documented values).
- URL is path-style — bucket as first segment.
- Jurisdiction-scoped endpoints (EU, FedRAMP) sign the same way.
- Standard X-Amz-* query params, signature is a 64-char HMAC-SHA256 hex digest.
- Object keys with slashes preserve their structure in the URL path.
