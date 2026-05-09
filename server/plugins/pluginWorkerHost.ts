/**
 * Plugin worker host — main-side manager for plugin worker isolation.
 *
 * One Bun.Worker is spawned per plugin id (see `ensureWorkerFor`). This
 * gives true blast-radius isolation: an uncaught error in plugin A's
 * lifecycle / route handler / hook only kills plugin A's worker; sibling
 * plugins keep running. The next call to `loadPluginInWorker(A,...)`
 * respawns A's worker.
 *
 * Bidirectional RPC bridge to each `pluginWorker.ts` instance:
 *  - Outbound: `loadPlugin`, `unloadPlugin`, `runLifecycle`, `runMigrate`,
 *    `runRoute`, `runHookListener`, `runHookFilter`, `runLoopFetch`,
 *    `runLoopPreview` — all return promises that resolve on the matching
 *    `*-result` message from the worker.
 *  - Inbound: dispatches `api-call` messages from the worker to the
 *    appropriate host primitive (db repository, hookBus, loopSourceRegistry,
 *    plugin settings repository).
 *
 * Defense-in-depth: a worker can only issue api-calls referencing its own
 * pluginId. Cross-plugin dispatch attempts are rejected before any
 * host-side side effect. See `handleWorkerMessage`.
 *
 * Resource cost: each Bun.Worker holds its own V8 isolate (~few MB
 * resident). Dozens of plugins → few hundred MB. Acceptable for self-
 * hosted CMS deployments. If/when supporting hundreds of plugins on a
 * small box becomes a constraint, group by trust level: shared worker for
 * first-party / signed plugins, per-worker for third-party.
 */

import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import type {
  PluginManifest,
  PluginPermission,
  PluginRecord,
  ServerPluginLifecycleHook,
} from '@core/plugin-sdk'
import {
  validatePluginSettingsRecord,
  type PluginSettingDefinition,
} from '@core/plugin-sdk'
import { findPluginResource, validatePluginRecordData } from '@core/plugins/manifest'
import { hookBus } from '@core/plugins/hookBus'
import { loopSourceRegistry } from '@core/loops/registry'
import type { LoopEntitySource, LoopFetchResult, LoopItem } from '@core/loops/types'
import {
  createPluginRecord,
  deletePluginRecord,
  listPluginRecords,
  setPluginSettings,
  updatePluginRecord,
} from '../repositories/plugins'
import { isCoreCapability, type CoreCapability } from '../auth/capabilities'
import type {
  ApiCall,
  LoadPluginResult,
  MainToWorkerMessage,
  SerializedRequest,
  SerializedResponse,
  SerializedUser,
  WorkerToMainMessage,
} from './workerProtocol'
import { isAllowedApiTarget } from './workerProtocol'

// ---------------------------------------------------------------------------
// Per-plugin host-side bookkeeping
// ---------------------------------------------------------------------------

interface HostRouteEntry {
  pluginId: string
  method: string
  path: string
  capability: CoreCapability | null
  routeKey: string
}

interface HostHookListenerEntry {
  pluginId: string
  listenerId: string
}

interface HostHookFilterEntry {
  pluginId: string
  filterId: string
}

interface HostLoopSourceEntry {
  pluginId: string
  sourceId: string
}

interface HostPluginRecord {
  manifest: PluginManifest
  routes: Map<string, HostRouteEntry>
  hookListeners: HostHookListenerEntry[]
  hookFilters: HostHookFilterEntry[]
  loopSources: HostLoopSourceEntry[]
}

const hostPlugins = new Map<string, HostPluginRecord>()

// ---------------------------------------------------------------------------
// Worker lifecycle — per-plugin workers
// ---------------------------------------------------------------------------
//
// We spawn ONE Bun.Worker per plugin id. Crash isolation is real: if plugin A
// throws an uncaught error during `activate` or inside a route handler, only
// plugin A's worker is terminated. Sibling plugins keep running, their
// pending RPC's resolve normally, the next call to `loadPluginInWorker(A,...)`
// respawns A's worker.
//
// Resource tradeoff: each worker has its own V8 isolate (≈few MB resident).
// At dozens of plugins this is a few hundred MB; that's the cost of
// per-tenant blast-radius isolation. If a future deploy needs to support
// hundreds of plugins on a small box, we can group plugins by trust level
// (one shared worker for first-party, per-plugin for third-party) — but
// that's premature today.

