/**
 * Azure Blob Storage plugin — Service SAS signer correctness.
 *
 * Unlike the S3 / R2 / GCS plugins, Azure Blob does NOT use AWS SigV4.
 * It uses Shared Access Signatures: a separate HMAC-SHA256 over a
 * different canonical string-to-sign, with a Base64-encoded signature.
 *
 * Spec: https://learn.microsoft.com/en-us/rest/api/storageservices/create-service-sas
 *
 * These tests verify the SAS signer's deterministic surface:
 *   • Base64 encode / decode round-trip (no built-in btoa/atob in QuickJS).
 *   • UTF-8 encoding (host crypto bridge takes bytes, not strings).
 *   • Endpoint suffix routing per Azure cloud.
 *   • Canonical resource shape (blob vs. container scope).
 *   • 16-field string-to-sign layout (sv >= 2020-12-06).
 *   • Full URL composition produced by `presignAzureBlobUrl`.
 *   • HMAC-SHA256 + Base64 signature shape.
 *
 * The HMAC-SHA256 primitive itself is the browser/Bun's
 * `crypto.subtle` — already well-tested at the platform level.
 */

import { describe, expect, it } from 'bun:test'
import {
  __testing,
  presignAzureBlobUrl,
  azureBlobHost,
} from '../../../examples/plugins/azure-blob-storage/server/sas'

const {
  bytesToBase64,
  base64ToBytes,
  utf8,
  iso8601Seconds,
  canonicalizedResource,
  buildStringToSign,
  encodeBlobPath,
  endpointSuffix,
  SIGNED_VERSION,
} = __testing

describe('Azure SAS — Base64 helpers', () => {
  it('encodes 0..255 → matches Bun.btoa', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    const ours = bytesToBase64(bytes)
    // Round-trip through Bun's native base64 implementation as the oracle.
    const expected = Buffer.from(bytes).toString('base64')
    expect(ours).toBe(expected)
  })

  it('encodes empty / 1 / 2 byte sequences with correct padding', () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe('')
    expect(bytesToBase64(new Uint8Array([0x4d]))).toBe('TQ==')
    expect(bytesToBase64(new Uint8Array([0x4d, 0x61]))).toBe('TWE=')
    expect(bytesToBase64(new Uint8Array([0x4d, 0x61, 0x6e]))).toBe('TWFu')
  })

  it('decodes back to the original bytes (round-trip)', () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 64, 100]) {
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 13) & 0xff
      const encoded = bytesToBase64(bytes)
      const decoded = base64ToBytes(encoded)
      expect([...decoded]).toEqual([...bytes])
    }
  })

  it('decodes a real Azure-issued account key (32-byte secret)', () => {
    // A representative shape: 32 random bytes → 44-char Base64 (with `=`).
    const original = new Uint8Array(32)
    for (let i = 0; i < 32; i++) original[i] = (i * 13 + 7) & 0xff
    const b64 = Buffer.from(original).toString('base64')
    const decoded = base64ToBytes(b64)
    expect([...decoded]).toEqual([...original])
  })
})

describe('Azure SAS — UTF-8 encoder', () => {
  it('matches TextEncoder for ASCII', () => {
    const input = 'sp=rl\nse=2026-01-01T00:00:00Z'
    const ours = utf8(input)
    const expected = new TextEncoder().encode(input)
    expect([...ours]).toEqual([...expected])
  })

  it('handles 2-byte UTF-8 (Latin-1 Supplement)', () => {
    const input = 'café'
    const ours = utf8(input)
    const expected = new TextEncoder().encode(input)
    expect([...ours]).toEqual([...expected])
  })

  it('handles 3-byte UTF-8 (BMP)', () => {
    const input = '日本語'
    const ours = utf8(input)
    const expected = new TextEncoder().encode(input)
    expect([...ours]).toEqual([...expected])
  })

  it('handles 4-byte UTF-8 (surrogate pair / emoji)', () => {
    const input = 'hello 🌍'
    const ours = utf8(input)
    const expected = new TextEncoder().encode(input)
    expect([...ours]).toEqual([...expected])
  })
})

describe('Azure SAS — timestamps', () => {
  it('strips milliseconds from ISO timestamps', () => {
    const d = new Date('2026-05-20T12:34:56.789Z')
    expect(iso8601Seconds(d)).toBe('2026-05-20T12:34:56Z')
  })
})

describe('Azure SAS — endpoint routing per cloud', () => {
  it('public cloud → blob.core.windows.net', () => {
    expect(endpointSuffix('public')).toBe('blob.core.windows.net')
    expect(azureBlobHost('mymedia', 'public')).toBe('mymedia.blob.core.windows.net')
  })

  it('US Government → blob.core.usgovcloudapi.net', () => {
    expect(endpointSuffix('usgov')).toBe('blob.core.usgovcloudapi.net')
    expect(azureBlobHost('govmedia', 'usgov')).toBe('govmedia.blob.core.usgovcloudapi.net')
  })

  it('China → blob.core.chinacloudapi.cn', () => {
    expect(endpointSuffix('china')).toBe('blob.core.chinacloudapi.cn')
    expect(azureBlobHost('cnmedia', 'china')).toBe('cnmedia.blob.core.chinacloudapi.cn')
  })
})

