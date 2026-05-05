import '../../src/modules/base'
import '@core/loops/sources'
import { registry } from '@core/module-engine/registry'
import { publishPage } from '@core/publisher/render'
import { buildSiteCssBundle } from './siteCssBundle'
import { selectEntryTemplate } from '@core/templates/templateMatching'
import { prefetchLoopData, publishedContentEntryToLoopItem } from './loopPrefetch'
import type { DbClient } from './db/client'
import type { PublishedContentEntry } from './contentRepository'
import type { PublishedPageSnapshot } from './publishRepository'

/**
 * URL prefix where the Bun server exposes the per-site CSS bundle. Mirrors
 * `/_pb/assets/` for runtime scripts. The matching route is registered in
 * `server/router.ts` and serves files with `Cache-Control: immutable`.
 */
const CSS_ASSET_BASE_URL = '/_pb/css/'

/** URL prefix for the loop data endpoint serving infinite-load fragments. */
const LOOP_ENDPOINT_BASE_URL = '/_pb/loop/'

export interface RenderPublishedSnapshotContext {
  db: DbClient
  /** Optional request URL — when present, drives per-loop pagination. */
  url?: URL
}

export async function renderPublishedSnapshot(
  snapshot: PublishedPageSnapshot,
  ctx: RenderPublishedSnapshotContext,
): Promise<string> {
  const page = snapshot.site.pages.find((candidate) => candidate.id === snapshot.pageId)
  if (!page) throw new Error(`Published page "${snapshot.pageId}" not found in snapshot`)
  const cssBundle = buildSiteCssBundle(snapshot.site, registry)
  const loopData = await prefetchLoopData(page, snapshot.site, ctx.db, ctx.url)
  return publishPage(page, snapshot.site, registry, {
    runtimeAssets: snapshot.runtimeAssets,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
  }).html
}

export async function renderPublishedContentTemplate(
  snapshot: PublishedPageSnapshot,
  entry: PublishedContentEntry,
  ctx: RenderPublishedSnapshotContext,
): Promise<string | null> {
  const template = selectEntryTemplate(snapshot.site, entry.collectionId)
  if (!template) return null

  const cssBundle = buildSiteCssBundle(snapshot.site, registry)
  const loopData = await prefetchLoopData(template, snapshot.site, ctx.db, ctx.url)
  return publishPage(template, snapshot.site, registry, {
    // Seed the entry stack with the published entry. Loop interceptors will
    // push/pop iteration items on top of this frame; nodes outside any loop
    // resolve their `currentEntry` bindings against this seed.
    templateContext: { entryStack: [publishedContentEntryToLoopItem(entry)] },
    runtimeAssets: snapshot.runtimeAssets,
    cssEmission: 'external',
    cssBundle,
    cssAssetBaseUrl: CSS_ASSET_BASE_URL,
    loopData,
    loopEndpointBaseUrl: LOOP_ENDPOINT_BASE_URL,
  }).html
}
