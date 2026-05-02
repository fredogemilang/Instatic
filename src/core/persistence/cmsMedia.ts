import { parseJsonResponse, safeParseJson } from '@core/utils/jsonValidate'
import { responseErrorMessage } from './httpErrors'
import {
  CmsMediaAssetEnvelopeSchema,
  CmsMediaListResponseSchema,
} from './responseSchemas'

export interface CmsMediaAsset {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  publicPath: string
  createdAt: string
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export async function listCmsMediaAssets(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<CmsMediaAsset[]> {
  const res = await fetchImpl(`${basePath}/media`, {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `CMS media listing failed with ${res.status}`))
  }
  // Use safeParseJson here so a malformed response degrades to an empty list
  // instead of crashing the media panel — preserves prior behaviour.
  const text = await res.text()
  const parsed = safeParseJson(text, CmsMediaListResponseSchema)
  return parsed.ok && parsed.value.assets ? parsed.value.assets : []
}

export async function uploadCmsMediaAsset(
  file: File,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<CmsMediaAsset> {
  const body = new FormData()
  body.set('file', file)

  const res = await fetchImpl(`${basePath}/media`, {
    method: 'POST',
    credentials: 'include',
    body,
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `CMS media upload failed with ${res.status}`))
  }
  const payload = await parseJsonResponse(res, CmsMediaAssetEnvelopeSchema)
  return payload.asset
}

export async function renameCmsMediaAsset(
  assetId: string,
  filename: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<CmsMediaAsset> {
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filename }),
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `CMS media rename failed with ${res.status}`))
  }
  const payload = await parseJsonResponse(res, CmsMediaAssetEnvelopeSchema)
  return payload.asset
}

export async function deleteCmsMediaAsset(
  assetId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/media/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `CMS media delete failed with ${res.status}`))
  }
}
