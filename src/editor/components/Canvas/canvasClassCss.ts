import { bagToCSS } from '@core/publisher/classCss'
import { scopedPublisherResetCss } from '@core/publisher/reset'
import { generateFrameworkColorRootCss } from '@core/framework/colors'
import { generateFrameworkTypographyRootCss } from '@core/framework/typography'
import { generateFrameworkSpacingRootCss } from '@core/framework/spacing'
import { resolveFrameworkPreferences } from '@core/framework/preferences'
import { generateFontsCss } from '@core/fonts/css'
import { cssClassSelector } from '@core/page-tree/classNames'
import type { CSSClass } from '@core/page-tree/schemas'
import type { SiteFontsSettings } from '@core/fonts/schemas'
import type {
  FrameworkColorSettings,
  FrameworkPreferencesSettings,
  FrameworkSpacingSettings,
  FrameworkTypographySettings,
} from '@core/framework/schemas'

export function generateCanvasClassCSS(
  classes: Record<string, CSSClass>,
  breakpoints: Array<{ id: string; width: number }>,
  frameworkColors?: FrameworkColorSettings | null,
  frameworkTypography?: FrameworkTypographySettings | null,
  frameworkSpacing?: FrameworkSpacingSettings | null,
  frameworkPreferences?: FrameworkPreferencesSettings | null,
  fonts?: SiteFontsSettings | null,
): string {
  const blocks: string[] = []
  const preferences = resolveFrameworkPreferences(frameworkPreferences)

  // Publisher reset, scoped to the breakpoint frame viewports. Mirrors what
  // `publishPage()` injects into the published HTML so the design canvas and
  // the iframe preview / front end agree on the box model, default font, list
  // bullets, body margin, etc. The scope `[data-breakpoint-id]` matches the
  // viewport `<div>` in BreakpointFrame; editor chrome (toolbars, panels) is
  // outside that scope and continues to use the editor's own globals.css.
  blocks.push(scopedPublisherResetCss('[data-breakpoint-id]'))

  // Fonts go first (after the reset) so `@font-face` declarations exist before
  // any rule that references the family — browsers tolerate the reverse order,
  // but the ordering keeps generated CSS easier to inspect.
  const fontsCss = generateFontsCss(fonts)
  if (fontsCss) blocks.push(fontsCss)
  const frameworkColorCss = generateFrameworkColorRootCss(frameworkColors)
  if (frameworkColorCss) blocks.push(frameworkColorCss)
  const frameworkTypographyCss = generateFrameworkTypographyRootCss(frameworkTypography, preferences)
  if (frameworkTypographyCss) blocks.push(frameworkTypographyCss)
  const frameworkSpacingCss = generateFrameworkSpacingRootCss(frameworkSpacing, preferences)
  if (frameworkSpacingCss) blocks.push(frameworkSpacingCss)

  for (const cls of Object.values(classes)) {
    const baseDecls = bagToCSS(cls.styles)
    if (baseDecls) {
      blocks.push(`${cssClassSelector(cls)} {\n${baseDecls}\n}`)
    }

    for (const [bpId, bpStyles] of Object.entries(cls.breakpointStyles)) {
      const decls = bagToCSS(bpStyles)
      if (!decls) continue
      if (!breakpoints.some((breakpoint) => breakpoint.id === bpId)) continue
      blocks.push(`[data-breakpoint-id="${escapeCssAttribute(bpId)}"] ${cssClassSelector(cls)} {\n${decls}\n}`)
    }
  }

  return blocks.join('\n\n')
}

/**
 * Generate a higher-specificity preview rule for a single class, used by
 * the canvas style injector while a user is hovering a suggestion. The
 * doubled class selector (`.foo.foo`) wins over any base / breakpoint
 * rule emitted by `generateCanvasClassCSS`, without committing the
 * change to the document or pushing a history entry.
 */
export function generatePreviewClassCSS(
  cls: CSSClass,
  preview: { breakpointId?: string | null; styles: Record<string, unknown> },
): string {
  const decls = bagToCSS(preview.styles)
  if (!decls) return ''
  const selector = cssClassSelector(cls)
  const doubled = `${selector}${selector}`
  if (!preview.breakpointId) {
    return `${doubled} {\n${decls}\n}`
  }
  return `[data-breakpoint-id="${escapeCssAttribute(preview.breakpointId)}"] ${doubled} {\n${decls}\n}`
}

function escapeCssAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}
