/**
 * Uptime Monitor — server entrypoint.
 *
 * Runs entirely inside the QuickJS-WASM sandbox (`server/plugins/quickjsHost.ts`).
 * The plugin has no Node/Bun access — every side effect goes through the
 * SDK functions we explicitly request via `permissions` in the manifest.
 *
 * Schedules:
 *   • check-urls — every 5 minutes; fetches each URL in settings, records
 *                  a `checks` row, and emits `uptime.failure` when a URL
 *                  fails N times in a row.
 *   • daily-summary — every day at 00:05 UTC; emits a roll-up event
 *                     describing the last 24 hours.
 *
 * Routes:
 *   • GET /status — returns the latest check per URL plus 24h stats.
 *                   Mounted at /admin/api/cms/plugins/acme.uptime/runtime/status
 *
 * Notice: `import` is intentionally minimal — pulling in any host-runtime
 * module (Node or Bun built-ins) would fail the sandbox literal scan at
 * build time. Anything beyond pure JS goes through the SDK.
 */
import type { ServerPluginApi, ServerPluginModule } from '@pagebuilder/plugin-sdk'

// ---------------------------------------------------------------------------
// Per-URL failure counter — lives in plugin VM memory. Reset on each
// activate cycle; failures persist in storage anyway.
// ---------------------------------------------------------------------------

const failureCounters = new Map<string, number>()

/**
 * Shape of a single check row. Field IDs come from `pb-plugin.config.ts`
 * → resources[0].fields. The manifest schema restricts ids to lowercase
 * + digits + hyphens, so multi-word fields use kebab-case here (and in
 * the `create({...})` payload below).
 */
