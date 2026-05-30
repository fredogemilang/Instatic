/**
 * cssToStyleRules — Phase 1 of the Super Import pipeline.
 *
 * Pure, headless CSS text → NewStyleRule[] parser. No UI, no zip handling,
 * no store integration. Just parse + classify + collect warnings + collect
 * asset refs.
 *
 * ## @media policy
 *
 * Matched @media (within ±mediaTolerance of a known breakpoint width):
 *   inner declarations are folded into `breakpointStyles[matchedBreakpointId]`.
 *
 * Unmatched @media (no breakpoint close enough):
 *   inner declarations are folded into the base `styles`, filling in only
 *   properties NOT already present in the base rule (base-takes-precedence
 *   semantics). One `unmatched-media-query` warning is emitted per unique
 *   condition text across all @media blocks in the file. Real-world CSS
 *   (e.g. Tailwind v4) can emit the same condition dozens of times — once per
 *   utility class — so we deduplicate to avoid warning floods.
 *
 * ## asset-reference warnings
 *
 * The parser collects `url(...)` payloads into `assetRefs` but does NOT emit
 * `asset-reference` entries in `warnings`. The `asset-reference` warning kind
 * exists for Phase 2's use; Phase 1 just records URLs for later rewriting.
 *
 * ## order assignment
 *
 * `order` is assigned ascending from 0 in source position. The caller
 * (Phase 2's `applyImport.ts`) may re-order on merge. For a rule created by
 * a matched @media block (when no base rule existed), order reflects the
 * source position of the @media block.
 *
 * ## duplicate class names
 *
 * When the same `.class-name` selector appears more than once in the file,
 * the later rule wins (later-in-source = higher cascade priority). One
 * `duplicate-class` warning is emitted per duplicated class. The rule's
 * order is kept as the FIRST occurrence.
 */

import { isEmittableProperty } from '@core/publisher/classCss'
import type { StyleRuleKind } from '@core/page-tree'
import type { ImportWarning, BreakpointHint, AssetRef, NewStyleRule } from './types'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface CssToStyleRulesOptions {
  /**
   * Site breakpoints used to match `@media (max-width: Npx)` queries.
   * Defaults to `[]` (all @media queries are treated as unmatched).
   */
  breakpoints?: BreakpointHint[]
  /**
   * Tolerance in CSS pixels for matching a media query width to a breakpoint.
   * A media query `(max-width: 768px)` matches a breakpoint of width 775px
   * if `mediaTolerance >= 7`. Defaults to 10.
   */
  mediaTolerance?: number
}

export interface CssToStyleRulesResult {
  rules: NewStyleRule[]
  warnings: ImportWarning[]
  assetRefs: AssetRef[]
}

// ---------------------------------------------------------------------------
// CSSRule type constants (CSSOM spec §6.1 — rule.type numeric values)
//
// Using rule.type instead of instanceof so the code works in both the browser
// (native CSSStyleRule global) and the happy-dom test environment (constructors
// live on window, not globalThis).
// ---------------------------------------------------------------------------

const STYLE_RULE_TYPE = 1   // CSSStyleRule
const IMPORT_RULE_TYPE = 3  // CSSImportRule
const MEDIA_RULE_TYPE = 4   // CSSMediaRule
const FONT_FACE_RULE_TYPE = 5  // CSSFontFaceRule
const PAGE_RULE_TYPE = 6    // CSSPageRule
const KEYFRAMES_RULE_TYPE = 7  // CSSKeyframesRule
const NAMESPACE_RULE_TYPE = 10 // CSSNamespaceRule
const SUPPORTS_RULE_TYPE = 12  // CSSSupportsRule

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Truncate a CSS source string for use in warning messages.
 * Appends `…` when the string is cut.
 */
