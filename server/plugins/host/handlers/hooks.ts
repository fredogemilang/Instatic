/**
 * Hook bus handlers — implements cms.hooks.on, cms.hooks.filter, and
 * cms.hooks.emit api-calls.
 *
 * All three are gated by the `cms.hooks` permission. Listeners and filters
 * are thin shims that round-trip to the plugin's worker via the RPC layer.
 */

import { hookBus } from '@core/plugins/hookBus'
import type { HookOnApiCall, HookFilterApiCall, HookEmitApiCall } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { assertHostPluginPermission } from '../registry'
import { replyApiOk } from '../workerPool'
import { runHookListenerInWorker, runHookFilterInWorker } from '../rpc'
import type { HostPluginRecord } from '../types'

export async function handleHooksOn(
  msg: HookOnApiCall,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.hooks')
  const [{ event, listenerId }] = msg.args
  entry.hookListeners.push({ pluginId: msg.pluginId, listenerId })
  // The hookBus listener is a thin shim that round-trips back to the worker.
  hookBus.on(msg.pluginId, event, async (payload: unknown) => {
    await runHookListenerInWorker(msg.pluginId, listenerId, event, payload)
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleHooksFilter(
  msg: HookFilterApiCall,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.hooks')
  const [{ name, filterId }] = msg.args
  entry.hookFilters.push({ pluginId: msg.pluginId, filterId })
  hookBus.filter(msg.pluginId, name, async (value: unknown, context: { pluginId: string } & Record<string, unknown>) => {
    return await runHookFilterInWorker(msg.pluginId, filterId, name, value, context)
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleHooksEmit(
  msg: HookEmitApiCall,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.hooks')
  const [{ event, payload }] = msg.args
  await hookBus.emit(event, payload)
  replyApiOk(msg.pluginId, msg.correlationId)
}
