/**
 * Visual Components — TypeBox schemas and derived types.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof Schema>`.
 * No parallel TypeScript interfaces — schema definitions ARE the contract.
 *
 * Architecture source: Contribution #619 §2
 * Constraint #269: This file must NOT import from editor/ or editor-store/.
 */

import { Type, type Static, withFallback } from '@core/utils/typeboxHelpers'
import { BaseNodeSchema, parsePropBindings } from '@core/page-tree/baseNode'

// ---------------------------------------------------------------------------
// VCParamType — valid param type values
// ---------------------------------------------------------------------------

export const VCParamTypeSchema = Type.Union([
  Type.Literal('string'),
  Type.Literal('number'),
  Type.Literal('boolean'),
  Type.Literal('url'),
  Type.Literal('enum'),
  Type.Literal('color'),
  Type.Literal('image'),
  Type.Literal('richText'),
  Type.Literal('slot'),
])

export type VCParamType = Static<typeof VCParamTypeSchema>

const VC_PARAM_TYPE_VALUES: VCParamType[] = [
  'string', 'number', 'boolean', 'url', 'enum', 'color', 'image', 'richText', 'slot',
]

// ---------------------------------------------------------------------------
// VCNode — a node inside a Visual Component tree (parallel to PageNode)
//
// VCNode uses a nested structure (childNodes) rather than the flat-map structure
// of Page.nodes — tree traversal is simpler for VC authoring.
//
// VCNodeSchema extends BaseNodeSchema with a recursive childNodes field via
// Type.Recursive. Unlike PageNode, VCNode carries no `dynamicBindings` — that
// field is exclusive to CMS template pages.
// ---------------------------------------------------------------------------

/**
 * A node inside a Visual Component tree.
 *
 * Defined as BaseNode (shared with PageNode) with a self-referential
 * `childNodes` for nested tree traversal. Unlike `PageNode`, `VCNode` carries
 * no `dynamicBindings` — that field is exclusive to CMS template pages.
 *
 * All props are flat (no dot-path keys) — same invariant as PageNode.
 */
export const VCNodeSchema = Type.Recursive((Self) =>
  Type.Object({
    ...BaseNodeSchema.properties,
    childNodes: Type.Optional(Type.Array(Self)),
  }),
)

export type VCNode = Static<typeof VCNodeSchema>

// ---------------------------------------------------------------------------
// VCParam — a named parameter on a Visual Component
// ---------------------------------------------------------------------------

export const VCParamSchema = Type.Object({
  /** Stable ID — generated with nanoid(); survives param renames */
  id: Type.String(),
  /** Free-form name; uniqueness within the VC is validated at the slice boundary */
  name: Type.String(),
  /** Param type — unknown values fall back to 'string' in the parser helper */
  type: withFallback(VCParamTypeSchema, 'string' as const),
  /** Optional human-readable description shown in the Properties Panel */
  description: Type.Optional(Type.String()),
  defaultValue: Type.Unknown(),
  required: Type.Boolean(),
  /** Only meaningful when type === 'enum' — non-string items are silently dropped */
  enumOptions: Type.Optional(Type.Array(Type.String())),
})

export type VCParam = Static<typeof VCParamSchema>

/**
 * Tolerant parser for a single VCParam. Handles:
 *   - type fallback to 'string' for unknown values
 *   - enumOptions preprocessing: filter to strings only, absent → undefined
 *   - required fallback to false
 *   - defaultValue fallback to ''
 * Returns null for structurally invalid entries (missing id or name).
 */
export function parseVCParam(raw: unknown): VCParam | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.name !== 'string') return null

  const type: VCParamType = VC_PARAM_TYPE_VALUES.includes(r.type as VCParamType)
    ? (r.type as VCParamType)
    : 'string'

  const enumOptions = Array.isArray(r.enumOptions)
    ? r.enumOptions.filter((x): x is string => typeof x === 'string')
    : undefined

  return {
    id: r.id,
    name: r.name,
    type,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    defaultValue: r.defaultValue !== undefined ? r.defaultValue : '',
    required: typeof r.required === 'boolean' ? r.required : false,
    ...(enumOptions !== undefined ? { enumOptions } : {}),
  }
}

// ---------------------------------------------------------------------------
// VCBreakpoint — lightweight breakpoint descriptor stored per-VC
// ---------------------------------------------------------------------------

const VCBreakpointSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String(),
  width: Type.Number(),
  icon: Type.String(),
})

type VCBreakpoint = Static<typeof VCBreakpointSchema>

/**
 * Tolerant parser for a single VCBreakpoint. Entries with empty/missing id are
 * dropped. Other fields fall back to their defaults (mirrors the original
 * Zod .default() behaviour for label, width, icon).
 */
function parseVCBreakpoint(raw: unknown): VCBreakpoint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  return {
    id: r.id,
    label: typeof r.label === 'string' ? r.label : '',
    width: typeof r.width === 'number' ? r.width : 0,
    icon: typeof r.icon === 'string' ? r.icon : 'monitor',
  }
}

