/**
 * Azure Blob Storage Adapter — plugin entry point.
 *
 * Runs entirely inside the QuickJS-WASM sandbox. Bytes never cross the
 * VM boundary; the plugin only signs URLs the host then streams to.
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { buildAzureBlobAdapter } from './adapter'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log(
      'Azure Blob Storage installed. Open the plugin\'s Settings dialog, fill in the storage account, account key, and container, then elect it in the Media → Storage panel.',
    )
  },

  async activate(api: ServerPluginApi) {
    const adapter = buildAzureBlobAdapter(api)
    api.cms.media.registerStorageAdapter(adapter)
    api.plugin.log(`Registered "${adapter.label}" adapter (id: ${adapter.id}).`)
  },
}

export default mod