function truncate(text: string, maxLen = 120): string {
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

/**
 * Convert a kebab-case CSS property name to camelCase.
 * "background-color" → "backgroundColor", "z-index" → "zIndex"
 *
 * CSS custom properties (`--brand`) are case-sensitive and must be stored
 * verbatim — camelCasing `--brand` into `-Brand` would change the property and
 * break the cascade. They're returned unchanged. (Vendor-prefixed names like
 * `-webkit-foo` DO camelCase to `WebkitFoo`, matching the DOM style API.)
 */
function kebabToCamel(prop: string): string {
  if (prop.startsWith('--')) return prop
  return prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * A single `.class-name` selector with no compound selectors, no combinators,
 * and no pseudo-classes/elements.
 *
 * Matches: `.foo`, `.btn-primary`, `.my_class`
 * Doesn't match: `.foo.bar`, `.foo .bar`, `h1`, `a:hover`, `[data-x]`, `.foo::after`
 */
const SINGLE_CLASS_RE = /^\.[a-zA-Z_][\w-]*$/

function classifySelector(selector: string): { kind: StyleRuleKind; name: string } {
  if (SINGLE_CLASS_RE.test(selector)) {
    // kind:'class' — selector is `.<name>`, name is the part after the dot
    return { kind: 'class', name: selector.slice(1) }
  }
  // kind:'ambient' — the selector text IS the display name
  return { kind: 'ambient', name: selector }
}

/**
 * Get the CSSStyleSheet constructor, falling back to the happy-dom window
 * object in test environments where the constructor is not on globalThis.
 */
function getSheetConstructor(): typeof CSSStyleSheet | null {
  if (typeof CSSStyleSheet !== 'undefined') return CSSStyleSheet
  // happy-dom test env: available on globalThis.window
  const w =
    typeof window !== 'undefined'
      ? (window as unknown as Record<string, unknown>)
      : null
  if (w?.CSSStyleSheet) return w.CSSStyleSheet as typeof CSSStyleSheet
  return null
}

/**
 * Extract the first `max-width: Npx` value from a CSS condition text.
 * Returns null if the condition doesn't match the expected form.
 */
function extractMaxWidthPx(conditionText: string): number | null {
  const m = conditionText.match(/\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)\s*px\s*\)/i)
  if (!m) return null
  return parseFloat(m[1])
}

/**
 * Match a media query condition text to a breakpoint within tolerance.
 * Currently handles `(max-width: Npx)` only.
 */
function matchBreakpoint(
  conditionText: string,
  breakpoints: BreakpointHint[],
  tolerance: number,
): BreakpointHint | null {
  const width = extractMaxWidthPx(conditionText)
  if (width === null) return null
  for (const bp of breakpoints) {
    if (Math.abs(bp.width - width) <= tolerance) return bp
  }
  return null
}

/**
 * Read all `url(...)` payloads from a CSS declaration value.
 * Handles single-quoted, double-quoted, and unquoted forms.
 * Handles multiple urls per value (e.g. `background: url(a) url(b)`).
 */
