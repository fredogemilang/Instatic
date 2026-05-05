/**
 * Template preview data — converts persisted ContentEntry objects into
 * the generic `LoopItem` shape consumed by the publisher's
 * dynamic-binding resolver and by the loop renderer.
 *
 * Used in two paths:
 *  - Editor canvas preview: pick a representative entry for a single-entry
 *    template page and render the canvas as if it were that entry.
 *  - Server-side single-entry route: convert the published version into
 *    a LoopItem that's seeded as the only frame on the entry stack.
 */

import type { ContentEntry } from '../content/schemas'
import type { CmsMediaAsset } from '../persistence/cmsMedia'
import type { LoopItem } from '../loops/types'
import { firstImagePathFromMarkdown } from '../markdown/renderContentMarkdown'
import { normalizeRouteBase } from './templateMatching'

function dateTimestamp(value: string | null | undefined): number {
  const timestamp = Date.parse(value ?? '')
  return Number.isFinite(timestamp) ? timestamp : 0
}

function entryTimestamp(entry: ContentEntry): number {
  return Math.max(
    dateTimestamp(entry.updatedAt),
    dateTimestamp(entry.publishedAt),
    dateTimestamp(entry.createdAt),
  )
}

export function selectLatestTemplatePreviewEntry(entries: ContentEntry[]): ContentEntry | null {
  if (entries.length === 0) return null
  return [...entries].sort((a, b) => entryTimestamp(b) - entryTimestamp(a))[0] ?? null
}

function mediaPublicPath(mediaAssets: CmsMediaAsset[], mediaId: string | null): string | null {
  if (!mediaId) return null
  return mediaAssets.find((asset) => asset.id === mediaId)?.publicPath ?? null
}

/**
 * Project a ContentEntry into the generic LoopItem shape.
 *
 * The `fields` map carries every value reachable through historical
 * `currentEntry` bindings — including the alias names (`featuredMedia`,
 * `featuredMediaPath`, `featuredMediaUrl`, `firstImage`, `firstImagePath`,
 * `firstImageUrl`) that earlier persisted bindings may already use.
 * Format coercions (markdown → HTML for `body`) happen in the resolver
 * when `binding.format === 'html'`.
 */
export function contentEntryToLoopItem(
  entry: ContentEntry,
  mediaAssets: CmsMediaAsset[] = [],
): LoopItem {
  const featuredMediaPath = mediaPublicPath(mediaAssets, entry.featuredMediaId)
  const firstImagePath = firstImagePathFromMarkdown(entry.bodyMarkdown)
  const collectionRouteBase = normalizeRouteBase(entry.collectionId)
  const permalink = `${collectionRouteBase === '/' ? '' : collectionRouteBase}/${entry.slug}`

  return {
    id: entry.id,
    fields: {
      // Identity
      id: entry.id,
      entryId: entry.id,
      collectionId: entry.collectionId,
      collectionSlug: entry.collectionId,
      collectionRouteBase,
      // Content
      title: entry.title,
      slug: entry.slug,
      body: entry.bodyMarkdown,
      bodyMarkdown: entry.bodyMarkdown,
      // Media — every alias points at the same resolved path
      featuredMediaId: entry.featuredMediaId,
      featuredMedia: featuredMediaPath,
      featuredMediaPath,
      featuredMediaUrl: featuredMediaPath,
      firstImage: firstImagePath,
      firstImagePath,
      firstImageUrl: firstImagePath,
      // SEO + dates
      seoTitle: entry.seoTitle,
      seoDescription: entry.seoDescription,
      publishedAt: entry.publishedAt ?? '',
      createdAt: entry.createdAt,
      // Routing
      permalink,
    },
  }
}
