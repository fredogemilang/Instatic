/**
 * scopeClasses — per-page class scoping for multi-stylesheet imports.
 *
 * ## The problem
 *
 * A multi-page site export ships one stylesheet per page, and those stylesheets
 * routinely reuse the SAME class name with DIFFERENT declarations — e.g.
 * `index.html`'s `instatic.css` defines `.btn { border-radius: 0 }` while
 * `original.html`'s `style.css` defines `.btn { border-radius: 999px }`.
 *
 * The CMS has ONE global class registry. Naively merging every stylesheet's
 * classes by name means one page's `.btn` silently overwrites the other's, so
 * the loser renders with the wrong styles. This is exactly the bug that made
 * imported buttons round + lose their uppercase and the hero collapse.
 *
 * ## The fix — scope colliding classes per page cascade
 *
 * For each class NAME, we compose the ordered CSS files linked by a page into
 * one effective cascade definition (base `styles` + `contextStyles`):
 *   - one distinct definition  → keep the bare name; the class is shared.
 *   - N distinct definitions   → the first keeps the bare name, the rest get a
 *     numeric suffix (`btn`, `btn-2`, `btn-3`). Page cascades that share a
 *     definition share its scoped name.
 *
 * A rename is then applied CONSISTENTLY within each page cascade:
 *   1. each page gets a generated body class for its CSS cascade,
 *   2. ambient selectors are prefixed under that body class so global resets
 *      from one imported page cannot override another imported page,
 *   3. the first `kind:'class'` rule for the final class name remains bindable,
 *   4. later class-rule fragments for the same final name become ambient
 *      selectors so the CSS cascade still emits in source order,
 *   5. every `kind:'ambient'` selector in that cascade that references the
 *      class as a token (`.btn-solid:hover`, `.btn.btn-lg`, `.plan-cta .btn`)
 *      follows the rename, and
 *   6. the `classIds` (class-name tokens) on the nodes of every page in that
 *      cascade follow the same final name.
 *
 * The result: every page renders with exactly the class definitions from its
 * own stylesheet, and pages whose definitions are identical still share one
 * class — no needless duplication.
 *
 * ## Limitation
 *
 * Pure element / attribute selectors (`body`, `h1`, `a:hover`) carry no class
 * token, so class-token renaming cannot help them. The generated body scope
 * handles these imported ambient selectors instead (`h1` →
 * `body.instatic-import-scope-* h1`, `body` → `body.instatic-import-scope-*`).
 *
 * Bootstrap-like scaffold / utility names (`row`, `col-xl-3`, `d-flex`,
 * `align-items-stretch`, …) are the exception. Their behaviour is intentionally
 * assembled from many small rules and combinators (`.row`, `.row > *`,
 * `.col-*`) across one or more stylesheets. Splitting those names by content
 * makes the HTML point at one fragment while the layout declarations land on
 * another. Those shared utility names stay global.
 */

import { classKindSelector } from '@core/page-tree'
import type { PagePlan, NewStyleRule } from './types'
import type { CssFileResult } from './assetPlan'

export interface ScopeClassesResult {
  pagePlans: PagePlan[]
  cssFileResults: CssFileResult[]
  /** Class names that were scoped (renamed) to preserve per-page fidelity. */
  renames: Array<{ originalName: string; scopedName: string; cssPath: string }>
}

interface CascadeGroup {
  key: string
  linkedCssPaths: string[]
  pageIndexes: number[]
  sortIndex: number
  firstPageIndex: number
}

interface ClassCascade {
  styles: Record<string, unknown>
  contextStyles: Record<string, Record<string, unknown>>
  count: number
}

const BOOTSTRAP_BREAKPOINT_RE = '(?:sm|md|lg|xl|xxl)'
const BOOTSTRAP_SIZE_RE = '(?:0|1|2|3|4|5|auto)'
const BOOTSTRAP_GRID_SPAN_RE = '(?:auto|[1-9]|1[0-2])'
const BOOTSTRAP_SIDE_RE = '(?:t|b|s|e|x|y)'

