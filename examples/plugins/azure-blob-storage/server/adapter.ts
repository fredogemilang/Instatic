/**
 * Azure Blob Storage adapter — implements `MediaStorageAdapter`.
 *
 * Unlike S3 / R2 / GCS, Azure Blob does NOT speak AWS SigV4. Instead it
 * uses Shared Access Signatures (SAS): a separate HMAC-SHA256 over a
 * different canonical string-to-sign, with a Base64-encoded signature.
 * See `./sas.ts` for the signer.
 *
 * The two-phase upload contract is the same as every other storage
 * plugin: the adapter signs URLs, the host streams bytes — the
 * QuickJS-WASM sandbox never sees the bytes.
 *
 * Per-operation SAS scopes / permissions:
 *
 *   beginWrite   →  sr=b  permissions=cw    (Create+Write a single blob)
 *   abortWrite   →  sr=b  permissions=d     (Delete that blob)
 *   delete       →  sr=b  permissions=d
 *   getReadUrl   →  sr=b  permissions=r     (Read)
 *   verify       →  sr=c  permissions=l     (List container)
 *
 * Endpoint per Azure cloud:
 *
 *   Public  →  <account>.blob.core.windows.net
 *   USGov   →  <account>.blob.core.usgovcloudapi.net
 *   China   →  <account>.blob.core.chinacloudapi.cn
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
import { azureBlobHost, presignAzureBlobUrl } from './sas'

type AzureCloud = 'public' | 'usgov' | 'china'

interface AzureAdapterSettings {
  account: string
  accountKey: string
  container: string
  cloud: AzureCloud
  servingMode: 'public-url' | 'signed-redirect'
  publicUrlBase: string | null
  pathPrefix: string
}

function readSettings(api: ServerPluginApi): AzureAdapterSettings {
  const get = <T extends string | number | boolean = string>(key: string): T | undefined =>
    api.cms.settings.get<T>(key)

  const required = {
    account: String(get('account') ?? ''),
    accountKey: String(get('accountKey') ?? ''),
    container: String(get('container') ?? ''),
  }
  for (const [key, value] of Object.entries(required)) {
    if (!value) {
      throw new Error(`The "${key}" setting is empty — open the plugin's Settings dialog and fill it in.`)
    }
  }

  const cloudRaw = String(get('cloud') ?? 'public')
  const cloud: AzureCloud =
    cloudRaw === 'usgov' ? 'usgov' :
    cloudRaw === 'china' ? 'china' : 'public'

  const servingModeRaw = String(get('servingMode') ?? 'signed-redirect')
  const servingMode: AzureAdapterSettings['servingMode'] =
    servingModeRaw === 'public-url' ? 'public-url' : 'signed-redirect'

  const publicUrlBaseRaw = String(get('publicUrlBase') ?? '').trim()
  const publicUrlBase = publicUrlBaseRaw
    ? publicUrlBaseRaw.endsWith('/') ? publicUrlBaseRaw : publicUrlBaseRaw + '/'
    : null

  // Path prefix: never leads with `/`, always ends with `/` when non-empty.
  let pathPrefix = String(get('pathPrefix') ?? '').trim()
  while (pathPrefix.startsWith('/')) pathPrefix = pathPrefix.slice(1)
  if (pathPrefix && !pathPrefix.endsWith('/')) pathPrefix = pathPrefix + '/'

  return {
    account: required.account,
    accountKey: required.accountKey,
    container: required.container,
    cloud,
    servingMode,
    publicUrlBase,
    pathPrefix,
  }
}

/** Full blob name (path inside the container). Never starts with `/`. */
function blobName(settings: AzureAdapterSettings, storagePath: string): string {
  return settings.pathPrefix + storagePath
}

/**
 * Public renderer URL for `servingMode: 'public-url'`. Defaults to the
 * direct blob URL — works when the container's public access level is
 * `Blob` (anonymous read on blobs). Override with `publicUrlBase` to
 * front it with Azure Front Door / a custom domain.
 */
function publicReadUrl(settings: AzureAdapterSettings, storagePath: string): string {
  const blob = blobName(settings, storagePath)
  if (settings.publicUrlBase) {
    return settings.publicUrlBase + blob
  }
  return `https://${azureBlobHost(settings.account, settings.cloud)}/${settings.container}/${blob}`
}

