/**
 * Google Cloud Storage adapter — implements `MediaStorageAdapter`.
 *
 * GCS exposes an S3-compatible XML API: same SigV4 algorithm
 * (`AWS4-HMAC-SHA256`), same `aws4_request` request type, same `s3`
 * service in the credential scope. Cloudflare R2 uses the identical
 * trick, so this plugin shares the SigV4 module with both R2 and the
 * AWS S3 plugin — no per-provider crypto fork.
 *
 * What's GCS-specific:
 *   • Endpoint: `storage.googleapis.com` (single host; no per-account
 *     subdomain like R2).
 *   • Region in credential scope: `auto` (GCS doesn't have regions
 *     baked into signing; the bucket's actual region is irrelevant
 *     for SigV4 with HMAC keys).
 *   • Path-style addressing: `storage.googleapis.com/<bucket>/<key>`.
 *   • Auth: HMAC key from "Interoperability" settings (Access ID
 *     starts with `GOOG…`).
 */
import type {
  MediaStorageAdapter,
  MediaStorageBeginWriteInput,
  MediaStorageFinalizeWriteInput,
  MediaStorageUploadPlan,
  MediaStorageVerifyResult,
  MediaStorageWriteResult,
  ServerPluginApi,
} from '@pagebuilder/plugin-sdk'
import { presignS3Url } from './sigv4'

interface GcsAdapterSettings {
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  servingMode: 'public-url' | 'signed-redirect'
  publicUrlBase: string | null
  pathPrefix: string
}

/** Documented value for the credential scope's region in S3-compat mode. */
const GCS_REGION = 'auto'

/**
 * Single endpoint host for the GCS XML API. There's no per-project
 * subdomain — GCS multiplexes all buckets on `storage.googleapis.com`
 * (path-style) and `<bucket>.storage.googleapis.com` (virtual-hosted).
 * We always sign for the path-style host so the signature stays
 * deterministic regardless of bucket name.
 */
const GCS_HOST = 'storage.googleapis.com'

function readSettings(api: ServerPluginApi): GcsAdapterSettings {
  const get = <T extends string | number | boolean = string>(key: string): T | undefined =>
    api.cms.settings.get<T>(key)

  const required = {
    accessKeyId: String(get('accessKeyId') ?? ''),
    secretAccessKey: String(get('secretAccessKey') ?? ''),
    bucket: String(get('bucket') ?? ''),
  }
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`The "${key}" setting is empty — open the plugin's Settings dialog and fill it in.`)
    }
  }

  const servingModeRaw = String(get('servingMode') ?? 'signed-redirect')
  const servingMode: GcsAdapterSettings['servingMode'] =
    servingModeRaw === 'public-url' ? 'public-url' : 'signed-redirect'

  const publicUrlBaseRaw = String(get('publicUrlBase') ?? '').trim()
  const publicUrlBase = publicUrlBaseRaw
    ? publicUrlBaseRaw.endsWith('/') ? publicUrlBaseRaw : publicUrlBaseRaw + '/'
    : null

  let pathPrefix = String(get('pathPrefix') ?? '').trim()
  while (pathPrefix.startsWith('/')) pathPrefix = pathPrefix.slice(1)
  if (pathPrefix && !pathPrefix.endsWith('/')) pathPrefix = pathPrefix + '/'

  return {
    accessKeyId: required.accessKeyId,
    secretAccessKey: required.secretAccessKey,
    bucket: required.bucket,
    servingMode,
    publicUrlBase,
    pathPrefix,
  }
}

/** Path-style URL key — bucket as first path segment. */
function gcsKey(settings: GcsAdapterSettings, storagePath: string): string {
  return `${settings.bucket}/${settings.pathPrefix}${storagePath}`
}

/**
 * Public renderer URL for `servingMode: 'public-url'`. Defaults to
 * `https://storage.googleapis.com/<bucket>/<key>`. For Cloud CDN behind
 * a custom domain, the user sets `publicUrlBase` to the CDN host.
 */
function publicReadUrl(settings: GcsAdapterSettings, storagePath: string): string {
  if (settings.publicUrlBase) {
    return settings.publicUrlBase + settings.pathPrefix + storagePath
  }
  return `https://${GCS_HOST}/${gcsKey(settings, storagePath)}`
}

async function buildSinglePutPlan(
  settings: GcsAdapterSettings,
  storagePath: string,
  mimeType: string,
): Promise<MediaStorageUploadPlan> {
  const expiresInSeconds = 15 * 60
  const presign = await presignS3Url({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    region: GCS_REGION,
    host: GCS_HOST,
    key: gcsKey(settings, storagePath),
    method: 'PUT',
    expiresInSeconds,
  })
  return {
    storagePath,
    steps: [{
      method: 'PUT',
      url: presign.url,
      headers: { 'Content-Type': mimeType },
    }],
    expiresAt: Date.now() + expiresInSeconds * 1000,
  }
}

