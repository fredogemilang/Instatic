import { handleAgentRequest, handleAgentToolResult } from './handlers/agent'
import { handleCmsRequest } from './handlers/cms'
import { handlePublicTrackerRequest, isPublicTrackerPath } from './handlers/cms/tracker'
import type { DbClient } from './db/client'
import {
  getDataRowRedirectByRoute,
  getPublishedDataRowByRoute,
} from './repositories/data/publish'
import { getLatestPublishedSiteSnapshot, getPublishedPageBySlug } from './repositories/publish'
import { renderPublishedDataRowTemplate, renderPublishedSnapshot } from './publish/publicRenderer'
import { renderDataRowDocumentHtml } from './publish/dataRenderer'
import { getSetupStatus } from './repositories/setup'
import { getPublishedRuntimeAsset } from './repositories/runtimeAsset'
import { handleLoopRequest, isLoopRuntimeAssetPath, serveLoopRuntimeAsset } from './handlers/cms/loop'
import { isRuntimePackagePath, tryServeRuntimePackage } from './publish/runtime/packageServer'
import { jsonResponse } from './http'
import { hardenUploadResponse, serveAdminApp, serveStaticFile } from './static'
import { registry } from '@core/module-engine/registry'
import type { CssBundleFile } from '@core/publisher/siteCssBundle'
import { buildSiteCssBundle } from './publish/siteCssBundle'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'

const VITE_DEV_URL = 'http://localhost:5173'

interface ServerRuntime {
  db: DbClient
  staticDir?: string
  uploadsDir?: string
}

/**
 * A route handler returns a `Response` if it owns the request, or `null` if
 * the URL/method doesn't match — the dispatcher walks the `routes` table and
 * returns the first non-null response. Prefix-namespaced handlers (e.g.
 * `/_pb/css/`, `/_pb/runtime/cache/`) absorb their entire namespace and emit
 * a 404 themselves rather than falling through, so unknown paths under a
 * known prefix can't accidentally match a later route.
 */
type RouteHandler = (
  req: Request,
  runtime: ServerRuntime,
  url: URL,
  pathname: string,
) => Promise<Response | null> | Response | null

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * The ordered routing table. Routes are tried top-to-bottom; the first match
 * wins. Adding a new endpoint is a one-line edit here plus a focused
 * `tryServeX` function below — no per-call type juggling and no editing the
 * dispatcher loop.
 */
const routes: readonly RouteHandler[] = [
  tryServeHealth,
  tryServeAgent,
  tryServeAgentToolResult,
  tryServeCmsApi,
  tryServeLoopRuntimeAsset,
  tryServeLoop,
  tryServePublicTracker,
  tryServeRuntimeAsset,
  tryServeRuntimePackageNamespace,
  tryServeSiteCssNamespace,
  tryServeMediaRedirect,
  tryServeStaticAsset,
  tryServeUpload,
  tryServeAdminApp,
  tryServePublishedPage,
  tryServeContentRoute,
  trySetupRedirect,
]

export async function handleServerRequest(
  req: Request,
  runtime: ServerRuntime,
): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url

  for (const route of routes) {
    const response = await route(req, runtime, url, pathname)
    if (response) return response
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function publicSlugFromPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'index' : trimmed
}

function contentRouteFromPath(pathname: string): { tableRouteBase: string; rowSlug: string } | null {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (parts.length < 2) return null
  return {
    tableRouteBase: `/${parts.slice(0, -1).map((part) => decodeURIComponent(part)).join('/')}`,
    rowSlug: decodeURIComponent(parts[parts.length - 1]),
  }
}

// ---------------------------------------------------------------------------
// Route handlers
//
// Each function checks its own method/path and returns `Response | null`.
// Order matters — see `routes` above.
// ---------------------------------------------------------------------------

function tryServeHealth(_req: Request, _runtime: ServerRuntime, _url: URL, pathname: string): Response | null {
  if (pathname !== '/health') return null
  return jsonResponse({ status: 'ok', ts: Date.now() })
}

/**
 * Agent endpoints live under `/admin/api/agent[/...]` (not their own
 * `/api/agent` prefix) so the admin session cookie — scoped to
 * `Path=/admin` to keep it off the public site — is actually carried to
 * them. Without that, the capability gate inside the handlers would 401
 * every request. Matched before the broader `/admin/api/cms/` route
 * because the agent paths don't include `cms` and must not be swallowed
 * by the CMS dispatcher.
 *
 * The F-0008 architecture gate (`agent-endpoint-auth.test.ts`) scans this
 * file for the literal calls `handleAgentRequest(req, runtime.db)` and
 * `handleAgentToolResult(req, runtime.db)` to ensure the `DbClient` flows
 * into the handlers' auth checks. Keep those literals here.
 */