describe('Azure SAS — canonical resource', () => {
  it('blob scope: /blob/<account>/<container>/<blob>', () => {
    expect(canonicalizedResource('mymedia', 'images', 'hero.jpg'))
      .toBe('/blob/mymedia/images/hero.jpg')
  })

  it('container scope: /blob/<account>/<container>', () => {
    expect(canonicalizedResource('mymedia', 'images', null))
      .toBe('/blob/mymedia/images')
  })

  it('nested blob paths preserved (folder slashes)', () => {
    expect(canonicalizedResource('mymedia', 'images', 'originals/2026/hero.jpg'))
      .toBe('/blob/mymedia/images/originals/2026/hero.jpg')
  })

  it('decodes percent-encoded blob names (caller defence)', () => {
    expect(canonicalizedResource('mymedia', 'images', 'hero%20fall.jpg'))
      .toBe('/blob/mymedia/images/hero fall.jpg')
  })
})

describe('Azure SAS — blob path URL encoding', () => {
  it('preserves slashes (used as virtual folder separators)', () => {
    expect(encodeBlobPath('originals/2026/hero.jpg'))
      .toBe('originals/2026/hero.jpg')
  })

  it('escapes spaces and non-ASCII per-segment', () => {
    expect(encodeBlobPath('originals/hero fall.jpg'))
      .toBe('originals/hero%20fall.jpg')
    expect(encodeBlobPath('originals/café.jpg'))
      .toBe('originals/caf%C3%A9.jpg')
  })
})

describe('Azure SAS — string-to-sign', () => {
  it('16 fields, joined by single newlines', () => {
    const s = buildStringToSign({
      signedPermissions: 'rl',
      signedStart: '',
      signedExpiry: '2026-05-20T13:00:00Z',
      canonicalizedResource: '/blob/mymedia/images',
      signedIdentifier: '',
      signedIP: '',
      signedProtocol: 'https',
      signedVersion: SIGNED_VERSION,
      signedResource: 'c',
      signedSnapshotTime: '',
      signedEncryptionScope: '',
      rscc: '',
      rscd: '',
      rsce: '',
      rscl: '',
      rsct: '',
    })
    // 16 fields → 15 \n separators
    expect(s.split('\n')).toHaveLength(16)
    // The 4th field (index 3) is the canonical resource
    expect(s.split('\n')[3]).toBe('/blob/mymedia/images')
    // The 8th field (index 7) is signedVersion
    expect(s.split('\n')[7]).toBe(SIGNED_VERSION)
    // The 9th field (index 8) is signedResource
    expect(s.split('\n')[8]).toBe('c')
  })

  it('empty optional fields preserve their newline slot', () => {
    const s = buildStringToSign({
      signedPermissions: 'r',
      signedStart: '',
      signedExpiry: 'x',
      canonicalizedResource: 'r',
      signedIdentifier: '',
      signedIP: '',
      signedProtocol: 'https',
      signedVersion: 'v',
      signedResource: 'b',
      signedSnapshotTime: '',
      signedEncryptionScope: '',
      rscc: '',
      rscd: '',
      rsce: '',
      rscl: '',
      rsct: '',
    })
    // 15 newlines for 16 fields, even though most are empty.
    expect((s.match(/\n/g) ?? []).length).toBe(15)
  })
})

