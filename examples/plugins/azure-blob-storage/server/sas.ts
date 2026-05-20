/**
 * Azure Storage Service SAS — minimal signer for Blob Storage.
 *
 * Spec: https://learn.microsoft.com/en-us/rest/api/storageservices/create-service-sas
 *
 * Why we don't use the Azure SDK:
 *   • The plugin runs in QuickJS-WASM — no Node/Bun built-ins, no
 *     azure-storage-blob (MB of code), no node_modules.
 *   • The SAS signature is ~60 lines of pure JS over the host's
 *     `crypto.subtle` HMAC-SHA256.
 *
 * What this module supports:
 *   • Service SAS for a single Blob (`sr=b`) — used by beginWrite /
 *     finalizeWrite / abortWrite / delete / getReadUrl.
 *   • Service SAS for a Container (`sr=c`) — used by verify() to list
 *     the container as a connectivity / auth check.
 *   • API version `2024-11-04` (current as of 2026; the string-to-sign
 *     shape has been stable since `2020-12-06`).
 *
 * What this module does NOT do:
 *   • Account SAS (account-wide; we want per-container scoping).
 *   • User Delegation SAS (requires Entra ID OAuth — out of scope; the
 *     plugin uses the account key directly, same as the simplest "Static
 *     Web Apps" / SDK examples).
 *   • Stored Access Policy SAS — the plugin signs ad-hoc.
 *
 * Crypto comes from the sandbox's `crypto.subtle` — see
 * `server/plugins/quickjsHost.ts` for the host bridge.
 */

// ---------------------------------------------------------------------------
// API version
// ---------------------------------------------------------------------------

/**
 * The signedVersion (`sv`) parameter. Drives both the string-to-sign
 * format and the Azure REST API version that's used when the SAS URL
 * is dereferenced. Picking a stable, well-tested version that supports
 * `signedEncryptionScope` (we don't use it, but its presence in the
 * string-to-sign shape is locked since 2020-12-06).
 */
const SIGNED_VERSION = '2024-11-04'

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------
//
// QuickJS doesn't ship btoa/atob. The host's crypto bridge expects
// base64 input + returns base64 output, so we always need to round-trip
// bytes through this encoding. ~30 lines of pure JS, no dependencies.

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64_CHARS[(triplet >> 18) & 0x3f]
      + B64_CHARS[(triplet >> 12) & 0x3f]
      + B64_CHARS[(triplet >> 6) & 0x3f]
      + B64_CHARS[triplet & 0x3f]
  }
  const rem = bytes.length - i
  if (rem === 1) {
    const a = bytes[i]
    out += B64_CHARS[a >> 2] + B64_CHARS[(a << 4) & 0x3f] + '=='
  } else if (rem === 2) {
    const a = bytes[i]
    const b = bytes[i + 1]
    out += B64_CHARS[a >> 2] + B64_CHARS[((a << 4) | (b >> 4)) & 0x3f] + B64_CHARS[(b << 2) & 0x3f] + '='
  }
  return out
}

const B64_DECODE = (() => {
  const table = new Uint8Array(128)
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i
  return table
})()

function base64ToBytes(base64: string): Uint8Array {
  let padded = base64.replace(/[^A-Za-z0-9+/=]/g, '')
  while (padded.length % 4 !== 0) padded += '='
  const padCount = padded.endsWith('==') ? 2 : padded.endsWith('=') ? 1 : 0
  const byteLength = (padded.length * 3) / 4 - padCount
  const out = new Uint8Array(byteLength)
  let o = 0
  for (let i = 0; i < padded.length; i += 4) {
    const a = B64_DECODE[padded.charCodeAt(i)] || 0
    const b = B64_DECODE[padded.charCodeAt(i + 1)] || 0
    const c = padded.charCodeAt(i + 2) === 0x3d ? 0 : (B64_DECODE[padded.charCodeAt(i + 2)] || 0)
    const d = padded.charCodeAt(i + 3) === 0x3d ? 0 : (B64_DECODE[padded.charCodeAt(i + 3)] || 0)
    out[o++] = (a << 2) | (b >> 4)
    if (o < byteLength) out[o++] = ((b << 4) & 0xff) | (c >> 2)
    if (o < byteLength) out[o++] = ((c << 6) & 0xff) | d
  }
  return out
}