async function buildSinglePutPlan(
  settings: AzureAdapterSettings,
  storagePath: string,
  mimeType: string,
): Promise<MediaStorageUploadPlan> {
  // 15 minutes — same window AWS uses. Long enough for any 50 MB
  // single-PUT we'd accept; short enough that a leaked URL is useless fast.
  const expiresInSeconds = 15 * 60
  const presign = await presignAzureBlobUrl({
    account: settings.account,
    accountKeyBase64: settings.accountKey,
    cloud: settings.cloud,
    container: settings.container,
    blob: blobName(settings, storagePath),
    signedResource: 'b',
    // c = create (allowed only if the blob doesn't yet exist), w = write
    // (allowed always). Together they let the executor PUT a brand-new
    // blob OR overwrite an existing one with the same name. The combo is
    // safer than `cw` order-flipped — Azure spec is `r-a-c-w-d-l-…`.
    permissions: 'cw',
    expiresInSeconds,
  })
  return {
    storagePath,
    steps: [{
      method: 'PUT',
      url: presign.url,
      // Azure requires `x-ms-blob-type: BlockBlob` on PUT-blob. The host
      // executor forwards every header in this map verbatim. Content-Type
      // is also surfaced so the stored blob's metadata records the MIME.
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': mimeType,
      },
    }],
    expiresAt: Date.now() + expiresInSeconds * 1000,
  }
}

/**
 * Build the adapter object. The closure captures `api` so every method
 * can re-read settings on each call — that way an admin's settings
 * change takes effect without a plugin re-registration.
 */
