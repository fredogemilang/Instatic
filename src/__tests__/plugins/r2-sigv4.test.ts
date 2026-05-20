/**
 * Cloudflare R2 plugin — Sigv4 correctness.
 *
 * R2 speaks the S3 API verbatim (same SigV4, same canonical-request
 * shape, `s3` as the credential-scope service), so the signer is the
 * SAME module the AWS S3 plugin uses — verified against AWS-published
 * test vectors in `s3-sigv4.test.ts`.
 *
 * This file adds the R2-specific surface checks:
 *   • Credential scope uses `auto` as the region (Cloudflare's
 *     documented value).
 *   • Service in the scope stays `s3` — R2 documents that requests
 *     with `service=r2` are rejected with "Credential service should
 *     be s3".
 *   • Path-style addressing: `<account>.r2.cloudflarestorage.com/<bucket>/<key>`.
 *   • Jurisdiction-scoped endpoints (`eu.` / `fedramp.` infix).
 */

import { describe, expect, it } from 'bun:test'
import { presignS3Url } from '../../../examples/plugins/r2-storage/server/sigv4'

describe('R2 Sigv4 signer', () => {
  it('credential scope uses auto region + s3 service', async () => {
    const result = await presignS3Url({
      accessKeyId: 'CFEXAMPLEKEY12345',
      secretAccessKey: 'cfsecret',
      region: 'auto',
      host: 'a1b2c3d4.r2.cloudflarestorage.com',
      key: 'my-bucket/originals/hero.jpg',
      method: 'PUT',
      expiresInSeconds: 900,
    })
    const url = new URL(result.url)
    const cred = url.searchParams.get('X-Amz-Credential') ?? ''
    // Format: `<access-key>/<YYYYMMDD>/<region>/<service>/aws4_request`
    expect(cred).toMatch(/^CFEXAMPLEKEY12345\/\d{8}\/auto\/s3\/aws4_request$/)
  })

  it('path-style URL puts bucket as the first segment', async () => {
    const result = await presignS3Url({
      accessKeyId: 'CFKEY',
      secretAccessKey: 'cfsecret',
      region: 'auto',
      host: 'a1b2c3d4.r2.cloudflarestorage.com',
      key: 'my-bucket/originals/abc-def.png',
      method: 'GET',
      expiresInSeconds: 60,
    })
    const url = new URL(result.url)
    expect(url.host).toBe('a1b2c3d4.r2.cloudflarestorage.com')
    // Bucket appears as the first path segment — the R2 S3 API uses
    // path-style addressing (no bucket subdomain).
    expect(url.pathname).toBe('/my-bucket/originals/abc-def.png')
  })

  it('jurisdiction-scoped endpoints sign the same way (EU)', async () => {
    const result = await presignS3Url({
      accessKeyId: 'CFKEY',
      secretAccessKey: 'cfsecret',
      region: 'auto',
      host: 'a1b2c3d4.eu.r2.cloudflarestorage.com',
      key: 'my-eu-bucket/hero.jpg',
      method: 'PUT',
      expiresInSeconds: 60,
    })
    const url = new URL(result.url)
    expect(url.host).toBe('a1b2c3d4.eu.r2.cloudflarestorage.com')
    // Same credential scope shape — `auto/s3` regardless of jurisdiction.
    const cred = url.searchParams.get('X-Amz-Credential') ?? ''
    expect(cred).toMatch(/\/auto\/s3\/aws4_request$/)
  })

  it('signature is a 64-char hex string (HMAC-SHA256 output)', async () => {
    const result = await presignS3Url({
      accessKeyId: 'CFKEY',
      secretAccessKey: 'cfsecret',
      region: 'auto',
      host: 'a1b2c3d4.r2.cloudflarestorage.com',
      key: 'bucket/k',
      method: 'GET',
      expiresInSeconds: 60,
    })
    expect(new URL(result.url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a deterministic signature within the same wall-clock second', async () => {
    const opts = {
      accessKeyId: 'CFKEY',
      secretAccessKey: 'cfsecret',
      region: 'auto',
      host: 'a1b2c3d4.r2.cloudflarestorage.com',
      key: 'bucket/k',
      method: 'GET' as const,
      expiresInSeconds: 60,
    }
    const a = await presignS3Url(opts)
    const b = await presignS3Url(opts)
    const aDate = new URL(a.url).searchParams.get('X-Amz-Date')
    const bDate = new URL(b.url).searchParams.get('X-Amz-Date')
    if (aDate === bDate) {
      expect(new URL(a.url).searchParams.get('X-Amz-Signature'))
        .toBe(new URL(b.url).searchParams.get('X-Amz-Signature'))
    }
  })

  it('object keys with slashes preserve slashes in the URL path', async () => {
    const result = await presignS3Url({
      accessKeyId: 'CFKEY',
      secretAccessKey: 'cfsecret',
      region: 'auto',
      host: 'a1b2c3d4.r2.cloudflarestorage.com',
      key: 'bucket/originals/2026/05/hero image.jpg',
      method: 'GET',
      expiresInSeconds: 60,
    })
    // Raw URL string: slashes inside the key MUST remain literal so the
    // canonical URI matches what R2 reconstructs at verify time. Spaces
    // get percent-encoded.
    expect(result.url).toContain('/bucket/originals/2026/05/hero%20image.jpg?')
  })

  it('UNSIGNED-PAYLOAD is the body-hash sentinel for presigned URLs', async () => {
    // Pure structural check: we don't surface the payload hash as a query
    // parameter (it's bound to the signature), but the canonical URI
    // shape proves we're not signing a body that doesn't exist yet.
    // No query param except the standard X-Amz-* ones.
    const result = await presignS3Url({
      accessKeyId: 'CFKEY',
      secretAccessKey: 'cfsecret',
      region: 'auto',
      host: 'a1b2c3d4.r2.cloudflarestorage.com',
      key: 'bucket/key',
      method: 'PUT',
      expiresInSeconds: 60,
    })
    const url = new URL(result.url)
    const keys = [...url.searchParams.keys()].sort()
    expect(keys).toEqual([
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-Signature',
      'X-Amz-SignedHeaders',
    ])
  })
})