interface PendingRequest {
  pluginId: string
  resolve: (value: WorkerToMainMessage) => void
  reject: (err: unknown) => void
}

const workers = new Map<string, Worker>()
/** Shared correlation map — values track which pluginId issued the request
 *  so a worker crash can reject only that plugin's pending calls. */
const pendingRequests = new Map<string, PendingRequest>()

let dbForApi: DbClient | null = null

export function setPluginWorkerDbClient(db: DbClient): void {
  dbForApi = db
}

// ---------------------------------------------------------------------------
// Crash recovery — sliding-window counter + auto-respawn
// ---------------------------------------------------------------------------

/**
 * Crash threshold: if a plugin's worker crashes this many times within
 * CRASH_WINDOW_MS, the host stops auto-respawning and parks the plugin in
 * `lifecycle_status='error'`. The site owner has to click "Restart Plugin"
 * to reset the counter and try again.
 */
const CRASH_THRESHOLD = 3
const CRASH_WINDOW_MS = 5 * 60 * 1000

interface CrashTracker {
  /** Crash timestamps within the current sliding window, oldest first. */
  timestamps: number[]
}

const crashTrackers = new Map<string, CrashTracker>()

/**
 * Reset a plugin's crash counter. Called on a successful manual restart and
 * on uninstall.
 */
export function clearPluginCrashCounter(pluginId: string): void {
  crashTrackers.delete(pluginId)
}

/**
 * Outcome the runtime layer should take after a worker crash. Returned by
 * `recordCrashAndDecide` so the runtime can both persist the event and
 * branch on whether to respawn or park in error state.
 */
export type CrashRecoveryDecision =
  | { kind: 'respawn'; recentCrashCount: number }
  | { kind: 'give-up'; recentCrashCount: number }

/**
 * Record a crash in the per-plugin sliding window. Returns whether the host
 * should auto-respawn or give up.
 */
export function recordCrashAndDecide(pluginId: string, now: number = Date.now()): CrashRecoveryDecision {
  const tracker = crashTrackers.get(pluginId) ?? { timestamps: [] }
  const cutoff = now - CRASH_WINDOW_MS
  // Drop expired entries before counting.
  tracker.timestamps = tracker.timestamps.filter((t) => t > cutoff)
  tracker.timestamps.push(now)
  crashTrackers.set(pluginId, tracker)

  const recentCrashCount = tracker.timestamps.length
  if (recentCrashCount >= CRASH_THRESHOLD) {
    return { kind: 'give-up', recentCrashCount }
  }
  return { kind: 'respawn', recentCrashCount }
}

/**
 * Callback the runtime registers so the worker host can ask it to re-load +
 * re-activate a plugin after an auto-respawn (or a manual restart). The
 * runtime owns the on-disk asset path resolution and lifecycle ordering;
 * the host just signals when to re-bind.
 */
export type CrashRecoveryHandler = (args: {
  pluginId: string
  reason: string
  decision: CrashRecoveryDecision
}) => Promise<void>

let crashRecoveryHandler: CrashRecoveryHandler | null = null

export function setCrashRecoveryHandler(handler: CrashRecoveryHandler): void {
  crashRecoveryHandler = handler
}

/**
 * Get the worker for a pluginId, spawning one if needed. Each spawn wires
 * its own message + error listeners so a crash in this worker only affects
 * pendings + state for THIS plugin id.
 */
function ensureWorkerFor(pluginId: string): Worker {
  const existing = workers.get(pluginId)
  if (existing) return existing
  const w = new Worker(new URL('./pluginWorker.ts', import.meta.url).href)
  workers.set(pluginId, w)
  w.addEventListener('message', (event: MessageEvent) => {
    handleWorkerMessage(pluginId, event.data as WorkerToMainMessage)
  })
  w.addEventListener('error', (event: ErrorEvent) => {
    console.error(`[plugin:${pluginId}] uncaught error in worker:`, event.message, event.error)
    handleWorkerCrash(pluginId, event.message)
  })
  return w
}

