/**
 * Site fonts library mutations: addFont, removeFont.
 *
 * The store actions are purely client-side mutations on `settings.fonts.items`.
 * The caller (UI) owns the server install/cleanup flow and passes the
 * resulting `FontEntry` here; duplicate `family` (case-insensitive) on the
 * same `source` re-installs (replacing the existing entry).
 */

import type { SiteSlice, SiteSliceHelpers } from './types'

export type FontActions = Pick<SiteSlice, 'addFont' | 'removeFont'>

export function createFontActions({
  mutateSite,
}: SiteSliceHelpers): FontActions {
  return {
    addFont: (entry) => {
      mutateSite((site) => {
        site.settings.fonts ??= { items: [] }
        const lib = site.settings.fonts
        const familyLower = entry.family.toLowerCase()
        const idx = lib.items.findIndex(
          (f) => f.family.toLowerCase() === familyLower && f.source === entry.source,
        )
        if (idx >= 0) {
          // Re-install of the same font: replace the existing entry so newly
          // selected variants/subsets supersede the previous selection.
          lib.items[idx] = { ...entry, updatedAt: Date.now() }
        } else {
          lib.items.push(entry)
        }
        return true
      })
    },

    removeFont: (fontId) => {
      mutateSite((site) => {
        if (!site.settings.fonts) return false
        const nextItems = site.settings.fonts.items.filter((f) => f.id !== fontId)
        if (nextItems.length === site.settings.fonts.items.length) return false
        site.settings.fonts.items = nextItems
        return true
      })
    },
  }
}
