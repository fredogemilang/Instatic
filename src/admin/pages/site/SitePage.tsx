import { useEffect } from 'react'
import { AdminCanvasLayout } from '@admin/layouts'
import { useEditorStore } from '@site/store/store'
import { consumePendingAction } from '@admin/spotlight/pendingAction'

// Register base modules with the global registry. Kept here (not in
// AdminEntry / main.tsx) so the publisher / page-tree / sanitize stack only
// ships in the lazy SitePage chunk — admins who never open the visual editor
// (Users-only role, Content-only role, Account page, etc.) never download it.
import '@modules/base'
// Register built-in loop sources so the Properties Panel + editor preview
// can pick them up. Same lazy-chunk reasoning as the modules import above.
import '@core/loops/sources'

/**
 * SitePage — the visual page-builder workspace.
 *
 * Mounts the editor (canvas + toolbar + sidebars + panels) inside the admin
 * shell. Everything inside this folder (`@site/*`) is editor-only:
 *   - canvas/        — the rendering surface, breakpoint frames, sandbox iframe
 *   - toolbar/       — top-bar (publish, save, zoom, settings, agent)
 *   - sidebars/      — left/right sidebars + panel rail
 *   - panels/        — DOM, properties, site explorer, fonts, etc.
 *   - property-controls/ — form controls used by the properties panel
 *   - module-picker/ — drag-source for blocks
 *   - explorer-actions/ — context menu / rename for explorer items
 *   - code-editor/   — CodeMirror surface for script/style files
 *   - preview/       — preview overlay
 *   - agent/         — AI agent state & executor
 *   - store/         — Zustand store + slices for the visual editor
 *   - hooks/         — editor-only React hooks
 *   - preferences/   — editor preferences (catalog, persistence, class usage)
 *   - layout/        — panel-layout persistence
 *   - ui/            — editor-shared building blocks (Tree, ModuleIcon)
 */
export function SitePage() {
  // Consume cross-workspace pending actions queued by the spotlight. Each
  // action waits for the editor store to hydrate (site !== null) — we
  // subscribe once and tear down as soon as the action has fired so the
  // listener doesn't outlive the SitePage mount.
  useEffect(() => {
    function runIfHydrated(): boolean {
      const store = useEditorStore.getState()
      if (!store.site) return false

      const newPage = consumePendingAction('site.newPage')
      if (newPage) {
        const title = newPage.args?.['title']?.trim()
        if (title) store.addPage(title)
        return true
      }

      const newVc = consumePendingAction('site.newVisualComponent')
      if (newVc) {
        const name = newVc.args?.['name']?.trim()
        if (name) {
          const vcId = store.createVisualComponent(name)
          store.setActiveDocument({ kind: 'visualComponent', vcId })
        }
        return true
      }

      return true // hydrated but nothing queued — stop waiting
    }

    if (runIfHydrated()) return

    const unsubscribe = useEditorStore.subscribe(() => {
      if (runIfHydrated()) unsubscribe()
    })
    return unsubscribe
  }, [])

  return <AdminCanvasLayout workspace="site" />
}