const SHARED_UTILITY_CLASS_PATTERNS = [
  /^container(?:-(?:sm|md|lg|xl|xxl|fluid))?$/,
  /^row(?:-cols(?:-(?:sm|md|lg|xl|xxl))?-(?:auto|[1-6]))?$/,
  new RegExp(`^col(?:-${BOOTSTRAP_GRID_SPAN_RE}|-${BOOTSTRAP_BREAKPOINT_RE}(?:-${BOOTSTRAP_GRID_SPAN_RE})?)?$`),
  new RegExp(`^offset(?:-${BOOTSTRAP_BREAKPOINT_RE})?-(?:[0-9]|1[0-1])$`),
  new RegExp(`^order(?:-${BOOTSTRAP_BREAKPOINT_RE})?-(?:first|last|[0-5])$`),
  new RegExp(`^(?:g|gx|gy)(?:-${BOOTSTRAP_BREAKPOINT_RE})?-${BOOTSTRAP_SIZE_RE}$`),
  new RegExp(`^(?:m|p)${BOOTSTRAP_SIDE_RE}?(?:-${BOOTSTRAP_BREAKPOINT_RE})?-${BOOTSTRAP_SIZE_RE}$`),
  new RegExp('^d(?:-(?:sm|md|lg|xl|xxl))?-(?:none|inline|inline-block|block|grid|table|table-row|table-cell|flex|inline-flex)$'),
  new RegExp('^flex(?:-(?:sm|md|lg|xl|xxl))?-(?:row|column|row-reverse|column-reverse|wrap|nowrap|wrap-reverse|fill|grow-0|grow-1|shrink-0|shrink-1)$'),
  new RegExp('^justify-content(?:-(?:sm|md|lg|xl|xxl))?-(?:start|end|center|between|around|evenly)$'),
  new RegExp('^align-(?:items|content|self)(?:-(?:sm|md|lg|xl|xxl))?-(?:start|end|center|baseline|stretch)$'),
  /^position-(?:static|relative|absolute|fixed|sticky)$/,
  /^(?:top|bottom|start|end)-(?:0|50|100)$/,
  /^translate-middle(?:-[xy])?$/,
  /^[wh]-(?:25|50|75|100|auto)$/,
  /^mw-100$/,
  /^mh-100$/,
  /^min-vw-100$/,
  /^min-vh-100$/,
  /^vw-100$/,
  /^vh-100$/,
]

/**
 * Class names from Bootstrap's shared layout / utility vocabulary must remain
 * global. They are not component classes: their intended behaviour often spans
 * multiple rules and selectors, so per-stylesheet scoping can split a single
 * grid contract into unrelated names (`row-3`, `row-4`, …).
 */
