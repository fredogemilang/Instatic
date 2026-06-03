/**
 * CRUD for data rows.
 *
 *   listDataRows             — list non-deleted rows in a table, optionally
 *                              restricted to rows owned by the calling user
 *   getDataRow               — read a single row with hydrated user references
 *   listDataAuthorOptions    — list active users for the author picker
 *   createDataRow            — insert a new draft
 *   saveDataRowDraft         — overwrite the draft cells and slug
 *   softDeleteDataRow        — set deleted_at
 *   updateDataRowTable       — move a row to another table (rejects on slug
 *                              conflict); was updateContentEntryCollection
 *   updateDataRowStatus      — flip between draft / unpublished
 *   updateDataRowAuthor      — reassign the author user id
 *   upsertDataRow            — id-preserving upsert for merge-overwrite / replace
 *   insertDataRowIfAbsent    — insert only if id absent; used by merge-add
 *   replaceDataRow           — plain insert after wipe; used by replace strategy
 *
 * Mutations (other than soft-delete) always RETURN id only, then re-read the
 * hydrated row through `getDataRow` so callers receive consistently populated
 * user references. Soft-delete is the exception: a soft-deleted row is
 * filtered out by `getDataRow`'s `deleted_at is null` clause, so the row is
 * mapped directly from RETURNING (without user references — the delete handler
 * only consumes id / tableId / slug for audit logging).
 */
import { nanoid } from 'nanoid'
import type { DbClient, Dialect } from '../../db/client'
import type { DataRow, DataRowCells, DataRowStatus } from '@core/data/schemas'
import type { StorageFilterOperator, StorageFilterValue } from '@core/plugin-sdk/storageSchemas'
import { jsonField } from '../../db/jsonExtract'
import { userRefAt, toIso, toIsoOrNull, type UserJoinColumns } from './shared'
import { bumpPublishVersion, withPublishLock } from '../../publish/renderCache'

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

interface CreateDataRowInput {
  id?: string
  tableId: string
  cells: DataRowCells
  /**
   * Denormalized slug derived from `cells.slug` (when the table has a slug
   * field) by the handler before calling this repo. Pass empty string for
   * tables that have no slug field.
   */
  slug: string
}

interface SaveDataRowDraftInput {
  cells: DataRowCells
  slug: string
}

/**
 * Options accepted by `listDataRowsWithFilter`. Mirrors the plugin SDK's
 * StorageListOptions shape (operator-object filter, asc/desc orderBy,
 * limit/offset) plus a status filter scoped to the row's lifecycle.
 *
 * `filter` keys are top-level JSON paths under `cells_json` (e.g. `title`,
 * `featuredMedia`). The repository validates each key against an identifier
 * regex before splicing it into SQL.
 *
 * `orderBy` accepts JSON-cell paths AND the four row-level columns
 * `slug` / `status` / `created_at` / `updated_at` (recognised by suffix
 * so the SQL stays dialect-naive).
 */
export interface ListDataRowsFilterOptions {
  filter?: Record<string, StorageFilterValue>
  orderBy?: Record<string, 'asc' | 'desc'>
  status?: 'any' | 'draft' | 'published' | 'scheduled'
  limit?: number
  offset?: number
}

export interface ListDataRowsWithFilterResult {
  rows: DataRow[]
  totalCount: number
}

interface ListDataRowsVisibility {
  /**
   * When set, only rows whose effective owner is this user id are returned.
   * Ownership: author overrides; when no author is assigned the creator is
   * the effective owner.
   */
  ownerUserId?: string | null
}

export type UpdateDataRowTableResult =
  | { ok: true; row: DataRow }
  | { ok: false; reason: 'row_not_found' | 'table_not_found' | 'slug_conflict' }

// ---------------------------------------------------------------------------
// Row shape returned by queries
// ---------------------------------------------------------------------------

