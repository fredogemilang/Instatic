/**
 * Analytics plugin — dashboard stats query helpers.
 *
 * Assembles the full dashboard payload from `daily-stats` records (for
 * complete past days) and live raw events (for the current day, when the
 * range includes today). Computes delta percentages against the previous
 * equivalent window.
 */
import type { ServerPluginApi, PluginRecord } from '@pagebuilder/plugin-sdk'

export type DateRange = '1d' | '7d' | '30d' | '90d' | { from: string; to: string }

export interface TopEntry {
  label: string
  count: number
  pct: number
}

export interface DashboardSummary {
  pageviews: number
  visitors: number
  sessions: number
  bounceRate: number
  deltaPct: {
    pageviews: number
    visitors: number
    sessions: number
    bounceRate: number
  }
}

export interface DashboardStats {
  summary: DashboardSummary
  series: { date: string; pageviews: number }[]
  topPages: TopEntry[]
  topReferrers: TopEntry[]
  topCountries: TopEntry[]
  topDevices: TopEntry[]
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function subtractDays(dateStr: string, days: number): string {
  return addDays(dateStr, -days)
}

interface ResolvedRange {
  from: string  // YYYY-MM-DD, inclusive
  to: string    // YYYY-MM-DD, inclusive
  days: number
}

function resolveRange(range: DateRange): ResolvedRange {
  const today = todayUtc()
  if (typeof range === 'string') {
    const days = range === '1d' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 90
    return {
      from: subtractDays(today, days - 1),
      to: today,
      days,
    }
  }
  const msFrom = new Date(range.from + 'T00:00:00Z').getTime()
  const msTo   = new Date(range.to   + 'T00:00:00Z').getTime()
  const days = Math.round((msTo - msFrom) / 86_400_000) + 1
  return { from: range.from, to: range.to, days }
}

function inRange(dateStr: string, from: string, to: string): boolean {
  return dateStr >= from && dateStr <= to
}

// ---------------------------------------------------------------------------
// Top-N aggregation helpers
// ---------------------------------------------------------------------------

function mergeTopJsonFields(
  records: PluginRecord[],
  field: 'top-pages' | 'top-referrers' | 'top-countries' | 'top-devices',
): Map<string, number> {
  const merged = new Map<string, number>()
  for (const r of records) {
    const raw = r.data[field]
    if (typeof raw !== 'string') continue
    try {
      const entries = JSON.parse(raw) as { label: string; count: number }[]
      if (!Array.isArray(entries)) continue
      for (const e of entries) {
        if (typeof e.label === 'string' && typeof e.count === 'number') {
          merged.set(e.label, (merged.get(e.label) ?? 0) + e.count)
        }
      }
    } catch {
      // corrupt row — skip
    }
  }
  return merged
}

function mapToTopEntries(map: Map<string, number>, total: number, n = 10): TopEntry[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([label, count]) => ({
      label,
      count,
      pct: total > 0 ? Math.round((count / total) * 100) : 0,
    }))
}

// ---------------------------------------------------------------------------
// Live event aggregation (for today's incomplete data)
// ---------------------------------------------------------------------------

interface LiveAggregate {
  pageviews: number
  visitors: number
  sessions: number
  bounceSessions: number
  topPages: Map<string, number>
  topReferrers: Map<string, number>
  topCountries: Map<string, number>
  topDevices: Map<string, number>
}

