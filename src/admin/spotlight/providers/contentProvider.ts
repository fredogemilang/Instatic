/**
 * Content provider — live data row search via /admin/api/cms/data/search.
 *
 * SERVER provider, 150 ms debounce.
 *
 * "Content documents" in this CMS are data rows stored in data_tables.
 * The search endpoint filters by row slug (a URL-safe lowercase derivative
 * of the content title) and returns lightweight row summaries.
 *
 * Navigation: /admin/content?table=<tableSlug>&row=<rowId> — the content
 * workspace deep-links via these query params (see useContentWorkspace.ts).
 */

import type { SpotlightProvider, Command } from '../types'
import { apiRequest, isAbortError } from '@core/http'
import type { Static } from '@core/utils/typeboxHelpers'
import { DataSearchResponseSchema } from './schemas'

const ENDPOINT = '/admin/api/cms/data/search'
const MAX_RESULTS = 25

export const contentProvider: SpotlightProvider = {
  id: 'content',
  label: 'Content',
  debounceMs: 150,

  async search(query, _ctx, signal): Promise<Command[]> {
    if (!query.trim()) return []

    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&limit=${MAX_RESULTS}`
    let body: Static<typeof DataSearchResponseSchema>
    try {
      body = await apiRequest(url, { schema: DataSearchResponseSchema, signal })
    } catch (err) {
      if (isAbortError(err)) return []
      throw err
    }

    return body.entries.map((entry): Command => {
      // Humanise the slug for display: replace hyphens with spaces and capitalise.
      const displayTitle = entry.slug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ')

      return {
        id: `content:${entry.id}`,
        title: displayTitle,
        subtitle: `${entry.tableName} · ${formatDate(entry.updatedAt)}`,
        group: 'content',
        iconName: 'file-text-solid',
        keywords: ['content', 'document', entry.tableSlug, entry.slug],
        run: (ctx) => {
          ctx.closeSpotlight()
          ctx.navigate(`/admin/content?table=${encodeURIComponent(entry.tableSlug)}&row=${encodeURIComponent(entry.id)}`)
        },
      }
    })
  },
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
