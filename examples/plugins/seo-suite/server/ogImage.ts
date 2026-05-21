/**
 * SEO Suite — daily OG image generation job.
 *
 * Wakes at 02:30 UTC, scans seo-entries for pages that have been rendered at
 * least once (have a `last-rendered-title`) but have no `og-image-url`, then
 * calls the operator-configured provider endpoint to generate one.
 *
 * Provider contract: POST { title, description, siteName, url } → 200 { url: string }
 * See README.md for more details and a self-hosted example.
 *
 * Security: `networkAllowedHosts` in pb-plugin.config.ts is empty by default.
 * The operator must add their provider host there and rebuild before this job
 * can make any outbound calls — fail-closed design.
 */
import type { ServerPluginApi, PluginRecord } from '@pagebuilder/plugin-sdk'
import { Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

// ---------------------------------------------------------------------------
// TypeBox schema for the OG image provider response.
// ---------------------------------------------------------------------------

const OgImageProviderResponseSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
})

// ---------------------------------------------------------------------------
// TypeBox schema for a seo-entry row read from storage.
// ---------------------------------------------------------------------------

const SeoEntrySchema = Type.Object({
  'page-id': Type.String(),
  'og-image-url': Type.Optional(Type.String()),
  'last-rendered-title': Type.Optional(Type.String()),
  'last-rendered-url': Type.Optional(Type.String()),
  'meta-description': Type.Optional(Type.String()),
})

type SeoEntry = {
  'page-id': string
  'og-image-url'?: string
  'last-rendered-title'?: string
  'last-rendered-url'?: string
  'meta-description'?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds — used for inter-request rate limiting. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // QuickJS supports setTimeout — if not available, fall back to busy-wait.
    if (typeof setTimeout !== 'undefined') {
      setTimeout(resolve, ms)
    } else {
      resolve()
    }
  })
}

// ---------------------------------------------------------------------------
// Exported registration function
// ---------------------------------------------------------------------------

export function registerOgImageJob(api: ServerPluginApi): void {
  api.cms.schedule.register({
    id: 'og-image-daily',
    cadence: { interval: 'daily', at: '02:30' },
    maxDurationMs: 60_000,
    overlap: 'skip',
    handler: async () => {
      const providerUrl = api.cms.settings.get<string>('ogImageProviderUrl') ?? ''
      if (!providerUrl) {
        api.plugin.log('[seo-suite] OG image provider not configured — skipping.')
        return
      }

      const siteName = api.cms.settings.get<string>('siteName') ?? ''

      let allRecords: PluginRecord[]
      try {
        const { records } = await api.cms.storage.collection('seo-entries').list()
        allRecords = records
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        api.plugin.log('[seo-suite] og-image-daily: failed to list seo-entries:', message)
        return
      }

      // Candidates: validated entries that have a rendered title but no OG image.
      const candidates: Array<{ recordId: string; entry: SeoEntry; data: Record<string, unknown> }> = []
      for (const record of allRecords) {
        if (!Value.Check(SeoEntrySchema, record.data)) continue
        const entry = record.data as SeoEntry
        const hasTitle = Boolean(entry['last-rendered-title'])
        const hasImage = Boolean(entry['og-image-url'])
        if (hasTitle && !hasImage) {
          candidates.push({ recordId: record.id, entry, data: record.data as Record<string, unknown> })
        }
      }

      if (candidates.length === 0) {
        api.plugin.log('[seo-suite] og-image-daily: no candidates need an OG image.')
        return
      }

      api.plugin.log(`[seo-suite] og-image-daily: generating OG images for ${candidates.length} page(s).`)

      const seoEntriesCollection = api.cms.storage.collection('seo-entries')

      for (const { recordId, entry, data } of candidates) {
        const title = entry['last-rendered-title'] ?? ''
        const description = entry['meta-description'] ?? ''
        const url = entry['last-rendered-url'] ?? ''

        try {
          const response = await fetch(providerUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, description, siteName, url }),
            signal: AbortSignal.timeout(15_000),
          })

          if (!response.ok) {
            api.plugin.log(
              `[seo-suite] og-image render failed for page ${entry['page-id']}: HTTP ${response.status}`,
            )
            continue
          }

          let responseBody: unknown
          try {
            responseBody = await response.json()
          } catch {
            api.plugin.log(
              `[seo-suite] og-image render failed for page ${entry['page-id']}: invalid JSON response`,
            )
            continue
          }

          if (!Value.Check(OgImageProviderResponseSchema, responseBody)) {
            api.plugin.log(
              `[seo-suite] og-image render failed for page ${entry['page-id']}: response missing "url" field`,
            )
            continue
          }

          const imageUrl = responseBody.url

          await seoEntriesCollection.update(recordId, {
            ...data,
            'og-image-url': imageUrl,
          })

          api.plugin.log(
            `[seo-suite] og-image-daily: set OG image for page ${entry['page-id']}: ${imageUrl}`,
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          api.plugin.log(
            `[seo-suite] og-image render failed for page ${entry['page-id']}:`,
            message,
          )
        }

        // Rate-limit: at most 1 request per 500ms to avoid hammering the provider.
        await sleep(500)
      }

      api.plugin.log('[seo-suite] og-image-daily: done.')
    },
  })
}
