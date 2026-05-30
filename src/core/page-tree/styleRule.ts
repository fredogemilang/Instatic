/**
 * StyleRule — a named CSS style rule that emits one rule into the stylesheet.
 *
 * A `StyleRule` can be any CSS rule, discriminated by `kind`:
 *
 *   - `kind: 'class'` — the rule's selector is `.<name>`. It is attached to
 *     nodes via `node.classIds`; the publisher emits the name into the node's
 *     class attribute and the rule into the stylesheet. This is what the
 *     editor's ClassPicker manipulates.
 *
 *   - `kind: 'ambient'` — the rule attaches by CSS matching, not by node
 *     assignment (e.g. `h1`, `h1 > span`, `.hero .title`, `a:hover`). The
 *     publisher emits the rule into the stylesheet only; nothing changes on
 *     node `class=` attributes. Used by the CSS importer and "Add ambient
 *     selector" affordance.
 *
 * §4.1 persistence note: `styles` and `breakpointStyles` are stored as
 * `Record<string, unknown>` matching `validate.ts` line 822 which stores the
 * raw object without narrowing to CSSPropertyBag. Narrowing happens at the
 * publisher boundary (`bagToCSS` in `classCss.ts`).
 *
 * CSSPropertyBag is used for the WRITE API (classSlice / framework
 * generators) which always writes only known CSS property keys.
 *
 * For tolerant parsing of persisted style rules (with per-entry fallbacks),
 * use `parseStyleRule` instead of `parseValue(StyleRuleSchema, raw)`.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, Value, type Static, withFallback } from '@core/utils/typeboxHelpers'
import { GeneratedClassMetadataSchema } from '@core/framework/schemas'
import {
  asPlainObject,
  parseBreakpointStylesBag,
  parseStringArrayField,
  parseStylesBag,
  parseTimestamp,
} from './parseHelpers'
import { escapeCssIdentifier as escapeCssIdent } from './cssIdentifier'

// ---------------------------------------------------------------------------
// Conditional style layers — arbitrary @media / @container / @supports
// ---------------------------------------------------------------------------

/**
 * The condition a conditional style layer applies under. Discriminated by
 * `kind`:
 *   - `breakpoint`: references a site width breakpoint by id (publisher emits
 *     `@media (max-width: N)`). NOTE: today's breakpoint variation lives in
 *     `breakpointStyles`, not here — this kind exists so a future migration
 *     could unify them without a schema change.
 *   - `media`:     any media query, stored verbatim (`(max-width: 860px)`,
 *                  `(orientation: landscape)`, `print`). Emits `@media <query>`.
 *   - `container`: a container query with an optional container name.
 *                  Emits `@container [name] (<query>)`.
 *   - `supports`:  a feature query. Emits `@supports (<query>)`.
 */
export const StyleConditionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('breakpoint'), breakpointId: Type.String() }),
  Type.Object({ kind: Type.Literal('media'), query: Type.String() }),
  Type.Object({
    kind: Type.Literal('container'),
    query: Type.String(),
    name: Type.Optional(Type.String()),
  }),
  Type.Object({ kind: Type.Literal('supports'), query: Type.String() }),
])
export type StyleCondition = Static<typeof StyleConditionSchema>

export const ConditionalStyleLayerSchema = Type.Object({
  /** Stable id — keys the editor tab and survives diffing / reordering. */
  id: Type.String(),
  condition: StyleConditionSchema,
  /** Declarations for this condition — same persistence shape as `styles`. */
  styles: withFallback(Type.Record(Type.String(), Type.Unknown()), {} as Record<string, unknown>),
  /** Cascade position among a rule's conditional layers (ascending). */
  order: withFallback(Type.Number(), 0),
})
export type ConditionalStyleLayer = Static<typeof ConditionalStyleLayerSchema>

// ---------------------------------------------------------------------------
// StyleRuleSchema
// ---------------------------------------------------------------------------

