/**
 * Architecture gates for the QuickJS sandbox crypto bridge.
 *
 * Storage / auth plugins (S3, R2, GCS, Azure, OAuth providers, JWT
 * issuers) need SHA-256 + HMAC-SHA256 to produce valid signatures.
 * The host exposes them via a thin `crypto.subtle` shim that follows
 * the WebCrypto subset every plugin author already knows from
 * browsers / Node / Bun.
 *
 * These tests lock the contract in. Three invariants:
 *
 *   1. The api-call allowlist exposes `crypto.digest` + `crypto.signHmac`
 *      (already covered by the broader `plugin-sandbox-invariants` test,
 *      duplicated here so this file stands alone for crypto-specific
 *      regressions).
 *
 *   2. The VM bootstrap exposes the WebCrypto subset — `crypto.subtle.digest`,
 *      `crypto.subtle.importKey`, `crypto.subtle.sign` — and they route
 *      through `__hostCall` (not a pure-JS HMAC vendored in the
 *      bootstrap). The whole point is to use the host's native crypto.
 *
 *   3. The host dispatcher uses Bun's native `crypto.subtle` — NOT a
 *      vendored npm package. A regression that pulled in `crypto-js`
 *      or similar would balloon the host bundle for no gain.
 *
 *   4. No permission gate on either target. Crypto is pure computation
 *      (no I/O, no privilege escalation) — same model as `Math` / `JSON`.
 *      Gating it would force every storage plugin to declare a
 *      permission they don't need.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('sandbox crypto bridge', () => {
  it('worker protocol exposes crypto.digest and crypto.signHmac', async () => {
    const source = await read('server/plugins/workerProtocol.ts')
    expect(source).toContain("'crypto.digest'")
    expect(source).toContain("'crypto.signHmac'")
    // Schemas must exist for both targets — without them the host
    // would accept malformed payloads.
    expect(source).toContain('CryptoDigestArgSchema')
    expect(source).toContain('CryptoSignHmacArgSchema')
  })

  it('VM bootstrap exposes the WebCrypto subset routed through __hostCall', async () => {
    const source = await read('server/plugins/quickjsHost.ts')
    // The three callable surfaces a plugin uses:
    expect(source).toMatch(/globalThis\.crypto\.subtle\s*=\s*\{/)
    expect(source).toMatch(/digest:\s*async function/)
    expect(source).toMatch(/importKey:\s*async function/)
    expect(source).toMatch(/sign:\s*async function/)
    // They must dispatch via __hostCall — NOT a pure-JS HMAC.
    expect(source).toMatch(/__hostCall\(['"]crypto\.digest['"]/)
    expect(source).toMatch(/__hostCall\(['"]crypto\.signHmac['"]/)
  })

  it('host dispatcher uses Bun-native crypto.subtle (no vendored package)', async () => {
    const source = await read('server/plugins/pluginWorkerHost.ts')
    // The two cases must reach into the platform's crypto.subtle.
    expect(source).toMatch(/case 'crypto\.digest'/)
    expect(source).toMatch(/case 'crypto\.signHmac'/)
    expect(source).toContain('crypto.subtle.digest(')
    expect(source).toContain('crypto.subtle.importKey(')
    expect(source).toContain('crypto.subtle.sign(')
    // Sanity: no third-party crypto library snuck in.
    expect(source).not.toContain('crypto-js')
    expect(source).not.toContain('jose')
  })

  it('crypto targets are not permission-gated', async () => {
    const source = await read('server/plugins/pluginWorkerHost.ts')
    // The dispatch cases for storage / hooks / etc. all begin with an
    // `assertHostPluginPermission(...)` call. The crypto cases must NOT
    // — they're pure computation, same model as Math / JSON.
    const cryptoBlock = source.match(/case 'crypto\.digest':[\s\S]*?case 'crypto\.signHmac':[\s\S]*?return\s*\}/)
    expect(cryptoBlock).not.toBeNull()
    expect(cryptoBlock![0]).not.toContain('assertHostPluginPermission')
  })
})
