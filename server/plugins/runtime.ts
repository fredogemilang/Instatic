/**
 * Plugin server-side runtime — orchestrates plugin lifecycle, route
 * forwarding, and asset path safety.
 *
 * As of the worker-isolation refactor, plugin server modules
 * (`entrypoints.server`) are loaded and executed in a separate Bun
 * `Worker` (see `pluginWorkerHost.ts` + `pluginWorker.ts`). The host
 * process never imports plugin code — eliminating the `bun --watch`
 * race during upgrade cleanup, isolating plugin crashes from the host,
 * and giving us a foundation to drop privileges (no fs / no env) inside
 * the worker in a future hardening pass.
 *
 * This module is the thin orchestration layer between the rest of the
 * CMS server and the worker host. It owns:
 *   - Path-containment safety (`assertPluginPathWithin`)
 *   - The plugin settings cache (read synchronously inside hook handlers
 *     via the worker's local mirror — populated at activation)
 *   - The HTTP entrypoint for `/admin/api/cms/plugins/:id/runtime/...`
 *   - The boot-time activation loop
 *
 * Plugin canvas-module packs (`entrypoints.modules`) still load in the
 * host process — the publisher's hot path calls `definition.render()`
 * synchronously per page node and an RPC round-trip per call would be
 * too expensive. Module packs use a data-URI import to sidestep the
 * `bun --watch` watcher (the dev-mode race driver) without paying the
 * worker RPC cost.
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import {
  getInstalledPlugin,
  listInstalledPlugins,
  recordPluginCrash,
  setPluginLifecycleStatus,
} from '../repositories/plugins'
import type {
  PluginManifest,
  PluginModulesEntrypointModule,
} from '@core/plugin-sdk'
import {
  activatePluginModulePack,
  resetPluginModulePacks,
} from '@core/plugins/modulePackLoader'
import { jsonResponse } from '../http'
import { hookBus } from '@core/plugins/hookBus'
import { requireCapability } from '../auth/authz'
import {
  clearPluginCrashCounter,
  findPluginRouteCapability,
  loadPluginInWorker,
  resetPluginWorker,
  runLifecycleInWorker,
  runMigrateInWorker,
  runRouteInWorker,
  setCrashRecoveryHandler,
  setPluginWorkerDbClient,
  unloadPluginInWorker,
} from './pluginWorkerHost'
import { broadcastPluginEvent } from './eventBroadcaster'

// Re-export for callers that orchestrate manual restart (resets the
// per-plugin crash counter so the next failure starts a fresh budget).
export { clearPluginCrashCounter }

// Re-export the host's setter so the server entry point can wire in the
// DbClient at boot before any request arrives.
export { setPluginWorkerDbClient }

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Defense-in-depth path containment. The schema-level pattern on
 * `assetBasePath` and the `SAFE_ASSET_PATH_PATTERN` on `entrypoints.*` already
 * exclude `..` segments and absolute paths, but the filesystem sinks recompose
 * paths via `path.join` — so we re-assert the resolved path stays under
 * `uploadsDir` after composition.
 */
