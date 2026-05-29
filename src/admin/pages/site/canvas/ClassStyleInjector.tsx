/**
 * ClassStyleInjector — injects/updates user class CSS into the target
 * document whenever the site's class registry changes.
 *
 * This is a pure side-effect component (renders null). It subscribes to
 * `site.classes` via a stable selector and imperatively manages a single
 * <style id="mc-classes"> element in the target document's <head>.
 *
 * Multi-document support
 * ──────────────────────
 * Each breakpoint frame in the canvas is its own iframe, with its own document.
 * `IframeFrameSurface` mounts one of these injectors per frame, targeting the
 * iframe's document. When no `targetDocument` prop is passed, the injector
 * falls back to the editor's main document — used by code paths that aren't
 * inside an iframe (none right now, but kept as a safe default).
 *
 * Architecture:
 * - One <style> tag per target document, kept in sync on every class
 *   registry change.
 * - CSS is generated from CSSPropertyBag by camelCase → kebab-case conversion.
 * - @media / `[data-breakpoint-id]` blocks are emitted for breakpoint overrides
 *   (uses site.breakpoints).
 * - No FOUC: the style element is created synchronously before first paint.
 *
 * Security (Constraint #228):
 * - Property names are validated against an allowlist (camelCase CSS properties).
 * - Values are sanitised via the canonical sanitiseCssValue() from publisher/utils.
 * - Only known CSS property names from CSSPropertyBag interface are emitted.
 *
 * Performance:
 * - Subscribes with a shallow-equality selector so re-renders only happen when
 *   classes actually change (not on every site edit).
 */

import { useEffect } from 'react'
import { useEditorStore } from '@site/store/store'
import { generateCanvasClassCSS, generatePreviewClassCSS } from './canvasClassCss'
import { resolveViewportUnitsForCanvas, type CanvasViewport } from './resolveViewportUnits'

interface ClassStyleInjectorProps {
  /**
   * Document to inject the <style> tag into. Defaults to the editor's main
   * document. Pass an iframe's `contentDocument` to scope the injection to
   * a single breakpoint frame.
   */
  targetDocument?: Document
  /**
   * Frame viewport used to resolve CSS viewport units (`vh`/`vw`/…) in class
   * styles to fixed px so they don't feed the iframe's grow-to-content height
   * loop. When omitted (non-iframe contexts), CSS is injected verbatim. See
   * `resolveViewportUnits.ts`.
   */
  viewport?: CanvasViewport
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const STYLE_TAG_ID = 'mc-classes'
const PREVIEW_STYLE_TAG_ID = 'mc-classes-preview'

/**
 * Stable empty array used as the ?? fallback for breakpoints selector.
 * Must be module-scope so it's reference-stable across renders — an inline `?? []`
 * literal creates a new array instance on every call, forcing unnecessary re-renders
 * (Guideline #239 — Zustand selectors must not use inline ?? [] / ?? {} fallbacks).
 */
const EMPTY_BREAKPOINTS: Array<{ id: string; width: number }> = []

export function ClassStyleInjector({ targetDocument, viewport }: ClassStyleInjectorProps = {}) {
  // Subscribe to class registry — shallow equality so we only re-run when
  // the classes object reference changes (Immer always creates a new ref on mutation)
  const classes = useEditorStore((s) => s.site?.classes ?? null)
  const breakpoints = useEditorStore((s) => s.site?.breakpoints ?? EMPTY_BREAKPOINTS)
  const frameworkColors = useEditorStore((s) => s.site?.settings.framework?.colors ?? null)
  const frameworkTypography = useEditorStore((s) => s.site?.settings.framework?.typography ?? null)
  const frameworkSpacing = useEditorStore((s) => s.site?.settings.framework?.spacing ?? null)
  const frameworkPreferences = useEditorStore((s) => s.site?.settings.framework?.preferences ?? null)
  const fonts = useEditorStore((s) => s.site?.settings.fonts ?? null)
  const previewClassStyles = useEditorStore((s) => s.previewClassStyles)

  useEffect(() => {
    const targetDoc = targetDocument ?? document
    // Get or create the <style> element inside the target document.
    let styleEl = targetDoc.getElementById(STYLE_TAG_ID) as HTMLStyleElement | null
    if (!styleEl) {
      styleEl = targetDoc.createElement('style')
      styleEl.id = STYLE_TAG_ID
      styleEl.setAttribute('data-source', 'ClassStyleInjector')
      targetDoc.head.appendChild(styleEl)
    }

    // Pin viewport units to the frame viewport (canvas-only) so class styles
    // using `vh`/`vmax`/… don't feed the iframe's grow-to-content height loop.
    const forCanvas = (css: string) => (viewport ? resolveViewportUnitsForCanvas(css, viewport) : css)

    const generated = generateCanvasClassCSS(
      classes && Object.keys(classes).length > 0 ? classes : {},
      breakpoints,
      frameworkColors,
      frameworkTypography,
      frameworkSpacing,
      frameworkPreferences,
      fonts,
    )
    styleEl.textContent = forCanvas(generated) || '/* no classes */'
  }, [targetDocument, viewport, classes, breakpoints, frameworkColors, frameworkTypography, frameworkSpacing, frameworkPreferences, fonts])

  // Preview overlay — a higher-specificity rule emitted while a user is
  // hovering a suggestion in a property control (e.g. spacing token
  // dropdown). Lives in its own <style> tag so it can be toggled cleanly
  // without re-running the main class-CSS generation.
  useEffect(() => {
    const targetDoc = targetDocument ?? document
    let previewEl = targetDoc.getElementById(PREVIEW_STYLE_TAG_ID) as HTMLStyleElement | null
    if (!previewClassStyles) {
      if (previewEl) previewEl.textContent = ''
      return
    }
    if (!previewEl) {
      previewEl = targetDoc.createElement('style')
      previewEl.id = PREVIEW_STYLE_TAG_ID
      previewEl.setAttribute('data-source', 'ClassStyleInjector:preview')
      targetDoc.head.appendChild(previewEl)
    }
    const cls = classes?.[previewClassStyles.classId]
    if (!cls) {
      previewEl.textContent = ''
      return
    }
    const previewCss = generatePreviewClassCSS(cls, {
      breakpointId: previewClassStyles.breakpointId ?? null,
      styles: previewClassStyles.styles,
    })
    previewEl.textContent = viewport ? resolveViewportUnitsForCanvas(previewCss, viewport) : previewCss
  }, [targetDocument, viewport, classes, previewClassStyles])

  // Cleanup: remove the style elements when the component unmounts. We
  // capture `targetDocument` into the effect so cleanup targets the same
  // document the effect installed to, even if the prop later changed.
  useEffect(() => {
    const targetDoc = targetDocument ?? document
    return () => {
      targetDoc.getElementById(STYLE_TAG_ID)?.remove()
      targetDoc.getElementById(PREVIEW_STYLE_TAG_ID)?.remove()
    }
  }, [targetDocument])

  return null
}
