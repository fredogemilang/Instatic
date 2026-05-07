import { nanoid } from 'nanoid'
import type { DbClient } from '../db/client'
import { normalizeCapabilities, type CoreCapability } from '../auth/capabilities'
import type { RoleRow } from '../types'

export interface Role {
  id: string
  slug: string
  name: string
  description: string
  isSystem: boolean
  capabilities: CoreCapability[]
  createdAt: string
  updatedAt: string
}

export class RoleMutationError extends Error {
  readonly status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'RoleMutationError'
    this.status = status
  }
}

function rowToRole(row: RoleRow): Role {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    isSystem: Boolean(row.is_system),
    capabilities: normalizeCapabilities(row.capabilities_json),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

function slugFromRoleName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function listRoles(db: DbClient): Promise<Role[]> {
  const { rows } = await db<RoleRow>`
    select id, slug, name, description, is_system, capabilities_json, created_at, updated_at
    from roles
    order by is_system desc, name asc
  `
  return rows.map(rowToRole)
}

async function getRole(db: DbClient, roleId: string): Promise<Role | null> {
  const { rows } = await db<RoleRow>`
    select id, slug, name, description, is_system, capabilities_json, created_at, updated_at
    from roles
    where id = ${roleId}
    limit 1
  `
  return rows[0] ? rowToRole(rows[0]) : null
}

export async function createCustomRole(
  db: DbClient,
  input: {
    name: string
    slug?: string
    description: string
    capabilities: CoreCapability[]
  },
): Promise<Role> {
  const name = input.name.trim()
  if (!name) throw new RoleMutationError('Role name is required')

  const slug = slugFromRoleName(input.slug || name)
  if (!slug) throw new RoleMutationError('Role slug is required')

  const id = nanoid()
  const { rows } = await db<RoleRow>`
    insert into roles (id, slug, name, description, is_system, capabilities_json)
    values (${id}, ${slug}, ${name}, ${input.description.trim()}, ${false}, ${input.capabilities})
    returning id, slug, name, description, is_system, capabilities_json, created_at, updated_at
  `
  return rowToRole(rows[0]!)
}

export async function updateCustomRole(
  db: DbClient,
  roleId: string,
  input: {
    name?: string
    slug?: string
    description?: string
    capabilities?: CoreCapability[]
  },
): Promise<Role | null> {
  const current = await getRole(db, roleId)
  if (!current) return null
  if (current.isSystem) throw new RoleMutationError('System roles cannot be edited', 409)

  const name = input.name === undefined ? current.name : input.name.trim()
  if (!name) throw new RoleMutationError('Role name is required')
  const slug = input.slug === undefined ? current.slug : slugFromRoleName(input.slug)
  if (!slug) throw new RoleMutationError('Role slug is required')
  const description = input.description === undefined ? current.description : input.description.trim()
  const capabilities = input.capabilities ?? current.capabilities

  const { rows } = await db<RoleRow>`
    update roles
    set slug = ${slug},
        name = ${name},
        description = ${description},
        capabilities_json = ${capabilities},
        updated_at = current_timestamp
    where id = ${roleId}
    returning id, slug, name, description, is_system, capabilities_json, created_at, updated_at
  `
  return rows[0] ? rowToRole(rows[0]) : null
}

export async function deleteCustomRole(db: DbClient, roleId: string): Promise<Role | null> {
  const current = await getRole(db, roleId)
  if (!current) return null
  if (current.isSystem) throw new RoleMutationError('System roles cannot be deleted', 409)

  const { rows } = await db<{ count: number }>`
    select count(*) as count
    from users
    where role_id = ${roleId}
      and deleted_at is null
  `
  if (Number(rows[0]?.count ?? 0) > 0) {
    throw new RoleMutationError('Cannot delete a role assigned to users', 409)
  }

  const result = await db`delete from roles where id = ${roleId}`
  return result.rowCount > 0 ? current : null
}
