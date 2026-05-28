/**
 * Public search route handler — GET /search
 *
 * Mounted at:
 *   /admin/api/cms/plugins/pagebuilder.search/runtime/search
 *
 * No authentication required — registered via `api.cms.routes.public.get`.
 * Plugin manifest declares `cms.routes.public` so the install dialog
 * flags the anonymous endpoint to the operator.
 *
 * Query parameters:
 *   q        — search query (required, trimmed, max 200 chars)
 *   page     — page number (integer ≥ 1, default 1)
 *   per-page — results per page (integer 1–50, default 10)
 *
 * Response shape (200):
 *   { results: SearchHit[], total: number, took_ms: number, query: string }
 *
 * Rate limit (429):
 *   { error: string, retry_after: number }
 *
 * Cache-Control: public, max-age=10 — short TTL so result freshness stays
 * acceptable without hammering the backend on every keystroke.
 */

import type { ServerPluginRouteContext } from '@pagebuilder/plugin-sdk'
import type { SearchBackend } from './backends/types'
import type { RateLimiter } from './rateLimit'
import { logQuery } from './analytics'
import type { ServerPluginApi } from '@pagebuilder/plugin-sdk'

// ---------------------------------------------------------------------------
// Param validation helpers (no TypeBox — sandbox internal)
// ---------------------------------------------------------------------------

function clampInt(raw: string | null, min: number, max: number, def: number): number {
  if (raw === null) return def
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return def
  return Math.max(min, Math.min(max, n))
}

function sanitiseQuery(raw: string | null): string {
  if (!raw) return ''
  return raw.trim().slice(0, 200)
}

// ---------------------------------------------------------------------------
// Route factory — returns a handler closed over the backend and limiter.
// ---------------------------------------------------------------------------

export interface SearchRouteHandlerOptions {
  backend: SearchBackend
  limiter: RateLimiter
  api: ServerPluginApi
}

/**
 * Build the route handler. Call once during `activate`, pass the result to
 * `api.cms.routes.public.get('/search', handler)`.
 */
export function buildSearchRouteHandler(opts: SearchRouteHandlerOptions) {
  const { backend, limiter, api } = opts

  return async function handleSearch(ctx: ServerPluginRouteContext): Promise<Response> {
    // ── Rate limit ─────────────────────────────────────────────────────────
    const ip = ctx.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      ?? ctx.req.headers.get('x-real-ip')
      ?? 'unknown'
    const rl = limiter.check(ip)
    if (rl.limited) {
      return new Response(
        JSON.stringify({ error: 'Too many requests', retry_after: rl.retryAfterSeconds }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(rl.retryAfterSeconds),
            'Cache-Control': 'no-store',
          },
        },
      )
    }

    // ── Parse query params ─────────────────────────────────────────────────
    const url = new URL(ctx.req.url)
    const q = sanitiseQuery(url.searchParams.get('q'))
    const page = clampInt(url.searchParams.get('page'), 1, 1000, 1)
    const perPage = clampInt(url.searchParams.get('per-page'), 1, 50, 10)

    if (!q) {
      return new Response(
        JSON.stringify({ results: [], total: 0, took_ms: 0, query: '' }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10' },
        },
      )
    }

    // ── Execute search ─────────────────────────────────────────────────────
    let results
    try {
      results = await backend.search(q, { page, perPage })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed'
      api.plugin.log('[search route] backend error:', message)
      return new Response(
        JSON.stringify({ error: 'Search service unavailable' }),
        {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        },
      )
    }

    // ── Log query (best-effort) ────────────────────────────────────────────
    const enableLogging = api.cms.settings.get<boolean>('enableQueryLogging') ?? true
    if (enableLogging) {
      void logQuery(api, q, results.total, results.tookMs)
    }

    // ── Respond ───────────────────────────────────────────────────────────
    const body = JSON.stringify({
      results: results.hits,
      total: results.total,
      took_ms: results.tookMs,
      query: q,
    })
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=10',
      },
    })
  }
}
