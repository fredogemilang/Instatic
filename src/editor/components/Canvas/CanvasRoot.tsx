/**
 * CanvasRoot — the top-level canvas component.
 *
 * Responsibilities:
 * - Captures all wheel, drag, and pinch gestures via useCanvas
 * - Manages the CanvasSelectionContext (click → selectNode, hover → hoverNode)
 * - Handles canvas-level keyboard shortcuts (Delete, Ctrl+D, Escape)
 * - Renders CanvasTransformLayer inside the gesture-capture area
 * - Renders CanvasNotch (position: absolute, not in transform layer)
 * - Handles double-click on base.visual-component-ref → enters VC canvas mode
 *
 * Performance architecture:
 * - Pan/zoom writes go directly to CanvasTransformLayer's style.transform via ref
 * - No React state is updated during active interaction (60fps pan/zoom)
 * - NodeRenderer components memo'd per node — only affected nodes re-render on edit
 *
 * Accessibility:
 * - tabIndex={0} so the canvas receives keyboard events
 * - aria-label for screen reader orientation
 * - prefers-reduced-motion: CSS transitions are disabled for users who opt out
 */

import { useRef, useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDroppable } from '@dnd-kit/core'
import { useEditorStore, selectActiveCanvasPage, selectRightSidebarExpanded } from '@core/editor-store/store'
import type { Breakpoint } from '@core/page-tree/schemas'
import { registry } from '@core/module-engine/registry'
import { ErrorBoundary } from '@ui/components/ErrorBoundary'
import { useCanvas } from '../../hooks/useCanvas'
import { CanvasTransformLayer } from './CanvasTransformLayer'
import { CanvasNotch } from './CanvasNotch'
import { CanvasModeToggle } from './CanvasModeToggle'
import { CanvasBreakpointSelector } from './CanvasBreakpointSelector'
import { CanvasSelectionContext } from './CanvasContexts'
import { ClassStyleInjector } from './ClassStyleInjector'
import { LayerNodeContextMenu } from '../DomPanel/LayerNodeContextMenu'
import { useTemplatePreviewContext } from '../../hooks/useTemplatePreviewContext'
import styles from './CanvasRoot.module.css'

/**
 * Stable empty-breakpoints sentinel — used as the `?? fallback` in the
 * breakpoints selector so that `Object.is(prev, next)` returns `true` when
 * the site is null, preventing useSyncExternalStore from entering an
 * infinite re-render loop.  Never use `?? []` inline in a useEditorStore
 * selector — a new array literal has a new identity on every call.
 */
const EMPTY_BREAKPOINTS: Breakpoint[] = []

/**
 * B2 — dnd-kit droppable ID for the canvas root.
 * The AdminLayout's canvas-level DndContext uses this to detect when a
 * visualComponentRef drag is released over the canvas.
 */
export const CANVAS_ROOT_DROPPABLE_ID = 'canvas-root'

