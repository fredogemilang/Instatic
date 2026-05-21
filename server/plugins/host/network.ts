/**
 * Gated outbound fetch — kernel-of-correctness for the `network.outbound`
 * permission.
 *
 * Two checks happen here:
 *  1. The plugin must have `network.outbound` granted (enforced by the
 *     caller via `assertHostPluginPermission`).
 *  2. The URL's host must match an entry in `manifest.networkAllowedHosts`
 *     (or a `*.<domain>` wildcard from that list). If `networkAllowedHosts`
 *     is empty or missing, ALL outbound is denied — fail-closed.
 *
 * Returns a JSON-serializable response shape the VM-side `fetch` shim
 * reconstructs into a Response-like object.
 *
 * Also provides base64 helpers used by the crypto bridge.
 */

import type { HostPluginRecord } from './types'

export interface SerializedNetworkResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  body: string
}

export function hostMatchesAllowlist(host: string, allowlist: ReadonlyArray<string>): boolean {
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

export async function performGatedFetch(
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

// ---------------------------------------------------------------------------
// Base64 helpers — wire format for binary payloads on the crypto bridge.
// JSON can't carry Uint8Array; base64 is the smallest portable encoding.
// Bun ships native btoa / atob (WHATWG-spec), which are byte-oriented
// despite the "binary string" misnomer — exactly what we want here.
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
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
export function base64ToFreshArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const buffer = new ArrayBuffer(binary.length)
  const view = new Uint8Array(buffer)
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
  return buffer
}