export const StyleRuleKindSchema = Type.Union([Type.Literal('class'), Type.Literal('ambient')])
export type StyleRuleKind = Static<typeof StyleRuleKindSchema>

export const StyleRuleSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /**
   * Discriminator. Old persisted shells written before this field existed
   * default to `'class'` in `parseStyleRule`.
   */
  kind: withFallback(StyleRuleKindSchema, 'class' as StyleRuleKind),
  /**
   * The CSS selector expression emitted verbatim into the published
   * stylesheet:
   *   - kind:'class'   → `.<escaped-name>` (always derived from `name`; not
   *                      user-edited; kept on the object so the publisher and
   *                      canvas can call `styleRuleSelector(rule)` uniformly).
   *   - kind:'ambient' → any valid selector (`h1`, `h1 > span`, `.hero .title`,
   *                      `a:hover`, `[data-x="y"]`, ...).
   *
   * Old shells without this field have it backfilled in `parseStyleRule` from
   * `.${escapeCssIdentifier(name)}`.
   */
  selector: withFallback(Type.String(), ''),
  /**
   * Cascade order — emitted rules are sorted ascending by `order`. Imported
   * rules preserve their position in the source stylesheet so author intent
   * survives. User-created rules append at the end. Defaults to 0 (treated as
   * "insertion order" by stable sort).
   */
  order: withFallback(Type.Number(), 0),
  description: Type.Optional(Type.String()),
  /**
   * Optional ownership scope. If the scope object does not match the exact
   * shape, it is silently dropped — handled in parseStyleRule.
   */
  scope: Type.Optional(Type.Object({
    type: Type.Literal('node'),
    nodeId: Type.String(),
    role: Type.Literal('module-style'),
  })),
  /**
   * Base CSS styles — arbitrary string→unknown map at persistence boundary.
   * Falls back to {} when missing or invalid — handled in parseStyleRule.
   */
  styles: withFallback(Type.Record(Type.String(), Type.Unknown()), {} as Record<string, unknown>),
  /**
   * Per-breakpoint overrides — same persistence semantics as `styles`.
   * Falls back to {} when missing or invalid — handled in parseStyleRule.
   */
  breakpointStyles: withFallback(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
    {} as Record<string, Record<string, unknown>>,
  ),
  /**
   * Arbitrary conditional style layers (CSS fidelity plan — Part 2a).
   *
   * `breakpointStyles` above is the first-class WIDTH-breakpoint model (driven
   * by the responsive toolbar). `conditionalLayers` is the escape hatch for
   * everything else: a custom `@media` query that doesn't match a breakpoint,
   * a `@container` query, or an `@supports` condition. Each layer wraps a bag
   * of declarations under one condition; the publisher emits
   * `@<kind> <query> { <selector> { … } }`.
   *
   * Optional + tolerant: legacy shells without it parse to `[]`.
   */
  conditionalLayers: Type.Optional(Type.Array(ConditionalStyleLayerSchema)),
  /** Optional search/filter tags. Invalid items silently dropped — handled in parseStyleRule. */
  tags: Type.Optional(Type.Array(Type.String())),
  /** Metadata for framework-generated classes. Undefined if invalid — handled in parseStyleRule. */
  generated: Type.Optional(GeneratedClassMetadataSchema),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
})

export type StyleRule = Static<typeof StyleRuleSchema>

/**
 * Build the canonical `.<escaped-name>` selector for a class-kind rule.
 * Used during creation and when backfilling missing `selector` on old data.
 */
export function classKindSelector(name: string): string {
  return `.${escapeCssIdent(name)}`
}

// ---------------------------------------------------------------------------
// Tolerant parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single conditional style layer, dropping it (return null) when the
 * shape is unusable (missing id or an unrecognised condition). Tolerant of a
 * missing `styles` / `order` (filled with defaults).
 */
