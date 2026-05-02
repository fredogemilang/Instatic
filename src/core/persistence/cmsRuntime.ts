import type {
  PublishedPageRuntimeAssets,
  SiteDependencyLock,
  SiteRuntimeDiagnostic,
} from '../site-runtime'
import type { SitePackageJson } from '../site-dependencies/manifest'
import type { TemplateRenderDataContext } from '../templates/dynamicBindings'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { responseErrorMessage } from './httpErrors'
import {
  CmsRuntimeDependencyEnvelopeSchema,
  CmsRuntimePreviewResponseSchema,
} from './responseSchemas'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface CmsRuntimePreviewAsset {
  path: string
  publicPath: string
  content: string
  contentType: string
}

export interface CmsRuntimePreviewResult {
  html: string
  assets: CmsRuntimePreviewAsset[]
  runtimeAssets: PublishedPageRuntimeAssets
  diagnostics: SiteRuntimeDiagnostic[]
}

export interface CmsRuntimePreviewInput {
  site: unknown
  pageId: string
  breakpointId?: string
  templateContext?: TemplateRenderDataContext
}

export async function resolveCmsRuntimeDependencies(
  packageJson: SitePackageJson,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<SiteDependencyLock> {
  const res = await fetchImpl(`${basePath}/runtime/dependencies/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageJson }),
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `Runtime dependency resolution failed with ${res.status}`))
  }
  // Envelope validated; SiteDependencyLock is deep — passes through as
  // unknown, then the cast below restores the typed surface for callers.
  const body = await parseJsonResponse(res, CmsRuntimeDependencyEnvelopeSchema)
  return body.dependencyLock as SiteDependencyLock
}

export async function buildCmsRuntimePreview(
  input: CmsRuntimePreviewInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/api/cms',
): Promise<CmsRuntimePreviewResult> {
  const res = await fetchImpl(`${basePath}/runtime/preview`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    throw new Error(await responseErrorMessage(res, `Runtime preview build failed with ${res.status}`))
  }
  // Envelope validated; deep nested types (PublishedPageRuntimeAssets,
  // SiteRuntimeDiagnostic) pass through as unknown — see responseSchemas.ts
  // for the strategy. Callers continue to see the original interface.
  const body = await parseJsonResponse(res, CmsRuntimePreviewResponseSchema)
  return {
    html: body.html,
    assets: body.assets as CmsRuntimePreviewResult['assets'],
    runtimeAssets: body.runtimeAssets as PublishedPageRuntimeAssets,
    diagnostics: body.diagnostics as SiteRuntimeDiagnostic[],
  }
}
