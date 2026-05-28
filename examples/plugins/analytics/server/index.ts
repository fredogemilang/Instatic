/**
 * Analytics plugin — server entrypoint.
 *
 * Wires together storage, routes, and scheduled jobs using the plugin
 * server SDK. The plugin owns its frontend pipeline end-to-end: the
 * tracker IIFE in `frontend/tracker.ts` POSTs to this plugin's own
 * `/runtime/ingest` route (registered below). The host provides no
 * tracker channel — the only generic surface this plugin uses is
 * `api.cms.routes.public.post`. The plugin manifest declares
 * `cms.routes.public` so the install dialog flags it to the operator.
 *
 * Delegates heavy lifting to the sibling modules:
 *   - ingest.ts  — incoming event handler + visitor hashing
 *   - rollup.ts  — daily aggregation + retention prune
 *   - stats.ts   — dashboard query helpers
 *   - csv.ts     — CSV serialization for export
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'
import { handleTrackerEvent } from './ingest'
import { runRollup, runPrune } from './rollup'
import { getDashboardStats } from './stats'
import { eventsToCsv, dailyStatsToCsv } from './csv'

// ---------------------------------------------------------------------------
// Salt seeding
// ---------------------------------------------------------------------------

/**
 * Generate a random 32-char hex string for the visitor-hash salt.
 * Uses Math.random() — not cryptographically strong, but adequate for an
 * analytics salt. (A truly random salt would require `crypto.getRandomValues`,
 * which the QuickJS polyfill does not expose.)
 */
function generateSalt(): string {
  let s = ''
  for (let i = 0; i < 32; i++) {
    s += Math.floor(Math.random() * 16).toString(16)
  }
  return s
}