// ---------------------------------------------------------------------------
// UTF-8 + HMAC-SHA256 — host-bridged WebCrypto.
// ---------------------------------------------------------------------------

function utf8(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) {
      out.push(c)
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(++i)
      const cp = 0x10000 + (((c & 0x3ff) << 10) | (next & 0x3ff))
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      )
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    }
  }
  return new Uint8Array(out)
}

async function hmacSha256(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const dataBytes = typeof data === 'string' ? utf8(data) : data
  const sig = await crypto.subtle.sign({ name: 'HMAC' }, cryptoKey, dataBytes)
  return new Uint8Array(sig)
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

/**
 * Azure SAS accepts ISO 8601 UTC timestamps. The spec example uses
 * second precision (`2023-05-24T01:13:55Z`), not millisecond precision.
 * `Date.prototype.toISOString` produces millisecond precision, so we
 * strip the `.NNN` fraction.
 */
function iso8601Seconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

// ---------------------------------------------------------------------------
// Endpoint resolution
// ---------------------------------------------------------------------------

/** The DNS suffix per Azure cloud. */
function endpointSuffix(cloud: 'public' | 'usgov' | 'china'): string {
  switch (cloud) {
    case 'usgov': return 'blob.core.usgovcloudapi.net'
    case 'china': return 'blob.core.chinacloudapi.cn'
    case 'public':
    default: return 'blob.core.windows.net'
  }
}

export function azureBlobHost(account: string, cloud: 'public' | 'usgov' | 'china'): string {
  return `${account}.${endpointSuffix(cloud)}`
}

// ---------------------------------------------------------------------------
// Canonicalized resource
// ---------------------------------------------------------------------------

/**
 * For Service SAS on Blob Storage (sv >= 2015-02-21):
 *   `canonicalizedResource = "/blob/<account>/<container>[/<blob>]"`
 *
 * The container and blob portions are URL-decoded. Since the host
 * supplies sanitised storage paths (`[a-zA-Z0-9_-]`) the encode/decode
 * round-trip is a no-op, but we apply `decodeURIComponent` on the blob
 * name to defend against future callers that pass percent-encoded names.
 */
function canonicalizedResource(account: string, container: string, blob: string | null): string {
  const base = `/blob/${account}/${container}`
  if (!blob) return base
  return `${base}/${decodeURIComponent(blob)}`
}

// ---------------------------------------------------------------------------
// String-to-sign — Service SAS, Blob Storage, sv = 2020-12-06+
// ---------------------------------------------------------------------------

interface StringToSignInput {
  signedPermissions: string
  signedStart: string
  signedExpiry: string
  canonicalizedResource: string
  signedIdentifier: string
  signedIP: string
  signedProtocol: string
  signedVersion: string
  signedResource: string
  signedSnapshotTime: string
  signedEncryptionScope: string
  rscc: string
  rscd: string
  rsce: string
  rscl: string
  rsct: string
}

/**
 * Assemble the 16-field string-to-sign required by sv >= 2020-12-06.
 * Each field is on its own line, separated by `\n`. Optional fields
 * are empty strings (NOT omitted) — the trailing newlines are
 * load-bearing for the signature to match Azure's reconstruction.
 */
function buildStringToSign(input: StringToSignInput): string {
  return [
    input.signedPermissions,
    input.signedStart,
    input.signedExpiry,
    input.canonicalizedResource,
    input.signedIdentifier,
    input.signedIP,
    input.signedProtocol,
    input.signedVersion,
    input.signedResource,
    input.signedSnapshotTime,
    input.signedEncryptionScope,
    input.rscc,
    input.rscd,
    input.rsce,
    input.rscl,
    input.rsct,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// URL encoding of blob path
// ---------------------------------------------------------------------------

/**
 * Blob names can contain `/` (used as a virtual folder separator).
 * URL-encoding the path PRESERVES the slashes. The signer applies the
 * canonical resource string with the DECODED blob name, so the
 * actual URL encoding has to keep the slashes intact for the request
 * to hit the right blob.
 */
function encodeBlobPath(blob: string): string {
  return blob.split('/').map((seg) => encodeURIComponent(seg)).join('/')
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface PresignBlobOptions {
  account: string
  accountKeyBase64: string
  cloud: 'public' | 'usgov' | 'china'
  container: string
  /**
   * For `sr === 'b'`: the blob name (path inside the container).
   * For `sr === 'c'`: ignored (pass empty string).
   */
  blob: string
  signedResource: 'b' | 'c'
  /**
   * Permission letters from the blob/container set. Must be in fixed
   * order (`racwd…`). The plugin only uses:
   *   • `r`     — getReadUrl, verify
   *   • `cw`    — beginWrite (Create + Write a new blob)
   *   • `d`     — abortWrite, delete
   *   • `l`     — verify (List blobs in container; used with sr='c')
   */
  permissions: string
  expiresInSeconds: number
}

export interface PresignBlobResult {
  /** Full URL `https://<host>/<container>/<blob>?<sas token>`. */
  url: string
  /** Wall-clock expiry timestamp for the caller's bookkeeping. */
  expiresAtMs: number
}

/**
 * Build a Service SAS URL for a single blob or container. Returns the
 * full `https://…?sas=…` URL the host can dereference directly.
 */
export async function presignAzureBlobUrl(opts: PresignBlobOptions): Promise<PresignBlobResult> {
  // ─── 1. Timestamps ────────────────────────────────────────────────────
  const now = new Date()
  // We omit `signedStart` (st) — Azure interprets a missing st as "valid
  // immediately". Including it would only help clock-skewed clients,
  // and the SAS the host issues is always used within a few seconds.
  const signedStart = ''
  const expiry = new Date(now.getTime() + opts.expiresInSeconds * 1000)
  const signedExpiry = iso8601Seconds(expiry)

  // ─── 2. Canonical resource ────────────────────────────────────────────
  const canonicalResource = canonicalizedResource(
    opts.account,
    opts.container,
    opts.signedResource === 'b' ? opts.blob : null,
  )

  // ─── 3. String-to-sign ────────────────────────────────────────────────
  // Every optional field is an empty string. The trailing-newline
  // requirement (each field on its own line) makes a missing field
  // semantically distinct from "this field with no value".
  const stringToSign = buildStringToSign({
    signedPermissions: opts.permissions,
    signedStart,
    signedExpiry,
    canonicalizedResource: canonicalResource,
    signedIdentifier: '',
    signedIP: '',
    signedProtocol: 'https',
    signedVersion: SIGNED_VERSION,
    signedResource: opts.signedResource,
    signedSnapshotTime: '',
    signedEncryptionScope: '',
    rscc: '',
    rscd: '',
    rsce: '',
    rscl: '',
    rsct: '',
  })

  // ─── 4. HMAC-SHA256(account-key, string-to-sign) → Base64 ─────────────
  const keyBytes = base64ToBytes(opts.accountKeyBase64)
  const sigBytes = await hmacSha256(keyBytes, stringToSign)
  const signature = bytesToBase64(sigBytes)

  // ─── 5. Assemble the URL ──────────────────────────────────────────────
  const query = new URLSearchParams()
  if (signedStart) query.set('st', signedStart)
  query.set('se', signedExpiry)
  query.set('sp', opts.permissions)
  query.set('spr', 'https')
  query.set('sv', SIGNED_VERSION)
  query.set('sr', opts.signedResource)
  query.set('sig', signature)

  const host = azureBlobHost(opts.account, opts.cloud)
  const pathBlob = opts.signedResource === 'b' ? `/${encodeBlobPath(opts.blob)}` : ''
  const pathContainer = `/${opts.container}`
  const url = `https://${host}${pathContainer}${pathBlob}?${query.toString()}`

  return { url, expiresAtMs: expiry.getTime() }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

export const __testing = {
  bytesToBase64,
  base64ToBytes,
  utf8,
  hmacSha256,
  iso8601Seconds,
  canonicalizedResource,
  buildStringToSign,
  encodeBlobPath,
  azureBlobHost,
  endpointSuffix,
  SIGNED_VERSION,
}