interface CheckRecord {
  url: string
  'status-code': number | null
  'latency-ms': number
  ok: boolean
  error: string | null
  'checked-at': string
}

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log('Uptime Monitor installed — open the Uptime tab in the admin to configure URLs.')
  },

  async activate(api: ServerPluginApi) {
    api.plugin.log('Uptime Monitor activating')

    // ─── HTTP route ──────────────────────────────────────────────────────
    // GET /status — live stats for the dashboard. The source of truth for
    // *which* URLs are tracked is the operator's `urls` setting; check
    // records are layered on top to provide last-run + 24h stats. This way
    // newly-added URLs show up immediately as "Pending" before the schedule
    // has had a chance to fire, and URLs removed from settings drop out of
    // the dashboard even if old history still exists.
    api.cms.routes.get('/status', 'plugins.manage', async () => {
      const configuredUrls = parseUrls(api.cms.settings.get('urls') ?? '')
      const { records } = await api.cms.storage.collection('checks').list()
      const byUrl = new Map<string, CheckRecord[]>()
      for (const row of records) {
        const data = row.data as unknown as CheckRecord
        const list = byUrl.get(data.url) ?? []
        list.push(data)
        byUrl.set(data.url, list)
      }

      const cutoff = Date.now() - 24 * 60 * 60 * 1000
      const summary = configuredUrls.map((url) => {
        const rows = byUrl.get(url) ?? []
        const sorted = rows.slice().sort(
          (a, b) => new Date(b['checked-at']).getTime() - new Date(a['checked-at']).getTime(),
        )
        const recent = sorted.filter((r) => new Date(r['checked-at']).getTime() >= cutoff)
        const okCount = recent.filter((r) => r.ok).length
        const failCount = recent.length - okCount
        const avgLatency = recent.length
          ? Math.round(recent.reduce((acc, r) => acc + r['latency-ms'], 0) / recent.length)
          : 0
        return {
          url,
          last: sorted[0] ?? null,
          last24h: {
            checks: recent.length,
            ok: okCount,
            failed: failCount,
            uptime_pct: recent.length ? Math.round((okCount / recent.length) * 100) : null,
            avg_latency_ms: avgLatency,
          },
        }
      })

      return {
        ok: true,
        plugin: api.plugin.id,
        urls: summary,
        generated_at: new Date().toISOString(),
      }
    })

    // ─── Hook listeners ──────────────────────────────────────────────────
    // The plugin emits its OWN hooks ('uptime.failure', 'uptime.daily-summary')
    // — other plugins or admin code can subscribe to react. To prove the
    // emit→listen flow works inside one plugin, we also subscribe to our
    // own events here just to log them.
    api.cms.hooks.on('uptime.failure', async (payload) => {
      api.plugin.log('FAILURE alert:', JSON.stringify(payload))
    })
    api.cms.hooks.on('uptime.daily-summary', async (payload) => {
      api.plugin.log('Daily summary:', JSON.stringify(payload))
    })

    // ─── Schedules ───────────────────────────────────────────────────────
    // Short form for the periodic check + full form for the daily summary
    // (so the demo shows both styles).

    api.cms.schedule.every(5, 'check-urls', async () => {
      const urls = parseUrls(api.cms.settings.get('urls') ?? '')
      const timeoutMs = Number(api.cms.settings.get('timeout_ms') ?? 5000)
      const threshold = Number(api.cms.settings.get('failure_threshold') ?? 3)

      if (urls.length === 0) {
        api.plugin.log('No URLs configured — open Settings to add some.')
        return
      }
      api.plugin.log(`Checking ${urls.length} URL(s)`)

      for (const url of urls) {
        const result = await checkOnce(url, timeoutMs)
        await api.cms.storage.collection('checks').create({
          url: result.url,
          'status-code': result['status-code'],
          'latency-ms': result['latency-ms'],
          ok: result.ok,
          error: result.error,
          'checked-at': result['checked-at'],
        })

        // Track consecutive failures + emit alert at the configured threshold.
        if (result.ok) {
          failureCounters.set(url, 0)
        } else {
          const next = (failureCounters.get(url) ?? 0) + 1
          failureCounters.set(url, next)
          if (next === threshold) {
            await api.cms.hooks.emit('uptime.failure', {
              url,
              consecutive_failures: next,
              last_error: result.error,
              checked_at: result['checked-at'],
            })
          }
        }
      }
    })

    api.cms.schedule.register({
      id: 'daily-summary',
      cadence: { interval: 'daily', at: '00:05' },
      // Daily roll-up scans up to 24h of records — give it a bigger
      // budget than the default 5s in case the table is large.
      maxDurationMs: 30_000,
      handler: async () => {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000
        const { records } = await api.cms.storage.collection('checks').list()
        const recent = records.filter(
          (r) => new Date((r.data as { 'checked-at': string })['checked-at']).getTime() >= cutoff,
        )
        const total = recent.length
        const ok = recent.filter((r) => (r.data as { ok: boolean }).ok).length
        await api.cms.hooks.emit('uptime.daily-summary', {
          total_checks: total,
          ok_checks: ok,
          failed_checks: total - ok,
          uptime_pct: total ? Math.round((ok / total) * 100) : null,
          window_start: new Date(cutoff).toISOString(),
          window_end: new Date().toISOString(),
        })
      },
    })

    api.plugin.log('Uptime Monitor activated — schedules registered, route mounted.')
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('Uptime Monitor deactivated.')
  },

  uninstall(api: ServerPluginApi) {
    api.plugin.log('Uptime Monitor uninstalled.')
  },
}

export default mod

// ---------------------------------------------------------------------------
// Helpers — pure functions, no SDK calls.
// ---------------------------------------------------------------------------

function parseUrls(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//.test(s))
}

type CheckOutcome = CheckRecord

async function checkOnce(url: string, timeoutMs: number): Promise<CheckOutcome> {
  const started = Date.now()
  const checkedAt = new Date().toISOString()
  try {
    // Per-request timeout via the sandbox's AbortSignal.timeout polyfill.
    // When it fires, the host's `network.abort` handler tears down the
    // upstream socket — we don't wait for the response to dribble in.
    // The schedule's `maxDurationMs` is the outer wall-clock ceiling.
    const safeTimeout = Math.max(500, Math.min(timeoutMs, 30_000))
    const result = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(safeTimeout),
    })
    const elapsed = Date.now() - started
    return {
      url,
      'status-code': result.status,
      'latency-ms': elapsed,
      ok: result.ok,
      error: result.ok ? null : `HTTP ${result.status}`,
      'checked-at': checkedAt,
    }
  } catch (err) {
    const elapsed = Date.now() - started
    return {
      url,
      'status-code': null,
      'latency-ms': elapsed,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      'checked-at': checkedAt,
    }
  }
}
