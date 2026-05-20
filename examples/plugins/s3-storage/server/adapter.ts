/**
 * S3 storage adapter — implements `MediaStorageAdapter`.
 *
 * Read the contract in `src/core/plugin-sdk/types.ts` (search for
 * `MediaStorageAdapter`). This file is the concrete realisation against
 * AWS S3 (and S3-compatible backends).
 *
 * Two-phase upload (the kernel of the design):
 *
 *   1. `beginWrite({ mimeType, suggestedStoragePath, contentHash, … })`
 *      → returns a presigned PUT URL valid for 15 minutes. The host's
 *        executor streams the actual bytes to that URL. We never see
 *        the bytes — and crucially, the QuickJS VM's 64 MB heap never
 *        has to hold them.
 *
 *   2. `finalizeWrite({ storagePath, uploadReceipts })`
 *      → returns the `publicUrl` the renderer should emit. For
 *        `servingMode: 'public-url'` we build it ourselves (typically
 *        `https://<bucket>.s3.<region>.amazonaws.com/<key>` or a
 *        CloudFront-fronted URL). For `signed-redirect` the host
 *        substitutes its own `/_pb/media/...` URL — we just return any
 *        placeholder.
 *
 * Reads (`getReadUrl`) mint a 1-hour presigned GET URL. The host's
 * router calls this from `/_pb/media/.../...` for signed-redirect mode.
 *
 * Failures (`abortWrite`, `delete`) issue presigned DELETEs. We don't
 * retry — the host logs and continues; orphaned bytes can be swept by
 * a future GC tool.
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

/** Required setting keys — the build-time validator rejects a registration
 *  that's missing any of these (see `assertAdapterSettings` below). */
type RequiredSettingKey =
  | 'awsAccessKeyId'
  | 'awsSecretAccessKey'
  | 'region'
  | 'bucket'

interface S3AdapterSettings {
  accessKeyId: string
  secretAccessKey: string
  region: string
  bucket: string
  /** Optional explicit endpoint host (no scheme). For R2: `<acct>.r2.cloudflarestorage.com`. */
  endpointHost: string | null
  servingMode: 'public-url' | 'signed-redirect'
  publicUrlBase: string | null
  pathPrefix: string
}

/**
 * Pull settings out of the SDK + validate. Throws a descriptive error
 * when a required value is missing — surfaces as a 500 on the upload
 * endpoint, but more importantly as a clear failure from
 * `adapter.verify()` so the admin sees "Set the awsAccessKeyId
 * setting" instead of "S3 returned 403".
 */
function readSettings(api: ServerPluginApi): S3AdapterSettings {
  const get = <T extends string | number | boolean = string>(key: string): T | undefined =>
    api.cms.settings.get<T>(key)

  const required: Record<RequiredSettingKey, string> = {
    awsAccessKeyId: String(get('awsAccessKeyId') ?? ''),
    awsSecretAccessKey: String(get('awsSecretAccessKey') ?? ''),
    region: String(get('region') ?? ''),
    bucket: String(get('bucket') ?? ''),
  }
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`The "${key}" setting is empty — open the plugin's Settings dialog and fill it in.`)
    }
  }

  const endpointRaw = String(get('endpoint') ?? '').trim()
  // Strip the scheme — we always sign with HTTPS, the user shouldn't have to
  // remember to omit it. Trailing slash gets normalised away too.
  const endpointHost = endpointRaw
    ? endpointRaw.replace(/^https?:\/\//, '').replace(/\/+$/, '') || null
    : null

  const servingModeRaw = String(get('servingMode') ?? 'public-url')
  const servingMode: S3AdapterSettings['servingMode'] =
    servingModeRaw === 'signed-redirect' ? 'signed-redirect' : 'public-url'

  const publicUrlBaseRaw = String(get('publicUrlBase') ?? '').trim()
  // Normalise: must end with `/` so the join is a simple concat.
  const publicUrlBase = publicUrlBaseRaw
    ? publicUrlBaseRaw.endsWith('/') ? publicUrlBaseRaw : publicUrlBaseRaw + '/'
    : null

  // `pathPrefix` is a key prefix — normalise so it doesn't start with `/`
  // (S3 keys never start with one) but DOES end with `/` when non-empty.
  let pathPrefix = String(get('pathPrefix') ?? '').trim()
  while (pathPrefix.startsWith('/')) pathPrefix = pathPrefix.slice(1)
  if (pathPrefix && !pathPrefix.endsWith('/')) pathPrefix = pathPrefix + '/'

  return {
    accessKeyId: required.awsAccessKeyId,
    secretAccessKey: required.awsSecretAccessKey,
    region: required.region,
    bucket: required.bucket,
    endpointHost,
    servingMode,
    publicUrlBase,
    pathPrefix,
  }
}

