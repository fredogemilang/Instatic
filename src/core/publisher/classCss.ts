import type { StyleRule, StyleCondition } from '@core/page-tree'
import { styleRuleSelector } from '@core/page-tree/classNames'
import { sanitiseCssValue } from './utils'

/**
 * Convert a camelCase CSS property name to kebab-case.
 * "backgroundColor" -> "background-color", "zIndex" -> "z-index"
 */
function toKebab(camel: string): string {
  return camel.replace(/([A-Z])/g, (_, c: string) => `-${c.toLowerCase()}`)
}

/**
 * Permissive property model (Phase 1a — CSS fidelity plan).
 *
 * The publisher used to gate emitted declarations against a hand-maintained
 * allowlist of ~110 camelCase property names. That was whack-a-mole: every
 * real-site import surfaced another batch of dropped-but-perfectly-valid
 * properties (`flex-grow`, `grid-auto-flow`, `list-style-type`, …).
 *
 * The allowlist was never the security boundary — `sanitiseCssValue` is. It
 * blocks the actual injection vectors at the *value* level (`expression()`,
 * `javascript:`, `behavior:`, `-moz-binding`, `data:text`, `{`/`}`, `</`). A
 * property *name* cannot break out of a declaration or inject script. So the
 * name gate is now permissive: any syntactically-valid CSS property name is
 * emittable, except a tiny denylist of genuinely dead / dangerous names.
 *
 * `--custom-properties` and vendor-prefixed names (`-webkit-…`) pass too.
 *
 * @see docs/plans/2026-05-30-css-fidelity-and-at-rules.md (Part 1)
 */

/**
 * Genuinely dead / dangerous property NAMES. Their *values* are already
 * sanitised, but these properties have historically been script / behaviour
 * vectors (IE `behavior`, Mozilla XBL `-moz-binding`), so we drop them outright
 * regardless of value. Lowercased for comparison.
 */
export const DENIED_PROPS = new Set<string>([
  'behavior',
  '-moz-binding',
  '-ms-behavior',
])

/**
 * A syntactically valid CSS property name. `-{0,2}` allows an optional leading
 * `-` (vendor prefix, e.g. `-webkit-...`) or `--` (custom property), then a
 * letter, then letters / digits / hyphens. Zero dashes covers the camelCase
 * keys our editor writes (`fontSize`) AND plain kebab-case keys (`flex-grow`).
 */
const VALID_PROPERTY_RE = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/

/**
 * Whether a property may be emitted into published CSS. Permissive: valid CSS
 * identifier AND not in the denylist. Exported so the importer applies exactly
 * the same gate (no second source of truth).
 */
export function isEmittableProperty(prop: string): boolean {
  return VALID_PROPERTY_RE.test(prop) && !DENIED_PROPS.has(prop.toLowerCase())
}

// ---------------------------------------------------------------------------
// Side-shorthand collapse — `paddingTop/Right/Bottom/Left` → `padding: T R B L`
// ---------------------------------------------------------------------------
//
// The schema stores per-side values (paddingTop, paddingRight, …) as the only
// canonical shape — there is no `padding`/`margin` shorthand key in storage.
// At the publishing boundary we collapse those four declarations into the
// standard CSS shorthand so the generated stylesheet reads the way a human
// would write it (`padding: 20px 0;`) rather than four separate
// `padding-top/right/bottom/left` lines.
//
// Collapse only happens when ALL four sides are present in the bag — partial
// overrides (e.g. a breakpoint that only changes `paddingTop`) keep their
// per-side shape so they don't accidentally reset the other three sides to 0.

const SIDES = ['Top', 'Right', 'Bottom', 'Left'] as const
const SIDE_SHORTHAND_PREFIXES = ['padding', 'margin'] as const
type SideShorthandPrefix = (typeof SIDE_SHORTHAND_PREFIXES)[number]

const SIDE_PROP_TO_PREFIX = new Map<string, SideShorthandPrefix>(
  SIDE_SHORTHAND_PREFIXES.flatMap((prefix) =>
    SIDES.map((side) => [`${prefix}${side}`, prefix] as const),
  ),
)

