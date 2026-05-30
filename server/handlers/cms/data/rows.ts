/**
 * Data-row endpoints.
 *
 *   GET    /admin/api/cms/data/authors                  — list assignable authors
 *   GET    /admin/api/cms/data/rows/:id                 — read a single row
 *   PATCH  /admin/api/cms/data/rows/:id                 — save the draft cells
 *   DELETE /admin/api/cms/data/rows/:id                 — soft delete
 *   POST   /admin/api/cms/data/rows/:id/publish         — publish
 *   PATCH  /admin/api/cms/data/rows/:id/status          — flip between draft/unpublished
 *   PATCH  /admin/api/cms/data/rows/:id/author          — reassign the author
 *   PATCH  /admin/api/cms/data/rows/:id/table           — move row to a new table
 *
 * `handleDataRowRoutes` is the dispatcher; one function below per URL pattern
 * owns its own method-routing, body-parsing, and audit emission.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import type { DataRow } from '@core/data/schemas'
import { createAuditEvent } from '../../../repositories/audit'
import {
  emitContentEntryDeleted,
  emitContentEntryUpdated,
} from '../../../publish/contentEvents'
import {
  cancelScheduledPublish,
  getDataRow,
  getDataTable,
  listDataAuthorOptions,
  publishDataRow,
  saveDataRowDraft,
  scheduleDataRowPublish,
  softDeleteDataRow,
  updateDataRowAuthor,
  updateDataRowStatus,
  updateDataRowTable,
} from '../../../repositories/data'
import { findUserById } from '../../../repositories/users'
import { dataTableHasField } from '@core/data/fields'
import { readSlugCell } from '@core/data/cells'
import { slugFromTitle } from '@core/utils/slug'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../../http'
import type { CmsHandlerOptions } from '../shared'
import { CMS_API_PREFIX, requestAuditContext } from '../shared'
import {
  RowAuthorBodySchema,
  RowScheduleBodySchema,
  RowStatusBodySchema,
  RowTableBodySchema,
  RowUpsertBodySchema,
} from './schemas'
import {
  canEditDataRow,
  canPublishDataRow,
  canReadDataRow,
  forbidden,
  requireDataAccess,
  requireDataAuthorManager,
  requireDataEditor,
  requireDataPublisher,
  requireDataRowMover,
} from './access'
import { handleRowPreview } from './preview'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROW_NOT_FOUND_BODY = { error: 'Data row not found' }

function rowNotFound(): Response {
  return jsonResponse(ROW_NOT_FOUND_BODY, { status: 404 })
}

type DataRowAuditAction =
  | 'data.row.update'
  | 'data.row.delete'
  | 'data.row.status'
  | 'data.row.move'
  | 'data.row.publish'
  | 'data.row.schedule'
  | 'data.row.schedule.cancel'
  | 'data.author.assign'

async function recordRowAuditEvent(
  db: DbClient,
  user: AuthUser,
  req: Request,
  action: DataRowAuditAction,
  row: DataRow,
  extraMetadata?: Record<string, unknown>,
): Promise<void> {
  await createAuditEvent(db, {
    actorUserId: user.id,
    action,
    targetType: 'data_row',
    targetId: row.id,
    metadata: {
      tableId: row.tableId,
      slug: row.slug,
      ...extraMetadata,
    },
    ...requestAuditContext(req),
  })
}

/**
 * Load a row and run the caller's access check. Returns a Response on
 * 404 / forbidden so call sites can `if (row instanceof Response) return row`.
 */
async function loadRowForAccess(
  db: DbClient,
  rowId: string,
  user: AuthUser,
  check: (user: AuthUser, row: DataRow) => boolean,
): Promise<DataRow | Response> {
  const row = await getDataRow(db, rowId)
  if (!row) return rowNotFound()
  if (!check(user, row)) return forbidden()
  return row
}

/**
 * Derive the denormalized slug from a cells payload for a given table.
 * Returns an empty string when the table has no slug field.
 */
async function extractSlugForTable(
  db: DbClient,
  tableId: string,
  cells: Record<string, unknown>,
): Promise<string> {
  const table = await getDataTable(db, tableId)
  if (!table || !dataTableHasField(table, 'slug')) return ''
  const rawSlug = readSlugCell(cells)
  return rawSlug ? slugFromTitle(rawSlug) : ''
}

// ---------------------------------------------------------------------------
// Per-route handlers
// ---------------------------------------------------------------------------

async function handleListAuthors(req: Request, db: DbClient): Promise<Response> {
  const user = await requireDataAuthorManager(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'GET') return methodNotAllowed()
  return jsonResponse({ authors: await listDataAuthorOptions(db) })
}