export function CanvasRoot() {
  const transformLayerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null)

  // B2 — Register canvas root as a drop target for visualComponentRef drags.
  // The AdminLayout DndContext's onDragEnd checks event.over.id against CANVAS_ROOT_DROPPABLE_ID.
  const { setNodeRef: setCanvasDropRef } = useDroppable({ id: CANVAS_ROOT_DROPPABLE_ID })

  // Merged callback ref: satisfies both useCanvas (canvasRef) and useDroppable (setCanvasDropRef).
  const mergedCanvasRef = useCallback(
    (el: HTMLDivElement | null) => {
      canvasRef.current = el
      setCanvasDropRef(el)
    },
    [setCanvasDropRef],
  )

  // Store subscriptions
  const canvasPage = useEditorStore(selectActiveCanvasPage)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const activeBreakpointId = useEditorStore((s) => s.activeBreakpointId)
  const rightSidebarExpanded = useEditorStore(selectRightSidebarExpanded)
  // selectedNodeId is needed here for canvas-level keyboard shortcuts (Delete, Ctrl+D).
  // hoveredNodeId is NOT subscribed here — NodeRenderer handles its own hover state
  // via per-node selectors to avoid O(N) re-renders on every hover event (#495).
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const selectNode = useEditorStore((s) => s.selectNode)
  const hoverNode = useEditorStore((s) => s.hoverNode)
  const clearSelection = useEditorStore((s) => s.clearSelection)
  const deleteNode = useEditorStore((s) => s.deleteNode)
  const duplicateNode = useEditorStore((s) => s.duplicateNode)
  const renameNode = useEditorStore((s) => s.renameNode)
  const wrapNode = useEditorStore((s) => s.wrapNode)
  const setActiveBreakpoint = useEditorStore((s) => s.setActiveBreakpoint)
  const setFocusedPanel = useEditorStore((s) => s.setFocusedPanel)
  const setActiveDocument = useEditorStore((s) => s.setActiveDocument)
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const templatePreviewContext = useTemplatePreviewContext(canvasPage)
  const focusActiveBreakpoint = Boolean(selectedNodeId && rightSidebarExpanded)

  // Canvas gesture hook (pan/zoom)
  const { bind, handleKeyDown: canvasKeyDown } = useCanvas({
    canvasRootRef: canvasRef,
    transformLayerRef,
  })

  // ─── Selection context value ───────────────────────────────────────────────

  const onNodeClick = useCallback(
    (nodeId: string, e: React.MouseEvent, breakpointId?: string) => {
      e.stopPropagation()
      if (breakpointId && breakpointId !== activeBreakpointId) {
        setActiveBreakpoint(breakpointId)
      }
      selectNode(nodeId)
      setFocusedPanel('canvas')
    },
    [activeBreakpointId, selectNode, setActiveBreakpoint, setFocusedPanel],
  )

  const onNodeHover = useCallback(
    (nodeId: string | null, breakpointId?: string) => {
      hoverNode(nodeId, breakpointId)
    },
    [hoverNode],
  )

  const onNodeContextMenu = useCallback(
    (nodeId: string, e: React.MouseEvent, breakpointId?: string) => {
      e.preventDefault()
      e.stopPropagation()
      if (breakpointId && breakpointId !== activeBreakpointId) {
        setActiveBreakpoint(breakpointId)
      }
      selectNode(nodeId)
      setFocusedPanel('canvas')
      setContextMenu({ x: e.clientX, y: e.clientY, nodeId })
    },
    [activeBreakpointId, selectNode, setActiveBreakpoint, setFocusedPanel],
  )

  /**
   * Double-click on a canvas node (Task #438 — Deliverable 3).
   * When the double-clicked node is a base.visual-component-ref, enter VC canvas mode.
   * For all other nodes, double-click is a no-op (handled by individual module components).
   */
  const onNodeDoubleClick = useCallback(
    (nodeId: string, _e: React.MouseEvent) => {
      // Imperative store access — correct in event handlers
      const state = useEditorStore.getState()
      const node = selectActiveCanvasPage(state)?.nodes[nodeId]
      if (!node) return

      if (node.moduleId === 'base.visual-component-ref') {
        const componentId = node.props.componentId
        if (typeof componentId === 'string' && componentId) {
          setActiveDocument({ kind: 'visualComponent', vcId: componentId })
        }
      }
    },
    [setActiveDocument],
  )

  // Context carries only stable callbacks — selectedNodeId/hoveredNodeId are
  // intentionally excluded (Perf fix — Contribution #495). Each NodeRenderer
  // subscribes to its own boolean directly, so only the 2 affected nodes
  // re-render per selection/hover event rather than the entire canvas tree.
  const selectionContextValue = useMemo(
    () => ({ onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick }),
    [onNodeClick, onNodeHover, onNodeContextMenu, onNodeDoubleClick],
  )

  // ─── Canvas-level keyboard shortcuts ──────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Let useCanvas handle zoom/pan shortcuts
      canvasKeyDown(e)

      // Escape exits VC mode regardless of selection state (SF-1 / CR #666).
      // This branch must run BEFORE the selectedNodeId guard so pressing Escape
      // while in VC mode with nothing selected still returns to the page canvas.
      if (e.key === 'Escape') {
        clearSelection()
        if (activeDocument?.kind === 'visualComponent') {
          setActiveDocument(null)
        }
        return
      }

      if (!selectedNodeId) return

      // Delete / Backspace → delete selected node
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Don't intercept backspace in inputs
        const target = e.target as HTMLElement
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) return
        e.preventDefault()
        deleteNode(selectedNodeId)
        clearSelection()
      }

      // Ctrl/Cmd+D → duplicate
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault()
        duplicateNode(selectedNodeId)
      }
    },
    [selectedNodeId, canvasKeyDown, deleteNode, clearSelection, duplicateNode, activeDocument, setActiveDocument],
  )

  // ─── Canvas background click → deselect ───────────────────────────────────

  const handleCanvasClick = useCallback(() => {
    setContextMenu(null)
    clearSelection()
  }, [clearSelection])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  const renameNodeFromCanvas = useCallback((nodeId: string) => {
    const state = useEditorStore.getState()
    const node = selectActiveCanvasPage(state)?.nodes[nodeId]
    if (!node) return

    const definition = registry.get(node.moduleId)
    const currentName = node.label || definition?.name || node.moduleId
    const nextName = window.prompt('Rename element', currentName)?.trim()
    if (!nextName || nextName === currentName) return

    renameNode(nodeId, nextName)
  }, [renameNode])

  return (
    <CanvasSelectionContext.Provider value={selectionContextValue}>
      <div
        ref={mergedCanvasRef}
        role="region"
        aria-label="Canvas — infinite editing surface"
        tabIndex={0}
        data-testid="canvas-root"
        data-canvas-state={canvasPage ? 'canvas-ready' : 'canvas-empty'}
        data-vc-mode={activeDocument?.kind === 'visualComponent' ? 'true' : undefined}
        onKeyDown={handleKeyDown}
        onClick={handleCanvasClick}
        onFocus={() => setFocusedPanel('canvas')}
        className={styles.canvas}
        // Spread gesture handlers from useGesture (wheel, drag, pinch)
        {...bind()}
      >
        {/* CSS for prefers-reduced-motion — no transitions for accessibility */}
        <style>{`
          @media (prefers-reduced-motion: reduce) {
            [data-testid="canvas-transform-layer"] {
              transition: none !important;
            }
          }
        `}</style>

        {/* Phase C — CSS class styles injected into document.head */}
        <ClassStyleInjector />

        {/* Fixed insert controls — part of canvas chrome, not the zoom layer. */}
        <CanvasNotch />

        {/* Design / Preview view toggle — top-left chrome */}
        <CanvasModeToggle />

        {rightSidebarExpanded && (
          <CanvasBreakpointSelector
            breakpoints={breakpoints}
            activeBreakpointId={activeBreakpointId}
            onBreakpointChange={setActiveBreakpoint}
          />
        )}

        {/*
          A buggy module render must not blank the toolbar / DOM panel /
          properties panel that share the editor shell. Resetting on the
          active page id means switching pages naturally clears stuck
          errors — the user navigates away from a broken module preview
          rather than getting "stuck" on the failure screen.
        */}
        <ErrorBoundary
          location="canvas"
          resetKeys={[canvasPage?.id ?? null, activeDocument?.kind ?? null]}
        >
          <CanvasTransformLayer
            ref={transformLayerRef}
            page={canvasPage}
            breakpoints={breakpoints}
            activeBreakpointId={activeBreakpointId}
            dimInactiveBreakpoints={focusActiveBreakpoint}
            onBreakpointActivate={setActiveBreakpoint}
            templateContext={templatePreviewContext}
          />
        </ErrorBoundary>

        {contextMenu && createPortal(
          <LayerNodeContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={closeContextMenu}
            onDelete={() => {
              deleteNode(contextMenu.nodeId)
              closeContextMenu()
            }}
            onDuplicate={() => {
              duplicateNode(contextMenu.nodeId)
              closeContextMenu()
            }}
            onRename={() => {
              const { nodeId } = contextMenu
              closeContextMenu()
              renameNodeFromCanvas(nodeId)
            }}
            onWrapInContainer={() => {
              wrapNode(contextMenu.nodeId, 'base.container')
              closeContextMenu()
            }}
          />,
          document.body,
        )}
      </div>
    </CanvasSelectionContext.Provider>
  )
}