/**
 * Worker for `pluginId` died (uncaught error). Reject only that plugin's
 * pending RPCs; tear down host-side state for that plugin; drop the
 * worker reference so the next call respawns. Sibling plugins are
 * unaffected.
 *
 * After local cleanup, we record the crash in the per-plugin sliding-window
 * counter and hand off to the runtime layer (`crashRecoveryHandler`) which
 * decides whether to auto-respawn or park the plugin in `error` state. The
 * handler is responsible for: persisting the event to `plugin_crash_events`,
 * updating the lifecycle row, re-loading the plugin into a fresh worker.
 */
function handleWorkerCrash(pluginId: string, reason: string): void {
  const w = workers.get(pluginId)
  if (w) {
    try { w.terminate() } catch {/* worker may already be dead */}
    workers.delete(pluginId)
  }
  for (const [correlationId, pending] of pendingRequests) {
    if (pending.pluginId !== pluginId) continue
    pendingRequests.delete(correlationId)
    pending.reject(new Error(`Plugin "${pluginId}" worker crashed: ${reason}`))
  }
  // Drop host-side bookkeeping for this plugin. Hook listeners + loop
  // sources registered via the dead worker would otherwise keep
  // round-tripping into nothing.
  const entry = hostPlugins.get(pluginId)
  if (entry) {
    for (const source of entry.loopSources) {
      loopSourceRegistry.unregister(source.sourceId)
    }
    hookBus.unregisterPlugin(pluginId)
    hostPlugins.delete(pluginId)
  }

  const decision = recordCrashAndDecide(pluginId)
  // Hand off to the runtime layer in a microtask — we don't want to block
  // the error event handler on async work, and re-loading the plugin needs
  // the current crash teardown to fully settle first.
  if (crashRecoveryHandler) {
    const handler = crashRecoveryHandler
    queueMicrotask(() => {
      handler({ pluginId, reason, decision }).catch((err: unknown) => {
        console.error(`[plugin:${pluginId}] crash recovery handler failed:`, err)
      })
    })
  }
}

function sendTo(pluginId: string, msg: MainToWorkerMessage): void {
  ensureWorkerFor(pluginId).postMessage(msg)
}

function requestFromWorker<TKind extends WorkerToMainMessage['kind']>(
  pluginId: string,
  msg: MainToWorkerMessage,
  expectedKind: TKind,
): Promise<Extract<WorkerToMainMessage, { kind: TKind }>> {
  return new Promise<Extract<WorkerToMainMessage, { kind: TKind }>>((resolve, reject) => {
    pendingRequests.set(msg.correlationId, {
      pluginId,
      resolve: (value) => {
        if (value.kind !== expectedKind) {
          reject(new Error(`Plugin worker returned unexpected message kind "${value.kind}"`))
          return
        }
        resolve(value as Extract<WorkerToMainMessage, { kind: TKind }>)
      },
      reject,
    })
    sendTo(pluginId, msg)
  })
}

function handleWorkerMessage(workerPluginId: string, msg: WorkerToMainMessage): void {
  switch (msg.kind) {
    case 'log':
      // Defense-in-depth: a worker can't impersonate another plugin's id in
      // its log line. The log prefix is the worker's owning pluginId.
      console.info(`[plugin:${workerPluginId}]`, ...msg.args)
      return
    case 'api-call':
      // Defense-in-depth: an api-call must reference the worker's own
      // pluginId. Cross-plugin dispatch attempts get rejected before any
      // host-side side effect.
      if (msg.pluginId !== workerPluginId) {
        replyApiError(
          workerPluginId,
          msg.correlationId,
          `api-call from worker "${workerPluginId}" references foreign pluginId "${msg.pluginId}"`,
        )
        return
      }
      void dispatchApiCall(msg)
      return
    default: {
      const pending = pendingRequests.get(msg.correlationId)
      if (!pending) return
      pendingRequests.delete(msg.correlationId)
      pending.resolve(msg)
    }
  }
}

