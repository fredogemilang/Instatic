/**
 * Showcase plugin — server entrypoint.
 *
 * Demonstrates four major server surfaces:
 *   1. Storage   — CRUD over plugin-owned `events` records
 *   2. Routes    — `/status` aggregates event counts, `/ingest` receives
 *                  events POSTed by this plugin's own frontend bundle
 *   3. Filters   — `publish.html` appends a marker to every published page
 *                  so the filter pipeline is observable from the HTML
 *
 * Notice how the plugin owns its frontend ingestion end-to-end: its IIFE
 * (`frontend/tracker.ts`) POSTs to `routes.postPublic('/ingest', ...)`
 * declared here. The host does not provide any shared frontend event
 * channel — every plugin that wants to receive frontend events
 * registers its own public route.
 */
import type { ServerPluginApi, ServerPluginModule } from '@core/plugin-sdk'

const STATUS_TAG = '<!-- plugin:acme.showcase -->'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log('Showcase plugin installed')
  },

  activate(api: ServerPluginApi) {
    api.plugin.log('Showcase plugin activated')

    const events = api.cms.storage.collection('events')

    api.cms.routes.get('/status', 'plugins.manage', async () => {
      const { records } = await events.list()
      const byEvent: Record<string, number> = {}
      for (const record of records) {
        const name = String(record.data.name || 'unknown')
        byEvent[name] = (byEvent[name] || 0) + 1
      }
      return {
        ok: true,
        plugin: api.plugin.id,
        total: records.length,
        byEvent,
      }
    })

    api.cms.routes.post('/clear', 'plugins.manage', async () => {
      const { records } = await events.list()
      await Promise.all(records.map((r) => events.delete(r.id)))
      return { ok: true, deleted: records.length }
    })

    // Frontend bundle POSTs events here. Plugin owns the envelope.
    api.cms.routes.postPublic('/ingest', async (ctx) => {
      const body = (ctx.body ?? {}) as Record<string, unknown>
      const eventName = typeof body.eventName === 'string' ? body.eventName : ''
      if (!eventName) {
        return { __response: true, status: 400, headers: {}, body: '{"error":"missing eventName"}' }
      }

      // Settings drive runtime behaviour — read live, not at activate-time,
      // so user edits in the Settings dialog take effect immediately.
      const prefix = api.cms.settings.get<string>('eventLabelPrefix') ?? ''
      const storeOutbound = api.cms.settings.get<boolean>('storeOutboundClicks') ?? true
      if (eventName === 'link-click' && !storeOutbound) return { ok: true, skipped: true }

      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload as Record<string, unknown>
        : {}

      try {
        await events.create({
          name: prefix ? `${prefix}:${eventName}` : eventName,
          page:    typeof body.pagePath  === 'string' ? body.pagePath  : '',
          visitor: typeof body.visitorId === 'string' ? body.visitorId : '',
          session: typeof body.sessionId === 'string' ? body.sessionId : '',
          payload: JSON.stringify(payload),
          'received-at': new Date().toISOString(),
        })
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        api.plugin.log('storage failed', message)
        return { __response: true, status: 500, headers: {}, body: '{"error":"storage failed"}' }
      }
    })

    api.cms.hooks.filter('publish.html', (html) => {
      if (typeof html !== 'string') return html
      return html.replace('</body>', `${STATUS_TAG}\n</body>`)
    })
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('Showcase plugin deactivated')
  },

  async uninstall(api: ServerPluginApi) {
    const events = api.cms.storage.collection('events')
    const { records } = await events.list()
    await Promise.all(records.map((r) => events.delete(r.id)))
    api.plugin.log(`Showcase plugin removed ${records.length} events`)
  },
}

export default mod
