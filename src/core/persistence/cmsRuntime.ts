import type {
  PublishedPageRuntimeAssets,
  RuntimePackageImportmap,
  SiteDependencyLock,
  SiteRuntimeDiagnostic,
} from '@core/site-runtime'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { readEnvelope } from '@core/http'
import {
  CmsRuntimeDependencyEnvelopeSchema,
  CmsRuntimePreviewResponseSchema,
  type CmsRuntimePreviewAsset,
} from './responseSchemas'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type { CmsRuntimePreviewAsset }

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
  // The envelope schema validates SiteDependencyLock + RuntimePackageImportmap
  // in full (both own canonical schemas in @core/site-runtime), so the parsed
  // body is already correctly typed — no cast needed.
  const body = await readEnvelope(
    res,
    CmsRuntimeDependencyEnvelopeSchema,
    `Runtime dependency resolution failed with ${res.status}`,
  )
  return {
    dependencyLock: body.dependencyLock,
    ...(body.packageImportmap ? { packageImportmap: body.packageImportmap } : {}),
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
  // The envelope schema validates the assets, runtimeAssets, and diagnostics
  // shapes in full against the canonical @core/site-runtime schemas, so the
  // parsed body matches CmsRuntimePreviewResult directly — no cast needed.
  const body = await readEnvelope(
    res,
    CmsRuntimePreviewResponseSchema,
    `Runtime preview build failed with ${res.status}`,
  )
  return {
    html: body.html,
    assets: body.assets,
    runtimeAssets: body.runtimeAssets,
    diagnostics: body.diagnostics,
  }
}
