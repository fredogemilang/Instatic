/**
 * QuickJS-WASM host bridge — runs plugin code inside a WebAssembly-isolated
 * VM with no access to Bun / Node ambient APIs. The plugin can only call
 * back through the host-imported `__hostCall(target, args)` function, which
 * routes to the existing api-call dispatch in `pluginWorkerHost.ts`.
 *
 * Sandbox topology:
 *   ┌─ Bun host (main process)
 *   │  ┌─ Bun.Worker (crash isolation, CPU yield)
 *   │  │  ┌─ QuickJS-WASM context (security sandbox — THIS file)
 *   │  │  │  ┌─ Bootstrap (SDK facade + handler registries + minimal runtime)
 *   │  │  │  └─ Plugin source (IIFE → globalThis.__plugin_exports)
 *   │  │  └─ Host functions: __hostCall, __log
 *   │  └─ workerProtocol.ts wire format (unchanged)
 *   └─ pluginWorkerHost.ts api-call dispatch (unchanged)
 *
 * Concurrency model — sync QuickJS variant + deferred VM promises:
 *
 *   - The synchronous WASM variant of QuickJS is used (NOT the asyncified one).
 *     Asyncify's stack-unwinding interacts badly with Bun's microtask scheduler
 *     under load (manifests as `p->ref_count == 0` assertions on the second
 *     async eval). The sync variant is rock-stable.
 *   - `__hostCall` is registered as a *synchronous* VM function. When the
 *     plugin invokes it, the host creates a VM-side `Promise` via
 *     `ctx.newPromise()`, kicks off the real async work, and returns the
 *     Promise handle immediately. When the host work completes,
 *     `deferred.resolve(...)` lands the value into the VM and triggers any
 *     queued `.then` continuations.
 *   - The host drains the VM's microtask queue via
 *     `runtime.executePendingJobs()` after each settle and during eval polling.
 *
 * The SDK provided inside the VM:
 *   • `api.plugin.{id,version,permissions,log}`
 *   • `api.cms.routes.{get,post,patch,delete,getPublic}`
 *   • `api.cms.storage.collection(id).{list,create,update,delete}`
 *   • `api.cms.hooks.{on,filter,emit}`
 *   • `api.cms.loops.registerSource`
 *   • `api.cms.settings.{get,getAll,replace}`
 *
 * Denied inside the VM:
 *   • `Bun`, `process`, `require`, `import('node:*' | 'bun:*')`
 *   • `fetch`, `WebSocket`, `XMLHttpRequest` — to be re-introduced under
 *     `network.outbound` permission as a gated host function (separate step).
 *   • `eval` cannot escape — the VM has no references into the host's heap.
 */

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PluginVmEnv {
  pluginId: string
  manifestVersion: string
  /** Permissions granted at install time — surfaced via api.plugin.permissions. */
  grantedPermissions: string[]
  /**
   * Asset base path for the plugin's installed files, e.g.
   * `/uploads/plugins/<id>/<version>`. Used by `api.plugin.assetUrl(path)`
   * to build URLs for static files the plugin shipped in its zip.
   */
  assetBasePath: string
  /** Initial settings snapshot — read synchronously inside the VM via api.cms.settings.get. */
  settings: Record<string, string | number | boolean>
  /**
   * Dispatch a host-side api-call. The implementation MUST validate
   * permission + target on the host side (see `dispatchApiCall` in
   * `pluginWorkerHost.ts`). Return value is JSON-serializable.
   */
  hostCall: (target: string, args: unknown[]) => Promise<unknown>
  /**
   * Stream a log line back to the host. Equivalent to `api.plugin.log(...)`.
   * Kept separate from hostCall so the existing `log` worker→main event
   * stays a fire-and-forget message (no correlation id).
   */
  log: (args: unknown[]) => void
}

export interface PluginVm {
  readonly pluginId: string
  /** Names of lifecycle hooks the plugin actually exported. */
  readonly exportedHooks: ReadonlyArray<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>
  runLifecycle: (hook: 'install' | 'activate' | 'deactivate' | 'uninstall') => Promise<void>
  runMigrate: (fromVersion: string) => Promise<void>
  runRoute: (routeKey: string, ctx: VmRouteContext) => Promise<unknown>
  runHookListener: (listenerId: string, payload: unknown) => Promise<void>
  runHookFilter: (filterId: string, value: unknown) => Promise<unknown>
  runLoopFetch: (sourceId: string, ctx: unknown) => Promise<{ items: unknown[]; totalItems: number }>
  runLoopPreview: (sourceId: string, ctx: unknown) => Promise<unknown[]>
  /**
   * Fire a scheduled job's handler. `maxDurationMs` overrides the VM's
   * default 5s deadline for this call only — schedules can declare a
   * larger budget at registration time (host-capped at 5 minutes).
   */
  runSchedule: (scheduleId: string, maxDurationMs: number) => Promise<void>
  /** Update the VM's settings mirror so subsequent api.cms.settings.get() sees the new values. */
  updateSettings: (next: Record<string, string | number | boolean>) => Promise<void>
  /**
   * Invoke a method on a plugin-registered media storage adapter. The host
   * uses this when the upload pipeline needs the adapter to sign an upload
   * plan or commit / cleanup. Bytes are NEVER carried through this call —
   * the adapter only signs URLs; the host streams payloads outside the VM.
   *
   * `method` is one of `beginWrite`, `finalizeWrite`, `abortWrite`,
   * `delete`, `getReadUrl`, `verify` (see `MediaStorageAdapter` in
   * `src/core/plugin-sdk/types.ts`).
   */
  runMediaAdapterCall: (adapterId: string, method: string, args: unknown[]) => Promise<unknown>
  /**
   * Apply a registered URL transformer. Receives `{ path, ctx }`, returns
   * either the rewritten path (string) or `null` for "no change".
   */
  runMediaUrlTransformer: (transformerId: string, payload: { path: string; ctx: unknown }) => Promise<string | null>
  dispose: () => void
}

export interface VmRouteContext {
  request: {
    url: string
    method: string
    headers: Record<string, string>
    body: string
  }
  body: Record<string, unknown>
  user: { id: string; email: string; capabilities: string[] } | null
}

// ---------------------------------------------------------------------------
// Resource limits — defense against runaway / malicious plugins.
//
// Plugin VMs get:
//   • A hard memory ceiling enforced by the QuickJS runtime
//     (`setMemoryLimit`). Allocations beyond the limit throw an
//     `OutOfMemory` error inside the VM.
//   • A bounded stack size (`setMaxStackSize`) so a recursive plugin can't
//     exhaust the host's WASM stack.
//   • A wall-clock interrupt per eval call (`shouldInterruptAfterDeadline`).
//     The VM cooperatively checks the interrupt flag during execution; a
//     plugin stuck in an infinite loop is aborted within the deadline.
//
// Defaults are picked to be invisible for normal plugin work and harsh
// for runaways. Plugins that legitimately need higher caps will surface
// memory errors and we can add a per-plugin override field later.
// ---------------------------------------------------------------------------

/** 64 MB max heap per plugin VM. */
const DEFAULT_MEMORY_LIMIT_BYTES = 64 * 1024 * 1024
/** 1 MB max stack — plenty for normal use, fatal for runaway recursion. */
const DEFAULT_STACK_SIZE_BYTES = 1 * 1024 * 1024
/**
 * 5 second wall-clock deadline per eval call. Lifecycle hooks, route
 * handlers, hook listeners, and loop fetches all use this same budget.
 * If a plugin needs more, it should yield back to the host (e.g. emit
 * progress events) rather than block in a tight loop.
 */
const DEFAULT_EVAL_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Singleton WASM module — one per worker, shared across plugin contexts.
// ---------------------------------------------------------------------------

let wasmModulePromise: Promise<QuickJSWASMModule> | null = null

function getWasmModule(): Promise<QuickJSWASMModule> {
  if (!wasmModulePromise) wasmModulePromise = getQuickJS()
  return wasmModulePromise
}

// ---------------------------------------------------------------------------
// JS↔VM marshalling
// ---------------------------------------------------------------------------