export function isSharedUtilityClassName(name: string): boolean {
  return SHARED_UTILITY_CLASS_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Resolve cross-stylesheet class-name collisions by scoping divergent
 * definitions per page stylesheet cascade. Pure: returns new arrays, never
 * mutates the inputs.
 */
export function scopeCollidingClasses(
  pagePlans: PagePlan[],
  cssFileResults: CssFileResult[],
): ScopeClassesResult {
  const cssFileByPath = new Map<string, CssFileResult>()
  const cssPathOrder = new Map<string, number>()
  const fileClassNames = new Map<string, Set<string>>()
  const allClassNames = new Set<string>()

  for (const [index, file] of cssFileResults.entries()) {
    if (!cssFileByPath.has(file.cssPath)) cssFileByPath.set(file.cssPath, file)
    if (!cssPathOrder.has(file.cssPath)) cssPathOrder.set(file.cssPath, index)
    const names = new Set<string>()
    for (const rule of file.rules) {
      if (rule.kind !== 'class') continue
      allClassNames.add(rule.name)
      names.add(rule.name)
    }
    fileClassNames.set(file.cssPath, names)
  }

  for (const plan of pagePlans) {
    for (const className of plan.nodeFragment.body?.classIds ?? []) allClassNames.add(className)
    for (const node of Object.values(plan.nodeFragment.nodes)) {
      for (const className of node.classIds ?? []) allClassNames.add(className)
    }
  }

  const cascadeGroups = buildCascadeGroups(pagePlans, cssFileResults, cssPathOrder)
  const scopeClassByGroup = new Map<string, string>()

  // ── 1. Catalogue every class cascade, in first-encounter order ─────────────
  // name → ordered list of { groupKey, contentKey } as page stylesheet cascades
  // are encountered. Each content key represents the effective declaration bag
  // after all linked CSS files for that page have been applied in order.
  const defsByName = new Map<string, Array<{ groupKey: string; contentKey: string }>>()
  const contentKeyByGroup = new Map<string, Map<string, string>>()
  let needsCascadeRewrite = false

  for (const group of cascadeGroups) {
    const cascadesByName = new Map<string, ClassCascade>()
    for (const cssPath of group.linkedCssPaths) {
      const file = cssFileByPath.get(cssPath)
      if (!file) continue
      for (const rule of file.rules) {
        if (rule.kind !== 'class') continue
        const cascade = cascadesByName.get(rule.name) ?? {
          styles: {},
          contextStyles: {},
          count: 0,
        }
        mergeClassRuleIntoCascade(cascade, rule)
        cascadesByName.set(rule.name, cascade)
        if (cascade.count > 1 && !isSharedUtilityClassName(rule.name)) {
          needsCascadeRewrite = true
        }
      }
    }

    const keyByName = new Map<string, string>()
    for (const [name, cascade] of cascadesByName) {
      const key = stableStringify({
        styles: cascade.styles,
        contextStyles: cascade.contextStyles,
      })
      keyByName.set(name, key)
      let list = defsByName.get(name)
      if (!list) {
        list = []
        defsByName.set(name, list)
      }
      list.push({ groupKey: group.key, contentKey: key })
    }
    contentKeyByGroup.set(group.key, keyByName)
  }

  // ── 2. Assign a final name to each distinct page-cascade definition ───────
  // name → (contentKey → finalName). The first distinct definition keeps the
  // bare name; subsequent ones get the next free numeric suffix.
  const usedNames = new Set(allClassNames)
  const finalNameByNameAndKey = new Map<string, Map<string, string>>()

  for (const [name, defs] of defsByName) {
    const keyToFinal = new Map<string, string>()
    if (isSharedUtilityClassName(name)) {
      for (const { contentKey: key } of defs) keyToFinal.set(key, name)
      finalNameByNameAndKey.set(name, keyToFinal)
      continue
    }
    for (const { contentKey: key } of defs) {
      if (keyToFinal.has(key)) continue
      if (keyToFinal.size === 0) {
        keyToFinal.set(key, name) // first distinct def keeps the bare name
      } else {
        keyToFinal.set(key, nextFreeName(name, usedNames))
      }
    }
    finalNameByNameAndKey.set(name, keyToFinal)
  }

  for (const group of cascadeGroups) {
    if (group.pageIndexes.length === 0) continue
    if (!groupNeedsAmbientScope(group, cssFileByPath)) continue
    scopeClassByGroup.set(group.key, scopeClassNameForGroup(group, usedNames))
  }

  // ── 3. Per-cascade map: original class name → final name ──────────────────
  const finalClassByGroup = new Map<string, Map<string, string>>()
  const renames: ScopeClassesResult['renames'] = []

  for (const group of cascadeGroups) {
    const map = new Map<string, string>()
    const keyByName = contentKeyByGroup.get(group.key) ?? new Map()
    for (const [name, key] of keyByName) {
      const final = finalNameByNameAndKey.get(name)?.get(key) ?? name
      map.set(name, final)
      if (final !== name) {
        for (const cssPath of group.linkedCssPaths) {
          if (!fileClassNames.get(cssPath)?.has(name)) continue
          renames.push({ originalName: name, scopedName: final, cssPath })
        }
      }
    }
    finalClassByGroup.set(group.key, map)
  }

  // Fast exit: nothing collided, no page links split fragments for one class
  // across its cascade, and no ambient selectors need page-cascade scoping.
  if (renames.length === 0 && !needsCascadeRewrite && scopeClassByGroup.size === 0) {
    return { pagePlans, cssFileResults, renames }
  }

  // ── 4. Rewrite each page cascade's rules ──────────────────────────────────
  const scopedCssFileResults: CssFileResult[] = []
  for (const group of cascadeGroups) {
    const map = finalClassByGroup.get(group.key) ?? new Map()
    const firstBindableByFinalName = new Set<string>()
    const scopeClassName = scopeClassByGroup.get(group.key)
    let scopeClassRuleInserted = false
    for (const cssPath of group.linkedCssPaths) {
      const file = cssFileByPath.get(cssPath)
      if (!file) continue
      let rules = file.rules.map((rule) => {
        const rewritten = rewriteCascadeRule(rule, map, firstBindableByFinalName)
        return scopeClassName ? scopeAmbientRule(rewritten, scopeClassName) : rewritten
      })
      if (scopeClassName && !scopeClassRuleInserted) {
        rules = [scopeClassRule(scopeClassName), ...rules]
        scopeClassRuleInserted = true
      }
      scopedCssFileResults.push({ ...file, rules })
    }
  }

  // ── 5. Rewrite class-name tokens on every page's nodes ──────────────────────
  const groupKeyByPageIndex = new Map<number, string>()
  for (const group of cascadeGroups) {
    for (const pageIndex of group.pageIndexes) groupKeyByPageIndex.set(pageIndex, group.key)
  }
  const scopedPagePlans: PagePlan[] = pagePlans.map((plan, index) => {
    const groupKey = groupKeyByPageIndex.get(index)
    if (!groupKey) return plan
    const rewritten = rewritePageTokens(plan, finalClassByGroup.get(groupKey) ?? new Map())
    const scopeClassName = scopeClassByGroup.get(groupKey)
    return scopeClassName ? addBodyScopeClass(rewritten, scopeClassName) : rewritten
  })

  return { pagePlans: scopedPagePlans, cssFileResults: scopedCssFileResults, renames }
}

function buildCascadeGroups(
  pagePlans: PagePlan[],
  cssFileResults: CssFileResult[],
  cssPathOrder: Map<string, number>,
): CascadeGroup[] {
  const groupsByKey = new Map<string, CascadeGroup>()
  const referencedCssPaths = new Set<string>()

  for (const [pageIndex, plan] of pagePlans.entries()) {
    if (plan.linkedCssPaths.length === 0) continue
    const key = cascadeKey(plan.linkedCssPaths)
    for (const cssPath of plan.linkedCssPaths) referencedCssPaths.add(cssPath)

    const sortIndex = minCssPathOrder(plan.linkedCssPaths, cssPathOrder)
    const existing = groupsByKey.get(key)
    if (existing) {
      existing.pageIndexes.push(pageIndex)
      existing.firstPageIndex = Math.min(existing.firstPageIndex, pageIndex)
      existing.sortIndex = Math.min(existing.sortIndex, sortIndex)
      continue
    }

    groupsByKey.set(key, {
      key,
      linkedCssPaths: [...plan.linkedCssPaths],
      pageIndexes: [pageIndex],
      sortIndex,
      firstPageIndex: pageIndex,
    })
  }

  // Unit tests and defensive callers may pass cssFileResults that no page links.
  // Keep them in the scoping catalogue in source order so first-definition
  // suffixing remains deterministic.
  for (const [index, file] of cssFileResults.entries()) {
    if (referencedCssPaths.has(file.cssPath)) continue
    const key = cascadeKey([file.cssPath])
    if (groupsByKey.has(key)) continue
    groupsByKey.set(key, {
      key,
      linkedCssPaths: [file.cssPath],
      pageIndexes: [],
      sortIndex: cssPathOrder.get(file.cssPath) ?? index,
      firstPageIndex: Number.POSITIVE_INFINITY,
    })
  }

  return [...groupsByKey.values()].sort((a, b) => {
    if (a.sortIndex !== b.sortIndex) return a.sortIndex - b.sortIndex
    return a.firstPageIndex - b.firstPageIndex
  })
}

function cascadeKey(linkedCssPaths: readonly string[]): string {
  return linkedCssPaths.join('\u0000')
}

function minCssPathOrder(
  linkedCssPaths: readonly string[],
  cssPathOrder: Map<string, number>,
): number {
  let min = Number.POSITIVE_INFINITY
  for (const cssPath of linkedCssPaths) {
    const order = cssPathOrder.get(cssPath)
    if (order !== undefined && order < min) min = order
  }
  return min
}

function mergeClassRuleIntoCascade(cascade: ClassCascade, rule: NewStyleRule): void {
  cascade.count += 1
  Object.assign(cascade.styles, rule.styles ?? {})
  for (const [contextId, bag] of Object.entries(rule.contextStyles ?? {})) {
    cascade.contextStyles[contextId] = {
      ...(cascade.contextStyles[contextId] ?? {}),
      ...bag,
    }
  }
}

function groupNeedsAmbientScope(
  group: CascadeGroup,
  cssFileByPath: Map<string, CssFileResult>,
): boolean {
  const classCounts = new Map<string, number>()
  for (const cssPath of group.linkedCssPaths) {
    const file = cssFileByPath.get(cssPath)
    if (!file) continue
    for (const rule of file.rules) {
      if (isScopeableAmbientRule(rule)) return true
      if (rule.kind !== 'class') continue
      classCounts.set(rule.name, (classCounts.get(rule.name) ?? 0) + 1)
    }
  }

  for (const [name, count] of classCounts) {
    if (count > 1 && !isSharedUtilityClassName(name)) return true
  }
  return false
}

function scopeClassNameForGroup(group: CascadeGroup, usedNames: Set<string>): string {
  const base = `instatic-import-scope-${hashText(group.key)}`
  if (!usedNames.has(base)) {
    usedNames.add(base)
    return base
  }
  return nextFreeName(base, usedNames)
}

function hashText(value: string): string {
  let hash = 5381
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i)
  }
  return (hash >>> 0).toString(36)
}

