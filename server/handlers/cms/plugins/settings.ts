/**
 * Plugin settings endpoints.
 *
 *   GET /admin/api/cms/plugins/:id/settings — return masked settings (secret
 *                                              values become `'***'`)
 *   PUT /admin/api/cms/plugins/:id/settings — validate, persist, refresh
 *                                              runtime cache, fire
 *                                              `settings.changed` so plugin
 *                                              server hooks can react.
 */
import type { DbClient } from '../../../db/client'
import type { AuthUser } from '../../../repositories/users'
import { createAuditEvent } from '../../../repositories/audit'
import {
  getInstalledPlugin,
  setPluginSettings,
} from '../../../repositories/plugins'
import {
  validatePluginSettingsRecord,
  maskSecretSettings,
  type PluginSettingDefinition,
} from '@core/plugin-sdk'
import { refreshPluginSettingsCache } from '../../../plugins/runtime'
import { hookBus } from '@core/plugins/hookBus'
import { badRequest, jsonResponse, methodNotAllowed, readJsonObject } from '../../../http'
import { requestAuditContext } from '../shared'
import { pluginNotFound } from './shared'

export async function handlePluginSettings(
  req: Request,
  db: DbClient,
  user: AuthUser,
  pluginId: string,
): Promise<Response> {
  const result = await getInstalledPlugin(db, pluginId)
  if (!result) return pluginNotFound()
  if (result.kind === 'broken') {
    return jsonResponse(
      { error: 'Cannot manage settings for a plugin with a corrupt manifest — remove and reinstall it.' },
      { status: 409 },
    )
  }
  const plugin = result.plugin
  const declared = (plugin.manifest.settings ?? []) as PluginSettingDefinition[]
  if (declared.length === 0) {
    return badRequest(`Plugin "${pluginId}" does not declare settings`)
  }

  if (req.method === 'GET') {
    return jsonResponse({
      schema: declared,
      settings: maskSecretSettings(declared, plugin.settings),
    })
  }

  if (req.method === 'PUT') {
    const body = await readJsonObject(req)
    let cleaned: Record<string, string | number | boolean>
    try {
      cleaned = validatePluginSettingsRecord(declared, body.settings ?? body)
    } catch (err) {
      return badRequest(err instanceof Error ? err.message : 'Invalid settings payload')
    }
    await setPluginSettings(db, pluginId, cleaned)
    await refreshPluginSettingsCache(db, pluginId)
    await hookBus.emit('settings.changed', {
      pluginId,
      settings: cleaned,
    } as unknown as Record<string, unknown>)
    await createAuditEvent(db, {
      actorUserId: user.id,
      action: 'plugin.settings.update',
      targetType: 'plugin',
      targetId: pluginId,
      metadata: {
        pluginId,
        keys: Object.keys(cleaned),
      },
      ...requestAuditContext(req),
    })
    return jsonResponse({ settings: maskSecretSettings(declared, cleaned) })
  }

  return methodNotAllowed()
}
