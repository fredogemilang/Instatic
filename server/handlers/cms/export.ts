/**
 * Site bundle export endpoint.
 *
 *   GET  /admin/api/cms/export
 *   POST /admin/api/cms/export
 *   POST /admin/api/cms/export/estimate   → { bytes } (size only, no download)
 *
 * Returns a `SiteBundle` JSON that captures a full or partial site state:
 *   - optionally the lean site shell (breakpoints, settings, classes, files, runtime)
 *   - selected (or all) data tables
 *   - selected (or all) non-deleted data rows
 *   - optionally: non-deleted media assets with bytes embedded as base64
 *
 * The `/export/estimate` path runs the IDENTICAL selection logic but reports
 * only the bundle's byte size — without reading media files off disk or
 * base64-encoding them. The estimate is therefore exact (it serializes the
 * real selection and adds each asset's Base64 length analytically), so the
 * "Estimated size" line in the dialog can never drift from the real download.
 *
 * Filter options (GET → query string, POST → JSON body via ExportRequestSchema):
 *   tables       — comma-separated table ids (GET) or string[] (POST); default all
 *   rowIds       — comma-separated row ids (GET) or string[] (POST); default all
 *   includeMedia — `1`/`0` (GET) or boolean (POST); default false
 *   includeSite  — `1`/`0` (GET, default 1) or boolean (POST, default true)
 *
 * Requires the `data.export` capability — split out of `site.read` in
 * B8 because the bundle bytes include every author's drafts, which
 * `site.read` (held by Client) should not imply.
 *
 * Additionally: row visibility is filtered via `canSeeAllDataRows`.
 * A caller without `content.edit.any` / `content.publish.any` /
 * `content.manage` only exports their own rows. This closes the G5
 * leak (the previous implementation returned every row regardless of
 * the caller's content visibility scope).
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { getDraftSite } from '../../repositories/site'
import { listDataTables } from '../../repositories/data/tables'
import { listDataRows } from '../../repositories/data/rows'
import { listExportableRedirects } from '../../repositories/data/publish'
import { listMediaAssetsForExport, countMediaAssetsForExport } from '../../repositories/media'
import { listExportableMediaFolders } from '../../repositories/mediaFolders'
import { jsonResponse, readValidatedBody } from '../../http'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'
import { ExportRequestSchema, type SiteBundle } from '@core/data/bundleSchema'
import { canSeeAllDataRows } from './data/access'

const EXPORT_PATH = `${CMS_API_PREFIX}/export`
const EXPORT_ESTIMATE_PATH = `${CMS_API_PREFIX}/export/estimate`
const EXPORT_SUMMARY_PATH = `${CMS_API_PREFIX}/export/summary`

/** A media asset row enriched with its storage path, as loaded for export. */
type ExportableAsset = Awaited<ReturnType<typeof listMediaAssetsForExport>>[number]

/** Bundle media entry without the heavy `bytesBase64` payload. */
type MediaEntryMetadata = Omit<NonNullable<SiteBundle['media']>[number], 'bytesBase64'>

/**
 * The metadata fields of a bundle media entry — everything except the Base64
 * payload. Shared by the real export (which appends the encoded bytes) and the
 * estimate (which appends an empty string and sizes the bytes analytically).
 */
function mediaEntryMetadata(asset: ExportableAsset): MediaEntryMetadata {
  return {
    id: asset.id,
    filename: asset.filename,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    altText: asset.altText,
    caption: asset.caption,
    title: asset.title,
    tags: asset.tags,
    width: asset.width,
    height: asset.height,
    durationMs: asset.durationMs,
    dominantColor: asset.dominantColor,
    blurHash: asset.blurHash,
    storagePath: asset.storagePath,
    posterPath: asset.posterPath,
    folderIds: asset.folderIds,
  }
}

/** Exact length of the Base64 encoding (with padding) of `n` raw bytes. */
function base64Length(n: number): number {
  return Math.ceil(n / 3) * 4
}

