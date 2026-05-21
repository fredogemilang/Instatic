/**
 * adminUi — admin-shell-wide UI state, intentionally kept small and
 * independent of the editor store.
 *
 * The editor store (`@site/store/store`) carries 11 slices and weighs
 * ~165 KB in its own chunk. Any module that subscribes to it transitively
 * drags that chunk into its graph. AdminPageLayout (Plugins / Users /
 * Account / plugin admin pages) only needs a few cross-shell signals —
 * specifically the "settings modal open" flag — and reading them from the
 * editor store made every non-editor admin page eagerly download the full
 * editor toolchain.
 *
 * This store lives outside `@site/` so the admin shell can subscribe
 * without pulling in any editor-only modules. The editor's
 * `settingsSlice` mirrors its open/close events into this store (see
 * `src/admin/pages/site/store/slices/settingsSlice.ts`), so editor and
 * admin views stay in sync without either one becoming dependent on
 * the other.
 *
 * Keep this store TINY. If a piece of state is only relevant inside the
 * canvas (selection, panels, breakpoints, …), it belongs in the editor
 * store. If admin pages outside the canvas need to read it, it belongs
 * here.
 */
import { create } from 'zustand'

export interface AdminUiState {
  /** True when the global Settings modal should be mounted + visible. */
  settingsOpen: boolean
  /** Section the modal opens to (e.g. "general", "pages", "breakpoints"). */
  settingsSection: string
  openSettings: (section?: string) => void
  closeSettings: () => void

  /**
   * Site summary surfaced in the admin toolbar (site name + favicon).
   *
   * Populated by:
   *   - The editor's `usePersistence` hook when it hydrates the full site
   *     (canvas pages — Site / Content / Data / Media).
   *   - The lightweight `useSiteSummary` hook on AdminPageLayout mount
   *     (non-canvas pages — Plugins / Users / Account).
   *
   * Either path writes via `setSiteSummary` so the toolbar always reads
   * from one source regardless of which layout mounted first.
   */
  siteName: string
  siteFaviconUrl: string | null
  setSiteSummary: (summary: { name: string; faviconUrl: string | null }) => void

  /**
   * Slug of the page currently open in the Site editor. `null` on every
   * non-editor admin route (Plugins / Users / Account / Dashboard / …) and
   * also when the editor is in Visual Component edit mode (no active page).
   *
   * Powers the toolbar's "Open live page" icon button, which uses the slug
   * to deep-link to the published page on the public site. When the slug is
   * `null`, the button falls back to the site root.
   *
   * Written by `AdminCanvasLayout` from the editor store on every render.
   * Non-editor layouts never write it, so the field naturally stays `null`
   * there without either layout knowing about the other.
   */
  activePageSlug: string | null
  setActivePageSlug: (slug: string | null) => void
}

/**
 * Editor-store bridge. Optional callback the editor store registers when
 * it's loaded so settings changes initiated from the admin shell propagate
 * into the editor's mirror state (`isSettingsOpen` / `activeSection`).
 * The editor side gates against re-entry — see `settingsSlice.ts`'s
 * `openSettings` / `closeSettings` actions, which delegate to a "publish
 * silently" path when invoked from this bridge.
 *
 * On non-editor admin pages, the editor store is never loaded and this
 * bridge stays `null` — adminUi alone is the truth.
 */
type EditorSettingsBridge = (open: boolean, section?: string) => void
let editorSettingsBridge: EditorSettingsBridge | null = null

/**
 * Called by the editor store's settings slice on initialization (once per
 * app load). Subsequent calls overwrite — exporters that hot-reload do not
 * accumulate stale bridges.
 */
export function bindEditorSettingsBridge(bridge: EditorSettingsBridge | null): void {
  editorSettingsBridge = bridge
}

export const useAdminUi = create<AdminUiState>((set) => ({
  settingsOpen: false,
  settingsSection: 'pages',
  openSettings: (section) => {
    let nextSection: string | undefined
    set((state) => {
      nextSection = section ?? state.settingsSection
      return { settingsOpen: true, settingsSection: nextSection }
    })
    editorSettingsBridge?.(true, nextSection)
  },
  closeSettings: () => {
    set({ settingsOpen: false })
    editorSettingsBridge?.(false)
  },

  siteName: 'Untitled Site',
  siteFaviconUrl: null,
  setSiteSummary: ({ name, faviconUrl }) =>
    set({ siteName: name, siteFaviconUrl: faviconUrl }),

  activePageSlug: null,
  setActivePageSlug: (slug) => set({ activePageSlug: slug }),
}))
