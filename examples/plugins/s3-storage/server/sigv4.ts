/**
 * AWS Signature V4 — minimal implementation for S3 presigned URLs.
 *
 * Spec: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 *
 * Why we don't pull in the AWS SDK:
 *   • The sandbox is QuickJS — no `aws-sdk-js-v3`, no Node modules. Even
 *     if we vendored it, the SDK is ~MB; we only need ~150 lines of
 *     pure JS.
 *   • The signing is straightforward; bringing in the SDK would hide
 *     the canonical-request shape behind layers of abstraction we don't
 *     need (operation-by-operation signers, paginators, retry wrappers).
 *   • Pure JS keeps the bundle small and the audit surface narrow.
 *
 * What this module supports:
 *   • Presigning a single PUT / GET / DELETE / HEAD request as a URL,
 *     with the signature embedded in the query string.
 *   • `service: 's3'` only — that's all the storage adapter needs.
 *   • UNSIGNED-PAYLOAD body hash — necessary for presigned PUTs of
 *     unknown-content (the host streams arbitrary bytes), and matches
 *     what every AWS SDK uses for presigned URLs.
 *
 * What this module does NOT do (out of scope, would expand to MB of code):
 *   • Authorization-header signing (only query-string presigning).
 *   • STS / IAM AssumeRole flows.
 *   • Other AWS services (DynamoDB, Lambda, …).
 *   • Multipart upload completion (the host's executor handles the
 *     per-part PUTs; the adapter's finalizeWrite would issue the
 *     completion POST separately — single-PUT is enough for v1).
 *
 * Crypto comes from the sandbox's `crypto.subtle` — see
 * `server/plugins/quickjsHost.ts` for the host bridge.
 */

// ---------------------------------------------------------------------------
// Byte / hex / encoding utilities
// ---------------------------------------------------------------------------

/**
 * UTF-8 encode a string. The sandbox doesn't ship `TextEncoder` (it's a
 * WHATWG / browser thing), so we roll our own — same shape as the Web
 * Crypto bridge in `quickjsHost.ts`.
 */
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

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

// ---------------------------------------------------------------------------
// SHA-256 + HMAC-SHA256 — host-bridged WebCrypto.
// ---------------------------------------------------------------------------

async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  // crypto.subtle.digest accepts ArrayBuffer / TypedArray / string (the
  // sandbox shim UTF-8 encodes strings for us, but we encode here for
  // explicit byte-control).
  const data = typeof input === 'string' ? utf8(input) : input
  const buf = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(buf)
}

async function hmacSha256(key: Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const dataBytes = typeof data === 'string' ? utf8(data) : data
  const sig = await crypto.subtle.sign({ name: 'HMAC' }, cryptoKey, dataBytes)
  return new Uint8Array(sig)
}

// ---------------------------------------------------------------------------
// URL canonicalisation
// ---------------------------------------------------------------------------

/**
 * AWS Sigv4 canonical query string: keys + values percent-encoded per
 * RFC 3986 (with `=` `&` reserved), sorted by key (then by value).
 *
 * The standard `encodeURIComponent` percent-encodes everything except
 * `A-Z a-z 0-9 _ . ! ~ * ' ( )`. AWS Sigv4 requires the strict RFC 3986
 * unreserved set `A-Z a-z 0-9 - _ . ~` — so we manually re-encode
 * `! * ' ( )` afterwards.
 */
function rfc3986Encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function canonicalQuery(params: Record<string, string>): string {
  const keys = Object.keys(params).sort()
  return keys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(params[k])}`)
    .join('&')
}

/**
 * S3 object keys can contain `/`. AWS Sigv4 for S3 requires the path
 * to be encoded per RFC 3986 EXCEPT for `/` (which stays as the
 * segment separator). All other unreserved chars stay literal.
 *
 * S3 keys typically come from `dispatchUpload.suggestedStoragePath`
 * which is a sanitized `[a-zA-Z0-9_-]` stem — no encoding needed.
 * But if a future caller passes a key with spaces or `+`, the
 * percent-encoding here protects the signature.
 */
function encodeS3Key(key: string): string {
  return key
    .split('/')
    .map((segment) => rfc3986Encode(segment))
    .join('/')
}

// ---------------------------------------------------------------------------
// Sigv4 presign — the public surface this module exposes
// ---------------------------------------------------------------------------

export interface PresignOptions {
  accessKeyId: string
  secretAccessKey: string
  /**
   * Optional STS session token. The sandbox only sees the user-provided
   * settings, so STS isn't supported in v1 — kept here as a documented
   * shape for future "instance profile credentials" support.
   */
  sessionToken?: string
  region: string
  /** S3 endpoint host (no scheme, no path). `<bucket>.s3.<region>.amazonaws.com`
   *  for AWS S3 virtual-hosted-style, or `<account>.r2.cloudflarestorage.com`
   *  for R2, etc. */
  host: string
  /** S3 object key — `key1/key2/file.jpg` style, leading slash stripped. */
  key: string
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD'
  /** Presigned URL expiry, seconds. Capped at 7 days by AWS. */
  expiresInSeconds: number
  /** Optional extra query parameters to include in the signature. */
  extraQuery?: Record<string, string>
}

export interface PresignResult {
  /** The fully-formed `https://<host>/<key>?<signed-query>` URL. */
  url: string
  /** Echoed timestamp; convenient for the caller's bookkeeping. */
  amzDateIso: string
}

