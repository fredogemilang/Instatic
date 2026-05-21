/**
 * Plugin settings handler — implements the `cms.settings.replace` api-call.
 *
 * Validates the incoming settings record against the plugin's declared setting
 * definitions, persists to the database, and emits a `settings.changed` hook
 * so other plugin subsystems can react to the update.
 *
 * No permission gate — any active plugin may update its own settings.
 */

import type { PluginSettingDefinition } from '@core/plugin-sdk'
import { validatePluginSettingsRecord } from '@core/plugin-sdk'
import { hookBus } from '@core/plugins/hookBus'
import { setPluginSettings } from '../../../repositories/plugins'
import type { SettingsReplaceApiCall } from '../../protocol/apiCallSchema'
import type { DbClient } from '../../../db/client'
import { replyApiOk } from '../workerPool'
import type { HostPluginRecord } from '../types'

export async function handleSettingsReplace(
  msg: SettingsReplaceApiCall,
  entry: HostPluginRecord,
  db: DbClient,
): Promise<void> {
  const [next] = msg.args
  const declared = (entry.manifest.settings ?? []) as PluginSettingDefinition[]
  const cleaned = validatePluginSettingsRecord(declared, next)
  await setPluginSettings(db, msg.pluginId, cleaned)
  // Refresh worker-side cache via the existing settings route — actually
  // the worker's local cache is updated from the api reply value.
  await hookBus.emit('settings.changed', {
    pluginId: msg.pluginId,
    settings: cleaned,
  } as unknown as Record<string, unknown>)
  replyApiOk(msg.pluginId, msg.correlationId, cleaned as unknown)
}
