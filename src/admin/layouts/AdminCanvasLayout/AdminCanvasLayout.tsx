/**
 * AdminCanvasLayout — the canvas-bearing admin shell.
 *
 * One of the two top-level admin layouts in `src/admin/layouts/`:
 *   - AdminCanvasLayout (this file) — used by the Site editor and the
 *     Content workspace. Carries the floating editor panels, the page
 *     canvas, the DnD context that wires the SiteExplorer drag-to-canvas
 *     flow, and the per-workspace sidebars.
 *   - AdminPageLayout — used by Plugins, Users, Account, and plugin admin
 *     pages. Strips the canvas / sidebar / DnD chrome and renders a
 *     simple centered page body with a unified header.
 *
 * Pick AdminCanvasLayout when the page IS the editor canvas. Pick
 * AdminPageLayout when the page is a regular admin page (lists, forms,
 * settings) that doesn't need the editor machinery.
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
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { CanvasRoot, CANVAS_ROOT_DROPPABLE_ID } from '@admin/pages/site/canvas'
import { PropertiesPanel } from '@admin/pages/site/panels/PropertiesPanel'
import { CodeEditorPanel } from '@admin/pages/site/code-editor'
import { Toolbar } from '@admin/pages/site/toolbar/Toolbar'
import { ToolbarDivider } from '@admin/pages/site/toolbar/Toolbar'
import { SettingsButton } from '@admin/pages/site/toolbar/SettingsButton'
import { ZoomControls } from '@admin/pages/site/toolbar/ZoomControls'
import { PublishButton } from '@admin/pages/site/toolbar/PublishButton'
import { LeftSidebar } from '@admin/pages/site/sidebars/LeftSidebar'
import { RightSidebar } from '@admin/pages/site/sidebars/RightSidebar'
import { ConfirmDeleteProvider } from '@admin/shared/dialogs/ConfirmDeleteDialog'
import { useEditorSelectPreference } from '@admin/pages/site/preferences/editorPreferences'
import { usePersistence } from '@admin/pages/site/hooks/usePersistence'
import { useSiteEditorDeepLink } from '@admin/pages/site/hooks/useSiteEditorDeepLink'
import { useEditorLayoutPersistence } from '@admin/pages/site/hooks/useEditorLayoutPersistence'
import { selectActiveCanvasPage, selectActivePage, selectRightSidebarExpanded, useEditorStore } from '@admin/pages/site/store/store'
import { resolveInsertLocation } from '@admin/pages/site/store/insertLocation'
import { cmsAdapter } from '@core/persistence'
import { useAdminUi } from '@admin/state/adminUi'
import { cn } from '@ui/cn'
import { useInstalledEditorPlugins } from '@admin/pages/plugins/hooks/useInstalledEditorPlugins'
import { usePluginEventBridge } from '@admin/pages/plugins/hooks/usePluginEventBridge'
import { AppLoadingScreen } from '@admin/AppLoadingScreen'
import { AdminSectionNavigation } from '@admin/shared/AdminSectionNavigation'
import styles from './AdminCanvasLayout.module.css'
import { lazy, Suspense, useCallback, useEffect, type ReactNode } from 'react'
import type { AdminWorkspace } from '@admin/workspace'
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

// SettingsModal is heavy (~37 KB raw) and closed 99% of the time. lazy()
// pushes it into its own chunk and the conditional render below avoids
// kicking off the dynamic import until the user actually opens settings.
// Once opened, React.lazy() caches the resolved module — subsequent
// open/close cycles are instant.
const SettingsModal = lazy(() =>
  import('@admin/modals/Settings/SettingsModal').then((m) => ({ default: m.SettingsModal })),
)

// Editor-only toolbar surfaces: preview iframe + VC breadcrumb. Both
// self-gate on store state, but we ALSO conditionally render them at the
// call site (below) so their chunks aren't fetched on first paint — the
// preview overlay drags in the entire publisher graph, which is large.
const PreviewOverlay = lazy(() =>
  import('@admin/pages/site/preview/PreviewOverlay').then((m) => ({
    default: m.PreviewOverlay,
  })),
)
const VCBreadcrumb = lazy(() =>
  import('@admin/pages/site/toolbar/VCBreadcrumb').then((m) => ({ default: m.default })),
)

/**
 * AdminCanvasLayout is the canvas-bearing shell — used by the Site editor
 * and the Content workspace. Other admin pages (Plugins, Users, Account,
 * plugin pages) render through `AdminPageLayout` instead, which skips the
 * canvas / sidebar / DnD chrome they don't need.
 */