export function assertPluginPathWithin(uploadsDir: string, child: string): void {
  const rel = relative(uploadsDir, child)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Plugin path "${child}" escapes uploads root`)
  }
}

// ---------------------------------------------------------------------------
// Settings cache — used by the worker host to seed each loaded plugin's
// in-worker `settings.get` mirror, and refreshed on PUTs through the admin
// settings route.
// ---------------------------------------------------------------------------

const pluginSettingsCache = new Map<string, Record<string, string | number | boolean>>()

export function getPluginSettingsSnapshot(
  pluginId: string,
): Record<string, string | number | boolean> {
  return pluginSettingsCache.get(pluginId) ?? {}
}

export function updatePluginSettingsCache(
  pluginId: string,
  settings: Record<string, string | number | boolean>,
): void {
  pluginSettingsCache.set(pluginId, settings)
}

export function clearPluginSettingsCache(pluginId: string): void {
  pluginSettingsCache.delete(pluginId)
}

export async function refreshPluginSettingsCache(
  db: DbClient,
  pluginId: string,
): Promise<void> {
  const plugin = await getInstalledPlugin(db, pluginId)
  if (!plugin) return
  pluginSettingsCache.set(pluginId, plugin.settings)
}

// ---------------------------------------------------------------------------
// Plugin lifecycle helpers — wrappers around the worker host that resolve
// the on-disk entrypoint path safely. Callers in `plugins.ts` use these
// to load + run individual lifecycle hooks during install / upgrade /
// disable / uninstall flows.
// ---------------------------------------------------------------------------

interface ResolvedEntrypoint {
  entryPath: string
}

function resolvePluginServerEntrypoint(
  manifest: PluginManifest,
  uploadsDir: string,
): ResolvedEntrypoint | null {
  if (!manifest.assetBasePath || !manifest.entrypoints?.server) return null
  const relativeBase = manifest.assetBasePath.replace(/^\/uploads\/?/, '')
  const entryPath = join(uploadsDir, relativeBase, manifest.entrypoints.server)
  assertPluginPathWithin(uploadsDir, entryPath)
  return { entryPath }
}

/**
 * Load a plugin's server entrypoint into the worker. Returns `false` if
 * the plugin has no server entrypoint (declarative-only plugins are
 * skipped). Throws if the worker reports a load error so callers can
 * propagate the message into the lifecycle status row.
 */
export async function loadPluginServerEntrypoint(
  manifest: PluginManifest,
  uploadsDir?: string,
): Promise<boolean> {
  if (!uploadsDir) return false
  const resolved = resolvePluginServerEntrypoint(manifest, uploadsDir)
  if (!resolved) return false
  const result = await loadPluginInWorker({
    manifest,
    entryFileUrl: resolved.entryPath,
    settings: pluginSettingsCache.get(manifest.id) ?? {},
  })
  if (!result.ok) {
    throw new Error(result.error ?? `Failed to load plugin "${manifest.id}" in worker`)
  }
  return true
}

/**
 * Run a single lifecycle hook on a previously-loaded plugin. No-op if
 * the hook isn't exported by the plugin module.
 */
export async function runPluginLifecycle(
  pluginId: string,
  hook: 'install' | 'activate' | 'deactivate' | 'uninstall',
): Promise<void> {
  await runLifecycleInWorker(pluginId, hook)
}

/**
 * Run the `migrate` hook on a previously-loaded plugin. The host calls
 * this in the upgrade flow between the old version's deactivate and the
 * new version's activate.
 */
export async function runPluginMigrate(
  pluginId: string,
  fromVersion: string,
): Promise<void> {
  await runMigrateInWorker(pluginId, fromVersion)
}

/**
 * Drop a plugin from the worker. Called after `deactivate` / `uninstall`
 * lands. Forgets host-side route + hook + loop registrations as a side
 * effect.
 */
export async function unloadPlugin(pluginId: string): Promise<void> {
  pluginSettingsCache.delete(pluginId)
  await unloadPluginInWorker(pluginId)
}

// ---------------------------------------------------------------------------
// Module pack loader (canvas modules)
// ---------------------------------------------------------------------------

/**
 * Load a plugin's canvas module pack. Uses a base64 data URI so the
 * pack file isn't tracked by `bun --watch` (which would otherwise
 * trigger a server reload when the file is deleted during plugin
 * upgrade cleanup). Module packs are bundled to a single file by the
 * plugin SDK build pipeline, so the lack of relative-import support
 * inside data URIs is not a constraint.
 *
 * Module packs deliberately stay in the host process — the publisher's
 * hot path calls `definition.render()` synchronously per page node and
 * an RPC round-trip per call would be prohibitively expensive.
 */
export async function loadPluginModulePack(
  manifest: PluginManifest,
  uploadsDir?: string,
): Promise<PluginModulesEntrypointModule | null> {
  if (!uploadsDir || !manifest.assetBasePath || !manifest.entrypoints?.modules) return null
  const relativeBase = manifest.assetBasePath.replace(/^\/uploads\/?/, '')
  const entryPath = join(uploadsDir, relativeBase, manifest.entrypoints.modules)
  assertPluginPathWithin(uploadsDir, entryPath)
  const code = await readFile(entryPath, 'utf-8')
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  return await import(dataUrl) as PluginModulesEntrypointModule
}

// ---------------------------------------------------------------------------
// HTTP runtime forwarder — `/admin/api/cms/plugins/:id/runtime/...`
// ---------------------------------------------------------------------------

export async function handleServerPluginRuntimeRequest(
  req: Request,
  db: DbClient,
): Promise<Response | null> {
  const url = new URL(req.url)
  const match = url.pathname.match(/^\/admin\/api\/cms\/plugins\/([^/]+)\/runtime(\/.*)?$/)
  if (!match) return null

  const pluginId = decodeURIComponent(match[1])
  const routePath = decodeURIComponent(match[2] ?? '/')

  const route = findPluginRouteCapability(pluginId, req.method, routePath)
  if (!route) return jsonResponse({ error: 'Plugin route not found' }, { status: 404 })

  // Capability check stays host-side. The plugin route handler in the
  // worker still receives the validated user object so it can do
  // additional fine-grained checks if needed.
  const user = route.capability ? await requireCapability(req, db, route.capability) : null
  if (user instanceof Response) return user

  return await runRouteInWorker({
    pluginId,
    method: req.method,
    path: routePath,
    request: req,
    user: user
      ? { id: user.id, email: user.email, capabilities: user.capabilities }
      : null,
  })
}

// ---------------------------------------------------------------------------
// Boot-time activation
// ---------------------------------------------------------------------------

/**
 * Re-load + re-activate a single plugin from disk. Used by the crash
 * recovery handler (after a worker auto-respawn) and by the manual
 * "Restart Plugin" admin endpoint.
 */
export async function reloadAndActivatePlugin(
  db: DbClient,
  pluginId: string,
  uploadsDir?: string,
): Promise<void> {
  if (!uploadsDir) return
  const plugin = await getInstalledPlugin(db, pluginId)
  if (!plugin || !plugin.enabled) return
  const manifest: PluginManifest = {
    ...plugin.manifest,
    grantedPermissions: plugin.grantedPermissions,
  }
  if (!manifest.assetBasePath) return
  // Refresh the in-memory settings cache from the canonical row before the
  // worker mirror gets seeded — keeps the worker in sync if settings drifted
  // since the last activation.
  pluginSettingsCache.set(manifest.id, plugin.settings)
  if (manifest.entrypoints?.server) {
    const loaded = await loadPluginServerEntrypoint(manifest, uploadsDir)
    if (loaded) await runPluginLifecycle(manifest.id, 'activate')
  }
}

/**
 * Register the crash recovery handler with the worker host. Called from
 * `activateInstalledServerPlugins` so the host has a live `db + uploadsDir`
 * pair to reload plugins with after a crash. Each invocation replaces the
 * previous handler (idempotent — safe to call on every boot / re-bind).
 */
function registerCrashRecoveryHandler(db: DbClient, uploadsDir: string): void {
  setCrashRecoveryHandler(async ({ pluginId, reason, decision }) => {
    const occurredAt = new Date().toISOString()

    // Persist the crash event so the admin UI can show it. Best-effort —
    // a DB error here shouldn't block the recovery flow.
    try {
      await recordPluginCrash(db, {
        id: nanoid(),
        pluginId,
        reason,
      })
    } catch (err) {
      console.error(`[plugin:${pluginId}] failed to record crash event:`, err)
    }

    // Tell every connected admin client about the crash so toasts + nav
    // badge + open Plugins-page lists update in real time.
    broadcastPluginEvent({
      kind: 'crash',
      pluginId,
      reason,
      recentCrashCount: decision.recentCrashCount,
      occurredAt,
    })

    if (decision.kind === 'give-up') {
      // Crash budget exceeded — park the plugin in error state. The site
      // owner has to click "Restart Plugin" in the admin UI to reset the
      // counter and try again.
      console.error(
        `[plugin:${pluginId}] crashed ${decision.recentCrashCount} times in the last 5 minutes; parking in error state`,
      )
      await setPluginLifecycleStatus(
        db,
        pluginId,
        'error',
        `Crash budget exceeded (${decision.recentCrashCount} crashes in 5 min). Last reason: ${reason}`,
      )
      broadcastPluginEvent({
        kind: 'parked',
        pluginId,
        reason,
        recentCrashCount: decision.recentCrashCount,
        occurredAt,
      })
      return
    }

    // Within budget — auto-respawn. The worker host has already torn down
    // the dead worker; reloading spawns a fresh one and re-runs activate.
    console.warn(
      `[plugin:${pluginId}] crash #${decision.recentCrashCount} in window — auto-respawning. Last reason: ${reason}`,
    )
    try {
      await reloadAndActivatePlugin(db, pluginId, uploadsDir)
      broadcastPluginEvent({
        kind: 'recovered',
        pluginId,
        afterCrashCount: decision.recentCrashCount,
        occurredAt: new Date().toISOString(),
      })
    } catch (err) {
      // Re-activation itself failed. The next round-trip will record this
      // as another crash event via the worker's normal error path; if the
      // failure is repeatable the budget will be exceeded and the plugin
      // will park in error state on its own. Log here for ops visibility.
      console.error(`[plugin:${pluginId}] auto-respawn re-activation failed:`, err)
    }
  })
}

