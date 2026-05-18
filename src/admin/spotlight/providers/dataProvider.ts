/**
 * Data provider — live data table search via /admin/api/cms/data/tables.
 *
 * SERVER provider, 150 ms debounce.
 *
 * Searches data tables by name and slug (JS-side filter in the handler).
 * Each result navigates to /admin/data with the table selected.
 */

import type { SpotlightProvider, Command } from '../types'
import { parseJsonResponse } from '@core/utils/jsonValidate'
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
    let res: Response
    try {
      res = await fetch(url, { credentials: 'include', signal })
    } catch (err) {
      if ((err as Error).name === 'AbortError') return []
      throw err
    }

    if (!res.ok) {
      throw new Error(`Data tables search failed: ${res.status}`)
    }

    const body = await parseJsonResponse(res, DataTablesListResponseSchema)

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