export function buildAzureBlobAdapter(api: ServerPluginApi): MediaStorageAdapter {
  const pluginId = api.plugin.id

  return {
    id: `${pluginId}.adapter`,
    label: 'Azure Blob Storage',
    roles: ['original', 'variant'],
    servingMode: readSettings(api).servingMode,

    /**
     * Phase 1: signed PUT URL the host's executor will stream the bytes to.
     */
    async beginWrite(input: MediaStorageBeginWriteInput): Promise<MediaStorageUploadPlan> {
      const settings = readSettings(api)
      return buildSinglePutPlan(settings, input.suggestedStoragePath, input.mimeType)
    },

    /**
     * Phase 2: bytes have landed. Compute the public renderer URL. For
     * single-PUT (the only path in v1) there's no commit — Azure already
     * committed when the PUT returned 201 Created.
     */
    async finalizeWrite(input: MediaStorageFinalizeWriteInput): Promise<MediaStorageWriteResult> {
      const settings = readSettings(api)
      const publicUrl = publicReadUrl(settings, input.storagePath)
      const etag = input.uploadReceipts[0]?.etag
      return {
        publicUrl,
        ...(etag ? { metadata: { etag } } : {}),
      }
    },

    /**
     * Cleanup when an upload failed mid-flight. Idempotent — DELETE on a
     * non-existent blob returns 404 and we don't propagate that as a failure.
     */
    async abortWrite(input: { storagePath: string }): Promise<void> {
      await issueSignedDelete(api, input.storagePath, 300)
    },

    /** Hard-delete — called when the admin purges from Trash, etc. */
    async delete(storagePath: string): Promise<void> {
      await issueSignedDelete(api, storagePath, 300)
    },

    /**
     * Mint a short-lived read URL the host's `/_pb/media/<id>/<path>`
     * route redirects to. 1 hour matches the other storage adapters —
     * long enough to survive a CDN warm-up, short enough that leaks
     * expire fast. Clamped defensively even though callers usually send
     * 3600 s.
     */
    async getReadUrl(storagePath: string, ttlSeconds: number) {
      const settings = readSettings(api)
      // Azure Service SAS max expiry is "any time" — but the Azure docs
      // recommend short lifetimes for ad-hoc SAS. We clamp to 24 h.
      const ttl = Math.max(60, Math.min(ttlSeconds, 86400))
      const presign = await presignAzureBlobUrl({
        account: settings.account,
        accountKeyBase64: settings.accountKey,
        cloud: settings.cloud,
        container: settings.container,
        blob: blobName(settings, storagePath),
        signedResource: 'b',
        permissions: 'r',
        expiresInSeconds: ttl,
      })
      return { url: presign.url, expiresAt: Date.now() + ttl * 1000 }
    },

    /**
     * Pre-flight check: issue a container-scoped SAS with `l` (list) and
     * GET the container's blob listing. Azure returns:
     *   200 — credentials + container both valid
     *   403 — signature wrong (bad account key or clock skew)
     *   404 — container doesn't exist (or account name typo)
     */
    async verify(): Promise<MediaStorageVerifyResult> {
      let settings: AzureAdapterSettings
      try {
        settings = readSettings(api)
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'Plugin settings missing',
          hint: 'Open the plugin Settings dialog and fill in every required field, then save.',
        }
      }

      // Account names: 3-24 chars, lowercase letters + digits only. Catch
      // an obvious paste-mistake early before the request hits the network.
      if (!/^[a-z0-9]{3,24}$/.test(settings.account)) {
        return {
          ok: false,
          reason: `Account name "${settings.account}" is not a valid Azure storage account name.`,
          hint: 'Azure storage account names are 3-24 chars, lowercase letters and digits only.',
        }
      }

      // Container names: 3-63 chars, lowercase letters / digits / dashes,
      // no leading or trailing dash, no consecutive dashes.
      if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(settings.container)) {
        return {
          ok: false,
          reason: `Container name "${settings.container}" is not a valid Azure container name.`,
          hint: 'Azure container names are 3-63 chars, lowercase letters / digits / hyphens, no leading or trailing hyphen, no consecutive hyphens.',
        }
      }

      try {
        const presign = await presignAzureBlobUrl({
          account: settings.account,
          accountKeyBase64: settings.accountKey,
          cloud: settings.cloud,
          container: settings.container,
          blob: '',
          signedResource: 'c',
          permissions: 'rl',
          expiresInSeconds: 60,
        })
        // Hit the "list blobs" endpoint — adds `restype=container&comp=list`
        // to the SAS URL. Azure honours SAS sigs on any extra query
        // parameters as long as the signed set (sv/se/sp/spr/sr/sig) is
        // present — those parameters are part of the canonical resource
        // identification, not the signature input.
        const listUrl = presign.url + '&restype=container&comp=list&maxresults=1'
        const response = await fetch(listUrl, { method: 'GET' })
        if (response.ok) return { ok: true }

        // Azure returns text/XML error bodies. We don't parse them — the
        // status code alone is informative enough for the admin UI.
        return {
          ok: false,
          reason: `Azure returned ${response.status} ${response.statusText || ''}`.trim(),
          hint:
            response.status === 403
              ? 'Signature rejected. Most likely the Account Key is wrong — re-copy `key1` or `key2` from Azure portal → Storage account → Access keys. Also check the system clock isn\'t skewed.'
              : response.status === 404
                ? `Container "${settings.container}" not found on account "${settings.account}". Create it via Azure portal → Storage account → Containers, or fix the names in plugin settings.`
                : 'Check the storage account name, the network connectivity to Azure, and the cloud setting (public / usgov / china).',
        }
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'fetch failed',
          hint: 'Check that the Azure Blob endpoint is reachable from this server and allowed in the plugin manifest\'s networkAllowedHosts.',
        }
      }
    },

    /**
     * Declared at registration so the publisher's CSP includes the Azure
     * Blob origins on every published page — otherwise the browser would
     * refuse to render `<img src="https://account.blob.core.windows.net/…">`
     * under the default `img-src 'self'` policy.
     */
    cspOrigins: [
      { directive: 'img-src', origin: '*.blob.core.windows.net' },
      { directive: 'img-src', origin: '*.blob.core.usgovcloudapi.net' },
      { directive: 'img-src', origin: '*.blob.core.chinacloudapi.cn' },
      { directive: 'media-src', origin: '*.blob.core.windows.net' },
      { directive: 'media-src', origin: '*.blob.core.usgovcloudapi.net' },
      { directive: 'media-src', origin: '*.blob.core.chinacloudapi.cn' },
    ],
  }
}

/**
 * `abortWrite` + `delete` helper. Mints a blob-scoped SAS with `d`
 * permission and fires a DELETE. Failures are logged but not propagated:
 * delete is idempotent, and we don't want a flaky network to keep an
 * admin spinning on a "purge" action.
 */
async function issueSignedDelete(
  api: ServerPluginApi,
  storagePath: string,
  ttlSeconds: number,
): Promise<void> {
  const settings = readSettings(api)
  const presign = await presignAzureBlobUrl({
    account: settings.account,
    accountKeyBase64: settings.accountKey,
    cloud: settings.cloud,
    container: settings.container,
    blob: blobName(settings, storagePath),
    signedResource: 'b',
    permissions: 'd',
    expiresInSeconds: ttlSeconds,
  })
  try {
    await fetch(presign.url, { method: 'DELETE' })
  } catch (err) {
    api.plugin.log(`[azure] DELETE "${storagePath}" failed (orphaned):`, err)
  }
}
