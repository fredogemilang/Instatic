/**
 * Google Cloud Storage Adapter — plugin entry point.
 *
 * Runs entirely inside the QuickJS-WASM sandbox. Bytes never cross
 * the VM boundary; the plugin only signs URLs the host then streams to.
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { buildGcsAdapter } from './adapter'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log(
      'Google Cloud Storage installed. Open the plugin\'s Settings dialog, fill in the HMAC access ID + secret + bucket, then elect it in the Media → Storage panel.',
    )
  },

  async activate(api: ServerPluginApi) {
    const adapter = buildGcsAdapter(api)
    api.cms.media.registerStorageAdapter(adapter)
    api.plugin.log(`Registered "${adapter.label}" adapter (id: ${adapter.id}).`)
  },
}

export default mod
