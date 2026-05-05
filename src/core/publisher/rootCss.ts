/**
 * Publisher — root CSS builder.
 *
 * Generates the platform-level CSS that lives in `framework.css` for a
 * published site:
 *   1. `@font-face` rules + `--font-<slug>` tokens (fonts library).
 *   2. Framework Color root variables + utility classes.
 *   3. Framework Typography root variables + utility classes.
 *   4. Framework Spacing root variables + utility classes.
 *
 * If the user hasn't configured any of those, this returns the empty string.
 * The publisher's external-mode emitter then skips the `framework.css` `<link>`
 * tag entirely so a brand-new project doesn't load a zero-byte stylesheet.
 *
 * The legacy `site.settings.colorTokens` raw `:root {}` path was removed —
 * the editor's Colors panel manages framework Color settings, which is the
 * single source of truth for color tokens. See SiteSettingsSchema for the
 * removal note.
 */

import type { SiteDocument } from '../page-tree/schemas'
import { generateFrameworkColorRootCss } from '../framework/colors'
import { generateFrameworkTypographyRootCss } from '../framework/typography'
import { generateFrameworkSpacingRootCss } from '../framework/spacing'
import { resolveFrameworkPreferences } from '../framework/preferences'
import { generateFontsCss } from '../fonts/css'

export function buildSiteRootCss(site: SiteDocument): string {
  const { framework, fonts } = site.settings
  const preferences = resolveFrameworkPreferences(framework?.preferences)
  // Fonts emit @font-face rules + --font-<slug> tokens. Emit first so any
  // rule that references a font family resolves against an already-declared
  // face. All `src` URLs are restricted to /uploads/fonts/ upstream — no CDN
  // linkage in the published page (Constraint: published HTML never reaches
  // Google).
  const fontsCss = generateFontsCss(fonts)
  const frameworkColorCss = generateFrameworkColorRootCss(framework?.colors)
  const frameworkTypographyCss = generateFrameworkTypographyRootCss(framework?.typography, preferences)
  const frameworkSpacingCss = generateFrameworkSpacingRootCss(framework?.spacing, preferences)
  return [fontsCss, frameworkColorCss, frameworkTypographyCss, frameworkSpacingCss]
    .filter(Boolean)
    .join('\n')
}
