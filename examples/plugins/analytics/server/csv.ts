/**
 * Analytics plugin — CSV serialization.
 *
 * RFC 4180 quoting: fields containing comma, double-quote, or newline are
 * wrapped in double-quotes; embedded double-quotes are escaped as `""`.
 */
import type { PluginRecord } from '@pagebuilder/plugin-sdk'

function quoteField(value: unknown): string {
  const s = value == null ? '' : String(value)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function row(fields: unknown[]): string {
  return fields.map(quoteField).join(',')
}

export function eventsToCsv(records: PluginRecord[]): string {
  const header = row(['id', 'name', 'path', 'visitorHash', 'session', 'referrer', 'device', 'country', 'payload', 'receivedAt', 'createdAt'])
  const lines = records.map(r => row([
    r.id,
    r.data.name,
    r.data.path,
    r.data.visitorHash,
    r.data.session,
    r.data.referrer,
    r.data.device,
    r.data.country,
    r.data.payload,
    r.data.receivedAt,
    r.createdAt,
  ]))
  return [header, ...lines].join('\r\n')
}

export function dailyStatsToCsv(records: PluginRecord[]): string {
  const header = row([
    'date', 'pageviews', 'visitors', 'sessions', 'bounce-rate',
    'avg-session-seconds', 'top-pages', 'top-referrers', 'top-countries', 'top-devices',
  ])
  const lines = records
    .slice()
    .sort((a, b) => String(a.data.date).localeCompare(String(b.data.date)))
    .map(r => row([
      r.data.date,
      r.data.pageviews,
      r.data.visitors,
      r.data.sessions,
      r.data['bounce-rate'],
      r.data['avg-session-seconds'],
      r.data['top-pages'],
      r.data['top-referrers'],
      r.data['top-countries'],
      r.data['top-devices'],
    ]))
  return [header, ...lines].join('\r\n')
}
