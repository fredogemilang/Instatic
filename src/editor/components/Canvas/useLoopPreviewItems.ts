/**
 * useLoopPreviewItems — fetches real iteration data for a `base.loop`
 * node so the editor canvas previews bound dynamic content with real
 * entries instead of placeholder strings.
 *
 * Mirrors the publisher's `prefetchLoopData()` semantics on the canvas
 * side: filters → orderBy → direction → offset → limit. Every change to
 * any of those properties re-runs the pipeline so the preview stays in
 * sync with what the published page will emit.
 *
 * Built-in source dispatch table:
 *   - `content.entries` — fetches via `listCmsContentEntries(collectionId)`
 *     plus `listCmsMediaAssets()` to resolve featured media paths, then
 *     sorts + offsets + limits client-side.
 *   - `site.pages`      — reads pages from the in-memory site document,
 *     filters / sorts / offsets / limits client-side.
 *   - `site.media`      — fetches via `listCmsMediaAssets()`, filters by
 *     mime prefix, sorts + offsets + limits client-side.
 *   - any other source  — falls back to the source's synchronous
 *     `preview()` method (plugin sources can ship synthetic data;
 *     follow-up work will let plugins declare a server fetch endpoint).
 */

import { useEffect, useMemo, useState } from 'react'
import { useEditorStore } from '@core/editor-store/store'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopItem } from '@core/loops/types'
import type { ContentEntry } from '@core/content/schemas'
import type { Page, PageNode } from '@core/page-tree/schemas'
import { listCmsContentEntries } from '@core/persistence/cmsContent'
import { listCmsMediaAssets, type CmsMediaAsset } from '@core/persistence/cmsMedia'
import { contentEntryToLoopItem } from '@core/templates/templatePreviewData'

// ---------------------------------------------------------------------------
// Loop prop reader
// ---------------------------------------------------------------------------

interface ResolvedLoopProps {
  sourceId: string
  filters: Record<string, unknown>
  orderBy: string
  direction: 'asc' | 'desc'
  offset: number
  /** Canvas-side limit, capped for performance. */
  limit: number
}

/**
 * Cap canvas preview at a handful of iterations — alternating layouts and
 * grid patterns only need a few items to be visible. Loops with `limit`
 * > CANVAS_MAX still publish their full set; the cap is editor-canvas only.
 */
const CANVAS_MAX_ITEMS = 6

function readLoopProps(node: PageNode): ResolvedLoopProps {
  const props = node.props
  const sourceId = typeof props.sourceId === 'string' ? props.sourceId : ''
  const filters =
    props.filters && typeof props.filters === 'object' && !Array.isArray(props.filters)
      ? (props.filters as Record<string, unknown>)
      : {}
  const orderBy = typeof props.orderBy === 'string' ? props.orderBy : ''
  const direction = props.direction === 'asc' ? 'asc' : 'desc'
  const rawLimit = typeof props.limit === 'number' ? Math.floor(props.limit) : 3
  const limit = Math.min(Math.max(rawLimit, 1), CANVAS_MAX_ITEMS)
  const rawOffset = typeof props.offset === 'number' ? Math.floor(props.offset) : 0
  const offset = Math.max(rawOffset, 0)
  return { sourceId, filters, orderBy, direction, offset, limit }
}

// ---------------------------------------------------------------------------
// Comparators — mirror the server-side ordering used in each source's fetch()
// ---------------------------------------------------------------------------

function dateMs(value: string | null | undefined): number {
  const ts = Date.parse(value ?? '')
  return Number.isFinite(ts) ? ts : 0
}

function applyDirection<T>(cmp: (a: T, b: T) => number, direction: 'asc' | 'desc') {
  return direction === 'asc' ? cmp : (a: T, b: T) => -cmp(a, b)
}

function sortContentEntries(
  entries: ContentEntry[],
  orderBy: string,
  direction: 'asc' | 'desc',
): ContentEntry[] {
  const out = [...entries]
  let cmp: (a: ContentEntry, b: ContentEntry) => number
  switch (orderBy) {
    case 'createdAt':
      cmp = (a, b) => dateMs(a.createdAt) - dateMs(b.createdAt)
      break
    case 'updatedAt':
      cmp = (a, b) => dateMs(a.updatedAt) - dateMs(b.updatedAt)
      break
    case 'title':
      cmp = (a, b) => a.title.localeCompare(b.title)
      break
    case 'publishedAt':
    default:
      cmp = (a, b) => dateMs(a.publishedAt) - dateMs(b.publishedAt)
      break
  }
  // descending = newest first for date columns; descending = Z→A for title
  out.sort(applyDirection(cmp, direction))
  return out
}

function sortPages(pages: Page[], orderBy: string, direction: 'asc' | 'desc'): Page[] {
  const out = [...pages]
  if (orderBy === 'title') {
    out.sort(applyDirection((a, b) => a.title.localeCompare(b.title), direction))
  } else if (orderBy === 'slug') {
    out.sort(applyDirection((a, b) => a.slug.localeCompare(b.slug), direction))
  } else {
    // 'definition' (or empty) — preserve site.pages order; descending reverses.
    if (direction === 'desc') out.reverse()
  }
  return out
}

function sortMedia(
  assets: CmsMediaAsset[],
  orderBy: string,
  direction: 'asc' | 'desc',
): CmsMediaAsset[] {
  const out = [...assets]
  let cmp: (a: CmsMediaAsset, b: CmsMediaAsset) => number
  if (orderBy === 'filename') {
    cmp = (a, b) => a.filename.localeCompare(b.filename)
  } else {
    cmp = (a, b) => dateMs(a.createdAt) - dateMs(b.createdAt)
  }
  out.sort(applyDirection(cmp, direction))
  return out
}

