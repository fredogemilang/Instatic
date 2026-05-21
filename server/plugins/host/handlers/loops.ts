/**
 * Loop source registration handler — implements the `cms.loops.registerSource`
 * api-call.
 *
 * Gated by the `loops.register` permission. The registered source is a shim
 * that delegates its `fetch` method to the plugin's worker via the RPC layer.
 * The `preview` method is intentionally a no-op (returns []) — the editor
 * uses the publisher's fetch path for live preview (see useLoopPreviewItems),
 * and any plugin that ships a synchronous preview-only path can be added later
 * via a worker-backed sync invariant.
 */

import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopSourceRegisterApiCall } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { assertHostPluginPermission } from '../registry'
import { replyApiOk } from '../workerPool'
import { runLoopFetchInWorker } from '../rpc'
import type { HostPluginRecord } from '../types'

export async function handleLoopsRegisterSource(
  msg: LoopSourceRegisterApiCall,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'loops.register')
  const [descriptor] = msg.args
  if (!descriptor.id?.startsWith(`${msg.pluginId}.`)) {
    throw new Error(
      `Loop source id "${descriptor.id}" must start with the plugin id "${msg.pluginId}.".`,
    )
  }
  const fullSource = {
    ...descriptor,
    fetch: async (ctx: unknown) => {
      return await runLoopFetchInWorker(msg.pluginId, descriptor.id, ctx)
    },
    preview: () => {
      return []
    },
  }
  entry.loopSources.push({ pluginId: msg.pluginId, sourceId: descriptor.id })
  loopSourceRegistry.registerOrReplace(fullSource)
  replyApiOk(msg.pluginId, msg.correlationId)
}