/**
 * Convert a JSON-serializable JS value into a fresh QuickJS handle. Caller
 * owns the returned handle and must dispose it (or transfer ownership to
 * the VM via `setProp` / function return).
 */
function jsToHandle(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === null || value === undefined) return ctx.undefined
  if (typeof value === 'string') return ctx.newString(value)
  if (typeof value === 'number') return ctx.newNumber(value)
  if (typeof value === 'boolean') return value ? ctx.true : ctx.false
  if (Array.isArray(value)) {
    const arr = ctx.newArray()
    value.forEach((item, idx) => {
      const itemHandle = jsToHandle(ctx, item)
      ctx.setProp(arr, idx, itemHandle)
      itemHandle.dispose()
    })
    return arr
  }
  if (typeof value === 'object') {
    const obj = ctx.newObject()
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childHandle = jsToHandle(ctx, v)
      ctx.setProp(obj, k, childHandle)
      childHandle.dispose()
    }
    return obj
  }
  // Functions / Symbols / BigInts aren't JSON-serializable across the boundary.
  return ctx.newString(String(value))
}

// ---------------------------------------------------------------------------
// Bootstrap source — evaluated inside the VM BEFORE the plugin code runs.
//
// Provides:
//   - `__plugin_handlers`        : maps storing route/listener/filter/loopSource handlers
//   - `__buildApi()`             : constructs the ServerPluginApi object plugins see
//   - `__runRoute / __runHookListener / __runHookFilter / __runLoopFetch / __runLoopPreview / __runLifecycle`
//   - `__plugin_meta` + `__plugin_settings`
//   - Minimal `console` polyfill routing to `__log`
//
// The plugin source runs AFTER this and attaches its lifecycle hooks to
// `globalThis.__plugin_exports`. Then the host evaluates `__runLifecycle(hook)`
// to dispatch.
// ---------------------------------------------------------------------------

