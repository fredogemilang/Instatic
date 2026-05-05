import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { DbClient } from './db/client'
import {
  SESSION_COOKIE_NAME,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  sessionExpiry,
  verifyPassword,
} from './auth'
import {
  createAdminUser,
  createSession,
  createSite,
  deleteSessionByHash,
  findAdminBySessionHash,
  findAdminByEmail,
  getSetupStatus,
} from './repositories'
import { loadDraftSite, saveDraftSite } from './siteRepository'
import { getDraftPublishStatus, publishDraftSite } from './publishRepository'
import {
  createContentCollection,
  createContentEntry,
  getContentEntry,
  listContentCollections,
  listContentEntries,
  publishContentEntry,
  saveContentEntryDraft,
  softDeleteContentCollection,
  softDeleteContentEntry,
  updateContentCollection,
  updateContentEntryCollection,
  updateContentEntryStatus,
} from './contentRepository'
import { normalizeContentCollectionFields } from '@core/content/fields'
import { createNode } from '@core/page-tree/mutations'
import type { Page } from '@core/page-tree/schemas'
import { slugFromTitle } from '@core/utils/slug'
import {
  createMediaAsset,
  deleteMediaAsset,
  listMediaAssets,
  renameMediaAsset,
} from './mediaRepository'
import { FontInstallError, installGoogleFont, uninstallFontFamily } from './fontsRepository'
import { listGoogleFonts } from '@core/fonts/googleDirectory'
import {
  createPluginRecord,
  deletePluginRecord,
  deletePlugin,
  getInstalledPlugin,
  installPlugin,
  listInstalledPlugins,
  listPluginRecords,
  setPluginLifecycleStatus,
  setPluginEnabled,
  updatePluginRecord,
} from './pluginRepository'
import type { AdminUserRow } from './types'
import {
  collectEnabledAdminPages,
  findPluginResource,
  missingPluginPermissionGrants,
  parsePluginManifest,
  validatePluginRecordData,
} from '@core/plugins/manifest'
import type {
  InstalledPlugin,
  PluginLifecycleStatus,
  PluginManifest,
  PluginPermission,
  PluginResource,
  ServerPluginLifecycleHook,
} from '@core/plugin-sdk'
import { readPluginPackage } from './pluginPackage'
import {
  activateInstalledServerPlugins,
  handleServerPluginRuntimeRequest,
  loadServerPluginModule,
  runServerPluginLifecycleHook,
  serverPluginRuntime,
} from './serverPluginRuntime'
import { validateSite, SiteValidationError } from '@core/persistence/validate'
import type { SitePackageJson } from '@core/site-dependencies/manifest'
import { isSafePackageName } from '@core/site-dependencies/packageNames'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import type { TemplateRenderDataContext } from '@core/templates/dynamicBindings'
import '../../src/modules/base'
import { registry } from '@core/module-engine/registry'
import { resolveSiteDependencyLock } from './runtime/dependencyResolver'
import { ensureRuntimeDependencyCache } from './runtime/dependencyCache'
import { buildRuntimePreviewDocument } from './runtime/previewRuntime'
import {
  badRequest,
  jsonResponse,
  methodNotAllowed,
  readJsonObject,
  setCookieHeader,
} from '../http'
import { loginRateLimit } from './rateLimit'
import { clientIp, isStateChangingMethod, originAllowed } from './security'

interface CmsHandlerOptions {
  uploadsDir?: string
}

