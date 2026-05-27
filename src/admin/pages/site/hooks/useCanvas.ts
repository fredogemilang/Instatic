/**
 * useCanvas — gesture handling hook for the infinite canvas.
 *
 * Performance architecture (Contribution #312):
 * ─────────────────────────────────────────────
 * Pan/zoom state is kept in a REF during active interaction.
 * DOM writes are batched into requestAnimationFrame (one write/frame).
 * Zustand is updated with a 100ms debounce at interaction end.
 * This avoids React re-renders at 60fps during pan/zoom.
 *
 * Input support:
 * - Ctrl/Cmd + wheel → zoom towards cursor
 * - Plain wheel → pan vertically (and horizontally with shift)
 * - Middle mouse drag → pan
 * - Space + left-drag → pan
 * - Pinch (touch) → zoom+pan
 * - +/- keys → zoom in/out (committed immediately)
 * - Ctrl/Cmd+0 → reset to 100% zoom
 * - Shift+1 → fit-to-screen (1:1 zoom, centered)
 */

import { useRef, useEffect, useCallback } from 'react'
import { useGesture } from '@use-gesture/react'
import { useEditorStore, type EditorStore } from '@site/store/store'
import {
  applyZoom,
  applyPan,
  zoomFromWheelDelta,
  clampZoom,
  incrementalScaleFromPinchMovement,
} from '@site/canvas/math'

interface Transform {
  zoom: number
  panX: number
  panY: number
}

interface UseCanvasOptions {
  /** Ref to the gesture capture root */
  canvasRootRef: React.RefObject<HTMLElement | null>
  /** Ref to the div that gets the CSS transform applied to it */
  transformLayerRef: React.RefObject<HTMLElement | null>
  /**
   * Whether the canvas accepts pan/zoom gestures. False while the canvas is
   * showing a preview iframe (preview mode owns its own surface, no panning).
   * When this flips false→true the hook re-syncs the DOM transform from the
   * store so the freshly-mounted transform layer doesn't visibly jump on the
   * first wheel/pinch event.
   */
  enabled: boolean
}

type CanvasTransformSnapshot = readonly [zoom: number, panX: number, panY: number]

const selectCanvasTransformSnapshot = (state: EditorStore): CanvasTransformSnapshot => [
  state.zoom,
  state.panX,
  state.panY,
]

function areCanvasTransformSnapshotsEqual(
  a: CanvasTransformSnapshot,
  b: CanvasTransformSnapshot,
) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/**
 * Duration of the eased zoom transition for discrete actions
 * (toolbar buttons, +/− keys, reset / fit). Kept in sync with the
 * `data-animating='true'` rule in CanvasTransformLayer.module.css.
 */
const ANIMATED_TRANSFORM_MS = 220

