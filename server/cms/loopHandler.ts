/**
 * `/_pb/loop/<loopId>` endpoint — serves additional pages for
 * infinite-loading loops.
 *
 * Called by the loop runtime (`loopRuntime.ts`) after the user clicks
 * "Load more". Returns `{ html, hasMore, pageNumber }` JSON.
 *
 * Algorithm:
 *   1. Resolve the page from the request's `pagePath` query param via
 *      the same routing logic the public renderer uses.
 *   2. Find the loop node by id within the resolved page.
 *   3. Run the loop's source `fetch()` for the requested page slice.
 *   4. Render only the loop's children using a synthetic page context
 *      sharing the publisher's renderNode walker.
 *   5. Return the joined HTML — clients append it before the load-more
 *      button.
 *
 * This handler is GET-only and returns 404 for any combination that
 * doesn't resolve cleanly. Errors are rendered as 4xx/5xx with empty
 * bodies; the runtime's "Try again" UX surfaces network failures.
 */

import type { DbClient } from './db/client'
import { registry } from '@core/module-engine/registry'
import { loopSourceRegistry } from '@core/loops/registry'
import { renderNode, type RenderContext, type ResolvedLoopRenderData } from '@core/publisher/render'
import { jsonResponse } from '../http'
import { getLatestPublishedSiteSnapshot, getPublishedPageBySlug } from './publishRepository'
import { collectLoopNodes, readLoopProps } from './loopPrefetch'
import { LOOP_RUNTIME_JS } from './loopRuntime'

const LOOP_RUNTIME_PATH = '/_pb/assets/loop-runtime.js'

export function isLoopRuntimeAssetPath(pathname: string): boolean {
  return pathname === LOOP_RUNTIME_PATH
}

export function serveLoopRuntimeAsset(): Response {
  return new Response(LOOP_RUNTIME_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      // Aggressive caching — content is a fixed CMS asset that only
      // changes when the CMS itself ships a new version. We can re-deploy
      // by invalidating the path or appending a hash.
      'cache-control': 'public, max-age=3600',
    },
  })
}

export interface LoopHandlerContext {
  db: DbClient
}

function publicSlugFromPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'index' : trimmed
}

export async function handleLoopRequest(
  req: Request,
  url: URL,
  ctx: LoopHandlerContext,
): Promise<Response> {
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  // /_pb/loop/<encoded-loopId>
  const loopId = decodeURIComponent(url.pathname.slice('/_pb/loop/'.length))
  if (!loopId) return jsonResponse({ error: 'Missing loop id' }, { status: 400 })

  const pageNumberRaw = url.searchParams.get('page') ?? '1'
  const pageNumber = Math.max(1, Number.parseInt(pageNumberRaw, 10) || 1)
  const pagePath = url.searchParams.get('pagePath') ?? '/'

  // Find the page that contains this loop. We try by slug first (public
  // pages); content-template loops live inside a published template page
  // and are addressable via the latest snapshot.
  const slugSnapshot = await getPublishedPageBySlug(ctx.db, publicSlugFromPath(pagePath))
  const fallbackSnapshot = slugSnapshot ?? (await getLatestPublishedSiteSnapshot(ctx.db))
  if (!fallbackSnapshot) {
    return jsonResponse({ error: 'Site not published' }, { status: 404 })
  }

  // Search for the loop node across all pages in the snapshot — easiest
  // way to handle both regular pages and template pages from one entry.
  let loopNode = null
  let containingPage = null
  for (const page of fallbackSnapshot.site.pages) {
    const nodes = collectLoopNodes(page)
    const match = nodes.find((n) => n.id === loopId)
    if (match) {
      loopNode = match
      containingPage = page
      break
    }
  }
  if (!loopNode || !containingPage) {
    return jsonResponse({ error: 'Loop not found' }, { status: 404 })
  }

  const props = readLoopProps(loopNode)
  if (props.pagination !== 'infinite') {
    return jsonResponse({ error: 'Loop is not in infinite mode' }, { status: 400 })
  }
  const source = loopSourceRegistry.get(props.sourceId)
  if (!source) {
    return jsonResponse({ error: 'Source not registered' }, { status: 404 })
  }

  // Fetch the requested page slice.
  const offset = props.offset + (pageNumber - 1) * props.pageSize
  let result
  try {
    result = await source.fetch({
      db: ctx.db,
      site: fallbackSnapshot.site,
      filters: props.filters,
      orderBy: props.orderBy || (source.orderByOptions[0]?.id ?? ''),
      direction: props.direction,
      limit: props.pageSize,
      offset,
    })
  } catch (err) {
    console.error(`[loop] source "${source.id}" failed for "${loopId}":`, err)
    return jsonResponse({ error: 'Source fetch failed' }, { status: 500 })
  }

  const consumed = offset + result.items.length
  const hasMore = consumed < result.totalItems

  // Render just the loop's children for the new items. We re-use the
  // publisher's renderNode walker by constructing a synthetic context;
  // CSS dedup is a no-op here because the asset bundle is already
  // loaded on the client.
  const variants = loopNode.children
  if (variants.length === 0) {
    return jsonResponse({ html: '', hasMore, pageNumber })
  }
  const ctxRender: RenderContext = {
    page: containingPage,
    site: fallbackSnapshot.site,
    registry,
    breakpointId: undefined,
    cssMap: new Map(),
    templateContext: { entryStack: [] },
    loopData: new Map<string, ResolvedLoopRenderData>([
      [loopId, { items: result.items, totalItems: result.totalItems, pageNumber, hasMore }],
    ]),
  }

  // Render each item by walking each variant child once per iteration.
  // Bypass renderLoop so we don't re-emit the wrapper element — the
  // existing wrapper on the client absorbs the appended fragments.
  const stack = ctxRender.templateContext?.entryStack ?? []
  let html = ''
  result.items.forEach((item, i) => {
    const variantId = variants[i % variants.length]
    stack.push(item)
    try {
      html += renderNode(variantId, ctxRender)
    } finally {
      stack.pop()
    }
  })

  return jsonResponse({ html, hasMore, pageNumber })
}
