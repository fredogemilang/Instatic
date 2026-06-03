import { isUserVisibleClass, styleRuleSelector } from '@core/page-tree'
import type { StyleRule, SiteDocument } from '@core/page-tree'

export function getReusableClasses(classes: Record<string, StyleRule>): StyleRule[] {
  return Object.values(classes).filter(isUserVisibleClass)
}

/**
 * Tally how many nodes reference each class, in a SINGLE pass over the whole
 * site tree. Returns a `Map<classId, count>`; classes with zero references are
 * simply absent (callers default to 0).
 *
 * This replaces a per-selector scan: counting one selector at a time was
 * O(selectors × pages × nodes), which made the Selectors panel janky to open
 * with hundreds of generated utility classes. One pass is O(pages × nodes)
 * regardless of how many selectors exist, and the React Compiler memoizes the
 * result against `site` so it only recomputes when the tree changes.
 */
export function buildSelectorUsageMap(site: SiteDocument | null): Map<string, number> {
  const usage = new Map<string, number>()
  if (!site) return usage

  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      const classIds = node.classIds
      if (!classIds) continue
      for (const classId of classIds) {
        usage.set(classId, (usage.get(classId) ?? 0) + 1)
      }
    }
  }
  return usage
}

export function formatSelectorUsage(count: number): string {
  if (count === 0) return 'Unused'
  return count === 1 ? 'Used 1 time' : `Used ${count} times`
}

/**
 * Normalise a raw search query so the prop-aware matcher can compare it against
 * the tokens built from each rule. Lower-cases, trims, and collapses whitespace
 * around a colon so a user can type `font-size: 10px` (with or without the
 * space) and still match the `font-size:10px` token form. Also collapses runs
 * of internal whitespace to a single space.
 */
export function normalizeSelectorQuery(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/\s*:\s*/g, ':')
    .replace(/\s+/g, ' ')
}

/**
 * Does this rule match the (already-normalised) query? Matches against BOTH the
 * selector name AND its declared CSS — every property name (`font-size`) and
 * `name:value` pair (`font-size:10px`), across base styles and every editing
 * context (breakpoints + custom conditions). This lets the Selectors panel
 * answer questions like "show me everything that sets `font-size`" or
 * "…that sets `font-size: 10px`", not just name lookups.
 */
export function selectorMatchesQuery(cls: StyleRule, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  if (cls.name.toLowerCase().includes(normalizedQuery)) return true
  if (styleRuleSelector(cls).toLowerCase().includes(normalizedQuery)) return true
  return buildSelectorSearchTokens(cls).some((token) => token.includes(normalizedQuery))
}

/**
 * Flatten a rule's CSS into searchable, normalised tokens: for every non-empty
 * declaration we emit the kebab-cased property name and a `name:value` pair, in
 * the same normalised form as {@link normalizeSelectorQuery}. Context overrides
 * (breakpoints + conditions) contribute their declarations too.
 */
function buildSelectorSearchTokens(cls: StyleRule): string[] {
  const tokens: string[] = []
  const collect = (styles: Record<string, unknown> | undefined) => {
    if (!styles) return
    for (const [key, value] of Object.entries(styles)) {
      if (!hasStyleValue(value)) continue
      const name = cssPropToKebab(key)
      tokens.push(name)
      tokens.push(`${name}:${String(value).toLowerCase().trim()}`)
    }
  }
  collect(cls.styles)
  for (const contextStyles of Object.values(cls.contextStyles ?? {})) {
    collect(contextStyles)
  }
  return tokens
}

/**
 * Convert a JS-style CSS property key (`fontSize`, `backgroundColor`) to its
 * authored kebab-case form (`font-size`, `background-color`) so search matches
 * what the user sees in CSS. Custom properties (`--foo`) and already-kebab keys
 * pass through unchanged.
 */
function cssPropToKebab(key: string): string {
  if (key.startsWith('--')) return key.toLowerCase()
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`).toLowerCase()
}

export function getSelectorStyleSummary(cls: StyleRule): string {
  const propCount = Object.values(cls.styles).filter(hasStyleValue).length
  // contextStyles holds both viewport-context and custom-condition overrides
  // (the unified editing-context axis); count non-empty contexts.
  const contextCount = Object.values(cls.contextStyles ?? {}).filter((styles) =>
    Object.values(styles).some(hasStyleValue),
  ).length

  if (propCount === 0 && contextCount === 0) return 'No styles'
  if (contextCount === 0) return propCount === 1 ? '1 prop' : `${propCount} props`
  const propsLabel = propCount === 1 ? '1 prop' : `${propCount} props`
  const ctxLabel = contextCount === 1 ? '1 context' : `${contextCount} contexts`
  return `${propsLabel} · ${ctxLabel}`
}

function hasStyleValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}