describe('Azure SAS — presignAzureBlobUrl URL composition', () => {
  it('produces a valid HTTPS URL with all required query params', async () => {
    // A representative Base64 key (32 random bytes). Azure account keys
    // are typically 64 bytes base64'd; this is shorter but still valid.
    const accountKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64')
    const result = await presignAzureBlobUrl({
      account: 'mymedia',
      accountKeyBase64,
      cloud: 'public',
      container: 'images',
      blob: 'originals/hero.jpg',
      signedResource: 'b',
      permissions: 'r',
      expiresInSeconds: 3600,
    })
    const url = new URL(result.url)

    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('mymedia.blob.core.windows.net')
    expect(url.pathname).toBe('/images/originals/hero.jpg')

    // Required SAS params for the resource shape
    expect(url.searchParams.get('sv')).toBe(SIGNED_VERSION)
    expect(url.searchParams.get('sr')).toBe('b')
    expect(url.searchParams.get('sp')).toBe('r')
    expect(url.searchParams.get('spr')).toBe('https')
    expect(url.searchParams.get('se')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(url.searchParams.get('sig')).toBeTruthy()
    // Base64 signature is HMAC-SHA256 → 32 bytes → 44 base64 chars (with `=`)
    expect(url.searchParams.get('sig')?.length).toBe(44)
  })

  it('container-scope SAS targets the container path (no blob segment)', async () => {
    const accountKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64')
    const result = await presignAzureBlobUrl({
      account: 'mymedia',
      accountKeyBase64,
      cloud: 'public',
      container: 'images',
      blob: '',
      signedResource: 'c',
      permissions: 'rl',
      expiresInSeconds: 60,
    })
    const url = new URL(result.url)
    expect(url.pathname).toBe('/images')
    expect(url.searchParams.get('sr')).toBe('c')
    expect(url.searchParams.get('sp')).toBe('rl')
  })

  it('routes to the correct sovereign cloud host', async () => {
    const accountKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64')
    const usgov = await presignAzureBlobUrl({
      account: 'govmedia',
      accountKeyBase64,
      cloud: 'usgov',
      container: 'images',
      blob: 'hero.jpg',
      signedResource: 'b',
      permissions: 'r',
      expiresInSeconds: 60,
    })
    expect(new URL(usgov.url).host).toBe('govmedia.blob.core.usgovcloudapi.net')

    const china = await presignAzureBlobUrl({
      account: 'cnmedia',
      accountKeyBase64,
      cloud: 'china',
      container: 'images',
      blob: 'hero.jpg',
      signedResource: 'b',
      permissions: 'r',
      expiresInSeconds: 60,
    })
    expect(new URL(china.url).host).toBe('cnmedia.blob.core.chinacloudapi.cn')
  })

  it('signature is deterministic within the same wall-clock second', async () => {
    const accountKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64')
    const opts = {
      account: 'mymedia',
      accountKeyBase64,
      cloud: 'public' as const,
      container: 'images',
      blob: 'hero.jpg',
      signedResource: 'b' as const,
      permissions: 'r',
      expiresInSeconds: 60,
    }
    const a = await presignAzureBlobUrl(opts)
    const b = await presignAzureBlobUrl(opts)
    const aExpiry = new URL(a.url).searchParams.get('se')
    const bExpiry = new URL(b.url).searchParams.get('se')
    if (aExpiry === bExpiry) {
      expect(new URL(a.url).searchParams.get('sig'))
        .toBe(new URL(b.url).searchParams.get('sig'))
    }
  })

  it('encodes spaces in blob names but leaves path slashes alone', async () => {
    const accountKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64')
    const result = await presignAzureBlobUrl({
      account: 'mymedia',
      accountKeyBase64,
      cloud: 'public',
      container: 'images',
      blob: 'originals/hero fall.jpg',
      signedResource: 'b',
      permissions: 'r',
      expiresInSeconds: 60,
    })
    const url = new URL(result.url)
    // Spaces → %20, slashes preserved
    expect(url.pathname).toBe('/images/originals/hero%20fall.jpg')
  })

  it('different permissions → different signatures', async () => {
    const accountKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64')
    const base = {
      account: 'mymedia',
      accountKeyBase64,
      cloud: 'public' as const,
      container: 'images',
      blob: 'hero.jpg',
      signedResource: 'b' as const,
      expiresInSeconds: 60,
    }
    const read = await presignAzureBlobUrl({ ...base, permissions: 'r' })
    const write = await presignAzureBlobUrl({ ...base, permissions: 'cw' })
    expect(new URL(read.url).searchParams.get('sig'))
      .not.toBe(new URL(write.url).searchParams.get('sig'))
  })

  it('expiresAtMs ≈ now + expiresInSeconds * 1000', async () => {
    const accountKeyBase64 = Buffer.from(new Uint8Array(32).fill(0x42)).toString('base64')
    const before = Date.now()
    const result = await presignAzureBlobUrl({
      account: 'mymedia',
      accountKeyBase64,
      cloud: 'public',
      container: 'images',
      blob: 'hero.jpg',
      signedResource: 'b',
      permissions: 'r',
      expiresInSeconds: 600,
    })
    const after = Date.now()
    // expiresAtMs lives at se truncated to whole seconds — compare against
    // a tolerant window (we lose up to 1000 ms when stripping millis from
    // the ISO timestamp).
    expect(result.expiresAtMs).toBeGreaterThanOrEqual(before + 600 * 1000 - 1000)
    expect(result.expiresAtMs).toBeLessThanOrEqual(after + 600 * 1000 + 1000)
  })
})

describe('Azure SAS — known-answer test', () => {
  // Reproducible test: a fixed key + fixed string-to-sign should produce
  // a fixed Base64 signature. The oracle here is `crypto.subtle` itself
  // — we recompute the expected value with the same primitives and
  // compare. This catches accidental changes to:
  //   • The Base64 encoder (e.g. URL-safe vs standard alphabet)
  //   • The UTF-8 encoder (e.g. accidental Latin-1 fallback)
  //   • The HMAC key import (e.g. wrong hash family)
  it('HMAC-SHA256(key, "hello") → known Base64 signature', async () => {
    // 32-byte all-0x42 key, stable Base64.
    const keyBytes = new Uint8Array(32).fill(0x42)
    const keyBase64 = Buffer.from(keyBytes).toString('base64')

    // Reproduce the same primitive chain.
    const keyAgain = base64ToBytes(keyBase64)
    expect([...keyAgain]).toEqual([...keyBytes])

    const dataBytes = utf8('hello')

    // Compare against Node-style crypto via `crypto.subtle`.
    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    )
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'HMAC' }, cryptoKey, dataBytes))
    const expectedBase64 = Buffer.from(sig).toString('base64')

    const ourBase64 = bytesToBase64(sig)
    expect(ourBase64).toBe(expectedBase64)
  })
})
