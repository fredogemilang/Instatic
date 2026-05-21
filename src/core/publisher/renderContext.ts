/**
 * Publisher — shared render context + the value types it carries.
 *
 * Every recursive call into a renderer flows through one `RenderContext`
 * object. Pulling the shape into its own file lets the standard renderer
 * (`renderNode.ts`), the specialised renderers (`renderVisualComponentRef.ts`,
 * `renderLoop.ts`), and the page orchestrator (`render.ts`) all import the
 * same type without circular dependencies.
 */

import type { Page, SiteDocument } from '@core/page-tree'
import type { IModuleRegistry } from '@core/module-engine/types'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import type { LoopFetchResult } from '@core/loops/types'

/**
 * Resolved loop data for one `base.loop` node, produced by the server's
 * `prefetchLoopData()` helper before publishing.
 */
export interface ResolvedLoopRenderData extends LoopFetchResult {
  /** 1-indexed page number when the loop is in `infinite` mode. */
  pageNumber: number
  /** Whether more rows remain past the current page. */
  hasMore: boolean
}

/**
 * Resolved media-asset payload attached to a prop at render time. The pure
 * render function reads `props._resolvedMediaByKey[<propKey>]` to get the
 * variant ladder / BlurHash / intrinsic dimensions for any of its
 * image/media-typed props, and uses it to emit responsive markup. Falls
 * back to the raw prop string when undefined, so non-CMS URLs or pages
 * built before `prefetchMediaAssets` ran still render correctly.
 */
export interface RenderResolvedMedia {
  publicPath: string
  width: number | null
  height: number | null
  altText: string
  blurHash: string | null
  variants: ReadonlyArray<{
    width: number
    height: number
    format: 'webp' | 'jpeg' | 'png' | 'avif'
    path: string
    sizeBytes: number
  }>
  posterPath: string | null
}

export interface RenderContext {
  page: Page
  site: SiteDocument
  registry: IModuleRegistry
  breakpointId: string | undefined
  templateContext?: TemplateRenderDataContext
  /**
   * Pre-fetched media assets, keyed by `public_path`. Populated by
   * `server/publish/mediaPrefetch.ts` before `publishPage()` is called.
   * Used to enrich image / media props with srcset, sizes, BlurHash, and
   * intrinsic dimensions before each module's `render()` runs.
   */
  mediaAssets?: Map<string, RenderResolvedMedia>
  /**
   * CSS deduplication map: moduleId → CSS string.
   * Each module type contributes at most one CSS entry regardless of instance count.
   * Decision #308: keying by moduleId is O(1); at 200 nodes saves ~60–80% CSS vs naive concat.
   */
  cssMap: Map<string, string>
  /**
   * Pre-fetched loop data, keyed by loop nodeId. Populated by
   * `server/publish/loopPrefetch.ts` before `publishPage()` is called.
   * Loops without an entry here render empty.
   */
  loopData?: Map<string, ResolvedLoopRenderData>
  /**
   * Set of loop nodeIds on the page that requested the infinite-scroll
   * runtime. The publisher reads this after rendering to decide whether
   * to inject the `loop-runtime.js` `<script>` tag.
   */
  infiniteLoopIds?: Set<string>
}
