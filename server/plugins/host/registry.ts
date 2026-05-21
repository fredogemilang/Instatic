/**
 * Plugin host registry — the shared mutable state for loaded plugins.
 *
 * `hostPlugins` is the source of truth for what the main process knows about
 * each active plugin: routes, hook registrations, loop sources, media
 * adapters, and in-flight fetches. All dispatch paths read from here.
 *
 * `dbForApi` is injected by the server startup sequence once the database
 * client is ready, so api-call dispatch can reach repositories without
 * importing the db client at module load time.
 */

import type { DbClient } from '../../db/client'
import type { PluginManifest, PluginPermission } from '@core/plugin-sdk'
import type { HostPluginRecord } from './types'

export const hostPlugins = new Map<string, HostPluginRecord>()

export function hasGrantedPermission(
  manifest: PluginManifest,
  permission: PluginPermission,
): boolean {
  return new Set(manifest.grantedPermissions ?? []).has(permission)
}

export function assertHostPluginPermission(
  entry: HostPluginRecord,
  permission: PluginPermission,
): void {
  if (!hasGrantedPermission(entry.manifest, permission)) {
    throw new Error(`Plugin "${entry.manifest.id}" requires permission "${permission}"`)
  }
}

let dbForApi: DbClient | null = null

export function setPluginWorkerDbClient(db: DbClient): void {
  dbForApi = db
}

export function getDbForApi(): DbClient | null {
  return dbForApi
}
