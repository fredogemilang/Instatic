/**
 * User management endpoints (gated by `users.manage`).
 *
 *   GET    /admin/api/cms/users      — list every user with their role
 *   POST   /admin/api/cms/users      — create a user (rejects role=owner)
 *   PATCH  /admin/api/cms/users/:id  — update fields, change password, change role
 *   DELETE /admin/api/cms/users/:id  — soft delete a user
 *
 * Owner-account guards live here too: this is where we refuse to let an
 * actor strip the last active owner of the role, suspend them, or delete
 * them — and where we refuse to assign the owner role to a new user.
 *
 * `handleUsersRoutes` is the dispatcher; one function below per URL pattern
 * owns its own method-routing, body-parsing, and audit emission.
 */
import type { DbClient } from '../../db/client'
import { hashPassword } from '../../auth/tokens'
import { getSessionHash, requireCapability, requireStepUp } from '../../auth/authz'
import type { AuthUser } from '../../repositories/users'
import { createAuditEvent } from '../../repositories/audit'
import { revokeAllOtherSessions } from '../../repositories/sessions'
import {
  countActiveOwners,
  createUser,
  findUserById,
  listUsers,
  softDeleteUser,
  updateUser,
} from '../../repositories/users'
import type { UserStatus } from '../../types'
import { Type } from '@core/utils/typeboxHelpers'
import { badRequest, jsonResponse, methodNotAllowed, readValidatedBody } from '../../http'
import {
  CMS_API_PREFIX,
  UserStatusSchema,
  mutationErrorResponse,
  requestAuditContext,
} from './shared'

const UserCreateBodySchema = Type.Object({
  email: Type.String(),
  displayName: Type.Optional(Type.String()),
  password: Type.String(),
  roleId: Type.String(),
  status: Type.Optional(UserStatusSchema),
})

const UserPatchBodySchema = Type.Partial(Type.Object({
  email: Type.String(),
  displayName: Type.String(),
  password: Type.String(),
  roleId: Type.String(),
  status: UserStatusSchema,
}))

// ---------------------------------------------------------------------------
// Owner-guard helpers
// ---------------------------------------------------------------------------

async function rejectsLastOwnerRemoval(
  db: DbClient,
  userId: string,
  next: { roleId?: string; status?: UserStatus; delete?: boolean },
): Promise<boolean> {
  const current = await findUserById(db, userId)
  if (!current) return false
  if (current.role.slug !== 'owner' || current.status !== 'active') return false
  const removesOwnerRole = next.delete || next.roleId !== undefined && next.roleId !== 'owner'
  const deactivatesOwner = next.status !== undefined && next.status !== 'active'
  return (removesOwnerRole || deactivatesOwner) && await countActiveOwners(db) <= 1
}

function rejectsOwnerRoleAssignment(roleId: string | undefined): Response | null {
  return roleId === 'owner'
    ? jsonResponse({ error: 'Owner role is setup-only' }, { status: 400 })
    : null
}

const USER_NOT_FOUND_BODY = { error: 'User not found' }

function userNotFound(): Response {
  return jsonResponse(USER_NOT_FOUND_BODY, { status: 404 })
}

const PASSWORD_MIN_LENGTH = 12

