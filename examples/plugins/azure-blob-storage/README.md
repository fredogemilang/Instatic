# Azure Blob Storage

Official Page Builder plugin that routes uploaded media to **Azure Blob Storage** using Shared Access Signatures (SAS).

## Why this plugin

Azure Blob Storage is the natural choice when you're already on Microsoft Azure (AKS, App Service, Functions) and want media on the same provider for low-latency colocation, or you need a sovereign cloud (US Government, China). Unlike the AWS S3 / Cloudflare R2 / GCS plugins — which share an `AWS4-HMAC-SHA256` signer — Azure Blob does NOT speak SigV4. It has its own Shared Access Signature scheme: HMAC-SHA256 over a different canonical string-to-sign, Base64-encoded signature.

Use this plugin when:
- Your infrastructure already lives in Azure (AKS, App Service, Functions, etc.).
- You need a **sovereign-cloud** deployment — US Government (`*.blob.core.usgovcloudapi.net`) or China (`*.blob.core.chinacloudapi.cn`).
- You want Azure Front Door / Azure CDN in front of your blobs.

## What it does

| Capability | What this plugin does |
|---|---|
| `media.storage.adapter` | Registers an exclusive storage adapter for the Originals + Variants roles. |
| `network.outbound` + `networkAllowedHosts` | Talks to `*.blob.core.windows.net` (and sovereign equivalents). |
| `crypto.subtle` | Computes HMAC-SHA256 over Azure's canonical string-to-sign (Service SAS). |
| `settings` (with `secret: true`) | Stores the account key masked in the admin UI. |
| Adapter declares `cspOrigins` | Publisher adds `*.blob.core.windows.net` to the page CSP automatically. |

## Build

```bash
bun pb-plugin build examples/plugins/azure-blob-storage
```

Produces `examples/plugins/azure-blob-storage.plugin.zip`.

## Set up Azure

1. **Create a storage account** in the [Azure portal](https://portal.azure.com/) → Storage accounts → Create. The account name must be 3-24 lowercase letters + digits.
2. **Create a container** under that account: Storage account → Data storage → Containers → "+ Container". The plugin doesn't auto-create containers — it must already exist. Container names are 3-63 chars (lowercase letters / digits / single hyphens).
3. **Copy the account key**: Storage account → Security + networking → Access keys → key1 (or key2) → "Show" → copy the value. This is a base64-encoded 64-byte key. Treat it like a root password — anyone with it can read / write / delete every blob in the account.
4. **Decide on a serving mode**:
   - **Signed redirect** (recommended) — container stays private; the host signs read URLs on demand.
   - **Public URL** — set the container's public access level to "Blob" via the portal, OR front it with Azure Front Door + a custom domain.

## Install in Page Builder

1. Upload `azure-blob-storage.plugin.zip` via `/admin/plugins` and approve the requested permissions:
   - `media.storage.adapter`
   - `network.outbound`
2. Click **Settings** on the plugin card and fill in:
   - **Storage Account Name** — e.g. `mymediaaccount`. NOT the full URL.
   - **Account Key** — base64 from Azure portal → Access keys.
   - **Container name** — must already exist.
   - **Cloud** — Public Azure, US Government, or China. Defaults to Public.
   - **Read serving mode** — `signed-redirect` (private) or `public-url`.
   - **Public URL base** — optional, for Azure Front Door / CDN.
   - **Blob path prefix** — optional, e.g. `media/`.
3. Open Media → Storage panel, click **Test connection**. The plugin issues a container-scoped SAS (`sr=c`, `sp=l`) and `GET`s the blob listing as a connectivity / auth check.
4. **Elect** the adapter for `Originals` (and `Variants` if desired).

## Permissions model

Azure Service SAS permissions per operation:

| Operation | `sr` (resource) | `sp` (permissions) |
|---|---|---|
| `beginWrite` (upload) | `b` (single blob) | `cw` (Create + Write) |
| `abortWrite` / `delete` | `b` | `d` (Delete) |
| `getReadUrl` (read) | `b` | `r` (Read) |
| `verify` (test connection) | `c` (container) | `rl` (Read + List) |

There are no IAM roles to grant — anyone holding the account key has full account access. For finer scoping use **User Delegation SAS** (requires Entra ID OAuth) — that flow is out of scope for v1.

## Azure SAS vs AWS SigV4 — what's different

| Concept | AWS S3 (SigV4) | Azure Blob (Service SAS) |
|---|---|---|
| Algorithm | `AWS4-HMAC-SHA256` | `HMAC-SHA256` |
| Signature encoding | Lowercase hex | Base64 |
| String-to-sign | Hash of canonical request | 16 newline-separated fields |
| Signing key derivation | 4-stage HMAC chain (date → region → service → "aws4_request") | Single HMAC with the account key |
| URL host | `<bucket>.s3.<region>.amazonaws.com` (or path-style) | `<account>.blob.core.windows.net/<container>/<blob>` |
| Query params | `X-Amz-Algorithm`, `X-Amz-Credential`, `X-Amz-Date`, `X-Amz-Expires`, `X-Amz-Signature`, `X-Amz-SignedHeaders` | `sv`, `se`, `sp`, `spr`, `sr`, `sig` (+ optional `st`, `si`) |
| API version param | n/a (in scope) | `sv` (e.g. `2024-11-04`) |
| Auth secret type | IAM access key + secret | Base64-encoded account key |
| Native vs. compat mode | n/a | n/a (no S3-compat for Azure Blob — must use SAS) |

## Limitations (v1)

- **Single-PUT only** — no `Put Block` + `Put Block List` multipart upload. The CMS's 50 MB upload cap is well below the single-PUT-blob limit Azure enforces.
- **Account-key auth only** — does NOT support User Delegation SAS (which requires Entra ID OAuth + RSA signing) or AAD direct auth (without SAS).
- **No managed identity** — Azure Functions / App Service often run under a system-assigned identity. This plugin doesn't tap into that — you must paste an account key. A future revision could add User Delegation SAS to remove that dependency.

## Tests

```bash
bun test src/__tests__/plugins/azure-sas.test.ts
```

Tests cover the Base64 round-trip, the 16-field string-to-sign assembly, the endpoint suffix routing per cloud, the canonical-resource shape, and the URL produced by `presignAzureBlobUrl`.
