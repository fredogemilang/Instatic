/**
 * Data provider — live data table search via /admin/api/cms/data/tables.
 *
 * SERVER provider, 150 ms debounce.
 *
 * Searches data tables by name and slug (JS-side filter in the handler).
 * Each result navigates to /admin/data with the table selected.
 */

import type { SpotlightProvider, Command } from '../types'
import { apiRequest, isAbortError } from '@core/http'
import type { Static } from '@core/utils/typeboxHelpers'
import { DataTablesListResponseSchema } from './schemas'

const ENDPOINT = '/admin/api/cms/data/tables'
const MAX_RESULTS = 25

export const dataProvider: SpotlightProvider = {
  id: 'data',
  label: 'Data',
  debounceMs: 150,

  async search(query, _ctx, signal): Promise<Command[]> {
    if (!query.trim()) return []

    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&limit=${MAX_RESULTS}`
    let body: Static<typeof DataTablesListResponseSchema>
    try {
      body = await apiRequest(url, { schema: DataTablesListResponseSchema, signal })
    } catch (err) {
      if (isAbortError(err)) return []
      throw err
    }

    return body.tables.map((table): Command => ({
      id: `data:${table.id}`,
      title: table.name,
      subtitle: table.pluralLabel ? `${table.pluralLabel} · /${table.slug}` : `/${table.slug}`,
      group: 'data',
      iconName: 'table-solid',
      keywords: ['data', 'table', 'database', table.slug],
      run: (ctx) => {
        ctx.closeSpotlight()
        ctx.navigate(`/admin/data?table=${encodeURIComponent(table.id)}`)
      },
    }))
  },
}
