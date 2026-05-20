/**
 * Architecture gates for the plugin sandbox.
 *
 * The QuickJS-WASM sandbox is the load-bearing security boundary for
 * plugin code. These tests lock in the invariants that make it real:
 * if any of them fail, the sandbox's guarantees no longer hold.
 *
 * Per CLAUDE.md: "Architectural rules are first-class. When you change a
 * structural rule (folder layout, allowed imports, banned APIs, design
 * tokens), update the matching test in src/__tests__/architecture/."
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

/**
 * Best-effort stripper of `//` line comments, `/* ... *\/` block comments,
 * and string literals. Used by architecture tests that need to scan ACTUAL
 * code for forbidden patterns — strings in docstrings shouldn't count.
 *
 * Not a full parser; nested string/comment edge cases (regex literals
 * containing `//`, template literals with `${}` interpolating code) are
 * handled imperfectly. Good enough for grep-style structural checks.
 */
function stripCommentsAndStrings(source: string): string {
  // Block comments
  let s = source.replace(/\/\*[\s\S]*?\*\//g, ' ')
  // Line comments
  s = s.replace(/\/\/[^\n]*/g, ' ')
  // String literals (single, double, backtick)
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''")
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""')
  s = s.replace(/`(?:\\.|[^`\\])*`/g, '``')
  return s
}

describe('plugin sandbox invariants', () => {
  it('pluginWorker.ts imports the QuickJS bridge (no fallback to dynamic import)', async () => {
    const source = await read('server/plugins/pluginWorker.ts')
    expect(source).toContain("from './quickjsHost'")
    expect(source).toContain('createPluginVm')
    // No dynamic import of arbitrary plugin code in the worker — that was
    // the pre-sandbox RCE pathway. `await import(`...) inside the worker
    // is only ever used for plugin code, so any occurrence here is a bug.
    expect(source).not.toMatch(/await\s+import\s*\(/)
  })

  it('quickjsHost.ts uses sync QuickJS + ctx.newPromise (no asyncified host functions)', async () => {
    const source = await read('server/plugins/quickjsHost.ts')
    // Sync variant — asyncified is known to corrupt VM state on the second
    // async eval (see comment block at the top of quickjsHost.ts).
    expect(source).toContain('getQuickJS')
    expect(source).not.toContain('newQuickJSAsyncWASMModule')
    expect(source).not.toContain('newAsyncifiedFunction')
    // Deferred VM-side Promise pattern is what we rely on.
    expect(source).toContain('ctx.newPromise()')
  })

  it('modulePackVm.ts sandboxes module packs through QuickJS', async () => {
    const source = await read('server/plugins/modulePackVm.ts')
    expect(source).toContain("from 'quickjs-emscripten'")
    expect(source).toContain('newContext')
    // No raw dynamic import of plugin bundles in actual code lines.
    // (Comments may mention historical context — strip them before scanning.)
    const codeOnly = stripCommentsAndStrings(source)
    expect(codeOnly).not.toMatch(/await\s+import\s*\(.*dataUrl/)
  })

  it('server/plugins/runtime.ts loads module packs into a sandboxed VM, not a raw dynamic import', async () => {
    const source = await read('server/plugins/runtime.ts')
    expect(source).toContain('createModulePackVm')
    // The old `await import(dataUrl)` plugin loader path is the exact
    // pattern that bypassed the sandbox. It must not return as live code.
    const codeOnly = stripCommentsAndStrings(source)
    expect(codeOnly).not.toMatch(/await\s+import\s*\(\s*dataUrl/)
    expect(codeOnly).not.toMatch(/\bimport\s*\(\s*dataUrl/)
  })

  it('server entrypoint and module pack bundles are scanned at install time', async () => {
    const source = await read('server/plugins/package.ts')
    expect(source).toContain('assertSandboxSafe')
    // Both server entrypoint AND module pack are sandboxed; both must be
    // scanned. The check below catches a future regression where one is
    // forgotten when adding more sandboxed entrypoints.
    const scanCount = (source.match(/assertSandboxSafe/g) ?? []).length
    expect(scanCount).toBeGreaterThanOrEqual(2)
  })

  it('the SDK build pipeline applies the same sandbox scan at build time', async () => {
    const source = await read('src/core/plugin-sdk/cli/build.ts')
    expect(source).toContain('assertSandboxSafe')
    // Sandboxed bundles must be emitted as IIFE (the format QuickJS can
    // eval). The build pipeline used to ship ESM with `export function …`
    // and rely on a runtime regex shim; the IIFE path makes the contract
    // explicit and removes the regex.
    expect(source).toContain("format: options.sandbox ? 'iife' : 'esm'")
  })

  it('the network.outbound permission is fail-closed without an allowlist', async () => {
    const source = await read('server/plugins/pluginWorkerHost.ts')
    expect(source).toContain('hostMatchesAllowlist')
    // The dispatch case must check both the permission AND the manifest's
    // networkAllowedHosts. Missing either gate would be a security bug.
    expect(source).toMatch(/case\s+'network\.fetch'/)
    expect(source).toContain("assertHostPluginPermission(entry, 'network.outbound')")
    expect(source).toContain('networkAllowedHosts')
  })

  it('worker protocol allows only the documented api-call targets', async () => {
    // ALLOWED_API_TARGETS is the canonical list of dotted RPC names the
    // host accepts from the worker. Anything not in this list is rejected
    // before any side effect. Locking the list down prevents accidental
    // surface expansion.
    //
    // The regex accepts either `export const ALLOWED_API_TARGETS` or a
    // module-private `const ALLOWED_API_TARGETS` — the constant is internal
    // to the protocol module today (consumers reach it via parseApiCall),
    // but the test cares about the *contents* not the visibility.
    const source = await read('server/plugins/workerProtocol.ts')
    const allowedListMatch = source.match(
      /(?:export\s+)?const ALLOWED_API_TARGETS = \[([\s\S]*?)\] as const/,
    )
    expect(allowedListMatch).not.toBeNull()
    const listBody = allowedListMatch![1]
    const literals = (listBody.match(/'[a-z][a-zA-Z.]+'/g) ?? []).map((s) => s.slice(1, -1)).sort()
    expect(literals).toEqual([
      'cms.hooks.emit',
      'cms.hooks.filter',
      'cms.hooks.on',
      'cms.loops.registerSource',
      'cms.media.registerStorageAdapter',
      'cms.media.registerUrlTransformer',
      'cms.media.registerVariantDelegate',
      'cms.routes.register',
      'cms.schedule.cancel',
      'cms.schedule.register',
      'cms.settings.replace',
      'cms.storage.create',
      'cms.storage.delete',
      'cms.storage.list',
      'cms.storage.update',
      'crypto.digest',
      'crypto.signHmac',
      'network.abort',
      'network.fetch',
    ])
  })
})