// ---------------------------------------------------------------------------
// Public API — used by the rest of the host
// ---------------------------------------------------------------------------

export async function loadPluginInWorker(args: {
  manifest: PluginManifest
  entryFileUrl: string
  settings: Record<string, string | number | boolean>
}): Promise<LoadPluginResult> {
  // Clear any prior host-side state for this plugin id — hook listeners,
  // loop sources, route entries — so a re-load (e.g. install → activate
  // sequence, or upgrade install) starts from a clean slate. The worker
  // also replaces its in-worker entry on `load-plugin`, so we don't need
  // to send an explicit `unload-plugin` first.
  const prior = hostPlugins.get(args.manifest.id)
  if (prior) {
    for (const source of prior.loopSources) {
      loopSourceRegistry.unregister(source.sourceId)
    }
    hookBus.unregisterPlugin(args.manifest.id)
  }
  hostPlugins.set(args.manifest.id, {
    manifest: args.manifest,
    routes: new Map(),
    hookListeners: [],
    hookFilters: [],
    loopSources: [],
  })

  const correlationId = nanoid()
  const result = await requestFromWorker(
    args.manifest.id,
    {
      kind: 'load-plugin',
      correlationId,
      pluginId: args.manifest.id,
      manifest: args.manifest,
      entryFileUrl: args.entryFileUrl,
      settings: args.settings,
    },
    'load-plugin-result',
  )
  return result
}

export async function unloadPluginInWorker(pluginId: string): Promise<void> {
  // Tear down host-side registrations BEFORE the worker forgets the plugin
  // — once the worker is told to drop, any in-flight callbacks would have
  // nowhere to go. The route map itself is owned by `hostPlugins`; clearing
  // the entry below also clears the routes.
  const entry = hostPlugins.get(pluginId)
  if (entry) {
    for (const source of entry.loopSources) {
      loopSourceRegistry.unregister(source.sourceId)
    }
    hookBus.unregisterPlugin(pluginId)
  }
  hostPlugins.delete(pluginId)

  const w = workers.get(pluginId)
  if (!w) return
  // Send `unload-plugin` so the worker can do any cleanup, then terminate
  // the worker entirely. Per-plugin worker → terminate fully on unload so
  // we don't keep a dead worker process around.
  try {
    await requestFromWorker(
      pluginId,
      { kind: 'unload-plugin', correlationId: nanoid(), pluginId },
      'unload-plugin-result',
    )
  } catch {
    // worker may have already crashed — terminate is still safe
  }
  try { w.terminate() } catch {/* may already be terminated */}
  workers.delete(pluginId)
}

export async function runLifecycleInWorker(
  pluginId: string,
  hook: Exclude<ServerPluginLifecycleHook, 'migrate'>,
): Promise<void> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-lifecycle', correlationId: nanoid(), pluginId, hook },
    'lifecycle-result',
  )
  if (!result.ok) {
    throw new Error(result.error ?? `Plugin "${pluginId}" ${hook} failed`)
  }
}

export async function runMigrateInWorker(
  pluginId: string,
  fromVersion: string,
): Promise<void> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-migrate', correlationId: nanoid(), pluginId, fromVersion },
    'lifecycle-result',
  )
  if (!result.ok) {
    throw new Error(result.error ?? `Plugin "${pluginId}" migrate failed`)
  }
}

/**
 * Forward an inbound HTTP request to the plugin's route handler in the
 * worker. The host has already verified the route is registered + the
 * caller has the required capability — this function only handles the
 * worker round-trip and response materialisation.
 */
