/**
 * JSON validation helpers backed by Zod.
 *
 * The codebase has many `JSON.parse(raw) as Foo` and `await res.json() as Foo`
 * call sites. The cast is the model lying — the runtime trusts whatever shape
 * happens to come back. Use these helpers at the boundary instead.
 *
 * Surfaced by /audit-types — see #1 in /health-check report.
 */

import type { z } from 'zod'

export type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: z.ZodError }

/**
 * Parse a string as JSON and validate it against a Zod schema.
 *
 * Returns a discriminated union so callers can decide between a hard error and
 * a soft fallback (e.g. for localStorage reads where corrupted data should not
 * brick the editor — fall back to defaults).
 */
export function safeParseJson<T>(
  raw: string,
  schema: z.ZodType<T>,
): JsonParseResult<T> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Treat invalid JSON the same as a failed schema validation. Callers don't
    // need to distinguish "wasn't JSON" from "was JSON but wrong shape" — both
    // mean "discard and use defaults" or "return 400".
    return { ok: false, error: schema.safeParse(undefined).error! }
  }
  const result = schema.safeParse(parsed)
  return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error }
}

/**
 * Convenience: parse a string as JSON and validate, falling back to a default
 * value on any failure. Use for best-effort reads (localStorage, optional
 * config files) where the caller has a reasonable default.
 */
export function parseJsonWithFallback<T>(
  raw: string | null | undefined,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  if (raw == null || raw === '') return fallback
  const result = safeParseJson(raw, schema)
  return result.ok ? result.value : fallback
}

/**
 * Parse and validate a Response body. Returns the value or throws — meant for
 * places where a malformed response is genuinely an error condition (the
 * caller should let it bubble up to a top-level error boundary).
 *
 * The thrown error is a ZodError so callers can inspect `.issues` for
 * field-level diagnostics.
 */
export async function parseJsonResponse<T>(
  res: Response,
  schema: z.ZodType<T>,
): Promise<T> {
  const data = (await res.json()) as unknown
  return schema.parse(data)
}
