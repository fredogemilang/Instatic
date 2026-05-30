import { type TSchema, type Static } from '@sinclair/typebox'
import { safeParseValue } from '@core/utils/typeboxHelpers'

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const res = new Response(JSON.stringify(body), init)
  res.headers.set('content-type', 'application/json')
  return res
}

export function methodNotAllowed(): Response {
  return jsonResponse({ error: 'Method not allowed' }, { status: 405 })
}

export function badRequest(message: string): Response {
  return jsonResponse({ error: message }, { status: 400 })
}

/**
 * Parse and validate a request body against a TypeBox schema. Returns the
 * validated value on success, or null on JSON parse failure or schema mismatch.
 * Callers return `badRequest(msg)` on null.
 */
export async function readValidatedBody<T extends TSchema>(
  req: Request,
  schema: T,
): Promise<Static<T> | null> {
  let raw: unknown
  try { raw = await req.json() } catch { return null }
  const parsed = safeParseValue(schema, raw)
  return parsed.ok ? (parsed.value as Static<T>) : null
}

export function setCookieHeader(res: Response, value: string): Response {
  res.headers.append('set-cookie', value)
  return res
}
