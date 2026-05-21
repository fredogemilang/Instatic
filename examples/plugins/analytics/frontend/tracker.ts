/**
 * Analytics plugin — frontend tracker bundle.
 *
 * Self-contained IIFE. Installs `window.__pb_analytics.send(event, payload)`
 * for any in-page code that wants to fire custom events, and wires DOM
 * listeners (page-view, link-click, scroll-depth, web vitals, bounce) that
 * POST to this plugin's OWN ingest route. The host provides no shared
 * runtime — every dependency lives inside this file.
 *
 * Privacy:
 *   - Honours `navigator.doNotTrack === '1'`.
 *   - Honours a per-user localStorage opt-out flag.
 *   - Country lookup + admin-session detection happen ONCE per session
 *     against this plugin's own routes; results cached in `sessionStorage`.
 *
 * Route base — every fetch lives under this plugin's `/runtime` namespace
 * so the host's permission gate covers it without any special-cased path.
 */
import type { } from '@pagebuilder/plugin-sdk' // type-only; compiles away

declare global {
  interface Window {
    __pb_analytics?: {
      visitorId: string
      sessionId: string
      send(event: string, payload?: Record<string, unknown>): void
    }
  }
}

const PLUGIN_ID       = 'pagebuilder.analytics'
const ROUTE_BASE      = `/admin/api/cms/plugins/${PLUGIN_ID}/runtime`
const VISITOR_KEY     = '__pb_analytics_v'
const SESSION_KEY     = '__pb_analytics_s'
const GEO_CACHE_KEY   = '__pb_analytics_geo'
const ADMIN_CACHE_KEY = '__pb_analytics_admin'
const OPT_OUT_KEY     = '__pb_analytics_optout'

