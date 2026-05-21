/**
 * CMS pages handlers — implements cms.pages.list, cms.pages.republish, and
 * cms.pages.republishAll api-calls.
 *
 * `list` is gated by `cms.pages.read`; `republish` and `republishAll` are
 * gated by `cms.pages.publish`.
 */

import { listPluginPageSummaries } from '../../../repositories/publish'
import { republishSinglePage, republishAllPages } from '../../../publish/republish'
import type {
  CmsPagesListApiCall,
  CmsPagesRepublishApiCall,
  CmsPagesRepublishAllApiCall,
} from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { assertHostPluginPermission } from '../registry'
import { replyApiOk } from '../workerPool'
import type { HostPluginRecord } from '../types'

export async function handleCmsPagesList(
  msg: CmsPagesListApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.pages.read')
  const pages = await listPluginPageSummaries(db)
  replyApiOk(msg.pluginId, msg.correlationId, pages as unknown)
}

export async function handleCmsPagesRepublish(
  msg: CmsPagesRepublishApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.pages.publish')
  const [pageId] = msg.args
  await republishSinglePage(db, String(pageId))
  replyApiOk(msg.pluginId, msg.correlationId, undefined)
}

export async function handleCmsPagesRepublishAll(
  msg: CmsPagesRepublishAllApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  assertHostPluginPermission(entry, 'cms.pages.publish')
  const count = await republishAllPages(db)
  replyApiOk(msg.pluginId, msg.correlationId, { count })
}