function extractUrlPayloads(value: string): string[] {
  const result: string[] = []
  // Captures: group 1 = optional quote char, group 2 = url content (excl. quotes/parens)
  const re = /url\(\s*(['"]?)([^'")\n]*)\1\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const rawUrl = m[2].trim()
    if (rawUrl) result.push(rawUrl)
  }
  return result
}

/**
 * Parse all declarations from a CSSStyleDeclaration into a camelCase Record.
 *
 * Phase 1a: the property gate is permissive — `isEmittableProperty` accepts
 * any valid CSS property name except a tiny denylist. So a real-site import
 * keeps every standard property (`flex-grow`, `grid-auto-flow`, …) instead of
 * dropping it. The only declarations dropped here are the genuinely
 * dead/dangerous denied names, surfaced as a (rare) `blocked-property`
 * warning rather than the old flood of `unknown-property`.
 *
 * The brief specifies using `.length` + index access (not `for...of`) since
 * CSSStyleDeclaration doesn't enumerate properties via Symbol.iterator.
 */
function parseDeclarations(
  style: CSSStyleDeclaration,
  selectorForWarning: string,
  warnings: ImportWarning[],
): Record<string, unknown> {
  const decls: Record<string, unknown> = {}
  for (let i = 0; i < style.length; i++) {
    const kebab = style[i]
    const value = style.getPropertyValue(kebab).trim()
    if (!value) continue

    const camel = kebabToCamel(kebab)
    if (!isEmittableProperty(camel)) {
      warnings.push({
        kind: 'blocked-property',
        message: `Property "${camel}" (${kebab}) is blocked for security and was dropped`,
        selector: selectorForWarning,
        property: camel,
      })
      continue
    }

    decls[camel] = value
  }
  return decls
}

/**
 * Scan a declarations map for `url(...)` values and append AssetRef entries.
 */
function collectAssetRefsFromDecls(
  decls: Record<string, unknown>,
  ruleIndex: number,
  breakpointId: string | undefined,
  assetRefs: AssetRef[],
): void {
  for (const [property, value] of Object.entries(decls)) {
    if (typeof value !== 'string') continue
    for (const rawUrl of extractUrlPayloads(value)) {
      assetRefs.push({ ruleIndex, breakpointId, property, rawUrl })
    }
  }
}

/**
 * Human-readable @-rule name from the CSSOM `rule.type` integer.
 */
function atRuleName(type: number): string {
  switch (type) {
    case IMPORT_RULE_TYPE:   return '@import'
    case FONT_FACE_RULE_TYPE: return '@font-face'
    case PAGE_RULE_TYPE:     return '@page'
    case KEYFRAMES_RULE_TYPE: return '@keyframes'
    case NAMESPACE_RULE_TYPE: return '@namespace'
    case SUPPORTS_RULE_TYPE: return '@supports'
    default:                 return `CSS at-rule (type ${type})`
  }
}

// ---------------------------------------------------------------------------
// Main implementation
// ---------------------------------------------------------------------------

/**
 * Parse a CSS text string into an array of `NewStyleRule` objects.
 *
 * Uses the browser-native `CSSStyleSheet.replaceSync()` API (available in
 * modern browsers and happy-dom). If that throws (sheet-level parse error),
 * returns a single `invalid-rule` warning and no rules.
 *
 * @param cssText - Raw CSS source text.
 * @param options - Optional breakpoints + tolerance for @media matching.
 * @returns Parsed rules, warnings, and URL asset references.
 */
export function cssToStyleRules(
  cssText: string,
  options?: CssToStyleRulesOptions,
): CssToStyleRulesResult {
  const breakpoints = options?.breakpoints ?? []
  const mediaTolerance = options?.mediaTolerance ?? 10

  const rules: NewStyleRule[] = []
  const warnings: ImportWarning[] = []
  const assetRefs: AssetRef[] = []

  // ── Acquire the CSS engine ──────────────────────────────────────────────
  const SheetCtor = getSheetConstructor()
  if (!SheetCtor) {
    warnings.push({
      kind: 'invalid-rule',
      message: 'CSSStyleSheet is not available in this environment',
      source: truncate(cssText),
    })
    return { rules, warnings, assetRefs }
  }

  // ── Sheet-level parse ───────────────────────────────────────────────────
  let sheet: CSSStyleSheet
  try {
    sheet = new SheetCtor()
    sheet.replaceSync(cssText)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    warnings.push({
      kind: 'invalid-rule',
      message: `CSS parse error: ${message}`,
      source: truncate(cssText),
    })
    return { rules, warnings, assetRefs }
  }

  // ── Rule-processing state ───────────────────────────────────────────────
  //
  // selectorToLastIndex: tracks the most-recently-created rule index for each
  //   selector. Used when @media inner rules need to look up or create a rule.
  //
  // seenClassSelectors: tracks class selectors seen in base rules so we can
  //   emit a duplicate-class warning on the second occurrence.
  const selectorToLastIndex = new Map<string, number>()
  const seenClassSelectors = new Set<string>()

  // ── Process each top-level rule ─────────────────────────────────────────
  for (let i = 0; i < sheet.cssRules.length; i++) {
    const rule = sheet.cssRules[i]
    try {
      processTopLevelRule(
        rule,
        rules,
        warnings,
        assetRefs,
        breakpoints,
        mediaTolerance,
        selectorToLastIndex,
        seenClassSelectors,
      )
    } catch (_err) {
      // Per-rule resilience: if a rule throws unexpectedly, warn and continue.
      warnings.push({
        kind: 'invalid-rule',
        message: `Unexpected error processing rule: ${_err instanceof Error ? _err.message : String(_err)}`,
        source: truncate(rule.cssText),
      })
    }
  }

  return { rules, warnings, assetRefs }
}

// ---------------------------------------------------------------------------
// Top-level rule processing
// ---------------------------------------------------------------------------

function processTopLevelRule(
  rule: CSSRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  breakpoints: BreakpointHint[],
  mediaTolerance: number,
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
): void {
  switch (rule.type) {
    case STYLE_RULE_TYPE:
      processBaseStyleRule(
        rule as CSSStyleRule,
        rules,
        warnings,
        assetRefs,
        selectorToLastIndex,
        seenClassSelectors,
      )
      return

    case MEDIA_RULE_TYPE:
      processMediaRule(
        rule as CSSMediaRule,
        rules,
        warnings,
        assetRefs,
        breakpoints,
        mediaTolerance,
        selectorToLastIndex,
        seenClassSelectors,
      )
      return

    case SUPPORTS_RULE_TYPE: {
      // @supports (feature query) → conditional layer, stored verbatim.
      const supportsRule = rule as CSSConditionRule
      const query = supportsRule.conditionText ?? ''
      processConditionInner(
        supportsRule,
        rules,
        warnings,
        assetRefs,
        selectorToLastIndex,
        seenClassSelectors,
        { kind: 'supports', query },
      )
      return
    }

    case FONT_FACE_RULE_TYPE:
      // @font-face can't be modelled as a StyleRule (no selector — it's a
      // declarative side-effect at the stylesheet level). The rule itself is
      // dropped, but we still scrape its `src: url(...)` so the font files
      // make it to the media library — otherwise an importer would upload
      // images, then silently lose every font in the bundle. Re-wiring the
      // imported font into @font-face is a Phase 4 follow-up (storing
      // @font-face as a first-class site asset).
      collectFontFaceUrls(rule as CSSFontFaceRule, assetRefs, rules.length)
      warnings.push({
        kind: 'dropped-at-rule',
        message: `${atRuleName(rule.type)} rule is not supported by the import engine (font files were still uploaded)`,
        source: truncate(rule.cssText),
      })
      return

    default: {
      // @container has no stable legacy `rule.type` (it's a newer CSSOM
      // addition; browsers report 0). Detect it structurally: a grouping rule
      // whose cssText starts with `@container`. Route it to a conditional
      // layer keyed on the verbatim query (+ optional container name).
      const groupingRule = rule as Partial<CSSGroupingRule> & { cssText?: string; containerName?: string; containerQuery?: string }
      const cssText = groupingRule.cssText ?? ''
      if (Array.isArray((groupingRule as CSSGroupingRule).cssRules ?? null) || /^@container\b/i.test(cssText)) {
        const containerMatch = cssText.match(/^@container\s+([^({]+?)?\s*\(([^)]*)\)/i)
        if (containerMatch && (groupingRule as CSSGroupingRule).cssRules) {
          const name = (groupingRule.containerName || containerMatch[1] || '').trim()
          const query = (groupingRule.containerQuery || containerMatch[2] || '').trim()
          processConditionInner(
            groupingRule as CSSGroupingRule,
            rules,
            warnings,
            assetRefs,
            selectorToLastIndex,
            seenClassSelectors,
            { kind: 'container', query, ...(name ? { name } : {}) },
          )
          return
        }
      }

      // Genuinely unsupported at-rules: @keyframes, @import, @page,
      // @namespace, @layer, and anything else. (@import is usually silently
      // dropped by replaceSync; this handles the rare surfaced case.)
      warnings.push({
        kind: 'dropped-at-rule',
        message: `${atRuleName(rule.type)} rule is not supported by the import engine`,
        source: truncate(rule.cssText),
      })
      return
    }
  }
}

/**
 * Scan an `@font-face` rule's declarations for `url(...)` payloads and emit
 * them as assetRefs so the wizard uploads the font binaries. The synthetic
 * ruleIndex is `rules.length` at the time of capture — the resulting
 * assetRef won't bind to any importable style rule, but the asset planner
 * only uses `ruleIndex` to dedupe; the file still ends up in plan.assets.
 */
function collectFontFaceUrls(
  rule: CSSFontFaceRule,
  assetRefs: AssetRef[],
  syntheticRuleIndex: number,
): void {
  // @font-face only carries `src: url(...) format(...), url(...) format(...);`
  // for our purposes. Read the property and pull every url() payload out.
  const decl = rule.style
  if (!decl) return
  const srcValue = decl.getPropertyValue('src')
  if (!srcValue) return
  collectAssetRefsFromDecls(
    { src: srcValue } as unknown as Record<string, string>,
    syntheticRuleIndex,
    undefined,
    assetRefs,
  )
}

// ---------------------------------------------------------------------------
// Base CSSStyleRule processing
// ---------------------------------------------------------------------------

function processBaseStyleRule(
  rule: CSSStyleRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
): void {
  const selector = rule.selectorText.trim()
  const classified = classifySelector(selector)
  const decls = parseDeclarations(rule.style, selector, warnings)

  if (classified.kind === 'class') {
    if (seenClassSelectors.has(selector)) {
      // Duplicate class: later-in-source wins. Update existing rule's styles.
      warnings.push({
        kind: 'duplicate-class',
        message: `Class "${classified.name}" (${selector}) appears more than once; later declaration wins`,
        selector,
      })
      const existingIdx = selectorToLastIndex.get(selector)!
      // Overwrite base styles with the new declarations (last-write-wins)
      Object.assign(rules[existingIdx].styles, decls)
      // Collect any new asset refs from the updated declarations
      collectAssetRefsFromDecls(decls, existingIdx, undefined, assetRefs)
      return
    }
    seenClassSelectors.add(selector)
  }

  const idx = rules.length
  rules.push({
    name: classified.name,
    kind: classified.kind,
    selector,
    order: idx,
    styles: decls,
    breakpointStyles: {},
  })
  selectorToLastIndex.set(selector, idx)
  collectAssetRefsFromDecls(decls, idx, undefined, assetRefs)
}

// ---------------------------------------------------------------------------
// @media rule processing
// ---------------------------------------------------------------------------

function processMediaRule(
  mediaRule: CSSMediaRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  breakpoints: BreakpointHint[],
  mediaTolerance: number,
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
): void {
  // conditionText is on CSSConditionRule (parent of CSSMediaRule) per CSSOM spec.
  // Fallback to mediaText for environments that don't expose conditionText.
  const conditionText =
    (mediaRule as CSSMediaRule & { conditionText?: string }).conditionText
    ?? mediaRule.media.mediaText

  const matched = matchBreakpoint(conditionText, breakpoints, mediaTolerance)

  if (matched !== null) {
    // Matched breakpoint: merge inner rules into breakpointStyles[matched.id]
    processConditionInner(
      mediaRule,
      rules,
      warnings,
      assetRefs,
      selectorToLastIndex,
      seenClassSelectors,
      { kind: 'breakpoint', breakpointId: matched.id },
    )
  } else {
    // Unmatched @media: store the inner declarations as a faithful conditional
    // layer keyed on the verbatim media query — NOT folded into base styles
    // (which was lossy: it dropped the condition and let the override leak to
    // all viewports). The query round-trips and re-emits as `@media <query>`.
    processConditionInner(
      mediaRule,
      rules,
      warnings,
      assetRefs,
      selectorToLastIndex,
      seenClassSelectors,
      { kind: 'media', query: conditionText },
    )
  }
}

/**
 * Process the inner CSSStyleRules of a conditional @-block (@media /
 * @container / @supports), writing each inner rule's declarations to the
 * target condition on the matching StyleRule.
 *
 * Target:
 *   - `{ kind: 'breakpoint', breakpointId }` → `breakpointStyles[id]`
 *      (the first-class width-breakpoint model).
 *   - any other condition → a `conditionalLayers` entry keyed by the condition.
 */
type ConditionTarget =
  | { kind: 'breakpoint'; breakpointId: string }
  | StyleConditionForImport

/**
 * Subset of StyleCondition the importer produces. Mirrors the page-tree
 * StyleCondition union but kept local so the headless siteImport module
 * doesn't depend on its exact import path beyond the type. (NewStyleRule
 * already carries the full conditionalLayers shape via Omit<StyleRule, …>.)
 */
type StyleConditionForImport =
  | { kind: 'media'; query: string }
  | { kind: 'container'; query: string; name?: string }
  | { kind: 'supports'; query: string }

function conditionLayerId(target: ConditionTarget): string {
  switch (target.kind) {
    case 'breakpoint': return `bp:${target.breakpointId}`
    case 'media': return `media:${target.query}`
    case 'container': return `container:${target.name ?? ''}:${target.query}`
    case 'supports': return `supports:${target.query}`
  }
}

function processConditionInner(
  block: CSSGroupingRule,
  rules: NewStyleRule[],
  warnings: ImportWarning[],
  assetRefs: AssetRef[],
  selectorToLastIndex: Map<string, number>,
  seenClassSelectors: Set<string>,
  target: ConditionTarget,
): void {
  for (let i = 0; i < block.cssRules.length; i++) {
    const inner = block.cssRules[i]
    // Only process style rules inside the @-block (skip nested @-rules)
    if (inner.type !== STYLE_RULE_TYPE) continue

    const innerStyle = inner as CSSStyleRule
    const selector = innerStyle.selectorText.trim()
    const decls = parseDeclarations(innerStyle.style, selector, warnings)

    // Find or create the rule for this selector
    let idx: number
    if (selectorToLastIndex.has(selector)) {
      idx = selectorToLastIndex.get(selector)!
    } else {
      const classified = classifySelector(selector)
      idx = rules.length
      rules.push({
        name: classified.name,
        kind: classified.kind,
        selector,
        order: idx,
        styles: {},
        breakpointStyles: {},
      })
      selectorToLastIndex.set(selector, idx)
      if (classified.kind === 'class') seenClassSelectors.add(selector)
    }

    if (target.kind === 'breakpoint') {
      const bpId = target.breakpointId
      const existing = (rules[idx].breakpointStyles[bpId] ?? {}) as Record<string, unknown>
      rules[idx].breakpointStyles[bpId] = { ...existing, ...decls }
      collectAssetRefsFromDecls(decls, idx, bpId, assetRefs)
    } else {
      // Conditional layer: find-or-create the layer with this condition id,
      // then merge declarations. assetRefs use the base ruleIndex (the
      // normaliser uploads the file regardless of which layer references it).
      const rule = rules[idx]
      if (!rule.conditionalLayers) rule.conditionalLayers = []
      const layerId = conditionLayerId(target)
      let layer = rule.conditionalLayers.find((l) => l.id === layerId)
      if (!layer) {
        layer = {
          id: layerId,
          condition: target,
          styles: {},
          order: rule.conditionalLayers.length,
        }
        rule.conditionalLayers.push(layer)
      }
      Object.assign(layer.styles as Record<string, unknown>, decls)
      collectAssetRefsFromDecls(decls, idx, undefined, assetRefs)
    }
  }
}