type AdminCanvasWorkspace = Extract<AdminWorkspace, 'site' | 'content' | 'data' | 'media'>

interface AdminCanvasLayoutProps {
  workspace?: AdminCanvasWorkspace
  /**
   * Custom left sidebar. Used by non-site workspaces ('content', 'media') to
   * replace the built-in `LeftSidebar` with their own panel rail + folder /
   * collection tree.
   */
  contentSidebar?: ReactNode
  /**
   * Optional content rendered inside the built-in site `LeftSidebar`. Only
   * the 'site' workspace consumes this — non-site workspaces own their full
   * sidebar via `contentSidebar`.
   */
  contentLeftPanel?: ReactNode
  /**
   * Canvas content for non-site workspaces. The 'site' workspace renders the
   * page-builder canvas regardless of this prop.
   */
  contentCanvas?: ReactNode
  /**
   * Custom right-sidebar content for non-site workspaces (e.g. the Content
   * SEO/settings panel or the Media asset inspector).
   */
  contentRightPanel?: ReactNode
  toolbarRightSlot?: ReactNode
}

export function AdminCanvasLayout({
  workspace = 'site',
  contentSidebar,
  contentLeftPanel,
  contentCanvas,
  contentRightPanel,
  toolbarRightSlot,
}: AdminCanvasLayoutProps) {
  const site = useEditorStore((s) => s.site)
  const propertiesPanelMode = useEditorStore((s) => s.propertiesPanelMode)
  const rightSidebarExpanded = useEditorStore(selectRightSidebarExpanded)
  // Toolbar branding — pulled from the editor store here (we already have
  // it loaded) and forwarded to the prop-driven Toolbar below. Keeps the
  // Toolbar component itself free of editor-store imports.
  const siteName = useEditorStore((s) => s.site?.name ?? 'Untitled Site')
  const faviconUrl = useEditorStore((s) => s.site?.settings.faviconUrl ?? null)
  // Editor-only toolbar surfaces — gate their lazy chunks on store state.
  const previewOpen = useEditorStore((s) => s.previewOpen)
  const inVcMode = useEditorStore((s) => s.activeDocument?.kind === 'visualComponent')
  // Settings modal mount gate. adminUi is the canonical source — the
  // editor's `settingsSlice.openSettings` mirrors into it, and the admin
  // shell reads from it too.
  const settingsOpen = useAdminUi((s) => s.settingsOpen)
  const publishSiteSummary = useAdminUi((s) => s.setSiteSummary)
  const publishActivePageSlug = useAdminUi((s) => s.setActivePageSlug)
  // Page slug currently open in the canvas — `null` in VC mode (no active
  // page) and on every non-editor route. The toolbar's "Open live page"
  // button uses it to deep-link to the published page; reading via the
  // page-mode selector is correct because VC mode is intentionally
  // page-less.
  const activePageSlug = useEditorStore((s) => selectActivePage(s)?.slug ?? null)
  const currentUser = useCurrentAdminUser()

  // Keep the adminUi site summary in sync with whatever the editor store
  // currently holds. AdminPageLayout reads siteName / faviconUrl from
  // adminUi (not the editor store), so editor pages need to publish there
  // too. This effect fires whenever the underlying values change, and is
  // cheap because adminUi.setSiteSummary is a stable setter.
  useEffect(() => {
    publishSiteSummary({ name: siteName, faviconUrl })
  }, [siteName, faviconUrl, publishSiteSummary])
  // Mirror the active page slug into adminUi so the toolbar's "Open live
  // page" icon — which is shared with non-editor admin routes via
  // AdminPageLayout — can deep-link without subscribing to the editor
  // store. Non-editor layouts never publish to this field, so it
  // naturally falls back to `null` (and the button to "/") off the canvas.
  useEffect(() => {
    publishActivePageSlug(activePageSlug)
    return () => {
      // Clear on unmount so navigating away from the editor leaves the
      // toolbar pointing at the site root again rather than a stale slug.
      publishActivePageSlug(null)
    }
  }, [activePageSlug, publishActivePageSlug])
  const customRightSidebarExpanded = workspace !== 'site' && Boolean(contentRightPanel)
  const hasRightSidebar = customRightSidebarExpanded || (workspace === 'site' && rightSidebarExpanded)
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
  const requiresSiteDocument = workspace === 'site'

  // J12 — wire persistence: load, auto-save, toolbar Save, Cmd+S.
  //
  // We load the site on EVERY workspace (not just `'site'`) because the
  // toolbar reads its title from `useEditorStore((s) => s.site?.name)` —
  // hard-refreshing on `/admin/account` or `/admin/users` would otherwise
  // show the "Untitled Site" fallback until the user navigated to the
  // editor canvas at least once. Auto-save side-effects don't fire on
  // non-site workspaces because nothing dirties the store there
  // (`hasUnsavedChanges` stays false), so the only behaviour we add to
  // those workspaces is the read-only hydrate.
  const persistence = usePersistence('default', cmsAdapter, {
    markNewSiteUnsaved: true,
    enabled: true,
  })
  // When the Site editor is opened with `?table=pages&row=<id>` or
  // `?table=components&row=<id>` (from the Data workspace), select that
  // row's page or component once the site has finished loading.
  useSiteEditorDeepLink({
    enabled: workspace === 'site',
    loaded: persistence.saveStatus.state !== 'loading',
  })
  useEditorLayoutPersistence()
  useInstalledEditorPlugins()
  // Mount the SSE bridge ONCE per admin tab — gives toasts on plugin
  // crashes from any route, drives the red dot on the Plugins nav link,
  // and keeps the open Plugins page list refreshed.
  usePluginEventBridge()

  // ── Canvas-level DnD (B2 — visualComponentRef drop from SiteExplorer) ──────
  // Handles drops of { kind: 'visualComponentRef', componentId: string } payloads
  // dragged from the SiteExplorerPanel onto the canvas.
  // NOTE: DomPanel has its own nested DndContext for DOM tree reordering — that
  // context is isolated and unaffected by this outer one (dnd-kit nesting).
  const canvasDndSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const handleCanvasDragEnd = useCallback((event: DragEndEvent) => {
    if (!canEditDraftSite) return

    const payload = event.active.data.current
    // Only handle visualComponentRef drags — ignore all other drag payloads
    // (e.g. DOM-panel tree node drags which live in their own nested context).
    if (!payload || payload['kind'] !== 'visualComponentRef') return
    if (!event.over) return

    const componentId = payload['componentId']
    if (typeof componentId !== 'string' || !componentId) return

    const state = useEditorStore.getState()
    const page = selectActiveCanvasPage(state)
    if (!page) return

    // Determine the drop target: canvas root drop → page root; node drop →
    // that node. resolveInsertLocation then maps the target onto an actual
    // (parent, index) pair, so drops onto leaf nodes (Text, Button, Image)
    // land as a sibling-after instead of silently failing inside a node that
    // doesn't accept children.
    const targetId =
      String(event.over.id) === CANVAS_ROOT_DROPPABLE_ID
        ? page.rootNodeId
        : String(event.over.id)

    const location = resolveInsertLocation(page, targetId)
    if (!location) return

    const result = state.insertComponentRef(location.parentId, componentId, location.index)
    if (result === null) {
      console.warn('[component-system] insertComponentRef returned null — cycle prevented or empty componentId')
    }
  }, [canEditDraftSite])

  // UI density preference — `data-editor-density` on the editor root drives
  // CSS variables consumed by tree rows, toolbar buttons, and other density-
  // sensitive surfaces. Reading the preference here keeps the attribute in
  // sync with the Settings toggle without per-component subscriptions.
  //
  // Read BEFORE the `!site` early return so the hook order stays stable across
  // the hydration gate (React rules-of-hooks: hooks must run in the same order
  // on every render).
  const density = useEditorSelectPreference('density')

  if (requiresSiteDocument && !site) {
    if (persistence.saveStatus.state === 'error') {
      return (
        <main className={styles.bootstrapError} role="alert">
          <h1>Could not load CMS site</h1>
          <p>{persistence.saveStatus.message ?? 'Reload the admin page and try again.'}</p>
        </main>
      )
    }

    return <AppLoadingScreen />
  }

  return (
    <EditorPermissionsProvider value={permissions}>
    <div className={styles.shell} data-editor-density={density}>
      {/* ── Top toolbar (z-60, Guideline #374) ───────────────────────────── */}
      {/* Toolbar is now a prop-driven shell — this layout supplies the
          site brand, the preview overlay + VC breadcrumb lazy mounts, and
          the editor-specific right slot (zoom / publish / settings). The
          lazy mounts gate on `previewOpen` / `inVcMode` so neither chunk
          loads until the user actually opens preview / enters a VC. */}
      <Toolbar
        siteName={siteName}
        faviconUrl={faviconUrl}
        section={workspace}
        adminNavigationSlot={(
          <AdminSectionNavigation
            section={workspace}
            currentUser={currentUser}
          />
        )}
        overlay={previewOpen && (
          <Suspense fallback={null}>
            <PreviewOverlay />
          </Suspense>
        )}
        breadcrumbSlot={inVcMode && (
          <Suspense fallback={null}>
            <VCBreadcrumb />
          </Suspense>
        )}
        rightSlot={toolbarRightSlot ?? (
          <>
            <ZoomControls />
            <ToolbarDivider />
            <PublishButton
              enabled={workspace === 'site' && canPublishPages}
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
        DndContext wraps the full editor body so SiteExplorerPanel draggables
        (visualComponentRef) can be dropped onto the CanvasRoot drop target.
        DomPanel has its own nested DndContext for tree-node reordering — that
        context is isolated; nested DndContexts are fully supported by dnd-kit.
      */}
      <DndContext sensors={canvasDndSensors} onDragEnd={handleCanvasDragEnd}>
      {/* `ConfirmDeleteProvider` wraps the editor body so the canvas
          Delete-key handler, Layers panel context menu, and other
          descendant destructive actions can call `useConfirmDelete()`
          and gate on the `confirmBeforeDelete` editor preference.
          Plugin uninstall is intentionally *not* gated on that preference
          and uses its own dedicated `PluginRemoveDialog` instead. */}
      <ConfirmDeleteProvider>
      <div className={styles.editorBody}>
        {workspace === 'site' ? (
          <LeftSidebar workspace={workspace} contentPanel={contentLeftPanel} editable={canEditDraftSite} />
        ) : (
          contentSidebar ?? null
        )}
        <div
          className={cn(styles.canvasStage, hasRightSidebar && styles.canvasStageRightSidebarOpen)}
          data-right-sidebar-expanded={hasRightSidebar ? 'true' : 'false'}
        >
          <div className={styles.canvasContent} key={workspace}>
            {workspace === 'site' ? (
              <>
                {/* Canvas — fills the remaining space between sidebars */}
                <CanvasRoot editable={canEditDraftSite} />
                {/* Properties can be unpinned into the floating draggable
                    overlay. Shown to any caller who can make some kind of
                    edit — a content-only Client still needs the panel to
                    change text / image props. */}
                {canSaveSite && propertiesPanelMode === 'floating' && <PropertiesPanel variant="floating" />}
              </>
            ) : (
              contentCanvas
            )}
          </div>
        </div>
        <RightSidebar
          contentPanel={workspace !== 'site' ? contentRightPanel : undefined}
          suppressDefaultPanel={workspace !== 'site' || !canSaveSite}
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
    </div>
    </EditorPermissionsProvider>
  )
}

