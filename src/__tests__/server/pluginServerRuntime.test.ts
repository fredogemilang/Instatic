/**
 * Server plugin runtime — integration tests through the cms handler.
 *
 * Plugin server modules run in a Bun Worker (the host never imports them
 * directly), so these tests build real `.zip` packages and install them
 * via the cms handler, then verify behavior end-to-end:
 *  - public GET routes (`getPublic`) don't require auth
 *  - missing capability grants block registration at the API boundary
 *  - plugin metadata (`api.plugin.id/version/permissions`) reaches the
 *    plugin's hooks
 *  - the host's lifecycle status reflects activate failures correctly
 *
 * Cross-context observation uses fs-marker files (the worker has its own
 * globalThis), same pattern the agent-browser e2e and `cmsPlugins.test.ts`
 * lifecycle test use.
 */
import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { SESSION_COOKIE_NAME, hashSessionToken } from '../../../server/auth/tokens'
import type { DbClient, DbResult } from '../../../server/db'
import { handleCmsRequest } from '../../../server/handlers/cms'

function makeFakeDb() {
  const sessions: Record<string, unknown>[] = []
  const plugins: Record<string, unknown>[] = []
  const records: Record<string, unknown>[] = []
  const crashEvents: Record<string, unknown>[] = []

  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.includes('from sessions') && normalized.includes('join users')) {
      const session = sessions.find((s) => String(s.id_hash) === String(values[0]))
      if (!session) return { rows: [], rowCount: 0 }
      return {
        rows: [{
          id: 'admin_1',
          email: 'owner@example.com',
          email_normalized: 'owner@example.com',
          display_name: 'Owner',
          password_hash: 'hash',
          status: 'active',
          role_id: 'owner',
          last_login_at: null,
          created_at: new Date('2026-05-01').toISOString(),
          updated_at: new Date('2026-05-01').toISOString(),
          deleted_at: null,
          role_slug: 'owner',
          role_name: 'Owner',
          role_description: '',
          role_is_system: true,
          role_capabilities_json: ['plugins.manage'],
        } as Row],
        rowCount: 1,
      }
    }
    if (normalized.includes('update sessions') && normalized.includes('last_seen_at')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('insert into audit_events')) {
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('select id, name, version, enabled') && normalized.includes('where id =')) {
      const row = plugins.find((plugin) => plugin.id === values[0])
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    if (normalized.includes('select id, name, version, enabled')) {
      return { rows: [...plugins] as Row[], rowCount: plugins.length }
    }
    if (normalized.includes('insert into installed_plugins')) {
      const now = new Date('2026-05-01T10:00:00.000Z').toISOString()
      const id = values[0]
      const previous = plugins.find((p) => p.id === id)
      const row = {
        id,
        name: values[1],
        version: values[2],
        enabled: true,
        lifecycle_status: 'installed',
        last_error: null,
        manifest_json: values[3],
        granted_permissions_json: values[4] ?? [],
        settings_json: previous?.settings_json ?? values[5] ?? '{}',
        installed_at: previous?.installed_at ?? now,
        updated_at: now,
      }
      const index = plugins.findIndex((plugin) => plugin.id === id)
      if (index >= 0) plugins[index] = row
      else plugins.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    if (normalized.includes('update installed_plugins set lifecycle_status')) {
      const row = plugins.find((plugin) => plugin.id === values[2])
      if (!row) return { rows: [], rowCount: 0 }
      row.lifecycle_status = values[0]
      row.last_error = values[1] ?? null
      row.updated_at = new Date().toISOString()
      return { rows: [row as Row], rowCount: 1 }
    }
    if (normalized.includes('insert into plugin_crash_events')) {
      const row = {
        id: values[0],
        plugin_id: values[1],
        occurred_at: new Date().toISOString(),
        reason: values[2],
        stack: values[3] ?? null,
      }
      crashEvents.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    if (normalized.includes('select id, plugin_id, occurred_at, reason, stack')
        && normalized.includes('from plugin_crash_events')) {
      const rows = crashEvents
        .filter((c) => c.plugin_id === values[0])
        .slice(0, Number(values[1] ?? 10))
      return { rows: rows as Row[], rowCount: rows.length }
    }
    if (normalized.includes('delete from plugin_crash_events')) {
      const before = crashEvents.length
      const remaining = crashEvents.filter((c) => c.plugin_id !== values[0])
      crashEvents.length = 0
      crashEvents.push(...remaining)
      return { rows: [], rowCount: before - remaining.length }
    }
    if (normalized.includes('insert into plugin_records')) {
      const row = {
        id: values[0],
        plugin_id: values[1],
        resource_id: values[2],
        data_json: values[3],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      records.push(row)
      return { rows: [row as Row], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return Object.assign(handle as DbClient, { sessions, plugins, records })
}

async function createCookie(db: ReturnType<typeof makeFakeDb>): Promise<string> {
  const token = 'valid-session-token'
  db.sessions.push({
    id_hash: await hashSessionToken(token),
    user_id: 'admin_1',
    expires_at: new Date('2030-01-01').toISOString(),
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

function cmsRequest(
  url: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Request {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    url,
    method: init.method ?? 'GET',
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) ?? null
      },
    },
    async json() {
      return init.body ? JSON.parse(init.body) : {}
    },
  } as Request
}

function cmsFormRequest(
  url: string,
  formData: FormData,
  headers: Record<string, string> = {},
): Request {
  const headerMap = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  )
  return {
    url,
    method: 'POST',
    headers: {
      get(name: string) {
        return headerMap.get(name.toLowerCase()) ?? null
      },
    },
    async formData() {
      return formData
    },
  } as Request
}

function pluginZip(files: Record<string, string>): File {
  const zipped = zipSync(Object.fromEntries(
    Object.entries(files).map(([path, content]) => [path, strToU8(content)]),
  ))
  return new File([zipped], 'plugin.zip', { type: 'application/zip' })
}

async function installPlugin(args: {
  manifest: Record<string, unknown>
  serverEntrypoint: string
  grantedPermissions: string[]
  uploadsDir: string
  db: ReturnType<typeof makeFakeDb>
  cookie: string
}): Promise<Response> {
  const formData = new FormData()
  formData.set('file', pluginZip({
    'plugin.json': JSON.stringify(args.manifest),
    'server/index.js': args.serverEntrypoint,
  }))
  formData.set('grantedPermissions', JSON.stringify(args.grantedPermissions))
  return await handleCmsRequest(
    cmsFormRequest('http://localhost/admin/api/cms/plugins/package', formData, { cookie: args.cookie }),
    args.db,
    { uploadsDir: args.uploadsDir },
  )
}

const baseManifest = {
  id: 'acme.workflow',
  name: 'Workflow Tools',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['cms.routes'] as const,
  entrypoints: { server: 'server/index.js' },
  resources: [],
  adminPages: [],
}

describe('server plugin runtime SDK', () => {
  it('lets plugins explicitly register public GET routes (no auth required)', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'page-builder-public-routes-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      const install = await installPlugin({
        manifest: baseManifest,
        serverEntrypoint: `
          export function activate(api) {
            api.cms.routes.getPublic('/status', () => ({ ok: true, plugin: api.plugin.id }))
          }
        `,
        grantedPermissions: ['cms.routes'],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)

      // Hit the runtime route WITHOUT a session cookie — getPublic skips auth.
      const res = await handleCmsRequest(
        cmsRequest('http://localhost/admin/api/cms/plugins/acme.workflow/runtime/status'),
        db,
        { uploadsDir },
      )
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, plugin: 'acme.workflow' })
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('blocks backend route registration without the cms.routes permission grant', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'page-builder-perm-gate-'))
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      // Plugin that requests cms.storage only, but tries to register a route
      // (which requires cms.routes). The activate hook should throw and the
      // host's lifecycle row should reflect lastError.
      const install = await installPlugin({
        manifest: { ...baseManifest, permissions: ['cms.storage'] },
        serverEntrypoint: `
          export function activate(api) {
            api.cms.routes.get('/should-fail', 'plugins.manage', () => ({ ok: true }))
          }
        `,
        grantedPermissions: ['cms.storage'],
        uploadsDir,
        db,
        cookie,
      })

      expect(install.status).toBe(201)
      const body = await install.json() as { plugin: { lifecycleStatus: string; lastError: string | null } }
      expect(body.plugin.lifecycleStatus).toBe('error')
      expect(body.plugin.lastError).toMatch(/requires permission "cms.routes"/)
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })

  it('exposes plugin metadata (id, version, permissions) inside lifecycle hooks', async () => {
    const uploadsDir = await mkdtemp(join(tmpdir(), 'page-builder-metadata-'))
    const markerLog = join(uploadsDir, 'metadata.log')
    const db = makeFakeDb()
    const cookie = await createCookie(db)
    try {
      const install = await installPlugin({
        manifest: baseManifest,
        serverEntrypoint: `
          import { appendFileSync } from 'node:fs'
          const MARKER = ${JSON.stringify(markerLog)}
          export function activate(api) {
            appendFileSync(MARKER, [
              api.plugin.id,
              api.plugin.version,
              api.plugin.permissions.slice().sort().join(','),
            ].join('|') + '\\n')
            api.plugin.log('hello from', api.plugin.id)
          }
        `,
        grantedPermissions: ['cms.routes'],
        uploadsDir,
        db,
        cookie,
      })
      expect(install.status).toBe(201)
      const markers = (await readFile(markerLog, 'utf-8')).split('\n').filter(Boolean)
      expect(markers).toEqual(['acme.workflow|1.0.0|cms.routes'])
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
