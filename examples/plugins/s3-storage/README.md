# Amazon S3 Storage

Official Page Builder plugin that routes uploaded media to Amazon S3 (or any S3-compatible backend — Cloudflare R2, Backblaze B2, DigitalOcean Spaces, MinIO).

## What it does

| Capability | What this plugin does |
|---|---|
| `media.storage.adapter` | Registers an exclusive storage adapter the admin can elect per role (Originals / Variants). |
| `network.outbound` + `networkAllowedHosts` | Talks to AWS S3 + the major S3-compatible providers from inside the sandbox. |
| `crypto.subtle` (no permission, available to all plugins) | Computes AWS Signature V4 (SHA-256 + HMAC-SHA256) for every presigned URL. |
| `settings` (with `secret: true`) | Stores AWS credentials masked in the admin UI. |
| Adapter declares `cspOrigins` | The publisher adds `https://*.s3.amazonaws.com` (etc.) to the page CSP automatically. |

The plugin never touches the bytes of an upload. The host's executor (`server/handlers/cms/mediaUploadExecutor.ts`) streams the bytes directly to the presigned PUT URL the plugin produced — bytes never cross the QuickJS sandbox boundary.

## Build

```bash
bun pb-plugin build examples/plugins/s3-storage
```

Produces `examples/plugins/s3-storage.plugin.zip` (~13 KB).

## Install

1. Upload `s3-storage.plugin.zip` from `/admin/plugins` and approve the requested permissions:
   - `media.storage.adapter` — register a storage backend
   - `network.outbound` — talk to S3
2. Click the **Settings** button on the plugin card and fill in:
   - **AWS Access Key ID** + **Secret Access Key** — a dedicated IAM user, NOT the root account.
   - **AWS Region** — e.g. `us-east-1`, `eu-west-1`, `auto` (R2).
   - **Bucket** — existing bucket name. The plugin does not create buckets.
   - **Endpoint override** — leave blank for AWS S3. For an S3-compatible provider, set the endpoint host (e.g. `https://<account>.r2.cloudflarestorage.com`).
   - **Read serving mode** — `public-url` for public buckets / CDN, `signed-redirect` for private buckets.
   - **Public URL base** — optional, if you front the bucket with CloudFront or a custom domain.
   - **Object key prefix** — optional, e.g. `media/` to scope writes when sharing a bucket between environments.
3. Open the **Media** workspace → **Storage** panel (sidebar icon → cloud-upload). Click **Test connection** on the Amazon S3 row; the plugin issues a Sigv4-signed HEAD against the bucket. You should see a green "OK".
4. **Elect** the adapter for `Originals` (and optionally `Variants` if you want the responsive ladder on S3 too). Future uploads land on S3.
5. If you already have local media you want moved to S3, click **Migrate N pending →** in the same panel. The host streams every existing asset through the adapter and updates the DB row to point at the new bytes. Variants migrate the same way.

## IAM policy

