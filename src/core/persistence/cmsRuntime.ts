import type {
  PublishedPageRuntimeAssets,
  RuntimePackageImportmap,
  SiteDependencyLock,
  SiteRuntimeDiagnostic,
} from '@core/site-runtime'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { parseJsonResponse } from '@core/utils/jsonValidate'
import { assertOk } from '@core/http'
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

export interface CmsRuntimeDependencyResolveResult {
  dependencyLock: SiteDependencyLock
  /**
   * Precomputed importmap from the server's `bun install` cache. Absent
   * when the lock has no resolvable packages or the install step skipped.
   * Callers that get an importmap should persist it on
   * `site.runtime.packageImportmap` so the editor iframe sandbox and the
   * published page consume the same URLs.
   */
  packageImportmap?: RuntimePackageImportmap
}

export async function resolveCmsRuntimeDependencies(
  packageJson: SitePackageJson,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRuntimeDependencyResolveResult> {
  const res = await fetchImpl(`${basePath}/runtime/dependencies/resolve`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageJson }),
  })
  await assertOk(res, `Runtime dependency resolution failed with ${res.status}`)
  // Envelope validated; SiteDependencyLock + RuntimePackageImportmap are
  // both deep shapes — pass through as unknown, then the casts below
  // restore the typed surface for callers.
  const body = await parseJsonResponse(res, CmsRuntimeDependencyEnvelopeSchema)
  return {
    dependencyLock: body.dependencyLock as SiteDependencyLock,
    ...(body.packageImportmap
      ? { packageImportmap: body.packageImportmap as RuntimePackageImportmap }
      : {}),
  }
}

export async function buildCmsRuntimePreview(
  input: CmsRuntimePreviewInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRuntimePreviewResult> {
  const res = await fetchImpl(`${basePath}/runtime/preview`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  await assertOk(res, `Runtime preview build failed with ${res.status}`)
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
