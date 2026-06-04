/**
 * AdminCanvasLayout — the canvas-bearing admin shell.
 *
 * One of the admin layout families in `src/admin/layouts/`:
 *   - AdminCanvasLayout (this file) — used by the Site editor. Carries the
 *     floating editor panels, the page canvas, and the DnD context shared by
 *     site-editor drag surfaces such as Site Explorer organization.
 *   - AdminPageLayout — used by Plugins, Users, Account, and plugin admin
 *     pages. Strips the canvas / sidebar / DnD chrome and renders a
 *     simple centered page body with a unified header.
 *   - AdminWorkspaceCanvasLayout — used by Content, Data, and Media. Keeps
 *     the canvas chrome without importing Site-editor-only modules.
 *
 * Pick AdminCanvasLayout for the visual Site editor. Content, Data, and Media
 * use AdminWorkspaceCanvasLayout so they do not download Site-editor-only
 * modules on first paint.
 *
 * Editor Overlay Layout (Guideline #410 — motion-editor style):
 *   ┌─────────────────────────────── Toolbar ──────────────────────────────────┐  z-60
 *   │ [SiteName] [Undo/Redo] [+ Add] ─────── [Zoom] [Save] [Publish] [⚙] [✦] │
 *   ├──────────────────────────── Canvas (full-bleed) ─────────────────────────┤
 *   │  [DOM Tree Panel ▓]     canvas          [Properties Panel ▓]            │
 *   │  position: absolute overlays (z-50)     [AI Panel ▓] (bottom-right)     │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * Five independent self-contained floating panels (Guideline #410):
 * - DomPanel (Layers) — top-left
 * - PropertiesPanel — top-right
 * - AgentPanel (AI) — bottom-right, independent visibility
 * - Site explorer panel — site concepts: pages, components, styles, scripts
 * - CodeEditorPanel (Task #432) — center-stage, code editing
 *
 * J12: usePersistence handles CMS draft load on mount, preference-gated
 * 30s auto-save, toolbar Save, and Cmd+S immediate save.
 *
 * Agent Panel: Phase D AI assistant — self-contained floating panel (Guideline #410).
 * Authenticates via ambient Claude Code credentials through the local Bun server.
 * No env vars, no API keys, no endpoint configuration required (Constraint #385).
 */
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { CanvasRoot } from '@admin/pages/site/canvas'
import { PropertiesPanel } from '@admin/pages/site/panels/PropertiesPanel'
import { CodeEditorPanel } from '@admin/pages/site/code-editor'
import { Toolbar } from '@admin/pages/site/toolbar/Toolbar'
import { SettingsButton } from '@admin/pages/site/toolbar/SettingsButton'
import { ZoomControls } from '@admin/pages/site/toolbar/ZoomControls'
import { PublishButton } from '@admin/pages/site/toolbar/PublishButton'
import { LeftSidebar } from '@admin/pages/site/sidebars/LeftSidebar'
import { RightSidebar } from '@admin/pages/site/sidebars/RightSidebar'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { useEditorSelectPreference } from '@admin/pages/site/preferences/editorPreferences'
import { usePersistence } from '@admin/pages/site/hooks/usePersistence'
import { useSiteEditorUrlSync } from '@admin/pages/site/hooks/useSiteEditorUrlSync'
import { useEditorLayoutPersistence } from '@admin/pages/site/hooks/useEditorLayoutPersistence'
import { selectActivePage, selectRightSidebarExpanded, useEditorStore } from '@admin/pages/site/store/store'
import { cmsAdapter } from '@core/persistence/cms'
import { useAdminUi } from '@admin/state/adminUi'
import { pagePublicPath } from '@core/page-tree'
import { cn } from '@ui/cn'
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import styles from './AdminCanvasLayout.module.css'
import { lazy, Suspense, useEffect } from 'react'
import { useCurrentAdminUser } from '@admin/sessionContext'
import {
  canEditContent as accessCanEditContent,
  canEditStructure as accessCanEditStructure,
  canEditStyle as accessCanEditStyle,
  canSaveDraftSite,
  hasCapability,
} from '@admin/access'
import { EditorPermissionsProvider } from '@site/EditorPermissionsProvider'
import type { EditorPermissions } from '@site/editorPermissionsContext'

import { ImportHtmlModal } from '@admin/modals/ImportHtml'

