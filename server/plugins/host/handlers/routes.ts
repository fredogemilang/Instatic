/**
 * Route registration handler — implements the `cms.routes.register` api-call.
 *
 * Validates the route capability against the core capability enum and upserts
 * the route entry into the plugin's host-side route map. Gated by the
 * `cms.routes` permission.
 */

import { isCoreCapability } from '../../../auth/capabilities'
import type { RouteRegistrationApiCall } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { assertHostPluginPermission } from '../registry'
import { replyApiOk } from '../workerPool'
import type { HostPluginRecord } from '../types'

export async function handleRoutesRegister(
  msg: RouteRegistrationApiCall,
  entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.routes')
  const [arg] = msg.args
  if (arg.capability !== null && !isCoreCapability(arg.capability)) {
    throw new Error(`Unknown plugin route capability: ${arg.capability}`)
  }
  entry.routes.set(arg.routeKey, {
    pluginId: msg.pluginId,
    method: arg.method,
    path: arg.path,
    capability: arg.capability,
    routeKey: arg.routeKey,
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}
