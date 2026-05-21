/**
 * Showcase plugin — self-contained frontend bundle.
 *
 * Owns its own event surface end-to-end. Wires DOM listeners (page-view,
 * link-click, scroll-depth) and POSTs each event to this plugin's own
 * `/runtime/ingest` route. Updates any `<div data-pb-counter="...">`
 * elements placed on the page by the `acme.showcase.event-counter`
 * canvas module with running counts.
 *
 * No host runtime, no shared `window.__pb` — the host provides only the
 * generic asset-injection substrate. Other plugins that want to
 * coordinate with the showcase can attach DOM event listeners or POST
 * to the same route themselves.
 */

const PLUGIN_ID = 'acme.showcase'
const ROUTE_BASE = `/admin/api/cms/plugins/${PLUGIN_ID}/runtime`

;(function init() {
  function rid(): string {
    return (Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16)
  }
  function persistentId(storage: Storage, key: string): string {
    try {
      const existing = storage.getItem(key)
      if (existing) return existing
      const fresh = rid()
      storage.setItem(key, fresh)
      return fresh
    } catch { return rid() }
  }
  const visitorId = persistentId(localStorage,   '__acme_showcase_v')
  const sessionId = persistentId(sessionStorage, '__acme_showcase_s')

  function send(eventName: string, payload: Record<string, unknown>): void {
    bumpCounter(eventName)
    fetch(`${ROUTE_BASE}/ingest`, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        eventName,
        payload,
        visitorId,
        sessionId,
        pagePath: location.pathname,
        referrer: document.referrer || null,
      }),
    }).catch(() => { /* fire-and-forget */ })
  }

  // ── Live counter overlay (used by the event-counter canvas module) ──
  const counts = new Map<string, number>()
  function bumpCounter(eventName: string) {
    const next = (counts.get(eventName) || 0) + 1
    counts.set(eventName, next)
    document
      .querySelectorAll(`[data-pb-counter="${CSS.escape(eventName)}"] [data-pb-counter-value]`)
      .forEach((el) => { el.textContent = String(next) })
  }

  // ── DOM listeners ───────────────────────────────────────────────────
  function firePageView() {
    send('page-view', { path: location.pathname, title: document.title })
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', firePageView, { once: true })
  } else {
    firePageView()
  }

  document.addEventListener('click', (e) => {
    const target = e.target as Element | null
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor) return
    send('link-click', {
      href: anchor.getAttribute('href') ?? '',
      text: (anchor.textContent ?? '').trim().slice(0, 80),
    })
  }, { capture: true })

  const seen: Record<number, true> = {}
  window.addEventListener('scroll', () => {
    const pct = Math.round((window.scrollY + window.innerHeight) / document.documentElement.scrollHeight * 100)
    for (const t of [25, 50, 75, 100]) {
      if (pct >= t && !seen[t]) { seen[t] = true; send('scroll-depth', { depth: t }) }
    }
  }, { passive: true })
})()
