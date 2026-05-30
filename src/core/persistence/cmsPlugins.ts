import { Type } from '@sinclair/typebox'
import type {
  CmsPluginsPayload,
  InstalledPlugin,
  PluginManifest,
  PluginPermission,
} from '@core/plugin-sdk'
import { readEnvelope, assertOk } from '@core/http'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// ---------------------------------------------------------------------------
// Envelope schemas
//
// Same envelope-only strategy as cmsContent.ts: validate the outer keys,
// pass deep types through as unknown, cast at the call site. Surfaced by
// /audit-types — replaces `await res.json() as T` with caller-supplied T.

const PluginsListEnvelope = Type.Object(
  {
    plugins: Type.Optional(Type.Array(Type.Unknown())),
    adminPages: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
)

const PluginActionEnvelope = Type.Object(
  {
    plugin: Type.Optional(Type.Unknown()),
    plugins: Type.Optional(Type.Array(Type.Unknown())),
    adminPages: Type.Optional(Type.Array(Type.Unknown())),
  },
  { additionalProperties: true },
)

const ManifestEnvelope = Type.Object(
  { manifest: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

const PluginSettingsEnvelope = Type.Object(
  {
    schema: Type.Optional(Type.Unknown()),
    settings: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true },
)

function emptyPayload(body: Partial<CmsPluginsPayload>): CmsPluginsPayload {
  return {
    plugins: Array.isArray(body.plugins) ? body.plugins : [],
    adminPages: Array.isArray(body.adminPages) ? body.adminPages : [],
  }
}

export async function listCmsPlugins(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginsPayload> {
  const res = await fetchImpl(`${basePath}/plugins`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(res, PluginsListEnvelope, `CMS plugins failed with ${res.status}`)
  return emptyPayload(body as Partial<CmsPluginsPayload>)
}

export async function installCmsPluginManifest(
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[] = [],
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const res = await fetchImpl(`${basePath}/plugins`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      grantedPermissions.length > 0
        ? { manifest, grantedPermissions }
        : manifest,
    ),
  })
  const body = await readEnvelope(res, PluginActionEnvelope, `CMS plugin install failed with ${res.status}`)
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

export async function inspectCmsPluginPackage(
  file: File,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<PluginManifest> {
  const formData = new FormData()
  formData.set('file', file)
  const res = await fetchImpl(`${basePath}/plugins/inspect-package`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  const body = await readEnvelope(res, ManifestEnvelope, `CMS plugin package inspection failed with ${res.status}`)
  if (!body.manifest) throw new Error('CMS plugin package inspection response was missing manifest')
  return body.manifest as PluginManifest
}

export async function installCmsPluginPackage(
  file: File,
  grantedPermissions: PluginPermission[],
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const formData = new FormData()
  formData.set('file', file)
  formData.set('grantedPermissions', JSON.stringify(grantedPermissions))

  const res = await fetchImpl(`${basePath}/plugins/package`, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  const body = await readEnvelope(res, PluginActionEnvelope, `CMS plugin package install failed with ${res.status}`)
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

export async function setCmsPluginEnabled(
  pluginId: string,
  enabled: boolean,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const res = await fetchImpl(`${basePath}/plugins/${encodeURIComponent(pluginId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  const body = await readEnvelope(res, PluginActionEnvelope, `CMS plugin update failed with ${res.status}`)
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

export async function removeCmsPlugin(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/plugins/${encodeURIComponent(pluginId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS plugin delete failed with ${res.status}`)
}

/**
 * POST /admin/api/cms/plugins/:id/restart — manually restart a plugin
 * after its worker crashed past the budget. The host resets the per-plugin
 * crash counter, drops historical crash events, terminates any stale
 * worker, then re-loads the entrypoint and runs `activate`. Returns the
 * fresh row + payload so the admin UI can update its state in one round.
 */
export async function restartCmsPlugin(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ plugin?: InstalledPlugin } & CmsPluginsPayload> {
  const res = await fetchImpl(`${basePath}/plugins/${encodeURIComponent(pluginId)}/restart`, {
    method: 'POST',
    credentials: 'include',
  })
  const body = await readEnvelope(res, PluginActionEnvelope, `CMS plugin restart failed with ${res.status}`)
  return {
    plugin: body.plugin as InstalledPlugin | undefined,
    ...emptyPayload(body as Partial<CmsPluginsPayload>),
  }
}

export interface CmsPluginPackInstallSummary {
  installed: {
    visualComponents: { id: string; name: string }[]
    pages: { id: string; title: string }[]
    classes: { id: string; name: string }[]
  }
  replaced: {
    visualComponents: string[]
    pages: string[]
    classes: string[]
  }
}

export async function installCmsPluginPack(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginPackInstallSummary> {
  const res = await fetchImpl(`${basePath}/plugins/${encodeURIComponent(pluginId)}/pack/install`, {
    method: 'POST',
    credentials: 'include',
  })
  await assertOk(res, `CMS plugin pack install failed with ${res.status}`)
  const body = (await res.json()) as CmsPluginPackInstallSummary
  return body
}

// ---------------------------------------------------------------------------
// Plugin settings
//
// `GET /admin/api/cms/plugins/:id/settings` returns the declared schema +
// the masked stored values (secrets become `'***'`). `PUT` validates against
// the schema and persists; the host requires a fresh step-up window for the
// PUT (see `server/handlers/cms/plugins/index.ts:requiresStepUp`), so callers
// in the admin UI must wrap the update in `runStepUp` to surface the
// password prompt when the window has expired.
// ---------------------------------------------------------------------------

export type PluginSettingsValue = string | number | boolean
export type PluginSettingsRecord = Record<string, PluginSettingsValue>
export type PluginSettingsSchema = NonNullable<PluginManifest['settings']>

export interface CmsPluginSettingsResponse {
  schema: PluginSettingsSchema
  settings: PluginSettingsRecord
}

export async function loadCmsPluginSettings(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginSettingsResponse> {
  const res = await fetchImpl(`${basePath}/plugins/${encodeURIComponent(pluginId)}/settings`, {
    method: 'GET',
    credentials: 'include',
  })
  const body = await readEnvelope(
    res,
    PluginSettingsEnvelope,
    `CMS plugin settings load failed with ${res.status}`,
  )
  return {
    schema: (body.schema as PluginSettingsSchema | undefined) ?? [],
    settings: (body.settings as PluginSettingsRecord | undefined) ?? {},
  }
}

export async function updateCmsPluginSettings(
  pluginId: string,
  settings: PluginSettingsRecord,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<PluginSettingsRecord> {
  const res = await fetchImpl(`${basePath}/plugins/${encodeURIComponent(pluginId)}/settings`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
  const body = await readEnvelope(
    res,
    PluginSettingsEnvelope,
    `CMS plugin settings update failed with ${res.status}`,
  )
  return (body.settings as PluginSettingsRecord | undefined) ?? {}
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

export interface CmsPluginScheduleSummary {
  pluginId: string
  scheduleId: string
  enabled: boolean
  cadence: unknown
  overlap: 'skip' | 'queue' | 'parallel'
  maxDurationMs: number
  consecutiveFailures: number
  lastRunAt: string | null
  lastFinishedAt: string | null
  lastStatus: 'ok' | 'error' | 'timeout' | 'never_run'
  lastError: string | null
  lastDurationMs: number | null
  nextRunAt: string
}

export interface CmsPluginScheduleRunSummary {
  id: string
  startedAt: string
  finishedAt: string | null
  status: 'ok' | 'error' | 'timeout' | 'never_run'
  error: string | null
  durationMs: number | null
  triggeredBy: 'tick' | 'run-now'
}

export interface CmsPluginSchedulesResponse {
  schedules: CmsPluginScheduleSummary[]
  recent: Record<string, CmsPluginScheduleRunSummary[]>
}

export async function listCmsPluginSchedules(
  pluginId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsPluginSchedulesResponse> {
  const res = await fetchImpl(`${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules`, {
    credentials: 'include',
  })
  await assertOk(res, `CMS plugin schedules list failed with ${res.status}`)
  return (await res.json()) as CmsPluginSchedulesResponse
}

export async function runCmsPluginScheduleNow(
  pluginId: string,
  scheduleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<{ outcome: { ok: boolean; status: string; error?: string; durationMs: number } }> {
  const url = `${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules/${encodeURIComponent(scheduleId)}/run-now`
  const res = await fetchImpl(url, { method: 'POST', credentials: 'include' })
  await assertOk(res, `CMS plugin schedule run-now failed with ${res.status}`)
  return (await res.json()) as { outcome: { ok: boolean; status: string; error?: string; durationMs: number } }
}

export async function pauseCmsPluginSchedule(
  pluginId: string,
  scheduleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const url = `${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules/${encodeURIComponent(scheduleId)}/pause`
  const res = await fetchImpl(url, { method: 'POST', credentials: 'include' })
  await assertOk(res, `CMS plugin schedule pause failed with ${res.status}`)
}

export async function resumeCmsPluginSchedule(
  pluginId: string,
  scheduleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const url = `${basePath}/plugins/${encodeURIComponent(pluginId)}/schedules/${encodeURIComponent(scheduleId)}/resume`
  const res = await fetchImpl(url, { method: 'POST', credentials: 'include' })
  await assertOk(res, `CMS plugin schedule resume failed with ${res.status}`)
}
