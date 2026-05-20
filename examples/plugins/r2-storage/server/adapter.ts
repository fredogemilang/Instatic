/**
 * Cloudflare R2 storage adapter — implements `MediaStorageAdapter`.
 *
 * R2 speaks the S3 API verbatim — same Sigv4 signing, same canonical
 * request shape, `s3` as the credential-scope service. The differences
 * are operational, not protocol-level:
 *
 *   • Endpoint host shape: `<accountId>.r2.cloudflarestorage.com`
 *     (plus a `<jurisdiction>.` prefix for EU / FedRAMP). The account
 *     ID is the multi-tenant routing key; the bucket name lives in
 *     the URL path (path-style addressing).
 *
 *   • Region is always `auto` in the credential scope. R2 accepts
 *     `us-east-1` and the empty string as aliases, but `auto` is the
 *     canonical value Cloudflare documents.
 *
 *   • Public-bucket reads go through a separate `<hash>.r2.dev` host
 *     OR a user-configured custom domain. We don't auto-discover the
 *     public host; the operator pastes it into `publicUrlBase`.
 *
 *   • Presigned URLs cannot be used with custom domains — only the
 *     `<accountId>.r2.cloudflarestorage.com` host. So `signed-redirect`
 *     mode always builds URLs against that host, regardless of any
 *     custom domain the bucket has.
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

interface R2AdapterSettings {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  jurisdiction: 'standard' | 'eu' | 'fedramp'
  servingMode: 'public-url' | 'signed-redirect'
  publicUrlBase: string | null
  pathPrefix: string
}

/** R2 documents that the credential scope's region must be `auto`. */
const R2_REGION = 'auto'

/**
 * Resolve the S3 API host for the configured account + jurisdiction.
 * Endpoint shape (per Cloudflare R2 docs, May 2026):
 *   • Standard:  `<accountId>.r2.cloudflarestorage.com`
 *   • EU:        `<accountId>.eu.r2.cloudflarestorage.com`
 *   • FedRAMP:   `<accountId>.fedramp.r2.cloudflarestorage.com`
 *
 * Presigned URLs ALWAYS sign against this host — custom domains and
 * the `.r2.dev` public host don't accept presigned authentication.
 */
function r2ApiHost(settings: R2AdapterSettings): string {
  const prefix = settings.jurisdiction === 'standard' ? '' : `${settings.jurisdiction}.`
  return `${settings.accountId}.${prefix}r2.cloudflarestorage.com`
}

/**
 * Pull settings from the SDK + validate. The same "describe the gap
 * explicitly" pattern the S3 plugin uses: throw a descriptive error so
 * `verify()` surfaces "fill in the Bucket setting" rather than
 * "R2 returned 400".
 */
function readSettings(api: ServerPluginApi): R2AdapterSettings {
  const get = <T extends string | number | boolean = string>(key: string): T | undefined =>
    api.cms.settings.get<T>(key)

  const required = {
    accountId: String(get('accountId') ?? ''),
    accessKeyId: String(get('accessKeyId') ?? ''),
    secretAccessKey: String(get('secretAccessKey') ?? ''),
    bucket: String(get('bucket') ?? ''),
  }
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`The "${key}" setting is empty — open the plugin's Settings dialog and fill it in.`)
    }
  }

  const jurisdictionRaw = String(get('jurisdiction') ?? 'standard')
  const jurisdiction: R2AdapterSettings['jurisdiction'] =
    jurisdictionRaw === 'eu' ? 'eu' : jurisdictionRaw === 'fedramp' ? 'fedramp' : 'standard'

  const servingModeRaw = String(get('servingMode') ?? 'signed-redirect')
  const servingMode: R2AdapterSettings['servingMode'] =
    servingModeRaw === 'public-url' ? 'public-url' : 'signed-redirect'

  const publicUrlBaseRaw = String(get('publicUrlBase') ?? '').trim()
  const publicUrlBase = publicUrlBaseRaw
    ? publicUrlBaseRaw.endsWith('/') ? publicUrlBaseRaw : publicUrlBaseRaw + '/'
    : null

  let pathPrefix = String(get('pathPrefix') ?? '').trim()
  while (pathPrefix.startsWith('/')) pathPrefix = pathPrefix.slice(1)
  if (pathPrefix && !pathPrefix.endsWith('/')) pathPrefix = pathPrefix + '/'

  return {
    accountId: required.accountId,
    accessKeyId: required.accessKeyId,
    secretAccessKey: required.secretAccessKey,
    bucket: required.bucket,
    jurisdiction,
    servingMode,
    publicUrlBase,
    pathPrefix,
  }
}

/**
 * Build the path-style URL key: `<bucket>/<prefix><storagePath>`.
 * R2 uses path-style addressing for the S3 API — the bucket isn't a
 * subdomain of the account host.
 */
function r2Key(settings: R2AdapterSettings, storagePath: string): string {
  return `${settings.bucket}/${settings.pathPrefix}${storagePath}`
}