export function useCanvas({ canvasRootRef, transformLayerRef, enabled }: UseCanvasOptions) {
  // Ref-based transform — not React state — avoids re-renders during interaction
  const transformRef = useRef<Transform>({ zoom: 1, panX: 0, panY: 0 })
  const rafRef = useRef<number | null>(null)
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const animatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const spaceActiveRef = useRef(false)
  const isDraggingRef = useRef(false)
  const lastPinchMovementRef = useRef(1)

  // Actions — Zustand actions are stable references, subscribing to them is fine.
  const setCanvasTransform = useEditorStore((s) => s.setCanvasTransform)
  const zoomIn = useEditorStore((s) => s.zoomIn)
  const zoomOut = useEditorStore((s) => s.zoomOut)
  const resetView = useEditorStore((s) => s.resetView)

  // ─── DOM write helper ─────────────────────────────────────────────────────

  /**
   * Write the transform to the DOM.
   *
   * `animated` toggles the `data-animating='true'` attribute on the layer,
   * which activates a CSS transition on `transform` (see
   * CanvasTransformLayer.module.css). Used for discrete zoom actions
   * (toolbar buttons, +/− keys, Cmd/Ctrl+0, Shift+1) so they ease in
   * instead of snapping. Continuous gestures (wheel / pinch / drag) pass
   * `animated=false` and remain instant — animating them would visibly
   * lag the cursor.
   */
  const applyTransformToDOM = useCallback((t: Transform, animated = false) => {
    const el = transformLayerRef.current
    if (!el) return

    if (animatingTimerRef.current) {
      clearTimeout(animatingTimerRef.current)
      animatingTimerRef.current = null
    }

    // Use setAttribute / removeAttribute instead of `el.dataset.X = ...` and
    // `delete el.dataset.X`. React Compiler treats DOM method calls as opaque
    // side effects (acceptable) but flags direct property assignment on a
    // value reached through a hook argument as a Rules-of-React violation.
    // Functionally identical — same `data-animating` attribute, same CSS
    // selector match in CanvasTransformLayer.module.css.
    if (animated) {
      el.setAttribute('data-animating', 'true')
      animatingTimerRef.current = setTimeout(() => {
        el.removeAttribute('data-animating')
        animatingTimerRef.current = null
      }, ANIMATED_TRANSFORM_MS)
    } else if (el.hasAttribute('data-animating')) {
      // A new gesture frame interrupting an in-flight animation: drop the
      // attribute so wheel/pinch/drag updates land instantly.
      el.removeAttribute('data-animating')
    }

    // setProperty avoids the same property-assignment lint trip as above.
    el.style.setProperty('transform', `translate(${t.panX}px, ${t.panY}px) scale(${t.zoom})`)
  }, [transformLayerRef])

  // Sync from store on mount AND whenever the canvas re-becomes enabled
  // (preview→design transition). Reading via getState() (not subscriptions)
  // avoids re-renders on every debounced pan commit — see Contribution #495.
  // The `enabled` dep ensures that when the user returns from preview mode,
  // the freshly-mounted transform layer immediately reflects the saved
  // pan/zoom instead of starting at the identity transform and visibly
  // jumping on the first wheel/pinch.
  useEffect(() => {
    if (!enabled) return
    const { zoom, panX, panY } = useEditorStore.getState()
    transformRef.current = { zoom, panX, panY }
    applyTransformToDOM(transformRef.current)
  }, [applyTransformToDOM, enabled])

  /**
   * Schedule a DOM write for the next animation frame.
   * Coalesces multiple updates within the same frame into a single DOM write.
   */
  const scheduleTransformWrite = useCallback((t: Transform) => {
    transformRef.current = t
    if (rafRef.current !== null) return // already scheduled
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      applyTransformToDOM(transformRef.current)
    })
  }, [applyTransformToDOM])

  /**
   * Debounced Zustand commit — fires 100ms after the last interaction event.
   * Keeps the store consistent without updating on every frame.
   */
  const scheduleStoreCommit = useCallback((t: Transform) => {
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
    commitTimerRef.current = setTimeout(() => {
      setCanvasTransform(t.zoom, t.panX, t.panY)
    }, 100)
  }, [setCanvasTransform])

  const updateTransform = useCallback((t: Transform) => {
    scheduleTransformWrite(t)
    scheduleStoreCommit(t)
  }, [scheduleTransformWrite, scheduleStoreCommit])

  const panBy = useCallback((dx: number, dy: number) => {
    const t = transformRef.current
    const next = applyPan(t.panX, t.panY, dx, dy)
    updateTransform({ zoom: t.zoom, ...next })
  }, [updateTransform])

  const resetCanvasView = useCallback(() => {
    resetView()
    transformRef.current = { zoom: 1, panX: 0, panY: 0 }
    applyTransformToDOM(transformRef.current, true)
  }, [resetView, applyTransformToDOM])

  // ─── Prevent browser pinch-zoom on Mac trackpad ──────────────────────────
  //
  // @use-gesture/react bind() (without `target`) routes all gesture handlers
  // through React's synthetic event system, which registers every listener as
  // passive.  Passive listeners CANNOT call event.preventDefault(), so the
  // browser applies its native Ctrl+scroll viewport zoom in addition to our
  // canvas zoom — causing panels, toolbars, and everything else to scale.
  //
  // Two separate event families must be blocked:
  //
  //  1. WheelEvent with ctrlKey=true — macOS trackpad pinch in Chrome/Firefox.
  //     Prevented at document level with { passive: false } so preventDefault()
  //     is honoured.
  //
  //  2. GestureEvent (gesturestart / gesturechange) — Safari's proprietary
  //     gesture API.  Safari routes trackpad pinch through these events before
  //     (or instead of) WheelEvent.  Without this listener, Safari ignores the
  //     wheel prevention and applies its native viewport zoom.
  //
  // Must be at document scope (not the canvas element) so the listener fires
  // before the browser claims the gesture, regardless of where the pointer is.
  // Same pattern used by Figma, Excalidraw, and Miro.
  useEffect(() => {
    if (!enabled) return
    const preventWheelZoom = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
    }
    // Safari proprietary GestureEvent — always prevent when it fires inside
    // the page; the canvas gesture handler (onPinch) provides the replacement.
    const preventGestureZoom = (e: Event) => e.preventDefault()

    // { passive: false } required — passive listeners cannot call preventDefault.
    document.addEventListener('wheel', preventWheelZoom, { passive: false })
    document.addEventListener('gesturestart', preventGestureZoom, { passive: false } as AddEventListenerOptions)
    document.addEventListener('gesturechange', preventGestureZoom, { passive: false } as AddEventListenerOptions)
    return () => {
      document.removeEventListener('wheel', preventWheelZoom)
      document.removeEventListener('gesturestart', preventGestureZoom)
      document.removeEventListener('gesturechange', preventGestureZoom)
    }
  }, [enabled])

  // ─── Spacebar tracking (for Space+drag pan) ───────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code === 'Space' && !e.repeat) {
        const target = e.target as HTMLElement
        // Don't intercept space in inputs/textareas
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) return
        e.preventDefault()
        spaceActiveRef.current = true
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'Space') {
        spaceActiveRef.current = false
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  // ─── Browser-style reset shortcut ─────────────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== '0') return

      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) return

      e.preventDefault()
      resetCanvasView()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [resetCanvasView])

  // ─── Keyboard shortcuts ───────────────────────────────────────────────────

  /**
   * Resolve the current canvas viewport center, in canvas-local coords.
   * Used as the zoom origin for keyboard +/− shortcuts so the zoom is
   * anchored to the middle of the visible area, not the document top-left.
   */
  const getViewportCenter = useCallback((): { x: number; y: number } | null => {
    const el = canvasRootRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    return { x: rect.width / 2, y: rect.height / 2 }
  }, [canvasRootRef])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't intercept typing — let inputs and contenteditables consume keys.
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) return

      // Zoom in/out with +/- keys — zoom around the canvas viewport center
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        const c = getViewportCenter()
        if (c) zoomIn(c.x, c.y)
        else zoomIn()
      } else if (e.key === '-') {
        e.preventDefault()
        const c = getViewportCenter()
        if (c) zoomOut(c.x, c.y)
        else zoomOut()
      } else if ((e.metaKey || e.ctrlKey) && e.key === '0') {
        e.preventDefault()
        resetCanvasView()
      } else if (e.key === '1' && e.shiftKey) {
        // `Shift+1` → Reset to 100% zoom (legacy muscle-memory shortcut).
        e.preventDefault()
        resetCanvasView()
      }
      // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z handled by App-level listener
    },
    [zoomIn, zoomOut, resetCanvasView, getViewportCenter],
  )

  // ─── External zoom/pan sync ───────────────────────────────────────────────
  //
  // ZoomControls (toolbar + buttons) and any other external caller update the
  // Zustand store directly via zoomIn/zoomOut/resetView.  The DOM transform
  // layer is NOT subscribed to the store via React state (intentional perf
  // design — avoids re-renders during 60fps gestures).  Without this
  // subscription those external actions only update the zoom indicator number
  // and never move the canvas visually.
  //
  // Zustand subscribers fire synchronously inside set(), so the DOM is updated
  // in the same microtask as the store change — no visible frame lag.
  //
  // This subscription must be scoped to the transform tuple. During wheel pan
  // the DOM transform intentionally leads the debounced store values; unrelated
  // store updates such as canvas hover must not "sync" the DOM back to stale pan.
  // The guard `zoom !== cur.zoom || ...` then prevents redundant DOM writes from
  // our own debounced Zustand commits (scheduleStoreCommit): by the time the
  // 100ms debounce fires, transformRef already holds the committed values.
  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe(
      selectCanvasTransformSnapshot,
      ([zoom, panX, panY]) => {
        const cur = transformRef.current
        if (zoom !== cur.zoom || panX !== cur.panX || panY !== cur.panY) {
          transformRef.current = { zoom, panX, panY }
          // External transform updates (toolbar buttons, +/− keys, agent
          // tools, undo/redo) animate to the new value. Continuous gestures
          // never reach this branch — by the time their debounced commit
          // fires, transformRef already matches the store and the guard
          // above skips the write.
          applyTransformToDOM(transformRef.current, true)
        }
      },
      { equalityFn: areCanvasTransformSnapshotsEqual },
    )
    return unsubscribe
  }, [applyTransformToDOM])

  // ─── Native wheel pan/zoom ────────────────────────────────────────────────
  //
  // Wheel cannot go through @use-gesture's React bind() path: React synthetic
  // wheel listeners are passive in modern React, so preventDefault is ignored,
  // and currentTarget can be null by the time @use-gesture invokes the handler.
  //
  // Skipped entirely while disabled (preview mode). If the listener stayed
  // bound, wheel-during-preview would silently mutate `transformRef` and the
  // debounced store commit, then on return to design the freshly mounted
  // transform layer would visibly jump on the first interaction.
  useEffect(() => {
    if (!enabled) return
    const canvasEl = canvasRootRef.current
    if (!canvasEl) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()

      const t = transformRef.current
      const rect = canvasEl.getBoundingClientRect()
      const originX = event.clientX - rect.left
      const originY = event.clientY - rect.top

      if (event.ctrlKey || event.metaKey) {
        const newZoom = zoomFromWheelDelta(t.zoom, event.deltaY)
        const next = applyZoom(t.zoom, newZoom, originX, originY, t.panX, t.panY)
        updateTransform(next)
        return
      }

      const wheelX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX
      const wheelY = event.shiftKey ? 0 : event.deltaY
      const next = applyPan(t.panX, t.panY, -wheelX, -wheelY)
      updateTransform({ zoom: t.zoom, ...next })
    }

    canvasEl.addEventListener('wheel', handleWheel, { passive: false })
    return () => {
      canvasEl.removeEventListener('wheel', handleWheel)
    }
  }, [canvasRootRef, updateTransform, enabled])

  // ─── Gesture handlers ─────────────────────────────────────────────────────

  const bind = useGesture(
    {
      onDrag: ({ delta: [dx, dy], buttons, first, last }) => {
        const isMiddleButton = (buttons & 4) !== 0
        const isSpacePan = spaceActiveRef.current

        if (!isMiddleButton && !isSpacePan) return

        if (first) isDraggingRef.current = true
        if (last) isDraggingRef.current = false

        const t = transformRef.current
        const next = applyPan(t.panX, t.panY, dx, dy)
        updateTransform({ zoom: t.zoom, ...next })
      },

      onPinch: ({ movement: [scaleMovement], origin: [ox, oy], first, last }) => {
        // event?.preventDefault() intentionally omitted — the document-level
        // gesturestart/gesturechange listeners above handle Safari, and the
        // document wheel listener handles Chrome/Firefox.  Calling preventDefault
        // here would be on a passive React synthetic event and has no effect.
        const t = transformRef.current
        // `origin` is in page coordinates — convert to canvas-relative
        const canvasEl = transformLayerRef.current?.parentElement
        if (!canvasEl) return
        const rect = canvasEl.getBoundingClientRect()
        const originX = ox - rect.left
        const originY = oy - rect.top
        // @use-gesture pinch movement[0] is accumulated since gesture start.
        // Convert it to a per-frame multiplier before applying it to the
        // current transform; otherwise every frame compounds the full gesture.
        const previousMovement = first ? 1 : lastPinchMovementRef.current
        const scaleDelta = incrementalScaleFromPinchMovement(scaleMovement, previousMovement)
        lastPinchMovementRef.current =
          Number.isFinite(scaleMovement) && scaleMovement > 0 ? scaleMovement : previousMovement

        const newZoom = clampZoom(t.zoom * scaleDelta)
        const next = applyZoom(t.zoom, newZoom, originX, originY, t.panX, t.panY)
        updateTransform(next)

        if (last) lastPinchMovementRef.current = 1
      },
    },
    {
      drag: { filterTaps: true },
      pinch: {
        eventOptions: { passive: false },
        // Trackpad pinch already arrives here through the native ctrl/meta
        // wheel listener above. Letting @use-gesture convert the same wheel
        // event into onPinch applies zoom twice and makes pinch far too fast.
        pinchOnWheel: false,
      },
    },
  )

  // ─── Cleanup on unmount ───────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (commitTimerRef.current) clearTimeout(commitTimerRef.current)
      if (animatingTimerRef.current) clearTimeout(animatingTimerRef.current)
    }
  }, [])

  return {
    bind,
    handleKeyDown,
    panBy,
    /** Whether a space-pan or middle-mouse drag is in progress */
    isDragging: isDraggingRef,
  }
}