// SettingsModal is heavy (~37 KB raw) and closed 99% of the time. lazy()
// pushes it into its own chunk and the conditional render below avoids
// kicking off the dynamic import until the user actually opens settings.
// Once opened, React.lazy() caches the resolved module — subsequent
// open/close cycles are instant.
const SettingsModal = lazy(() =>
  import('@admin/modals/Settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)

// Editor-only toolbar surface: preview iframe. It self-gates on store state,
// but we ALSO conditionally render it at the call site (below) so its chunk
// isn't fetched on first paint — the preview overlay drags in the entire
// publisher graph, which is large.
const PreviewOverlay = lazy(() =>
  import('@admin/pages/site/preview/PreviewOverlay').then((m) => ({
    default: m.PreviewOverlay,
  })),
)

/**
 * AdminCanvasLayout is the Site editor shell. Other canvas-style workspaces
 * render through `AdminWorkspaceCanvasLayout`, and regular admin pages render
 * through `AdminPageLayout`.
 */
export function AdminCanvasLayout() {
  const site = useEditorStore((s) => s.site)
  const propertiesPanelMode = useEditorStore((s) => s.propertiesPanelMode)
  const rightSidebarExpanded = useEditorStore(selectRightSidebarExpanded)
  // Toolbar branding — pulled from the editor store here (we already have
  // it loaded) and forwarded to the prop-driven Toolbar below. Keeps the
  // Toolbar component itself free of editor-store imports.
  const siteName = useEditorStore((s) => s.site?.name ?? 'Untitled Site')
  const faviconUrl = useEditorStore((s) => s.site?.settings.faviconUrl ?? null)
  // Editor-only toolbar surface — gate its lazy chunk on store state.
  const previewOpen = useEditorStore((s) => s.previewOpen)
  // Settings modal mount gate. adminUi is the canonical source — the
  // editor's `settingsSlice.openSettings` mirrors into it, and the admin
  // shell reads from it too.
  const settingsOpen = useAdminUi((s) => s.settingsOpen)
  const importHtmlModalOpen = useEditorStore((s) => s.importHtmlModalOpen)
  const publishSiteSummary = useAdminUi((s) => s.setSiteSummary)
  const publishActiveLivePath = useAdminUi((s) => s.setActiveLivePath)
  // Public path of the page currently open in the Site-editor canvas.
  // Forwarded to adminUi below so the toolbar's "Open live page" button
  // can deep-link without subscribing to the editor store.
  const activeSitePath = useEditorStore((s) => {
    const slug = selectActivePage(s)?.slug
    return slug ? pagePublicPath(slug) : null
  })
  const currentUser = useCurrentAdminUser()

  // Keep the adminUi site summary in sync with whatever the editor store
  // currently holds. AdminPageLayout reads siteName / faviconUrl from
  // adminUi (not the editor store), so editor pages need to publish there
  // too. This effect fires whenever the underlying values change, and is
  // cheap because adminUi.setSiteSummary is a stable setter.
  useEffect(() => {
    publishSiteSummary({ name: siteName, faviconUrl })
  }, [siteName, faviconUrl, publishSiteSummary])
  // Mirror the active page's public path into adminUi so the toolbar's
  // "Open live page" icon can deep-link without subscribing to the editor
  // store.
  useEffect(() => {
    publishActiveLivePath(activeSitePath)
    return () => {
      // Clear on unmount so navigating away from the editor leaves
      // the toolbar pointing at the site root again rather than a
      // stale path.
      publishActiveLivePath(null)
    }
  }, [activeSitePath, publishActiveLivePath])
  const hasRightSidebar = rightSidebarExpanded
  // Three-way edit permissions — see `src/admin/access.ts`. A user with all
  // three holds full editor rights; a user with only `canEditContent` is the
  // "Client / copy editor" persona: read everything, change copy on existing
  // nodes, no DnD, no style edits, no structural changes.
  const canEditStructureFlag = accessCanEditStructure(currentUser)
  const canEditContentFlag = accessCanEditContent(currentUser)
  const canEditStyleFlag = accessCanEditStyle(currentUser)
  const canSaveSite = canSaveDraftSite(currentUser)
  // Legacy "anything-editable" flag — true when the caller can drag/drop and
  // structurally modify the canvas. Most existing call sites are structural
  // by nature (DnD, context menu, rename, delete keyboard shortcut, plugin
  // overlays). Content-only callers still get the canvas in read-mostly mode
  // with content controls live.
  const canEditDraftSite = canEditStructureFlag
  const canPublishPages = !currentUser || hasCapability(currentUser, 'pages.publish')

  const permissions: EditorPermissions = {
    canEditStructure: canEditStructureFlag,
    canEditContent: canEditContentFlag,
    canEditStyle: canEditStyleFlag,
  }
  // J12 — wire persistence: load, auto-save, toolbar Save, Cmd+S.
  const persistence = usePersistence('default', cmsAdapter, {
    markNewSiteUnsaved: true,
    enabled: true,
  })
  // Keep the open page in lockstep with the URL: consume `?page=<slug>` on
  // load, and mirror the active page's slug back into the address bar so it's
  // directly linkable.
  useSiteEditorUrlSync({
    enabled: true,
    loaded: persistence.saveStatus.state !== 'loading',
  })
  useEditorLayoutPersistence('site')
  useInstalledEditorPlugins()
  // Mount the SSE bridge ONCE per admin tab — gives toasts on plugin
  // crashes from any route, drives the red dot on the Plugins nav link,
  // and keeps the open Plugins page list refreshed.
  usePluginEventBridge()

  // ── Site-editor DnD shell ─────────────────────────────────────────────────
  // Site Explorer organization hooks into this outer DndContext. DomPanel has
  // its own nested DndContext for DOM tree reordering, isolated by dnd-kit.
  const canvasDndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  // UI density preference — `data-editor-density` on the editor root drives
  // CSS variables consumed by tree rows, toolbar buttons, and other density-
  // sensitive surfaces. Reading the preference here keeps the attribute in
  // sync with the Settings toggle without per-component subscriptions.
  //
  // Read BEFORE the `!site` early return so the hook order stays stable across
  // the hydration gate (React rules-of-hooks: hooks must run in the same order
  // on every render).
  const density = useEditorSelectPreference('density')

  const loadError = !site && persistence.saveStatus.state === 'error'
    ? persistence.saveStatus.message ?? 'Reload the admin page and try again.'
    : null

  return (
    <EditorPermissionsProvider value={permissions}>
    <div className={styles.shell} data-editor-density={density}>
      {/* ── Top toolbar (z-60, Guideline #374) ───────────────────────────── */}
      {/* Toolbar is now a prop-driven shell — this layout supplies the
          site brand, the preview overlay lazy mount, and
          the editor-specific right slot (zoom / publish / settings). The
          lazy mount gates on `previewOpen` so the chunk loads only when the
          user actually opens preview. */}
      <Toolbar
        siteName={siteName}
        faviconUrl={faviconUrl}
        section="site"
        adminNavigationSlot={(
          <AdminSectionNavigation
            section="site"
            currentUser={currentUser}
          />
        )}
        overlay={previewOpen && (
          <Suspense fallback={null}>
            <PreviewOverlay />
          </Suspense>
        )}
        rightSlot={(
          <>
            <ZoomControls />
            <PublishButton
              enabled={canPublishPages}
              onSave={canSaveSite ? persistence.saveSite : undefined}
              saveStatus={persistence.saveStatus}
            />
            <SettingsButton />
          </>
        )}
      />

      {/* ── Canvas + floating overlay panels ──────────────────────────────── */}
      {/*
        position: relative makes this the containing block for absolutely
        positioned panels (Guideline #356 / Task #358 / Architect #504).
        flex is kept so CanvasRoot's flex:1 fills the full width.
        DndContext wraps the full editor body so SiteExplorerPanel rows can be
        reordered across sections and folders.
        DomPanel has its own nested DndContext for tree-node reordering — that
        context is isolated; nested DndContexts are fully supported by dnd-kit.
      */}
      <DndContext sensors={canvasDndSensors} collisionDetection={pointerWithin}>
      {/* `ConfirmDeleteProvider` wraps the editor body so the canvas
          Delete-key handler, Layers panel context menu, and other
          descendant destructive actions can call `useConfirmDelete()`
          and gate on the `confirmBeforeDelete` editor preference.
          Plugin uninstall is intentionally *not* gated on that preference
          and uses its own dedicated `PluginRemoveDialog` instead. */}
      <ConfirmDeleteProvider>
      <div className={styles.editorBody}>
        <LeftSidebar workspace="site" editable={canEditDraftSite} />
        <div
          className={cn(styles.canvasStage, hasRightSidebar && styles.canvasStageRightSidebarOpen)}
          data-right-sidebar-expanded={hasRightSidebar ? 'true' : 'false'}
        >
          <div className={styles.canvasContent} key="site">
            {/* Canvas — fills the remaining space between sidebars */}
            {loadError ? (
              <SiteEditorLoadError message={loadError} />
            ) : (
              <CanvasRoot editable={canEditDraftSite} />
            )}
            {/* Properties can be unpinned into the floating draggable overlay. */}
            {canSaveSite && propertiesPanelMode === 'floating' && <PropertiesPanel variant="floating" />}
          </div>
        </div>
        {/* `mode` tells the RightSidebar which expansion model to use:
            - `'site'`:      Site editor — width follows the selection-
              gated `sitePropertiesExpanded` selector.
            - `'hidden'`:    Site viewer with no `pages.draft.save`
              capability. */}
        <RightSidebar
          key="site"
          mode={canSaveSite ? 'site' : 'hidden'}
        />
      </div>
      </ConfirmDeleteProvider>
      </DndContext>

      {/* Code editor/media preview: viewport overlay, not constrained by the
          canvas stage. The panel itself is small chrome; the heavy CodeMirror
          6 bundle (~600 kB) is lazy-loaded inside the panel only when the
          user opens a text file. */}
      <CodeEditorPanel />

      {/* Settings Modal (portal-rendered, listens to adminUi.settingsOpen).
          Lazy + conditional render — the 1300-line modal + its six section
          subtree stays out of the eager graph until the user opens settings. */}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal />
        </Suspense>
      )}

      {/* Import HTML modal — opens from Spotlight or right-click "Paste HTML here…".
          Dialog handles its own portal + Escape; always rendered so it can
          react to `importHtmlModalOpen` without a lazy-load delay. */}
      {importHtmlModalOpen && <ImportHtmlModal />}

    </div>
    </EditorPermissionsProvider>
  )
}

function SiteEditorLoadError({ message }: { message: string }) {
  return (
    <section className={styles.canvasBootstrapError} role="alert">
      <h1>Could not load CMS site</h1>
      <p>{message}</p>
    </section>
  )
}
