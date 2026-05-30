import { Type } from '@sinclair/typebox'
import type {
  DataTable,
  DataTableListItem,
  DataRow,
  DataUserReference,
  CreateDataTableInput,
  UpdateDataTableInput,
  CreateDataRowInput,
  SaveDataRowDraftInput,
  DataMeta,
} from '@core/data/schemas'
import {
  DataMetaSchema,
  DataRowSchema,
  DataTableListItemSchema,
  DataTableSchema,
  DataUserReferenceSchema,
} from '@core/data/schemas'
import type { SiteBundle } from '@core/data/bundleSchema'
import { SiteBundleSchema } from '@core/data/bundleSchema'
import type { LoopItem } from '@core/loops/types'
import { LoopItemSchema } from '@core/loops/types'
import { parseValue } from '@core/utils/typeboxHelpers'
import { readEnvelope } from '@core/http'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// ---------------------------------------------------------------------------
// Envelope schemas
// ---------------------------------------------------------------------------

const TablesListEnvelope = Type.Object(
  { tables: Type.Optional(Type.Array(DataTableListItemSchema)) },
  { additionalProperties: true },
)

const RowsListEnvelope = Type.Object(
  { rows: Type.Optional(Type.Array(DataRowSchema)) },
  { additionalProperties: true },
)

const AuthorsListEnvelope = Type.Object(
  { authors: Type.Optional(Type.Array(DataUserReferenceSchema)) },
  { additionalProperties: true },
)

const TableEnvelope = Type.Object(
  { table: Type.Optional(DataTableSchema) },
  { additionalProperties: true },
)

