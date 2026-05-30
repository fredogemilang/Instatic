/**
 * Pages CRUD endpoints backed by `data_rows` (table_id = 'pages').
 *
 *   GET /admin/api/cms/pages — list all non-deleted page rows as DataRow[]
 *                              (gated by `site.read`). The client adapter
 *                              converts these to Page[] via pageFromRow.
 *
 *   PUT /admin/api/cms/pages — batch upsert the full page roster. The body
 *                              carries `{ pages: Page[] }` (the in-memory
 *                              representation from the editor store). The
 *                              server validates them, converts to cells via
 *                              pageToCells, and reconciles create/update/delete
 *                              against the current rows in one transaction.
 *
 *                              **Gated by `site.structure.edit`** — the reconcile
 *                              soft-deletes any row not in the incoming set,
 *                              so this endpoint can wipe pages wholesale. The
 *                              previous `SITE_WRITE_CAPABILITIES` gate let a
 *                              Client with `site.content.edit` only also send
 *                              `{ pages: [] }` and erase every page. (A1
 *                              fix — see capabilities review.)
 *
 *                              Per-node content edits stay on the site-shell
 *                              save path, which IS diff-validated.
 *
 * The GET response intentionally returns raw DataRow objects (not Page objects)
 * so the client adapter can reconstruct Pages via pageFromRow without a
 * round-trip through a second validation layer on the server. The adapter
 * validates pages via validatePages immediately after conversion.
 */
import type { DbClient } from '../../db/client'
import { requireCapability } from '../../auth/authz'
import { loadDraftSite } from '../../repositories/site'
import {
  listDataRows,
  createDataRow,
  saveDataRowDraft,
  softDeleteDataRow,
} from '../../repositories/data'
import { pageToCells } from '../../../src/core/data/pageFromRow'
import { visualComponentFromRow } from '../../../src/core/data/componentFromRow'
import { validatePages, SiteValidationError } from '@core/persistence/validate'
import type { Page } from '@core/page-tree'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import { Type } from '@core/utils/typeboxHelpers'
import { CMS_API_PREFIX } from './shared'

export async function handlePagesRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)
  if (url.pathname !== `${CMS_API_PREFIX}/pages`) return null

  if (req.method === 'GET') {
    const user = await requireCapability(req, db, 'site.read')
    if (user instanceof Response) return user

    const rows = await listDataRows(db, 'pages')
    return jsonResponse({ rows })
  }

  if (req.method === 'PUT') {
    // Structural gate. The reconcile soft-deletes any row missing from
    // the incoming set — a Client with `site.content.edit` only must
    // not be able to trigger that. Per-node content edits flow through
    // the site-shell save endpoint, which has its own diff validator.
    const user = await requireCapability(req, db, 'site.structure.edit')
    if (user instanceof Response) return user

    const PagesBodySchema = Type.Object({ pages: Type.Array(Type.Unknown()) })
    const body = await readValidatedBody(req, PagesBodySchema)
    if (!body) return badRequest('Invalid request body')
    const rawPages = body.pages

    // Load current shell and VC roster for full validatePages context
    const [shell, vcRows] = await Promise.all([
      loadDraftSite(db),
      listDataRows(db, 'components'),
    ])
    if (!shell) return jsonResponse({ error: 'draft site not found' }, { status: 404 })

    const visualComponents = vcRows.flatMap((r) => {
      const vc = visualComponentFromRow(r)
      return vc ? [vc] : []
    })

    let pages: Page[]
    try {
      pages = validatePages(shell, rawPages, visualComponents)
    } catch (err) {
      if (err instanceof SiteValidationError) return badRequest(err.message)
      throw err
    }

    // Batch reconcile: create / update / soft-delete in a transaction
    await db.transaction(async (tx) => {
      const existingRows = await listDataRows(tx, 'pages')
      const existingById = new Map(existingRows.map((r) => [r.id, r]))
      const incomingIds = new Set(pages.map((p) => p.id))

      for (const page of pages) {
        const cells = pageToCells(page)
        if (existingById.has(page.id)) {
          await saveDataRowDraft(tx, page.id, { cells, slug: page.slug }, user.id)
        } else {
          await createDataRow(tx, { id: page.id, tableId: 'pages', cells, slug: page.slug }, user.id)
        }
      }

      // Soft-delete rows that are no longer in the incoming set
      for (const [rowId] of existingById) {
        if (!incomingIds.has(rowId)) {
          await softDeleteDataRow(tx, rowId, user.id)
        }
      }
    })

    return jsonResponse({ ok: true })
  }

  return methodNotAllowed()
}
