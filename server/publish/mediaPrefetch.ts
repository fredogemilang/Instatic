/**
 * Server-side media-asset pre-fetch.
 *
 * Walks a page tree, finds every prop whose module-schema control type is
 * `image` or `media`, collects the local `/uploads/<storage>` paths, batch-
 * fetches the matching `media_assets` rows, and returns a map keyed by
 * `public_path` → asset. The publisher attaches the resolved assets to each
 * node's `props._resolvedMediaByKey` (keyed by prop key) before calling
 * `render()` so the pure render function can emit responsive markup
 * (srcset / sizes / BlurHash) without any I/O of its own.
 *
 * Why look up by `public_path`, not asset id?
 *   - The module prop stores the raw path (e.g. `/uploads/abc-hero.png`)
 *     today; no schema change required.
 *   - `replaceMediaAssetBinary` keeps the same `public_path` so existing
 *     page references stay valid across a file swap. Fetching by path
 *     transparently picks up the new variant list.
 */

import type { Page, PageNode } from '@core/page-tree/schemas'
import type { IModuleRegistry } from '@core/module-engine/types'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import type { DbClient } from '../db/client'
import { materializeAssetMapForClient } from './mediaPresentation'

// Re-export under the client-shared type name so RenderContext can type
// the map without crossing the server boundary. The repo's `MediaAsset`
// shape is structurally identical.
type MediaAsset = CmsMediaAsset

/** Map keyed by the asset's `public_path` for O(1) lookup at render time. */
export type MediaAssetMap = Map<string, MediaAsset>

interface PrefetchedAssetRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  public_path: string
  uploaded_by_user_id: string | null
  created_at: Date | string
  alt_text: string | null
  caption: string | null
  title: string | null
  tags_json: unknown
  width: number | null
  height: number | null
  duration_ms: number | string | null
  dominant_color: string | null
  deleted_at: Date | string | null
  replaced_at: Date | string | null
  blur_hash: string | null
  variants_json: unknown
  poster_path: string | null
}

/**
 * Collect every `/uploads/...` path referenced by an image/media-typed prop
 * across the page tree.
 */
function collectMediaPaths(page: Page, registry: IModuleRegistry): Set<string> {
  const paths = new Set<string>()
  for (const node of Object.values(page.nodes) as PageNode[]) {
    const def = registry.get(node.moduleId)
    if (!def) continue
    for (const [propKey, control] of Object.entries(def.schema)) {
      // Only `image` / `media` controls participate in the responsive
      // pipeline. Plain `text` URL fields (rare) aren't auto-upgraded.
      if (control.type !== 'image' && control.type !== 'media') continue
      const value = node.props?.[propKey]
      if (typeof value !== 'string' || !value.startsWith('/uploads/')) continue
      paths.add(value)
    }
  }
  return paths
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value == null ? null : toIsoString(value)
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function parseVariants(value: unknown): MediaAsset['variants'] {
  // Mirrors `parseVariants` in `repositories/media.ts` — defensive against
  // hand-edited rows. Kept inline (vs. importing) so this file's only
  // cross-module dep is the row TypeScript shape.
  const raw: unknown = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  if (!Array.isArray(raw)) return []
  const out: MediaAsset['variants'] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.width !== 'number' || typeof e.height !== 'number') continue
    if (typeof e.path !== 'string' || typeof e.sizeBytes !== 'number') continue
    if (e.format !== 'webp' && e.format !== 'jpeg' && e.format !== 'png' && e.format !== 'avif') continue
    out.push({
      width: e.width,
      height: e.height,
      format: e.format,
      path: e.path,
      sizeBytes: e.sizeBytes,
    })
  }
  return out
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function mapRow(row: PrefetchedAssetRow): MediaAsset {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    publicPath: row.public_path,
    uploadedByUserId: row.uploaded_by_user_id ?? null,
    createdAt: toIsoString(row.created_at),
    altText: row.alt_text ?? '',
    caption: row.caption ?? '',
    title: row.title ?? '',
    tags: parseTags(row.tags_json),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    durationMs: numberOrNull(row.duration_ms),
    dominantColor: row.dominant_color ?? null,
    deletedAt: toIsoOrNull(row.deleted_at),
    replacedAt: toIsoOrNull(row.replaced_at),
    folderIds: [],  // Not needed at render time; left empty to skip the per-asset
                    // join roundtrip the regular repo path would do.
    blurHash: row.blur_hash ?? null,
    variants: parseVariants(row.variants_json),
    posterPath: row.poster_path ?? null,
  }
}

/**
 * Fetch every media asset referenced by image / media props in the page
 * tree. Returns an empty map for pages that reference no local uploads
 * (purely external URLs, or no media modules at all).
 */
export async function prefetchMediaAssets(
  page: Page,
  registry: IModuleRegistry,
  db: DbClient,
): Promise<MediaAssetMap> {
  const map = new Map<string, MediaAsset>()
  const paths = collectMediaPaths(page, registry)
  if (paths.size === 0) return map

  // One fetch per path. Cross-dialect bulk-IN binding via the tagged-template
  // API isn't ergonomic (SQLite has no native array bind, PG uses `= any()`),
  // and the per-page count is usually < 20 so the round trips are cheap.
  // If it becomes a bottleneck on big pages we'll batch with a dialect-aware
  // helper — same pattern as `loadFolderIdsForAssets`.
  for (const path of paths) {
    const { rows } = await db<PrefetchedAssetRow>`
      select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path
      from media_assets
      where public_path = ${path} and deleted_at is null
    `
    if (rows[0]) map.set(path, mapRow(rows[0]))
  }
  // Apply the `media.url.transform` filter chain to every asset's URLs
  // (publicPath + variants[*].path). The map KEY stays the page tree's
  // stored token so the renderer's O(1) lookup still works; the VALUE is
  // rewritten so transformer plugins (passive CDN, image-CDN) take effect
  // on the published page AND the editor preview iframe in one place.
  return materializeAssetMapForClient(map)
}
