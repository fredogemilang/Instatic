/**
 * Shared helpers used by every handler in `server/handlers/cms/*`.
 *
 * - Body readers (`readString`, `readObject`, `readNullableString`,
 *   `readValidatedBody`) — narrow `Record<string, unknown>` access into
 *   the typed shape each route expects.
 * - `requestAuditContext` — the `(ipAddress, userAgent)` pair every audit
 *   event carries.
 * - `mutationErrorResponse` — translates the typed mutation errors thrown
 *   by repositories (`UserMutationError`, `RoleMutationError`) into the
 *   `{ error }` JSON envelope clients expect.
 *
 * These helpers are intentionally small and dependency-free so any new
 * handler module can pull them in without dragging the rest of the CMS
 * surface along with it.
 */
import type { Static, TSchema } from '@sinclair/typebox'
import { Type, Value } from '@core/utils/typeboxHelpers'
import { jsonResponse, readJsonObject } from '../../http'
import { clientIp } from '../../auth/security'
import { UserMutationError } from '../../repositories/users'
import { RoleMutationError } from '../../repositories/roles'

export const CMS_API_PREFIX = '/admin/api/cms'

export const UserStatusSchema = Type.Union([Type.Literal('active'), Type.Literal('suspended')])

export interface CmsHandlerOptions {
  uploadsDir?: string
}

export function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  return typeof value === 'string' ? value.trim() : ''
}

export async function readValidatedBody<T extends TSchema>(
  req: Request,
  schema: T,
): Promise<Static<T> | null> {
  const body = await readJsonObject(req)
  return Value.Check(schema, body) ? Value.Decode(schema, body) as Static<T> : null
}

export function readObject<T>(body: Record<string, unknown>, key: string): T | undefined {
  const value = body[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as T
    : undefined
}

export function requestAuditContext(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: clientIp(req),
    userAgent: req.headers.get('user-agent'),
  }
}

export function mutationErrorResponse(err: unknown): Response {
  if (err instanceof UserMutationError || err instanceof RoleMutationError) {
    return jsonResponse({ error: err.message }, { status: err.status })
  }
  throw err
}
