/**
 * Cryptographic operation handlers — implements crypto.digest and
 * crypto.signHmac api-calls.
 *
 * No permission gate on either target. Crypto is pure computation (no I/O,
 * no privilege escalation) — same model as Math/JSON exposure. Inputs are
 * size-bounded by the protocol schema.
 *
 * Uses Bun's native `crypto.subtle` (the WHATWG Web Crypto API) — no
 * vendored npm crypto library.
 */

import type { CryptoDigestApiCall, CryptoSignHmacApiCall } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../workerPool'
import { bytesToBase64, base64ToFreshArrayBuffer } from '../network'
import type { HostPluginRecord } from '../types'

export async function handleCryptoDigest(
  msg: CryptoDigestApiCall,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ algorithm, data }] = msg.args
  const dataBytes = base64ToFreshArrayBuffer(data)
  const digest = await crypto.subtle.digest(algorithm, dataBytes)
  replyApiOk(msg.pluginId, msg.correlationId, bytesToBase64(new Uint8Array(digest)))
}

export async function handleCryptoSignHmac(
  msg: CryptoSignHmacApiCall,
  _entry: HostPluginRecord,
  _db: DbClient,
): Promise<void> {
  const [{ hash, key, data }] = msg.args
  const keyBuffer = base64ToFreshArrayBuffer(key)
  const dataBuffer = base64ToFreshArrayBuffer(data)
  const importedKey = await crypto.subtle.importKey(
    'raw',
    keyBuffer,
    { name: 'HMAC', hash },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign({ name: 'HMAC' }, importedKey, dataBuffer)
  replyApiOk(msg.pluginId, msg.correlationId, bytesToBase64(new Uint8Array(signature)))
}
