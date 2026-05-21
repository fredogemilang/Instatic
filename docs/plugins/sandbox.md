# Plugin Sandbox

Every plugin's **server entrypoint and canvas modules run inside a QuickJS-WASM sandbox** — a separate JavaScript engine compiled to WebAssembly. Plugin code has no access to Node, Bun, the host's file system, environment variables, or the network. Anything the plugin needs from the outside goes through the SDK.

This document explains what's available, what's denied, and how to bridge the gap.

## TL;DR

- You write normal TypeScript / JavaScript using the SDK
- `pb-plugin build` bundles your code and verifies it's sandbox-safe
- `import 'node:fs'`, `Bun.spawn`, `process.env`, `require()`, etc. are **build-time errors**
- The sandbox is portable: identical behavior on Linux, macOS, and Windows

## Why a sandbox?

Page Builder is self-hosted. Site operators install plugins they downloaded from the internet, and one bad plugin should not own the host process. The sandbox makes that boundary real: a plugin sees the SDK and nothing else. There is no kernel feature, OS configuration, or per-platform setup involved — the boundary is the WebAssembly specification.

## What's available inside the sandbox

### The SDK

- `api.plugin.{id, version, permissions, log}`
- `api.plugin.assetUrl(path)` — build a URL for a static file your plugin shipped in its zip (`'/uploads/plugins/<id>/<version>/<path>'`)
- `api.cms.routes.{get, post, patch, delete, getPublic}` — register HTTP routes under `/admin/api/cms/plugins/<id>/runtime/…`
- `api.cms.storage.collection(id).{list, create, update, delete}` — plugin-owned records
- `api.cms.hooks.{on, filter, emit}` — pub/sub event bus
- `api.cms.loops.registerSource` — register a loop entity source
- `api.cms.settings.{get, getAll, replace}` — plugin settings
- `api.cms.schedule.{register, cancel, daily, hourly, every}` — scheduled jobs (cadence-driven handlers). See [scheduled-jobs.md](./scheduled-jobs.md).

### Standard JavaScript

- `console.{log, info, warn, error, debug, trace}` — routes to `api.plugin.log`
- `JSON`, `Math`, `Date`, `Promise`, `async`/`await`, `Map`, `Set`, `WeakMap`, `WeakSet`
- `Array`, `Object`, `String`, `Number`, `Boolean`, `Symbol`, `BigInt`
- `RegExp`, `Error`, `TypeError`, `RangeError`, etc.
- ES2020+ syntax (optional chaining, nullish coalescing, BigInt literals, etc.)

### Outbound HTTP — opt-in

