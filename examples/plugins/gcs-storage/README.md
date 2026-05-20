# Google Cloud Storage

Official Page Builder plugin that routes uploaded media to **Google Cloud Storage** via its S3-compatible XML API.

## Why this plugin

GCS exposes the same S3 protocol surface (SigV4, presigned URLs, canonical-request format), so a single signer module powers the AWS S3, Cloudflare R2, AND GCS plugins. No per-provider crypto fork — the architecture pays off here.

Use this plugin when:
- You're already on Google Cloud (GKE, App Engine, Cloud Run) and want media on the same provider for low-latency colocation.
- You want Cloud CDN's edge network in front of your buckets.
- You need EU / regional data residency and your bucket lives in a specific GCS region.

## What it does

| Capability | What this plugin does |
|---|---|
| `media.storage.adapter` | Registers an exclusive storage adapter for the Originals + Variants roles. |
| `network.outbound` + `networkAllowedHosts` | Talks to `storage.googleapis.com` and `*.storage.googleapis.com`. |
| `crypto.subtle` | Computes AWS4-HMAC-SHA256 (the same algorithm GCS accepts in S3-compat mode). |
| `settings` (with `secret: true`) | Stores the GCS HMAC key masked in the admin UI. |
| Adapter declares `cspOrigins` | Publisher adds `https://storage.googleapis.com` to the page CSP automatically. |

## Build

```bash
bun pb-plugin build examples/plugins/gcs-storage
```

Produces `examples/plugins/gcs-storage.plugin.zip` (~14 KB).

## Set up GCS

1. **Create a bucket** in the [Cloud Console](https://console.cloud.google.com/) → Cloud Storage.
2. **Create a service account** with the role `Storage Object Admin` on the bucket (NOT account-wide).
3. **Create an HMAC key for that service account**:
   - Cloud Console → Cloud Storage → Settings → Interoperability tab.
   - "Create access key for a service account" → pick the service account → "Create key".
   - Save the **Access ID** (starts with `GOOG…`) + **Secret**. The secret is shown ONCE.
4. **Decide on a serving mode**:
   - **Signed redirect** (recommended) — bucket stays private; the host signs read URLs on demand.
   - **Public URL** — set the bucket's IAM to `allUsers: Storage Object Viewer`, OR front it with Cloud CDN + a custom domain.

## Install in Page Builder

1. Upload `gcs-storage.plugin.zip` via `/admin/plugins` and approve the requested permissions:
   - `media.storage.adapter`
   - `network.outbound`
2. Click **Settings** on the plugin card and fill in:
   - **HMAC Access ID** — starts with `GOOG`.
   - **HMAC Secret** — the value you saved at HMAC key creation time.
   - **Bucket name** — must already exist.
   - **Read serving mode** — `signed-redirect` (private) or `public-url` (public/CDN).
   - **Public URL base** — optional, for a Cloud CDN domain.
   - **Object key prefix** — optional, e.g. `media/`.
3. Open Media → Storage panel, click **Test connection**. The plugin issues a SigV4-signed HEAD against the bucket.
4. **Elect** the adapter for `Originals` (and `Variants` if desired).

## IAM model

GCS HMAC keys are tied to a service account. The service account needs these object-level permissions on the bucket:

- `storage.objects.create` — uploads
- `storage.objects.get` — signed-redirect reads
- `storage.objects.delete` — `abortWrite` + hard delete from Trash
- `storage.buckets.get` — Test connection (HEAD on bucket)

The simplest way to grant all four: the **Storage Object Admin** (`roles/storage.objectAdmin`) role on the bucket. For tighter scope, build a custom role with exactly those four permissions.

## GCS vs AWS S3 — what's the same / different

| Concept | AWS S3 | GCS XML API |
|---|---|---|
| Algorithm | `AWS4-HMAC-SHA256` | `AWS4-HMAC-SHA256` (same — GCS accepts AWS-style sigs in S3-compat mode) |
| Service in credential scope | `s3` | `s3` (same — GCS accepts `s3` for S3-compat signing) |
| Region in scope | actual AWS region | `auto` (GCS ignores region for signing) |
| Endpoint host | `<bucket>.s3.<region>.amazonaws.com` | `storage.googleapis.com` (single host) |
| Addressing | virtual-hosted | path-style |
| Auth | IAM access key | HMAC key tied to a service account |
| Max presigned URL expiry | 7 days | 7 days |
| Native (non-S3) algorithm | n/a | `GOOG4-HMAC-SHA256` (this plugin doesn't use it) |

## Limitations (v1)

- **Single-PUT only** — no multipart upload. The CMS's 50 MB upload cap is well below GCS's 5 TB single-PUT limit.
- **S3-compat mode only** — uses `AWS4-HMAC-SHA256`. The native GCS `GOOG4-HMAC-SHA256` (which supports `x-goog-*` headers) is NOT used. For the storage adapter's surface (PUT / GET / DELETE / HEAD with UNSIGNED-PAYLOAD), the S3-compat mode is sufficient.
- **HMAC keys only** — does NOT support service-account JSON keys (which would require OAuth2 + RSA signing instead). HMAC keys are the simplest path and what GCS recommends for S3-compat workloads.

## Tests

```bash
bun test src/__tests__/plugins/gcs-sigv4.test.ts
```

The cryptographic primitives are covered by the shared signer's tests against AWS-published vectors (in `s3-sigv4.test.ts`). This file verifies the GCS-specific surface: `storage.googleapis.com` host, `auto/s3` credential scope, path-style URLs.