/**
 * Build the renderer URL for `servingMode: 'public-url'`. R2 public
 * buckets serve from a separate `<hash>.r2.dev` host OR a custom
 * domain — the operator pastes that prefix into `publicUrlBase` and
 * we just concatenate the object key.
 *
 * When no `publicUrlBase` is set, fall back to a host-relative path
 * (the host's `tryServeUpload` will 404 it, prompting the user to
 * configure the public base). Returning a broken URL here is loud-
 * fail behaviour by design — silently emitting the signing host (which
 * doesn't serve public reads) would be a confusing dev experience.
 */
function publicReadUrl(settings: R2AdapterSettings, storagePath: string): string {
  if (settings.publicUrlBase) {
    return settings.publicUrlBase + settings.pathPrefix + storagePath
  }
  // No public URL configured — fall back to the host's redirect route,
  // which means the operator gets signed-redirect behaviour even though
  // they chose public-url mode. Acceptable degradation.
  return `https://${r2ApiHost(settings)}/${r2Key(settings, storagePath)}`
}

/**
 * Build a presigned-PUT upload plan. Single step (no multipart) — R2's
 * S3 API supports multipart but the host's executor doesn't yet, and
 * a single PUT handles the host's 50 MB upload cap comfortably.
 */
async function buildSinglePutPlan(
  settings: R2AdapterSettings,
  storagePath: string,
  mimeType: string,
): Promise<MediaStorageUploadPlan> {
  const expiresInSeconds = 15 * 60
  const presign = await presignS3Url({
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    region: R2_REGION,
    host: r2ApiHost(settings),
    key: r2Key(settings, storagePath),
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

export function buildR2Adapter(api: ServerPluginApi): MediaStorageAdapter {
  const pluginId = api.plugin.id

  return {
    id: `${pluginId}.adapter`,
    label: 'Cloudflare R2',
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
        region: R2_REGION,
        host: r2ApiHost(settings),
        key: r2Key(settings, storagePath),
        method: 'GET',
        // R2 caps presigned URLs at 7 days (604800s), same as AWS.
        // Caller already clamps but defense-in-depth never hurts.
        expiresInSeconds: Math.max(60, Math.min(ttlSeconds, 7 * 24 * 60 * 60)),
      })
      return { url: presign.url, expiresAt: Date.now() + ttlSeconds * 1000 }
    },

    /**
     * R2 supports `HeadBucket`. We sign one for the bucket and check
     * the response code:
     *   • 200 — credentials work and the bucket exists
     *   • 403 — credentials work but the token can't see the bucket
     *           (wrong scope / Object Read & Write missing this bucket)
     *   • 404 — bucket doesn't exist (or wrong jurisdiction)
     *   • other — DNS / endpoint / Cloudflare error
     */
    async verify(): Promise<MediaStorageVerifyResult> {
      let settings: R2AdapterSettings
      try {
        settings = readSettings(api)
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'Plugin settings missing',
          hint: 'Open the plugin Settings dialog and fill in every required field, then save.',
        }
      }

      try {
        // Sign a HEAD against the bucket path. Note: R2 returns 200 on
        // HEAD for `/<bucket>` when the credentials have access AND the
        // bucket exists in the configured jurisdiction.
        const presign = await presignS3Url({
          accessKeyId: settings.accessKeyId,
          secretAccessKey: settings.secretAccessKey,
          region: R2_REGION,
          host: r2ApiHost(settings),
          key: settings.bucket,
          method: 'HEAD',
          expiresInSeconds: 60,
        })
        const response = await fetch(presign.url, { method: 'HEAD' })
        if (response.ok) return { ok: true }
        return {
          ok: false,
          reason: `R2 returned ${response.status} ${response.statusText || ''}`.trim(),
          hint:
            response.status === 401 || response.status === 403
              ? 'The credentials work but the token doesn\'t have Object Read & Write on this bucket. Issue a new token scoped to the bucket and try again.'
              : response.status === 404
                ? 'Bucket not found in this jurisdiction. Verify the bucket name and the jurisdiction setting.'
                : 'Check the Account ID and that the bucket host is reachable.',
        }
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'fetch failed',
          hint: 'Check the Account ID and that *.r2.cloudflarestorage.com is reachable from this server.',
        }
      }
    },

    /**
     * CSP origins declared at registration. Both the signing host
     * (`*.r2.cloudflarestorage.com`) and the public-bucket host
     * (`*.r2.dev`) are listed so either serving mode works on
     * published pages. The publisher dedupes entries the renderer
     * doesn't actually need.
     */
    cspOrigins: [
      { directive: 'img-src', origin: '*.r2.cloudflarestorage.com' },
      { directive: 'media-src', origin: '*.r2.cloudflarestorage.com' },
      { directive: 'img-src', origin: '*.r2.dev' },
      { directive: 'media-src', origin: '*.r2.dev' },
    ],
  }
}

/**
 * Helper for abortWrite / delete — mint a presigned DELETE URL and
 * fire it. Same swallow-errors-and-log pattern as the S3 plugin.
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
    region: R2_REGION,
    host: r2ApiHost(settings),
    key: r2Key(settings, storagePath),
    method,
    expiresInSeconds: ttlSeconds,
  })
  try {
    await fetch(presign.url, { method })
  } catch (err) {
    api.plugin.log(`[r2] ${method} "${storagePath}" failed (orphaned):`, err)
  }
}
