/**
 * Eval helpers — drive a VM expression to a fully-resolved value.
 *
 * Polling pattern (no asyncify):
 *   1. evalCode runs the synchronous portion of the expression
 *   2. If the result is a Promise (e.g. from `async function` call),
 *      we poll its state via getPromiseState
 *   3. Between polls: executePendingJobs() advances VM microtasks
 *   4. If no jobs ran and the Promise is still pending, yield to the host
 *      event loop so __hostCall's host-side .then can fire deferred.resolve
 *   5. Once fulfilled/rejected, return the value or throw the error
 *
 * The deadline guard (`withDeadline`) installs a wall-clock interrupt on
 * the runtime for the duration of one eval call — a plugin stuck in a
 * tight loop is aborted within the deadline.
 */

import { shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten'
import { DEFAULT_EVAL_TIMEOUT_MS } from './limits'

function withDeadline<T>(ctx: QuickJSContext, timeoutMs: number, body: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  ctx.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline))
  return body().finally(() => {
    try { ctx.runtime.removeInterruptHandler() } catch { /* runtime may already be disposed */ }
  })
}

function evalResolved<T>(
  ctx: QuickJSContext,
  code: string,
  read: (handle: QuickJSHandle) => T,
  timeoutMs: number = DEFAULT_EVAL_TIMEOUT_MS,
): Promise<T> {
  // Run inside a wall-clock deadline — runaway plugin code is aborted
  // with a QuickJS `InternalError: interrupted` rather than blocking
  // the worker forever. Callers can override the default (5s) for cases
  // like scheduled jobs that declare a higher `maxDurationMs`.
  return withDeadline(ctx, timeoutMs, () => evalResolvedInner(ctx, code, read))
}

async function evalResolvedInner<T>(
  ctx: QuickJSContext,
  code: string,
  read: (handle: QuickJSHandle) => T,
): Promise<T> {
  const evalResult = ctx.evalCode(code, 'pagebuilder-eval.js')
  const evalHandle = ctx.unwrapResult(evalResult)

  // Drain any microtasks scheduled by the eval's synchronous portion.
  drainJobs(ctx)

  // Probe Promise state. For non-promises, `getPromiseState` returns a
  // fulfilled state with `notAPromise: true` and `value` set to the
  // original handle (no new ownership transfer).
  const initialState = ctx.getPromiseState(evalHandle)
  if (initialState.type === 'fulfilled' && initialState.notAPromise) {
    try {
      return read(evalHandle)
    } finally {
      evalHandle.dispose()
    }
  }

  // It IS a Promise — pump VM jobs + host event loop until it settles.
  const MAX_BATCHES = 10_000
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const state = ctx.getPromiseState(evalHandle)
    if (state.type === 'fulfilled') {
      const valueHandle = state.value
      evalHandle.dispose()
      try {
        return read(valueHandle)
      } finally {
        valueHandle.dispose()
      }
    }
    if (state.type === 'rejected') {
      const errorHandle = state.error
      const errorValue = ctx.dump(errorHandle) as { message?: string; stack?: string } | string | undefined
      evalHandle.dispose()
      // Surface the plugin's own error message verbatim — the host's
      // logging (`[plugin:<id>]`) provides the context, so a "Plugin VM
      // threw: " prefix would just be redundant noise.
      const message = typeof errorValue === 'object' && errorValue && errorValue.message
        ? errorValue.message
        : typeof errorValue === 'string'
          ? errorValue
          : 'VM promise rejected with unknown error'
      throw new Error(message)
    }
    // Still pending. Drain VM microtasks, then yield to host event loop
    // so any pending __hostCall host-side resolution can fire.
    const ranJobs = drainJobs(ctx)
    if (ranJobs === 0) {
      await new Promise<void>((res) => setTimeout(res, 0))
    }
  }
  evalHandle.dispose()
  throw new Error(`VM promise did not settle within ${MAX_BATCHES} batches`)
}

/**
 * Drain QuickJS's pending-job queue. The result is a `DisposableResult` —
 * either success (`.value` is the count of jobs that ran) or failure
 * (`.value` is the error handle). We treat any error as 0 jobs ran and
 * just dispose the error; uncaught microtask errors inside the VM usually
 * mean a plugin bug that the calling eval's reject path will surface
 * cleanly.
 */
function drainJobs(ctx: QuickJSContext): number {
  const result = ctx.runtime.executePendingJobs()
  if ('error' in result && result.error) {
    try { result.error.dispose() } catch { /* ignore */ }
    return 0
  }
  if ('value' in result && typeof result.value === 'number') {
    return result.value
  }
  return 0
}

export function evalVoid(ctx: QuickJSContext, code: string, timeoutMs?: number): Promise<void> {
  return evalResolved(ctx, code, () => undefined, timeoutMs)
}

export function evalString(ctx: QuickJSContext, code: string): Promise<string> {
  return evalResolved(ctx, code, (h) => ctx.getString(h))
}

export async function evalJson<T>(ctx: QuickJSContext, code: string): Promise<T> {
  const raw = await evalString(ctx, `JSON.stringify((${code}))`)
  return JSON.parse(raw) as T
}