const MAX_MEDIA_BYTES = 50 * 1024 * 1024

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readObject<T>(body: Record<string, unknown>, key: string): T | undefined {
  const value = body[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as T
    : undefined
}

function readNullableString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  if (value === null) return null
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * True when the inbound request was made over HTTPS.
 *
 * Trusts `X-Forwarded-Proto` from a reverse proxy (e.g. Caddy in
 * compose.tls.yml) and falls back to the request URL's protocol when no
 * proxy is involved.
 *
 * Spoofing X-Forwarded-Proto from a direct (non-proxied) HTTP client doesn't
 * gain the attacker anything: it would cause the server to set `Secure`,
 * which makes browsers refuse to send the cookie over HTTP. So the worst
 * case is the attacker locks themselves out, not a privilege escalation.
 */
function requestIsHttps(req: Request): boolean {
  const forwardedProto = req.headers.get('x-forwarded-proto')
  if (forwardedProto) return forwardedProto.toLowerCase() === 'https'
  return req.url.startsWith('https://')
}

function sessionCookieAttributes(secure: boolean): string {
  // HttpOnly  — JS in the browser cannot read the cookie (XSS mitigation)
  // SameSite=Lax — cross-origin POST/PUT/DELETE don't carry the cookie (CSRF)
  // Secure    — browser only sends the cookie over HTTPS (set when applicable)
  const base = 'Path=/; HttpOnly; SameSite=Lax'
  return secure ? `${base}; Secure` : base
}

function sessionCookie(req: Request, token: string, expires: Date): string {
  const attrs = sessionCookieAttributes(requestIsHttps(req))
  return `${SESSION_COOKIE_NAME}=${token}; ${attrs}; Expires=${expires.toUTCString()}`
}

function clearSessionCookie(req: Request): string {
  const attrs = sessionCookieAttributes(requestIsHttps(req))
  return `${SESSION_COOKIE_NAME}=; ${attrs}; Max-Age=0`
}

/**
 * A fixed argon2id hash, computed once per process. Used by the login handler
 * as the verification target when the supplied email doesn't match any admin
 * user — keeping the response time constant prevents an attacker from
 * learning which emails belong to admins via timing analysis.
 *
 * The hashed plaintext is deliberately not a real password and never grants
 * access; verifyPassword against this hash returns false for every input.
 *
 * Eagerly kicked off at module load so the very first unknown-email login
 * doesn't pay the one-time hashing cost (~50ms) and stand out as slower
 * than the steady-state.
 */
const dummyPasswordHashCache: Promise<string> = hashPassword('not-a-real-account-placeholder')
function getDummyPasswordHash(): Promise<string> {
  return dummyPasswordHashCache
}

function readCookie(req: Request, name: string): string {
  const cookie = req.headers.get('cookie') ?? ''
  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=')
    if (rawKey === name) return rawValue.join('=')
  }
  return ''
}

async function getSessionHash(req: Request): Promise<string> {
  const token = readCookie(req, SESSION_COOKIE_NAME)
  return token ? hashSessionToken(token) : ''
}

/**
 * Resolve the admin user attached to the request session, or return a 401
 * response. Call sites do:
 *
 *   const admin = await requireAdmin(req, db)
 *   if (admin instanceof Response) return admin
 *
 * which narrows `admin` to `AdminUserRow` for the rest of the handler.
 */
async function requireAdmin(
  req: Request,
  db: DbClient,
): Promise<AdminUserRow | Response> {
  const idHash = await getSessionHash(req)
  const admin = idHash ? await findAdminBySessionHash(db, idHash) : null
  if (!admin) return jsonResponse({ error: 'Unauthorized' }, { status: 401 })
  return admin
}

function isAcceptedMediaType(mimeType: string): boolean {
  return /^image\/|^video\//.test(mimeType)
}

async function pluginsPayload(db: DbClient) {
  const plugins = await listInstalledPlugins(db)
  return {
    plugins,
    adminPages: collectEnabledAdminPages(plugins),
  }
}

function readPermissionGrants(value: unknown): PluginPermission[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is PluginPermission => typeof item === 'string') as PluginPermission[]
}

function assertPluginPermissionGrants(
  manifest: PluginManifest,
  grantedPermissions: PluginPermission[],
): Response | null {
  const missing = missingPluginPermissionGrants(manifest, grantedPermissions)
  if (missing.length === 0) return null
  return badRequest(`Plugin install requires permission grants: ${missing.join(', ')}`)
}

function pluginManifestWithGrants(plugin: InstalledPlugin): PluginManifest {
  return {
    ...plugin.manifest,
    grantedPermissions: plugin.grantedPermissions,
  }
}

function lifecycleErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Plugin lifecycle hook failed'
}

async function runPluginLifecycleHook(
  db: DbClient,
  plugin: InstalledPlugin,
  options: CmsHandlerOptions,
  hook: ServerPluginLifecycleHook,
  successStatus: PluginLifecycleStatus,
): Promise<{ plugin: InstalledPlugin; ok: boolean }> {
  const manifest = pluginManifestWithGrants(plugin)

  try {
    const mod = await loadServerPluginModule(manifest, options.uploadsDir)
    if (!mod?.[hook]) {
      const updated = await setPluginLifecycleStatus(db, plugin.id, successStatus)
      return { plugin: updated ?? plugin, ok: true }
    }

    await runServerPluginLifecycleHook(manifest, mod, db, hook)
    const updated = await setPluginLifecycleStatus(db, plugin.id, successStatus)
    return { plugin: updated ?? plugin, ok: true }
  } catch (err) {
    if (hook === 'activate') {
      serverPluginRuntime.unregisterPlugin(plugin.id)
    }
    const updated = await setPluginLifecycleStatus(db, plugin.id, 'error', lifecycleErrorMessage(err))
    return { plugin: updated ?? plugin, ok: false }
  }
}

async function removePluginAssets(plugin: InstalledPlugin, uploadsDir?: string): Promise<void> {
  const assetBasePath = plugin.manifest.assetBasePath
  if (!uploadsDir || !assetBasePath?.startsWith('/uploads/plugins/')) return
  const relativeBasePath = assetBasePath.replace(/^\/uploads\/?/, '')
  await rm(join(uploadsDir, relativeBasePath), { recursive: true, force: true })
}

