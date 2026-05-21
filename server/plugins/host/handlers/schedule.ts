/**
 * Plugin schedule handlers — implements cms.schedule.register and
 * cms.schedule.cancel api-calls.
 *
 * Both are gated by the `cms.schedule` permission. Registration delegates to
 * `pluginScheduleRegistration` which owns the DB upsert and next_run_at
 * calculation, keeping all cadence math in one place so registration and
 * tick share identical interpretation. Cancellation marks the schedule as
 * disabled in the database.
 */

import { registerPluginSchedule } from '../../pluginScheduleRegistration'
import { disablePluginSchedule } from '../../../repositories/pluginSchedules'
import type { ScheduleRegisterApiCall, ScheduleCancelApiCall } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { assertHostPluginPermission } from '../registry'
import { replyApiOk } from '../workerPool'
import type { HostPluginRecord } from '../types'

export async function handleScheduleRegister(
  msg: ScheduleRegisterApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.schedule')
  const [arg] = msg.args
  await registerPluginSchedule(db, {
    pluginId: msg.pluginId,
    scheduleId: arg.scheduleId,
    cadence: arg.cadence,
    overlap: arg.overlap,
    maxDurationMs: arg.maxDurationMs,
  })
  replyApiOk(msg.pluginId, msg.correlationId)
}

export async function handleScheduleCancel(
  msg: ScheduleCancelApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.schedule')
  const [{ scheduleId }] = msg.args
  await disablePluginSchedule(db, msg.pluginId, scheduleId)
  replyApiOk(msg.pluginId, msg.correlationId)
}