`fetch(url, init)` is available **only** when the plugin has the `network.outbound` permission AND the URL's host is in the manifest's `networkAllowedHosts` allowlist. See [Network access](#network-access) below.

## What's denied

These all error at build time (with a clear message) and again at install time as defense-in-depth:

| Forbidden | What to use instead |
|-----------|---------------------|
| `import 'node:fs'`, any `node:*` | `api.cms.storage.*` for plugin data |
| `import 'bun:*'` | The SDK |
| `Bun.spawn`, `Bun.connect`, `Bun.serve`, `Bun.sql`, `Bun.write`, `Bun.$` | Hooks (`api.cms.hooks.emit`) for cross-plugin signals |
| `process.env`, `process.exit`, `process.binding` | `api.cms.settings.*` for configuration |
| `require()` | ES module imports (resolved at build time) |
| `globalThis.fetch` without permission | Declare `network.outbound` + `networkAllowedHosts` |
| `WebSocket`, `XMLHttpRequest` | Not in the VM. Open an issue if you need them. |
| `eval`, `new Function(...)` | Don't do this — it's blocked. |

## Network access

Plugins are network-isolated by default. To make outbound HTTP requests, declare both the permission and the allowlist:

```json
{
  "id": "acme.weather",
  "permissions": ["network.outbound"],
  "networkAllowedHosts": [
    "api.weather.example.com",
    "*.cdn.weather.example.com"
  ]
}
```

Then in your plugin code:

```ts
export async function activate(api) {
  const res = await fetch('https://api.weather.example.com/today')
  const json = await res.json()
  api.plugin.log('today =', json)
}
```

### Allowlist semantics

- Plain hostnames (`api.example.com`) match **exactly**.
- The leading `*.` wildcard matches **one** subdomain segment:
  - `*.shopify.com` matches `shop.shopify.com` ✓
  - `*.shopify.com` does NOT match `shopify.com` ✗
  - `*.shopify.com` does NOT match `a.b.shopify.com` ✗
- An empty or missing `networkAllowedHosts` denies all outbound HTTP even when the permission is granted (fail-closed).
- Only `http:` and `https:` URLs are permitted — no `file:`, no `ftp:`, no custom schemes.
- The host validates the URL before issuing the request. The plugin never observes a redirect target outside the allowlist.

### `fetch` in the VM

The VM ships a minimal `fetch` polyfill that returns a Response-like object with:

- `.status` (number)
- `.ok` (boolean)
- `.headers.get(name)`, `.headers.has(name)`, `.headers.forEach(cb)`
- `.text()` → `Promise<string>`
- `.json()` → `Promise<unknown>`
- `.arrayBuffer()` → `Promise<ArrayBuffer>`

It DOES support `init.signal` — `AbortSignal` cancellation threads through to the host's real `fetch`, so an aborted call tears down the upstream socket instead of waiting for the response to dribble in.

```ts
export async function activate(api) {
  // Per-request timeout via AbortSignal.timeout.
  const res = await fetch('https://api.weather.example.com/today', {
    signal: AbortSignal.timeout(5_000),
  })
  api.plugin.log(await res.json())
}
```

It does NOT support: streaming bodies, `FormData` request bodies, or introspectable redirects. Add an issue if you need them.

### Timers, microtasks, and AbortController

The VM ships polyfills for the standard async/cancellation surface:

- `setTimeout(fn, ms)` / `clearTimeout(id)`
- `setInterval(fn, ms)` / `clearInterval(id)` (4ms floor)
- `queueMicrotask(fn)`
- `AbortController`, `AbortSignal`, `AbortSignal.abort(reason)`, `AbortSignal.timeout(ms)`, `AbortSignal.any(signals)`

Timers are real wall-clock timers — the wait is performed by the host's worker, not faked inside the VM — so a plugin can use them for debouncing, periodic polling, or per-request timeouts as it would in Node or the browser.

Two caveats:

1. **Scheduled-job deadlines still apply.** A scheduled handler that uses `setTimeout` inside its own body must finish all timer-driven work within the schedule's `maxDurationMs`. The QuickJS interrupt handler aborts the whole fire if it runs over.
2. **Timers are tied to the VM lifecycle.** When a plugin is uninstalled, upgraded, or its worker crashes, every pending timer is cancelled — fires after that point are dropped, not delivered into a dead VM.

## Static assets

Plugins can ship any static file alongside their bundled JS — images, CSS, fonts, JSON, audio, anything. Put them in the plugin zip at any path and the host serves them at `/uploads/plugins/<id>/<version>/<path>` automatically.

To reference an asset from plugin code, use `api.plugin.assetUrl(path)`:

```ts
// server entrypoint
export async function activate(api) {
  api.cms.routes.getPublic('/og.png', async () => ({
    __response: true,
    status: 302,
    headers: { Location: api.plugin.assetUrl('og-image.png') },
  }))
}

// editor / admin / frontend bundles
import type { EditorPluginApi } from '@pagebuilder/plugin-sdk'
export const activate = (api: EditorPluginApi) => {
  document.body.style.backgroundImage = `url(${api.plugin.assetUrl('bg.svg')})`
}
```

`assetUrl` works identically in server, editor, admin, and frontend contexts.

## Resource limits

Each plugin VM has hard caps to keep runaways from degrading the host:

| Limit | Default | Behavior when exceeded |
|---|---|---|
| Heap memory | 64 MB | Allocation throws `OutOfMemory` inside the VM |
| WASM stack | 1 MB | Deep recursion throws `StackOverflow` inside the VM |
| Wall-clock per eval | 5 s | The VM is aborted with `InternalError: interrupted` |

The wall-clock budget applies to every entry point: lifecycle hooks, route handlers, hook listeners, loop fetches, settings updates. If your plugin legitimately needs more time for an external call, emit progress hooks and let the operation chunk — don't block in a tight loop.

These limits live in `server/plugins/quickjsHost.ts`. They are not yet configurable per plugin; if your plugin hits a ceiling, open an issue.

## Build-time validation

`pb-plugin build` scans your bundled server entrypoint and canvas module pack for forbidden literals and fails with a clear error:

```text
✗ Plugin sandbox: bundle for "examples/plugins/showcase/server/index.ts" references forbidden literals: 'node:.
Plugins run inside a QuickJS-WASM sandbox with no access to Node/Bun runtime APIs.
Use the SDK (api.cms.storage.*, api.cms.hooks.*, api.cms.routes.*) for I/O instead.
```

This catches honest mistakes before anything ships. The same scan runs again at install time on the host so unsigned or hand-zipped packages can't slip through.

## Page republish — host-side execution

`api.cms.pages.republish(pageId)` and `api.cms.pages.republishAll()` execute **outside the VM** — the host runs the full publish pipeline (publish.before → publish.html filter → publish.after) directly in the main process. From the plugin's perspective, the call is just an async `__hostCall` that resolves when the republish chain completes.

This means:
- Hook listeners and filter handlers registered by **all** active plugins fire during the republish, not just those of the calling plugin.
- The host, not the VM, drives the pipeline. The plugin's sandbox cannot observe or intercept the HTML pipeline internally — it only receives or transforms the value when its own registered filter runs.
- Large republish batches (`republishAll` on a site with many pages) are synchronous from the plugin's await perspective. Budget the time accordingly. Using `api.cms.schedule` for batch republish tasks (instead of a one-shot `activate` call) is recommended for production plugins.

## Cross-context signaling

When you need to send a value from inside the sandbox out to host code (for tests, dashboards, observers, other plugins), use **hooks**:

```ts
// Plugin
export async function activate(api) {
  await api.cms.hooks.emit('my.plugin.heartbeat', { ts: Date.now() })
}

// Host subscriber (another plugin, or core code)
hookBus.on('observer', 'my.plugin.heartbeat', async (payload) => {
  console.log('heartbeat:', payload)
})
```

This is the sandbox-safe channel for anything you'd reach for `globalThis` or a side-effect file for.

## Architecture

```
┌─ Bun host (main process)
│  ┌─ Bun.Worker (per-plugin crash isolation)
│  │  ┌─ QuickJS-WASM context (security boundary)
│  │  │  ┌─ Bootstrap: SDK facade, console, fetch shim, handler registries
│  │  │  └─ Plugin code: IIFE → globalThis.__plugin_exports
│  │  └─ Single host function: __hostCall(target, args) → Promise
│  └─ postMessage protocol (workerProtocol.ts)
└─ Plugin worker host (api-call dispatch)
```

Source files (for contributors):

- `server/plugins/quickjsHost.ts` — VM bridge for server entrypoints
- `server/plugins/modulePackVm.ts` — VM bridge for canvas module packs
- `server/plugins/pluginWorker.ts` — the Bun.Worker entry
- `server/plugins/pluginWorkerHost.ts` — main-thread api-call dispatch (incl. gated `network.fetch`)
- `src/core/plugins/sandboxScan.ts` — shared forbidden-literal scanner
- `src/__tests__/architecture/plugin-sandbox-invariants.test.ts` — gates that lock in the design

## Threat model

The host's only contract with plugin code is the function set imported into the QuickJS context: `__hostCall(target, args)` and `__log(level, message)`. Everything else — including the SDK that plugins see — is built on top of that single function inside the VM bootstrap. The VM has no other connection to the host process.

A malicious or compromised plugin cannot reach the file system, cannot read `process.env`, cannot make arbitrary network requests, cannot run native code, cannot escape the WebAssembly linear memory. The same boundary holds across operating systems because WebAssembly is a portable specification, not an OS feature.
