import { parseJsonResponse } from '@core/utils/jsonValidate'
import { responseErrorMessage } from './httpErrors'
import {
  CmsPublishResultSchema,
  CmsPublishStatusSchema,
} from './responseSchemas'

interface CmsPublishResult {
  publishedPages: number
}

interface CmsPublishStatus {
  hasPublishedVersion: boolean
  draftMatchesPublished: boolean
  draftPages: number
  publishedPages: number
  lastPublishedAt?: string
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function publishCmsDraft(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<CmsPublishResult> {
  const res = await fetchImpl(`${basePath}/publish`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `CMS publish failed with ${res.status}`))
  }
  return await parseJsonResponse(res, CmsPublishResultSchema)
}

export async function getCmsPublishStatus(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<CmsPublishStatus> {
  const res = await fetchImpl(`${basePath}/publish/status`, {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `CMS publish status failed with ${res.status}`))
  }
  return await parseJsonResponse(res, CmsPublishStatusSchema)
}
