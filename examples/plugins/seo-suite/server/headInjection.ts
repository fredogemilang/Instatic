/**
 * SEO Suite — publish.html filter + page-index maintenance.
 *
 * The `publish.html` filter receives `{ siteId, pageId, slug }` directly in
 * its context — no Map bridge is needed. The seo-entries collection is cached
 * in memory and invalidated whenever a `content.entry.*` event mentions the
 * `seo-entries` resource. The cache removes one storage round-trip per
 * published page at the cost of a tiny memory footprint (one entry ≈ a few
 * hundred bytes).
 */
import type { ServerPluginApi, PluginRecord } from '@pagebuilder/plugin-sdk'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

// ---------------------------------------------------------------------------
// TypeBox schemas — resilient reads from storage.
// ---------------------------------------------------------------------------

const SeoEntrySchema = Type.Object({
  'page-id': Type.String(),
  'title-override': Type.Optional(Type.String()),
  'meta-description': Type.Optional(Type.String()),
  'og-title': Type.Optional(Type.String()),
  'og-description': Type.Optional(Type.String()),
  'og-image-url': Type.Optional(Type.String()),
  'twitter-card': Type.Optional(Type.String()),
  'canonical-url': Type.Optional(Type.String()),
  'no-index': Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
  'no-follow': Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
  'json-ld': Type.Optional(Type.String()),
})

type SeoEntry = {
  'page-id': string
  'title-override'?: string
  'meta-description'?: string
  'og-title'?: string
  'og-description'?: string
  'og-image-url'?: string
  'twitter-card'?: string
  'canonical-url'?: string
  'no-index'?: boolean | string
  'no-follow'?: boolean | string
  'json-ld'?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for use inside an HTML attribute value (double-quoted). */
function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Coerce a stored boolean-or-string to a proper boolean. */
function isTruthy(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value === 'true' || value === '1'
  return false
}

/** Extract the <title> content from an HTML string, or return null. */
function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!m || !m[1]) return null
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
}

/** Extract the href of <link rel="canonical"> from an HTML string, or null. */
function extractCanonical(html: string): string | null {
  const m = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)
    ?? /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html)
  return m?.[1] ?? null
}

/**
 * Escape `</` inside a JSON-LD <script> block to prevent script-tag-close
 * injection. This is the only HTML-context escaping JSON-LD needs.
 */
