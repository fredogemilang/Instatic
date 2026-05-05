/**
 * Server-side loop pre-fetch.
 *
 * Walks a page tree, finds every `base.loop` node, dispatches to the
 * registered LoopEntitySource's `fetch()`, and returns a map keyed by
 * loop nodeId → fetched items + pagination metadata. The publisher's
 * loop interceptor then reads from this map without performing any I/O.
 *
 * Pre-fetching all loop data up front means the renderer stays a pure
 * synchronous walk and CSS dedup keeps working unchanged.
 */

import type { Page, PageNode, SiteDocument } from '@core/page-tree/schemas'
import type {
  LoopEntitySource,
  LoopFetchResult,
  LoopItem,
  SourceFetchContext,
} from '@core/loops/types'
import { loopSourceRegistry } from '@core/loops/registry'
import { firstImagePathFromMarkdown } from '@core/markdown/renderContentMarkdown'
import { normalizeRouteBase } from '@core/templates/templateMatching'
import type { DbClient } from './db/client'
import type { PublishedContentEntry } from './contentRepository'

/**
 * Resolved loop data for a single loop node on a page.
 *
 * `pageNumber` is 1-indexed. `hasMore` enables the infinite-loading
 * sentinel; `totalItems` powers the future numeric paginator block.
 */
export interface ResolvedLoopData extends LoopFetchResult {
  pageNumber: number
  hasMore: boolean
}

export type LoopDataMap = Map<string, ResolvedLoopData>

/**
 * Project a published content entry into a LoopItem. The single-entry
 * route uses this to seed the publisher's entry stack with one frame
 * representing the entry being viewed.
 */
export function publishedContentEntryToLoopItem(entry: PublishedContentEntry): LoopItem {
  const collectionRouteBase = normalizeRouteBase(
    entry.collectionRouteBase || `/${entry.collectionSlug}`,
  )
  const permalink = `${collectionRouteBase === '/' ? '' : collectionRouteBase}/${entry.slug}`
  const firstImagePath = firstImagePathFromMarkdown(entry.bodyMarkdown)

  return {
    id: entry.id,
    fields: {
      // Identity
      id: entry.entryId,
      entryId: entry.entryId,
      versionId: entry.id,
      versionNumber: entry.versionNumber,
      collectionId: entry.collectionId,
      collectionSlug: entry.collectionSlug,
      collectionRouteBase,
      // Content
      title: entry.title,
      slug: entry.slug,
      body: entry.bodyMarkdown,
      bodyMarkdown: entry.bodyMarkdown,
      // Media — every alias resolves to the same path
      featuredMediaId: entry.featuredMediaId,
      featuredMedia: entry.featuredMediaPath,
      featuredMediaPath: entry.featuredMediaPath,
      featuredMediaUrl: entry.featuredMediaPath,
      firstImage: firstImagePath,
      firstImagePath,
      firstImageUrl: firstImagePath,
      // SEO + dates
      seoTitle: entry.seoTitle,
      seoDescription: entry.seoDescription,
      publishedAt: entry.publishedAt,
      createdAt: entry.createdAt,
      // Routing
      permalink,
    },
  }
}

/**
 * Recursively collect all `base.loop` nodes reachable from `rootNodeId`.
 * Walks via `node.children` (flat-map traversal — same as the publisher).
 */
export function collectLoopNodes(page: Page): PageNode[] {
  const result: PageNode[] = []
  const visit = (nodeId: string): void => {
    const node = page.nodes[nodeId]
    if (!node) return
    if (node.moduleId === 'base.loop') result.push(node)
    for (const childId of node.children) visit(childId)
  }
  visit(page.rootNodeId)
  return result
}

/**
 * Read a loop node's properties as a strongly-typed shape. Every field
 * has a sensible default so a node missing properties (e.g. just-inserted)
 * still resolves to "no data" instead of crashing the render.
 */
export interface LoopProps {
  sourceId: string
  filters: Record<string, unknown>
  orderBy: string
  direction: 'asc' | 'desc'
  limit: number
  offset: number
  pagination: 'none' | 'infinite'
  pageSize: number
}