/**
 * Compute the AWS Sigv4 signing key for `s3` in a given region/date.
 * Each step is an HMAC-SHA256 chained from the previous result. Keeps
 * the secret IN the first key (`'AWS4' + secret`) and never re-uses
 * the same input twice.
 */
async function s3SigningKey(secret: string, dateStamp: string, region: string): Promise<Uint8Array> {
  const k1 = await hmacSha256(utf8('AWS4' + secret), dateStamp)
  const k2 = await hmacSha256(k1, region)
  const k3 = await hmacSha256(k2, 's3')
  return hmacSha256(k3, 'aws4_request')
}

/**
 * Build a presigned S3 URL valid for `expiresInSeconds`. The signature
 * is the standard Sigv4 V4 over UNSIGNED-PAYLOAD with `host` as the
 * only signed header.
 *
 * For PUTs the host streams the body to this URL directly. The
 * signature is bound to the host header only, so any Content-Type /
 * Content-Length the host adds doesn't break it (those headers are
 * NOT in the SignedHeaders list).
 */
export async function presignS3Url(opts: PresignOptions): Promise<PresignResult> {
  // ── 1. Time stamps ────────────────────────────────────────────────────
  const now = new Date()
  // AWS expects YYYYMMDDTHHmmssZ for x-amz-date and YYYYMMDD for the
  // credential scope's date portion. `toISOString` returns
  // 2026-05-20T10:15:30.123Z — strip the dashes / colons / millis.
  const iso = now.toISOString()
  const amzDate = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  const dateStamp = amzDate.slice(0, 8)

  // ── 2. Credential scope + signed headers ──────────────────────────────
  const credentialScope = `${dateStamp}/${opts.region}/s3/aws4_request`
  // We only sign `host` — anything else the host's fetch adds at runtime
  // (Content-Length, User-Agent, …) is outside the signature, so we don't
  // care if it changes between sign and request.
  const signedHeaders = 'host'

  // ── 3. Canonical query string ─────────────────────────────────────────
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${opts.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(opts.expiresInSeconds),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(opts.sessionToken ? { 'X-Amz-Security-Token': opts.sessionToken } : {}),
    ...(opts.extraQuery ?? {}),
  }
  const canonicalQs = canonicalQuery(query)

  // ── 4. Canonical request ──────────────────────────────────────────────
  const canonicalUri = '/' + encodeS3Key(opts.key)
  const canonicalHeaders = `host:${opts.host}\n`
  // S3 presigned URLs use UNSIGNED-PAYLOAD: the body hash isn't part of
  // the signature, so the same URL works regardless of body content.
  // Critical for PUTs where the host streams arbitrary bytes.
  const payloadHash = 'UNSIGNED-PAYLOAD'
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQs,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  // ── 5. String to sign ─────────────────────────────────────────────────
  const canonicalRequestHash = bytesToHex(await sha256(canonicalRequest))
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, canonicalRequestHash].join('\n')

  // ── 6. Signing key + signature ────────────────────────────────────────
  const signingKey = await s3SigningKey(opts.secretAccessKey, dateStamp, opts.region)
  const signatureBytes = await hmacSha256(signingKey, stringToSign)
  const signature = bytesToHex(signatureBytes)

  // ── 7. Assemble the URL ───────────────────────────────────────────────
  const finalQuery = `${canonicalQs}&X-Amz-Signature=${signature}`
  return {
    url: `https://${opts.host}${canonicalUri}?${finalQuery}`,
    amzDateIso: amzDate,
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

// Each helper is exported so the architecture / unit tests can verify
// individual pieces against AWS's published test vectors. They aren't
// part of the plugin's runtime contract — re-export markers only.
export const __testing = {
  utf8,
  bytesToHex,
  sha256,
  hmacSha256,
  rfc3986Encode,
  canonicalQuery,
  encodeS3Key,
  s3SigningKey,
}
