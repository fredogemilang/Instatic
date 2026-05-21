/**
 * SEO Suite — admin REST routes for seo-entries.
 *
 * Mounted under the plugin's runtime path (auth-gated):
 *
 *   GET  /seo-entries          — list all seo-entries
 *   GET  /seo-entries/:pageId  — get one entry by pageId
 *   POST /seo-entries/:pageId  — upsert an entry for a page
 *
 * The admin dashboard calls these routes via `usePluginRoutes().fetch(...)`.
 * All three require the `plugins.manage` capability (admin-only).
 */
import type { ServerPluginApi, ServerPluginRouteContext } from '@pagebuilder/plugin-sdk'

export function registerSeoEntriesRoutes(api: ServerPluginApi): void {
  const seoEntries = api.cms.storage.collection('seo-entries')

  // ── GET /seo-entries — list all entries ──────────────────────────────────
  api.cms.routes.get('/seo-entries', 'plugins.manage', async () => {
    try {
      const { records: all } = await seoEntries.list()
      return { ok: true, entries: all }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.plugin.log('[seo-suite] GET /seo-entries failed:', message)
      return { ok: false, error: message }
    }
  })

  // ── POST /seo-entries/:pageId — upsert an entry ──────────────────────────
  // The route path doesn't capture URL params in the current SDK, so we read
  // pageId from the request body instead. The admin sends:
  //   { pageId, titleOverride, metaDescription, ... }
  api.cms.routes.post('/seo-entries', 'plugins.manage', async (ctx: ServerPluginRouteContext) => {
    try {
      const body = ctx.body as Record<string, unknown>
      const pageId = typeof body['page-id'] === 'string' ? body['page-id'] : null
      if (!pageId) {
        return { ok: false, error: 'Missing required field: page-id' }
      }

      // Find the existing record for this pageId.
      const { records } = await seoEntries.list({ filter: { 'page-id': pageId } })
      const existing = records[0]

      // Build the data payload — pick only known fields, preserving system
      // fields from the existing record.
      const systemFields: Record<string, unknown> = existing
        ? {
          'last-rendered-url': existing.data['last-rendered-url'],
          'last-rendered-title': existing.data['last-rendered-title'],
          'last-rendered-at': existing.data['last-rendered-at'],
        }
        : {}

      const data: Record<string, unknown> = {
        'page-id': pageId,
        'title-override': typeof body['title-override'] === 'string' ? body['title-override'] : '',
        'meta-description': typeof body['meta-description'] === 'string' ? body['meta-description'] : '',
        'og-title': typeof body['og-title'] === 'string' ? body['og-title'] : '',
        'og-description': typeof body['og-description'] === 'string' ? body['og-description'] : '',
        'og-image-url': typeof body['og-image-url'] === 'string' ? body['og-image-url'] : '',
        'twitter-card': typeof body['twitter-card'] === 'string' ? body['twitter-card'] : 'summary_large_image',
        'canonical-url': typeof body['canonical-url'] === 'string' ? body['canonical-url'] : '',
        'no-index': typeof body['no-index'] === 'boolean' ? body['no-index'] : false,
        'no-follow': typeof body['no-follow'] === 'boolean' ? body['no-follow'] : false,
        'json-ld': typeof body['json-ld'] === 'string' ? body['json-ld'] : '',
        ...systemFields,
      }

      let record
      if (existing) {
        record = await seoEntries.update(existing.id, data)
      } else {
        record = await seoEntries.create(data)
      }

      return { ok: true, entry: record }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.plugin.log('[seo-suite] POST /seo-entries failed:', message)
      return { ok: false, error: message }
    }
  })

  // ── GET /page-index — list the page index (for dashboard stats) ──────────
  api.cms.routes.get('/page-index', 'plugins.manage', async () => {
    try {
      const { records: all } = await api.cms.storage.collection('page-index').list()
      return { ok: true, pages: all }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.plugin.log('[seo-suite] GET /page-index failed:', message)
      return { ok: false, error: message }
    }
  })
}