interface ExportSelection {
  shell: NonNullable<Awaited<ReturnType<typeof getDraftSite>>>
  tables: Awaited<ReturnType<typeof listDataTables>>
  rows: Awaited<ReturnType<typeof listDataRows>>
  includeMedia: boolean
  includeSite: boolean
  /** Folder tree, or undefined when folders weren't requested. */
  mediaFolders: SiteBundle['mediaFolders']
  /** Self-consistent redirect set, or undefined when redirects weren't requested. */
  redirects: SiteBundle['redirects']
}

export async function handleExportRoute(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  const isEstimate = url.pathname === EXPORT_ESTIMATE_PATH
  const isSummary = url.pathname === EXPORT_SUMMARY_PATH
  if (url.pathname !== EXPORT_PATH && !isEstimate && !isSummary) return null
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  const user = await requireCapability(req, db, 'data.export')
  if (user instanceof Response) return user

  // Summary — total counts of the non-table export categories, so the dialog
  // can label and disable categories independent of the current selection.
  if (isSummary) {
    const [media, mediaFolders, redirects] = await Promise.all([
      countMediaAssetsForExport(db),
      listExportableMediaFolders(db),
      listExportableRedirects(db),
    ])
    return jsonResponse({ media, mediaFolders: mediaFolders.length, redirects: redirects.length })
  }

  // Parse filter options from query string (GET) or JSON body (POST). A
  // `selections` of `undefined` means "every table, all rows" (full export);
  // otherwise each entry names a table and, optionally, a row subset.
  let selections: { tableId: string; rowIds?: string[] }[] | undefined
  let includeMedia: boolean
  let includeSite: boolean
  let includeMediaFolders: boolean
  let includeRedirects: boolean

  if (req.method === 'POST') {
    const exportReq = await readValidatedBody(req, ExportRequestSchema)
    if (!exportReq) {
      return jsonResponse({ error: 'Invalid export request body' }, { status: 400 })
    }
    selections = exportReq.tables
    includeMedia = exportReq.includeMedia ?? false
    includeSite = exportReq.includeSite ?? true
    includeMediaFolders = exportReq.includeMediaFolders ?? true
    includeRedirects = exportReq.includeRedirects ?? true
  } else {
    // GET supports whole-table selection only (comma-separated ids); row-level
    // subsets are a POST-only concern (the export dialog always POSTs).
    const tablesParam = url.searchParams.get('tables')
    selections = tablesParam
      ? tablesParam.split(',').filter(Boolean).map((tableId) => ({ tableId }))
      : undefined
    includeMedia = url.searchParams.get('includeMedia') === '1'
    includeSite = url.searchParams.get('includeSite') !== '0'
    includeMediaFolders = url.searchParams.get('includeMediaFolders') !== '0'
    includeRedirects = url.searchParams.get('includeRedirects') !== '0'
  }

  // Always load the site shell — needed for sourceSiteName even when includeSite=false
  const shell = await getDraftSite(db)
  if (!shell) {
    return jsonResponse({ error: 'Site not initialised — run setup before exporting' }, { status: 404 })
  }

  // Resolve the table set: all tables for a full export, or just the named ones.
  const selectionByTable = selections ? new Map(selections.map((s) => [s.tableId, s])) : null
  let tables = await listDataTables(db)
  if (selectionByTable) {
    tables = tables.filter((t) => selectionByTable.has(t.id))
  }

  // Load rows per table (parallel), applying each table's row subset if one was
  // given. Visibility filtering: a caller without `content.edit.any` /
  // `content.publish.any` / `content.manage` only sees their own rows in the
  // bundle, so a Client with `data.export` can't download every author's drafts
  // (G5 fix — see capabilities review).
  const visibility = canSeeAllDataRows(user) ? {} : { ownerUserId: user.id }
  const rowsPerTable = await Promise.all(
    tables.map(async (table) => {
      const all = await listDataRows(db, table.id, visibility)
      const sel = selectionByTable?.get(table.id)
      if (!sel?.rowIds) return all
      const want = new Set(sel.rowIds)
      return all.filter((r) => want.has(r.id))
    }),
  )
  const rows = rowsPerTable.flat()

  // Media folder tree — cheap; gather whenever requested.
  const mediaFolders = includeMediaFolders ? await listExportableMediaFolders(db) : undefined

  // Redirects — keep the bundle self-consistent: only include redirects whose
  // table AND target row are part of this export, so the import can restore
  // them without dangling foreign keys (both FKs cascade-delete in the schema).
  let redirects: SiteBundle['redirects']
  if (includeRedirects) {
    const selectedTableIds = new Set(tables.map((t) => t.id))
    const selectedRowIds = new Set(rows.map((r) => r.id))
    const all = await listExportableRedirects(db)
    redirects = all.filter(
      (r) => selectedTableIds.has(r.tableId) && selectedRowIds.has(r.targetRowId),
    )
  }

  const selection: ExportSelection = {
    shell,
    tables,
    rows,
    includeMedia,
    includeSite,
    mediaFolders,
    redirects,
  }

  // Media is embedded only when requested AND an uploads dir is configured —
  // both the estimate and the real export gate on this so they stay in sync.
  const wantMedia = includeMedia && Boolean(options.uploadsDir)
  const assets = wantMedia ? await listMediaAssetsForExport(db) : []

  if (isEstimate) {
    return estimateResponse(selection, wantMedia, assets)
  }

  return downloadResponse(selection, wantMedia, assets, options.uploadsDir)
}

