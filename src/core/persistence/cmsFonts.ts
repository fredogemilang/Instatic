/**
 * Client-side wrappers for the fonts CMS endpoints.
 *
 * - `listCmsGoogleFonts` returns the bundled directory snapshot via the server
 *   (rather than importing the JSON directly) so the editor stays a thin client.
 * - `estimateCmsGoogleFont` returns the total woff2 download size for a
 *   selection without committing files — used by the picker to show a live
 *   "selected: 42 KB" hint before the user clicks Install.
 * - `installCmsGoogleFont` posts the user's chosen variants/subsets and returns
 *   a fully-shaped `FontEntry` to merge into `site.settings.fonts`.
 * - `registerCustomFont` posts uploaded media-asset ids + variants and returns
 *   a `FontEntry` (`source: 'custom'`) to merge into `site.settings.fonts`.
 * - `deleteCmsFontFamily` removes the on-disk woff2 files for a Google family
 *   slug. Custom fonts reference shared media assets, so removing one is a
 *   metadata-only edit — no server call.
 */

import { parseJsonResponse } from '@core/utils/jsonValidate'
import type { FontEntry } from '@core/fonts/schemas'
import { responseErrorMessage } from '@core/http'
import {
  type CmsFontEstimateDto,
  CmsFontEntryEnvelopeSchema,
  CmsFontEstimateEnvelopeSchema,
  CmsGoogleFontsEnvelopeSchema,
  type GoogleFontFamilyDto,
} from './responseSchemas'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

export async function listCmsGoogleFonts(
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<GoogleFontFamilyDto[]> {
  const res = await fetchImpl(`${basePath}/fonts/google`, {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `Google fonts list failed with ${res.status}`))
  }
  const payload = await parseJsonResponse(res, CmsGoogleFontsEnvelopeSchema)
  return payload.families
}

export interface InstallGoogleFontRequest {
  family: string
  variants: string[]
  subsets: string[]
}

/**
 * Ask the server for the on-disk size that a (family × variants × subsets)
 * selection would download. The server fetches the Google CSS2 stylesheet and
 * HEADs each woff2 URL, so this is one round-trip per call from the client's
 * point of view. Caller is responsible for debouncing rapid selection changes.
 */
export async function estimateCmsGoogleFont(
  request: InstallGoogleFontRequest,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
  init?: { signal?: AbortSignal },
): Promise<CmsFontEstimateDto> {
  const res = await fetchImpl(`${basePath}/fonts/estimate`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal: init?.signal,
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `Font estimate failed with ${res.status}`))
  }
  return parseJsonResponse(res, CmsFontEstimateEnvelopeSchema)
}

export async function installCmsGoogleFont(
  request: InstallGoogleFontRequest,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<FontEntry> {
  const res = await fetchImpl(`${basePath}/fonts/install`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `Font install failed with ${res.status}`))
  }
  const payload = await parseJsonResponse(res, CmsFontEntryEnvelopeSchema)
  // Server-side `installGoogleFont` returns a fully-shaped FontEntry; the
  // envelope schema treats the inner shape as `unknown` to avoid duplicating
  // FontEntry's structure here. validateSite() will catch any drift the next
  // time the site is saved.
  return payload.font as FontEntry
}

export interface RegisterCustomFontRequest {
  family: string
  files: { mediaAssetId: string; variant: string }[]
}

/**
 * Register a custom font from already-uploaded media assets. The binaries are
 * uploaded separately through the media route; this posts the asset ids +
 * chosen variants and returns a fully-shaped `FontEntry` to merge into
 * `site.settings.fonts` via the `addFont` action.
 */
export async function registerCustomFont(
  request: RegisterCustomFontRequest,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<FontEntry> {
  const res = await fetchImpl(`${basePath}/fonts/custom`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `Custom font registration failed with ${res.status}`))
  }
  const payload = await parseJsonResponse(res, CmsFontEntryEnvelopeSchema)
  return payload.font as FontEntry
}

export async function deleteCmsFontFamily(
  family: string,
  fetchImpl: FetchLike = defaultFetch,
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/fonts/family/${encodeURIComponent(family)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `Font delete failed with ${res.status}`))
  }
}