export function readLoopProps(node: PageNode): LoopProps {
  const props = node.props
  return {
    sourceId: typeof props.sourceId === 'string' ? props.sourceId : '',
    filters:
      props.filters && typeof props.filters === 'object' && !Array.isArray(props.filters)
        ? (props.filters as Record<string, unknown>)
        : {},
    orderBy: typeof props.orderBy === 'string' ? props.orderBy : '',
    direction: props.direction === 'asc' ? 'asc' : 'desc',
    limit: typeof props.limit === 'number' && props.limit > 0 ? Math.floor(props.limit) : 10,
    offset: typeof props.offset === 'number' && props.offset >= 0 ? Math.floor(props.offset) : 0,
    pagination: props.pagination === 'infinite' ? 'infinite' : 'none',
    pageSize:
      typeof props.pageSize === 'number' && props.pageSize > 0 ? Math.floor(props.pageSize) : 10,
  }
}

/**
 * URL query parameter prefix for per-loop pagination state, e.g.
 * `?loop_<nodeId>_page=2`. Multiple loops on a single page each get their
 * own param so they paginate independently.
 */
export function loopPageQueryKey(loopNodeId: string): string {
  return `loop_${loopNodeId}_page`
}

function readPageNumber(url: URL | undefined, loopNodeId: string): number {
  if (!url) return 1
  const raw = url.searchParams.get(loopPageQueryKey(loopNodeId))
  if (!raw) return 1
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

/**
 * Resolve one loop node by dispatching to its registered source and
 * applying the requested page slice.
 *
 * - `pagination: 'none'` → fetch up to `limit`, single page, never `hasMore`.
 * - `pagination: 'infinite'` → fetch `pageSize` items at `offset + (page-1)*pageSize`,
 *   `hasMore` reflects whether more rows remain.
 *
 * Errors from a source are swallowed and the loop renders empty — one
 * misconfigured loop must not crash the whole page.
 */
async function resolveOneLoop(
  node: PageNode,
  source: LoopEntitySource,
  ctx: { db: DbClient; site: SiteDocument; url?: URL },
): Promise<ResolvedLoopData> {
  const props = readLoopProps(node)
  const pageNumber = props.pagination === 'infinite' ? readPageNumber(ctx.url, node.id) : 1

  let limit = props.limit
  let offset = props.offset
  if (props.pagination === 'infinite') {
    limit = props.pageSize
    offset = props.offset + (pageNumber - 1) * props.pageSize
  }

  const fetchCtx: SourceFetchContext = {
    db: ctx.db,
    site: ctx.site,
    filters: props.filters,
    orderBy: props.orderBy || (source.orderByOptions[0]?.id ?? ''),
    direction: props.direction,
    limit,
    offset,
  }

  try {
    const result = await source.fetch(fetchCtx)
    const consumed = offset + result.items.length
    return {
      items: result.items,
      totalItems: result.totalItems,
      pageNumber,
      hasMore: props.pagination === 'infinite' && consumed < result.totalItems,
    }
  } catch (err) {
    console.error(`[loopPrefetch] source "${source.id}" failed for node "${node.id}":`, err)
    return { items: [], totalItems: 0, pageNumber, hasMore: false }
  }
}

/**
 * Pre-fetch all loop data for a page in parallel. Returned map is keyed
 * by loop node id; the publisher's renderer reads from it during the
 * synchronous walk.
 *
 * `url` is optional — when present, per-loop `?loop_<id>_page` query
 * params drive infinite-loading slices. When absent (e.g. SSR for
 * editor preview) every loop renders page 1.
 */
export async function prefetchLoopData(
  page: Page,
  site: SiteDocument,
  db: DbClient,
  url?: URL,
): Promise<LoopDataMap> {
  const nodes = collectLoopNodes(page)
  if (nodes.length === 0) return new Map()

  const entries: Array<[string, ResolvedLoopData]> = await Promise.all(
    nodes.map(async (node) => {
      const props = readLoopProps(node)
      const source = props.sourceId ? loopSourceRegistry.get(props.sourceId) : undefined
      if (!source) {
        return [
          node.id,
          { items: [], totalItems: 0, pageNumber: 1, hasMore: false },
        ] as [string, ResolvedLoopData]
      }
      const data = await resolveOneLoop(node, source, { db, site, url })
      return [node.id, data] as [string, ResolvedLoopData]
    }),
  )

  return new Map(entries)
}