async function handleRowItem(
  req: Request,
  db: DbClient,
  rowId: string,
): Promise<Response> {
  // GET reads (broader access); PATCH and DELETE mutate (editor-only).
  const user =
    req.method === 'GET'
      ? await requireDataAccess(req, db)
      : await requireDataEditor(req, db)
  if (user instanceof Response) return user

  if (req.method === 'GET') {
    const row = await loadRowForAccess(db, rowId, user, canReadDataRow)
    if (row instanceof Response) return row
    return jsonResponse({ row })
  }

  if (req.method === 'PATCH') {
    const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
    if (currentRow instanceof Response) return currentRow

    const body = await readValidatedBody(req, RowUpsertBodySchema)
    if (!body) return badRequest('Invalid row payload')

    const cells = body.cells ?? currentRow.cells
    const slug = await extractSlugForTable(db, currentRow.tableId, cells)

    const row = await saveDataRowDraft(db, rowId, { cells, slug }, user.id)
    if (!row) return rowNotFound()
    // Compute changed cell ids from the patch (sufficient for plugin loop
    // guards — the diff in plugin handlers is finer-grained but the admin
    // path doesn't read the previous cells anyway).
    const changedFieldIds = body.cells ? Object.keys(body.cells) : []
    await emitContentEntryUpdated(db, rowId, changedFieldIds, { kind: 'user', userId: user.id })
    await recordRowAuditEvent(db, user, req, 'data.row.update', row)
    return jsonResponse({ row })
  }

  if (req.method === 'DELETE') {
    const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
    if (currentRow instanceof Response) return currentRow

    const row = await softDeleteDataRow(db, rowId, user.id)
    if (!row) return rowNotFound()
    await emitContentEntryDeleted(db, rowId, { kind: 'user', userId: user.id })
    await recordRowAuditEvent(db, user, req, 'data.row.delete', row)
    return jsonResponse({ row })
  }

  return methodNotAllowed()
}

async function handleRowPublish(
  req: Request,
  db: DbClient,
  rowId: string,
  options: CmsHandlerOptions,
): Promise<Response> {
  const user = await requireDataPublisher(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'POST') return methodNotAllowed()

  const currentRow = await loadRowForAccess(db, rowId, user, canPublishDataRow)
  if (currentRow instanceof Response) return currentRow

  const result = await publishDataRow(db, rowId, user.id, options.uploadsDir)
  await emitContentEntryUpdated(db, rowId, ['status'], { kind: 'user', userId: user.id })
  await recordRowAuditEvent(db, user, req, 'data.row.publish', result.row, {
    versionNumber: result.version.versionNumber,
  })
  return jsonResponse(result)
}

async function handleRowSchedule(
  req: Request,
  db: DbClient,
  rowId: string,
): Promise<Response> {
  // Same RBAC as the existing publish endpoint — scheduling a publish
  // is conceptually "publish later", not a new permission.
  const user = await requireDataPublisher(req, db)
  if (user instanceof Response) return user

  const currentRow = await loadRowForAccess(db, rowId, user, canPublishDataRow)
  if (currentRow instanceof Response) return currentRow

  // POST: set / replace the schedule.
  if (req.method === 'POST') {
    const body = await readValidatedBody(req, RowScheduleBodySchema)
    if (!body) return badRequest('Body must be { at: ISO datetime }')

    const when = new Date(body.at)
    if (Number.isNaN(when.getTime())) {
      return badRequest('Invalid datetime — must be a parseable ISO 8601 string')
    }
    if (when.getTime() <= Date.now()) {
      return badRequest('Scheduled time must be in the future')
    }
    const whenIso = when.toISOString()

    const row = await scheduleDataRowPublish(db, rowId, whenIso, user.id)
    if (!row) return rowNotFound()
    await recordRowAuditEvent(db, user, req, 'data.row.schedule', row, {
      scheduledPublishAt: whenIso,
    })
    return jsonResponse({ row })
  }

  // DELETE: cancel a pending schedule, revert the row to draft.
  if (req.method === 'DELETE') {
    const row = await cancelScheduledPublish(db, rowId, user.id)
    if (!row) {
      // Either the row doesn't exist OR it wasn't scheduled. The repo
      // function gates on `status = 'scheduled'`, so a non-scheduled
      // row returns null. Surface a meaningful 404.
      return rowNotFound()
    }
    await recordRowAuditEvent(db, user, req, 'data.row.schedule.cancel', row)
    return jsonResponse({ row })
  }

  return methodNotAllowed()
}

async function handleRowStatus(
  req: Request,
  db: DbClient,
  rowId: string,
): Promise<Response> {
  const user = await requireDataEditor(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'PATCH') return methodNotAllowed()

  const body = await readValidatedBody(req, RowStatusBodySchema)
  if (!body) return badRequest('Status must be draft or unpublished')

  const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
  if (currentRow instanceof Response) return currentRow

  const row = await updateDataRowStatus(db, rowId, body.status, user.id)
  if (!row) return rowNotFound()
  await recordRowAuditEvent(db, user, req, 'data.row.status', row, { status: body.status })
  return jsonResponse({ row })
}

