/**
 * Analytics plugin — daily roll-up and retention prune.
 *
 * `runRollup` aggregates yesterday's raw events into a `daily-stats` record.
 * `runPrune` deletes raw events older than the configured retention window.
 */
import type { ServerPluginApi } from '@pagebuilder/plugin-sdk'

interface TopEntry {
  label: string
  count: number
}

function topN(map: Map<string, number>, n = 10): TopEntry[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({ label, count }))
}

/**
 * Aggregate yesterday's raw events into the `daily-stats` resource.
 * If a row for yesterday already exists it is updated (idempotent).
 */
export async function runRollup(api: ServerPluginApi): Promise<void> {
  const events = api.cms.storage.collection('events')
  const dailyStats = api.cms.storage.collection('daily-stats')

  const yesterday = new Date()
  yesterday.setUTCDate(yesterday.getUTCDate() - 1)
  const dateStr = yesterday.toISOString().slice(0, 10)

  const dayStart = `${dateStr}T00:00:00.000Z`
  const dayEnd = `${dateStr}T23:59:59.999Z`
  const { records: dayEvents } = await events.list({
    filter: { receivedAt: { gte: dayStart, lte: dayEnd } },
    limit: 1000,
  })

  if (dayEvents.length === 0) return

  // Pageviews
  const pageviewEvents = dayEvents.filter(r => r.data.name === 'page-view')
  const pageviews = pageviewEvents.length

  // Unique visitors (by visitorHash)
  const visitors = new Set(pageviewEvents.map(r => String(r.data.visitorHash ?? ''))).size

  // Sessions
  const sessionSet = new Set(dayEvents.map(r => String(r.data.session ?? '')).filter(Boolean))
  const sessions = sessionSet.size

  // Bounce rate: sessions with exactly one page-view / total sessions
  const pageviewsPerSession = new Map<string, number>()
  for (const r of pageviewEvents) {
    const s = String(r.data.session ?? '')
    if (s) pageviewsPerSession.set(s, (pageviewsPerSession.get(s) ?? 0) + 1)
  }
  const bounceSessions = [...pageviewsPerSession.values()].filter(v => v === 1).length
  const bounceRate = sessions > 0 ? Math.round((bounceSessions / sessions) * 100) : 0

  // Avg session duration: for each session, duration = max(received-at) - min(received-at)
  const sessionBounds = new Map<string, { min: number; max: number }>()
  for (const r of dayEvents) {
    const s = String(r.data.session ?? '')
    if (!s) continue
    const t = new Date(String(r.data.receivedAt ?? r.createdAt)).getTime()
    if (Number.isNaN(t)) continue
    const bounds = sessionBounds.get(s)
    if (!bounds) sessionBounds.set(s, { min: t, max: t })
    else { bounds.min = Math.min(bounds.min, t); bounds.max = Math.max(bounds.max, t) }
  }
  const durations = [...sessionBounds.values()].map(b => (b.max - b.min) / 1000)
  const avgSessionSeconds = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0

  // Top tables (only page-view events for pages; all events for referrers/countries/devices)
  const pageMap = new Map<string, number>()
  for (const r of pageviewEvents) {
    const p = String(r.data.path ?? '')
    if (p) pageMap.set(p, (pageMap.get(p) ?? 0) + 1)
  }

  const referrerMap = new Map<string, number>()
  for (const r of pageviewEvents) {
    const ref = String(r.data.referrer ?? '').trim()
    if (ref) referrerMap.set(ref, (referrerMap.get(ref) ?? 0) + 1)
  }

  const countryMap = new Map<string, number>()
  for (const r of dayEvents) {
    const c = String(r.data.country ?? '').trim()
    if (c) countryMap.set(c, (countryMap.get(c) ?? 0) + 1)
  }

  const deviceMap = new Map<string, number>()
  for (const r of dayEvents) {
    const d = String(r.data.device ?? 'desktop')
    deviceMap.set(d, (deviceMap.get(d) ?? 0) + 1)
  }

  const payload = {
    date:                  dateStr,
    pageviews,
    visitors,
    sessions,
    'bounce-rate':         bounceRate,
    'avg-session-seconds': avgSessionSeconds,
    'top-pages':           JSON.stringify(topN(pageMap)),
    'top-referrers':       JSON.stringify(topN(referrerMap)),
    'top-countries':       JSON.stringify(topN(countryMap)),
    'top-devices':         JSON.stringify(topN(deviceMap)),
  }

  // Upsert: find existing row for this date and update, or create new
  const { records: existingRows } = await dailyStats.list({ filter: { date: dateStr } })
  if (existingRows[0]) {
    await dailyStats.update(existingRows[0].id, payload)
  } else {
    await dailyStats.create(payload)
  }
}

/**
 * Delete raw events older than the configured retention period.
 */
export async function runPrune(api: ServerPluginApi): Promise<void> {
  const retentionDays = Number(api.cms.settings.get<number>('retentionDays') ?? 90)
  const cutoffMs = Date.now() - retentionDays * 86_400_000

  const cutoffIso = new Date(cutoffMs).toISOString()
  const events = api.cms.storage.collection('events')
  const { records: stale } = await events.list({
    filter: { receivedAt: { lt: cutoffIso } },
    limit: 1000,
  })

  for (const r of stale) {
    await events.delete(r.id)
  }

  if (stale.length > 0) {
    api.plugin.log(`[analytics] pruned ${stale.length} events older than ${retentionDays} days`)
  }
}