// ---------------------------------------------------------------------------
// parseVCNode — tolerant recursive VCNode parser
//
// Replicates the Zod .catch() fallback behaviour for fields that use
// withFallback() in BaseNodeSchema (props, breakpointOverrides, classIds).
// Required by parseVisualComponent to handle persisted data where child nodes
// may have been stored without classIds or other optional-with-fallback fields.
// ---------------------------------------------------------------------------

/**
 * Tolerant parser for a single VCNode (used by parseVisualComponent).
 *
 * Unlike `Value.Check(VCNodeSchema, raw)`, this function handles:
 *   - Missing classIds → default []
 *   - Missing/invalid props → default {}
 *   - Missing/invalid breakpointOverrides → default {}
 *   - childNodes: recursively parsed, invalid children silently dropped
 *   - propBindings: per-entry filtered via parsePropBindings
 *
 * Returns null when required fields (id, moduleId, children) are invalid.
 */
function parseVCNode(raw: unknown): VCNode | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.moduleId !== 'string') return null
  if (!Array.isArray(r.children)) return null

  const props: Record<string, unknown> =
    r.props && typeof r.props === 'object' && !Array.isArray(r.props)
      ? (r.props as Record<string, unknown>)
      : {}

  const breakpointOverrides: Record<string, Record<string, unknown>> =
    r.breakpointOverrides && typeof r.breakpointOverrides === 'object' && !Array.isArray(r.breakpointOverrides)
      ? (r.breakpointOverrides as Record<string, Record<string, unknown>>)
      : {}

  const children = r.children.filter((c): c is string => typeof c === 'string')

  const classIds = Array.isArray(r.classIds)
    ? r.classIds.filter((c): c is string => typeof c === 'string')
    : []

  const propBindings = parsePropBindings(r.propBindings)

  const childNodes: VCNode[] = Array.isArray(r.childNodes)
    ? r.childNodes.flatMap((child) => {
        const node = parseVCNode(child)
        return node ? [node] : []
      })
    : []

  return {
    id: r.id,
    moduleId: r.moduleId,
    props,
    breakpointOverrides,
    children,
    classIds,
    ...(typeof r.label === 'string' ? { label: r.label } : {}),
    ...(typeof r.locked === 'boolean' ? { locked: r.locked } : {}),
    ...(typeof r.hidden === 'boolean' ? { hidden: r.hidden } : {}),
    ...(propBindings !== undefined ? { propBindings } : {}),
    ...(childNodes.length > 0 ? { childNodes } : {}),
  }
}

// ---------------------------------------------------------------------------
// VisualComponent — top-level VC document
// ---------------------------------------------------------------------------

/**
 * TypeBox schema for a VisualComponent stored in SiteDocument.visualComponents[].
 *
 * For tolerant parsing (silently dropping invalid params/breakpoints and
 * providing timestamp fallbacks), use `parseVisualComponent` instead of
 * `parseValue(VisualComponentSchema, raw)`.
 *
 * Naming invariants (enforced by validateComponentName at write boundaries):
 *   - Non-empty (whitespace-only is rejected; trimmed before storage)
 *   - Unique within the site
 */
export const VisualComponentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  rootNode: VCNodeSchema,
  params: Type.Array(VCParamSchema),
  breakpoints: Type.Array(VCBreakpointSchema),
  classIds: Type.Array(Type.String()),
  /** Falls back to Date.now() for missing or non-numeric values — handled by parser */
  createdAt: Type.Number(),
})

export type VisualComponent = Static<typeof VisualComponentSchema>

/**
 * Tolerant parser for a VisualComponent. Handles:
 *   - rootNode: parsed via parseVCNode (tolerant, handles missing classIds etc.)
 *   - params: silently drops items that fail parseVCParam
 *   - breakpoints: silently drops items with empty id
 *   - createdAt: falls back to Date.now() for missing/invalid timestamps
 *
 * Returns null when required fields (id, name, rootNode) are invalid.
 */
export function parseVisualComponent(raw: unknown): VisualComponent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.name !== 'string' || r.name.length === 0) return null

  const rootNode = parseVCNode(r.rootNode)
  if (!rootNode) return null

  const params = Array.isArray(r.params)
    ? r.params.flatMap((item) => {
        const p = parseVCParam(item)
        return p ? [p] : []
      })
    : []

  const breakpoints = Array.isArray(r.breakpoints)
    ? r.breakpoints.flatMap((item) => {
        const b = parseVCBreakpoint(item)
        return b ? [b] : []
      })
    : []

  const classIds = Array.isArray(r.classIds)
    ? r.classIds.filter((x): x is string => typeof x === 'string')
    : []

  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()

  return {
    id: r.id,
    name: r.name,
    rootNode,
    params,
    breakpoints,
    classIds,
    createdAt,
  }
}