const RowEnvelope = Type.Object(
  { row: Type.Optional(DataRowSchema) },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// Data table CRUD
// ---------------------------------------------------------------------------

export async function listCmsDataTables(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTableListItem[]> {
  const res = await fetchImpl(`${basePath}/data/tables`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(res, TablesListEnvelope, `CMS data tables failed with ${res.status}`)
  return body.tables ?? []
}

export async function getCmsDataTable(
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable | null> {
  const res = await fetchImpl(`${basePath}/data/tables/${encodeURIComponent(tableId)}`, {
    method: 'GET',
    credentials: 'include',
  })
  if (res.status === 404) return null
  const body = await readEnvelope(res, TableEnvelope, `CMS data table fetch failed with ${res.status}`)
  return body.table ?? null
}

export async function getCmsDataTableBySlug(
  slug: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable | null> {
  const tables = await listCmsDataTables(fetchImpl, basePath)
  return tables.find((t) => t.slug === slug) ?? null
}

export async function createCmsDataTable(
  input: CreateDataTableInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable> {
  const res = await fetchImpl(`${basePath}/data/tables`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, TableEnvelope, `CMS data table create failed with ${res.status}`)
  if (!body.table) throw new Error('CMS data table create response was missing table')
  return body.table
}

export async function updateCmsDataTable(
  tableId: string,
  input: UpdateDataTableInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable> {
  const res = await fetchImpl(`${basePath}/data/tables/${encodeURIComponent(tableId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, TableEnvelope, `CMS data table update failed with ${res.status}`)
  if (!body.table) throw new Error('CMS data table update response was missing table')
  return body.table
}

export async function deleteCmsDataTable(
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataTable> {
  const res = await fetchImpl(`${basePath}/data/tables/${encodeURIComponent(tableId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const body = await readEnvelope(res, TableEnvelope, `CMS data table delete failed with ${res.status}`)
  if (!body.table) throw new Error('CMS data table delete response was missing table')
  return body.table
}

// ---------------------------------------------------------------------------
// Data row CRUD
// ---------------------------------------------------------------------------

export async function listCmsDataRows(
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow[]> {
  const res = await fetchImpl(
    `${basePath}/data/tables/${encodeURIComponent(tableId)}/rows`,
    { method: 'GET', credentials: 'include' },
  )
  const body = await readEnvelope(res, RowsListEnvelope, `CMS data rows failed with ${res.status}`)
  return body.rows ?? []
}

export async function createCmsDataRow(
  tableId: string,
  input: CreateDataRowInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(
    `${basePath}/data/tables/${encodeURIComponent(tableId)}/rows`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
  const body = await readEnvelope(res, RowEnvelope, `CMS data row create failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row create response was missing row')
  return body.row
}

export async function saveCmsDataRowDraft(
  rowId: string,
  input: SaveDataRowDraftInput,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row save failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row save response was missing row')
  return body.row
}

export async function deleteCmsDataRow(
  rowId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row delete failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row delete response was missing row')
  return body.row
}

export async function publishCmsDataRow(
  rowId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/publish`, {
    method: 'POST',
    credentials: 'include',
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row publish failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row publish response was missing row')
  return body.row
}

/**
 * Schedule a row's publication for a future ISO datetime. The
 * server-side publish-scheduler tick (`server/publish/publishScheduler.ts`)
 * picks the row up once `at <= now()` and calls the regular publish
 * flow. The server validates that `at` is in the future and rejects
 * past timestamps with a 400.
 */
export async function scheduleCmsDataRowPublish(
  rowId: string,
  atIso: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/schedule`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ at: atIso }),
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row schedule failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row schedule response was missing row')
  return body.row
}

/**
 * Cancel a pending scheduled publication. Reverts the row to `'draft'`
 * status and clears `scheduledPublishAt`. Returns 404 if the row isn't
 * currently scheduled (or doesn't exist).
 */
export async function cancelCmsDataRowSchedule(
  rowId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/schedule`, {
    method: 'DELETE',
    credentials: 'include',
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row schedule cancel failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row schedule cancel response was missing row')
  return body.row
}

export async function updateCmsDataRowStatus(
  rowId: string,
  // Mirrors the server handler's accepted statuses
  // (`server/handlers/cms/data/rows.ts` → `handleRowStatus`). The status
  // endpoint is the bare draft↔unpublished toggle. Publishing goes
  // through `publishCmsDataRow`; scheduling goes through
  // `scheduleCmsDataRowPublish`. The client signature is narrow so the
  // type system enforces "use the right endpoint" at the call site.
  status: 'draft' | 'unpublished',
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/status`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row status update failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row status response was missing row')
  return body.row
}

export async function updateCmsDataRowAuthor(
  rowId: string,
  authorUserId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/author`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authorUserId }),
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row author update failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row author response was missing row')
  return body.row
}

export async function updateCmsDataRowTable(
  rowId: string,
  tableId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataRow> {
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/table`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tableId }),
  })
  const body = await readEnvelope(res, RowEnvelope, `CMS data row table update failed with ${res.status}`)
  if (!body.row) throw new Error('CMS data row table response was missing row')
  return body.row
}

// ---------------------------------------------------------------------------
// Loop preview — real published rows projected as LoopItems
//
// Used by the editor canvas `useLoopPreviewItems` hook for `data.rows`
// loops so the preview matches what the publisher will emit. Falls back
// to synthetic placeholder items only when the table has no published rows.
// ---------------------------------------------------------------------------

const LoopPreviewEnvelope = Type.Object(
  {
    items: Type.Optional(Type.Array(LoopItemSchema)),
    totalItems: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

export interface DataLoopPreviewOptions {
  orderBy?: string
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface DataLoopPreviewResult {
  items: LoopItem[]
  totalItems: number
}

export async function previewCmsDataLoopItems(
  tableId: string,
  options: DataLoopPreviewOptions = {},
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataLoopPreviewResult> {
  const params = new URLSearchParams()
  if (options.orderBy) params.set('orderBy', options.orderBy)
  if (options.direction) params.set('direction', options.direction)
  if (typeof options.limit === 'number') params.set('limit', String(options.limit))
  if (typeof options.offset === 'number') params.set('offset', String(options.offset))
  const query = params.toString()
  const suffix = query ? `?${query}` : ''
  const res = await fetchImpl(
    `${basePath}/data/tables/${encodeURIComponent(tableId)}/loop-preview${suffix}`,
    { method: 'GET', credentials: 'include' },
  )
  const body = await readEnvelope(
    res,
    LoopPreviewEnvelope,
    `CMS data loop preview failed with ${res.status}`,
  )
  return {
    items: body.items ?? [],
    totalItems: body.totalItems ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Live-mode preview — renders an entry through the real publish pipeline
// using the draft cells from the editor's in-memory state. The response
// is the full HTML document (sandboxed in an iframe on the client side)
// rather than JSON, so we side-step the envelope helper.
// ---------------------------------------------------------------------------

export interface PreviewCmsDataRowOptions {
  /** Draft cells to merge over the row's persisted state. */
  cells?: Record<string, unknown>
  /** Abort signal so the caller can cancel a stale request. */
  signal?: AbortSignal
  fetchImpl?: FetchLike
  basePath?: string
}

export async function previewCmsDataRow(
  rowId: string,
  options: PreviewCmsDataRowOptions = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const basePath = options.basePath ?? '/admin/api/cms'
  const res = await fetchImpl(`${basePath}/data/rows/${encodeURIComponent(rowId)}/preview`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cells: options.cells ?? {} }),
    signal: options.signal,
  })
  if (!res.ok) {
    // The preview endpoint emits the standard `{ error }` JSON envelope
    // on failure; try to surface the message, fall back to status text.
    let message = `CMS data row preview failed with ${res.status}`
    try {
      const json = (await res.json()) as { error?: string }
      if (json && typeof json.error === 'string') message = json.error
    } catch {
      /* response body wasn't JSON — keep the default message */
    }
    throw new Error(message)
  }
  return await res.text()
}

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

export async function listCmsDataAuthors(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<DataUserReference[]> {
  const res = await fetchImpl(`${basePath}/data/authors`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(res, AuthorsListEnvelope, `CMS data authors failed with ${res.status}`)
  return body.authors ?? []
}

// ---------------------------------------------------------------------------
// Data meta
// ---------------------------------------------------------------------------

const DataMetaEnvelope = Type.Object(
  { meta: DataMetaSchema },
  { additionalProperties: true },
)

export async function getDataMeta(
  options?: { fetchImpl?: FetchLike; basePath?: string },
): Promise<DataMeta> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const basePath = options?.basePath ?? '/admin/api/cms'
  const res = await fetchImpl(`${basePath}/data/_meta`, { credentials: 'include' })
  const body = await readEnvelope(res, DataMetaEnvelope, `CMS data meta failed with ${res.status}`)
  return body.meta
}

// ---------------------------------------------------------------------------
// Bundle export / import
// ---------------------------------------------------------------------------

/**
 * Download the full site bundle from the server.
 * Pass `includeMedia: true` to embed media asset bytes in the bundle.
 */
export async function exportCmsBundle(
  options: { includeMedia?: boolean; fetchImpl?: FetchLike; basePath?: string } = {},
): Promise<SiteBundle> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const basePath = options.basePath ?? '/admin/api/cms'
  const query = options.includeMedia ? '?media=1' : ''
  const res = await fetchImpl(`${basePath}/export${query}`, {
    method: 'GET',
    credentials: 'include',
  })
  if (!res.ok) {
    throw new Error(`CMS export failed with ${res.status}`)
  }
  const raw: unknown = await res.json()
  return parseValue(SiteBundleSchema, raw)
}

const ImportResultEnvelope = Type.Object(
  {
    ok: Type.Optional(Type.Boolean()),
    tableCount: Type.Optional(Type.Number()),
    rowCount: Type.Optional(Type.Number()),
    mediaCount: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
)

export interface ImportBundleResult {
  tableCount: number
  rowCount: number
  mediaCount: number
}

/**
 * Upload a site bundle to the server and apply it, replacing all site data.
 * This is a destructive operation — all existing rows and custom tables are
 * wiped before the bundle is applied.
 */
export async function importCmsBundle(
  bundle: SiteBundle,
  options: { fetchImpl?: FetchLike; basePath?: string } = {},
): Promise<ImportBundleResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const basePath = options.basePath ?? '/admin/api/cms'
  const res = await fetchImpl(`${basePath}/import`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  })
  const body = await readEnvelope(res, ImportResultEnvelope, `CMS import failed with ${res.status}`)
  return {
    tableCount: body.tableCount ?? 0,
    rowCount: body.rowCount ?? 0,
    mediaCount: body.mediaCount ?? 0,
  }
}
