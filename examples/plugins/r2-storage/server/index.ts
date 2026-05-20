/**
 * Cloudflare R2 Storage Adapter — plugin entry point.
 *
 * Runs entirely inside the QuickJS-WASM sandbox. The plugin's only
 * privileged operations are:
 *   • `crypto.subtle.digest` + `crypto.subtle.sign` — host-bridged
 *     SHA-256 + HMAC-SHA256 for SigV4 signing.
 *   • `fetch` — gated by `network.outbound` + `networkAllowedHosts`.
 *     Used only for HEAD verify + DELETE cleanup; the BYTES of every
 *     upload flow through the host directly (the executor in
 *     `server/handlers/cms/mediaUploadExecutor.ts`), never through this VM.
 *   • `api.cms.media.registerStorageAdapter` — registers the adapter
 *     shim with the host.
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { buildR2Adapter } from './adapter'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log(
      'Cloudflare R2 Storage installed. Open the plugin\'s Settings dialog, fill in the Account ID + R2 API token, then elect it in the Media → Storage panel.',
    )
  },

  async activate(api: ServerPluginApi) {
    const adapter = buildR2Adapter(api)
    api.cms.media.registerStorageAdapter(adapter)
    api.plugin.log(`Registered "${adapter.label}" adapter (id: ${adapter.id}).`)
  },
}

export default mod