const BOOTSTRAP_SOURCE = `
'use strict';

// ------- minimal runtime stubs -------
const __consoleProxy = (level) => function () {
  const parts = [];
  for (let i = 0; i < arguments.length; i++) {
    const a = arguments[i];
    if (a instanceof Error) parts.push(a.stack || a.message);
    else if (typeof a === 'string') parts.push(a);
    else {
      try { parts.push(JSON.stringify(a)); }
      catch (_) { parts.push(String(a)); }
    }
  }
  __log(level, parts.join(' '));
};
globalThis.console = {
  log: __consoleProxy('info'),
  info: __consoleProxy('info'),
  warn: __consoleProxy('warn'),
  error: __consoleProxy('error'),
  debug: __consoleProxy('info'),
  trace: __consoleProxy('info'),
};

// ------- timers (setTimeout/setInterval) — host-bridged via __hostSleep --
// The QuickJS VM has no built-in event loop, so timers can't be a pure JS
// polyfill — somebody has to actually wait. We thread that wait through a
// worker-local __hostSleep(ms) host function that resolves a VM Promise
// after ms real milliseconds (via the worker's setTimeout). Plugin
// timers are therefore real wall-clock timers, not VM-internal "ticks",
// and they integrate with the existing __hostCall pump (microtasks get
// drained when the host-side resolve lands).
//
// Cancellation is recorded in __timer_tokens; the fire path checks the
// token's flag before invoking the callback. The host also tracks each
// scheduled native setTimeout via its host-side handle so the whole set
// can be torn down when the VM is disposed (preventing fires into a dead
// VM after the plugin is uninstalled / upgraded).
let __timer_seq = 0;
const __timer_tokens = new Map();
const __TIMER_MAX_MS = 24 * 60 * 60 * 1000; // 1 day ceiling — silently clamped.

function __scheduleTimer(handler, delayMs, repeating) {
  if (typeof handler !== 'function') throw new TypeError('Timer callback must be a function');
  __timer_seq += 1;
  const id = __timer_seq;
  const raw = Number(delayMs);
  let ms = Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (ms > __TIMER_MAX_MS) ms = __TIMER_MAX_MS;
  const token = { cancelled: false };
  __timer_tokens.set(id, token);

  function tick() {
    if (token.cancelled) return;
    __hostSleep(ms).then(function () {
      if (token.cancelled) return;
      try {
        handler();
      } catch (err) {
        __log('error', '[timer] callback threw: ' + (err && err.stack ? err.stack : String(err)));
      }
      if (repeating && !token.cancelled) tick();
      else __timer_tokens.delete(id);
    });
  }
  tick();
  return id;
}

globalThis.setTimeout = function setTimeout(handler, delayMs) {
  return __scheduleTimer(handler, delayMs, false);
};
globalThis.clearTimeout = function clearTimeout(id) {
  const token = __timer_tokens.get(id);
  if (token) { token.cancelled = true; __timer_tokens.delete(id); }
};
globalThis.setInterval = function setInterval(handler, periodMs) {
  // Browser-ish floor of 4ms so a misuse (setInterval(fn, 0)) doesn't pin
  // a worker. The 1-day ceiling above already covers the upper end.
  const safeMs = Number(periodMs) >= 4 ? Number(periodMs) : 4;
  return __scheduleTimer(handler, safeMs, true);
};
globalThis.clearInterval = function clearInterval(id) {
  const token = __timer_tokens.get(id);
  if (token) { token.cancelled = true; __timer_tokens.delete(id); }
};
globalThis.queueMicrotask = function queueMicrotask(handler) {
  if (typeof handler !== 'function') throw new TypeError('queueMicrotask callback must be a function');
  // The VM has a native Promise scheduler — a resolved Promise's .then is a
  // proper microtask. This polyfill matches the WHATWG ordering closely
  // enough for plugin code that just wants to defer until the current
  // synchronous task finishes.
  Promise.resolve().then(function () {
    try { handler(); }
    catch (err) { __log('error', '[microtask] threw: ' + (err && err.stack ? err.stack : String(err))); }
  });
};

// ------- AbortController / AbortSignal — pure JS polyfill ----------------
// Plugins routinely receive AbortSignals from libraries and need to thread
// them through fetch. We implement just enough of the WHATWG surface
// (aborted, reason, addEventListener('abort'), throwIfAborted) for
// realistic usage. AbortSignal.timeout() and AbortSignal.any() are static
// helpers most users expect.
function __makeAbortSignal() {
  const listeners = [];
  const signal = {
    aborted: false,
    reason: undefined,
    onabort: null,
    addEventListener: function (type, listener) {
      if (type !== 'abort' || typeof listener !== 'function') return;
      if (signal.aborted) {
        try { listener({ type: 'abort', target: signal }); } catch (_) {}
        return;
      }
      listeners.push(listener);
    },
    removeEventListener: function (type, listener) {
      if (type !== 'abort') return;
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: function () { return true; },
    throwIfAborted: function () {
      if (signal.aborted) {
        const r = signal.reason;
        if (r && typeof r === 'object') throw r;
        const err = new Error(typeof r === 'string' ? r : 'The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
    },
  };
  signal.__fire = function (reason) {
    if (signal.aborted) return;
    signal.aborted = true;
    if (reason === undefined) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      signal.reason = err;
    } else {
      signal.reason = reason;
    }
    const event = { type: 'abort', target: signal };
    if (typeof signal.onabort === 'function') {
      try { signal.onabort(event); } catch (_) {}
    }
    const snapshot = listeners.slice();
    listeners.length = 0;
    for (let i = 0; i < snapshot.length; i++) {
      try { snapshot[i](event); } catch (_) {}
    }
  };
  return signal;
}

function AbortControllerCtor() {
  if (!(this instanceof AbortControllerCtor)) {
    throw new TypeError("AbortController constructor: must be called with 'new'");
  }
  const signal = __makeAbortSignal();
  this.signal = signal;
  this.abort = function abort(reason) { signal.__fire(reason); };
}
globalThis.AbortController = AbortControllerCtor;

globalThis.AbortSignal = {
  abort: function (reason) {
    const s = __makeAbortSignal();
    s.__fire(reason);
    return s;
  },
  timeout: function (ms) {
    const controller = new AbortControllerCtor();
    const delay = Number(ms);
    if (Number.isFinite(delay) && delay >= 0) {
      setTimeout(function () {
        const err = new Error('Signal timed out');
        err.name = 'TimeoutError';
        controller.abort(err);
      }, delay);
    }
    return controller.signal;
  },
  any: function (signals) {
    const merged = new AbortControllerCtor();
    if (!signals || typeof signals.length !== 'number') return merged.signal;
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      if (!s) continue;
      if (s.aborted) { merged.abort(s.reason); return merged.signal; }
    }
    for (let i = 0; i < signals.length; i++) {
      const s = signals[i];
      if (!s) continue;
      s.addEventListener('abort', function () { merged.abort(s.reason); });
    }
    return merged.signal;
  },
};

// ------- crypto.subtle — WebCrypto-compatible shim --------------------------
// Storage / auth plugins need SHA-256 + HMAC-SHA256 (AWS Sigv4, JWT signing,
// OAuth, presigned URLs). Without a host bridge they'd have to vendor a
// pure-JS HMAC implementation — possible but error-prone.
//
// Exposed surface (matches the WebCrypto spec subset every plugin actually
// uses):
//   • crypto.subtle.digest(algorithm, data) → Promise<ArrayBuffer>
//   • crypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, extractable, ['sign'])
//       → Promise<CryptoKey>   // opaque handle wrapping raw bytes
//   • crypto.subtle.sign({ name: 'HMAC' }, key, data) → Promise<ArrayBuffer>
//
// Inputs accept any BufferSource (ArrayBuffer, Uint8Array, etc.) OR a
// string (UTF-8 encoded into bytes inside the shim — the most common
// caller shape for AWS canonical-request strings). Outputs are
// ArrayBuffer; callers wrap in Uint8Array as usual.
//
// Bytes cross the host bridge as base64-encoded strings. Inputs are
// size-capped on the host (8 MB after decode); AWS signing strings are
// always < 4 KB so the cap is comfortable.
function __utf8Encode(str) {
  // QuickJS doesn't ship TextEncoder, but we only need UTF-8 of a
  // string we control here. Implementing the encoder inline keeps the
  // surface minimal — and the bytes get base64'd straight away.
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      // Surrogate pair — combine with the next code unit.
      const next = str.charCodeAt(++i);
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (next & 0x3ff));
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(out);
}

const __B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function __bytesToBase64(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += __B64_CHARS[(triplet >> 18) & 0x3f]
      + __B64_CHARS[(triplet >> 12) & 0x3f]
      + __B64_CHARS[(triplet >> 6) & 0x3f]
      + __B64_CHARS[triplet & 0x3f];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const a = bytes[i];
    out += __B64_CHARS[a >> 2] + __B64_CHARS[(a << 4) & 0x3f] + '==';
  } else if (rem === 2) {
    const a = bytes[i];
    const b = bytes[i + 1];
    out += __B64_CHARS[a >> 2]
      + __B64_CHARS[((a << 4) | (b >> 4)) & 0x3f]
      + __B64_CHARS[(b << 2) & 0x3f]
      + '=';
  }
  return out;
}

const __B64_DECODE = new Uint8Array(128);
for (let i = 0; i < __B64_CHARS.length; i++) __B64_DECODE[__B64_CHARS.charCodeAt(i)] = i;

function __base64ToBytes(base64) {
  // Strip trailing '=' padding for the length computation but tolerate
  // its presence on input (we just stop at the first '=').
  let padded = base64;
  while (padded.length % 4 !== 0) padded += '=';
  const padCount = (padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0);
  const byteLength = (padded.length * 3) / 4 - padCount;
  const out = new Uint8Array(byteLength);
  let o = 0;
  for (let i = 0; i < padded.length; i += 4) {
    const a = __B64_DECODE[padded.charCodeAt(i)] || 0;
    const b = __B64_DECODE[padded.charCodeAt(i + 1)] || 0;
    const c = padded.charCodeAt(i + 2) === 0x3d ? 0 : (__B64_DECODE[padded.charCodeAt(i + 2)] || 0);
    const d = padded.charCodeAt(i + 3) === 0x3d ? 0 : (__B64_DECODE[padded.charCodeAt(i + 3)] || 0);
    out[o++] = (a << 2) | (b >> 4);
    if (o < byteLength) out[o++] = ((b << 4) & 0xff) | (c >> 2);
    if (o < byteLength) out[o++] = ((c << 6) & 0xff) | d;
  }
  return out;
}

function __cryptoInputToBase64(input) {
  if (typeof input === 'string') return __bytesToBase64(__utf8Encode(input));
  if (input instanceof Uint8Array) return __bytesToBase64(input);
  if (input instanceof ArrayBuffer) return __bytesToBase64(new Uint8Array(input));
  if (input && typeof input === 'object' && input.buffer instanceof ArrayBuffer) {
    // TypedArray view (Int8Array / DataView / etc.). Slice into a
    // fresh Uint8Array so we don't accidentally read past byteLength.
    return __bytesToBase64(new Uint8Array(
      input.buffer.slice(input.byteOffset || 0, (input.byteOffset || 0) + input.byteLength),
    ));
  }
  throw new TypeError('Crypto input must be a string, ArrayBuffer, or BufferSource');
}

function __cryptoNormalizeAlgorithm(algorithm) {
  if (typeof algorithm === 'string') return algorithm;
  if (algorithm && typeof algorithm === 'object' && typeof algorithm.name === 'string') return algorithm.name;
  throw new TypeError('Crypto algorithm must be a string or { name } object');
}

function __cryptoNormalizeHash(hash) {
  if (typeof hash === 'string') return hash;
  if (hash && typeof hash === 'object' && typeof hash.name === 'string') return hash.name;
  throw new TypeError("Hash algorithm must be a string or { name } object");
}

const __CRYPTO_SUPPORTED_HASHES = ['SHA-256', 'SHA-1', 'SHA-512'];

globalThis.crypto = globalThis.crypto || {};
globalThis.crypto.subtle = {
  digest: async function digest(algorithm, data) {
    const name = __cryptoNormalizeAlgorithm(algorithm);
    if (__CRYPTO_SUPPORTED_HASHES.indexOf(name) < 0) {
      throw new Error('Unsupported digest algorithm: ' + name);
    }
    const base64 = __cryptoInputToBase64(data);
    const resultBase64 = await __hostCall('crypto.digest', [{ algorithm: name, data: base64 }]);
    const bytes = __base64ToBytes(String(resultBase64));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  importKey: async function importKey(format, keyData, algorithm, _extractable, keyUsages) {
    if (format !== 'raw') {
      throw new TypeError("Only 'raw' key format is supported in this sandbox.");
    }
    const algoName = __cryptoNormalizeAlgorithm(algorithm);
    if (algoName !== 'HMAC') {
      throw new TypeError("Only HMAC keys are supported in this sandbox.");
    }
    const hashName = __cryptoNormalizeHash(algorithm && algorithm.hash);
    if (__CRYPTO_SUPPORTED_HASHES.indexOf(hashName) < 0) {
      throw new Error('Unsupported HMAC hash: ' + hashName);
    }
    if (!Array.isArray(keyUsages) || keyUsages.indexOf('sign') < 0) {
      throw new TypeError("HMAC importKey requires usages to include 'sign'.");
    }
    return {
      __cryptoKey: true,
      type: 'secret',
      algorithm: { name: 'HMAC', hash: { name: hashName } },
      extractable: false,
      usages: ['sign'],
      __raw: __cryptoInputToBase64(keyData),
    };
  },
  sign: async function sign(algorithm, key, data) {
    if (!key || !key.__cryptoKey) {
      throw new TypeError('Sign requires a CryptoKey returned by importKey.');
    }
    const algoName = __cryptoNormalizeAlgorithm(algorithm);
    if (algoName !== 'HMAC') {
      throw new TypeError('Only HMAC signing is supported in this sandbox.');
    }
    const dataBase64 = __cryptoInputToBase64(data);
    const sigBase64 = await __hostCall('crypto.signHmac', [{
      hash: key.algorithm.hash.name,
      key: key.__raw,
      data: dataBase64,
    }]);
    const bytes = __base64ToBytes(String(sigBase64));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
};

// ------- gated fetch -------
// Plugins with the 'network.outbound' permission AND a matching entry in
// the manifest's networkAllowedHosts can issue outbound HTTP. The host
// enforces both checks (kernel-of-correctness); this shim provides a
// Response-like façade so plugin code can use the familiar fetch API.
//
// AbortSignal threading: each call mints a unique abortId and registers
// it on the host. If the plugin's signal aborts before the host fetch
// completes, the polyfill fires the network.abort api-call so the host's
// AbortController cancels the in-flight request instead of waiting for
// it to settle. The host fetch's pending promise is also raced against
// a local rejection so the plugin's await resolves immediately.
let __fetch_abort_seq = 0;

function __materializeResponse(result) {
  return {
    status: result.status,
    ok: result.ok,
    headers: {
      get: function (name) { return result.headers[String(name).toLowerCase()] || null; },
      has: function (name) { return Object.prototype.hasOwnProperty.call(result.headers, String(name).toLowerCase()); },
      forEach: function (cb) { for (const k of Object.keys(result.headers)) cb(result.headers[k], k); },
    },
    text: async function () { return result.body; },
    json: async function () { return JSON.parse(result.body); },
    arrayBuffer: async function () {
      const buf = new Uint8Array(result.body.length);
      for (let i = 0; i < result.body.length; i++) buf[i] = result.body.charCodeAt(i) & 0xff;
      return buf.buffer;
    },
  };
}

function __abortError(reason) {
  if (reason && typeof reason === 'object') return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}

globalThis.fetch = async function fetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
  const opts = init && typeof init === 'object' ? init : {};
  const serialized = {
    method: typeof opts.method === 'string' ? opts.method : 'GET',
    headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : {},
    body: typeof opts.body === 'string' ? opts.body : (opts.body == null ? undefined : String(opts.body)),
  };
  const signal = opts.signal && typeof opts.signal === 'object' ? opts.signal : null;
  if (signal && signal.aborted) throw __abortError(signal.reason);

  __fetch_abort_seq += 1;
  const abortId = 'a' + __fetch_abort_seq + '_' + Date.now().toString(36);
  serialized.abortId = abortId;

  const hostPromise = __hostCall('network.fetch', [url, serialized]);

  if (!signal) {
    const result = await hostPromise;
    return __materializeResponse(result);
  }

  // Race the host fetch against the signal — if abort wins, also tell the
  // host to cancel the in-flight request so its socket / response stream
  // is torn down instead of leaking until natural completion.
  let abortListener = null;
  const abortPromise = new Promise(function (_, reject) {
    abortListener = function () {
      reject(__abortError(signal.reason));
      // Fire-and-forget — if the host call already returned, the host's
      // map entry is gone and this is a no-op.
      try { __hostCall('network.abort', [{ abortId: abortId }]); } catch (_) {}
    };
    signal.addEventListener('abort', abortListener);
  });

  try {
    const result = await Promise.race([hostPromise, abortPromise]);
    return __materializeResponse(result);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
};

// ------- handler registries (live inside the VM, host has metadata) -------
globalThis.__plugin_handlers = {
  routes: {},
  listeners: {},
  filters: {},
  loopSources: {},
  schedules: {},
  // Media subsystem — each adapter is keyed by its namespaced id; each
  // entry is the { beginWrite, finalizeWrite, abortWrite, delete,
  // getReadUrl?, verify, readStream? } record the plugin handed to
  // api.cms.media.registerStorageAdapter. URL transformers are keyed by
  // a host-minted transformer id (mirroring the hook-filter pattern).
  mediaAdapters: {},
  mediaUrlTransformers: {},
};

// ------- the api object plugins receive -------
globalThis.__buildApi = function buildApi() {
  const meta = globalThis.__plugin_meta;

  function assertPermission(perm) {
    // Sync defense-in-depth check INSIDE the VM. The host-side dispatcher
    // also enforces permissions (kernel-of-correctness), but the host check
    // surfaces as a rejected Promise — plugin code that doesn't await
    // would otherwise silently succeed. Throwing synchronously here matches
    // the pre-sandbox 'assertPluginPermission' behavior plugin authors
    // already rely on.
    if (meta.permissions.indexOf(perm) < 0) {
      throw new Error('Plugin "' + meta.id + '" requires permission "' + perm + '"');
    }
  }

  function call(target, args) {
    return __hostCall(target, args);
  }

  function normalizePath(p) {
    const t = String(p).trim();
    if (!t || t === '/') return '/';
    return '/' + t.replace(/^\\/+|\\/+$/g, '');
  }

  function makeRoute(method) {
    return function (path, capability, handler) {
      assertPermission('cms.routes');
      if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
      const routeKey = method + ':' + normalizePath(path);
      globalThis.__plugin_handlers.routes[routeKey] = handler;
      return call('cms.routes.register', [{ method: method, path: normalizePath(path), capability: capability, routeKey: routeKey }]);
    };
  }
  function registerPublic(method) {
    return function (path, handler) {
      assertPermission('cms.routes');
      if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
      const routeKey = method + ':' + normalizePath(path);
      globalThis.__plugin_handlers.routes[routeKey] = handler;
      return call('cms.routes.register', [{ method: method, path: normalizePath(path), capability: null, routeKey: routeKey }]);
    };
  }

  function on(event, listener) {
    assertPermission('cms.hooks');
    if (typeof listener !== 'function') throw new TypeError('Hook listener must be a function');
    const listenerId = __nextId('listener');
    globalThis.__plugin_handlers.listeners[listenerId] = listener;
    return call('cms.hooks.on', [{ event: String(event), listenerId: listenerId }]);
  }
  function filter(name, handler) {
    assertPermission('cms.hooks');
    if (typeof handler !== 'function') throw new TypeError('Hook filter must be a function');
    const filterId = __nextId('filter');
    globalThis.__plugin_handlers.filters[filterId] = handler;
    return call('cms.hooks.filter', [{ name: String(name), filterId: filterId }]);
  }
  function emit(event, payload) {
    assertPermission('cms.hooks');
    return call('cms.hooks.emit', [{ event: String(event), payload: payload === undefined ? null : payload }]);
  }

  function registerSource(source) {
    assertPermission('loops.register');
    if (!source || typeof source !== 'object') throw new TypeError('Loop source must be an object');
    if (typeof source.fetch !== 'function') throw new TypeError('Loop source.fetch must be a function');
    const sourceId = String(source.id);
    globalThis.__plugin_handlers.loopSources[sourceId] = {
      fetch: source.fetch,
      preview: typeof source.preview === 'function' ? source.preview : function () { return []; },
    };
    const descriptor = {
      id: sourceId,
      label: source.label,
      description: source.description,
      filterSchema: source.filterSchema || {},
      orderByOptions: source.orderByOptions || [],
      fields: source.fields || [],
    };
    return call('cms.loops.registerSource', [descriptor]);
  }

  function collection(resourceId) {
    assertPermission('cms.storage');
    return {
      list: function () { return call('cms.storage.list', [String(resourceId)]); },
      create: function (data) { return call('cms.storage.create', [String(resourceId), data]); },
      update: function (recordId, data) { return call('cms.storage.update', [String(resourceId), String(recordId), data]); },
      delete: function (recordId) { return call('cms.storage.delete', [String(resourceId), String(recordId)]); },
    };
  }

  // ---- scheduled jobs --------------------------------------------------
  // Plugin declares cadence + handler at activate-time. The host upserts
  // a row; the scheduler tick fires the handler via __runSchedule(id).
  // Handler is stored INSIDE the VM (not serialised) — the host carries
  // only the schedule metadata in plugin_schedules.

  // The host namespaces schedule ids as <pluginId>.<localId> before
  // storing them (see pluginScheduleRegistration.ts:registerPluginSchedule)
  // and dispatches firings using the namespaced id. The VM's handler map
  // must use the SAME key so __runSchedule can resolve a registered handler.
  function namespaceScheduleId(localId) {
    const prefix = meta.id + '.';
    return localId.indexOf(prefix) === 0 ? localId : prefix + localId;
  }

  function scheduleRegister(def) {
    assertPermission('cms.schedule');
    if (!def || typeof def !== 'object') throw new TypeError('schedule.register: argument must be an object');
    if (typeof def.id !== 'string' || def.id.length === 0) throw new TypeError("schedule.register: 'id' is required");
    if (typeof def.handler !== 'function') throw new TypeError("schedule.register: 'handler' must be a function");
    if (!def.cadence || typeof def.cadence !== 'object') throw new TypeError("schedule.register: 'cadence' is required");
    const scheduleId = String(def.id);
    globalThis.__plugin_handlers.schedules[namespaceScheduleId(scheduleId)] = def.handler;
    const overlap = def.overlap === 'queue' || def.overlap === 'parallel' ? def.overlap : 'skip';
    // Cap at the host-side maximum (5 minutes); a stricter cap can be
    // negotiated later via a per-plugin manifest field. Default 5_000ms
    // matches the VM's default eval deadline so behaviour is consistent
    // with route / hook / loop calls.
    let maxDurationMs = typeof def.maxDurationMs === 'number' ? def.maxDurationMs : 5000;
    if (maxDurationMs < 100) maxDurationMs = 100;
    if (maxDurationMs > 5 * 60 * 1000) maxDurationMs = 5 * 60 * 1000;
    return call('cms.schedule.register', [{
      scheduleId: scheduleId,
      cadence: def.cadence,
      overlap: overlap,
      maxDurationMs: maxDurationMs,
    }]);
  }

  function scheduleCancel(id) {
    assertPermission('cms.schedule');
    const scheduleId = String(id);
    delete globalThis.__plugin_handlers.schedules[namespaceScheduleId(scheduleId)];
    return call('cms.schedule.cancel', [{ scheduleId: scheduleId }]);
  }

  const scheduleApi = {
    register: scheduleRegister,
    cancel: scheduleCancel,
    daily: function (id, at, handler) {
      return scheduleRegister({ id: id, cadence: { interval: 'daily', at: at }, handler: handler });
    },
    hourly: function (id, handler) {
      return scheduleRegister({ id: id, cadence: { interval: 'hourly' }, handler: handler });
    },
    every: function (minutes, id, handler) {
      return scheduleRegister({ id: id, cadence: { interval: 'every', minutes: minutes }, handler: handler });
    },
  };

  const settingsApi = {
    get: function (key) { return globalThis.__plugin_settings[key]; },
    getAll: function () { return Object.assign({}, globalThis.__plugin_settings); },
    replace: async function (next) {
      const updated = await call('cms.settings.replace', [next]);
      for (const k of Object.keys(globalThis.__plugin_settings)) delete globalThis.__plugin_settings[k];
      if (updated && typeof updated === 'object') Object.assign(globalThis.__plugin_settings, updated);
    },
  };

  // ---- media subsystem -----------------------------------------------------
  // Three independent surfaces under api.cms.media. The callbacks live INSIDE
  // the VM (stored under __plugin_handlers.mediaAdapters / mediaUrlTransformers);
  // the host only knows the adapter id + metadata. The host calls back into
  // the VM via __runMediaAdapterCall / __runMediaUrlTransformer when it
  // actually needs to upload/delete/transform a path.

  function registerStorageAdapter(adapter) {
    assertPermission('media.storage.adapter');
    if (!adapter || typeof adapter !== 'object') throw new TypeError('registerStorageAdapter: adapter must be an object');
    if (typeof adapter.id !== 'string' || !adapter.id) throw new TypeError("registerStorageAdapter: 'id' is required");
    if (adapter.id.indexOf(meta.id + '.') !== 0) {
      throw new Error('registerStorageAdapter: adapter id "' + adapter.id + '" must start with the plugin id "' + meta.id + '."');
    }
    if (typeof adapter.label !== 'string' || !adapter.label) throw new TypeError("registerStorageAdapter: 'label' is required");
    if (!Array.isArray(adapter.roles) || adapter.roles.length === 0) {
      throw new TypeError("registerStorageAdapter: 'roles' must be a non-empty array");
    }
    if (typeof adapter.servingMode !== 'string') throw new TypeError("registerStorageAdapter: 'servingMode' is required");
    if (typeof adapter.beginWrite !== 'function') throw new TypeError("registerStorageAdapter: 'beginWrite' must be a function");
    if (typeof adapter.finalizeWrite !== 'function') throw new TypeError("registerStorageAdapter: 'finalizeWrite' must be a function");
    if (typeof adapter.abortWrite !== 'function') throw new TypeError("registerStorageAdapter: 'abortWrite' must be a function");
    if (typeof adapter['delete'] !== 'function') throw new TypeError("registerStorageAdapter: 'delete' must be a function");
    if (typeof adapter.verify !== 'function') throw new TypeError("registerStorageAdapter: 'verify' must be a function");
    // Mode-specific constraints — the host re-validates but throwing here
    // surfaces the bug at activation time instead of first-use.
    if (adapter.servingMode === 'proxy' && typeof adapter.readStream !== 'function') {
      throw new TypeError("registerStorageAdapter: servingMode 'proxy' requires a 'readStream' function");
    }
    if (adapter.servingMode !== 'proxy' && typeof adapter.getReadUrl !== 'function') {
      throw new TypeError("registerStorageAdapter: servingMode '" + adapter.servingMode + "' requires a 'getReadUrl' function");
    }
    // Stash the live callback bag — keyed by id so the host's call-into-VM
    // round-trip can find it without iterating.
    globalThis.__plugin_handlers.mediaAdapters[adapter.id] = {
      beginWrite: adapter.beginWrite,
      finalizeWrite: adapter.finalizeWrite,
      abortWrite: adapter.abortWrite,
      delete: adapter['delete'],
      getReadUrl: typeof adapter.getReadUrl === 'function' ? adapter.getReadUrl : null,
      verify: adapter.verify,
      readStream: typeof adapter.readStream === 'function' ? adapter.readStream : null,
    };
    // Normalise CSP origins — accept either array of objects or undefined.
    const cspOrigins = Array.isArray(adapter.cspOrigins)
      ? adapter.cspOrigins.map(function (entry) {
        return { directive: String(entry.directive), origin: String(entry.origin) };
      })
      : undefined;
    return call('cms.media.registerStorageAdapter', [{
      adapterId: adapter.id,
      label: String(adapter.label),
      roles: adapter.roles.slice(),
      servingMode: String(adapter.servingMode),
      hasGetReadUrl: typeof adapter.getReadUrl === 'function',
      hasReadStream: typeof adapter.readStream === 'function',
      cspOrigins: cspOrigins,
    }]);
  }

  function registerUrlTransformer(fn) {
    assertPermission('media.url.transform');
    if (typeof fn !== 'function') throw new TypeError('registerUrlTransformer: argument must be a function');
    const transformerId = __nextId('mediaUrlT');
    globalThis.__plugin_handlers.mediaUrlTransformers[transformerId] = fn;
    return call('cms.media.registerUrlTransformer', [{ transformerId: transformerId }]);
  }

  function registerVariantDelegate(delegate) {
    assertPermission('media.variant.delegate');
    if (!delegate || typeof delegate !== 'object') throw new TypeError('registerVariantDelegate: argument must be an object');
    if (typeof delegate.id !== 'string' || !delegate.id) throw new TypeError("registerVariantDelegate: 'id' is required");
    if (delegate.id.indexOf(meta.id + '.') !== 0) {
      throw new Error('registerVariantDelegate: id "' + delegate.id + '" must start with the plugin id "' + meta.id + '."');
    }
    if (typeof delegate.variantUrlTemplate !== 'string') {
      throw new TypeError("registerVariantDelegate: 'variantUrlTemplate' must be a string");
    }
    if (!Array.isArray(delegate.widths) || delegate.widths.length === 0) {
      throw new TypeError("registerVariantDelegate: 'widths' must be a non-empty array");
    }
    if (!Array.isArray(delegate.formats) || delegate.formats.length === 0) {
      throw new TypeError("registerVariantDelegate: 'formats' must be a non-empty array");
    }
    return call('cms.media.registerVariantDelegate', [{
      delegateId: delegate.id,
      variantUrlTemplate: delegate.variantUrlTemplate,
      widths: delegate.widths.slice(),
      formats: delegate.formats.slice(),
    }]);
  }

  return {
    plugin: {
      id: meta.id,
      version: meta.version,
      permissions: meta.permissions.slice(),
      log: function () {
        const parts = [];
        for (let i = 0; i < arguments.length; i++) {
          const a = arguments[i];
          if (typeof a === 'string') parts.push(a);
          else {
            try { parts.push(JSON.stringify(a)); }
            catch (_) { parts.push(String(a)); }
          }
        }
        __log('info', parts.join(' '));
      },
      // Build a URL for a static file the plugin shipped in its zip.
      // assetBasePath looks like '/uploads/plugins/<id>/<version>'; we
      // join it with the package-relative path and normalize the slashes.
      assetUrl: function (path) {
        if (typeof path !== 'string' || path.length === 0) {
          throw new TypeError('assetUrl: path must be a non-empty string');
        }
        const base = (meta.assetBasePath || '').replace(/\\/+$/g, '');
        const rel = String(path).replace(/^\\/+/g, '');
        return base + '/' + rel;
      },
    },
    cms: {
      routes: {
        get: makeRoute('GET'),
        post: makeRoute('POST'),
        patch: makeRoute('PATCH'),
        delete: makeRoute('DELETE'),
        getPublic: registerPublic('GET'),
      },
      storage: { collection: collection },
      hooks: { on: on, filter: filter, emit: emit },
      loops: { registerSource: registerSource },
      settings: settingsApi,
      schedule: scheduleApi,
      media: {
        registerStorageAdapter: registerStorageAdapter,
        registerUrlTransformer: registerUrlTransformer,
        registerVariantDelegate: registerVariantDelegate,
      },
    },
  };
};

let __idCounter = 0;
function __nextId(prefix) { __idCounter += 1; return prefix + '_' + __idCounter + '_' + Date.now().toString(36); }

// ------- runners — host calls these to dispatch into plugin code -------

/**
 * Resolve the actual plugin module from __plugin_exports. Plugin authors
 * write one of two shapes:
 *   - named lifecycle exports: \`export function activate(api) { ... }\`
 *   - a default-export module: \`export default { install, activate, ... }\`
 *
 * Both code paths land on __plugin_exports — but with named exports the
 * hooks are direct properties, while with default-export the hooks live
 * one level deeper (under .default). We unwrap the latter so the runners
 * find the hooks either way. The SDK build's facade ALSO unwraps, but
 * keeping this here as belt-and-suspenders means raw-ESM single-file
 * plugins (test fixtures, hand-authored modules going through the
 * worker's \`ensureIifeForm\` shim) work too.
 */
function __resolvePluginModule() {
  const root = globalThis.__plugin_exports;
  if (!root || typeof root !== 'object') return null;
  const def = root.default;
  const isPluginModule = function (v) {
    return v && typeof v === 'object' && (
      typeof v.install === 'function' ||
      typeof v.activate === 'function' ||
      typeof v.deactivate === 'function' ||
      typeof v.uninstall === 'function' ||
      typeof v.migrate === 'function'
    );
  };
  return isPluginModule(def) ? def : root;
}

globalThis.__runLifecycle = async function runLifecycle(hook) {
  const mod = __resolvePluginModule();
  const fn = mod && mod[hook];
  if (typeof fn !== 'function') return;
  await fn(globalThis.__buildApi());
};

globalThis.__runMigrate = async function runMigrate(fromVersion) {
  const mod = __resolvePluginModule();
  const fn = mod && mod.migrate;
  if (typeof fn !== 'function') return;
  await fn({ fromVersion: fromVersion }, globalThis.__buildApi());
};

globalThis.__runRoute = async function runRoute(routeKey, ctxJson) {
  const handler = globalThis.__plugin_handlers.routes[routeKey];
  if (!handler) throw new Error('Route handler not registered: ' + routeKey);
  const ctx = JSON.parse(ctxJson);
  const req = {
    url: ctx.request.url,
    method: ctx.request.method,
    headers: ctx.request.headers,
    json: async function () { return JSON.parse(ctx.request.body || '{}'); },
    text: async function () { return ctx.request.body; },
  };
  const result = await handler({ req: req, body: ctx.body, user: ctx.user });
  return JSON.stringify(result === undefined ? { ok: true } : result);
};

globalThis.__runHookListener = async function runHookListener(listenerId, payloadJson) {
  const fn = globalThis.__plugin_handlers.listeners[listenerId];
  if (!fn) return;
  await fn(JSON.parse(payloadJson));
};

globalThis.__runHookFilter = async function runHookFilter(filterId, valueJson) {
  const fn = globalThis.__plugin_handlers.filters[filterId];
  if (!fn) return valueJson;
  const value = JSON.parse(valueJson);
  const next = await fn(value, { pluginId: globalThis.__plugin_meta.id });
  return JSON.stringify(next === undefined ? value : next);
};

globalThis.__runLoopFetch = async function runLoopFetch(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId];
  if (!source) throw new Error('Loop source not registered: ' + sourceId);
  const result = await source.fetch(JSON.parse(ctxJson));
  return JSON.stringify(result);
};

globalThis.__runLoopPreview = function runLoopPreview(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId];
  if (!source) throw new Error('Loop source not registered: ' + sourceId);
  return JSON.stringify(source.preview(JSON.parse(ctxJson)));
};

/**
 * Fire a scheduled job. Resolves with no value on success; throws on
 * handler error. The host wraps this call in its eval deadline (set per
 * schedule to maxDurationMs) so a runaway handler is interrupted cleanly.
 *
 * Lookup uses the namespaced id (e.g. 'acme.uptime.check-urls') because
 * scheduleRegister stores handlers under that key — mirroring the host's
 * pluginScheduleRegistration namespacing so both sides agree.
 *
 * If the handler isn't registered (e.g. plugin upgraded between tick and
 * dispatch, or the schedule row outlived a deactivate), we log and no-op
 * rather than throw — the schedule row will eventually be GC'd by the
 * host once the boot-claim grace window expires. We log so the silent
 * no-op surfaces during development if the handler-key ever drifts again.
 */
globalThis.__runSchedule = async function runSchedule(scheduleId) {
  const handler = globalThis.__plugin_handlers.schedules[scheduleId];
  if (typeof handler !== 'function') {
    __log('warn', 'no handler registered for schedule "' + String(scheduleId) + '"');
    return;
  }
  await handler();
};

/**
 * Generic adapter dispatch. The host calls this when it needs to invoke a
 * method on a plugin-registered MediaStorageAdapter (beginWrite, finalizeWrite,
 * abortWrite, delete, getReadUrl, verify). One runner instead of six so the
 * dispatcher's surface stays narrow and the per-method routing happens
 * inside the VM via a property lookup on the handler bag.
 *
 * argsJson is the JSON-encoded argument array for the method (so
 * beginWrite receives one object, delete receives one string, etc.). The
 * runner returns JSON-stringified value so the host's evalString helper
 * can carry the result back.
 */
globalThis.__runMediaAdapterCall = async function runMediaAdapterCall(adapterId, method, argsJson) {
  const adapter = globalThis.__plugin_handlers.mediaAdapters[adapterId];
  if (!adapter) throw new Error('Media adapter not registered: ' + adapterId);
  const fn = adapter[method];
  if (typeof fn !== 'function') throw new Error('Media adapter "' + adapterId + '" does not implement "' + method + '"');
  const argsArray = JSON.parse(argsJson);
  // .apply doesn't work cleanly through QuickJS' function wrapping; spread
  // into a regular call. Adapter methods accept 0..2 arguments in v1.
  const result = await fn(argsArray[0], argsArray[1]);
  return JSON.stringify(result === undefined ? null : result);
};

globalThis.__runMediaUrlTransformer = async function runMediaUrlTransformer(transformerId, payloadJson) {
  const fn = globalThis.__plugin_handlers.mediaUrlTransformers[transformerId];
  if (typeof fn !== 'function') {
    // Pass-through fallback. The host treats a null return as "no rewrite,
    // chain through to the next transformer's input value".
    return JSON.stringify(null);
  }
  const payload = JSON.parse(payloadJson);
  const next = await fn(payload.path, payload.ctx);
  return JSON.stringify(typeof next === 'string' ? next : null);
};

globalThis.__updateSettings = function updateSettings(nextJson) {
  const next = JSON.parse(nextJson);
  for (const k of Object.keys(globalThis.__plugin_settings)) delete globalThis.__plugin_settings[k];
  Object.assign(globalThis.__plugin_settings, next);
};

globalThis.__detectExportedHooks = function detectExportedHooks() {
  // Returns an Array (not a JSON string) because the host invokes this via
  // evalJson, which already wraps the result in JSON.stringify. Returning
  // a string would double-encode and the host would receive a string like
  // [["activate"]]. The runner-style helpers (__runRoute / __runLoopFetch
  // / ...) DO return JSON strings because their callers use evalString.
  const known = ['install', 'activate', 'deactivate', 'uninstall', 'migrate'];
  const mod = __resolvePluginModule() || {};
  const out = [];
  for (const name of known) {
    if (typeof mod[name] === 'function') out.push(name);
  }
  return out;
};
`

