/**
 * Worker pool — per-plugin Bun.Worker lifecycle and bidirectional RPC.
 *
 * One Bun.Worker is spawned per plugin id (see `ensureWorkerFor`). This
 * gives true blast-radius isolation: an uncaught error in plugin A's
 * lifecycle / route handler / hook only kills plugin A's worker; sibling
 * plugins keep running. The next call to `loadPluginInWorker(A,...)` in
 * rpc.ts respawns A's worker.
 *
 * Correlation ids (nanoid strings) tie each outbound request message to its
 * inbound result. `pendingRequests` is the shared map; it is exported so
 * `crashRecovery.ts` can reject all pending requests for a crashed plugin.
 */

import type { MainToWorkerMessage, WorkerToMainMessage } from '../protocol/messages'
import { parseApiCall } from '../protocol/parser'
import type { ValidatedApiCall } from '../protocol/apiCallSchema'
import type { PendingRequest } from './types'
import { handleWorkerCrash } from './crashRecovery'
import { dispatchApiCall } from './apiDispatch'

export const workers = new Map<string, Worker>()
/** Shared correlation map — values track which pluginId issued the request
 *  so a worker crash can reject only that plugin's pending calls. */
export const pendingRequests = new Map<string, PendingRequest>()

/**
 * Get the worker for a pluginId, spawning one if needed. Each spawn wires
 * its own message + error listeners so a crash in this worker only affects
 * pendings + state for THIS plugin id.
 */
export function ensureWorkerFor(pluginId: string): Worker {
  const existing = workers.get(pluginId)
  if (existing) return existing
  const w = new Worker(new URL('../pluginWorker.ts', import.meta.url).href)
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

export function sendTo(pluginId: string, msg: MainToWorkerMessage): void {
  ensureWorkerFor(pluginId).postMessage(msg)
}

export function requestFromWorker<TKind extends WorkerToMainMessage['kind']>(
  pluginId: string,
  msg: MainToWorkerMessage,
  expectedKind: TKind,
): Promise<Extract<WorkerToMainMessage, { kind: TKind }>> {
  return new Promise<Extract<WorkerToMainMessage, { kind: TKind }>>((resolve, reject) => {
    pendingRequests.set(msg.correlationId, {
      pluginId,
      resolve: (value) => {
        const v = value as WorkerToMainMessage
        if (v.kind !== expectedKind) {
          reject(new Error(`Plugin worker returned unexpected message kind "${v.kind}"`))
          return
        }
        resolve(v as Extract<WorkerToMainMessage, { kind: TKind }>)
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

export function handleWorkerMessage(workerPluginId: string, msg: unknown): void {
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

export function replyApiOk(pluginId: string, correlationId: string, value?: unknown): void {
  // Reply must go to the same worker that issued the api-call. With per-plugin
  // workers we pick by pluginId; if that worker has been terminated (e.g. a
  // crash race during the round-trip) we silently drop — the worker is gone
  // and there's nobody to receive the reply.
  const w = workers.get(pluginId)
  if (!w) return
  w.postMessage({ kind: 'api-reply', correlationId, ok: true, value })
}

export function replyApiError(pluginId: string, correlationId: string, message: string): void {
  const w = workers.get(pluginId)
  if (!w) return
  w.postMessage({ kind: 'api-reply', correlationId, ok: false, error: message })
}

/**
 * Fully tear down host-side state. Called by `activateInstalledServerPlugins`
 * before re-binding plugins (e.g. on server boot or after a settings change
 * that requires a clean re-load).
 */
export async function resetPluginWorker(): Promise<void> {
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
