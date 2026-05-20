/**
 * Google Cloud Storage plugin — Sigv4 correctness.
 *
 * GCS's S3-compat XML API accepts the EXACT same SigV4 the AWS S3
 * plugin uses (algorithm `AWS4-HMAC-SHA256`, scope `<date>/auto/s3/aws4_request`,
 * `UNSIGNED-PAYLOAD` body hash). The signer module is shared verbatim
 * between the AWS S3, Cloudflare R2, and GCS plugins.
 *
 * These tests verify the GCS-specific surface — host, path-style
 * shape, and the `auto` region. The cryptographic primitives are
 * already covered by AWS test vectors in `s3-sigv4.test.ts`.
 */

import { describe, expect, it } from 'bun:test'
import { presignS3Url } from '../../../examples/plugins/gcs-storage/server/sigv4'

describe('GCS Sigv4 signer', () => {
  it('credential scope uses auto/s3 — the S3-compat mode values', async () => {
    const result = await presignS3Url({
      accessKeyId: 'GOOG1ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      secretAccessKey: 'gcssecret',
      region: 'auto',
      host: 'storage.googleapis.com',
      key: 'my-bucket/originals/hero.jpg',
      method: 'PUT',
      expiresInSeconds: 900,
    })
    const url = new URL(result.url)
    const cred = url.searchParams.get('X-Amz-Credential') ?? ''
    expect(cred).toMatch(/^GOOG1ABCDEFGHIJKLMNOPQRSTUVWXYZ\/\d{8}\/auto\/s3\/aws4_request$/)
  })

  it('path-style URL puts bucket as the first segment', async () => {
    const result = await presignS3Url({
      accessKeyId: 'GOOG1KEY',
      secretAccessKey: 'gcssecret',
      region: 'auto',
      host: 'storage.googleapis.com',
      key: 'my-bucket/originals/abc-def.png',
      method: 'GET',
      expiresInSeconds: 60,
    })
    const url = new URL(result.url)
    expect(url.host).toBe('storage.googleapis.com')
    expect(url.pathname).toBe('/my-bucket/originals/abc-def.png')
  })

  it('signature is a 64-char hex string', async () => {
    const result = await presignS3Url({
      accessKeyId: 'GOOG1KEY',
      secretAccessKey: 'gcssecret',
      region: 'auto',
      host: 'storage.googleapis.com',
      key: 'b/k',
      method: 'GET',
      expiresInSeconds: 60,
    })
    expect(new URL(result.url).searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('uses the standard X-Amz-* query parameter set', async () => {
    const result = await presignS3Url({
      accessKeyId: 'GOOG1KEY',
      secretAccessKey: 'gcssecret',
      region: 'auto',
      host: 'storage.googleapis.com',
      key: 'b/k',
      method: 'PUT',
      expiresInSeconds: 60,
    })
    const keys = [...new URL(result.url).searchParams.keys()].sort()
    expect(keys).toEqual([
      'X-Amz-Algorithm',
      'X-Amz-Credential',
      'X-Amz-Date',
      'X-Amz-Expires',
      'X-Amz-Signature',
      'X-Amz-SignedHeaders',
    ])
  })

  it('produces deterministic signatures within the same wall-clock second', async () => {
    const opts = {
      accessKeyId: 'GOOG1KEY',
      secretAccessKey: 'gcssecret',
      region: 'auto',
      host: 'storage.googleapis.com',
      key: 'b/k',
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

  it('S3-compat: same X-Amz-Algorithm header GCS expects for HMAC keys', async () => {
    const result = await presignS3Url({
      accessKeyId: 'GOOG1KEY',
      secretAccessKey: 'gcssecret',
      region: 'auto',
      host: 'storage.googleapis.com',
      key: 'b/k',
      method: 'GET',
      expiresInSeconds: 60,
    })
    // GCS docs explicitly note: "Using AWS4-HMAC-SHA256 indicates that
    // you are using an HMAC V4 signature and you intend to send x-amz-*
    // headers." We use AWS4-HMAC-SHA256, NOT GOOG4-HMAC-SHA256.
    expect(new URL(result.url).searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
  })
})
