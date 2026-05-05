import type { Page, SiteDocument } from '@core/page-tree/schemas'
import type { IModuleRegistry } from '@core/module-engine/types'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import { publishPage } from '@core/publisher/render'
import { prefetchLoopData } from '../loopPrefetch'
import type { DbClient } from '../db/client'
import {
  buildSiteRuntimeScripts,
  type BuiltRuntimeAssetFile,
  type BuildSiteRuntimeScriptsInput,
  type SiteRuntimeBuildResult,
} from './bundleScripts'

export interface RuntimePreviewDocumentInput {
  site: SiteDocument
  page: Page
  registry: IModuleRegistry
  assetBasePath: string
  dependencyCache?: BuildSiteRuntimeScriptsInput['dependencyCache']
  dependencyNodeModulesDir?: string
  breakpointId?: string
  templateContext?: TemplateRenderDataContext
  /**
   * Optional DB client — when supplied, every `base.loop` node on the
   * page is pre-fetched against the database, so loops render with real
   * data in the editor's runtime preview (iframe canvas). Without it,
   * loops emit a "no resolved data" comment.
   */
  db?: DbClient
}

export interface RuntimePreviewDocumentResult extends SiteRuntimeBuildResult {
  html: string
  files: BuiltRuntimeAssetFile[]
}

export async function buildRuntimePreviewDocument(
  input: RuntimePreviewDocumentInput,
): Promise<RuntimePreviewDocumentResult> {
  const runtimeBuild = await buildSiteRuntimeScripts({
    site: input.site,
    page: input.page,
    target: 'canvas',
    assetBasePath: input.assetBasePath,
    dependencyCache: input.dependencyCache,
    dependencyNodeModulesDir: input.dependencyNodeModulesDir,
  })
  const loopData = input.db
    ? await prefetchLoopData(input.page, input.site, input.db)
    : undefined
  const html = publishPage(input.page, input.site, input.registry, {
    breakpointId: input.breakpointId,
    templateContext: input.templateContext,
    runtimeAssets: runtimeBuild.runtimeAssets,
    loopData,
  }).html

  return {
    ...runtimeBuild,
    html,
  }
}
