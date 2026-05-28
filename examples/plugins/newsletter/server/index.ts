/**
 * Newsletter plugin — server entrypoint.
 *
 * Runs entirely inside the QuickJS-WASM sandbox. All privileged operations
 * go through the SDK: storage, routes, hooks, schedules, and outbound fetch
 * (gated to api.resend.com via networkAllowedHosts).
 *
 * Lifecycle:
 *   install   — seeds a default "General" mailing list.
 *   activate  — registers all routes, the scheduled-send job, webhook handler,
 *               and hook listeners.
 *   uninstall — removes all subscriber, list, broadcast, and delivery records.
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { registerSubscribeRoutes } from './subscribe'
import { registerBroadcastRoutes, registerBroadcastSchedule } from './broadcasts'
import { registerWebhookRoutes } from './webhooks'
import { generateToken } from './resend'

const mod: ServerPluginModule = {
  async install(api: ServerPluginApi) {
    api.plugin.log('Newsletter plugin installed — seeding default list.')

    // Seed a default General list so subscribe forms work out of the box.
    const lists = api.cms.storage.collection('lists')
    const { records: existing } = await lists.list()
    if (existing.length === 0) {
      await lists.create({
        name: 'General',
        description: 'Main newsletter list.',
        isDefault: true,
      })
      api.plugin.log('Newsletter plugin: seeded "General" list.')
    }
  },

  async activate(api: ServerPluginApi) {
    api.plugin.log('Newsletter plugin activating.')

    // Subscribe / confirm / unsubscribe / preferences + admin subscriber & list routes.
    registerSubscribeRoutes(api)

    // Broadcast CRUD + on-demand send + preview routes.
    registerBroadcastRoutes(api)

    // Resend webhook handler (public.post — no auth required, signature-verified).
    registerWebhookRoutes(api)

    // Scheduled job: every 5 min, dispatch any due scheduled broadcasts.
    registerBroadcastSchedule(api)

    // Settings-change listener — log whenever the admin updates plugin config.
    api.cms.hooks.on('settings.changed', (payload) => {
      if ((payload as { pluginId?: string }).pluginId !== api.plugin.id) return
      api.plugin.log('Newsletter plugin settings updated.')
    })

    api.plugin.log('Newsletter plugin activated.')
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('Newsletter plugin deactivated.')
  },

  async uninstall(api: ServerPluginApi) {
    const collections = ['subscribers', 'lists', 'broadcasts', 'deliveries']
    for (const name of collections) {
      const col = api.cms.storage.collection(name)
      const { records: all } = await col.list({ limit: 1000 })
      await Promise.all(all.map((r) => col.delete(r.id)))
      api.plugin.log(`Newsletter plugin removed ${all.length} ${name} records.`)
    }
    api.plugin.log('Newsletter plugin uninstalled.')
  },
}

export default mod

// Re-export for tests only.
export { generateToken }