/**
 * Collapse 4 per-side values into the shortest valid CSS shorthand:
 *   - all four equal               → "T"           (e.g. `20px`)
 *   - top == bottom, left == right → "T L"         (e.g. `20px 0`)
 *   - left == right                → "T L B"       (e.g. `20px 8px 12px`)
 *   - otherwise                    → "T R B L"     (e.g. `20px 8px 12px 4px`)
 */
function buildSidesShorthand(top: string, right: string, bottom: string, left: string): string {
  if (top === right && right === bottom && bottom === left) return top
  if (top === bottom && left === right) return `${top} ${right}`
  if (left === right) return `${top} ${left} ${bottom}`
  return `${top} ${right} ${bottom} ${left}`
}

/**
 * If `bag` carries all four `<prefix>Top/Right/Bottom/Left` values, return
 * the collapsed shorthand value. Returns `null` when any side is missing or
 * dropped by the sanitiser — the caller falls back to per-side longhand.
 */
function tryCollapseSides(
  bag: Record<string, unknown>,
  prefix: SideShorthandPrefix,
): string | null {
  const values: string[] = []
  for (const side of SIDES) {
    const raw = bag[`${prefix}${side}`]
    if (raw === undefined || raw === null || raw === '') return null
    const sanitised = sanitiseCssValue(raw as string | number)
    if (sanitised === null) return null
    values.push(sanitised)
  }
  const [top, right, bottom, left] = values
  return buildSidesShorthand(top, right, bottom, left)
}

/**
 * Serialise a style map to a CSS declaration block string.
 * Only emits properties in the allowlist with sanitised values.
 * Accepts the wide persistence type (Record<string, unknown>) since styles are
 * stored without per-property narrowing at the persistence boundary.
 *
 * Per-side `padding`/`margin` properties are collapsed into the standard
 * shorthand when all four sides are present (see `tryCollapseSides`). The
 * shorthand is emitted at the position of the first encountered side so it
 * appears in the natural order relative to other declarations.
 */
export function bagToCSS(bag: Record<string, unknown>): string {
  const lines: string[] = []
  // Track which prefixes have already been emitted as a collapsed shorthand
  // so we skip the remaining three side properties for that prefix.
  const collapsedPrefixes = new Set<SideShorthandPrefix>()

  for (const [prop, value] of Object.entries(bag)) {
    if (!isEmittableProperty(prop)) continue
    if (value === undefined || value === null || value === '') continue

    const sidePrefix = SIDE_PROP_TO_PREFIX.get(prop)
    if (sidePrefix) {
      if (collapsedPrefixes.has(sidePrefix)) continue
      const shorthand = tryCollapseSides(bag, sidePrefix)
      if (shorthand !== null) {
        lines.push(`  ${sidePrefix}: ${shorthand};`)
        collapsedPrefixes.add(sidePrefix)
        continue
      }
      // Fewer than 4 sides present → fall through and emit longhand below.
    }

    const sanitised = sanitiseCssValue(value as string | number)
    if (sanitised === null) continue
    lines.push(`  ${toKebab(prop)}: ${sanitised};`)
  }
  return lines.join('\n')
}

/**
 * Generate the full CSS string for all classes in the registry.
 * Includes base styles and @media blocks for breakpoint overrides.
 *
 * Cascade order matters. We emit breakpoint @media blocks in DESCENDING
 * width order (widest first, narrowest last). All @media (max-width: N)
 * blocks have the same selector specificity, so the last-matching one in
 * source order wins. Desktop is widest → its rule applies at wider
 * viewports while shadowed by tablet/mobile when the viewport narrows.
 *
 * If we iterated `cls.breakpointStyles` in insertion order, the user's
 * editing sequence would silently determine which breakpoint "wins" at
 * any given viewport — e.g. mobile-then-desktop would let desktop styles
 * leak through to mobile widths because desktop's @media rule was last
 * in source. Sorting by width fixes that for good.
 */