function escapeJsonLd(json: string): string {
  return json.replace(/<\//g, '<\\/')
}

/** Build a single <meta> tag string, escaping the value. */
function meta(name: string, value: string, prop?: boolean): string {
  const attr = prop ? 'property' : 'name'
  return `<meta ${attr}="${escapeAttr(name)}" content="${escapeAttr(value)}">`
}

// ---------------------------------------------------------------------------
// Module-level state — safe because the plugin VM is single-threaded.
// ---------------------------------------------------------------------------

/** In-memory cache of seo-entries; null means "not loaded yet". */
let seoEntriesCache: PluginRecord[] | null = null

// ---------------------------------------------------------------------------
// Exported registration function
// ---------------------------------------------------------------------------

export function registerHeadInjection(api: ServerPluginApi): void {
  const seoEntries = api.cms.storage.collection('seo-entries')
  const pageIndex = api.cms.storage.collection('page-index')

  // ── Cache invalidation on seo-entries mutations ──────────────────────────
  api.cms.hooks.on('content.entry.created', (evt) => {
    if ((evt as { tableSlug?: string }).tableSlug === 'seo-entries') {
      seoEntriesCache = null
    }
  })
  api.cms.hooks.on('content.entry.updated', (evt) => {
    if ((evt as { tableSlug?: string }).tableSlug === 'seo-entries') {
      seoEntriesCache = null
    }
  })
  api.cms.hooks.on('content.entry.deleted', (evt) => {
    if ((evt as { tableSlug?: string }).tableSlug === 'seo-entries') {
      seoEntriesCache = null
    }
  })

  // ── publish.html filter — inject meta tags + maintain page-index ──────────
  api.cms.hooks.filter('publish.html', async (html, { pageId, slug }) => {
    if (typeof html !== 'string') return html

    // ── Load seo-entries (cached) ─────────────────────────────────────────
    try {
      if (seoEntriesCache === null) {
        const { records } = await seoEntries.list()
        seoEntriesCache = records
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.plugin.log('[seo-suite] Failed to load seo-entries cache:', message)
      return html
    }

    // Find the entry for this page (may be undefined — defaults apply).
    let entry: SeoEntry | undefined
    for (const record of seoEntriesCache) {
      if (!Value.Check(SeoEntrySchema, record.data)) continue
      const candidate = record.data as SeoEntry
      if (candidate['page-id'] === pageId) {
        entry = candidate
        break
      }
    }

    // ── Read settings live ────────────────────────────────────────────────
    const siteUrl = (api.cms.settings.get<string>('siteUrl') ?? '').replace(/\/$/, '')
    const siteName = api.cms.settings.get<string>('siteName') ?? ''
    const defaultOgImage = api.cms.settings.get<string>('defaultOgImage') ?? ''
    const twitterHandle = api.cms.settings.get<string>('twitterHandle') ?? ''
    const enableJsonLd = api.cms.settings.get<boolean>('enableJsonLd') ?? true
    const defaultNoIndex = api.cms.settings.get<boolean>('defaultNoIndex') ?? false

    // ── Derive values from HTML + entry ────────────────────────────────────
    const htmlTitle = extractTitle(html)
    const htmlCanonical = extractCanonical(html)

    const noIndex = entry ? isTruthy(entry['no-index']) : defaultNoIndex
    const noFollow = entry ? isTruthy(entry['no-follow']) : false
    const canonicalUrl = entry?.['canonical-url'] || htmlCanonical || ''
    const pageTitle = entry?.['title-override'] || htmlTitle || ''
    const metaDescription = entry?.['meta-description'] ?? ''
    const ogTitle = entry?.['og-title'] || pageTitle
    const ogDescription = entry?.['og-description'] || metaDescription
    const ogImageUrl = entry?.['og-image-url'] || defaultOgImage
    const twitterCard = entry?.['twitter-card'] || 'summary_large_image'
    const customJsonLd = entry?.['json-ld'] ?? ''

    // ── Build the <head> injection block ──────────────────────────────────
    const tags: string[] = []

    // Robots meta — always emit when no-index or no-follow is set.
    if (noIndex || noFollow) {
      const robotsContent = [noIndex ? 'noindex' : '', noFollow ? 'nofollow' : '']
        .filter(Boolean)
        .join(', ')
      tags.push(meta('robots', robotsContent))
    }

    // Canonical link — only emit if we have a URL and none exists already.
    if (canonicalUrl && !htmlCanonical) {
      tags.push(`<link rel="canonical" href="${escapeAttr(canonicalUrl)}">`)
    }

    // Meta description.
    if (metaDescription) {
      tags.push(meta('description', metaDescription))
    }

    // Open Graph tags.
    if (ogTitle) tags.push(meta('og:title', ogTitle, true))
    if (ogDescription) tags.push(meta('og:description', ogDescription, true))
    if (ogImageUrl) tags.push(meta('og:image', ogImageUrl, true))
    if (siteName) tags.push(meta('og:site_name', siteName, true))
    if (canonicalUrl) tags.push(meta('og:url', canonicalUrl, true))
    tags.push(meta('og:type', 'website', true))

    // Twitter card tags.
    tags.push(meta('twitter:card', twitterCard))
    if (ogTitle) tags.push(meta('twitter:title', ogTitle))
    if (ogDescription) tags.push(meta('twitter:description', ogDescription))
    if (ogImageUrl) tags.push(meta('twitter:image', ogImageUrl))
    if (twitterHandle) tags.push(meta('twitter:site', twitterHandle))

    // JSON-LD — custom overrides auto-generated; auto only when enabled.
    if (customJsonLd) {
      tags.push(`<script type="application/ld+json">${escapeJsonLd(customJsonLd)}</script>`)
    } else if (enableJsonLd) {
      const webPageSchema: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: pageTitle || siteName,
        ...(canonicalUrl ? { url: canonicalUrl } : {}),
        ...(metaDescription ? { description: metaDescription } : {}),
      }
      const webSiteSchema: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: siteName || pageTitle,
        ...(siteUrl ? { url: siteUrl } : {}),
      }
      const schemaArray = [webPageSchema, webSiteSchema]
      tags.push(
        `<script type="application/ld+json">${escapeJsonLd(JSON.stringify(schemaArray))}</script>`,
      )
    }

    if (tags.length > 0) {
      const injection = '\n' + tags.map((t) => `  ${t}`).join('\n') + '\n'
      const headCloseIndex = html.indexOf('</head>')
      if (headCloseIndex === -1) {
        // Malformed HTML — return unchanged.
        return html
      }
      html =
        html.slice(0, headCloseIndex) +
        injection +
        html.slice(headCloseIndex)
    }

    // ── Upsert page-index ─────────────────────────────────────────────────
    // slug comes from the filter context — no URL reverse-engineering needed.
    // Best-effort — never crash the publish pipeline on a storage failure.
    try {
      const pageUrl = canonicalUrl || (siteUrl ? `${siteUrl}/${slug.replace(/^\//, '')}` : '')
      const now = new Date().toISOString()

      // Find the existing page-index record for this pageId.
      const { records: existingPageRecords } = await pageIndex.list({ filter: { 'page-id': pageId } })
      const existingRecord = existingPageRecords[0]

      const indexData: Record<string, unknown> = {
        'page-id': pageId,
        slug,
        url: pageUrl,
        title: pageTitle,
        'last-seen-at': now,
      }

      if (existingRecord) {
        await pageIndex.update(existingRecord.id, indexData)
      } else {
        await pageIndex.create(indexData)
      }

      // Also update seo-entry's last-rendered-* fields if an entry exists.
      if (entry && seoEntriesCache !== null) {
        const seoRecord = seoEntriesCache.find(
          (r) => Value.Check(SeoEntrySchema, r.data) &&
            (r.data as SeoEntry)['page-id'] === pageId,
        )
        if (seoRecord) {
          await seoEntries.update(seoRecord.id, {
            ...seoRecord.data,
            'last-rendered-url': pageUrl,
            'last-rendered-title': pageTitle,
            'last-rendered-at': now,
          })
          // Invalidate cache so the ogImage job sees fresh data.
          seoEntriesCache = null
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      api.plugin.log('[seo-suite] page-index upsert failed:', message)
      // Do NOT return — html is already modified above; fall through to return it.
    }

    return html
  })
}