function parseConditionalLayer(raw: unknown): ConditionalStyleLayer | null {
  const r = asPlainObject(raw)
  if (!r) return null
  if (typeof r.id !== 'string') return null

  const c = asPlainObject(r.condition)
  if (!c) return null
  let condition: StyleCondition | null = null
  if (c.kind === 'breakpoint' && typeof c.breakpointId === 'string') {
    condition = { kind: 'breakpoint', breakpointId: c.breakpointId }
  } else if (c.kind === 'media' && typeof c.query === 'string') {
    condition = { kind: 'media', query: c.query }
  } else if (c.kind === 'container' && typeof c.query === 'string') {
    condition = {
      kind: 'container',
      query: c.query,
      ...(typeof c.name === 'string' ? { name: c.name } : {}),
    }
  } else if (c.kind === 'supports' && typeof c.query === 'string') {
    condition = { kind: 'supports', query: c.query }
  }
  if (!condition) return null

  return {
    id: r.id,
    condition,
    styles: parseStylesBag(r.styles),
    order: typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 0,
  }
}

/** Parse the optional conditionalLayers array, dropping invalid entries. */
function parseConditionalLayers(raw: unknown): ConditionalStyleLayer[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const layers: ConditionalStyleLayer[] = []
  for (const entry of raw) {
    const parsed = parseConditionalLayer(entry)
    if (parsed) layers.push(parsed)
  }
  return layers.length > 0 ? layers : undefined
}

/** Parse a StyleRule scope (currently only `{ type: 'node', nodeId, role: 'module-style' }`). */
function parseStyleRuleScope(raw: unknown): StyleRule['scope'] {
  const s = asPlainObject(raw)
  if (!s) return undefined
  if (s.type !== 'node' || typeof s.nodeId !== 'string' || s.role !== 'module-style') return undefined
  return { type: 'node', nodeId: s.nodeId, role: 'module-style' }
}

/**
 * Parse a StyleRule, providing fallbacks for resilient fields.
 *
 * Backfills for the selectors-system fields on legacy shells that predate them:
 *   - kind:      defaults to 'class' (the only kind that existed before).
 *   - selector:  defaults to the canonical `.<escaped-name>` for kind 'class'.
 *                For kind 'ambient' a missing selector falls back to the name
 *                verbatim (the importer always writes selector explicitly).
 *   - order:     defaults to 0 (stable-sort preserves insertion order).
 */
export function parseStyleRule(raw: unknown): StyleRule | null {
  const r = asPlainObject(raw)
  if (!r) return null
  if (typeof r.id !== 'string') return null
  if (typeof r.name !== 'string') return null

  const scope = parseStyleRuleScope(r.scope)
  const tags = parseStringArrayField(r.tags)
  const conditionalLayers = parseConditionalLayers(r.conditionalLayers)
  const generated = Value.Check(GeneratedClassMetadataSchema, r.generated)
    ? (r.generated as StyleRule['generated'])
    : undefined

  const kind: StyleRuleKind = r.kind === 'ambient' ? 'ambient' : 'class'
  const rawSelector = typeof r.selector === 'string' ? r.selector : ''
  const selector = rawSelector.length > 0
    ? rawSelector
    : (kind === 'class' ? classKindSelector(r.name) : r.name)
  const order = typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : 0

  return {
    id: r.id,
    name: r.name,
    kind,
    selector,
    order,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(scope !== undefined ? { scope } : {}),
    styles: parseStylesBag(r.styles),
    breakpointStyles: parseBreakpointStylesBag(r.breakpointStyles),
    ...(conditionalLayers !== undefined ? { conditionalLayers } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(generated !== undefined ? { generated } : {}),
    createdAt: parseTimestamp(r.createdAt),
    updatedAt: parseTimestamp(r.updatedAt),
  }
}

/** Parse the style rule registry: iterate entries and silently drop those with invalid id/name. */
export function parseStyleRuleRegistry(raw: unknown): Record<string, StyleRule> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, StyleRule> = {}
  for (const [id, rule] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseStyleRule(rule)
    if (parsed) result[id] = parsed
  }
  return result
}