export function generateClassCSS(
  classes: Record<string, StyleRule>,
  breakpoints: Array<{ id: string; width: number }>,
): string {
  const blocks: string[] = []
  // Map id → width once per call so we can sort breakpoint entries below
  // without re-scanning the array per class.
  const widthById = new Map<string, number>(breakpoints.map((bp) => [bp.id, bp.width]))

  // Cascade order: rules with a smaller `order` are emitted first so a later,
  // more-specific override appears later in source and wins on equal
  // specificity. Imported rules carry the source stylesheet's position;
  // user-created rules append at the end (see classSlice.nextRuleOrder).
  const orderedClasses = Object.values(classes).slice().sort((a, b) => {
    const ao = typeof a.order === 'number' ? a.order : 0
    const bo = typeof b.order === 'number' ? b.order : 0
    return ao - bo
  })

  for (const cls of orderedClasses) {
    const selector = styleRuleSelector(cls)
    const baseDecls = bagToCSS(cls.styles)
    if (baseDecls) {
      blocks.push(`${selector} {\n${baseDecls}\n}`)
    }

    // Conditional layers (custom @media / @container / @supports) emit AFTER
    // base but BEFORE the width-breakpoint @media blocks, so explicit width
    // breakpoints keep winning at their widths (cascade precedence Q-A:
    // base → conditional layers → breakpoint @media). Ordered by each
    // layer's `order` so source order from the importer is preserved.
    const layers = (cls.conditionalLayers ?? []).slice().sort((a, b) => {
      const ao = typeof a.order === 'number' ? a.order : 0
      const bo = typeof b.order === 'number' ? b.order : 0
      return ao - bo
    })
    for (const layer of layers) {
      const decls = bagToCSS(layer.styles)
      if (!decls) continue
      const prelude = conditionPrelude(layer.condition, widthById)
      if (!prelude) continue
      blocks.push(`${prelude} {\n  ${selector} {\n${decls}\n  }\n}`)
    }

    const bpEntries = Object.entries(cls.breakpointStyles)
      .map(([bpId, bpStyles]) => ({ bpStyles, width: widthById.get(bpId) }))
      .filter((entry): entry is { bpStyles: typeof entry.bpStyles; width: number } =>
        entry.width !== undefined,
      )
      // Widest first → narrowest last. The narrowest matching @media rule
      // ends up later in source and wins on equal specificity.
      .sort((a, b) => b.width - a.width)

    for (const { bpStyles, width } of bpEntries) {
      const decls = bagToCSS(bpStyles)
      if (!decls) continue
      blocks.push(`@media (max-width: ${width}px) {\n  ${selector} {\n${decls}\n  }\n}`)
    }
  }

  return blocks.join('\n\n')
}

/**
 * Build the `@<kind> <query>` prelude for a conditional layer's condition.
 * Returns null when a `breakpoint`-kind condition references an unknown
 * breakpoint id (nothing sensible to emit). The query text is the author's /
 * importer's verbatim string; it has already been through the browser's CSS
 * parser at import time, so we trust its syntax here.
 */
export function conditionPrelude(
  condition: StyleCondition,
  widthById: Map<string, number>,
): string | null {
  switch (condition.kind) {
    case 'breakpoint': {
      const width = widthById.get(condition.breakpointId)
      return width === undefined ? null : `@media (max-width: ${width}px)`
    }
    case 'media':
      return `@media ${condition.query}`
    case 'container':
      return condition.name
        ? `@container ${condition.name} ${wrapParens(condition.query)}`
        : `@container ${wrapParens(condition.query)}`
    case 'supports':
      return `@supports ${wrapParens(condition.query)}`
    default:
      return null
  }
}

/**
 * Wrap a condition query in parens unless it already is. CSSOM's
 * `conditionText` sometimes includes the surrounding parens (`(display: grid)`)
 * and sometimes not (`display: grid`), depending on the engine — normalise so
 * we never double-wrap (`@supports ((display: grid))`).
 */
function wrapParens(query: string): string {
  const q = query.trim()
  return q.startsWith('(') ? q : `(${q})`
}