/**
 * Whether the adapter signs URLs in path-style. Used when the operator
 * has supplied a custom endpoint host (R2 / MinIO / B2 / Spaces) —
 * those endpoints typically expose buckets as the first path segment
 * rather than a subdomain. AWS S3 itself defaults to virtual-hosted
 * style (the only form that's not slated for deprecation).
 */
function isPathStyle(settings: S3AdapterSettings): boolean {
  return Boolean(settings.endpointHost)
}

/**
 * Resolve the HTTPS host that signs + serves the bucket. For AWS S3 we
 * use virtual-hosted style across ALL regions — including us-east-1.
 * The legacy `<bucket>.s3.amazonaws.com` global endpoint still works for
 * us-east-1 but AWS docs explicitly recommend the regional form everywhere
 * because the global endpoint is treated as legacy and returns 400 for
 * buckets in regions launched after March 20, 2019.
 *
 * For S3-compatible backends the host stays the configured endpoint as-is
 * (path-style addressing includes the bucket name in the path instead).
 */
function s3Host(settings: S3AdapterSettings): string {
  if (settings.endpointHost) {
    return settings.endpointHost
  }
  return `${settings.bucket}.s3.${settings.region}.amazonaws.com`
}

/**
 * Build the signed URI's path portion. For virtual-hosted-style (AWS S3)
 * this is the object key alone. For path-style (custom endpoints) we
 * prefix the bucket name onto the path so the request reaches the right
 * resource on a server that addresses buckets via path.
 *
 * AWS S3 keys never start with `/`. The user-supplied `pathPrefix` is
 * applied first, then the storage-path the host's pipeline produced.
 */
function s3Key(settings: S3AdapterSettings, storagePath: string): string {
  const objectKey = settings.pathPrefix + storagePath
  return isPathStyle(settings) ? `${settings.bucket}/${objectKey}` : objectKey
}

/**
 * Build the public renderer URL for `servingMode: 'public-url'`. This
 * is what the renderer emits as `<img src="...">`. For
 * `signed-redirect` the host overrides this; the value here is
 * irrelevant in that mode but we still return something predictable
 * so the migration / debug paths have a usable URL.
 */
function publicReadUrl(settings: S3AdapterSettings, storagePath: string): string {
  if (settings.publicUrlBase) {
    return settings.publicUrlBase + (settings.pathPrefix + storagePath)
  }
  return `https://${s3Host(settings)}/${s3Key(settings, storagePath)}`
}

/**
 * Build a presigned-URL step the host's executor walks. Returns ONE
 * step (single-PUT) — multipart upload is out of scope for v1; if
 * we ever ship it, this is where we'd emit N PUT-part steps.
 *
 * The `expiresAt` is the WALL CLOCK absolute time when the URL expires
 * (vs the relative `expiresInSeconds` in the signature itself). The
 * host's executor checks it before kicking off the upload — useful
 * defense if the plan ages in a queue.
 */
async function buildSinglePutPlan(
  settings: S3AdapterSettings,
  storagePath: string,
  mimeType: string,
): Promise<MediaStorageUploadPlan> {
  // 15 minutes — AWS's default; long enough for any single-PUT we'd
  // accept (50 MB cap × generous network), short enough that a leaked
  // signed URL is useless fast.
  const expiresInSeconds = 15 * 60
  const presign = await presignS3Url({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    region: settings.region,
    host: s3Host(settings),
    key: s3Key(settings, storagePath),
    method: 'PUT',
    expiresInSeconds,
  })
  return {
    storagePath,
    steps: [{
      method: 'PUT',
      url: presign.url,
      // We don't sign `Content-Type` (SignedHeaders = host only), so
      // including it here is purely informational for the executor +
      // S3's stored object metadata. AWS still records the Content-Type
      // even though it's outside the signature.
      headers: {
        'Content-Type': mimeType,
      },
    }],
    expiresAt: Date.now() + expiresInSeconds * 1000,
  }
}