export async function runRouteInWorker(args: {
  pluginId: string
  method: string
  path: string
  request: Request
  user: SerializedUser | null
}): Promise<Response> {
  const entry = hostPlugins.get(args.pluginId)
  const routeKey = `${args.method.toUpperCase()}:${normalizeRoutePath(args.path)}`
  const route = entry?.routes.get(routeKey)
  if (!route) return new Response('Plugin route not found', { status: 404 })

  // Read the body once, pre-parse the JSON form for the handler context.
  const bodyText = args.method !== 'GET' ? await args.request.text() : ''
  let parsedBody: Record<string, unknown> = {}
  if (bodyText) {
    try {
      const parsed: unknown = JSON.parse(bodyText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedBody = parsed as Record<string, unknown>
      }
    } catch {
      // non-JSON body — handler can read raw via req.text()
    }
  }

  // Real Bun `Headers` supports both `forEach` and the entries iterator.
  // Test stubs may only provide `.get(name)` — handle both shapes so we
  // can ship realistic typing without forcing tests to mock the full
  // Headers contract.
  const headers: Record<string, string> = {}
  const reqHeaders = args.request.headers as unknown as
    | { forEach?: (cb: (value: string, key: string) => void) => void; entries?: () => Iterable<[string, string]> }
    | null
  if (reqHeaders && typeof reqHeaders.forEach === 'function') {
    reqHeaders.forEach((v: string, k: string) => { headers[k] = v })
  } else if (reqHeaders && typeof reqHeaders.entries === 'function') {
    for (const [k, v] of reqHeaders.entries()) headers[k] = v
  }

  const serializedReq: SerializedRequest = {
    url: args.request.url,
    method: args.request.method,
    headers,
    body: bodyText,
  }

  const result = await requestFromWorker(
    args.pluginId,
    {
      kind: 'run-route',
      correlationId: nanoid(),
      pluginId: args.pluginId,
      routeKey,
      request: serializedReq,
      user: args.user,
      body: parsedBody,
    },
    'route-result',
  )
  if (!result.ok || !result.response) {
    return Response.json({ error: result.error ?? 'Plugin route failed' }, { status: 500 })
  }
  return materializeResponse(result.response)
}

function materializeResponse(response: SerializedResponse): Response {
  if (response.kind === 'response') {
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    })
  }
  return Response.json(response.value)
}

