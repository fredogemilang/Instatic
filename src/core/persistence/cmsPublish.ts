import { readEnvelope } from '@core/http'
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
  return readEnvelope(res, CmsPublishResultSchema, `CMS publish failed with ${res.status}`)
}

export async function getCmsPublishStatus(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPublishStatus> {
  const res = await fetchImpl(`${basePath}/publish/status`, {
    method: 'GET',
    credentials: 'include',
  })
  return readEnvelope(res, CmsPublishStatusSchema, `CMS publish status failed with ${res.status}`)
}
