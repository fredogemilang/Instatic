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
  MediaAssetRole,
  MediaStorageAdapter,
  MediaStorageBeginWriteInput,
  MediaStorageFinalizeWriteInput,
  MediaStorageServingMode,
  MediaStorageUploadPlan,
  MediaStorageVerifyResult,
  MediaStorageWriteResult,
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
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { mediaVariantDelegateRegistry } from '@core/plugins/mediaVariantDelegateRegistry'
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
  LoadPluginResult,
  MainToWorkerMessage,
  SerializedRequest,
  SerializedResponse,
  SerializedUser,
  ValidatedApiCall,
  WorkerToMainMessage,
} from './workerProtocol'
import { parseApiCall } from './workerProtocol'
import { registerPluginSchedule } from './pluginScheduleRegistration'

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

interface HostMediaAdapterEntry {
  pluginId: string
  adapterId: string
}

interface HostMediaTransformerEntry {
  pluginId: string
  transformerId: string
}

interface HostPluginRecord {
  manifest: PluginManifest
  routes: Map<string, HostRouteEntry>
  hookListeners: HostHookListenerEntry[]
  hookFilters: HostHookFilterEntry[]
  loopSources: HostLoopSourceEntry[]
  /** Media storage adapter ids registered by this plugin. */
  mediaAdapters: HostMediaAdapterEntry[]
  /** Media URL transformer registrations — actually live as hookBus filters. */
  mediaUrlTransformers: HostMediaTransformerEntry[]
  /**
   * In-flight outbound fetches keyed by the plugin's `abortId`. Populated
   * by `performGatedFetch` (which registers a fresh AbortController before
   * issuing the upstream `fetch`) and dropped in its `finally` block.
   * `network.abort` dispatch looks up the controller here and aborts it,
   * tearing down the underlying socket / response stream instead of
   * waiting for natural completion.
   */
  inflightFetches: Map<string, AbortController>
}

const hostPlugins = new Map<string, HostPluginRecord>()

function hasGrantedPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): boolean {
  return new Set(manifest.grantedPermissions ?? []).has(permission)
}

function assertHostPluginPermission(
  entry: HostPluginRecord,
  permission: PluginPermission,
): void {
  if (!hasGrantedPermission(entry.manifest, permission)) {
    throw new Error(`Plugin "${entry.manifest.id}" requires permission "${permission}"`)
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers — wire format for binary payloads on the crypto bridge.
// JSON can't carry Uint8Array; base64 is the smallest portable encoding.
// Bun ships native btoa / atob (WHATWG-spec), which are byte-oriented
// despite the "binary string" misnomer — exactly what we want here.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked so we don't blow the call stack on multi-MB inputs (the
  // String.fromCharCode spread variant fails on large arrays).
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/**
 * Decode base64 directly into a fresh, tightly-sized `ArrayBuffer`. The
 * Web Crypto `crypto.subtle` API requires `BufferSource` with an
 * `ArrayBuffer` (not `SharedArrayBuffer`); `Uint8Array.buffer` is typed
 * as `ArrayBufferLike` which TS narrows out. A fresh allocation removes
 * the narrowing problem and guarantees no sibling view past byteLength.
 */
function base64ToFreshArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
  return buffer
}

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
    handleWorkerMessage(pluginId, event.data)
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
    // Abort every in-flight outbound fetch. The worker that requested them
    // is dead, so completing the response would just drop bytes on the
    // floor and tie up sockets/memory. Cancelling now releases them.
    for (const ctrl of entry.inflightFetches.values()) {
      try { ctrl.abort(new Error(`Plugin "${pluginId}" worker crashed`)) } catch { /* ignore */ }
    }
    entry.inflightFetches.clear()
    hookBus.unregisterPlugin(pluginId)
    mediaStorageRegistry.unregisterPlugin(pluginId)
    mediaVariantDelegateRegistry.unregisterPlugin(pluginId)
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

function workerMessageKind(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' ? kind : null
}

function workerMessageCorrelationId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const correlationId = (value as { correlationId?: unknown }).correlationId
  return typeof correlationId === 'string' && correlationId ? correlationId : null
}