function tryServeAgent(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response> | null {
  if (pathname !== '/admin/api/agent') return null
  return handleAgentRequest(req, runtime.db)
}

function tryServeAgentToolResult(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response> | null {
  if (pathname !== '/admin/api/agent/tool-result') return null
  return handleAgentToolResult(req, runtime.db)
}

function tryServeCmsApi(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response> | null {
  if (!pathname.startsWith('/admin/api/cms/')) return null
  return handleCmsRequest(req, runtime.db, { uploadsDir: runtime.uploadsDir })
}

/**
 * The loop runtime is a fixed CMS asset, served before the per-site
 * runtime asset lookup so the request never falls through.
 */
function tryServeLoopRuntimeAsset(req: Request, _runtime: ServerRuntime, _url: URL, pathname: string): Response | null {
  if (req.method !== 'GET' || !isLoopRuntimeAssetPath(pathname)) return null
  return serveLoopRuntimeAsset()
}

function tryServeLoop(req: Request, runtime: ServerRuntime, url: URL, pathname: string): Promise<Response> | null {
  if (!pathname.startsWith('/_pb/loop/')) return null
  return handleLoopRequest(req, url, { db: runtime.db })
}

/**
 * Frontend tracker — the runtime injected into published pages POSTs
 * structured events here. No admin auth: the endpoint is public by design,
 * events are scoped per plugin grant, and abuse mitigation belongs at the
 * edge (rate limit / CSRF) for the host operator to configure.
 */
function tryServePublicTracker(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response> | null {
  if (!isPublicTrackerPath(pathname)) return null
  return handlePublicTrackerRequest(req, runtime.db)
}

async function tryServeRuntimeAsset(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET' || !pathname.startsWith('/_pb/assets/')) return null
  const runtimeAsset = await getPublishedRuntimeAsset(runtime.db, pathname)
  if (!runtimeAsset) return null
  const body = new ArrayBuffer(runtimeAsset.bytes.byteLength)
  new Uint8Array(body).set(runtimeAsset.bytes)
  return new Response(body, {
    headers: {
      'content-type': runtimeAsset.contentType,
      'cache-control': 'public, max-age=31536000, immutable',
    },
  })
}

/**
 * Per-site runtime dependency cache — served from the hashed
 * `bun install` workspace under `/_pb/runtime/cache/<hash>/<...path>`.
 * The publisher emits a `<script type="importmap">` mapping bare
 * specifiers like `three` to URLs in this namespace, so plugin module
 * scripts and frontend bundles share a single locally-installed copy
 * of every site dependency.
 *
 * The /_pb/runtime/cache/ namespace is exclusive: unknown paths under it
 * 404 here rather than falling through to a later matcher.
 */
async function tryServeRuntimePackageNamespace(req: Request, _runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> {
  if (!isRuntimePackagePath(pathname)) return null
  return (await tryServeRuntimePackage(req, pathname)) ?? new Response('not found', { status: 404 })
}

/**
 * Per-site CSS bundle — `reset-<hash>.css`, `framework-<hash>.css`,
 * `style-<hash>.css`. Filenames embed a content hash, so responses can
 * use `Cache-Control: immutable` for a year. Stale-hash requests 404 so
 * the browser falls back to refetching the HTML (which carries the new
 * hash).
 *
 * The /_pb/css/ namespace is exclusive: any unknown path under it is a
 * 404, never falls through to the public-slug handler. That prevents an
 * unrelated path like `/_pb/css/anything.css` from accidentally
 * rendering the homepage.
 */
async function tryServeSiteCssNamespace(req: Request, runtime: ServerRuntime, _url: URL, pathname: string): Promise<Response | null> {
  if (req.method !== 'GET' || !pathname.startsWith('/_pb/css/')) return null
  return (await serveSiteCss(runtime.db, pathname)) ?? new Response('Not found', { status: 404 })
}

/**
 * Resolve a media asset request that lives on a plugin-registered storage
 * adapter with `servingMode !== 'public-url'`.
 *
 * `dispatchUpload` synthesises a host-owned URL of the shape
 *   /_pb/media/<adapterId>/<storagePath>
 * for non-public-url writes, then stores that on `media_assets.public_path`
 * (or inside each variant's `path`). Browsers hit this route; we ask the
 * adapter for a freshly-signed read URL and 302-redirect.
 *
 * The route is exclusive: an unknown adapter id or missing `getReadUrl`
 * returns 404 here rather than falling through to the public-slug handler.
 * That keeps a misconfigured storage backend from being silently swallowed
 * by the published-page renderer.
 *
 * Variants get the same treatment automatically — the variant URLs in
 * `variants_json` carry this same shape, so the renderer's `<img srcset>`
 * emission Just Works without per-variant DB indexing.
 */
async function tryServeMediaRedirect(
  req: Request,
  _runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!pathname.startsWith('/_pb/media/')) return null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 })
  }
  const match = pathname.match(/^\/_pb\/media\/([^/]+)\/(.+)$/)
  if (!match) return new Response('Not found', { status: 404 })
  const adapterId = decodeURIComponent(match[1])
  const storagePath = decodeURIComponent(match[2])
  // Local-disk asset URLs never use this route (the dispatcher's
  // `buildSignedRedirectUrl` only fires for non-built-in adapters with
  // `servingMode !== 'public-url'`). A request that pretends to be one is
  // an attacker probe — 404 it.
  if (!adapterId) return new Response('Not found', { status: 404 })
  const adapter = mediaStorageRegistry.resolveForRead(adapterId)
  if (!adapter || !adapter.getReadUrl) {
    return new Response('Not found', { status: 404 })
  }
  let signed: { url: string; expiresAt: number }
  try {
    // 1 hour TTL — long enough that browser-side fetches and CDN warm-ups
    // succeed, short enough that a leaked signed URL becomes useless fast.
    signed = await adapter.getReadUrl(storagePath, 3600)
  } catch (err) {
    console.error(`[router] adapter "${adapterId}" getReadUrl failed:`, err)
    return new Response('Not found', { status: 404 })
  }
  // No cache header on the 302 itself — the redirect target is signed and
  // expires; we want every browser navigation to hit us for a fresh signature
  // rather than reuse a stale one.
  return new Response(null, {
    status: 302,
    headers: {
      'location': signed.url,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

async function tryServeStaticAsset(
  _req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!runtime.staticDir || !pathname.startsWith('/assets/')) return null
  return await serveStaticFile(runtime.staticDir, pathname, _req)
}

async function tryServeUpload(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  if (!runtime.uploadsDir || !pathname.startsWith('/uploads/')) return null
  const upload = await serveStaticFile(runtime.uploadsDir, pathname.slice('/uploads'.length), req)
  if (!upload) return null
  // Defense-in-depth: even though the upload handler now writes only
  // server-chosen extensions, the static handler still derives Content-Type
  // from the on-disk extension. `hardenUploadResponse` adds the `nosniff`
  // and (for non-inert MIMEs) `attachment` headers so a stray non-allowlisted
  // file in the uploads dir can never be top-level navigated and rendered as
  // HTML on the admin origin. See `INERT_UPLOAD_MIMES` in `static.ts`.
  const hardened = hardenUploadResponse(upload)
  // Plugin bundles live under `/uploads/plugins/<id>/<version>/...`. The
  // editor's preview iframe loads them with `sandbox="allow-scripts"` (no
  // `allow-same-origin`), which puts the iframe in an opaque origin —
  // module fetches across that boundary need CORS. Plugin assets are
  // distribution code (frontend bundles, plugin-shipped images), so
  // allow-all is correct here. Non-plugin uploads stay default-deny.
  if (pathname.startsWith('/uploads/plugins/')) {
    const headers = new Headers(hardened.headers)
    headers.set('access-control-allow-origin', '*')
    headers.set('cross-origin-resource-policy', 'cross-origin')
    return new Response(hardened.body, {
      status: hardened.status,
      statusText: hardened.statusText,
      headers,
    })
  }
  return hardened
}

async function tryServeAdminApp(
  req: Request,
  runtime: ServerRuntime,
  _url: URL,
  pathname: string,
): Promise<Response | null> {
  const isAdminPath = pathname === '/admin' || pathname.startsWith('/admin/')
  if (!isAdminPath) return null

  if (runtime.staticDir) {
    const adminApp = await serveAdminApp(runtime.staticDir, req)
    if (adminApp) return adminApp
  }
  // Admin SPA isn't served from this port (dev mode, or production missing a
  // build). Tell the developer where to actually find it.
  return adminUiNotBuiltResponse(pathname)
}

/**
 * Render the explicit page snapshot stored under `pages/<slug>` if one
 * exists for this URL. Returns `null` when the slug doesn't resolve to a
 * published page — the dispatcher then falls through to the content-entry
 * lookup.
 */
async function tryServePublishedPage(req: Request, runtime: ServerRuntime, url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  const snapshot = await getPublishedPageBySlug(runtime.db, publicSlugFromPath(url.pathname))
  if (!snapshot) return null
  return new Response(await renderPublishedSnapshot(snapshot, { db: runtime.db, url }), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/**
 * Resolve a URL like `/posts/hello-world` against the data row registry.
 * - If the row exists at its current route, render it through the site
 *   template (or fall back to a 404 when no template matches).
 * - Otherwise consult the redirect table and 301 to the row's new home.
 *
 * Returns `null` for paths that don't carry at least a `/table/slug`
 * shape; the dispatcher then continues to the setup-wizard redirect.
 */
async function tryServeContentRoute(req: Request, runtime: ServerRuntime, url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  const route = contentRouteFromPath(url.pathname)
  if (!route) return null

  const { db } = runtime
  const row = await getPublishedDataRowByRoute(db, route.tableRouteBase, route.rowSlug)
  if (row) {
    const siteSnapshot = await getLatestPublishedSiteSnapshot(db)
    const templateHtml = siteSnapshot
      ? await renderPublishedDataRowTemplate(siteSnapshot, row, { db, url })
      : null
    // Pass the published site + URL through so the fallback document
    // can build proper page/site/route frames and resolve tokens like
    // `{site.name}` and `{route.path}` in row cells.
    const html = templateHtml ?? renderDataRowDocumentHtml(row, {
      site: siteSnapshot?.site,
      url,
    })
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  const redirect = await getDataRowRedirectByRoute(db, route.tableRouteBase, route.rowSlug)
  if (redirect) {
    return new Response(null, {
      status: 301,
      headers: { location: `${redirect.targetPath}${url.search}` },
    })
  }

  return null
}

/**
 * On a fresh install with no admin user yet, bounce the visitor to /admin so
 * they land in the setup wizard instead of seeing a confusing 404. Returns
 * null when the install is already past setup.
 */
async function trySetupRedirect(req: Request, runtime: ServerRuntime, _url: URL, _pathname: string): Promise<Response | null> {
  if (req.method !== 'GET') return null
  const setupStatus = await getSetupStatus(runtime.db)
  return setupStatus.needsSetup
    ? new Response(null, { status: 302, headers: { location: '/admin' } })
    : null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function adminUiNotBuiltResponse(pathname: string): Response {
  const targetUrl = `${VITE_DEV_URL}${pathname}`
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Admin UI not served on this port</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 32px; background: #000; color: #ededed; line-height: 1.5; }
  a { color: #fff; }
  code { background: #111; padding: 2px 6px; border-radius: 3px; }
</style>
</head>
<body>
<h1>Admin UI not served on this port</h1>
<p>This is the CMS API server (port 3001). In development, the admin UI is served by the Vite dev server.</p>
<p>Open <a href="${targetUrl}">${targetUrl}</a>.</p>
<p>If Vite isn't running yet, start it with <code>bun run dev</code> from the project root.</p>
</body>
</html>`
  return new Response(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

/**
 * Serve one of the three site CSS bundle files (reset / framework / style).
 *
 * The URL path is `/_pb/css/<bundle>-<hash>.css` where `<bundle>` is the
 * logical layer name and `<hash>` is the 12-hex SHA-256 prefix that
 * `buildSiteCssBundle` produces. We rebuild the bundle from the latest
 * published snapshot on every request, which is fine because:
 *
 *  - Bundles are tiny (kB) and the build is microseconds (deduped by moduleId).
 *  - Browsers / CDNs cache the response for a year (`immutable`), so this
 *    handler only fires for the FIRST visitor of a given hash.
 *  - When a hash changes (the site or its classes were edited), HTML pages
 *    re-render with the new `<link href>` referencing the new filename, and
 *    visitors fetch the new bundle exactly once.
 *
 * Stale hash → 404 so the browser falls back to refetching the HTML, which
 * carries the current hash. Returning the new content under the old name
 * would defeat `immutable` caching by serving different bytes for the same
 * URL across the cache lifetime.
 */
async function serveSiteCss(db: DbClient, pathname: string): Promise<Response | null> {
  const filename = pathname.slice('/_pb/css/'.length)
  const match = filename.match(/^(reset|framework|style)-([a-f0-9]{12})\.css$/)
  if (!match) return null

  const [, requestedBundle, requestedHash] = match
  const snapshot = await getLatestPublishedSiteSnapshot(db)
  if (!snapshot) return new Response('Not found', { status: 404 })

  const bundle = buildSiteCssBundle(snapshot.site, registry)
  const file: CssBundleFile = bundle[requestedBundle as 'reset' | 'framework' | 'style']
  if (file.hash !== requestedHash) {
    return new Response('Not found', { status: 404 })
  }

  return new Response(file.content, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      etag: `"${file.hash}"`,
    },
  })
}