async function handleRowAuthor(
  req: Request,
  db: DbClient,
  rowId: string,
): Promise<Response> {
  const user = await requireDataAuthorManager(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'PATCH') return methodNotAllowed()

  const body = await readValidatedBody(req, RowAuthorBodySchema)
  if (!body || !body.authorUserId.trim()) return badRequest('Author is required')

  const author = await findUserById(db, body.authorUserId)
  if (!author || author.status !== 'active') return badRequest('Author must be an active user')

  const currentRow = await getDataRow(db, rowId)
  if (!currentRow) return rowNotFound()

  const row = await updateDataRowAuthor(db, rowId, body.authorUserId, user.id)
  if (!row) return rowNotFound()

  await createAuditEvent(db, {
    actorUserId: user.id,
    action: 'data.author.assign',
    targetType: 'data_row',
    targetId: row.id,
    metadata: {
      previousAuthorUserId: currentRow.authorUserId,
      authorUserId: body.authorUserId,
    },
    ...requestAuditContext(req),
  })
  return jsonResponse({ row })
}

async function handleRowTable(
  req: Request,
  db: DbClient,
  rowId: string,
): Promise<Response> {
  // Cross-collection move = structurally distinct from cell-level editing.
  // A junior editor with `content.edit.any` should not be able to take a
  // post out of Posts and into Drafts (breaks the URL — different route
  // base). Split out as `data.rows.move` so the operator can grant it
  // separately. See G2 / B8 in the capabilities review.
  const user = await requireDataRowMover(req, db)
  if (user instanceof Response) return user
  if (req.method !== 'PATCH') return methodNotAllowed()

  const body = await readValidatedBody(req, RowTableBodySchema)
  if (!body || !body.tableId.trim()) return badRequest('Table is required')

  const currentRow = await loadRowForAccess(db, rowId, user, canEditDataRow)
  if (currentRow instanceof Response) return currentRow

  const result = await updateDataRowTable(db, rowId, body.tableId, user.id)
  if (result.ok) {
    await recordRowAuditEvent(db, user, req, 'data.row.move', result.row)
    return jsonResponse({ row: result.row })
  }
  if (result.reason === 'slug_conflict') {
    return jsonResponse(
      { error: 'A row with this slug already exists in the target table' },
      { status: 409 },
    )
  }
  if (result.reason === 'table_not_found') {
    return jsonResponse({ error: 'Table not found' }, { status: 404 })
  }
  return rowNotFound()
}

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

const ROW_PUBLISH_PATTERN = /^\/admin\/api\/cms\/data\/rows\/([^/]+)\/publish$/
const ROW_SCHEDULE_PATTERN = /^\/admin\/api\/cms\/data\/rows\/([^/]+)\/schedule$/
const ROW_STATUS_PATTERN = /^\/admin\/api\/cms\/data\/rows\/([^/]+)\/status$/
const ROW_AUTHOR_PATTERN = /^\/admin\/api\/cms\/data\/rows\/([^/]+)\/author$/
const ROW_TABLE_PATTERN = /^\/admin\/api\/cms\/data\/rows\/([^/]+)\/table$/
const ROW_PREVIEW_PATTERN = /^\/admin\/api\/cms\/data\/rows\/([^/]+)\/preview$/
const ROW_ITEM_PATTERN = /^\/admin\/api\/cms\/data\/rows\/([^/]+)$/

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleDataRowRoutes(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response | null> {
  const { pathname } = new URL(req.url)

  if (pathname === `${CMS_API_PREFIX}/data/authors`) {
    return handleListAuthors(req, db)
  }

  // Sub-routes (`/publish`, `/status`, `/author`, `/table`) must match before
  // the bare `/rows/:id` pattern, otherwise the latter swallows them (the
  // regex `[^/]+` would match e.g. `abc/publish`).
  const publishMatch = pathname.match(ROW_PUBLISH_PATTERN)
  if (publishMatch) {
    return handleRowPublish(req, db, decodeURIComponent(publishMatch[1]), options)
  }

  const scheduleMatch = pathname.match(ROW_SCHEDULE_PATTERN)
  if (scheduleMatch) {
    return handleRowSchedule(req, db, decodeURIComponent(scheduleMatch[1]))
  }

  const statusMatch = pathname.match(ROW_STATUS_PATTERN)
  if (statusMatch) {
    return handleRowStatus(req, db, decodeURIComponent(statusMatch[1]))
  }

  const authorMatch = pathname.match(ROW_AUTHOR_PATTERN)
  if (authorMatch) {
    return handleRowAuthor(req, db, decodeURIComponent(authorMatch[1]))
  }

  const tableMatch = pathname.match(ROW_TABLE_PATTERN)
  if (tableMatch) {
    return handleRowTable(req, db, decodeURIComponent(tableMatch[1]))
  }

  const previewMatch = pathname.match(ROW_PREVIEW_PATTERN)
  if (previewMatch) {
    return handleRowPreview(req, db, decodeURIComponent(previewMatch[1]))
  }

  const itemMatch = pathname.match(ROW_ITEM_PATTERN)
  if (itemMatch) {
    return handleRowItem(req, db, decodeURIComponent(itemMatch[1]))
  }

  return null
}
