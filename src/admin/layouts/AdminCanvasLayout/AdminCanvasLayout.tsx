/**
 * AdminLayout — root layout for the self-hosted CMS admin.
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
import { CanvasRoot, CANVAS_ROOT_DROPPABLE_ID } from './pages/site/canvas'
import { PropertiesPanel } from './pages/site/panels/PropertiesPanel'
import { CodeEditorPanel } from './pages/site/code-editor'
import { Toolbar } from './pages/site/toolbar'
import { LeftSidebar } from './pages/site/sidebars/LeftSidebar'
import { RightSidebar } from './pages/site/sidebars/RightSidebar'
import { SettingsModal } from './modals/Settings'
import { ConfirmDeleteProvider } from './shared/dialogs/ConfirmDeleteDialog'
import { useEditorSelectPreference } from './pages/site/preferences/editorPreferences'
import { usePersistence } from './pages/site/hooks/usePersistence'
import { useEditorLayoutPersistence } from './pages/site/hooks/useEditorLayoutPersistence'
import { selectActiveCanvasPage, selectRightSidebarExpanded, useEditorStore } from './pages/site/store/store'
import { cmsAdapter } from '@core/persistence'
import { listCmsPlugins } from '@core/persistence/cmsPlugins'
import type { PluginAdminPageRoute } from '@core/plugin-sdk'
import { cn } from '@ui/cn'
import { useInstalledEditorPlugins } from './pages/plugins/hooks/useInstalledEditorPlugins'
import { CMS_PLUGINS_CHANGED_EVENT } from './pages/plugins/utils/pluginEvents'
import { AppLoadingScreen } from './AppLoadingScreen'
import styles from './AdminLayout.module.css'
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { Link } from './lib/routing'
import { useInRouterContext, useLocation, useNavigate } from './lib/routing'
import toolbarStyles from './pages/site/toolbar/Toolbar.module.css'
import type { AdminWorkspace } from './workspace'
import { useCurrentAdminUser } from './sessionContext'
import { canAccessWorkspace, hasAllCapabilities, hasCapability } from './access'
import type { CmsCurrentUser } from '@core/persistence'

interface AdminLayoutProps {
  workspace?: AdminWorkspace
  contentSidebar?: ReactNode
  contentLeftPanel?: ReactNode
  contentCanvas?: ReactNode
  contentRightPanel?: ReactNode
  toolbarRightSlot?: ReactNode
}

export default function AdminLayout({
  workspace = 'site',
  contentSidebar,
  contentLeftPanel,
  contentCanvas,
  contentRightPanel,
  toolbarRightSlot,
}: AdminLayoutProps) {
  const site = useEditorStore((s) => s.site)
  const propertiesPanelMode = useEditorStore((s) => s.propertiesPanelMode)
  const rightSidebarExpanded = useEditorStore(selectRightSidebarExpanded)
  const currentUser = useCurrentAdminUser()
  const contentRightSidebarExpanded = workspace === 'content' && Boolean(contentRightPanel)
  const hasRightSidebar = contentRightSidebarExpanded || (workspace === 'site' && rightSidebarExpanded)
  const canEditDraftSite = !currentUser || hasAllCapabilities(currentUser, ['site.edit', 'pages.edit'])
  const canPublishPages = !currentUser || hasCapability(currentUser, 'pages.publish')
  const requiresSiteDocument = workspace === 'site'

  // J12 — wire persistence: load, auto-save, toolbar Save, Cmd+S.
  const persistence = usePersistence('default', cmsAdapter, {
    markNewSiteUnsaved: true,
    enabled: requiresSiteDocument,
  })
  useEditorLayoutPersistence()
  useInstalledEditorPlugins()

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

    // Determine parent: canvas root drop → page root; node drop → that node.
    let parentId: string | undefined
    if (String(event.over.id) === CANVAS_ROOT_DROPPABLE_ID) {
      parentId = page?.rootNodeId
    } else {
      parentId = String(event.over.id)
    }

    if (!parentId) return

    const result = state.insertComponentRef(parentId, componentId)
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
    <div className={styles.shell} data-editor-density={density}>
      {/* ── Top toolbar (z-60, Guideline #374) ───────────────────────────── */}
      <Toolbar
        onSave={canEditDraftSite ? persistence.saveSite : undefined}
        saveStatus={persistence.saveStatus}
        publishEnabled={workspace === 'site' && canPublishPages}
        section={workspace}
        adminNavigationSlot={(
          <AdminSectionNavigation
            section={workspace}
            currentUser={currentUser}
          />
        )}
        rightSlot={toolbarRightSlot}
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
                {/* Properties can be unpinned into the floating draggable overlay. */}
                {canEditDraftSite && propertiesPanelMode === 'floating' && <PropertiesPanel variant="floating" />}
              </>
            ) : (
              contentCanvas
            )}
          </div>
        </div>
        <RightSidebar
          contentPanel={workspace === 'content' ? contentRightPanel : undefined}
          suppressDefaultPanel={workspace !== 'site' || !canEditDraftSite}
        />
      </div>
      </ConfirmDeleteProvider>
      </DndContext>

      {/* Code editor/media preview: viewport overlay, not constrained by the
          canvas stage. The panel itself is small chrome; the heavy CodeMirror
          6 bundle (~600 kB) is lazy-loaded inside the panel only when the
          user opens a text file. */}
      <CodeEditorPanel />

      {/* J10 — Settings Modal (portal-rendered, listens to store.settingsModalOpen) */}
      <SettingsModal />
    </div>
  )
}