// ---------------------------------------------------------------------------
// Rule rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite one rule using a file's `original → final` class-name map.
 * - class-kind: rename `name` + `selector` when its final differs.
 * - ambient:    rename every class token in the selector that the file renamed;
 *   the display `name` (which defaults to the selector text) follows.
 */
function rewriteRule(rule: NewStyleRule, map: Map<string, string>): NewStyleRule {
  if (rule.kind === 'class') {
    const final = map.get(rule.name)
    if (!final || final === rule.name) return rule
    return { ...rule, name: final, selector: classKindSelector(final) }
  }
  // ambient — rewrite class tokens referenced in the selector.
  const newSelector = rewriteSelectorClasses(rule.selector, map)
  if (newSelector === rule.selector) return rule
  // Ambient display names default to the selector text; keep them in sync when
  // the original name WAS the selector (the importer's default).
  const newName = rule.name === rule.selector ? newSelector : rule.name
  return { ...rule, selector: newSelector, name: newName }
}

function rewriteCascadeRule(
  rule: NewStyleRule,
  map: Map<string, string>,
  firstBindableByFinalName: Set<string>,
): NewStyleRule {
  const rewritten = rewriteRule(rule, map)
  if (rewritten.kind !== 'class') return rewritten

  if (!firstBindableByFinalName.has(rewritten.name)) {
    firstBindableByFinalName.add(rewritten.name)
    return rewritten
  }

  return {
    ...rewritten,
    kind: 'ambient',
    name: rewritten.selector,
  }
}

