import { Type, type Static } from '@sinclair/typebox'
import { readEnvelope, assertOk } from '@core/http'
import { CmsCurrentUserSchema, type CmsCurrentUser } from './cmsAuth'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export const CmsRoleSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  name: Type.String(),
  description: Type.String(),
  isSystem: Type.Boolean(),
  capabilities: Type.Array(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

export type CmsRole = Static<typeof CmsRoleSchema>

export const CmsAuditEventSchema = Type.Object({
  id: Type.String(),
  actorUserId: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  targetType: Type.Union([Type.String(), Type.Null()]),
  targetId: Type.Union([Type.String(), Type.Null()]),
  metadata: Type.Record(Type.String(), Type.Unknown()),
  actorLabel: Type.Union([Type.String(), Type.Null()]),
  targetLabel: Type.Union([Type.String(), Type.Null()]),
  metadataLabels: Type.Record(Type.String(), Type.String()),
  ipAddress: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
})

export type CmsAuditEvent = Static<typeof CmsAuditEventSchema>

const UsersEnvelope = Type.Object({ users: Type.Optional(Type.Array(CmsCurrentUserSchema)) }, { additionalProperties: true })
const UserEnvelope = Type.Object({ user: Type.Optional(CmsCurrentUserSchema) }, { additionalProperties: true })
const RolesEnvelope = Type.Object({ roles: Type.Optional(Type.Array(CmsRoleSchema)) }, { additionalProperties: true })
const RoleEnvelope = Type.Object({ role: Type.Optional(CmsRoleSchema) }, { additionalProperties: true })
const AuditEnvelope = Type.Object({ events: Type.Optional(Type.Array(CmsAuditEventSchema)) }, { additionalProperties: true })

export async function listCmsUsers(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser[]> {
  const res = await fetchImpl(`${basePath}/users`, { method: 'GET', credentials: 'include' })
  const body = await readEnvelope(res, UsersEnvelope, `CMS users failed with ${res.status}`)
  return body.users ?? []
}

export async function createCmsUser(
  input: { email: string; displayName: string; password: string; roleId: string; status?: 'active' | 'suspended' },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const res = await fetchImpl(`${basePath}/users`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, UserEnvelope, `CMS user create failed with ${res.status}`)
  if (!body.user) throw new Error('CMS user create response was missing user')
  return body.user
}

export async function updateCmsUser(
  userId: string,
  input: Partial<{ email: string; displayName: string; password: string; roleId: string; status: 'active' | 'suspended' }>,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsCurrentUser> {
  const res = await fetchImpl(`${basePath}/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, UserEnvelope, `CMS user update failed with ${res.status}`)
  if (!body.user) throw new Error('CMS user update response was missing user')
  return body.user
}

export async function deleteCmsUser(
  userId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS user delete failed with ${res.status}`)
}

export async function listCmsRoles(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRole[]> {
  const res = await fetchImpl(`${basePath}/roles`, { method: 'GET', credentials: 'include' })
  const body = await readEnvelope(res, RolesEnvelope, `CMS roles failed with ${res.status}`)
  return body.roles ?? []
}

export async function createCmsRole(
  input: { name: string; slug?: string; description: string; capabilities: string[] },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRole> {
  const res = await fetchImpl(`${basePath}/roles`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, RoleEnvelope, `CMS role create failed with ${res.status}`)
  if (!body.role) throw new Error('CMS role create response was missing role')
  return body.role
}

export async function updateCmsRole(
  roleId: string,
  input: Partial<{ name: string; slug: string; description: string; capabilities: string[] }>,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsRole> {
  const res = await fetchImpl(`${basePath}/roles/${encodeURIComponent(roleId)}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readEnvelope(res, RoleEnvelope, `CMS role update failed with ${res.status}`)
  if (!body.role) throw new Error('CMS role update response was missing role')
  return body.role
}

export async function deleteCmsRole(
  roleId: string,
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<void> {
  const res = await fetchImpl(`${basePath}/roles/${encodeURIComponent(roleId)}`, {
    method: 'DELETE',
    credentials: 'include',
  })
  await assertOk(res, `CMS role delete failed with ${res.status}`)
}

export async function listCmsAuditEvents(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
  basePath = '/admin/api/cms',
): Promise<CmsAuditEvent[]> {
  const res = await fetchImpl(`${basePath}/audit`, { method: 'GET', credentials: 'include' })
  const body = await readEnvelope(res, AuditEnvelope, `CMS audit events failed with ${res.status}`)
  return body.events ?? []
}