// ---------------------------------------------------------------------------
// VM construction
// ---------------------------------------------------------------------------

/**
 * Create a fresh QuickJS context for a plugin, evaluate the bootstrap, wire
 * in host functions, evaluate the plugin source bundle, and return a
 * `PluginVm` with strongly-typed entry points. Caller MUST `dispose()` when
 * the plugin is unloaded.
 *
 * Plugin source MUST be an IIFE that attaches its lifecycle hooks to
 * `globalThis.__plugin_exports`. The SDK build pipeline produces this shape
 * for server bundles — see `src/core/plugin-sdk/cli/build.ts`.
 */
export async function createPluginVm(args: {
  pluginSource: string
  env: PluginVmEnv
}): Promise<PluginVm> {
  const wasm = await getWasmModule()
  const ctx = wasm.newContext()

  // Apply per-plugin resource limits BEFORE evaluating any plugin code.
  // setMemoryLimit / setMaxStackSize live on the runtime, not the context,
  // and bind to all contexts created from this runtime. Each `wasm.newContext`
  // creates its own runtime in this binding, so limits are effectively
  // per-plugin.
  ctx.runtime.setMemoryLimit(DEFAULT_MEMORY_LIMIT_BYTES)
  ctx.runtime.setMaxStackSize(DEFAULT_STACK_SIZE_BYTES)
  /**
   * Host function handles MUST be kept alive for the lifetime of the
   * context — QuickJS's emscripten binding holds them via a HostRefMap and
   * disposing the JS-side handle early invalidates the in-VM callable.
   * They get released alongside the context in `dispose()` below.
   */
  const hostFunctionHandles: QuickJSHandle[] = []

  /**
   * Pending host-side timers. Bun.setTimeout returns a Timer handle (Node-
   * compatible) that we keep here so `dispose()` can stop every in-flight
   * fire before tearing down the VM — otherwise a timer scheduled by the
   * plugin would fire into a dead context and crash the worker.
   *
   * We use any-typed handles because the cross-platform Timer / Timeout
   * shape differs between Bun, Node, and the WebWorker DOM lib. We only
   * pass them to clearTimeout, which accepts all three.
   */
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

  /**
   * Set to true by `dispose()`. Used by the __hostCall / __hostSleep
   * callbacks as a cheap pre-check before touching VM handles, so a host
   * promise that resolves moments after `dispose()` can drop silently
   * instead of trying to call `ctx.newObject()` on a freed context (which
   * fails with "Lifetime not alive").
   */
  let vmDisposed = false

  /**
   * Pending VM-side `Deferred`s created by `__hostCall` / `__hostSleep`.
   * Each `ctx.newPromise()` allocates VM-tracked handles for the resolve
   * and reject callbacks; if the VM is disposed while one is unsettled,
   * QuickJS asserts `list_empty(&rt->gc_obj_list)` at runtime-free time
   * because those handles are still in the GC list. Disposing the deferred
   * up front in `vm.dispose()` releases them cleanly. Deferreds are
   * removed once they settle (resolve / reject paths handle this).
   */
  const pendingDeferreds = new Set<ReturnType<QuickJSContext['newPromise']>>()

  try {
    // 1. Wire __hostCall as a SYNCHRONOUS VM function. The host returns a
    //    VM-side Promise immediately and resolves it later from JS-land.
    //    `runtime.executePendingJobs()` drives any queued plugin-side .then
    //    continuations after the resolve lands.
    const hostCallHandle = ctx.newFunction('__hostCall', (targetHandle, argsHandle) => {
      const target = ctx.getString(targetHandle)
      const dumpedArgs = ctx.dump(argsHandle) as unknown
      const argsArray = Array.isArray(dumpedArgs) ? dumpedArgs : []

      const deferred = ctx.newPromise()
      pendingDeferreds.add(deferred)
      args.env.hostCall(target, argsArray).then(
        (value) => {
          // If the VM was disposed while we were awaiting (e.g. plugin
          // upgrade, crash, uninstall) drop the result silently — there's
          // no one to deliver to, and touching context handles would crash.
          // The try/catch protects against the gap between deferred being
          // marked dead and the underlying context lifetime being invalidated.
          if (vmDisposed || !deferred.alive) {
            pendingDeferreds.delete(deferred)
            return
          }
          try {
            const valueHandle = jsToHandle(ctx, value)
            deferred.resolve(valueHandle)
            if (valueHandle !== ctx.undefined && valueHandle !== ctx.null && valueHandle !== ctx.true && valueHandle !== ctx.false) {
              valueHandle.dispose()
            }
            // Drain plugin-side microtasks queued by the resolve.
            ctx.runtime.executePendingJobs()
          } catch { /* VM gone — silent drop. */ }
          pendingDeferreds.delete(deferred)
        },
        (err) => {
          if (vmDisposed || !deferred.alive) {
            pendingDeferreds.delete(deferred)
            return
          }
          try {
            const message = err instanceof Error ? err.message : String(err)
            const errHandle = ctx.newError(message)
            deferred.reject(errHandle)
            errHandle.dispose()
            ctx.runtime.executePendingJobs()
          } catch { /* VM gone — silent drop. */ }
          pendingDeferreds.delete(deferred)
        },
      )
      return deferred.handle
    })
    ctx.setProp(ctx.global, '__hostCall', hostCallHandle)
    hostFunctionHandles.push(hostCallHandle)

    // 1b. Wire __hostSleep — sync VM function that returns a VM Promise
    //     resolved after `ms` real wall-clock milliseconds. Used by the
    //     bootstrap's setTimeout/setInterval polyfills. Worker-local
    //     setTimeout (no IPC roundtrip to the main thread).
    const hostSleepHandle = ctx.newFunction('__hostSleep', (msHandle) => {
      const ms = ctx.getNumber(msHandle)
      const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0
      const deferred = ctx.newPromise()
      pendingDeferreds.add(deferred)
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        if (vmDisposed || !deferred.alive) {
          pendingDeferreds.delete(deferred)
          return
        }
        try {
          deferred.resolve(ctx.undefined)
          ctx.runtime.executePendingJobs()
        } catch { /* VM gone — silent drop. */ }
        pendingDeferreds.delete(deferred)
      }, safeMs)
      pendingTimers.add(timer)
      return deferred.handle
    })
    ctx.setProp(ctx.global, '__hostSleep', hostSleepHandle)
    hostFunctionHandles.push(hostSleepHandle)

    // 2. Wire __log — fire-and-forget log channel.
    const logHandle = ctx.newFunction('__log', (levelHandle, messageHandle) => {
      const level = ctx.getString(levelHandle)
      const message = ctx.getString(messageHandle)
      args.env.log([`[${level}]`, message])
    })
    ctx.setProp(ctx.global, '__log', logHandle)
    hostFunctionHandles.push(logHandle)

    // 3. Wire meta + settings as VM globals.
    const metaHandle = jsToHandle(ctx, {
      id: args.env.pluginId,
      version: args.env.manifestVersion,
      permissions: args.env.grantedPermissions,
      assetBasePath: args.env.assetBasePath,
    })
    ctx.setProp(ctx.global, '__plugin_meta', metaHandle)
    metaHandle.dispose()

    const settingsHandle = jsToHandle(ctx, { ...args.env.settings })
    ctx.setProp(ctx.global, '__plugin_settings', settingsHandle)
    settingsHandle.dispose()

    // 4. Evaluate the bootstrap and plugin bundle.
    ctx.unwrapResult(ctx.evalCode(BOOTSTRAP_SOURCE, 'pagebuilder-bootstrap.js')).dispose()
    ctx.unwrapResult(ctx.evalCode(args.pluginSource, `plugin:${args.env.pluginId}`)).dispose()

    // 5. Detect which lifecycle hooks the plugin exported.
    const exportedHooks = await evalJson<Array<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>>(
      ctx,
      `__detectExportedHooks()`,
    )

    const pluginId = args.env.pluginId

    return {
      pluginId,
      exportedHooks,

      async runLifecycle(hook) {
        await evalVoid(ctx, `__runLifecycle(${JSON.stringify(hook)})`)
      },

      async runMigrate(fromVersion) {
        await evalVoid(ctx, `__runMigrate(${JSON.stringify(fromVersion)})`)
      },

      async runRoute(routeKey, routeCtx) {
        const ctxJson = JSON.stringify(routeCtx)
        const json = await evalString(ctx, `__runRoute(${JSON.stringify(routeKey)}, ${JSON.stringify(ctxJson)})`)
        return JSON.parse(json) as unknown
      },

      async runHookListener(listenerId, payload) {
        const payloadJson = JSON.stringify(payload ?? null)
        await evalVoid(ctx, `__runHookListener(${JSON.stringify(listenerId)}, ${JSON.stringify(payloadJson)})`)
      },

      async runHookFilter(filterId, value) {
        const valueJson = JSON.stringify(value ?? null)
        const resultJson = await evalString(
          ctx,
          `__runHookFilter(${JSON.stringify(filterId)}, ${JSON.stringify(valueJson)})`,
        )
        return JSON.parse(resultJson) as unknown
      },

      async runLoopFetch(sourceId, loopCtx) {
        const ctxJson = JSON.stringify(loopCtx ?? null)
        const json = await evalString(ctx, `__runLoopFetch(${JSON.stringify(sourceId)}, ${JSON.stringify(ctxJson)})`)
        const parsed = JSON.parse(json) as { items?: unknown[]; totalItems?: number }
        return {
          items: Array.isArray(parsed.items) ? parsed.items : [],
          totalItems: typeof parsed.totalItems === 'number' ? parsed.totalItems : 0,
        }
      },

      async runLoopPreview(sourceId, loopCtx) {
        const ctxJson = JSON.stringify(loopCtx ?? null)
        const json = await evalString(ctx, `__runLoopPreview(${JSON.stringify(sourceId)}, ${JSON.stringify(ctxJson)})`)
        const parsed = JSON.parse(json) as unknown
        return Array.isArray(parsed) ? parsed : []
      },

      async runSchedule(scheduleId, maxDurationMs) {
        // Per-schedule deadline replaces the VM's default 5s budget for
        // this single call. The interrupt is reset by withDeadline's
        // finally block so subsequent calls fall back to the default.
        await evalVoid(ctx, `__runSchedule(${JSON.stringify(scheduleId)})`, maxDurationMs)
      },

      async updateSettings(next) {
        const json = JSON.stringify(next)
        await evalVoid(ctx, `__updateSettings(${JSON.stringify(json)})`)
      },

      async runMediaAdapterCall(adapterId, method, callArgs) {
        const argsJson = JSON.stringify(callArgs ?? [])
        const resultJson = await evalString(
          ctx,
          `__runMediaAdapterCall(${JSON.stringify(adapterId)}, ${JSON.stringify(method)}, ${JSON.stringify(argsJson)})`,
        )
        return JSON.parse(resultJson) as unknown
      },

      async runMediaUrlTransformer(transformerId, payload) {
        const payloadJson = JSON.stringify(payload)
        const resultJson = await evalString(
          ctx,
          `__runMediaUrlTransformer(${JSON.stringify(transformerId)}, ${JSON.stringify(payloadJson)})`,
        )
        const parsed = JSON.parse(resultJson) as unknown
        return typeof parsed === 'string' ? parsed : null
      },

      dispose() {
        // Mark disposed FIRST so any host-call resolution arriving after
        // this call (the VM has no way to cancel in-flight host promises)
        // short-circuits before touching freed handles.
        vmDisposed = true
        // Stop pending timers next so a timer fire doesn't try to touch a
        // disposed context. The deferred.alive checks inside the fire
        // callback are belt-and-suspenders, but cancelling up front avoids
        // even calling them.
        for (const timer of pendingTimers) {
          try { clearTimeout(timer) } catch {/* ignore */}
        }
        pendingTimers.clear()
        // Dispose any still-pending deferreds. Each one owns VM-tracked
        // resolve/reject closures that count against the runtime's GC list;
        // leaving them alive trips a `list_empty(&rt->gc_obj_list)` assertion
        // at runtime-free time.
        for (const deferred of pendingDeferreds) {
          try { deferred.dispose() } catch {/* already disposed */}
        }
        pendingDeferreds.clear()
        for (const h of hostFunctionHandles) {
          try { if (h.alive) h.dispose() } catch {/* already disposed */}
        }
        try { ctx.dispose() } catch {/* already disposed */}
      },
    }
  } catch (err) {
    vmDisposed = true
    for (const timer of pendingTimers) {
      try { clearTimeout(timer) } catch {/* ignore */}
    }
    pendingTimers.clear()
    for (const deferred of pendingDeferreds) {
      try { deferred.dispose() } catch {/* ignore */}
    }
    pendingDeferreds.clear()
    for (const h of hostFunctionHandles) {
      try { if (h.alive) h.dispose() } catch {/* ignore */}
    }
    try { ctx.dispose() } catch {/* ignore */}
    throw err
  }
}