interface DataRowRow extends UserJoinColumns {
  id: string
  table_id: string
  cells_json: Record<string, unknown>
  slug: string
  status: DataRowStatus
  author_user_id: string | null
  created_by_user_id: string | null
  updated_by_user_id: string | null
  published_by_user_id: string | null
  created_at: string | Date
  updated_at: string | Date
  published_at: string | Date | null
  scheduled_publish_at: string | Date | null
  deleted_at: string | Date | null
}

interface DataAuthorRow {
  id: string
  email: string
  display_name: string | null
  role_slug: string | null
  role_name: string | null
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

function mapRow(row: DataRowRow): DataRow {
  return {
    id: row.id,
    tableId: row.table_id,
    cells: row.cells_json,
    slug: row.slug,
    status: row.status,
    authorUserId: row.author_user_id ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
    publishedByUserId: row.published_by_user_id ?? null,
    author: userRefAt(row, 'author'),
    createdBy: userRefAt(row, 'created_by'),
    updatedBy: userRefAt(row, 'updated_by'),
    publishedBy: userRefAt(row, 'published_by'),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    publishedAt: toIsoOrNull(row.published_at),
    scheduledPublishAt: toIsoOrNull(row.scheduled_publish_at),
    deletedAt: toIsoOrNull(row.deleted_at),
  }
}

function isOwnedByUser(row: DataRow, ownerUserId: string): boolean {
  if (row.authorUserId === ownerUserId) return true
  if (row.authorUserId === null) return row.createdByUserId === ownerUserId
  return false
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listDataRows(
  db: DbClient,
  tableId: string,
  visibility: ListDataRowsVisibility = {},
): Promise<DataRow[]> {
  const { rows } = await db<DataRowRow>`
    select data_rows.id,
           data_rows.table_id,
           data_rows.cells_json,
           data_rows.slug,
           data_rows.status,
           data_rows.author_user_id,
           data_rows.created_by_user_id,
           data_rows.updated_by_user_id,
           data_rows.published_by_user_id,
           author_users.email as author_email,
           author_users.display_name as author_display_name,
           author_roles.slug as author_role_slug,
           author_roles.name as author_role_name,
           creator_users.email as created_by_email,
           creator_users.display_name as created_by_display_name,
           creator_roles.slug as created_by_role_slug,
           creator_roles.name as created_by_role_name,
           updater_users.email as updated_by_email,
           updater_users.display_name as updated_by_display_name,
           updater_roles.slug as updated_by_role_slug,
           updater_roles.name as updated_by_role_name,
           publisher_users.email as published_by_email,
           publisher_users.display_name as published_by_display_name,
           publisher_roles.slug as published_by_role_slug,
           publisher_roles.name as published_by_role_name,
           data_rows.created_at,
           data_rows.updated_at,
           data_rows.published_at,
           data_rows.scheduled_publish_at,
           data_rows.deleted_at
    from data_rows
    left join users author_users on author_users.id = data_rows.author_user_id
    left join roles author_roles on author_roles.id = author_users.role_id
    left join users creator_users on creator_users.id = data_rows.created_by_user_id
    left join roles creator_roles on creator_roles.id = creator_users.role_id
    left join users updater_users on updater_users.id = data_rows.updated_by_user_id
    left join roles updater_roles on updater_roles.id = updater_users.role_id
    left join users publisher_users on publisher_users.id = data_rows.published_by_user_id
    left join roles publisher_roles on publisher_roles.id = publisher_users.role_id
    where data_rows.table_id = ${tableId}
      and data_rows.deleted_at is null
    order by data_rows.updated_at desc, data_rows.created_at desc
  `
  const dataRows = rows.map(mapRow)
  if (visibility.ownerUserId) {
    const ownerUserId = visibility.ownerUserId
    return dataRows.filter((row) => isOwnedByUser(row, ownerUserId))
  }
  return dataRows
}

// ---------------------------------------------------------------------------
// Cross-table search (content provider)
// ---------------------------------------------------------------------------

/**
 * A lightweight row summary returned by spotlight content search.
 * Omits user references and cells to keep the response small.
 */
export interface DataRowSearchResult {
  id: string
  tableId: string
  tableSlug: string
  tableName: string
  slug: string
  status: DataRowStatus
  updatedAt: string
}

interface DataRowSearchRow {
  id: string
  table_id: string
  table_slug: string
  table_name: string
  slug: string
  status: DataRowStatus
  author_user_id: string | null
  created_by_user_id: string | null
  updated_at: string | Date
}

interface SearchDataRowsVisibility {
  /**
   * When set, only rows whose effective owner matches this user id are
   * returned. Ownership follows the same rule used by `listDataRows`:
   * `authorUserId` wins when present, otherwise `createdByUserId` is the
   * effective owner. Pass `null` (or omit) for callers who can see every
   * row (`content.edit.any` / `content.publish.any` / `content.manage`).
   */
  ownerUserId?: string | null
}

/**
 * Search non-deleted rows across all non-deleted data tables by slug.
 * The slug is a URL-safe, lowercased derivative of the content title,
 * making it a reliable text proxy for search without requiring dialect-
 * specific JSON extraction from cells_json.
 *
 * `visibility.ownerUserId` restricts the result set to rows owned by the
 * caller — required for `content.edit.own`-only roles so a slug fragment
 * typed in spotlight can't surface other authors' row metadata. Callers
 * with broad visibility (`canSeeAllDataRows`) should omit the filter.
 *
 * Both `lower()` and `LIKE` are ANSI SQL — safe for Postgres and SQLite.
 */
export async function searchDataRows(
  db: DbClient,
  query: string,
  limit: number,
  visibility: SearchDataRowsVisibility = {},
): Promise<DataRowSearchResult[]> {
  const likePattern = `%${query.toLowerCase()}%`
  const { rows } = await db<DataRowSearchRow>`
    select data_rows.id,
           data_rows.table_id,
           data_rows.slug,
           data_rows.status,
           data_rows.author_user_id,
           data_rows.created_by_user_id,
           data_rows.updated_at,
           data_tables.slug as table_slug,
           data_tables.name as table_name
    from data_rows
    join data_tables on data_tables.id = data_rows.table_id
    where data_rows.deleted_at is null
      and data_tables.deleted_at is null
      and lower(data_rows.slug) like ${likePattern}
    order by data_rows.updated_at desc
    limit ${limit}
  `
  const results = rows.map((r) => ({
    row: r,
    result: {
      id: r.id,
      tableId: r.table_id,
      tableSlug: r.table_slug,
      tableName: r.table_name,
      slug: r.slug,
      status: r.status,
      updatedAt: toIso(r.updated_at),
    },
  }))
  if (visibility.ownerUserId) {
    const ownerUserId = visibility.ownerUserId
    return results
      .filter(({ row }) => {
        if (row.author_user_id === ownerUserId) return true
        if (row.author_user_id === null) return row.created_by_user_id === ownerUserId
        return false
      })
      .map(({ result }) => result)
  }
  return results.map(({ result }) => result)
}

export async function getDataRow(
  db: DbClient,
  rowId: string,
): Promise<DataRow | null> {
  const { rows } = await db<DataRowRow>`
    select data_rows.id,
           data_rows.table_id,
           data_rows.cells_json,
           data_rows.slug,
           data_rows.status,
           data_rows.author_user_id,
           data_rows.created_by_user_id,
           data_rows.updated_by_user_id,
           data_rows.published_by_user_id,
           author_users.email as author_email,
           author_users.display_name as author_display_name,
           author_roles.slug as author_role_slug,
           author_roles.name as author_role_name,
           creator_users.email as created_by_email,
           creator_users.display_name as created_by_display_name,
           creator_roles.slug as created_by_role_slug,
           creator_roles.name as created_by_role_name,
           updater_users.email as updated_by_email,
           updater_users.display_name as updated_by_display_name,
           updater_roles.slug as updated_by_role_slug,
           updater_roles.name as updated_by_role_name,
           publisher_users.email as published_by_email,
           publisher_users.display_name as published_by_display_name,
           publisher_roles.slug as published_by_role_slug,
           publisher_roles.name as published_by_role_name,
           data_rows.created_at,
           data_rows.updated_at,
           data_rows.published_at,
           data_rows.scheduled_publish_at,
           data_rows.deleted_at
    from data_rows
    left join users author_users on author_users.id = data_rows.author_user_id
    left join roles author_roles on author_roles.id = author_users.role_id
    left join users creator_users on creator_users.id = data_rows.created_by_user_id
    left join roles creator_roles on creator_roles.id = creator_users.role_id
    left join users updater_users on updater_users.id = data_rows.updated_by_user_id
    left join roles updater_roles on updater_roles.id = updater_users.role_id
    left join users publisher_users on publisher_users.id = data_rows.published_by_user_id
    left join roles publisher_roles on publisher_roles.id = publisher_users.role_id
    where data_rows.id = ${rowId}
      and data_rows.deleted_at is null
    limit 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function listDataAuthorOptions(
  db: DbClient,
): Promise<Array<{ id: string; email: string; displayName: string; roleSlug: string | null; roleName: string | null }>> {
  const { rows } = await db<DataAuthorRow>`
    select users.id,
           users.email,
           users.display_name,
           roles.slug as role_slug,
           roles.name as role_name
    from users
    join roles on roles.id = users.role_id
    where users.deleted_at is null
      and users.status = ${'active'}
    order by users.display_name asc, users.email asc
  `
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name ?? row.email ?? row.id,
    roleSlug: row.role_slug,
    roleName: row.role_name,
  }))
}

export async function createDataRow(
  db: DbClient,
  input: CreateDataRowInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow> {
  const { rows } = await db<{ id: string }>`
    insert into data_rows (
      id,
      table_id,
      cells_json,
      slug,
      status,
      author_user_id,
      created_by_user_id,
      updated_by_user_id,
      plugin_actor_id
    )
    values (
      ${input.id ?? nanoid()},
      ${input.tableId},
      ${input.cells},
      ${input.slug},
      ${'draft'},
      ${actorUserId},
      ${actorUserId},
      ${actorUserId},
      ${pluginActorId}
    )
    returning id
  `
  const created = await getDataRow(db, rows[0].id)
  if (!created) throw new Error('data row was created but could not be re-read')
  return created
}

export async function saveDataRowDraft(
  db: DbClient,
  rowId: string,
  input: SaveDataRowDraftInput,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set cells_json = ${input.cells},
        slug = ${input.slug},
        updated_by_user_id = ${actorUserId},
        plugin_actor_id = ${pluginActorId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

// ---------------------------------------------------------------------------
// Plugin content access helpers
// ---------------------------------------------------------------------------
//
// The following helpers back the `api.cms.content.*` plugin surface. They
// reuse the existing per-row CRUD primitives where possible; only
// `listDataRowsWithFilter` and `getDataRowBySlug` introduce new SQL. The
// filter SQL is dialect-naive (ANSI lower/like, jsonField() helper for the
// cells_json paths) — `db-postgres-isms.test.ts` gates against drift.

/** Identifier regex — same rule as `jsonField`. */
const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** Row-level columns plugins are allowed to order by directly. */
const ROW_LEVEL_ORDER_KEYS = new Set([
  'slug',
  'status',
  'created_at',
  'updated_at',
  'published_at',
])

function placeholder(dialect: Dialect, index: number): string {
  return dialect === 'postgres' ? `$${index}` : '?'
}

interface DataRowFilterRow {
  id: string
}

/**
 * List rows in a table with operator-object filters, sort, and pagination.
 *
 * Two queries — one for the page of ids matching the filter, then a second
 * via `getDataRow` per id to hydrate user references. The hydration step
 * is per-row so the SQL itself stays dialect-naive (no recursive joins to
 * stitch in user data inside the filtered subquery).
 */
export async function listDataRowsWithFilter(
  db: DbClient,
  tableId: string,
  options: ListDataRowsFilterOptions = {},
): Promise<ListDataRowsWithFilterResult> {
  const { filter, orderBy, status = 'any', limit = 100, offset = 0 } = options

  const params: unknown[] = [tableId]
  let paramIdx = 1
  function addParam(value: unknown): string {
    params.push(value)
    paramIdx++
    return placeholder(db.dialect, paramIdx)
  }

  let whereSql = `data_rows.table_id = ${placeholder(db.dialect, 1)} and data_rows.deleted_at is null`

  if (status !== 'any') {
    whereSql += ` and data_rows.status = ${addParam(status)}`
  }

  if (filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid filter field name: ${JSON.stringify(key)}`)
      }
      const fragment = jsonField('cells_json', key, db.dialect).sql

