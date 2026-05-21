/**
 * Analytics plugin — tracker event ingestion.
 *
 * Handles every event POSTed to the plugin's own `/runtime/ingest` route:
 * applies privacy filters, computes the daily-rotating visitor hash,
 * classifies the device, and persists a raw event record. The event
 * shape is owned entirely by this plugin — there is no host-defined
 * envelope.
 */
import type { ServerPluginApi } from '@pagebuilder/plugin-sdk'

export interface TrackerEvent {
  eventName: string
  payload: Record<string, unknown>
  visitorId?: string
  sessionId?: string
  pagePath?: string
  referrer?: string
  country?: string
  isAdmin?: boolean
  userAgent?: string
  /** ISO timestamp the browser stamped on the request. */
  clientTime?: string
  /** ISO timestamp the server received the request. */
  receivedAt: string
}

// ---------------------------------------------------------------------------
// Visitor hash — SHA-256(salt : visitorId : YYYY-MM-DD)
// ---------------------------------------------------------------------------

async function computeVisitorHash(salt: string, visitorId: string, date: string): Promise<string> {
  const input = `${salt}:${visitorId}:${date}`
  const encoded = new TextEncoder().encode(input)
  const buf = await crypto.subtle.digest('SHA-256', encoded)
  const bytes = new Uint8Array(buf)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Path glob matching
// ---------------------------------------------------------------------------

/**
 * Minimal glob match supporting `*` (single segment) and `**` (any depth).
 * Used for excludePaths filter. Case-sensitive.
 */
// Private-use sentinel used as an intermediate placeholder when converting
// glob `**` to regex `.*`. A private-use Unicode codepoint is chosen so it
// can never appear in a real path and won't trigger `no-control-regex`.
const GLOB_DOUBLE_STAR_SENTINEL = ''

function matchGlob(path: string, pattern: string): boolean {
  // Convert glob to regex — two-pass to handle ** before single *.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')          // escape regex meta chars (not * or ?)
    .replace(/\*\*/g, GLOB_DOUBLE_STAR_SENTINEL)     // stash ** before processing *
    .replace(/\*/g, '[^/]*')                         // * matches within one segment
    .replace(new RegExp(GLOB_DOUBLE_STAR_SENTINEL, 'g'), '.*') // ** matches any depth
  const re = new RegExp(`^${escaped}$`)
  return re.test(path)
}

function isExcludedPath(path: string, excludePaths: string): boolean {
  if (!excludePaths.trim()) return false
  for (const pattern of excludePaths.split('\n')) {
    const p = pattern.trim()
    if (p && matchGlob(path, p)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Device classification from User-Agent string
// ---------------------------------------------------------------------------

function classifyDevice(ua: string): 'bot' | 'mobile' | 'tablet' | 'desktop' {
  if (/bot|crawl|spider|slurp|facebookexternalhit|twitterbot/i.test(ua)) return 'bot'
  if (/iPad|Tablet/i.test(ua)) return 'tablet'
  if (/Mobile|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile'
  return 'desktop'
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleTrackerEvent(api: ServerPluginApi, evt: TrackerEvent): Promise<void> {
  const excludePaths  = String(api.cms.settings.get('excludePaths')  ?? '')
  const excludeAdmins = Boolean(api.cms.settings.get<boolean>('excludeAdmins') ?? true)
  const salt          = String(api.cms.settings.get('salt') ?? '')

  const path = evt.pagePath ?? ''

  if (path && isExcludedPath(path, excludePaths)) return

  // Drop events from admin sessions when the operator has enabled that filter.
  // The frontend tracker calls /is-admin once per session and includes the
  // result in the envelope as `isAdmin: true | false`.
  if (excludeAdmins && evt.isAdmin === true) return

  const date = evt.receivedAt.slice(0, 10) // YYYY-MM-DD
  const visitorHash = await computeVisitorHash(salt, evt.visitorId ?? 'anon', date)
  const ua = evt.userAgent ?? ''
  const device = ua ? classifyDevice(ua) : 'desktop'
  const country = evt.country ?? ''

  // `payload` is whatever the plugin's frontend bundle put on the event;
  // store it as-is. Envelope fields (userAgent, country, isAdmin, …) are
  // already lifted out and stored in their own columns above.
  const rest = evt.payload

  const events = api.cms.storage.collection('events')
  await events.create({
    name:          evt.eventName,
    path,
    visitorHash,
    session:       evt.sessionId ?? '',
    referrer:      evt.referrer ?? '',
    device,
    country,
    payload:       JSON.stringify(rest),
    receivedAt:    evt.receivedAt,
  })
}