function aggregateLiveEvents(events: PluginRecord[], from: string, to: string): LiveAggregate {
  const agg: LiveAggregate = {
    pageviews: 0,
    visitors: 0,
    sessions: 0,
    bounceSessions: 0,
    topPages: new Map(),
    topReferrers: new Map(),
    topCountries: new Map(),
    topDevices: new Map(),
  }

  const visitorSet = new Set<string>()
  const sessionSet = new Set<string>()
  const pageviewsPerSession = new Map<string, number>()

  for (const r of events) {
    const at = String(r.data.receivedAt ?? r.createdAt)
    const dateStr = at.slice(0, 10)
    if (!inRange(dateStr, from, to)) continue

    const name = String(r.data.name ?? '')
    const path = String(r.data.path ?? '')
    const session = String(r.data.session ?? '')
    const vh = String(r.data.visitorHash ?? '')
    const referrer = String(r.data.referrer ?? '').trim()
    const country = String(r.data.country ?? '').trim()
    const device = String(r.data.device ?? 'desktop')

    if (name === 'page-view') {
      agg.pageviews++
      if (vh) visitorSet.add(vh)
      if (session) {
        const prev = pageviewsPerSession.get(session) ?? 0
        pageviewsPerSession.set(session, prev + 1)
      }
      if (path) agg.topPages.set(path, (agg.topPages.get(path) ?? 0) + 1)
      if (referrer) agg.topReferrers.set(referrer, (agg.topReferrers.get(referrer) ?? 0) + 1)
    }

    if (session) sessionSet.add(session)
    if (country) agg.topCountries.set(country, (agg.topCountries.get(country) ?? 0) + 1)
    agg.topDevices.set(device, (agg.topDevices.get(device) ?? 0) + 1)
  }

  agg.visitors = visitorSet.size
  agg.sessions = sessionSet.size
  agg.bounceSessions = [...pageviewsPerSession.values()].filter(v => v === 1).length

  return agg
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

function deltaPct(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0
  return Math.round(((current - previous) / previous) * 100)
}

// ---------------------------------------------------------------------------
// Main stats function
// ---------------------------------------------------------------------------

export async function getDashboardStats(api: ServerPluginApi, range: DateRange): Promise<DashboardStats> {
  const r = resolveRange(range)
  const today = todayUtc()
  const prevFrom = subtractDays(r.from, r.days)
  const prevTo = subtractDays(r.to, r.days)

  const dailyStats = api.cms.storage.collection('daily-stats')
  const events = api.cms.storage.collection('events')

  const [{ records: allStats }, { records: allEvents }] = await Promise.all([
    // Fetch only the two windows we need: current + previous comparison period
    dailyStats.list({ filter: { date: { gte: prevFrom, lte: r.to } }, limit: 1000 }),
    // Only load raw events if the range includes today (live data needed)
    r.to >= today
      ? events.list({ filter: { receivedAt: { gte: `${today}T00:00:00.000Z` } }, limit: 1000 })
      : Promise.resolve({ records: [] as PluginRecord[], totalCount: 0 }),
  ])

  // Current window: daily-stats rows for complete past days + live events for today
  const curStats = allStats.filter(s => inRange(String(s.data.date ?? ''), r.from, r.to))
  const prevStats = allStats.filter(s => inRange(String(s.data.date ?? ''), prevFrom, prevTo))

  // Summarise from daily-stats rows
  function sumStats(rows: PluginRecord[]) {
    let pageviews = 0, visitors = 0, sessions = 0, bounceRateSum = 0
    for (const r of rows) {
      pageviews    += Number(r.data.pageviews ?? 0)
      visitors     += Number(r.data.visitors ?? 0)
      sessions     += Number(r.data.sessions ?? 0)
      bounceRateSum += Number(r.data['bounce-rate'] ?? 0)
    }
    const bounceRate = rows.length > 0 ? Math.round(bounceRateSum / rows.length) : 0
    return { pageviews, visitors, sessions, bounceRate }
  }

  const curSumFromStats = sumStats(curStats)
  const prevSum = sumStats(prevStats)

  // Merge in live events for today if applicable
  let curSum = curSumFromStats
  const liveAgg = r.to >= today
    ? aggregateLiveEvents(allEvents, today, today)
    : null

  if (liveAgg) {
    curSum = {
      pageviews:  curSumFromStats.pageviews + liveAgg.pageviews,
      visitors:   curSumFromStats.visitors + liveAgg.visitors,
      sessions:   curSumFromStats.sessions + liveAgg.sessions,
      bounceRate: liveAgg.sessions > 0
        ? Math.round((liveAgg.bounceSessions / liveAgg.sessions) * 100)
        : curSumFromStats.bounceRate,
    }
  }

  // Series — one entry per day, from daily-stats or live events
  const statsMap = new Map(curStats.map(s => [String(s.data.date), Number(s.data.pageviews ?? 0)]))
  if (liveAgg) {
    statsMap.set(today, (statsMap.get(today) ?? 0) + liveAgg.pageviews)
  }

  const series: { date: string; pageviews: number }[] = []
  let cursor = r.from
  while (cursor <= r.to) {
    series.push({ date: cursor, pageviews: statsMap.get(cursor) ?? 0 })
    cursor = addDays(cursor, 1)
  }

  // Top tables — merge daily-stats JSON fields + live events
  const pagesMap   = mergeTopJsonFields(curStats, 'top-pages')
  const refMap     = mergeTopJsonFields(curStats, 'top-referrers')
  const countryMap = mergeTopJsonFields(curStats, 'top-countries')
  const deviceMap  = mergeTopJsonFields(curStats, 'top-devices')

  if (liveAgg) {
    for (const [k, v] of liveAgg.topPages)     pagesMap.set(k,   (pagesMap.get(k)   ?? 0) + v)
    for (const [k, v] of liveAgg.topReferrers) refMap.set(k,     (refMap.get(k)     ?? 0) + v)
    for (const [k, v] of liveAgg.topCountries) countryMap.set(k, (countryMap.get(k) ?? 0) + v)
    for (const [k, v] of liveAgg.topDevices)   deviceMap.set(k,  (deviceMap.get(k)  ?? 0) + v)
  }

  const totalPageviews = curSum.pageviews

  return {
    summary: {
      ...curSum,
      deltaPct: {
        pageviews:  deltaPct(curSum.pageviews,  prevSum.pageviews),
        visitors:   deltaPct(curSum.visitors,   prevSum.visitors),
        sessions:   deltaPct(curSum.sessions,   prevSum.sessions),
        bounceRate: deltaPct(curSum.bounceRate, prevSum.bounceRate),
      },
    },
    series,
    topPages:     mapToTopEntries(pagesMap,   totalPageviews),
    topReferrers: mapToTopEntries(refMap,     totalPageviews),
    topCountries: mapToTopEntries(countryMap, totalPageviews),
    topDevices:   mapToTopEntries(deviceMap,  totalPageviews),
  }
}