      if (value === null || typeof value !== 'object') {
        whereSql += ` and ${fragment} = ${addParam(value)}`
      } else {
        const op = value as StorageFilterOperator
        if (op.eq !== undefined) whereSql += ` and ${fragment} = ${addParam(op.eq)}`
        if (op.ne !== undefined) whereSql += ` and ${fragment} != ${addParam(op.ne)}`
        if (op.gt !== undefined) whereSql += ` and ${fragment} > ${addParam(op.gt)}`
        if (op.gte !== undefined) whereSql += ` and ${fragment} >= ${addParam(op.gte)}`
        if (op.lt !== undefined) whereSql += ` and ${fragment} < ${addParam(op.lt)}`
        if (op.lte !== undefined) whereSql += ` and ${fragment} <= ${addParam(op.lte)}`
        if (op.in !== undefined) {
          if (op.in.length === 0) {
            whereSql += ` and 1=0`
          } else {
            const inPlaceholders = op.in.map((v) => addParam(v))
            whereSql += ` and ${fragment} in (${inPlaceholders.join(', ')})`
          }
        }
        if (op.like !== undefined) {
          whereSql += ` and lower(${fragment}) like lower(${addParam(op.like)})`
        }
      }
    }
  }

  const countParamCount = params.length

  let orderBySql = 'data_rows.updated_at desc, data_rows.created_at desc'
  if (orderBy && Object.keys(orderBy).length > 0) {
    const parts: string[] = []
    for (const [key, dir] of Object.entries(orderBy)) {
      const normalizedDir = dir === 'desc' ? 'desc' : 'asc'
      if (ROW_LEVEL_ORDER_KEYS.has(key)) {
        parts.push(`data_rows.${key} ${normalizedDir}`)
        continue
      }
      if (!FIELD_KEY_RE.test(key)) {
        throw new Error(`[content] invalid orderBy field name: ${JSON.stringify(key)}`)
      }
      const fragment = jsonField('cells_json', key, db.dialect).sql
      parts.push(`${fragment} ${normalizedDir}`)
    }
    orderBySql = parts.join(', ')
  }

  const limitPlaceholder = addParam(Math.max(1, Math.min(500, limit)))
  const offsetPlaceholder = addParam(Math.max(0, offset))

  const dataSql = `
    select data_rows.id
    from data_rows
    where ${whereSql}
    order by ${orderBySql}
    limit ${limitPlaceholder} offset ${offsetPlaceholder}
  `
  const countSql = `
    select count(*) as total
    from data_rows
    where ${whereSql}
  `

  const dataParams = params
  const countParams = params.slice(0, countParamCount)

  const [dataResult, countResult] = await Promise.all([
    db.unsafe<DataRowFilterRow>(dataSql, dataParams),
    db.unsafe<{ total: number | bigint | string }>(countSql, countParams),
  ])

  const ids = dataResult.rows.map((r) => r.id)
  const hydrated = await Promise.all(ids.map((id) => getDataRow(db, id)))
  const rows = hydrated.filter((r): r is DataRow => r !== null)

  return {
    rows,
    totalCount: Number(countResult.rows[0]?.total ?? 0),
  }
}

