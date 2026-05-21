/**
 * Plugin storage (data_rows) handlers — implements cms.storage.{list,create,
 * update,delete} api-calls.
 *
 * All four are gated by the `cms.storage` permission. Data is written to the
 * `data_rows` table scoped to the plugin id + resource id. Record data is
 * validated against the plugin's resource schema when a matching resource
 * definition is found in the manifest.
 */

import { nanoid } from 'nanoid'
import type { PluginRecord } from '@core/plugin-sdk'
import { findPluginResource, validatePluginRecordData } from '@core/plugins/manifest'
import {
  createPluginRecord,
  deletePluginRecord,
  listPluginRecords,
  updatePluginRecord,
} from '../../../repositories/plugins'
import type {
  StorageListApiCall,
  StorageCreateApiCall,
  StorageUpdateApiCall,
  StorageDeleteApiCall,
} from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { assertHostPluginPermission } from '../registry'
import { replyApiOk } from '../workerPool'
import type { HostPluginRecord } from '../types'

export async function handleStorageList(
  msg: StorageListApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.storage')
  const [resourceId, options] = msg.args
  const result = await listPluginRecords(db, msg.pluginId, resourceId, options)
  replyApiOk(msg.pluginId, msg.correlationId, result as unknown)
}

export async function handleStorageCreate(
  msg: StorageCreateApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.storage')
  const [resourceId, data] = msg.args
  const resource = findPluginResource(entry.manifest, resourceId)
  const cleanedData = resource ? validatePluginRecordData(resource, data) : data
  const created: PluginRecord = await createPluginRecord(db, {
    id: nanoid(),
    pluginId: msg.pluginId,
    resourceId,
    data: cleanedData,
  })
  replyApiOk(msg.pluginId, msg.correlationId, created as unknown)
}

export async function handleStorageUpdate(
  msg: StorageUpdateApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.storage')
  const [resourceId, recordId, data] = msg.args
  const resource = findPluginResource(entry.manifest, resourceId)
  const cleanedData = resource ? validatePluginRecordData(resource, data) : data
  const updated = await updatePluginRecord(db, {
    id: recordId,
    pluginId: msg.pluginId,
    resourceId,
    data: cleanedData,
  })
  replyApiOk(msg.pluginId, msg.correlationId, updated as unknown)
}

export async function handleStorageDelete(
  msg: StorageDeleteApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.storage')
  const [resourceId, recordId] = msg.args
  const ok = await deletePluginRecord(db, {
    id: recordId,
    pluginId: msg.pluginId,
    resourceId,
  })
  replyApiOk(msg.pluginId, msg.correlationId, ok as unknown)
}