function scopeClassRule(name: string): NewStyleRule {
  return {
    kind: 'class',
    name,
    selector: classKindSelector(name),
    order: 0,
    styles: {},
    contextStyles: {},
    tags: ['instatic-import-scope'],
  }
}

function isScopeableAmbientRule(rule: NewStyleRule): boolean {
  if (rule.kind !== 'ambient') return false
  if (typeof rule.rawCss === 'string') return false
  return !rule.selector.trimStart().startsWith('@')
}

function scopeAmbientRule(rule: NewStyleRule, scopeClassName: string): NewStyleRule {
  if (!isScopeableAmbientRule(rule)) return rule

  const selector = scopeSelectorList(rule.selector, scopeClassName)
  if (selector === rule.selector) return rule
  return {
    ...rule,
    selector,
    name: rule.name === rule.selector ? selector : rule.name,
  }
}

/** A class token in a selector: a `.` followed by a CSS identifier. */
const SELECTOR_CLASS_TOKEN_RE = /\.(-?[A-Za-z_][\w-]*)/g

/**
 * Replace every `.token` in a selector whose `token` the file renamed.
 * Leaves untouched: class tokens the file didn't rename, element names,
 * pseudo-classes/elements, attribute selectors, combinators.
 */
function rewriteSelectorClasses(selector: string, map: Map<string, string>): string {
  return selector.replace(SELECTOR_CLASS_TOKEN_RE, (whole, token: string) => {
    const final = map.get(token)
    return final && final !== token ? `.${final}` : whole
  })
}

