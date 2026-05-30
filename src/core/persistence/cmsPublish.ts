import { parseJsonResponse } from '@core/utils/jsonValidate'
import { assertOk } from '@core/http'
import {
  CmsPublishResultSchema,
  CmsPublishStatusSchema,
  type CmsPublishResult,
  type CmsPublishStatus,
} from './responseSchemas'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function publishCmsDraft(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPublishResult> {
  const res = await fetchImpl(`${basePath}/publish`, {
    method: 'POST',
    credentials: 'include',
  })
  await assertOk(res, `CMS publish failed with ${res.status}`)
  return await parseJsonResponse(res, CmsPublishResultSchema)
}

export async function getCmsPublishStatus(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPublishStatus> {
  const res = await fetchImpl(`${basePath}/publish/status`, {
    method: 'GET',
    credentials: 'include',
  })
  await assertOk(res, `CMS publish status failed with ${res.status}`)
  return await parseJsonResponse(res, CmsPublishStatusSchema)
}
