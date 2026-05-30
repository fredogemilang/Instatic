/**
 * Site bundle export endpoint.
 *
 *   GET  /admin/api/cms/export
 *   POST /admin/api/cms/export
 *
 * Returns a `SiteBundle` JSON that captures a full or partial site state:
 *   - optionally the lean site shell (breakpoints, settings, classes, files, runtime)
 *   - selected (or all) data tables
 *   - selected (or all) non-deleted data rows
 *   - optionally: non-deleted media assets with bytes embedded as base64
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
import { loadDraftSite } from '../../repositories/site'
import { listDataTables } from '../../repositories/data/tables'
import { listDataRows } from '../../repositories/data/rows'
import { listMediaAssetsForExport } from '../../repositories/media'
import { jsonResponse, readValidatedBody } from '../../http'
import { CMS_API_PREFIX, type CmsHandlerOptions } from './shared'
import { ExportRequestSchema, type SiteBundle } from '@core/data/bundleSchema'
import { canSeeAllDataRows } from './data/access'

export async function handleExportRoute(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/export`) return null
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
  }

  const user = await requireCapability(req, db, 'data.export')
  if (user instanceof Response) return user

  // Parse filter options from query string (GET) or JSON body (POST)
  let filterTables: string[] | undefined
  let filterRowIds: string[] | undefined
  let includeMedia: boolean
  let includeSite: boolean

  if (req.method === 'POST') {
    const exportReq = await readValidatedBody(req, ExportRequestSchema)
    if (!exportReq) {
      return jsonResponse({ error: 'Invalid export request body' }, { status: 400 })
    }
    filterTables = exportReq.tables
    filterRowIds = exportReq.rowIds
    includeMedia = exportReq.includeMedia ?? false
    includeSite = exportReq.includeSite ?? true
  } else {
    const tablesParam = url.searchParams.get('tables')
    const rowIdsParam = url.searchParams.get('rowIds')
    filterTables = tablesParam ? tablesParam.split(',').filter(Boolean) : undefined
    filterRowIds = rowIdsParam ? rowIdsParam.split(',').filter(Boolean) : undefined
    includeMedia = url.searchParams.get('includeMedia') === '1'
    includeSite = url.searchParams.get('includeSite') !== '0'
  }

  // Always load the site shell — needed for sourceSiteName even when includeSite=false
  const shell = await loadDraftSite(db)
  if (!shell) {
    return jsonResponse({ error: 'Site not initialised — run setup before exporting' }, { status: 404 })
  }

  // Load all tables, then apply the table filter if requested
  let tables = await listDataTables(db)
  if (filterTables && filterTables.length > 0) {
    const tableFilter = new Set(filterTables)
    tables = tables.filter((t) => tableFilter.has(t.id))
  }

  // Load rows for the selected tables (parallel). Visibility filtering:
  // a caller without `content.edit.any` / `content.publish.any` /
  // `content.manage` only sees their own rows in the bundle. Without
  // this, a Client with `data.export` granted (which already implies
  // limited content access) could download every author's drafts.
  // (G5 fix — see capabilities review.)
  const visibility = canSeeAllDataRows(user) ? {} : { ownerUserId: user.id }
  const rowsPerTable = await Promise.all(
    tables.map((table) => listDataRows(db, table.id, visibility)),
  )
  let rows = rowsPerTable.flat()

  // If specific row ids were requested, filter rows and reconcile tables
  if (filterRowIds && filterRowIds.length > 0) {
    const rowIdFilter = new Set(filterRowIds)
    rows = rows.filter((r) => rowIdFilter.has(r.id))
    // Only include tables that are actually referenced by the filtered rows
    const referencedTableIds = new Set(rows.map((r) => r.tableId))
    tables = tables.filter((t) => referencedTableIds.has(t.id))
  }

  // Optionally embed media bytes
  let media: SiteBundle['media']
  if (includeMedia && options.uploadsDir) {
    const assets = await listMediaAssetsForExport(db)
    const mediaItems = await Promise.all(
      assets.map(async (asset) => {
        try {
          const bytes = await readFile(join(options.uploadsDir!, asset.storagePath))
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
            bytesBase64: bytes.toString('base64'),
          }
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

  const bundle: SiteBundle = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    sourceSiteName: shell.name,
    ...(includeSite ? { site: shell } : {}),
    tables,
    rows,
    ...(media !== undefined ? { media } : {}),
  }

  const json = JSON.stringify(bundle)
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')
  return new Response(json, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="site-bundle-${timestamp}.json"`,
    },
  })
}