async function readPluginPackageForm(req: Request): Promise<{
  file: File | null
  grantedPermissions: PluginPermission[]
}> {
  const body = await req.formData()
  const file = body.get('file')
  const rawPermissions = body.get('grantedPermissions')
  let grantedPermissions: PluginPermission[] = []
  if (typeof rawPermissions === 'string') {
    try {
      // JSON.parse returns unknown — readPermissionGrants validates the shape
      // (must be array, items must be strings) before returning. Safe boundary.
      grantedPermissions = readPermissionGrants(JSON.parse(rawPermissions))
    } catch {
      grantedPermissions = []
    }
  }
  return {
    file: file instanceof File ? file : null,
    grantedPermissions,
  }
}

async function writePluginPackageFiles(
  uploadsDir: string,
  manifest: PluginManifest,
  files: Record<string, string>,
): Promise<PluginManifest> {
  const relativeBasePath = `plugins/${manifest.id}/${manifest.version}`
  const diskBasePath = join(uploadsDir, relativeBasePath)
  await rm(diskBasePath, { recursive: true, force: true })

  for (const [path, content] of Object.entries(files)) {
    if (path === 'plugin.json') continue
    const outputPath = join(diskBasePath, path)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, content, 'utf-8')
  }

  return {
    ...manifest,
    assetBasePath: `/uploads/${relativeBasePath}`,
  }
}

async function getEnabledPluginResource(
  db: DbClient,
  pluginId: string,
  resourceId: string,
): Promise<PluginResource | null> {
  const plugin = await getInstalledPlugin(db, pluginId)
  if (!plugin?.enabled) return null
  return findPluginResource(plugin.manifest, resourceId)
}

function safeStorageName(filename: string): string {
  const normalized = filename.replace(/\\/g, '/')
  const safe = basename(normalized).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '')
  return safe || 'upload.bin'
}

function runtimeDependencyMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const dependencies: Record<string, string> = {}
  for (const [rawName, rawVersion] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim()
    const version = typeof rawVersion === 'string' ? rawVersion.trim() : ''
    if (!name || !version || !isSafePackageName(name)) continue
    dependencies[name] = version
  }
  return dependencies
}

function runtimeRequestPackageJson(raw: unknown): SitePackageJson {
  const manifest = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  return {
    dependencies: runtimeDependencyMap(manifest.dependencies),
    devDependencies: runtimeDependencyMap(manifest.devDependencies),
  }
}

async function readUploadedFile(req: Request): Promise<File | null> {
  const body = await req.formData()
  const file = body.get('file')
  return file instanceof File ? file : null
}

