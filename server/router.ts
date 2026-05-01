import { handleAgentRequest } from './agentHandler'
import { handleCmsRequest } from './cms/handlers'
import type { DbClient } from './cms/db'
import { getPublishedContentEntryByRoute } from './cms/contentRepository'
import { renderContentDocumentHtml } from './cms/contentRenderer'
import { getPublishedPageBySlug } from './cms/publishRepository'
import { renderPublishedSnapshot } from './cms/publicRenderer'
import { jsonResponse } from './http'
import { serveAdminApp, serveStaticFile } from './static'

export interface ServerRuntime {
  db: DbClient
  staticDir?: string
  uploadsDir?: string
}

function publicSlugFromPath(pathname: string): string {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? 'index' : trimmed
}

function contentRouteFromPath(pathname: string): { collectionSlug: string; entrySlug: string } | null {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  if (parts.length !== 2) return null
  return {
    collectionSlug: decodeURIComponent(parts[0]),
    entrySlug: decodeURIComponent(parts[1]),
  }
}

export async function handleServerRequest(
  req: Request,
  runtime: ServerRuntime,
): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === '/health') {
    return jsonResponse({ status: 'ok', ts: Date.now() })
  }

  if (url.pathname.startsWith('/api/cms/')) {
    return handleCmsRequest(req, runtime.db, { uploadsDir: runtime.uploadsDir })
  }

  if (url.pathname === '/api/agent') {
    return handleAgentRequest(req)
  }

  if (runtime.staticDir && url.pathname.startsWith('/assets/')) {
    const asset = await serveStaticFile(runtime.staticDir, url.pathname)
    if (asset) return asset
  }

  if (runtime.uploadsDir && url.pathname.startsWith('/uploads/')) {
    const upload = await serveStaticFile(runtime.uploadsDir, url.pathname.slice('/uploads'.length))
    if (upload) return upload
  }

  if (
    runtime.staticDir &&
    (url.pathname === '/admin' || url.pathname.startsWith('/admin/'))
  ) {
    const adminApp = await serveAdminApp(runtime.staticDir)
    if (adminApp) return adminApp
  }

  if (req.method === 'GET') {
    const snapshot = await getPublishedPageBySlug(runtime.db, publicSlugFromPath(url.pathname))
    if (snapshot) {
      return new Response(renderPublishedSnapshot(snapshot), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    const contentRoute = contentRouteFromPath(url.pathname)
    if (contentRoute) {
      const entry = await getPublishedContentEntryByRoute(
        runtime.db,
        contentRoute.collectionSlug,
        contentRoute.entrySlug,
      )
      if (entry) {
        return new Response(renderContentDocumentHtml({
          title: entry.title,
          bodyMarkdown: entry.bodyMarkdown,
          seoTitle: entry.seoTitle,
          seoDescription: entry.seoDescription,
          featuredMediaPath: entry.featuredMediaPath,
        }), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
    }
  }

  return jsonResponse({ error: 'Not found' }, { status: 404 })
}