/**
 * Compute the exact bundle byte size without reading media files. Serializes
 * the real selection with empty `bytesBase64` strings, then adds each asset's
 * Base64-encoded length — which is precisely what would fill those strings.
 * (Base64 is ASCII, so its JSON-string length equals its byte length.)
 */
function estimateResponse(
  selection: ExportSelection,
  wantMedia: boolean,
  assets: ExportableAsset[],
): Response {
  const mediaSkeleton: SiteBundle['media'] = wantMedia
    ? assets.map((asset) => ({ ...mediaEntryMetadata(asset), bytesBase64: '' }))
    : undefined

  const skeleton = buildBundle(selection, mediaSkeleton)
  const structuralBytes = Buffer.byteLength(JSON.stringify(skeleton), 'utf8')
  const mediaBytes = wantMedia
    ? assets.reduce((sum, asset) => sum + base64Length(asset.sizeBytes), 0)
    : 0

  return jsonResponse({ bytes: structuralBytes + mediaBytes })
}

/** Build the full bundle (reading + base64-encoding media bytes) and stream it as a download. */
async function downloadResponse(
  selection: ExportSelection,
  wantMedia: boolean,
  assets: ExportableAsset[],
  uploadsDir: string | undefined,
): Promise<Response> {
  let media: SiteBundle['media']
  if (wantMedia && uploadsDir) {
    const mediaItems = await Promise.all(
      assets.map(async (asset) => {
        try {
          const bytes = await readFile(join(uploadsDir, asset.storagePath))
          return { ...mediaEntryMetadata(asset), bytesBase64: bytes.toString('base64') }
        } catch {
          // If a file is missing from disk, skip the asset rather than aborting
          // the entire export. The import will recreate metadata rows but without
          // the bytes.
          return null
        }
      }),
    )
    media = mediaItems.filter((item): item is NonNullable<typeof item> => item !== null)
  }

  const bundle = buildBundle(selection, media)
  const json = JSON.stringify(bundle)
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
  return new Response(json, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="site-bundle-${timestamp}.json"`,
    },
  })
}

/** Assemble the `SiteBundle` from a selection plus an already-resolved media array. */
function buildBundle(selection: ExportSelection, media: SiteBundle['media']): SiteBundle {
  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceSiteName: selection.shell.name,
    ...(selection.includeSite ? { site: selection.shell } : {}),
    tables: selection.tables,
    rows: selection.rows,
    ...(media !== undefined ? { media } : {}),
    ...(selection.mediaFolders !== undefined ? { mediaFolders: selection.mediaFolders } : {}),
    ...(selection.redirects !== undefined ? { redirects: selection.redirects } : {}),
  }
}