function rejectsShortPassword(password: string | undefined): Response | null {
  if (password === undefined) return null
  return password.length >= PASSWORD_MIN_LENGTH
    ? null
    : badRequest(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
}

// ---------------------------------------------------------------------------
// Per-route handlers
// ---------------------------------------------------------------------------

async function handleUsersCollection(
  req: Request,
  db: DbClient,
  actor: AuthUser,
): Promise<Response> {
  if (req.method === 'GET') {
    return jsonResponse({ users: await listUsers(db) })
  }

  if (req.method === 'POST') {
    const stepUp = await requireStepUp(req, db)
    if (stepUp instanceof Response) return stepUp

    const body = await readValidatedBody(req, UserCreateBodySchema)
    if (!body) return badRequest('Invalid user payload')
    const passwordError = rejectsShortPassword(body.password)
    if (passwordError) return passwordError
    const ownerRoleError = rejectsOwnerRoleAssignment(body.roleId)
    if (ownerRoleError) return ownerRoleError

    try {
      const user = await createUser(db, {
        email: body.email,
        displayName: body.displayName ?? body.email,
        passwordHash: await hashPassword(body.password),
        roleId: body.roleId,
        status: body.status,
      })
      await createAuditEvent(db, {
        actorUserId: actor.id,
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        metadata: { roleId: body.roleId },
        ...requestAuditContext(req),
      })
      return jsonResponse({ user }, { status: 201 })
    } catch (err) {
      return mutationErrorResponse(err)
    }
  }

  return methodNotAllowed()
}

async function handleUserPatch(
  req: Request,
  db: DbClient,
  actor: AuthUser,
  userId: string,
): Promise<Response> {
  const stepUp = await requireStepUp(req, db)
  if (stepUp instanceof Response) return stepUp

  const body = await readValidatedBody(req, UserPatchBodySchema)
  if (!body) return badRequest('Invalid user payload')

  const passwordError = rejectsShortPassword(body.password)
  if (passwordError) return passwordError

  const currentUser = await findUserById(db, userId)
  if (!currentUser) return userNotFound()

  // The Owner row is identity-anchored: only the Owner themself can mutate
  // it. Without this guard, any actor with `users.manage` (e.g. admin) could
  // overwrite the Owner's password_hash / email and seize the Owner identity.
  if (currentUser.role.slug === 'owner' && actor.id !== currentUser.id) {
    return jsonResponse({ error: 'Only the owner can modify the owner account' }, { status: 403 })
  }

  const ownerRoleError = rejectsOwnerRoleAssignment(body.roleId)
  if (ownerRoleError) return ownerRoleError

  if (
    body.roleId !== undefined &&
    userId === actor.id &&
    currentUser.role.slug === 'owner' &&
    body.roleId !== currentUser.role.id
  ) {
    return jsonResponse({ error: 'Owner cannot change their own role' }, { status: 409 })
  }

  if (
    body.status !== undefined &&
    (await rejectsLastOwnerRemoval(db, userId, { status: body.status }))
  ) {
    return jsonResponse({ error: 'Cannot suspend the last active owner' }, { status: 409 })
  }

  if (
    body.roleId !== undefined &&
    (await rejectsLastOwnerRemoval(db, userId, { roleId: body.roleId }))
  ) {
    return jsonResponse({ error: 'Cannot remove the last active owner' }, { status: 409 })
  }

  try {
    const user = await updateUser(db, userId, {
      email: body.email,
      displayName: body.displayName,
      passwordHash: body.password ? await hashPassword(body.password) : undefined,
      roleId: body.roleId,
      status: body.status,
    })
    if (!user) return userNotFound()
    const revokedSessions = body.password !== undefined
      ? await revokeAllOtherSessions(
        db,
        userId,
        userId === actor.id ? await getSessionHash(req) : null,
      )
      : 0

    const action = body.password !== undefined
      ? 'password.change'
      : body.status === 'suspended'
        ? 'user.suspend'
        : 'user.update'
    await createAuditEvent(db, {
      actorUserId: actor.id,
      action,
      targetType: 'user',
      targetId: user.id,
      metadata: {
        passwordChanged: body.password !== undefined,
        roleId: body.roleId ?? user.role.id,
        status: body.status ?? user.status,
        revokedSessions,
      },
      ...requestAuditContext(req),
    })

    if (body.roleId !== undefined) {
      await createAuditEvent(db, {
        actorUserId: actor.id,
        action: 'role.assign',
        targetType: 'user',
        targetId: user.id,
        metadata: { roleId: body.roleId },
        ...requestAuditContext(req),
      })
    }
    return jsonResponse({ user })
  } catch (err) {
    return mutationErrorResponse(err)
  }
}

async function handleUserDelete(
  req: Request,
  db: DbClient,
  actor: AuthUser,
  userId: string,
): Promise<Response> {
  // Step-up gate — deleting another user is one of the highest-blast-radius
  // actions in the admin. Capability check (`users.manage`) already ran;
  // this enforces a fresh password re-entry on top.
  const stepUp = await requireStepUp(req, db)
  if (stepUp instanceof Response) return stepUp

  const target = await findUserById(db, userId)
  if (!target) return userNotFound()

  // Symmetric to the PATCH guard: only the Owner themself can delete the
  // Owner account. `rejectsLastOwnerRemoval` only blocks deleting the
  // *last* owner, so if multi-owner is ever introduced the takeover
  // surface would re-open without this row-level check.
  if (target.role.slug === 'owner' && actor.id !== target.id) {
    return jsonResponse({ error: 'Only the owner can delete the owner account' }, { status: 403 })
  }

  if (await rejectsLastOwnerRemoval(db, userId, { delete: true })) {
    return jsonResponse({ error: 'Cannot delete the last active owner' }, { status: 409 })
  }

  const deleted = await softDeleteUser(db, userId)
  if (!deleted) return userNotFound()

  await createAuditEvent(db, {
    actorUserId: actor.id,
    action: 'user.delete',
    targetType: 'user',
    targetId: userId,
    metadata: {},
    ...requestAuditContext(req),
  })
  return jsonResponse({ ok: true })
}

async function handleUserItem(
  req: Request,
  db: DbClient,
  actor: AuthUser,
  userId: string,
): Promise<Response> {
  if (req.method === 'PATCH') {
    return handleUserPatch(req, db, actor, userId)
  }

  if (req.method === 'DELETE') {
    return handleUserDelete(req, db, actor, userId)
  }

  return methodNotAllowed()
}

// ---------------------------------------------------------------------------
// Route patterns
// ---------------------------------------------------------------------------

const USER_ITEM_PATTERN = /^\/admin\/api\/cms\/users\/([^/]+)$/

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleUsersRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const { pathname } = new URL(req.url)

  if (pathname !== `${CMS_API_PREFIX}/users` && !USER_ITEM_PATTERN.test(pathname)) {
    return null
  }

  const actor = await requireCapability(req, db, 'users.manage')
  if (actor instanceof Response) return actor

  if (pathname === `${CMS_API_PREFIX}/users`) {
    return handleUsersCollection(req, db, actor)
  }

  const itemMatch = pathname.match(USER_ITEM_PATTERN)
  if (itemMatch) {
    return handleUserItem(req, db, actor, decodeURIComponent(itemMatch[1]))
  }

  return null
}