function mediaAssetToLoopItem(asset: CmsMediaAsset): LoopItem {
  return {
    id: asset.id,
    fields: {
      id: asset.id,
      filename: asset.filename,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      path: asset.publicPath,
      url: asset.publicPath,
      src: asset.publicPath,
      createdAt: asset.createdAt,
    },
  }
}

function pageToLoopItem(page: Page): LoopItem {
  const slug = page.slug.startsWith('/') ? page.slug : `/${page.slug}`
  const permalink = slug === '/index' ? '/' : slug
  return {
    id: page.id,
    fields: {
      id: page.id,
      title: page.title,
      slug: page.slug,
      permalink,
      isTemplate: page.template?.enabled === true,
      templateCollectionId: page.template?.enabled ? page.template.collectionId : null,
    },
  }
}

function filterPagesForLoop(pages: readonly Page[], filters: Record<string, unknown>): Page[] {
  const templateOnly = filters.templateOnly === true
  const excludeTemplates = filters.excludeTemplates === true
  return pages.filter((page) => {
    const isTemplate = page.template?.enabled === true
    if (templateOnly && !isTemplate) return false
    if (excludeTemplates && isTemplate) return false
    return true
  })
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLoopPreviewItems(node: PageNode): LoopItem[] {
  const { sourceId, filters, orderBy, direction, offset, limit } = readLoopProps(node)
  const collectionId = typeof filters.collectionId === 'string' ? filters.collectionId : ''
  const mimePrefix = typeof filters.mimePrefix === 'string' ? filters.mimePrefix : ''

  // Stable filter signature so per-source filters (collectionId, mimePrefix,
  // templateOnly, excludeTemplates, …) drive a fresh re-run.
  const filtersSignature = useMemo(() => JSON.stringify(filters), [filters])

  // Subscribe reactively so site.pages updates trigger re-renders.
  const site = useEditorStore((s) => s.site)
  const sitePages = useEditorStore((s) => s.site?.pages ?? null)

  // Raw fetched data for async sources — sort/offset/limit applied below.
  const [asyncEntries, setAsyncEntries] = useState<ContentEntry[]>([])
  const [asyncMedia, setAsyncMedia] = useState<CmsMediaAsset[]>([])
  const [asyncMediaAssetsForEntries, setAsyncMediaAssetsForEntries] = useState<CmsMediaAsset[]>([])

  // ── Async fetch: content.entries ────────────────────────────────────
  useEffect(() => {
    if (sourceId !== 'content.entries' || !collectionId) {
      if (sourceId !== 'content.entries') setAsyncEntries([])
      return
    }
    let cancelled = false
    Promise.all([
      listCmsContentEntries(collectionId),
      listCmsMediaAssets().catch(() => [] as CmsMediaAsset[]),
    ])
      .then(([entries, mediaAssets]) => {
        if (cancelled) return
        setAsyncEntries(entries)
        setAsyncMediaAssetsForEntries(mediaAssets)
      })
      .catch(() => {
        if (!cancelled) {
          setAsyncEntries([])
          setAsyncMediaAssetsForEntries([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [sourceId, collectionId])

  // ── Async fetch: site.media ─────────────────────────────────────────
  useEffect(() => {
    if (sourceId !== 'site.media') {
      if (sourceId !== 'site.media') setAsyncMedia([])
      return
    }
    let cancelled = false
    listCmsMediaAssets()
      .then((assets) => {
        if (cancelled) return
        setAsyncMedia(assets)
      })
      .catch(() => {
        if (!cancelled) setAsyncMedia([])
      })
    return () => {
      cancelled = true
    }
  }, [sourceId])

  // ── Sort + offset + limit pipeline ──────────────────────────────────
  return useMemo(() => {
    if (!sourceId) return []

    if (sourceId === 'content.entries') {
      if (asyncEntries.length === 0) return []
      const sorted = sortContentEntries(asyncEntries, orderBy || 'publishedAt', direction)
      return sorted
        .slice(offset, offset + limit)
        .map((entry) => contentEntryToLoopItem(entry, asyncMediaAssetsForEntries))
    }

    if (sourceId === 'site.media') {
      if (asyncMedia.length === 0) return []
      const filtered = mimePrefix
        ? asyncMedia.filter((a) => a.mimeType.startsWith(mimePrefix))
        : asyncMedia
      const sorted = sortMedia(filtered, orderBy || 'createdAt', direction)
      return sorted.slice(offset, offset + limit).map(mediaAssetToLoopItem)
    }

    if (sourceId === 'site.pages') {
      if (!sitePages) return []
      const filtered = filterPagesForLoop(sitePages, filters)
      const sorted = sortPages(filtered, orderBy || 'definition', direction)
      return sorted.slice(offset, offset + limit).map(pageToLoopItem)
    }

    // Plugin source fallback — synchronous preview() with no client-side
    // sort. Plugins that need ordering should apply it inside their own
    // preview() implementation.
    const source = loopSourceRegistry.get(sourceId)
    if (!source || !site) return []
    try {
      return source.preview({ site, filters, limit }).slice(offset, offset + limit)
    } catch {
      return []
    }
  }, [
    sourceId,
    asyncEntries,
    asyncMediaAssetsForEntries,
    asyncMedia,
    sitePages,
    site,
    filtersSignature,
    filters,
    orderBy,
    direction,
    offset,
    limit,
    mimePrefix,
  ])
}