function workerLogArgs(value: unknown): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const args = (value as { args?: unknown }).args
  return Array.isArray(args) ? args : []
}

function rejectInvalidApiCall(workerPluginId: string, msg: unknown, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[plugin:${workerPluginId}] invalid api-call:`, err)

  const correlationId = workerMessageCorrelationId(msg)
  if (!correlationId) return
  replyApiError(workerPluginId, correlationId, message)
}

function handleWorkerMessage(workerPluginId: string, msg: unknown): void {
  switch (workerMessageKind(msg)) {
    case 'log':
      // Defense-in-depth: a worker can't impersonate another plugin's id in
      // its log line. The log prefix is the worker's owning pluginId.
      console.info(`[plugin:${workerPluginId}]`, ...workerLogArgs(msg))
      return
    case 'api-call': {
      let apiCall: ValidatedApiCall
      try {
        apiCall = parseApiCall(msg)
      } catch (err) {
        rejectInvalidApiCall(workerPluginId, msg, err)
        return
      }
      // Defense-in-depth: an api-call must reference the worker's own
      // pluginId. Cross-plugin dispatch attempts get rejected before any
      // host-side side effect.
      if (apiCall.pluginId !== workerPluginId) {
        replyApiError(
          workerPluginId,
          apiCall.correlationId,
          `api-call from worker "${workerPluginId}" references foreign pluginId "${apiCall.pluginId}"`,
        )
        return
      }
      void dispatchApiCall(apiCall)
      return
    }
    default: {
      const correlationId = workerMessageCorrelationId(msg)
      if (!correlationId) return
      const pending = pendingRequests.get(correlationId)
      if (!pending) return
      pendingRequests.delete(correlationId)
      pending.resolve(msg as WorkerToMainMessage)
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
    mediaStorageRegistry.unregisterPlugin(args.manifest.id)
    mediaVariantDelegateRegistry.unregisterPlugin(args.manifest.id)
  }
  hostPlugins.set(args.manifest.id, {
    manifest: args.manifest,
    routes: new Map(),
    hookListeners: [],
    hookFilters: [],
    loopSources: [],
    mediaAdapters: [],
    mediaUrlTransformers: [],
    inflightFetches: new Map(),
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
    // Mirror the crash path: abort any in-flight outbound fetches before
    // tearing down the host record, so naked sockets don't outlive the
    // plugin record they belonged to.
    for (const ctrl of entry.inflightFetches.values()) {
      try { ctrl.abort(new Error(`Plugin "${pluginId}" unloaded`)) } catch { /* ignore */ }
    }
    entry.inflightFetches.clear()
    hookBus.unregisterPlugin(pluginId)
    mediaStorageRegistry.unregisterPlugin(pluginId)
    mediaVariantDelegateRegistry.unregisterPlugin(pluginId)
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

function getRegisteredRoute(
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

async function dispatchApiCall(msg: ValidatedApiCall): Promise<void> {
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
        assertHostPluginPermission(entry, 'cms.routes')
        const [arg] = msg.args
        if (arg.capability !== null && !isCoreCapability(arg.capability)) {
          throw new Error(`Unknown plugin route capability: ${arg.capability}`)
        }
        entry.routes.set(arg.routeKey, {
          pluginId: msg.pluginId,
          method: arg.method,
          path: arg.path,
          capability: arg.capability,
          routeKey: arg.routeKey,
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.hooks.on': {
        assertHostPluginPermission(entry, 'cms.hooks')
        const [{ event, listenerId }] = msg.args
        entry.hookListeners.push({ pluginId: msg.pluginId, listenerId })
        // The hookBus listener is a thin shim that round-trips back to the worker.
        hookBus.on(msg.pluginId, event, async (payload: unknown) => {
          await runHookListenerInWorker(msg.pluginId, listenerId, event, payload)
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.hooks.filter': {
        assertHostPluginPermission(entry, 'cms.hooks')
        const [{ name, filterId }] = msg.args
        entry.hookFilters.push({ pluginId: msg.pluginId, filterId })
        hookBus.filter(msg.pluginId, name, async (value: unknown) => {
          return await runHookFilterInWorker(msg.pluginId, filterId, name, value)
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.hooks.emit': {
        assertHostPluginPermission(entry, 'cms.hooks')
        const [{ event, payload }] = msg.args
        await hookBus.emit(event, payload)
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.loops.registerSource': {
        assertHostPluginPermission(entry, 'loops.register')
        const [descriptor] = msg.args
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
        assertHostPluginPermission(entry, 'cms.storage')
        const [resourceId] = msg.args
        const records = await listPluginRecords(db, msg.pluginId, resourceId)
        replyApiOk(msg.pluginId, msg.correlationId, records as unknown)
        return
      }

      case 'cms.storage.create': {
        assertHostPluginPermission(entry, 'cms.storage')
        const [resourceId, data] = msg.args
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
        assertHostPluginPermission(entry, 'cms.storage')
        const [resourceId, recordId, data] = msg.args
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
        assertHostPluginPermission(entry, 'cms.storage')
        const [resourceId, recordId] = msg.args
        const ok = await deletePluginRecord(db, {
          id: recordId,
          pluginId: msg.pluginId,
          resourceId,
        })
        replyApiOk(msg.pluginId, msg.correlationId, ok as unknown)
        return
      }

      case 'cms.settings.replace': {
        const [next] = msg.args
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

      case 'network.fetch': {
        assertHostPluginPermission(entry, 'network.outbound')
        const [urlString, init] = msg.args
        const result = await performGatedFetch(entry, urlString, init)
        replyApiOk(msg.pluginId, msg.correlationId, result as unknown)
        return
      }

      case 'network.abort': {
        // Intentionally NOT permission-gated. A plugin without
        // `network.outbound` can never have registered a live abortId in
        // the first place, so the lookup just no-ops. Treat this target
        // as a cheap correlation-id cancel.
        const [{ abortId }] = msg.args
        const controller = entry.inflightFetches.get(abortId)
        if (controller) {
          try {
            const err = new Error('AbortError')
            err.name = 'AbortError'
            controller.abort(err)
          } catch { /* ignore */ }
          entry.inflightFetches.delete(abortId)
        }
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.schedule.register': {
        assertHostPluginPermission(entry, 'cms.schedule')
        const [arg] = msg.args
        // The pluginScheduleRegistration module owns the DB upsert +
        // next_run_at calc. Routing through it (rather than inlining SQL
        // here) keeps all cadence math in one place so registration and
        // tick share identical interpretation.
        await registerPluginSchedule(db, {
          pluginId: msg.pluginId,
          scheduleId: arg.scheduleId,
          cadence: arg.cadence,
          overlap: arg.overlap,
          maxDurationMs: arg.maxDurationMs,
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.schedule.cancel': {
        assertHostPluginPermission(entry, 'cms.schedule')
        const [{ scheduleId }] = msg.args
        const { disablePluginSchedule } = await import('../repositories/pluginSchedules')
        await disablePluginSchedule(db, msg.pluginId, scheduleId)
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.media.registerStorageAdapter': {
        assertHostPluginPermission(entry, 'media.storage.adapter')
        const [arg] = msg.args
        // Schema-validated, so the cast is for the union narrowing the
        // SDK exposes. servingMode + roles are already validated as the
        // expected literal sets.
        const adapter = buildAdapterShim({
          pluginId: msg.pluginId,
          adapterId: arg.adapterId,
          label: arg.label,
          roles: arg.roles as ReadonlyArray<MediaAssetRole>,
          servingMode: arg.servingMode as MediaStorageServingMode,
          hasGetReadUrl: arg.hasGetReadUrl,
          hasReadStream: arg.hasReadStream,
          ...(arg.cspOrigins ? { cspOrigins: arg.cspOrigins } : {}),
        })
        // Registry.register throws on a reserved id (e.g. ''); let it bubble
        // so the plugin sees a real exception instead of a silent failure.
        // The outer try/catch turns it into a structured api-call error.
        mediaStorageRegistry.register(adapter)
        entry.mediaAdapters.push({ pluginId: msg.pluginId, adapterId: arg.adapterId })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'cms.media.registerUrlTransformer': {
        assertHostPluginPermission(entry, 'media.url.transform')
        const [{ transformerId }] = msg.args
        entry.mediaUrlTransformers.push({ pluginId: msg.pluginId, transformerId })
        // URL transformers ride the existing hook bus filter pipeline so
        // chaining + error-fallback semantics match every other plugin
        // filter. The filter input is `{ path, ctx }` and the host applies
        // it via `hookBus.applyFilter('media.url.transform', ...)` at the
        // render boundary (Phase C wires the boundary).
        hookBus.filter(msg.pluginId, 'media.url.transform', async (value) => {
          const payload = value as { path: string; ctx: unknown }
          const rewritten = await runMediaUrlTransformerInWorker(
            msg.pluginId,
            transformerId,
            payload,
          )
          // null = "no rewrite" — chain through. String = the new path.
          if (typeof rewritten === 'string') {
            return { ...payload, path: rewritten }
          }
          return value
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }

      case 'crypto.digest': {
        // Pure computation — no permission gate (same model as Math /
        // JSON exposure). Inputs are size-bounded by the schema.
        const [{ algorithm, data }] = msg.args
        const dataBytes = base64ToFreshArrayBuffer(data)
        const digest = await crypto.subtle.digest(algorithm, dataBytes)
        replyApiOk(msg.pluginId, msg.correlationId, bytesToBase64(new Uint8Array(digest)))
        return
      }

      case 'crypto.signHmac': {
        const [{ hash, key, data }] = msg.args
        const keyBuffer = base64ToFreshArrayBuffer(key)
        const dataBuffer = base64ToFreshArrayBuffer(data)
        const importedKey = await crypto.subtle.importKey(
          'raw',
          keyBuffer,
          { name: 'HMAC', hash },
          false,
          ['sign'],
        )
        const signature = await crypto.subtle.sign({ name: 'HMAC' }, importedKey, dataBuffer)
        replyApiOk(msg.pluginId, msg.correlationId, bytesToBase64(new Uint8Array(signature)))
        return
      }

      case 'cms.media.registerVariantDelegate': {
        assertHostPluginPermission(entry, 'media.variant.delegate')
        const [arg] = msg.args
        // Persist in the in-memory registry so the admin UI's
        // "Pick a delegate" picker sees it. Election (which delegate
        // actually wins) lives in `active_media_variant_delegate` and
        // is managed by the admin API in `server/handlers/cms/mediaStorageAdmin.ts`.
        mediaVariantDelegateRegistry.register({
          id: arg.delegateId,
          pluginId: msg.pluginId,
          variantUrlTemplate: arg.variantUrlTemplate,
          widths: arg.widths,
          formats: arg.formats,
        })
        replyApiOk(msg.pluginId, msg.correlationId)
        return
      }
    }
  } catch (err) {
    replyApiError(msg.pluginId, msg.correlationId, err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Gated outbound fetch — kernel-of-correctness for the `network.outbound`
// permission.
//
// Two checks happen here:
//  1. The plugin must have `network.outbound` granted (already enforced by
//     the case above via `assertHostPluginPermission`).
//  2. The URL's host must match an entry in `manifest.networkAllowedHosts`
//     (or a `*.<domain>` wildcard from that list). If `networkAllowedHosts`
//     is empty or missing, ALL outbound is denied — fail-closed.
//
// Returns a JSON-serializable response shape the VM-side `fetch` shim
// reconstructs into a Response-like object.
// ---------------------------------------------------------------------------

interface SerializedNetworkResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
}

function hostMatchesAllowlist(host: string, allowlist: ReadonlyArray<string>): boolean {
  const lower = host.toLowerCase()
  for (const entry of allowlist) {
    const e = entry.toLowerCase()
    if (e.startsWith('*.')) {
      const suffix = e.slice(2)
      const dotSuffix = `.${suffix}`
      // Wildcard `*.foo.com` matches `bar.foo.com` but NOT `foo.com` and NOT `a.bar.foo.com`.
      if (lower.endsWith(dotSuffix)) {
        const head = lower.slice(0, lower.length - dotSuffix.length)
        if (head.length > 0 && !head.includes('.')) return true
      }
      continue
    }
    if (lower === e) return true
  }
  return false
}

async function performGatedFetch(
  entry: HostPluginRecord,
  urlString: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; abortId?: string },
): Promise<SerializedNetworkResponse> {
  const manifest = entry.manifest
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error(`Invalid URL: "${urlString}"`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Plugin network.fetch only supports http: and https: URLs (got "${parsed.protocol}")`)
  }
  const allowlist = manifest.networkAllowedHosts ?? []
  if (!hostMatchesAllowlist(parsed.host, allowlist)) {
    throw new Error(
      `Plugin "${manifest.id}" requested fetch to "${parsed.host}", which is not in the manifest's networkAllowedHosts allowlist.`,
    )
  }
  // Per-call AbortController so the plugin's VM-side signal can short-
  // circuit the actual upstream request, not just the in-VM wait. If the
  // plugin didn't supply an abortId, we still allocate a controller so
  // crash/unload teardown can cancel it; we just don't register it for
  // lookup since no `network.abort` can ever target it.
  const controller = new AbortController()
  const abortId = init.abortId
  if (abortId) entry.inflightFetches.set(abortId, controller)
  try {
    const response = await fetch(urlString, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      signal: controller.signal,
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((v, k) => { headers[k] = v })
    const body = await response.text()
    return {
      status: response.status,
      ok: response.ok,
      headers,
      body,
    }
  } finally {
    if (abortId) entry.inflightFetches.delete(abortId)
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
 * Fire a registered schedule handler in the plugin's worker. Returns the
 * status + measured duration. The scheduler tick records the outcome to
 * `plugin_schedules` + `plugin_schedule_runs`. If the worker isn't running
 * or has been terminated, the call rejects with the underlying error;
 * the scheduler converts that into a 'error' status row.
 */
export async function runScheduleInWorker(args: {
  pluginId: string
  scheduleId: string
  maxDurationMs: number
}): Promise<{ status: 'ok' | 'error' | 'timeout'; error?: string; durationMs: number }> {
  const result = await requestFromWorker(
    args.pluginId,
    {
      kind: 'run-schedule',
      correlationId: nanoid(),
      pluginId: args.pluginId,
      scheduleId: args.scheduleId,
      maxDurationMs: args.maxDurationMs,
    },
    'schedule-result',
  )
  return {
    status: result.status,
    error: result.error,
    durationMs: result.durationMs,
  }
}

// ---------------------------------------------------------------------------
// Media subsystem — worker round-trips
//
// Bytes NEVER cross the QuickJS sandbox boundary. The adapter signs upload
// plans here (single round-trip per stage); the host streams bytes itself
// via `executeUploadPlan` in `server/handlers/cms/mediaUploadExecutor.ts`.
// `runMediaAdapterCallInWorker` is a generic dispatcher — every adapter
// method routes through this one helper, mirroring how routes / hook
// listeners / hook filters use a single shared worker call.
// ---------------------------------------------------------------------------

async function runMediaAdapterCallInWorker(
  pluginId: string,
  adapterId: string,
  method: 'beginWrite' | 'finalizeWrite' | 'abortWrite' | 'delete' | 'getReadUrl' | 'verify',
  args: unknown[],
): Promise<unknown> {
  const result = await requestFromWorker(
    pluginId,
    {
      kind: 'run-media-adapter-call',
      correlationId: nanoid(),
      pluginId,
      adapterId,
      method,
      args,
    },
    'media-adapter-call-result',
  )
  if (!result.ok) {
    throw new Error(result.error ?? `Plugin "${pluginId}" media adapter "${adapterId}.${method}" failed`)
  }
  return result.value
}

async function runMediaUrlTransformerInWorker(
  pluginId: string,
  transformerId: string,
  payload: unknown,
): Promise<string | null> {
  const result = await requestFromWorker(
    pluginId,
    {
      kind: 'run-media-url-transformer',
      correlationId: nanoid(),
      pluginId,
      transformerId,
      payload,
    },
    'media-url-transformer-result',
  )
  if (!result.ok) {
    console.error(`[plugin:${pluginId}] media URL transformer threw:`, result.error)
    return null
  }
  return typeof result.value === 'string' ? result.value : null
}

/**
 * Build a host-side `MediaStorageAdapter` shim that proxies every method
 * to the plugin's VM. The adapter's *contract* (servingMode, roles,
 * cspOrigins, hasGetReadUrl, hasReadStream) is metadata declared at
 * registration time; the actual logic lives inside the QuickJS sandbox
 * and round-trips here for each invocation.
 */
function buildAdapterShim(args: {
  pluginId: string
  adapterId: string
  label: string
  roles: ReadonlyArray<MediaAssetRole>
  servingMode: MediaStorageServingMode
  hasGetReadUrl: boolean
  hasReadStream: boolean
  cspOrigins?: ReadonlyArray<{ directive: 'img-src' | 'media-src' | 'connect-src'; origin: string }>
}): MediaStorageAdapter {
  const call = (
    method: 'beginWrite' | 'finalizeWrite' | 'abortWrite' | 'delete' | 'getReadUrl' | 'verify',
    methodArgs: unknown[],
  ): Promise<unknown> => runMediaAdapterCallInWorker(args.pluginId, args.adapterId, method, methodArgs)
  const shim: MediaStorageAdapter = {
    id: args.adapterId,
    label: args.label,
    roles: args.roles,
    servingMode: args.servingMode,
    beginWrite: async (input: MediaStorageBeginWriteInput): Promise<MediaStorageUploadPlan> => {
      const v = await call('beginWrite', [input])
      return v as MediaStorageUploadPlan
    },
    finalizeWrite: async (input: MediaStorageFinalizeWriteInput): Promise<MediaStorageWriteResult> => {
      const v = await call('finalizeWrite', [input])
      return v as MediaStorageWriteResult
    },
    abortWrite: async (input) => {
      await call('abortWrite', [input])
    },
    delete: async (storagePath: string) => {
      await call('delete', [storagePath])
    },
    verify: async (): Promise<MediaStorageVerifyResult> => {
      const v = await call('verify', [])
      // Defensive: plugin verify() that throws or returns garbage gets
      // converted to a structured failure here so the admin UI doesn't
      // crash on an unexpected shape.
      if (v && typeof v === 'object' && typeof (v as { ok?: unknown }).ok === 'boolean') {
        return v as MediaStorageVerifyResult
      }
      return { ok: false, reason: 'Adapter returned a malformed verify() result.' }
    },
    ...(args.cspOrigins && args.cspOrigins.length > 0 ? { cspOrigins: args.cspOrigins } : {}),
  }
  if (args.hasGetReadUrl) {
    shim.getReadUrl = async (storagePath: string, ttlSeconds: number) => {
      const v = await call('getReadUrl', [storagePath, ttlSeconds])
      if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
        const obj = v as { url: string; expiresAt?: number }
        return {
          url: obj.url,
          expiresAt: typeof obj.expiresAt === 'number' ? obj.expiresAt : Date.now() + ttlSeconds * 1000,
        }
      }
      throw new Error(`Plugin "${args.pluginId}" adapter "${args.adapterId}" returned malformed getReadUrl result`)
    }
  }
  // readStream support for proxy adapters is intentionally not wired in
  // Phase B — proxy-mode adapters land with the host streaming bytes
  // through a separate API (and the QuickJS bridge needs a chunked
  // protocol). Public-URL and signed-redirect adapters are the v1 target.
  return shim
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