function scopeSelectorList(selector: string, scopeClassName: string): string {
  return splitSelectorList(selector)
    .map((part) => scopeSingleSelector(part, scopeClassName))
    .join(', ')
}

function scopeSingleSelector(selector: string, scopeClassName: string): string {
  const trimmed = selector.trim()
  if (trimmed.length === 0) return selector
  const scopeSelector = `body${classKindSelector(scopeClassName)}`

  if (/^body(?=$|[.#:[\s>+~])/.test(trimmed)) {
    return trimmed.replace(/^body/, scopeSelector)
  }

  if (/^(?:html|:root)(?=$|[.#:[\s>+~])/.test(trimmed)) {
    const withoutRoot = trimmed.replace(/^(?:html|:root)\s*/, '').trim()
    if (withoutRoot.length === 0) return scopeSelector
    if (/^body(?=$|[.#:[\s>+~])/.test(withoutRoot)) {
      return withoutRoot.replace(/^body/, scopeSelector)
    }
    return `${scopeSelector} ${withoutRoot}`
  }

  return `${scopeSelector} ${trimmed}`
}

function splitSelectorList(selector: string): string[] {
  const parts: string[] = []
  let start = 0
  let parenDepth = 0
  let bracketDepth = 0
  let quote: '"' | "'" | null = null

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (quote) {
      if (ch === '\\') {
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(') {
      parenDepth += 1
      continue
    }
    if (ch === ')' && parenDepth > 0) {
      parenDepth -= 1
      continue
    }
    if (ch === '[') {
      bracketDepth += 1
      continue
    }
    if (ch === ']' && bracketDepth > 0) {
      bracketDepth -= 1
      continue
    }
    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      parts.push(selector.slice(start, i))
      start = i + 1
    }
  }
  parts.push(selector.slice(start))
  return parts
}

// ---------------------------------------------------------------------------
// Page-token rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite the class-name tokens on every node of a page using that page
 * cascade's final class-name map.
 */
function rewritePageTokens(plan: PagePlan, classFinal: Map<string, string>): PagePlan {
  // Resolve a token to its scoped name for this page (or itself if unscoped).
  const resolve = (token: string): string => classFinal.get(token) ?? token

  let touched = false
  const nodes: typeof plan.nodeFragment.nodes = {}
  for (const [id, node] of Object.entries(plan.nodeFragment.nodes)) {
    const classIds = node.classIds
    if (!classIds || classIds.length === 0) {
      nodes[id] = node
      continue
    }
    const rewritten = dedupe(classIds.map(resolve))
    if (sameOrder(rewritten, classIds)) {
      nodes[id] = node
      continue
    }
    touched = true
    nodes[id] = { ...node, classIds: rewritten }
  }

  const bodyClassIds = plan.nodeFragment.body?.classIds
  let body = plan.nodeFragment.body
  if (bodyClassIds?.length) {
    const rewritten = dedupe(bodyClassIds.map(resolve))
    if (!sameOrder(rewritten, bodyClassIds)) {
      touched = true
      body = { ...body, classIds: rewritten }
    }
  }

  if (!touched) return plan
  return { ...plan, nodeFragment: { ...plan.nodeFragment, nodes, ...(body ? { body } : {}) } }
}

function addBodyScopeClass(plan: PagePlan, scopeClassName: string): PagePlan {
  const body = plan.nodeFragment.body ?? {}
  const classIds = body.classIds ?? []
  if (classIds.includes(scopeClassName)) return plan
  return {
    ...plan,
    nodeFragment: {
      ...plan.nodeFragment,
      body: {
        ...body,
        classIds: [...classIds, scopeClassName],
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic JSON with sorted object keys (arrays keep their order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/** First `name-2`, `name-3`, … not already taken; reserves the result. */
function nextFreeName(name: string, used: Set<string>): string {
  let n = 2
  let candidate = `${name}-${n}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${name}-${n}`
  }
  used.add(candidate)
  return candidate
}

/** Remove duplicate strings, preserving first-seen order. */
function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** Whether two string arrays are identical in length and order. */
function sameOrder(a: string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