// ---------------------------------------------------------------------------
// Plugin module
// ---------------------------------------------------------------------------

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    // Seed the salt on first install so visitor hashes are unpredictable
    const existing = api.cms.settings.get('salt')
    if (!existing) {
      void api.cms.settings.replace({
        ...api.cms.settings.getAll(),
        salt: generateSalt(),
      })
    }
    api.plugin.log('[analytics] installed')
  },

  activate(api: ServerPluginApi) {
    api.plugin.log('[analytics] activating')

    // ── Storage handles ────────────────────────────────────────────
    const events     = api.cms.storage.collection('events')
    const dailyStats = api.cms.storage.collection('daily-stats')

    // ── settings.changed ───────────────────────────────────────────
    api.cms.hooks.on('settings.changed', (payload) => {
      if (
        typeof payload === 'object' &&
        payload !== null &&
        'pluginId' in payload &&
        payload.pluginId !== api.plugin.id
      ) return
      api.plugin.log('[analytics] settings updated')
    })

    // ── Authenticated routes ───────────────────────────────────────

    // GET /stats?range=7d — full dashboard payload
    api.cms.routes.get('/stats', 'plugins.read', async (ctx) => {
      const url = new URL(ctx.req.url)
      const rangeParam = url.searchParams.get('range') ?? '7d'
      const validRanges = ['1d', '7d', '30d', '90d'] as const
      type RangeStr = typeof validRanges[number]
      const range: RangeStr = (validRanges as readonly string[]).includes(rangeParam)
        ? rangeParam as RangeStr
        : '7d'
      return getDashboardStats(api, range)
    })

    // GET /live — last 5 minutes of raw events (at most 100)
    api.cms.routes.get('/live', 'plugins.read', async () => {
      const cutoffIso = new Date(Date.now() - 5 * 60_000).toISOString()
      const { records } = await events.list({
        filter: { receivedAt: { gte: cutoffIso } },
        limit: 100,
      })
      return { ok: true, events: records.slice(-100).reverse() }
    })

    // GET /export.csv?resource=events|daily-stats&range=30d
    api.cms.routes.get('/export.csv', 'plugins.read', async (ctx) => {
      const url = new URL(ctx.req.url)
      const resource = url.searchParams.get('resource') ?? 'events'
      const rangeParam = url.searchParams.get('range') ?? '30d'
      const days = rangeParam === '7d' ? 7 : rangeParam === '30d' ? 30 : rangeParam === '90d' ? 90 : 30
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

      let csvBody: string
      let filename: string

      if (resource === 'daily-stats') {
        const { records: rows } = await dailyStats.list({
          filter: { date: { gte: cutoff.slice(0, 10) } },
          limit: 1000,
        })
        csvBody = dailyStatsToCsv(rows)
        filename = `analytics-daily-stats-${rangeParam}.csv`
      } else {
        const { records: filtered } = await events.list({
          filter: { receivedAt: { gte: cutoff } },
          limit: 1000,
        })
        csvBody = eventsToCsv(filtered)
        filename = `analytics-events-${rangeParam}.csv`
      }

      return {
        __response: true,
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
        body: csvBody,
      }
    })

    // ── Public routes ──────────────────────────────────────────────

    // POST /ingest — frontend tracker bundle POSTs every event here.
    // Public by design (the tracker runs on the published page with no
    // admin session). Validation, normalization, hashing, and storage
    // all happen inside `handleTrackerEvent`.
    api.cms.routes.public.post('/ingest', async (ctx) => {
      try {
        const body = ctx.body as Record<string, unknown>
        const eventName = typeof body.eventName === 'string' ? body.eventName : ''
        if (!eventName) {
          return { __response: true, status: 400, headers: {}, body: '{"error":"missing eventName"}' }
        }
        const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
          ? body.payload as Record<string, unknown>
          : {}
        await handleTrackerEvent(api, {
          eventName,
          payload,
          visitorId:  typeof body.visitorId  === 'string' ? body.visitorId  : undefined,
          sessionId:  typeof body.sessionId  === 'string' ? body.sessionId  : undefined,
          pagePath:   typeof body.pagePath   === 'string' ? body.pagePath   : undefined,
          referrer:   typeof body.referrer   === 'string' ? body.referrer   : undefined,
          country:    typeof body.country    === 'string' ? body.country    : undefined,
          isAdmin:    body.isAdmin === true,
          userAgent:  typeof body.userAgent  === 'string' ? body.userAgent  : undefined,
          clientTime: typeof body.clientTime === 'string' ? body.clientTime : undefined,
          receivedAt: new Date().toISOString(),
        })
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        api.plugin.log('[analytics] ingest failed:', msg)
        return { __response: true, status: 500, headers: {}, body: '{"error":"ingest failed"}' }
      }
    })

    // GET /geo — country lookup from CF-IPCountry header (cached per session by tracker)
    api.cms.routes.public.get('/geo', async (ctx) => {
      const country =
        ctx.req.headers.get('CF-IPCountry') ??
        ctx.req.headers.get('X-Country-Code') ??
        ''
      return { country }
    })

    // GET /is-admin — detects whether the requesting browser has an active
    // admin session cookie. The host's session cookie name is `pb_admin_session`;
    // presence (not validity) is sufficient to identify admin self-traffic.
    // The frontend tracker calls this once per session and includes the result
    // in every subsequent event payload. The ingest handler drops admin events
    // when `excludeAdmins` is true.
    api.cms.routes.public.get('/is-admin', async (ctx) => {
      const cookie = ctx.req.headers.get('cookie') ?? ''
      // Cookie presence check — an expired-but-not-cleared cookie gives a
      // false positive, which is the safe direction (under-count, not over-count).
      const admin = cookie.includes('pb_admin_session=')
      return { admin }
    })

    // GET /public-stats.json?token=<publicStatsToken>
    api.cms.routes.public.get('/public-stats.json', async (ctx) => {
      const token = api.cms.settings.get<string>('publicStatsToken') ?? ''
      if (!token) {
        return { __response: true, status: 404, headers: {}, body: '{"error":"disabled"}' }
      }
      const url = new URL(ctx.req.url)
      const provided = url.searchParams.get('token') ?? ''
      if (provided !== token) {
        return { __response: true, status: 403, headers: {}, body: '{"error":"forbidden"}' }
      }
      return getDashboardStats(api, '30d')
    })

    // ── Scheduled jobs ─────────────────────────────────────────────

    // Daily roll-up at 02:00 UTC
    api.cms.schedule.register({
      id: 'roll-up',
      cadence: { interval: 'daily', at: '02:00' },
      maxDurationMs: 60_000,
      overlap: 'skip',
      handler: async () => runRollup(api),
    })

    // Retention prune at 03:00 UTC
    api.cms.schedule.register({
      id: 'prune',
      cadence: { interval: 'daily', at: '03:00' },
      maxDurationMs: 60_000,
      overlap: 'skip',
      handler: async () => runPrune(api),
    })

    api.plugin.log('[analytics] activated')
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('[analytics] deactivated')
  },

  async uninstall(api: ServerPluginApi) {
    // Clean up all stored data on uninstall — drain each collection in batches of 1000
    const eventsCol = api.cms.storage.collection('events')
    const statsCol  = api.cms.storage.collection('daily-stats')

    let eventsRemoved = 0
    while (true) {
      const { records, totalCount } = await eventsCol.list({ limit: 1000 })
      if (totalCount === 0 || records.length === 0) break
      await Promise.all(records.map(r => eventsCol.delete(r.id)))
      eventsRemoved += records.length
    }

    let statsRemoved = 0
    while (true) {
      const { records, totalCount } = await statsCol.list({ limit: 1000 })
      if (totalCount === 0 || records.length === 0) break
      await Promise.all(records.map(r => statsCol.delete(r.id)))
      statsRemoved += records.length
    }

    api.plugin.log(`[analytics] uninstalled — removed ${eventsRemoved} events, ${statsRemoved} daily-stats rows`)
  },
}

export default mod