export function buildGcsAdapter(api: ServerPluginApi): MediaStorageAdapter {
  const pluginId = api.plugin.id

  return {
    id: `${pluginId}.adapter`,
    label: 'Google Cloud Storage',
    roles: ['original', 'variant'],
    servingMode: readSettings(api).servingMode,

    async beginWrite(input: MediaStorageBeginWriteInput): Promise<MediaStorageUploadPlan> {
      const settings = readSettings(api)
      return buildSinglePutPlan(settings, input.suggestedStoragePath, input.mimeType)
    },

    async finalizeWrite(input: MediaStorageFinalizeWriteInput): Promise<MediaStorageWriteResult> {
      const settings = readSettings(api)
      const publicUrl = publicReadUrl(settings, input.storagePath)
      const etag = input.uploadReceipts[0]?.etag
      return {
        publicUrl,
        ...(etag ? { metadata: { etag } } : {}),
      }
    },

    async abortWrite(input: { storagePath: string }): Promise<void> {
      await issueSignedRequest(api, 'DELETE', input.storagePath, 300)
    },

    async delete(storagePath: string): Promise<void> {
      await issueSignedRequest(api, 'DELETE', storagePath, 300)
    },

    async getReadUrl(storagePath: string, ttlSeconds: number) {
      const settings = readSettings(api)
      const presign = await presignS3Url({
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        region: GCS_REGION,
        host: GCS_HOST,
        key: gcsKey(settings, storagePath),
        // GCS docs note "up to 7 days" for presigned URLs — same ceiling
        // as AWS / R2. Clamp defensively even though the caller usually
        // sends 3600s.
        method: 'GET',
        expiresInSeconds: Math.max(60, Math.min(ttlSeconds, 7 * 24 * 60 * 60)),
      })
      return { url: presign.url, expiresAt: Date.now() + ttlSeconds * 1000 }
    },

    /**
     * Test the bucket exists + credentials work. Same pattern as the
     * other storage adapters: sign a HEAD on the bucket path; 200
     * means OK, 403 means credentials are valid but the IAM principal
     * lacks the right scope on this bucket.
     */
    async verify(): Promise<MediaStorageVerifyResult> {
      let settings: GcsAdapterSettings
      try {
        settings = readSettings(api)
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'Plugin settings missing',
          hint: 'Open the plugin Settings dialog and fill in every required field, then save.',
        }
      }

      // A nice early sanity check: GCS HMAC access IDs all start with
      // `GOOG`. If the user pasted an AWS or R2 key by mistake, this
      // fails fast with a recognisable hint.
      if (!settings.accessKeyId.startsWith('GOOG')) {
        return {
          ok: false,
          reason: `Access ID "${settings.accessKeyId.slice(0, 8)}…" doesn't start with "GOOG".`,
          hint: 'GCS HMAC access IDs always start with GOOG. Make sure you created an interoperability HMAC key (Cloud Console → Cloud Storage → Settings → Interoperability), not a service-account JSON key.',
        }
      }

      try {
        const presign = await presignS3Url({
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
          region: GCS_REGION,
          host: GCS_HOST,
          key: settings.bucket,
          method: 'HEAD',
          expiresInSeconds: 60,
        })
        const response = await fetch(presign.url, { method: 'HEAD' })
        if (response.ok) return { ok: true }
        return {
          ok: false,
          reason: `GCS returned ${response.status} ${response.statusText || ''}`.trim(),
          hint:
            response.status === 403
              ? 'The HMAC key works but the associated service account lacks `storage.objects.create` / `storage.objects.get` / `storage.buckets.get` on this bucket. Grant the "Storage Object Admin" role on the bucket and try again.'
              : response.status === 404
                ? 'Bucket not found. Verify the bucket name and that the HMAC key\'s service account has access.'
                : 'Check the HMAC access ID + secret, and that storage.googleapis.com is reachable.',
        }
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'fetch failed',
          hint: 'Check that storage.googleapis.com is reachable from this server.',
        }
      }
    },

    /** CSP origins — both the API host and the public-download host. */
    cspOrigins: [
      { directive: 'img-src', origin: 'storage.googleapis.com' },
      { directive: 'img-src', origin: '*.storage.googleapis.com' },
      { directive: 'media-src', origin: 'storage.googleapis.com' },
      { directive: 'media-src', origin: '*.storage.googleapis.com' },
    ],
  }
}

async function issueSignedRequest(
  api: ServerPluginApi,
  method: 'DELETE',
  storagePath: string,
  ttlSeconds: number,
): Promise<void> {
  const settings = readSettings(api)
  const presign = await presignS3Url({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    region: GCS_REGION,
    host: GCS_HOST,
    key: gcsKey(settings, storagePath),
    method,
    expiresInSeconds: ttlSeconds,
  })
  try {
    await fetch(presign.url, { method })
  } catch (err) {
    api.plugin.log(`[gcs] ${method} "${storagePath}" failed (orphaned):`, err)
  }
}