Minimum policy for a dedicated IAM user:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PageBuilderS3Bucket",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::YOUR-BUCKET"
    },
    {
      "Sid": "PageBuilderS3Objects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET/*"
    }
  ]
}
```

- `s3:ListBucket` is the IAM action that powers the **Test connection** button. There is no separate `s3:HeadBucket` permission — the `HeadBucket` operation requires `s3:ListBucket` on the bucket ARN itself (not the `/*` object ARN). Counterintuitive but it's what AWS documents.
- `s3:PutObject` is for uploads (signed by `beginWrite`, executed by the host).
- `s3:GetObject` is for `signed-redirect` reads (signed by `getReadUrl`, redirected by the host).
- `s3:DeleteObject` is for `abortWrite` (clean up partially-failed uploads) + `delete` (hard purge from Trash).

For public-bucket mode, also set the bucket policy to allow public GET on the object key prefix — or front the bucket with CloudFront.

## How it works under the hood

### Upload flow (two-phase commit)

```
admin POST /admin/api/cms/media          (multipart with file=)
    │
    ▼
host: magic-byte sniff → dispatchUpload(role: 'original', bytes, mime)
    │
    ▼
host: getElectedAdapterId('original') → 'pagebuilder.s3-storage.adapter'
    │
    ▼
adapter.beginWrite({ mimeType, suggestedStoragePath, contentHash, sizeBytes })
    │  ── runs in the QuickJS sandbox ──
    │  Sigv4-signs a PUT URL valid for 15 minutes
    │
    ▼
returns { storagePath, steps: [{ method: 'PUT', url, headers }], expiresAt }
    │
    ▼
host: executeUploadPlan(plan, bytes)
    │  ── runs OUTSIDE the sandbox; bytes never enter the VM ──
    │  fetch(presignedUrl, { method: 'PUT', body: bytes })
    │  → S3 returns 200 + ETag
    │
    ▼
adapter.finalizeWrite({ storagePath, uploadReceipts: [{ etag }] })
    │  ── runs in the QuickJS sandbox ──
    │  returns { publicUrl }   (the absolute S3 URL, or the
    │                            host-substituted /_pb/media/... URL
    │                            for signed-redirect mode)
    │
    ▼
host: createMediaAsset(db, { ..., storage_adapter_id, public_path, externally_hosted })
```

### Read flow

**`public-url` mode** (public bucket / CloudFront):

```
browser GET <img src="https://my-bucket.s3.us-east-1.amazonaws.com/originals/abc-hero.jpg">
   → S3 serves directly, host not in the path
```

**`signed-redirect` mode** (private bucket):

```
browser GET <img src="/_pb/media/pagebuilder.s3-storage.adapter/originals%2Fabc-hero.jpg">
   ▼
host's tryServeMediaRedirect:
   resolves adapter → adapter.getReadUrl(storagePath, 3600)
   ▼
adapter (in sandbox): Sigv4-signs a GET URL valid for 1 hour
   ▼
host: 302 Location: https://my-bucket.s3.amazonaws.com/...?X-Amz-Algorithm=...&X-Amz-Signature=...
   ▼
browser follows → S3 serves directly
```

The signed URL is short-lived and re-minted on every request, so a leaked URL becomes useless within an hour.

## Limitations (v1)

- **Single-PUT only** — no multipart upload. The CMS's per-upload size cap is 50 MB, well below S3's 5 GB single-PUT limit.
- **No instance-profile / IRSA credentials** — the plugin reads credentials from settings only. If you need short-lived STS tokens, run a credential-refresher process out of band and update the plugin's settings periodically.
- **Settings hot-reload requires plugin restart** — pre-existing limitation of the plugin runtime affecting every plugin's settings. Click **Restart** on the plugin card after changing settings to pick up new values.
- **Custom endpoint hosts beyond the manifest's allowlist** require publishing a new plugin version with the extra hostname added to `networkAllowedHosts`. The manifest IS the audit boundary — operators approve it at install time.

## Migration to / from S3

The Storage admin panel surfaces a **Migrate N pending →** button under any role whose elected adapter differs from where some assets live. Click it to move existing assets between adapters:

- **Local → S3**: streams files from `/uploads/...` through the adapter's `beginWrite` + host PUT, updates each row, removes the local file.
- **S3 → local**: the migration reader uses `getReadUrl` to fetch from S3, then writes locally. Works for both public-url and signed-redirect modes.
- **Variants migrate separately**: elect S3 for `Variants` too, then run the **Migrate** button under the Variants row.

Failures are per-asset, never per-batch — a single 403 doesn't bail the whole migration. Successful migrations report their counts; failed assets surface in the progress stream and can be retried.

## Trust model

- The plugin runs in QuickJS-WASM with no access to Node/Bun built-ins, no `node_modules`, no filesystem, no network outside the manifest's `networkAllowedHosts`.
- AWS credentials are stored as `secret: true` settings — masked in the admin UI's plugin row, and emitted as `'***'` in the plugin list endpoint. The plugin reads the actual values via `api.cms.settings.get(...)`; secrets never leave the host process.
- The plugin signs URLs in the sandbox; the host streams bytes to them outside the sandbox. The bytes path is auditable and the same code path local-disk uploads use — there's no separate streaming branch for plugin adapters.
- The adapter declares its `cspOrigins` at registration time; the publisher merges them into the page CSP automatically. The CSP entries appear on every published page only while the adapter is elected for a role.

## Tests

```bash
bun test src/__tests__/plugins/s3-sigv4.test.ts
```

Verifies the Sigv4 implementation against the canonical AWS test vectors (HMAC-SHA256, RFC 3986 percent-encoding, S3 key encoding, signing-key chain) and the URL shape AWS expects.
