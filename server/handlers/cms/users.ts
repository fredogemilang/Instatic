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
 */
import type { DbClient } from '../../db/client'
import { hashPassword } from '../../auth/tokens'
import { requireCapability } from '../../auth/authz'
import { createAuditEvent } from '../../repositories/audit'
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
import { badRequest, jsonResponse, methodNotAllowed } from '../../http'
import {
  CMS_API_PREFIX,
  UserStatusSchema,
  mutationErrorResponse,
  readValidatedBody,
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

export async function handleUsersRoutes(req: Request, db: DbClient): Promise<Response | null> {
  const url = new URL(req.url)

  if (url.pathname === `${CMS_API_PREFIX}/users`) {
    const actor = await requireCapability(req, db, 'users.manage')
    if (actor instanceof Response) return actor

    if (req.method === 'GET') {
      return jsonResponse({ users: await listUsers(db) })
    }

    if (req.method === 'POST') {
      const body = await readValidatedBody(req, UserCreateBodySchema)
      if (!body) return badRequest('Invalid user payload')
      if (body.password.length < 12) return badRequest('Password must be at least 12 characters')
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

  const userItemMatch = url.pathname.match(/^\/admin\/api\/cms\/users\/([^/]+)$/)
  if (userItemMatch) {
    const actor = await requireCapability(req, db, 'users.manage')
    if (actor instanceof Response) return actor

    const userId = decodeURIComponent(userItemMatch[1])

    if (req.method === 'PATCH') {
      const body = await readValidatedBody(req, UserPatchBodySchema)
      if (!body) return badRequest('Invalid user payload')
      if (body.password !== undefined && body.password.length < 12) {
        return badRequest('Password must be at least 12 characters')
      }
      const currentUser = await findUserById(db, userId)
      if (!currentUser) return jsonResponse({ error: 'User not found' }, { status: 404 })
      const ownerRoleError = rejectsOwnerRoleAssignment(body.roleId)
      if (ownerRoleError) return ownerRoleError
      if (body.roleId !== undefined && userId === actor.id && currentUser.role.slug === 'owner' && body.roleId !== currentUser.role.id) {
        return jsonResponse({ error: 'Owner cannot change their own role' }, { status: 409 })
      }
      if (body.status !== undefined && await rejectsLastOwnerRemoval(db, userId, { status: body.status })) {
        return jsonResponse({ error: 'Cannot suspend the last active owner' }, { status: 409 })
      }
      if (body.roleId !== undefined && await rejectsLastOwnerRemoval(db, userId, { roleId: body.roleId })) {
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
        if (!user) return jsonResponse({ error: 'User not found' }, { status: 404 })
        const metadata = {
          passwordChanged: body.password !== undefined,
          roleId: body.roleId ?? user.role.id,
          status: body.status ?? user.status,
        }
        await createAuditEvent(db, {
          actorUserId: actor.id,
          action: body.password !== undefined ? 'password.change' : body.status === 'suspended' ? 'user.suspend' : 'user.update',
          targetType: 'user',
          targetId: user.id,
          metadata,
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

    if (req.method === 'DELETE') {
      if (userId === actor.id && await rejectsLastOwnerRemoval(db, userId, { delete: true })) {
        return jsonResponse({ error: 'Cannot delete the last active owner' }, { status: 409 })
      }
      if (await rejectsLastOwnerRemoval(db, userId, { delete: true })) {
        return jsonResponse({ error: 'Cannot delete the last active owner' }, { status: 409 })
      }
      const deleted = await softDeleteUser(db, userId)
      if (!deleted) return jsonResponse({ error: 'User not found' }, { status: 404 })
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

    return methodNotAllowed()
  }

  return null
}
