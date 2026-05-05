/**
 * BreakpointSelectionOverlay — selection and hover rings for the canvas.
 *
 * Why this exists
 * ───────────────
 * The previous design rendered selection/hover rings via a `::after`
 * pseudo-element on `NodeWrapper`. That required `NodeWrapper` to produce a
 * layout box (`<div>` with `position: relative`), which in turn forced every
 * canvas node into block flow — breaking inline behaviour (two `<a>` siblings
 * stacking instead of sitting side-by-side, flex-row containers laying out as
 * column, etc.) and diverging from the published HTML.
 *
 * Now `NodeWrapper` is `display: contents` (no layout box, exact match for
 * published), and rings live here as absolutely-positioned divs over the
 * actual rendered module element.
 *
 * Architecture
 * ────────────
 * - One overlay per breakpoint frame, mounted inside the viewport `<div>`
 *   (which is already `position: relative`).
 * - Subscribes to `selectedNodeId` and (per-frame) `hoveredNodeId`.
 * - Resolves the rendered element via `[data-node-id="X"]`'s first element
 *   child (modules render single-root HTML, so `firstElementChild` is the
 *   actual rendered tag — `<a>`, `<h1>`, `<div>`, etc.).
 * - Computes the rect relative to the viewport on every animation frame
 *   while a ring is visible (cheap; getBoundingClientRect + style write).
 *   Polling via RAF is simpler than wiring ResizeObserver/MutationObserver/
 *   IntersectionObserver to every possible mutation source.
 * - Clears style positioning when the tracked node disappears or the
 *   selection/hover clears.
 *
 * Contract
 * ────────
 * The overlay is purely presentational and click-through (`pointer-events:
 * none` in CSS). Click/hover/keyboard interaction still flows through
 * `NodeWrapper` exactly as before.
 */

import { useEffect, useRef } from 'react'
import { useEditorStore } from '@core/editor-store/store'
import { cn } from '@ui/cn'
import styles from './BreakpointSelectionOverlay.module.css'

interface BreakpointSelectionOverlayProps {
  /**
   * The breakpoint frame this overlay belongs to. Used to scope the hover
   * ring — only the frame that owns the current hover renders one. Selection
   * applies to all frames simultaneously (the user sees the same node
   * highlighted in every breakpoint preview).
   */
  breakpointId: string
  /**
   * Ref to the viewport `<div>` the overlay sits inside. Bounding rects are
   * computed relative to this element so the ring follows pan/zoom without
   * extra math.
   */
  viewportRef: React.RefObject<HTMLElement | null>
}

export function BreakpointSelectionOverlay({
  breakpointId,
  viewportRef,
}: BreakpointSelectionOverlayProps) {
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId)
  const hoveredNodeId = useEditorStore((s) =>
    s.hoveredBreakpointId === breakpointId ? s.hoveredNodeId : null,
  )

  const selectionRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef<HTMLDivElement>(null)

  // Track whichever rings are currently visible. Hover only renders when the
  // hovered node differs from the selected one — otherwise the two rings
  // would stack and the hover ring would mask the selection ring.
  const showHover = Boolean(hoveredNodeId) && hoveredNodeId !== selectedNodeId

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    let frame = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      positionRing(selectionRef.current, selectedNodeId, viewport)
      positionRing(hoverRef.current, showHover ? hoveredNodeId : null, viewport)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [selectedNodeId, hoveredNodeId, showHover, viewportRef])

  return (
    <div className={styles.overlayLayer} aria-hidden="true">
      {selectedNodeId && (
        <div
          ref={selectionRef}
          className={cn(styles.ring, styles.selection)}
          data-canvas-selection-ring="true"
          data-node-id={selectedNodeId}
        />
      )}
      {showHover && hoveredNodeId && (
        <div
          ref={hoverRef}
          className={cn(styles.ring, styles.hover)}
          data-canvas-hover-ring="true"
          data-node-id={hoveredNodeId}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Positioning helper
// ---------------------------------------------------------------------------

/**
 * Move/resize a ring div to overlay the rendered element of `nodeId` inside
 * `viewport`. Hides the ring (display: none) if the element is not currently
 * mounted — happens transiently during page swaps, breakpoint changes, or
 * when the selection points into a hidden subtree.
 *
 * Coordinates are computed via getBoundingClientRect and made viewport-local
 * by subtracting the viewport's own rect — naturally handles zoom/pan because
 * the viewport itself is transformed with the canvas.
 */
function positionRing(
  ring: HTMLDivElement | null,
  nodeId: string | null,
  viewport: HTMLElement,
): void {
  if (!ring) return

  if (!nodeId) {
    ring.style.display = 'none'
    return
  }

  // The wrapper is `display: contents` so its own getBoundingClientRect
  // returns a zero-sized rect. Read the rect from the actual rendered child
  // element instead — modules render single-root HTML, so firstElementChild
  // is the right target. Search inside the viewport so a duplicate node-id
  // in another breakpoint frame can't be picked up by accident.
  const wrapper = viewport.querySelector<HTMLElement>(
    `[data-node-id="${escapeAttribute(nodeId)}"]`,
  )
  const target = wrapper?.firstElementChild ?? wrapper

  if (!target || !(target instanceof Element)) {
    ring.style.display = 'none'
    return
  }

  const rect = target.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    // Element is in the DOM but not laid out (display: none ancestor, etc.) —
    // hide the ring rather than draw a zero-sized box at (0,0).
    ring.style.display = 'none'
    return
  }

  const viewportRect = viewport.getBoundingClientRect()
  const x = rect.left - viewportRect.left
  const y = rect.top - viewportRect.top

  // transform/width/height instead of top/left/width/height so the browser
  // can promote the ring to its own compositing layer (smooth follow without
  // layout thrash on the rest of the canvas).
  ring.style.display = ''
  ring.style.transform = `translate(${x}px, ${y}px)`
  ring.style.width = `${rect.width}px`
  ring.style.height = `${rect.height}px`
}

/**
 * Escape an attribute value for safe inclusion in a CSS attribute selector.
 * `nodeId` is generated server-side / by the editor so the alphabet is
 * controlled, but escaping `"` and `\` is cheap insurance and matches the
 * defensive pattern used elsewhere in canvasClassCss.ts.
 */
function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