// ---------------------------------------------------------------------------
// Deadline guard — installs a wall-clock interrupt handler on the runtime
// for the duration of one eval call, then removes it. The QuickJS VM
// cooperatively polls this handler during execution; a plugin stuck in a
// tight loop is aborted within the deadline.
// ---------------------------------------------------------------------------

function withDeadline<T>(ctx: QuickJSContext, timeoutMs: number, body: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  ctx.runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline))
  return body().finally(() => {
    try { ctx.runtime.removeInterruptHandler() } catch { /* runtime may already be disposed */ }
  })
}

// ---------------------------------------------------------------------------
// Eval helpers — drive a VM expression to a fully-resolved value.
//
// Polling pattern (no asyncify):
//   1. evalCode runs the synchronous portion of the expression
//   2. If the result is a Promise (e.g. from `async function` call),
//      we poll its state via getPromiseState
//   3. Between polls: executePendingJobs() advances VM microtasks
//   4. If no jobs ran and the Promise is still pending, yield to the host
//      event loop so __hostCall's host-side .then can fire deferred.resolve
//   5. Once fulfilled/rejected, return the value or throw the error
// ---------------------------------------------------------------------------

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

function evalVoid(ctx: QuickJSContext, code: string, timeoutMs?: number): Promise<void> {
  return evalResolved(ctx, code, () => undefined, timeoutMs)
}

function evalString(ctx: QuickJSContext, code: string): Promise<string> {
  return evalResolved(ctx, code, (h) => ctx.getString(h))
}

async function evalJson<T>(ctx: QuickJSContext, code: string): Promise<T> {
  const raw = await evalString(ctx, `JSON.stringify((${code}))`)
  return JSON.parse(raw) as T
}
