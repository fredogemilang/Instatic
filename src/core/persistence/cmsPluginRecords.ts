import { Type } from '@sinclair/typebox'
import type { PluginRecord, PluginResource } from '@core/plugin-sdk'
import type { StorageListOptions } from '@core/plugin-sdk/storageSchemas'
import { readEnvelope, assertOk } from '@core/http'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface PluginRecordsPayload {
  resource?: PluginResource
  records?: PluginRecord[]
  totalCount?: number
}

// Envelope schemas — same strategy as cmsContent / cmsPlugins. PluginRecord
// and PluginResource are deep types validated downstream by their domain
// modules; here we just check that the wrapper object has the expected key.
// Surfaced by /audit-types.

const PluginRecordsEnvelope = Type.Object(
  {
    resource: Type.Optional(Type.Unknown()),
    records: Type.Optional(Type.Array(Type.Unknown())),
    totalCount: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: true },
)

const RecordEnvelope = Type.Object(
  { record: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

function recordsPath(basePath: string, pluginId: string, resourceId: string): string {
  return `${basePath}/plugins/${encodeURIComponent(pluginId)}/resources/${encodeURIComponent(resourceId)}/records`
}

function buildQueryString(options?: StorageListOptions): string {
  if (!options) return ''
  const sp = new URLSearchParams()
  if (options.filter !== undefined) sp.set('filter', JSON.stringify(options.filter))
  if (options.orderBy !== undefined) sp.set('orderBy', JSON.stringify(options.orderBy))
  if (options.limit !== undefined) sp.set('limit', String(options.limit))
  if (options.offset !== undefined) sp.set('offset', String(options.offset))
  const qs = sp.toString()
  return qs ? `?${qs}` : ''
}

export async function listCmsPluginResourceRecords(
  pluginId: string,
  resourceId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
  options?: StorageListOptions,
): Promise<{ records: PluginRecord[]; totalCount: number }> {
  const url = recordsPath(basePath, pluginId, resourceId) + buildQueryString(options)
  const res = await fetchImpl(url, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(res, PluginRecordsEnvelope, `CMS plugin records failed with ${res.status}`)
  const cast = body as PluginRecordsPayload
  return {
    records: Array.isArray(cast.records) ? cast.records : [],
    totalCount: typeof cast.totalCount === 'number' ? cast.totalCount : 0,
  }
}

export async function loadCmsPluginResource(
  pluginId: string,
  resourceId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ resource: PluginResource; records: PluginRecord[]; totalCount: number }> {
  const res = await fetchImpl(recordsPath(basePath, pluginId, resourceId), {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(res, PluginRecordsEnvelope, `CMS plugin resource failed with ${res.status}`)
  const cast = body as PluginRecordsPayload
  if (!cast.resource) throw new Error('CMS plugin resource response was missing resource')
  return {
    resource: cast.resource,
    records: Array.isArray(cast.records) ? cast.records : [],
    totalCount: typeof cast.totalCount === 'number' ? cast.totalCount : 0,
  }
}

export async function createCmsPluginResourceRecord(
  pluginId: string,
  resourceId: string,
  data: Record<string, unknown>,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<PluginRecord> {
  const res = await fetchImpl(recordsPath(basePath, pluginId, resourceId), {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  const body = await readEnvelope(res, RecordEnvelope, `CMS plugin record create failed with ${res.status}`)
  if (!body.record) throw new Error('CMS plugin record create response was missing record')
  return body.record as PluginRecord
}

export async function updateCmsPluginResourceRecord(
  pluginId: string,
  resourceId: string,
  recordId: string,
  data: Record<string, unknown>,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<PluginRecord> {
  const res = await fetchImpl(`${recordsPath(basePath, pluginId, resourceId)}/${encodeURIComponent(recordId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  const body = await readEnvelope(res, RecordEnvelope, `CMS plugin record update failed with ${res.status}`)
  if (!body.record) throw new Error('CMS plugin record update response was missing record')
  return body.record as PluginRecord
}

export async function deleteCmsPluginResourceRecord(
  pluginId: string,
  resourceId: string,
  recordId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${recordsPath(basePath, pluginId, resourceId)}/${encodeURIComponent(recordId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS plugin record delete failed with ${res.status}`)
}
