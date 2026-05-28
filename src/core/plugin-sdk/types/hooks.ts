// ---------------------------------------------------------------------------
// CMS server-side hook event surface
// ---------------------------------------------------------------------------

export interface CmsServerEvents {
  'publish.before': { siteId: string; pageId?: string }
  'publish.after': { siteId: string; pageId?: string }
  'content.entry.created': { tableSlug: string; entryId: string }
  'content.entry.updated': { tableSlug: string; entryId: string }
  'content.entry.deleted': { tableSlug: string; entryId: string }
  // Plugin-defined events fall through. The host does not pre-define any
  // frontend-specific event channels — plugins that ingest events from
  // their own published-page bundles register their own `routes.public.post`
  // endpoints and (optionally) re-emit on the hook bus under a namespaced
  // name (`pagebuilder.analytics.page-view`) for cross-plugin coordination.
  [key: string]: Record<string, unknown>
}

export interface CmsServerFilters {
  'publish.html': string
  'publish.headers': Record<string, string>
  // Plugin-defined filters fall through.
  [key: string]: unknown
}

/**
 * Extra context fields passed to filter handlers alongside `{ pluginId }`.
 * Keyed by filter name; only named filters carry structured context — the
 * generic fallthrough gets `Record<string, unknown>`.
 *
 * Filter handlers destructure what they need:
 * ```ts
 * api.cms.hooks.filter('publish.html', (html, { siteId, pageId, slug }) => {
 *   return html.replace('</body>', `<!-- page:${slug} -->\n</body>`)
 * })
 * ```
 */
export interface CmsServerFilterContexts {
  'publish.html': { siteId: string; pageId: string; slug: string }
  'publish.headers': { siteId: string; pageId: string; slug: string }
}

export interface ServerPluginHooksApi {
  on: <K extends keyof CmsServerEvents | string>(
    event: K,
    listener: (
      payload: K extends keyof CmsServerEvents ? CmsServerEvents[K] : Record<string, unknown>,
    ) => void | Promise<void>,
  ) => void
  filter: <K extends keyof CmsServerFilters | string>(
    name: K,
    handler: (
      value: K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown,
      context: { pluginId: string } & (
        K extends keyof CmsServerFilterContexts ? CmsServerFilterContexts[K] : Record<string, unknown>
      ),
    ) =>
      | (K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown)
      | Promise<K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown>,
  ) => void
  emit: <K extends keyof CmsServerEvents | string>(
    event: K,
    payload: K extends keyof CmsServerEvents ? CmsServerEvents[K] : Record<string, unknown>,
  ) => Promise<void>
}