export function getRegisteredRoute(
  pluginId: string,
  method: string,
  path: string,
): { capability: CoreCapability | null } | null {
  const entry = hostPlugins.get(pluginId)
  const route = entry?.routes.get(`${method.toUpperCase()}:${normalizeRoutePath(path)}`)
  return route ? { capability: route.capability } : null
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

/**
 * Fully tear down host-side state. Called by `activateInstalledServerPlugins`
 * before re-binding plugins (e.g. on server boot or after a settings change
 * that requires a clean re-load).
 */
export async function resetPluginWorker(): Promise<void> {
  hostPlugins.clear()
  for (const [, w] of workers) {
    try { w.terminate() } catch {/* noop */}
  }
  workers.clear()
  // Reject pending; respawn happens on next call.
  for (const [, pending] of pendingRequests) {
    pending.reject(new Error('Plugin worker reset'))
  }
  pendingRequests.clear()
}

// ---------------------------------------------------------------------------
// Inbound api-call dispatch
// ---------------------------------------------------------------------------

async function dispatchApiCall(msg: ApiCall): Promise<void> {
  if (!isAllowedApiTarget(msg.target)) {
    replyApiError(msg.pluginId, msg.correlationId, `Unknown api target "${msg.target}"`)
    return
  }
  if (!dbForApi) {
    replyApiError(msg.pluginId, msg.correlationId, 'Plugin worker host has no DbClient configured')
    return
  }
  const db = dbForApi
  const entry = hostPlugins.get(msg.pluginId)
  if (!entry) {
    replyApiError(msg.pluginId, msg.correlationId, `Plugin "${msg.pluginId}" is not loaded`)
    return
  }

  try {
    switch (msg.target) {
      case 'cms.routes.register': {
        const arg = msg.args[0] as {
          method: string
          path: string
          capability: string | null
          routeKey: string
        }
        if (arg.capability !== null && !isCoreCapability(arg.capability)) {
          throw new Error(`Unknown plugin route capability: ${arg.capability}`)
        }
        entry.routes.set(arg.routeKey, {
          pluginId: msg.pluginId,
          method: arg.method,
          path: arg.path,
          capability: arg.capability as CoreCapability | null,
          routeKey: arg.routeKey,
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.hooks.on': {
        const { event, listenerId } = msg.args[0] as { event: string; listenerId: string }
        entry.hookListeners.push({ pluginId: msg.pluginId, listenerId })
        // The hookBus listener is a thin shim that round-trips back to the worker.
        hookBus.on(msg.pluginId, event, async (payload: unknown) => {
          await runHookListenerInWorker(msg.pluginId, listenerId, event, payload)
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.hooks.filter': {
        const { name, filterId } = msg.args[0] as { name: string; filterId: string }
        entry.hookFilters.push({ pluginId: msg.pluginId, filterId })
        hookBus.filter(msg.pluginId, name, async (value: unknown) => {
          return await runHookFilterInWorker(msg.pluginId, filterId, name, value)
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.hooks.emit': {
        const { event, payload } = msg.args[0] as { event: string; payload: unknown }
        await hookBus.emit(event, payload)
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.loops.registerSource': {
        const descriptor = msg.args[0] as Omit<LoopEntitySource, 'fetch' | 'preview'>
        if (!descriptor.id?.startsWith(`${msg.pluginId}.`)) {
          throw new Error(
            `Loop source id "${descriptor.id}" must start with the plugin id "${msg.pluginId}.".`,
          )
        }
        const fullSource: LoopEntitySource = {
          ...descriptor,
          fetch: async (ctx) => {
            return await runLoopFetchInWorker(msg.pluginId, descriptor.id, ctx)
          },
          preview: () => {
            // preview() is synchronous in the contract — we can't await the
            // worker. Returning [] is fine: the editor uses the publisher's
            // fetch path for live preview now (see useLoopPreviewItems),
            // and any plugin that ships a synchronous preview-only path
            // can be added later via a worker-backed sync invariant.
            return []
          },
        }
        entry.loopSources.push({ pluginId: msg.pluginId, sourceId: descriptor.id })
        loopSourceRegistry.registerOrReplace(fullSource)
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.storage.list': {
        const [resourceId] = msg.args as [string]
        const records = await listPluginRecords(db, msg.pluginId, resourceId)
        replyApiOk(msg.pluginId, msg.correlationId, records as unknown)
        return
      }

      case 'cms.storage.create': {
        const [resourceId, data] = msg.args as [string, Record<string, unknown>]
        const resource = findPluginResource(entry.manifest, resourceId)
        const cleanedData = resource ? validatePluginRecordData(resource, data) : data
        const created: PluginRecord = await createPluginRecord(db, {
          id: nanoid(),
          pluginId: msg.pluginId,
          resourceId,
          data: cleanedData,
        })
        replyApiOk(msg.pluginId, msg.correlationId, created as unknown)
        return
      }

      case 'cms.storage.update': {
        const [resourceId, recordId, data] = msg.args as [string, string, Record<string, unknown>]
        const resource = findPluginResource(entry.manifest, resourceId)
        const cleanedData = resource ? validatePluginRecordData(resource, data) : data
        const updated = await updatePluginRecord(db, {
          id: recordId,
          pluginId: msg.pluginId,
          resourceId,
          data: cleanedData,
        })
        replyApiOk(msg.pluginId, msg.correlationId, updated as unknown)
        return
      }

      case 'cms.storage.delete': {
        const [resourceId, recordId] = msg.args as [string, string]
        const ok = await deletePluginRecord(db, {
          id: recordId,
          pluginId: msg.pluginId,
          resourceId,
        })
        replyApiOk(msg.pluginId, msg.correlationId, ok as unknown)
        return
      }

      case 'cms.settings.replace': {
        const [next] = msg.args as [Record<string, unknown>]
        const declared = (entry.manifest.settings ?? []) as PluginSettingDefinition[]
        const cleaned = validatePluginSettingsRecord(declared, next)
        await setPluginSettings(db, msg.pluginId, cleaned)
        // Refresh worker-side cache via the existing settings route — actually
        // the worker's local cache is updated from the api reply value.
        await hookBus.emit('settings.changed', {
          pluginId: msg.pluginId,
          settings: cleaned,
        } as unknown as Record<string, unknown>)
        replyApiOk(msg.pluginId, msg.correlationId, cleaned as unknown)
        return
      }
    }
  } catch (err) {
    replyApiError(msg.pluginId, msg.correlationId, err instanceof Error ? err.message : String(err))
  }
}

function replyApiOk(pluginId: string, correlationId: string, value?: unknown): void {
  // Reply must go to the same worker that issued the api-call. With per-plugin
  // workers we pick by pluginId; if that worker has been terminated (e.g. a
  // crash race during the round-trip) we silently drop — the worker is gone
  // and there's nobody to receive the reply.
  const w = workers.get(pluginId)
  if (!w) return
  w.postMessage({ kind: 'api-reply', correlationId, ok: true, value })
}

function replyApiError(pluginId: string, correlationId: string, message: string): void {
  const w = workers.get(pluginId)
  if (!w) return
  w.postMessage({ kind: 'api-reply', correlationId, ok: false, error: message })
}

async function runHookListenerInWorker(
  pluginId: string,
  listenerId: string,
  event: string,
  payload: unknown,
): Promise<void> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-hook-listener', correlationId: nanoid(), pluginId, listenerId, event, payload },
    'hook-listener-result',
  )
  if (!result.ok) {
    console.error(
      `[plugin:${pluginId}] hook listener for "${event}" threw:`,
      result.error,
    )
  }
}

async function runHookFilterInWorker(
  pluginId: string,
  filterId: string,
  name: string,
  value: unknown,
): Promise<unknown> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-hook-filter', correlationId: nanoid(), pluginId, filterId, name, value },
    'hook-filter-result',
  )
  if (!result.ok) {
    console.error(`[plugin:${pluginId}] hook filter "${name}" threw:`, result.error)
    return value
  }
  return result.value
}

async function runLoopFetchInWorker(
  pluginId: string,
  sourceId: string,
  ctx: unknown,
): Promise<LoopFetchResult> {
  const result = await requestFromWorker(
    pluginId,
    { kind: 'run-loop-fetch', correlationId: nanoid(), pluginId, sourceId, ctx },
    'loop-fetch-result',
  )
  if (!result.ok || !result.value) {
    console.error(
      `[plugin:${pluginId}] loop source "${sourceId}" fetch failed:`,
      result.error,
    )
    return { items: [], totalItems: 0 }
  }
  // Cast: items shape is unknown over the wire; the publisher revalidates.
  // LoopItem is a structural { id: string, ... } shape.
  return {
    items: result.value.items as LoopItem[],
    totalItems: result.value.totalItems,
  }
}

/**
 * Lookup helper used by the existing plugin-runtime route table — given a
 * plugin id and request method/path, return whether that plugin has a
 * registered route, and which capability gates it.
 */
export function findPluginRouteCapability(
  pluginId: string,
  method: string,
  path: string,
): { capability: CoreCapability | null } | null {
  return getRegisteredRoute(pluginId, method, path)
}

/**
 * Test-only / diagnostics: list current host-side bookkeeping. Useful for
 * checking that registrations land where expected, and for asserting
 * worker isolation invariants in tests (e.g. crash of one plugin's worker
 * does not affect a sibling plugin's worker).
 */
export function inspectPluginWorkerState(): {
  loaded: string[]
  workers: string[]
  routes: { pluginId: string; method: string; path: string }[]
} {
  const loaded = [...hostPlugins.keys()]
  const workersOut = [...workers.keys()]
  const routes: { pluginId: string; method: string; path: string }[] = []
  for (const [pluginId, entry] of hostPlugins) {
    for (const route of entry.routes.values()) {
      routes.push({ pluginId, method: route.method, path: route.path })
    }
  }
  return { loaded, workers: workersOut, routes }
}

// Re-export the permission union so external callers can pass it.
export type { PluginPermission }