/**
 * Read a non-deleted row in a table by its denormalized slug. Plain ANSI
 * SQL — the `data_rows_table_slug_active_idx` index covers this query
 * (the `where slug <> ''` partial guard does not exclude the lookup here
 * because we pass an explicit slug).
 */
export async function getDataRowBySlug(
  db: DbClient,
  tableId: string,
  slug: string,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    select id from data_rows
    where table_id = ${tableId}
      and slug = ${slug}
      and deleted_at is null
    limit 1
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

/**
 * Bulk-insert N draft rows in a single transaction. Used by
 * `api.cms.content.table(slug).createMany(...)` — see plan §13 for the
 * "fail the batch" semantics (one slug conflict / DB error aborts the
 * entire batch).
 */
export async function createDataRowMany(
  db: DbClient,
  inputs: ReadonlyArray<CreateDataRowInput>,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow[]> {
  return db.transaction(async (tx) => {
    const created: DataRow[] = []
    for (const input of inputs) {
      created.push(await createDataRow(tx, input, actorUserId, pluginActorId))
    }
    return created
  })
}

/**
 * Bulk-update N rows in a single transaction. Each update overrides the
 * row's draft cells AND slug — the caller pre-computes the denormalized
 * slug exactly as the per-row handler does.
 */
export async function saveDataRowDraftMany(
  db: DbClient,
  updates: ReadonlyArray<{ id: string; input: SaveDataRowDraftInput }>,
  actorUserId: string | null = null,
  pluginActorId: string | null = null,
): Promise<DataRow[]> {
  return db.transaction(async (tx) => {
    const updated: DataRow[] = []
    for (const { id, input } of updates) {
      const result = await saveDataRowDraft(tx, id, input, actorUserId, pluginActorId)
      if (result) updated.push(result)
    }
    return updated
  })
}

/**
 * Bulk-soft-delete N rows in a single transaction. Returns the number of
 * rows that were actually deleted (skips rows that were already missing
 * or soft-deleted).
 */
export async function softDeleteDataRowMany(
  db: DbClient,
  rowIds: ReadonlyArray<string>,
  actorUserId: string | null = null,
): Promise<{ deleted: number }> {
  return db.transaction(async (tx) => {
    let deleted = 0
    for (const id of rowIds) {
      const result = await softDeleteDataRow(tx, id, actorUserId)
      if (result) deleted++
    }
    return { deleted }
  })
}

/**
 * Soft-delete is the one mutation that returns the row directly from
 * RETURNING rather than re-reading via `getDataRow`: the row now has
 * `deleted_at` set, so `getDataRow`'s `deleted_at is null` filter would mask
 * it. The handler only consumes id / tableId / slug for audit logging, so the
 * absence of hydrated user references on the returned shape is acceptable.
 */
export async function softDeleteDataRow(
  db: DbClient,
  rowId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<DataRowRow>`
    update data_rows
    set deleted_at = current_timestamp,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id, table_id, cells_json, slug, status,
              author_user_id, created_by_user_id,
              updated_by_user_id, published_by_user_id,
              created_at, updated_at, published_at, deleted_at
  `
  return rows[0] ? mapRow(rows[0]) : null
}

/**
 * Move a row to another table. Refuses if the target table is missing or
 * already has a non-deleted row with the same (non-empty) slug. Returns a
 * discriminated union so handlers can map each failure mode to the right HTTP
 * status.
 */
export async function updateDataRowTable(
  db: DbClient,
  rowId: string,
  tableId: string,
  actorUserId: string | null = null,
): Promise<UpdateDataRowTableResult> {
  const row = await getDataRow(db, rowId)
  if (!row) return { ok: false, reason: 'row_not_found' }
  if (row.tableId === tableId) return { ok: true, row }

  const { rows: tableRows } = await db<{ id: string }>`
    select id from data_tables
    where id = ${tableId}
      and deleted_at is null
    limit 1
  `
  if (!tableRows[0]) return { ok: false, reason: 'table_not_found' }

  // Only check for slug conflicts when the row has a non-empty slug.
  if (row.slug) {
    const { rows: conflictRows } = await db<{ id: string }>`
      select id from data_rows
      where table_id = ${tableId}
        and slug = ${row.slug}
        and id <> ${rowId}
        and deleted_at is null
      limit 1
    `
    if (conflictRows[0]) return { ok: false, reason: 'slug_conflict' }
  }

  const { rows } = await db<{ id: string }>`
    update data_rows
    set table_id = ${tableId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  if (!rows[0]) return { ok: false, reason: 'row_not_found' }
  const updated = await getDataRow(db, rows[0].id)
  if (!updated) return { ok: false, reason: 'row_not_found' }
  return { ok: true, row: updated }
}

/**
 * Flip a row between `draft` and `unpublished` (the only states reachable
 * from this endpoint — `published` goes through the dedicated publish flow).
 * Always clears `published_at` / `published_by_user_id` since neither remains
 * meaningful in the new state.
 */
export async function updateDataRowStatus(
  db: DbClient,
  rowId: string,
  status: 'draft' | 'unpublished',
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set status = ${status},
        published_at = null,
        published_by_user_id = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  if (!rows[0]) return null
  // Layer B: a status change to draft/unpublished removes the row from
  // visitor-facing content — invalidate the render cache. Serialize the bump
  // with publishes so it can't fire between a concurrent publish's version
  // read and its own bump, which would strand that publish's baked shells
  // (ISS-038).
  await withPublishLock(async () => {
    bumpPublishVersion()
  })
  return getDataRow(db, rows[0].id)
}

export async function updateDataRowAuthor(
  db: DbClient,
  rowId: string,
  authorUserId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set author_user_id = ${authorUserId},
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

// ---------------------------------------------------------------------------
// Scheduled publish
// ---------------------------------------------------------------------------

/**
 * Mark a row as `scheduled` for future publication. The publish-scheduler
 * tick (`server/publish/publishScheduler.ts`) polls for rows where
 * `status='scheduled' AND scheduled_publish_at <= now()` and calls the
 * regular publish path on each.
 *
 *   • `whenIso` MUST be in the future — the caller (HTTP handler)
 *     validates this before invoking us. We don't re-validate here so a
 *     direct repo caller (tests, fixtures) can plant rows at any time.
 *
 *   • `published_at` / `published_by_user_id` are cleared because the
 *     row is no longer in the published state — they get repopulated
 *     when the tick actually publishes the row.
 *
 *   • `actorUserId` is recorded as the updater. We don't track "who
 *     scheduled this" separately — the audit log captures intent if
 *     a scheduling audit is ever needed.
 */
export async function scheduleDataRowPublish(
  db: DbClient,
  rowId: string,
  whenIso: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set status = 'scheduled',
        scheduled_publish_at = ${whenIso},
        published_at = null,
        published_by_user_id = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

/**
 * Cancel a pending scheduled publication and revert the row to a draft.
 * Used by the "Cancel schedule" UI action and by the publish-scheduler
 * tick's failure handler (when a publish attempt fails the row falls
 * back to draft per CLAUDE.md "Revert to draft + log error" choice).
 */
export async function cancelScheduledPublish(
  db: DbClient,
  rowId: string,
  actorUserId: string | null = null,
): Promise<DataRow | null> {
  const { rows } = await db<{ id: string }>`
    update data_rows
    set status = 'draft',
        scheduled_publish_at = null,
        updated_by_user_id = ${actorUserId},
        updated_at = current_timestamp
    where id = ${rowId}
      and deleted_at is null
      and status = 'scheduled'
    returning id
  `
  return rows[0] ? getDataRow(db, rows[0].id) : null
}

/**
 * Lightweight read shape for the publish-scheduler tick — just the
 * identity columns it needs to dispatch a publish, no joined user refs
 * (the tick doesn't render any UI). One small ANSI-SQL query, the same
 * filter the partial index `data_rows_scheduled_publish_idx` covers.
 */
export interface DueScheduledRow {
  rowId: string
  tableId: string
  scheduledPublishAt: string
}

/**
 * List scheduled rows whose target time has passed and that aren't
 * already deleted. Returns up to `limit` rows ordered by their target
 * time (oldest first — back-pressure favours the rows that have been
 * waiting longest). The scheduler tick calls this, then calls
 * `publishDataRow(...)` on each result.
 *
 * NOT atomic — two concurrent leader instances could read the same
 * batch. The publish-scheduler tick relies on the host-level leader
 * lock (`pg_try_advisory_lock` in PG, single-process for SQLite) to
 * ensure only one instance ticks at a time.
 */
export async function listDuePublishSchedules(
  db: DbClient,
  nowIso: string,
  limit: number,
): Promise<DueScheduledRow[]> {
  const { rows } = await db<{
    id: string
    table_id: string
    scheduled_publish_at: string | Date
  }>`
    select id, table_id, scheduled_publish_at
    from data_rows
    where status = 'scheduled'
      and deleted_at is null
      and scheduled_publish_at is not null
      and scheduled_publish_at <= ${nowIso}
    order by scheduled_publish_at asc
    limit ${limit}
  `
  return rows.map((row) => ({
    rowId: row.id,
    tableId: row.table_id,
    scheduledPublishAt: toIso(row.scheduled_publish_at),
  }))
}

// ---------------------------------------------------------------------------
// Bundle import helpers
// ---------------------------------------------------------------------------

export interface DataRowImportInput {
  id: string
  tableId: string
  cells: DataRowCells
  slug: string
  status: DataRowStatus
  publishedAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * Upsert a row preserving its original id, status, and timestamps. Used by
 * the `merge-overwrite` and `replace` import strategies.
 *
 * User reference columns (author, createdBy, etc.) are intentionally dropped
 * on import: the user ids from the source instance will not exist in the target.
 */
export async function upsertDataRow(
  db: DbClient,
  input: DataRowImportInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  await db`
    insert into data_rows (
      id, table_id, cells_json, slug, status,
      published_at, created_at, updated_at
    )
    values (
      ${input.id}, ${input.tableId}, ${input.cells}, ${input.slug}, ${input.status},
      ${input.publishedAt}, ${createdAt}, ${updatedAt}
    )
    on conflict (id) do update
      set table_id    = excluded.table_id,
          cells_json  = excluded.cells_json,
          slug        = excluded.slug,
          status      = excluded.status,
          published_at = excluded.published_at,
          updated_at  = excluded.updated_at
  `
}

/**
 * Insert a row only if its id does not already exist. Returns `true` when the
 * row was inserted, `false` when it was skipped (id conflict). Used by the
 * `merge-add` import strategy.
 *
 * RETURNING id is supported by both Postgres and SQLite, making this dialect-
 * neutral while still reporting whether an insert actually happened.
 */
export async function insertDataRowIfAbsent(
  db: DbClient,
  input: DataRowImportInput,
): Promise<boolean> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  const { rows } = await db<{ id: string }>`
    insert into data_rows (
      id, table_id, cells_json, slug, status,
      published_at, created_at, updated_at
    )
    values (
      ${input.id}, ${input.tableId}, ${input.cells}, ${input.slug}, ${input.status},
      ${input.publishedAt}, ${createdAt}, ${updatedAt}
    )
    on conflict (id) do nothing
    returning id
  `
  return rows.length > 0
}

/**
 * Plain INSERT with no conflict handling. Assumes the caller has already wiped
 * the table (as the `replace` strategy does). Returns void — the caller does
 * not need the inserted row shape.
 */
export async function replaceDataRow(
  db: DbClient,
  input: DataRowImportInput,
): Promise<void> {
  const createdAt = input.createdAt ?? new Date().toISOString()
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  await db`
    insert into data_rows (
      id, table_id, cells_json, slug, status,
      published_at, created_at, updated_at
    )
    values (
      ${input.id}, ${input.tableId}, ${input.cells}, ${input.slug}, ${input.status},
      ${input.publishedAt}, ${createdAt}, ${updatedAt}
    )
  `
}