export async function activateInstalledServerPlugins(
  db: DbClient,
  uploadsDir?: string,
): Promise<void> {
  if (!uploadsDir) return

  // Make sure the worker host can reach the DbClient — required before any
  // worker-initiated `cms.storage.*` round-trip lands. Idempotent; safe to
  // call on every boot.
  setPluginWorkerDbClient(db)
  registerCrashRecoveryHandler(db, uploadsDir)

  // Reset existing in-process state so a re-bind (from `bun --watch`
  // reload, dev-mode hot path, or a full restart) starts from a clean
  // slate. Worker is terminated and respawned on next call.
  await resetPluginWorker()
  resetPluginModulePacks()
  hookBus.reset()

  const plugins = await listInstalledPlugins(db)
  for (const plugin of plugins) {
    if (!plugin.enabled) continue
    const manifest: PluginManifest = {
      ...plugin.manifest,
      grantedPermissions: plugin.grantedPermissions,
    }
    if (!manifest.assetBasePath) continue

    // Settings cache must be populated BEFORE the worker loads the plugin
    // — `loadPluginInWorker` reads from `pluginSettingsCache` to seed the
    // worker's local `settings.get` mirror, which plugin code may consult
    // synchronously during `activate()`.
    pluginSettingsCache.set(manifest.id, plugin.settings)

    // Module pack first — registers canvas modules in the host registry so
    // server-rendered (publisher) and editor-rendered (canvas) pages can
    // use them immediately.
    if (
      manifest.entrypoints?.modules &&
      plugin.grantedPermissions.includes('modules.register')
    ) {
      try {
        const pack = await loadPluginModulePack(manifest, uploadsDir)
        if (pack) activatePluginModulePack(manifest, pack)
      } catch (err) {
        console.error(`[plugin:${manifest.id}] module pack load failed`, err)
      }
    }

    // Server entrypoint — load into worker, then run activate.
    if (manifest.entrypoints?.server) {
      try {
        const loaded = await loadPluginServerEntrypoint(manifest, uploadsDir)
        if (loaded) await runPluginLifecycle(manifest.id, 'activate')
      } catch (err) {
        console.error(`[plugin:${manifest.id}] server entrypoint activation failed`, err)
      }
    }
  }
}