;(function init() {
  // ── Privacy gates ─────────────────────────────────────────────────────
  const dnt =
    (typeof navigator !== 'undefined' && navigator.doNotTrack === '1') ||
    (typeof window !== 'undefined' && (window as Record<string, unknown>).doNotTrack === '1')
  if (dnt) return
  try { if (localStorage.getItem(OPT_OUT_KEY) === '1') return } catch { /* ignore */ }

  // ── Identity ──────────────────────────────────────────────────────────
  function rid(): string {
    return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16)
  }
  function visitorId(): string {
    try {
      const existing = localStorage.getItem(VISITOR_KEY)
      if (existing) return existing
      const fresh = rid()
      localStorage.setItem(VISITOR_KEY, fresh)
      return fresh
    } catch { return rid() }
  }
  function sessionId(): string {
    try {
      const existing = sessionStorage.getItem(SESSION_KEY)
      if (existing) return existing
      const fresh = rid()
      sessionStorage.setItem(SESSION_KEY, fresh)
      return fresh
    } catch { return rid() }
  }

  const _visitorId = visitorId()
  const _sessionId = sessionId()

  // ── Session-scoped enrichment ─────────────────────────────────────────
  let cachedCountry = ''
  let cachedIsAdmin = false
  let adminResolved = false

  try { cachedCountry = sessionStorage.getItem(GEO_CACHE_KEY) ?? '' } catch { /* ignore */ }
  try {
    const cached = sessionStorage.getItem(ADMIN_CACHE_KEY)
    if (cached !== null) {
      cachedIsAdmin = cached === '1'
      adminResolved = true
    }
  } catch { /* ignore */ }

  function fetchCountry(): void {
    if (cachedCountry) return
    fetch(`${ROUTE_BASE}/geo`, { method: 'GET', credentials: 'omit' })
      .then((r) => r.json() as Promise<{ country?: string }>)
      .then((data) => {
        const country = typeof data.country === 'string' ? data.country : ''
        cachedCountry = country
        try { sessionStorage.setItem(GEO_CACHE_KEY, country) } catch { /* ignore */ }
      })
      .catch(() => { /* geo is optional */ })
  }

  function fetchIsAdmin(): void {
    if (adminResolved) return
    fetch(`${ROUTE_BASE}/is-admin`, { method: 'GET', credentials: 'include' })
      .then((r) => r.json() as Promise<{ admin?: boolean }>)
      .then((data) => {
        cachedIsAdmin = data.admin === true
        adminResolved = true
        try { sessionStorage.setItem(ADMIN_CACHE_KEY, cachedIsAdmin ? '1' : '0') } catch { /* ignore */ }
      })
      .catch(() => { cachedIsAdmin = false; adminResolved = true })
  }

  fetchCountry()
  fetchIsAdmin()

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''

  // ── Ingestion ─────────────────────────────────────────────────────────
  function send(eventName: string, payload: Record<string, unknown> = {}): void {
    const body = JSON.stringify({
      eventName,
      payload,
      visitorId: _visitorId,
      sessionId: _sessionId,
      pagePath: location.pathname,
      referrer: document.referrer || null,
      country: cachedCountry,
      isAdmin: cachedIsAdmin,
      userAgent: ua,
      clientTime: new Date().toISOString(),
    })
    fetch(`${ROUTE_BASE}/ingest`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body,
    }).catch(() => { /* fire-and-forget */ })
  }

  // Expose a small surface for in-page code that wants to fire custom
  // events (e.g. a CTA-click handler in a custom module).
  window.__pb_analytics = {
    visitorId: _visitorId,
    sessionId: _sessionId,
    send,
  }

  // ── DOM listeners ─────────────────────────────────────────────────────
  let pageStartTime    = Date.now()
  let interactionCount = 0

  function bumpInteraction() { interactionCount++ }
  document.addEventListener('click',    bumpInteraction, { passive: true, capture: true })
  document.addEventListener('keypress', bumpInteraction, { passive: true, capture: true })
  document.addEventListener('scroll',   bumpInteraction, { passive: true, capture: true, once: true })

  // Page view — fire on initial load.
  function firePageView(): void {
    pageStartTime    = Date.now()
    interactionCount = 0
    send('page-view', { path: location.pathname, title: document.title })
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', firePageView, { once: true })
  } else {
    firePageView()
  }

  // Outbound link clicks.
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? ''
    let outbound = false
    try { outbound = href.startsWith('http') && new URL(href).hostname !== location.hostname } catch { /* ignore */ }
    send('link-click', {
      href,
      text: (anchor.textContent ?? '').trim().slice(0, 80),
      outbound,
    })
  }, { capture: true })

  // Scroll depth (25 / 50 / 75 / 100).
  const seenDepth: Record<number, true> = {}
  window.addEventListener('scroll', () => {
    const pct = Math.round((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100)
    for (const t of [25, 50, 75, 100]) {
      if (pct >= t && !seenDepth[t]) {
        seenDepth[t] = true
        send('scroll-depth', { depth: t, path: location.pathname })
      }
    }
  }, { passive: true })

  // ── Web vitals (LCP, CLS, FID) flushed on page hide ───────────────────
  interface VitalsBuffer { lcp: number | null; cls: number; fid: number | null }
  const vitals: VitalsBuffer = { lcp: null, cls: 0, fid: null }
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      const lcpObs = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1] as PerformanceEntry & { startTime: number }
        if (last) vitals.lcp = Math.round(last.startTime)
      })
      lcpObs.observe({ type: 'largest-contentful-paint', buffered: true })
    } catch { /* not supported */ }
    try {
      const clsObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
          if (!e.hadRecentInput && typeof e.value === 'number') vitals.cls += e.value
        }
      })
      clsObs.observe({ type: 'layout-shift', buffered: true })
    } catch { /* not supported */ }
    try {
      const fidObs = new PerformanceObserver((list) => {
        const first = list.getEntries()[0] as PerformanceEntry & { processingStart?: number; startTime: number }
        if (first && vitals.fid === null && first.processingStart !== undefined) {
          vitals.fid = Math.round(first.processingStart - first.startTime)
        }
      })
      fidObs.observe({ type: 'first-input', buffered: true })
    } catch { /* not supported */ }
  }

  function flushVitals(): void {
    if (vitals.lcp === null && vitals.cls === 0 && vitals.fid === null) return
    send('web-vitals', {
      lcp: vitals.lcp,
      cls: Math.round(vitals.cls * 1000) / 1000,
      fid: vitals.fid,
      path: location.pathname,
    })
  }

  // ── Bounce detection ──────────────────────────────────────────────────
  function flushBounce(): void {
    if (interactionCount === 0 && Date.now() - pageStartTime < 10_000) {
      send('bounce', { path: location.pathname })
    }
  }

  function onPageHide(): void {
    flushVitals()
    flushBounce()
  }
  window.addEventListener('pagehide',     onPageHide, { capture: true, once: true })
  window.addEventListener('beforeunload', onPageHide, { capture: true, once: true })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushVitals()
  })
})()