export async function handleCmsRequest(
  req: Request,
  db: DbClient,
  options: CmsHandlerOptions = {},
): Promise<Response> {
  const url = new URL(req.url)

  // CSRF defense in depth: reject state-changing requests whose Origin
  // header doesn't match the request's own origin (or a dev allowlist
  // entry). SameSite=Lax already covers most CSRF; this closes the
  // same-site-different-subdomain edge case and gives a clear 403 instead
  // of executing a forged action. Safe methods (GET/HEAD/OPTIONS) are not
  // checked — they shouldn't mutate state by definition.
  if (isStateChangingMethod(req.method) && !originAllowed(req)) {
    return jsonResponse({ error: 'Forbidden: invalid origin' }, { status: 403 })
  }

  if (url.pathname === '/api/cms/setup/status') {
    if (req.method !== 'GET') return methodNotAllowed()
    return jsonResponse(await getSetupStatus(db))
  }

  if (url.pathname === '/api/cms/setup') {
    if (req.method !== 'POST') return methodNotAllowed()
    const status = await getSetupStatus(db)
    if (!status.needsSetup) {
      return jsonResponse({ error: 'Setup already complete' }, { status: 409 })
    }

    const body = await readJsonObject(req)
    const siteName = readString(body, 'siteName')
    const email = readString(body, 'email').toLowerCase()
    const password = readString(body, 'password')

    if (!siteName) return badRequest('Missing siteName')
    if (!email.includes('@')) return badRequest('Invalid email')
    if (password.length < 12) return badRequest('Password must be at least 12 characters')

    return await db.transaction(async (tx) => {
      await createSite(tx, siteName, {})
      await createAdminUser(tx, {
        id: nanoid(),
        email,
        passwordHash: await hashPassword(password),
      })
      // Seed a starter homepage. SiteDocumentSchema requires pages.length >= 1
      // — a freshly-set-up site without any pages would fail validation the
      // moment the editor tried to load it.
      const rootNode = createNode('base.root')
      const homePage: Page = {
        id: nanoid(),
        title: 'Home',
        slug: 'index',
        rootNodeId: rootNode.id,
        nodes: { [rootNode.id]: rootNode },
      }
      await tx`
        insert into pages (id, title, slug, draft_document_json, sort_order)
        values (${homePage.id}, ${homePage.title}, ${homePage.slug}, ${homePage}, ${0})
      `
      return jsonResponse({ ok: true }, { status: 201 })
    })
  }

  if (url.pathname === '/api/cms/login') {
    if (req.method !== 'POST') return methodNotAllowed()
    const body = await readJsonObject(req)
    const email = readString(body, 'email').toLowerCase()
    const password = readString(body, 'password')

    // Rate limit per (client-ip, email) tuple. The bucket is consumed BEFORE
    // any DB lookup or password verification — an attacker who triggers the
    // 429 cannot make us burn argon2id CPU cycles.
    const rateLimitKey = `${clientIp(req)}|${email}`
    const decision = loginRateLimit.consume(rateLimitKey)
    if (!decision.ok) {
      return jsonResponse(
        { error: 'Too many login attempts. Try again later.' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) },
        },
      )
    }

    // Constant-time path: ALWAYS run argon2id verify, even when the email
    // doesn't match a user. Without this, "user not found" returns in ~5ms
    // while "user found, wrong password" takes ~100ms — a timing oracle for
    // email enumeration. We verify against a fixed dummy hash on the no-user
    // branch; the result is always false, but the latency profile is the
    // same as the real branch.
    const admin = await findAdminByEmail(db, email)
    const verifiedHash = admin?.password_hash ?? (await getDummyPasswordHash())
    const passwordOk = await verifyPassword(password, verifiedHash)

    if (!admin || !passwordOk) {
      return jsonResponse({ error: 'Invalid email or password' }, { status: 401 })
    }

    // Successful login → release this user's bucket so a forgotten password
    // followed by a correct attempt doesn't continue eating into the quota.
    loginRateLimit.reset(rateLimitKey)

    const token = createSessionToken()
    const expiresAt = sessionExpiry()
    await createSession(db, {
      idHash: await hashSessionToken(token),
      adminUserId: admin.id,
      expiresAt,
    })

    return setCookieHeader(jsonResponse({ ok: true }), sessionCookie(req, token, expiresAt))
  }

  if (url.pathname === '/api/cms/logout') {
    if (req.method !== 'POST') return methodNotAllowed()
    const idHash = await getSessionHash(req)
    if (idHash) await deleteSessionByHash(db, idHash)
    return setCookieHeader(jsonResponse({ ok: true }), clearSessionCookie(req))
  }

  if (url.pathname === '/api/cms/site') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    if (req.method === 'GET') {
      const site = await loadDraftSite(db)
      if (!site) return jsonResponse({ error: 'draft site not found' }, { status: 404 })
      return jsonResponse({ site })
    }

    if (req.method === 'PUT') {
      const body = await readJsonObject(req)
      try {
        const site = validateSite(body.site)
        await saveDraftSite(db, site)
        return jsonResponse({ ok: true })
      } catch (err) {
        if (err instanceof SiteValidationError) return badRequest(err.message)
        throw err
      }
    }

    return methodNotAllowed()
  }

  if (url.pathname === '/api/cms/runtime/dependencies/resolve') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'POST') return methodNotAllowed()

    const body = await readJsonObject(req)
    try {
      const packageJson = runtimeRequestPackageJson(body.packageJson)
      const dependencyLock = await resolveSiteDependencyLock(packageJson)
      return jsonResponse({ dependencyLock })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Runtime dependency resolution failed')
    }
  }

  if (url.pathname === '/api/cms/runtime/preview') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'POST') return methodNotAllowed()

    const body = await readJsonObject(req)
    const pageId = readString(body, 'pageId')
    const breakpointId = readString(body, 'breakpointId') || undefined
    const templateContext = readObject<TemplateRenderDataContext>(body, 'templateContext')
    if (!pageId) return badRequest('Missing pageId')

    try {
      const site = validateSite(body.site)
      const page = site.pages.find((candidate) => candidate.id === pageId)
      if (!page) return jsonResponse({ error: 'Page not found' }, { status: 404 })

      const runtime = normalizeSiteRuntimeConfig(site.runtime)
      const dependencyCache = Object.keys(runtime.dependencyLock.packages).length > 0
        ? await ensureRuntimeDependencyCache(runtime.dependencyLock)
        : undefined
      const preview = await buildRuntimePreviewDocument({
        site,
        page,
        registry,
        assetBasePath: '/_pb/preview/runtime/',
        dependencyCache,
        breakpointId,
        templateContext,
        db,
      })

      return jsonResponse({
        html: preview.html,
        assets: preview.files.map((file) => ({
          path: file.path,
          publicPath: file.publicPath,
          content: file.content,
          contentType: file.contentType,
        })),
        runtimeAssets: preview.runtimeAssets,
        diagnostics: preview.diagnostics,
      })
    } catch (err) {
      if (err instanceof SiteValidationError) return badRequest(err.message)
      return badRequest(err instanceof Error ? err.message : 'Runtime preview build failed')
    }
  }

  if (url.pathname === '/api/cms/media') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    if (req.method === 'GET') {
      return jsonResponse({ assets: await listMediaAssets(db) })
    }

    if (req.method === 'POST') {
      if (!options.uploadsDir) {
        return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
      }

      const file = await readUploadedFile(req)
      if (!file) return badRequest('Missing file')
      if (file.size <= 0) return badRequest('File is empty')
      if (file.size > MAX_MEDIA_BYTES) return badRequest('File exceeds the 50 MB hard limit')

      const mimeType = file.type || 'application/octet-stream'
      if (!isAcceptedMediaType(mimeType)) {
        return badRequest('Only image and video files can be uploaded')
      }

      const storagePath = `${nanoid()}-${safeStorageName(file.name)}`
      const publicPath = `/uploads/${storagePath}`
      await mkdir(options.uploadsDir, { recursive: true })
      await writeFile(join(options.uploadsDir, storagePath), new Uint8Array(await file.arrayBuffer()))

      const asset = await createMediaAsset(db, {
        id: nanoid(),
        filename: file.name || storagePath,
        mimeType,
        sizeBytes: file.size,
        storagePath,
        publicPath,
      })
      return jsonResponse({ asset }, { status: 201 })
    }

    return methodNotAllowed()
  }

  const mediaItemMatch = url.pathname.match(/^\/api\/cms\/media\/([^/]+)$/)
  if (mediaItemMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    const assetId = decodeURIComponent(mediaItemMatch[1])

    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      const filename = readString(body, 'filename')
      if (!filename) return badRequest('Filename is required')

      const asset = await renameMediaAsset(db, assetId, filename)
      if (!asset) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })
      return jsonResponse({ asset })
    }

    if (req.method === 'DELETE') {
      if (!options.uploadsDir) {
        return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
      }

      const deleted = await deleteMediaAsset(db, assetId)
      if (!deleted) return jsonResponse({ error: 'Media asset not found' }, { status: 404 })

      await rm(join(options.uploadsDir, deleted.storagePath), { force: true })
      return jsonResponse({ ok: true })
    }

    return methodNotAllowed()
  }

  if (url.pathname === '/api/cms/plugins') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    if (req.method === 'GET') {
      return jsonResponse(await pluginsPayload(db))
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req)
      try {
        const manifest = parsePluginManifest(body.manifest ?? body)
        const grantedPermissions = readPermissionGrants(body.grantedPermissions)
        const grantError = assertPluginPermissionGrants(manifest, grantedPermissions)
        if (grantError) return grantError
        const installed = await installPlugin(db, manifest, grantedPermissions)
        const plugin = await setPluginLifecycleStatus(db, installed.id, 'active') ?? installed
        return jsonResponse({ plugin, ...await pluginsPayload(db) }, { status: 201 })
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : 'Invalid plugin manifest')
      }
    }

    return methodNotAllowed()
  }

  if (url.pathname === '/api/cms/plugins/inspect-package') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'POST') return methodNotAllowed()

    const { file } = await readPluginPackageForm(req)
    if (!file) return badRequest('Missing plugin package')
    try {
      const pluginPackage = await readPluginPackage(file)
      return jsonResponse({ manifest: pluginPackage.manifest })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid plugin package')
    }
  }

  if (url.pathname === '/api/cms/plugins/package') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'POST') return methodNotAllowed()
    if (!options.uploadsDir) return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })

    const { file, grantedPermissions } = await readPluginPackageForm(req)
    if (!file) return badRequest('Missing plugin package')

    try {
      const pluginPackage = await readPluginPackage(file)
      const grantError = assertPluginPermissionGrants(pluginPackage.manifest, grantedPermissions)
      if (grantError) return grantError
      const manifest = await writePluginPackageFiles(options.uploadsDir, pluginPackage.manifest, pluginPackage.files)
      const installed = await installPlugin(db, manifest, grantedPermissions)
      const installLifecycle = await runPluginLifecycleHook(db, installed, options, 'install', 'installed')
      if (!installLifecycle.ok) {
        return jsonResponse({ plugin: installLifecycle.plugin, ...await pluginsPayload(db) }, { status: 201 })
      }

      serverPluginRuntime.unregisterPlugin(installed.id)
      const activateLifecycle = await runPluginLifecycleHook(
        db,
        installLifecycle.plugin,
        options,
        'activate',
        'active',
      )
      return jsonResponse({ plugin: activateLifecycle.plugin, ...await pluginsPayload(db) }, { status: 201 })
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid plugin package')
    }
  }

  const pluginItemMatch = url.pathname.match(/^\/api\/cms\/plugins\/([^/]+)$/)
  if (pluginItemMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    const pluginId = decodeURIComponent(pluginItemMatch[1])

    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      if (typeof body.enabled !== 'boolean') return badRequest('Plugin enabled must be a boolean')

      const current = await getInstalledPlugin(db, pluginId)
      if (!current) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })

      if (!body.enabled) {
        const disabled = await setPluginEnabled(db, pluginId, false)
        if (!disabled) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
        serverPluginRuntime.unregisterPlugin(pluginId)
        const lifecycle = await runPluginLifecycleHook(db, disabled, options, 'deactivate', 'disabled')
        await activateInstalledServerPlugins(db, options.uploadsDir)
        return jsonResponse({ plugin: lifecycle.plugin, ...await pluginsPayload(db) })
      }

      const enabled = await setPluginEnabled(db, pluginId, true)
      if (!enabled) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
      serverPluginRuntime.unregisterPlugin(pluginId)
      const lifecycle = await runPluginLifecycleHook(db, enabled, options, 'activate', 'active')
      return jsonResponse({ plugin: lifecycle.plugin, ...await pluginsPayload(db) })
    }

    if (req.method === 'DELETE') {
      const current = await getInstalledPlugin(db, pluginId)
      if (!current) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
      const lifecycle = await runPluginLifecycleHook(db, current, options, 'uninstall', current.lifecycleStatus)
      if (!lifecycle.ok) {
        return badRequest(lifecycle.plugin.lastError ?? 'Plugin uninstall failed')
      }

      const deleted = await deletePlugin(db, pluginId)
      if (!deleted) return jsonResponse({ error: 'Plugin not found' }, { status: 404 })
      serverPluginRuntime.unregisterPlugin(pluginId)
      await removePluginAssets(current, options.uploadsDir)
      await activateInstalledServerPlugins(db, options.uploadsDir)
      return jsonResponse({ ok: true })
    }

    return methodNotAllowed()
  }

  const pluginRecordsMatch = url.pathname.match(/^\/api\/cms\/plugins\/([^/]+)\/resources\/([^/]+)\/records$/)
  if (pluginRecordsMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    const pluginId = decodeURIComponent(pluginRecordsMatch[1])
    const resourceId = decodeURIComponent(pluginRecordsMatch[2])
    const resource = await getEnabledPluginResource(db, pluginId, resourceId)
    if (!resource) return jsonResponse({ error: 'Plugin resource not found' }, { status: 404 })

    if (req.method === 'GET') {
      return jsonResponse({
        resource,
        records: await listPluginRecords(db, pluginId, resourceId),
      })
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req)
      try {
        const data = validatePluginRecordData(resource, body.data ?? body)
        const record = await createPluginRecord(db, {
          id: nanoid(),
          pluginId,
          resourceId,
          data,
        })
        return jsonResponse({ record }, { status: 201 })
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : 'Invalid plugin record data')
      }
    }

    return methodNotAllowed()
  }

  const pluginRuntimeMatch = url.pathname.match(/^\/api\/cms\/plugins\/([^/]+)\/runtime(?:\/.*)?$/)
  if (pluginRuntimeMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    return await handleServerPluginRuntimeRequest(req, db)
      ?? jsonResponse({ error: 'Plugin route not found' }, { status: 404 })
  }

  const pluginRecordItemMatch = url.pathname.match(/^\/api\/cms\/plugins\/([^/]+)\/resources\/([^/]+)\/records\/([^/]+)$/)
  if (pluginRecordItemMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    const pluginId = decodeURIComponent(pluginRecordItemMatch[1])
    const resourceId = decodeURIComponent(pluginRecordItemMatch[2])
    const recordId = decodeURIComponent(pluginRecordItemMatch[3])
    const resource = await getEnabledPluginResource(db, pluginId, resourceId)
    if (!resource) return jsonResponse({ error: 'Plugin resource not found' }, { status: 404 })

    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      try {
        const data = validatePluginRecordData(resource, body.data ?? body)
        const record = await updatePluginRecord(db, {
          id: recordId,
          pluginId,
          resourceId,
          data,
        })
        if (!record) return jsonResponse({ error: 'Plugin record not found' }, { status: 404 })
        return jsonResponse({ record })
      } catch (err) {
        return badRequest(err instanceof Error ? err.message : 'Invalid plugin record data')
      }
    }

    if (req.method === 'DELETE') {
      const deleted = await deletePluginRecord(db, {
        id: recordId,
        pluginId,
        resourceId,
      })
      if (!deleted) return jsonResponse({ error: 'Plugin record not found' }, { status: 404 })
      return jsonResponse({ ok: true })
    }

    return methodNotAllowed()
  }

  if (url.pathname === '/api/cms/content/collections') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    if (req.method === 'GET') {
      return jsonResponse({ collections: await listContentCollections(db) })
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req)
      const name = readString(body, 'name')
      if (!name) return badRequest('Collection name is required')

      const singularLabel = readString(body, 'singularLabel') || name.replace(/s$/i, '') || name
      const pluralLabel = readString(body, 'pluralLabel') || name
      const slug = slugFromTitle(readString(body, 'slug') || pluralLabel)
      const routeBase = readString(body, 'routeBase') || slug
      const collection = await createContentCollection(db, {
        name,
        slug,
        routeBase,
        singularLabel,
        pluralLabel,
        fields: normalizeContentCollectionFields(body.fields),
      })
      return jsonResponse({ collection }, { status: 201 })
    }

    return methodNotAllowed()
  }

  const collectionItemMatch = url.pathname.match(/^\/api\/cms\/content\/collections\/([^/]+)$/)
  if (collectionItemMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    const collectionId = decodeURIComponent(collectionItemMatch[1])
    if (req.method === 'PATCH') {
      const body = await readJsonObject(req)
      const update: Parameters<typeof updateContentCollection>[2] = {}

      if ('name' in body) {
        const name = readString(body, 'name')
        if (!name) return badRequest('Collection name is required')
        update.name = name
      }
      if ('slug' in body) {
        const slug = slugFromTitle(readString(body, 'slug'))
        if (!slug) return badRequest('Collection slug is required')
        update.slug = slug
      }
      if ('routeBase' in body) {
        const routeBase = readString(body, 'routeBase')
        if (!routeBase) return badRequest('Route base is required')
        update.routeBase = routeBase
      }
      if ('singularLabel' in body) {
        const singularLabel = readString(body, 'singularLabel')
        if (!singularLabel) return badRequest('Singular label is required')
        update.singularLabel = singularLabel
      }
      if ('pluralLabel' in body) {
        const pluralLabel = readString(body, 'pluralLabel')
        if (!pluralLabel) return badRequest('Plural label is required')
        update.pluralLabel = pluralLabel
      }
      if ('fields' in body) {
        update.fields = normalizeContentCollectionFields(body.fields)
      }
      if (Object.keys(update).length === 0) return badRequest('Collection update is required')

      const collection = await updateContentCollection(db, collectionId, update)
      if (!collection) return jsonResponse({ error: 'Collection not found' }, { status: 404 })
      return jsonResponse({ collection })
    }

    if (req.method === 'DELETE') {
      const collection = await softDeleteContentCollection(db, collectionId)
      if (!collection) return jsonResponse({ error: 'Collection cannot be deleted' }, { status: 409 })
      return jsonResponse({ collection })
    }

    return methodNotAllowed()
  }

  const collectionEntriesMatch = url.pathname.match(/^\/api\/cms\/content\/collections\/([^/]+)\/entries$/)
  if (collectionEntriesMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    const collectionId = decodeURIComponent(collectionEntriesMatch[1])
    if (req.method === 'GET') {
      return jsonResponse({ entries: await listContentEntries(db, collectionId) })
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req)
      const title = readString(body, 'title') || 'Untitled'
      const entry = await createContentEntry(db, {
        collectionId,
        title,
        slug: slugFromTitle(readString(body, 'slug') || title),
        bodyMarkdown: readString(body, 'bodyMarkdown'),
        featuredMediaId: readNullableString(body, 'featuredMediaId'),
        seoTitle: readString(body, 'seoTitle'),
        seoDescription: readString(body, 'seoDescription'),
      })
      return jsonResponse({ entry }, { status: 201 })
    }

    return methodNotAllowed()
  }

  const contentEntryMatch = url.pathname.match(/^\/api\/cms\/content\/entries\/([^/]+)$/)
  if (contentEntryMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin

    const entryId = decodeURIComponent(contentEntryMatch[1])
    if (req.method === 'GET') {
      const entry = await getContentEntry(db, entryId)
      if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
      return jsonResponse({ entry })
    }

    if (req.method === 'PUT') {
      const body = await readJsonObject(req)
      const title = readString(body, 'title') || 'Untitled'
      const entry = await saveContentEntryDraft(db, entryId, {
        title,
        slug: slugFromTitle(readString(body, 'slug') || title),
        bodyMarkdown: readString(body, 'bodyMarkdown'),
        featuredMediaId: readNullableString(body, 'featuredMediaId'),
        seoTitle: readString(body, 'seoTitle'),
        seoDescription: readString(body, 'seoDescription'),
      })
      if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
      return jsonResponse({ entry })
    }

    if (req.method === 'DELETE') {
      const entry = await softDeleteContentEntry(db, entryId)
      if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
      return jsonResponse({ entry })
    }

    return methodNotAllowed()
  }

  const publishContentEntryMatch = url.pathname.match(/^\/api\/cms\/content\/entries\/([^/]+)\/publish$/)
  if (publishContentEntryMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'POST') return methodNotAllowed()

    const entryId = decodeURIComponent(publishContentEntryMatch[1])
    return jsonResponse(await publishContentEntry(db, entryId, admin.id))
  }

  const contentEntryStatusMatch = url.pathname.match(/^\/api\/cms\/content\/entries\/([^/]+)\/status$/)
  if (contentEntryStatusMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'PATCH') return methodNotAllowed()

    const body = await readJsonObject(req)
    const status = readString(body, 'status')
    if (status !== 'draft' && status !== 'unpublished') {
      return badRequest('Status must be draft or unpublished')
    }

    const entryId = decodeURIComponent(contentEntryStatusMatch[1])
    const entry = await updateContentEntryStatus(db, entryId, status)
    if (!entry) return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
    return jsonResponse({ entry })
  }

  const contentEntryCollectionMatch = url.pathname.match(/^\/api\/cms\/content\/entries\/([^/]+)\/collection$/)
  if (contentEntryCollectionMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'PATCH') return methodNotAllowed()

    const body = await readJsonObject(req)
    const collectionId = readString(body, 'collectionId')
    if (!collectionId) return badRequest('Collection is required')

    const entryId = decodeURIComponent(contentEntryCollectionMatch[1])
    const result = await updateContentEntryCollection(db, entryId, collectionId)
    if (result.ok) return jsonResponse({ entry: result.entry })
    if (result.reason === 'slug_conflict') {
      return jsonResponse({ error: 'An entry with this slug already exists in the target collection' }, { status: 409 })
    }
    if (result.reason === 'collection_not_found') {
      return jsonResponse({ error: 'Collection not found' }, { status: 404 })
    }
    return jsonResponse({ error: 'Content entry not found' }, { status: 404 })
  }

  // ─── Fonts library ───────────────────────────────────────────────────────
  // GET  /api/cms/fonts/google         — bundled Google Fonts directory (no CDN hit)
  // POST /api/cms/fonts/install        — download woff2 files, return FontEntry
  // DELETE /api/cms/fonts/family/:family — remove on-disk font files for a family
  //
  // The fonts library itself lives inside `site.settings.fonts`, so the
  // create/delete REST surface is intentionally narrow: install + uninstall
  // perform on-disk work; the metadata is persisted with the rest of the site
  // settings via the existing PUT /api/cms/site path.
  if (url.pathname === '/api/cms/fonts/google') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'GET') return methodNotAllowed()
    return jsonResponse({ families: listGoogleFonts() })
  }

  if (url.pathname === '/api/cms/fonts/install') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'POST') return methodNotAllowed()
    if (!options.uploadsDir) {
      return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
    }

    const body = await readJsonObject(req)
    const family = readString(body, 'family')
    const variants = Array.isArray(body.variants)
      ? (body.variants as unknown[]).filter((v): v is string => typeof v === 'string')
      : []
    const subsets = Array.isArray(body.subsets)
      ? (body.subsets as unknown[]).filter((s): s is string => typeof s === 'string')
      : []

    if (!family) return badRequest('Missing font family')
    if (variants.length === 0) return badRequest('Pick at least one variant')
    if (subsets.length === 0) return badRequest('Pick at least one subset')

    try {
      const entry = await installGoogleFont({ family, variants, subsets }, options.uploadsDir)
      return jsonResponse({ font: entry }, { status: 201 })
    } catch (err) {
      if (err instanceof FontInstallError) return badRequest(err.message)
      console.error('[fonts:install]', err)
      return jsonResponse({ error: 'Font install failed' }, { status: 500 })
    }
  }

  const fontFamilyMatch = url.pathname.match(/^\/api\/cms\/fonts\/family\/([^/]+)$/)
  if (fontFamilyMatch) {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'DELETE') return methodNotAllowed()
    if (!options.uploadsDir) {
      return jsonResponse({ error: 'Uploads directory is not configured' }, { status: 500 })
    }

    const family = decodeURIComponent(fontFamilyMatch[1])
    try {
      await uninstallFontFamily(family, options.uploadsDir)
      return jsonResponse({ ok: true })
    } catch (err) {
      console.error('[fonts:uninstall]', err)
      return jsonResponse({ error: 'Font uninstall failed' }, { status: 500 })
    }
  }

  if (url.pathname === '/api/cms/publish') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'POST') return methodNotAllowed()

    return jsonResponse(await publishDraftSite(db, admin.id))
  }

  if (url.pathname === '/api/cms/publish/status') {
    const admin = await requireAdmin(req, db)
    if (admin instanceof Response) return admin
    if (req.method !== 'GET') return methodNotAllowed()

    return jsonResponse(await getDraftPublishStatus(db))
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}