/**
 * Build the adapter object. Closure-captures `api` so each method can
 * re-read settings on every call — that way an admin's settings change
 * doesn't require a plugin restart for the new values to take effect
 * (modulo the worker settings cache, which the host runtime is
 * responsible for keeping in sync).
 */
export function buildS3Adapter(api: ServerPluginApi): MediaStorageAdapter {
  const pluginId = api.plugin.id

  return {
    id: `${pluginId}.adapter`,
    label: 'Amazon S3',
    // We claim only the roles that make sense for an object-store
    // backend. Avatars + plugin-pack are kept local — they're small,
    // few-in-number, and benefit from on-disk locality.
    roles: ['original', 'variant'],
    // We READ settings at registration time only to decide the serving
    // mode (the host needs to know it). The actual sign-time settings
    // are re-read inside each method so updates take effect without a
    // re-registration.
    servingMode: readSettings(api).servingMode,

    /**
     * Phase 1 of the upload: produce a signed PUT URL the host streams to.
     */
    async beginWrite(input: MediaStorageBeginWriteInput): Promise<MediaStorageUploadPlan> {
      const settings = readSettings(api)
      // The host already produced a SHA-256 of the bytes (`input.contentHash`).
      // For UNSIGNED-PAYLOAD signing, S3 doesn't enforce the body hash, so
      // we don't include it — but we record it on the response shape
      // metadata in `finalizeWrite` so it's queryable later if needed.
      return buildSinglePutPlan(settings, input.suggestedStoragePath, input.mimeType)
    },

    /**
     * Phase 2 of the upload: bytes have landed. Return the public URL.
     *
     * For single-PUT (the only path in v1) there's nothing to "commit" —
     * S3 already committed when the PUT returned 200. We just compute
     * the URL the renderer should emit.
     */
    async finalizeWrite(input: MediaStorageFinalizeWriteInput): Promise<MediaStorageWriteResult> {
      const settings = readSettings(api)
      const publicUrl = settings.servingMode === 'public-url'
        ? publicReadUrl(settings, input.storagePath)
        // For signed-redirect, the host substitutes its own `/_pb/media/`
        // URL — anything we return here is replaced by the dispatcher
        // (see `server/handlers/cms/mediaUploadDispatch.ts`). We still
        // return a fallback for debug visibility.
        : publicReadUrl(settings, input.storagePath)
      const etag = input.uploadReceipts[0]?.etag
      return {
        publicUrl,
        ...(etag ? { metadata: { etag } } : {}),
      }
    },

    /**
     * Cleanup the destination object when a write failed mid-flight.
     * Idempotent — DELETE on a missing key returns 204; either way the
     * adapter just resolves.
     */
    async abortWrite(input: { storagePath: string }): Promise<void> {
      await issueSignedRequest(api, 'DELETE', input.storagePath, 300)
    },

    /**
     * Permanent delete — called when the admin purges the asset from
     * Trash, or when a binary replace lands and the previous object
     * needs sweeping.
     */
    async delete(storagePath: string): Promise<void> {
      await issueSignedRequest(api, 'DELETE', storagePath, 300)
    },

    /**
     * Mint a signed GET URL for the host's `/_pb/media/<id>/<path>`
     * route. The TTL must be long enough that a slow CDN warm-up
     * completes, short enough that a leaked URL becomes useless
     * quickly. 1 hour is the standard "long enough but not forever".
     */
    async getReadUrl(storagePath: string, ttlSeconds: number) {
      const settings = readSettings(api)
      const presign = await presignS3Url({
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        region: settings.region,
        host: s3Host(settings),
        key: s3Key(settings, storagePath),
        method: 'GET',
        expiresInSeconds: Math.max(60, Math.min(ttlSeconds, 86400)),
      })
      return { url: presign.url, expiresAt: Date.now() + ttlSeconds * 1000 }
    },

    /**
     * Pre-flight check: issue a signed HEAD on the bucket root. AWS
     * returns 200 when the bucket exists AND the IAM principal has
     * `s3:ListBucket` / `s3:HeadBucket` on it. We don't ACTUALLY need
     * ListBucket for normal operation, but if it works HeadBucket
     * works too, and AWS bundles them in most "S3 Read" managed
     * policies. Failures bubble up as structured `{ ok: false, reason }`
     * so the admin UI surfaces a useful diagnosis.
     */
    async verify(): Promise<MediaStorageVerifyResult> {
      let settings: S3AdapterSettings
      try {
        settings = readSettings(api)
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'Plugin settings missing',
          hint: 'Open the plugin Settings dialog and fill in every required field, then save.',
        }
      }

      // AWS S3 virtual-hosted-style HTTPS uses a wildcard certificate
      // (`*.s3.<region>.amazonaws.com`) that matches buckets with NO
      // dots in the name. A bucket like `media.example.com` would
      // produce `media.example.com.s3.<region>.amazonaws.com`, which the
      // certificate's single-subdomain wildcard rejects. Warn early —
      // the user would otherwise see a confusing TLS handshake failure
      // on first upload. This restriction does NOT apply when the user
      // configured a custom endpoint (R2 / MinIO / etc.).
      if (!settings.endpointHost && settings.bucket.includes('.')) {
        return {
          ok: false,
          reason: `Bucket name "${settings.bucket}" contains dots. AWS S3 virtual-hosted-style HTTPS uses a wildcard certificate that only matches single-segment bucket names.`,
          hint: 'Rename the bucket without dots (`media-example-com` instead of `media.example.com`), or front it with CloudFront on a custom domain.',
        }
      }

      try {
        // HEAD on the bucket root URL. We sign for `key: ''` which
        // gives `https://<host>/?<sigv4>`. Some S3-compat backends
        // require a non-empty key — if HEAD fails for those, the user
        // can retry with `getReadUrl` against a known key.
        const presign = await presignS3Url({
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
          region: settings.region,
          host: s3Host(settings),
          key: '',
          method: 'HEAD',
          expiresInSeconds: 60,
        })
        const response = await fetch(presign.url, { method: 'HEAD' })
        if (response.ok) {
          return { ok: true }
        }
        // 403 → creds OK, IAM missing the permission
        // 404 → bucket doesn't exist OR region mismatch
        // others → network / DNS / endpoint typo
        return {
          ok: false,
          reason: `S3 returned ${response.status} ${response.statusText || ''}`.trim(),
          hint:
            response.status === 403
              ? "The credentials work but lack s3:HeadBucket on the bucket. Update the IAM policy."
              : response.status === 404
                ? "Bucket not found. Check the bucket name and region — a region mismatch returns 404 here."
                : 'Check the endpoint host (for R2 / Spaces / B2 set the Endpoint override setting).',
        }
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'fetch failed',
          hint: 'Check that the bucket host is included in the plugin manifest\'s networkAllowedHosts.',
        }
      }
    },

    /**
     * Declared at registration so the publisher's CSP includes these
     * origins on every published page — otherwise the browser would
     * refuse to load `<img src="https://my-bucket.s3.amazonaws.com/…">`
     * under the default `img-src 'self'` policy.
     *
     * We list both the bucket-style AND the path-style suffix so users
     * with old-school bucket names still work. The publisher
     * deduplicates origin entries.
     */
    cspOrigins: [
      { directive: 'img-src', origin: '*.s3.amazonaws.com' },
      { directive: 'img-src', origin: '*.amazonaws.com' },
      { directive: 'media-src', origin: '*.amazonaws.com' },
      { directive: 'img-src', origin: '*.r2.cloudflarestorage.com' },
      { directive: 'img-src', origin: '*.backblazeb2.com' },
      { directive: 'img-src', origin: '*.digitaloceanspaces.com' },
    ],
  }
}

/**
 * Helper for `abortWrite` / `delete` — mint a signed DELETE URL and
 * fire it. The host stores the response status on its diagnostic
 * trail, but the adapter itself just resolves regardless: delete is
 * idempotent and we don't want a flaky network to keep the admin
 * spinning on a "purge" action.
 */
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
    region: settings.region,
    host: s3Host(settings),
    key: s3Key(settings, storagePath),
    method,
    expiresInSeconds: ttlSeconds,
  })
  try {
    await fetch(presign.url, { method })
  } catch (err) {
    api.plugin.log(`[s3] ${method} "${storagePath}" failed (orphaned):`, err)
  }
}