interface AdminSectionNavigationProps {
  section: AdminWorkspace
  currentUser?: CmsCurrentUser | null
  onWorkspaceNavigateStart?: () => void
}

export function AdminSectionNavigation({
  section,
  currentUser,
  onWorkspaceNavigateStart,
}: AdminSectionNavigationProps) {
  const [pluginPages, setPluginPages] = useState<PluginAdminPageRoute[]>([])
  const sessionUser = useCurrentAdminUser()
  const effectiveUser = currentUser ?? sessionUser ?? null
  const unrestricted = !effectiveUser
  const canAccess = (workspace: AdminWorkspace) => unrestricted || canAccessWorkspace(effectiveUser, workspace)
  const canAccessPlugins = canAccess('plugins')

  useEffect(() => {
    let cancelled = false

    async function loadPluginPages() {
      if (!canAccessPlugins) {
        setPluginPages([])
        return
      }
      try {
        const payload = await listCmsPlugins()
        if (!cancelled) {
          setPluginPages((current) => {
            const next = payload.adminPages
            const unchanged =
              current.length === next.length &&
              current.every((page, index) => page.route === next[index]?.route)
            return unchanged ? current : next
          })
        }
      } catch {
        // Navigation remains usable when plugins cannot be loaded.
      }
    }

    function refreshPluginPages() {
      void loadPluginPages()
    }

    refreshPluginPages()
    window.addEventListener(CMS_PLUGINS_CHANGED_EVENT, refreshPluginPages)
    return () => {
      cancelled = true
      window.removeEventListener(CMS_PLUGINS_CHANGED_EVENT, refreshPluginPages)
    }
  }, [canAccessPlugins])

  return (
    <>
      {canAccess('site') && (
        section === 'site' ? (
          <span className={toolbarStyles.activeSection}>Site</span>
        ) : (
          <AdminRouteLink to="/admin/site" onNavigateStart={onWorkspaceNavigateStart}>Site</AdminRouteLink>
        )
      )}
      {canAccess('content') && (
        section === 'content' ? (
          <span className={toolbarStyles.activeSection}>Content</span>
        ) : (
          <AdminRouteLink to="/admin/content" onNavigateStart={onWorkspaceNavigateStart}>Content</AdminRouteLink>
        )
      )}
      {canAccess('plugins') && (
        section === 'plugins' ? (
          <span className={toolbarStyles.activeSection}>Plugins</span>
        ) : (
          <AdminRouteLink to="/admin/plugins" onNavigateStart={onWorkspaceNavigateStart}>Plugins</AdminRouteLink>
        )
      )}
      {canAccess('users') && (
        section === 'users' ? (
          <span className={toolbarStyles.activeSection}>Users</span>
        ) : (
          <AdminRouteLink to="/admin/users" onNavigateStart={onWorkspaceNavigateStart}>Users</AdminRouteLink>
        )
      )}
      {canAccessPlugins && pluginPages.map((page) => (
        <AdminRouteLink
          key={`${page.pluginId}:${page.id}`}
          to={page.route}
          onNavigateStart={onWorkspaceNavigateStart}
        >
          {page.navLabel ?? page.title}
        </AdminRouteLink>
      ))}
    </>
  )
}

function AdminRouteLink({
  to,
  children,
  onNavigateStart,
}: {
  to: string
  children: ReactNode
  onNavigateStart?: () => void
}) {
  const inRouter = useInRouterContext()

  if (inRouter) {
    return (
      <RouterAdminRouteLink to={to} onNavigateStart={onNavigateStart}>
        {children}
      </RouterAdminRouteLink>
    )
  }

  return (
    <a className={toolbarStyles.adminLink} href={to}>
      {children}
    </a>
  )
}

function RouterAdminRouteLink({
  to,
  children,
  onNavigateStart,
}: {
  to: string
  children: ReactNode
  onNavigateStart?: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.currentTarget.target
    ) {
      return
    }

    if (location.pathname === to) return

    event.preventDefault()
    onNavigateStart?.()

    const startViewTransition = document.startViewTransition
    if (typeof startViewTransition !== 'function') {
      void navigate(to)
      return
    }

    startViewTransition.call(document, () => {
      flushSync(() => {
        void navigate(to)
      })
    })
  }

  return (
    <Link className={toolbarStyles.adminLink} to={to} onClick={handleClick}>
      {children}
    </Link>
  )
}
