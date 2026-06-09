/**
 * Master encryption key bootstrap for the AI credential store.
 *
 * The master key is a 32-byte (256-bit) AES key used by `encryption.ts` to
 * encrypt every AI provider credential at rest. It is loaded once at boot
 * and cached for the lifetime of the process.
 *
 * Source priority:
 *
 *   1. `INSTATIC_SECRET_KEY` environment variable (base64).
 *      Production deployments MUST set this. If unset in production
 *      (`NODE_ENV=production`), boot fails loudly with instructions.
 *
 *   2. `.tmp/secret.key` file in the working directory.
 *      Dev / non-production fallback. Auto-created on first boot so a fresh
 *      `bun run dev` works without manual setup. The file is intentionally
 *      under `.tmp/` (already git-ignored).
 *
 * Key rotation: replace the env var or `.tmp/secret.key` file and restart.
 * Existing credential rows whose `key_fingerprint` no longer matches will be
 * flagged in the UI as "needs re-entry". There is no second-key migration
 * path in v1 — the operator re-enters each API key.
 *
 * @see docs/plans/2026-05-26-ai-runtime-rewrite.md → "Encryption"
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

const REQUIRED_KEY_BYTES = 32 // 256-bit AES key
const DEV_KEY_PATH = '.tmp/secret.key'
const ENV_VAR_NAME = 'INSTATIC_SECRET_KEY'

let cachedKey: CryptoKey | null = null
let cachedFingerprint: string | null = null

export class MasterKeyConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'MasterKeyConfigurationError'
  }
}

/**
 * Load (and cache) the AES-256 master key as a non-extractable `CryptoKey`.
 *
 * Safe to call repeatedly — the underlying secret is read once.
 */
export async function loadMasterKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey
  const rawBytes = readMasterKeyBytes()
  cachedKey = await crypto.subtle.importKey(
    'raw',
    rawBytes as BufferSource,
    { name: 'AES-GCM' },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  )
  cachedFingerprint = await computeMasterKeyFingerprint(rawBytes)
  return cachedKey
}

/**
 * Returns the fingerprint of the currently-loaded master key — the first 16
 * hex chars of SHA-256(rawKeyBytes). Stored on every credential row so the
 * UI can detect key rotation and prompt the user to re-enter.
 *
 * Lazily ensures the key is loaded first (since the fingerprint is computed
 * inside `loadMasterKey`).
 */
export async function getMasterKeyFingerprint(): Promise<string> {
  if (!cachedFingerprint) {
    await loadMasterKey()
  }
  if (!cachedFingerprint) {
    throw new Error('[ai/masterKey] Fingerprint unavailable after loadMasterKey().')
  }
  return cachedFingerprint
}

/**
 * Test-only: reset the cached key so the next loadMasterKey() picks up a
 * different env value or file contents. Production code MUST NOT call this.
 */
export function __resetMasterKeyCacheForTesting(): void {
  cachedKey = null
  cachedFingerprint = null
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readMasterKeyBytes(): Uint8Array {
  const envValue = process.env[ENV_VAR_NAME]
  if (envValue && envValue.trim()) {
    return parseAndValidateBase64(envValue.trim(), `env var ${ENV_VAR_NAME}`)
  }

  if (process.env.NODE_ENV === 'production') {
    throw new MasterKeyConfigurationError(
      `[ai/masterKey] ${ENV_VAR_NAME} is required in production. ` +
      'Generate one with: bun run scripts/generate-secret-key.ts',
    )
  }

  return readOrCreateDevKey(DEV_KEY_PATH)
}

function readOrCreateDevKey(path: string): Uint8Array {
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim()
    return parseAndValidateBase64(raw, `file ${path}`)
  }
  const fresh = crypto.getRandomValues(new Uint8Array(REQUIRED_KEY_BYTES))
  const dir = dirname(path)
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  const base64 = bytesToBase64(fresh)
  writeFileSync(path, base64 + '\n', 'utf8')
  // 0600 — owner read/write only; defence-in-depth against accidental
  // exposure when the file system is shared.
  try { chmodSync(path, 0o600) } catch { /* best-effort on POSIX */ }
  console.warn(
    `[ai/masterKey] Generated a new dev master key at ${path}. ` +
    `Set ${ENV_VAR_NAME} for production.`,
  )
  return fresh
}

function parseAndValidateBase64(value: string, source: string): Uint8Array {
  let bytes: Uint8Array
  try {
    bytes = base64ToBytes(value)
  } catch (err) {
    throw new MasterKeyConfigurationError(
      `[ai/masterKey] ${source} is not valid base64. ` +
      'Generate a new key with: bun run scripts/generate-secret-key.ts',
      { cause: err },
    )
  }
  if (bytes.length !== REQUIRED_KEY_BYTES) {
    throw new MasterKeyConfigurationError(
      `[ai/masterKey] ${source} decoded to ${bytes.length} bytes; ` +
      `must be exactly ${REQUIRED_KEY_BYTES}. ` +
      'Generate a new key with: bun run scripts/generate-secret-key.ts',
    )
  }
  return bytes
}

async function computeMasterKeyFingerprint(keyBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', keyBytes as BufferSource)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  // 16 hex chars = 8 bytes (64 bits) — collision-resistant enough to
  // distinguish a rotated key without leaking the key itself.
  return hex.slice(0, 16)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}
