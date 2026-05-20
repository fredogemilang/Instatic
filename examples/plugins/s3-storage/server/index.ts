/**
 * S3 Storage Adapter — plugin entry point.
 *
 * Runs entirely inside the QuickJS-WASM sandbox. The plugin's only
 * privileged operations are:
 *   • `crypto.subtle.digest` + `crypto.subtle.sign` — host-bridged
 *     SHA-256 + HMAC-SHA256 for AWS Sigv4 signing.
 *   • `fetch` — gated by `network.outbound` permission +
 *     `networkAllowedHosts` allowlist. Used only for HEAD verify and
 *     DELETE cleanup; the BYTES of every upload flow through the host
 *     directly (the executor in `server/handlers/cms/mediaUploadExecutor.ts`),
 *     never through this VM.
 *   • `api.cms.media.registerStorageAdapter` — the SDK surface we exist
 *     to call. Registers the adapter shim with the host.
 *
 * Lifecycle:
 *   • `install` — fires once per package version. We log a friendly
 *     "open Settings" reminder; nothing to do.
 *   • `activate` — fires on every server boot AND after settings change.
 *     We register the adapter; the host's storage admin panel can then
 *     elect it for a role.
 *   • `deactivate` / `uninstall` — host's plugin runtime tears the
 *     adapter down via `mediaStorageRegistry.unregisterPlugin(pluginId)`
 *     without us needing to do anything explicit here.
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { buildS3Adapter } from './adapter'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log(
      'Amazon S3 Storage installed. Open the plugin\'s Settings dialog, fill in the AWS credentials + bucket, then elect it in the Media → Storage panel.',
    )
  },

  async activate(api: ServerPluginApi) {
    // Adapter object closes over `api` so each method can re-read
    // settings live — settings changes don't require re-registration.
    // (The QuickJS worker's local settings cache is the only thing
    // that needs to be in sync, which the host runtime handles via
    // `settings.changed` propagation.)
    const adapter = buildS3Adapter(api)
    api.cms.media.registerStorageAdapter(adapter)
    api.plugin.log(`Registered "${adapter.label}" adapter (id: ${adapter.id}).`)
  },
}

export default mod
