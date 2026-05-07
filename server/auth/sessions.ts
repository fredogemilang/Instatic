import type { DbClient } from '../db/client'
import { rowToUser, type AuthUser } from '../repositories/users'
import type { UserRow } from '../types'

const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 60 * 24 * 30

interface SessionUserRow extends UserRow {
  role_slug: string
  role_name: string
  role_description: string
  role_is_system: boolean | number
  role_capabilities_json: unknown
}

function sessionIdleCutoff(now = Date.now()): Date {
  return new Date(now - SESSION_IDLE_TIMEOUT_MS)
}

export async function createSession(
  db: DbClient,
  input: {
    idHash: string
    userId: string
    expiresAt: Date
    ipAddress: string | null
    userAgent: string | null
  },
): Promise<void> {
  await db`
    insert into sessions (id_hash, user_id, expires_at, ip_address, user_agent)
    values (${input.idHash}, ${input.userId}, ${input.expiresAt}, ${input.ipAddress}, ${input.userAgent})
  `
}

export async function findUserBySessionHash(
  db: DbClient,
  idHash: string,
  now = Date.now(),
): Promise<AuthUser | null> {
  const idleCutoff = sessionIdleCutoff(now)
  const currentTime = new Date(now)
  const { rows } = await db<SessionUserRow>`
    select users.id,
           users.email,
           users.email_normalized,
           users.display_name,
           users.password_hash,
           users.status,
           users.role_id,
           users.last_login_at,
           users.created_at,
           users.updated_at,
           users.deleted_at,
           roles.slug as role_slug,
           roles.name as role_name,
           roles.description as role_description,
           roles.is_system as role_is_system,
           roles.capabilities_json as role_capabilities_json
    from sessions
    join users on users.id = sessions.user_id
    join roles on roles.id = users.role_id
    where sessions.id_hash = ${idHash}
      and sessions.revoked_at is null
      and sessions.expires_at > ${currentTime}
      and sessions.last_seen_at > ${idleCutoff}
      and users.status = ${'active'}
      and users.deleted_at is null
    limit 1
  `
  const user = rows[0] ? rowToUser(rows[0]) : null
  if (!user) return null

  await db`
    update sessions
    set last_seen_at = current_timestamp
    where id_hash = ${idHash}
  `
  return user
}

export async function revokeSessionByHash(db: DbClient, idHash: string): Promise<void> {
  await db`
    update sessions
    set revoked_at = current_timestamp
    where id_hash = ${idHash}
  `
}
