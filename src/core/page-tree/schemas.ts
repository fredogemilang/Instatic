/**
 * Page Tree — TypeBox schemas and derived types.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof Schema>`.
 * No parallel TypeScript interfaces — schema definitions ARE the contract.
 *
 * Resilient parsing semantics (for persisted site documents) live in
 * `parseSiteDocument`, exported from this file. The schemas themselves define
 * the validated output shape; the parser handles all fallbacks and per-entry
 * filtering.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, Value, type Static, withFallback } from '@core/utils/typeboxHelpers'
import { BaseNodeSchema, type BaseNode, parsePropBindings } from './baseNode'
import {
  FrameworkSettingsSchema,
  GeneratedClassMetadataSchema,
} from '../framework/schemas'
import { SiteFileSchema, type SiteFile, type SiteFileType } from '../files/schemas'
import { parseVisualComponent, VisualComponentSchema } from '../visualComponents/schemas'
import { SiteRuntimeConfigSchema, type SiteRuntimeConfig } from '../site-runtime/schemas'
import { SitePackageJsonSchema, type SitePackageJson } from '../site-dependencies/manifest'
import { SiteFontsSettingsSchema, parseSiteFontsSettings } from '../fonts/schemas'

// ---------------------------------------------------------------------------
// Breakpoint
// ---------------------------------------------------------------------------

export const BreakpointSchema = Type.Object({
  id: Type.String(),
  /** Display label e.g. "Mobile", "Tablet", "Desktop" */
  label: Type.String(),
  /** Viewport width in pixels */
  width: Type.Number(),
  /**
   * pixel-art-icons kebab-case icon name — e.g. "smartphone", "tablet", "monitor".
   * Falls back to "monitor" if missing or non-string — handled in parseSiteDocument.
   */
  icon: Type.String(),
})

export type Breakpoint = Static<typeof BreakpointSchema>

// ---------------------------------------------------------------------------
// Dynamic template binding
// ---------------------------------------------------------------------------

/**
 * Source for a dynamic prop binding.
 *
 * - `currentEntry` — top of the publisher's entry stack. Inside a `base.loop`
 *   subtree this is the iteration's item; outside any loop on a single-entry
 *   template page this is the entry being viewed.
 * - `parentEntry` — one frame below the top. Inside a loop nested in a
 *   single-entry template, this lets a node refer to the outer template
 *   entry (e.g. "Related to {parentEntry.title}").
 */
export const DynamicBindingSourceSchema = Type.Union([
  Type.Literal('currentEntry'),
  Type.Literal('parentEntry'),
])
export type DynamicBindingSource = Static<typeof DynamicBindingSourceSchema>

export const DynamicBindingFormatSchema = Type.Union([
  Type.Literal('plain'),
  Type.Literal('html'),
  Type.Literal('url'),
  Type.Literal('media'),
])
export type DynamicBindingFormat = Static<typeof DynamicBindingFormatSchema>

export const DynamicPropBindingSchema = Type.Object({
  source: DynamicBindingSourceSchema,
  field: Type.String({ minLength: 1 }),
  /** Valid format tag; silently dropped if unrecognised or absent — handled in parseDynamicPropBinding. */
  format: Type.Optional(DynamicBindingFormatSchema),
  /** Fallback strategy; silently dropped if unrecognised or absent — handled in parseDynamicPropBinding. */
  fallback: Type.Optional(Type.Union([Type.Literal('static'), Type.Literal('empty')])),
})

export type DynamicPropBinding = Static<typeof DynamicPropBindingSchema>

// ---------------------------------------------------------------------------
// Page template configuration
// ---------------------------------------------------------------------------

export const TemplateContextSchema = Type.Literal('entry')
export type TemplateContext = Static<typeof TemplateContextSchema>

export const TemplateConditionSchema = Type.Object({
  id: Type.String(),
  field: Type.String(),
  operator: Type.Literal('equals'),
  value: Type.String(),
})

export type TemplateCondition = Static<typeof TemplateConditionSchema>

export const PageTemplateConfigSchema = Type.Object({
  enabled: Type.Literal(true),
  context: TemplateContextSchema,
  collectionId: Type.String({ minLength: 1 }),
  /**
   * Falls back to 0 when missing or not a finite number —
   * handled in parsePageTemplate.
   */
  priority: Type.Number(),
  /** Invalid items are silently dropped; missing array becomes [] — handled in parsePageTemplate. */
  conditions: Type.Array(TemplateConditionSchema),
})

export type PageTemplateConfig = Static<typeof PageTemplateConfigSchema>

// ---------------------------------------------------------------------------
// PageNode — extends BaseNode with CMS-template-only fields
//
// Type.Recursive handles the self-reference previously served by z.lazy().
// ---------------------------------------------------------------------------

export const PageNodeSchema = Type.Recursive((Self) =>
  Type.Object({
    ...BaseNodeSchema.properties,
    /**
     * Template-only prop bindings.
     * Static props remain stored as fallback values; dynamicBindings overlay them
     * at render time when a page is used as a CMS content template.
     * Silently dropped if invalid — handled in parsePageNode.
     */
    dynamicBindings: Type.Optional(Type.Record(Type.String(), DynamicPropBindingSchema)),
    /**
     * VC-tree only: nested child PageNode objects for tree traversal.
     * Only populated on nodes inside a VisualComponent.rootNode tree.
     * Page nodes use the flat `nodes: Record<string, PageNode>` map instead.
     * Silently dropped if invalid — handled in parsePageNode.
     */
    childNodes: Type.Optional(Type.Array(Self)),
  }),
)

export type PageNode = BaseNode & {
  dynamicBindings?: Record<string, DynamicPropBinding>
  childNodes?: PageNode[]
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export const PageSchema = Type.Object({
  id: Type.String(),
  /** URL-safe slug — used as the public URL path when published */
  slug: Type.String(),
  /** Display title e.g. "Home", "About Us" */
  title: Type.String(),
  /**
   * FLAT MAP of all nodes on this page.
   * All mutations go through page-tree/mutations.ts.
   */
  nodes: Type.Record(Type.String(), PageNodeSchema),
  /**
   * ID of the root container node — always "base.root".
   * Entry point for all tree traversal and the publisher.
   */
  rootNodeId: Type.String(),
  /**
   * Optional CMS template configuration.
   * Missing means a normal static page.
   * Silently dropped if invalid — handled in parsePage.
   */
  template: Type.Optional(PageTemplateConfigSchema),
})

export type Page = Static<typeof PageSchema>

// ---------------------------------------------------------------------------
// Default breakpoints
// ---------------------------------------------------------------------------

export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'mobile',  label: 'Mobile',  width: 375,  icon: 'smartphone' },
  { id: 'tablet',  label: 'Tablet',  width: 768,  icon: 'tablet'     },
  { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor'    },
]

// ---------------------------------------------------------------------------
// CSSPropertyBagSchema — publisher-boundary narrowing type
//
// §4.1 rationale: validate.ts line 822 stores `styles` as
// `Record<string, unknown>` without narrowing to CSSPropertyBag. The editor
// only writes known CSSPropertyBag keys via classSlice, but the persistence
// layer preserves arbitrary keys (forward-compat with future CSS properties).
//
// Consequence:
//   - `CSSClassSchema.styles` uses `Type.Record(Type.String(), Type.Unknown())`
//     to match the persistence semantics exactly.
//   - `CSSPropertyBagSchema` exists as the TypeBox source-of-truth for the type
//     only, used at the publisher narrowing point (classCss.ts `bagToCSS`).
//   - Per-property fallback is intentionally absent: the publisher already
//     guards via the ALLOWED_PROPS set + `sanitiseCssValue`, so silently
//     coercing bad values here would be redundant and misleading.
// ---------------------------------------------------------------------------

export const CSSPropertyBagSchema = Type.Object({
  // Typography
  fontFamily: Type.Optional(Type.String()),
  fontSize: Type.Optional(Type.String()),
  fontWeight: Type.Optional(Type.String()),
  fontStyle: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('italic')])),
  letterSpacing: Type.Optional(Type.String()),
  lineHeight: Type.Optional(Type.String()),
  textAlign: Type.Optional(Type.Union([
    Type.Literal('left'), Type.Literal('center'), Type.Literal('right'), Type.Literal('justify'),
  ])),
  textDecoration: Type.Optional(Type.String()),
  textTransform: Type.Optional(Type.Union([
    Type.Literal('none'), Type.Literal('uppercase'), Type.Literal('lowercase'), Type.Literal('capitalize'),
  ])),
  color: Type.Optional(Type.String()),
  textShadow: Type.Optional(Type.String()),

  // Layout
  display: Type.Optional(Type.Union([
    Type.Literal('block'), Type.Literal('flex'), Type.Literal('grid'),
    Type.Literal('inline'), Type.Literal('inline-block'), Type.Literal('inline-flex'),
    Type.Literal('none'),
  ])),
  flexDirection: Type.Optional(Type.Union([
    Type.Literal('row'), Type.Literal('column'),
    Type.Literal('row-reverse'), Type.Literal('column-reverse'),
  ])),
  flexWrap: Type.Optional(Type.Union([Type.Literal('nowrap'), Type.Literal('wrap')])),
  alignItems: Type.Optional(Type.String()),
  justifyContent: Type.Optional(Type.String()),
  justifyItems: Type.Optional(Type.String()),
  alignSelf: Type.Optional(Type.String()),
  justifySelf: Type.Optional(Type.String()),
  flex: Type.Optional(Type.String()),
  gap: Type.Optional(Type.String()),
  rowGap: Type.Optional(Type.String()),
  columnGap: Type.Optional(Type.String()),
  gridTemplateColumns: Type.Optional(Type.String()),
  gridTemplateRows: Type.Optional(Type.String()),
  gridColumn: Type.Optional(Type.String()),
  gridRow: Type.Optional(Type.String()),

  // Size
  width: Type.Optional(Type.String()),
  height: Type.Optional(Type.String()),
  minWidth: Type.Optional(Type.String()),
  maxWidth: Type.Optional(Type.String()),
  minHeight: Type.Optional(Type.String()),
  maxHeight: Type.Optional(Type.String()),
  aspectRatio: Type.Optional(Type.String()),
  boxSizing: Type.Optional(Type.Union([Type.Literal('border-box'), Type.Literal('content-box')])),

  // Spacing
  margin: Type.Optional(Type.String()),
  marginTop: Type.Optional(Type.String()),
  marginRight: Type.Optional(Type.String()),
  marginBottom: Type.Optional(Type.String()),
  marginLeft: Type.Optional(Type.String()),
  padding: Type.Optional(Type.String()),
  paddingTop: Type.Optional(Type.String()),
  paddingRight: Type.Optional(Type.String()),
  paddingBottom: Type.Optional(Type.String()),
  paddingLeft: Type.Optional(Type.String()),

  // Position
  position: Type.Optional(Type.Union([
    Type.Literal('static'), Type.Literal('relative'), Type.Literal('absolute'),
    Type.Literal('fixed'), Type.Literal('sticky'),
  ])),
  top: Type.Optional(Type.String()),
  right: Type.Optional(Type.String()),
  bottom: Type.Optional(Type.String()),
  left: Type.Optional(Type.String()),
  zIndex: Type.Optional(Type.Number()),

  // Visual
  backgroundColor: Type.Optional(Type.String()),
  background: Type.Optional(Type.String()),
  backgroundImage: Type.Optional(Type.String()),
  backgroundSize: Type.Optional(Type.String()),
  backgroundPosition: Type.Optional(Type.String()),
  backgroundRepeat: Type.Optional(Type.String()),
  objectFit: Type.Optional(Type.Union([
    Type.Literal('contain'), Type.Literal('cover'), Type.Literal('fill'),
    Type.Literal('none'), Type.Literal('scale-down'),
  ])),
  objectPosition: Type.Optional(Type.String()),
  opacity: Type.Optional(Type.Number()),
  overflow: Type.Optional(Type.String()),
  overflowX: Type.Optional(Type.String()),
  overflowY: Type.Optional(Type.String()),

  // Border
  border: Type.Optional(Type.String()),
  borderTop: Type.Optional(Type.String()),
  borderRight: Type.Optional(Type.String()),
  borderBottom: Type.Optional(Type.String()),
  borderLeft: Type.Optional(Type.String()),
  borderColor: Type.Optional(Type.String()),
  borderRadius: Type.Optional(Type.String()),
  borderTopLeftRadius: Type.Optional(Type.String()),
  borderTopRightRadius: Type.Optional(Type.String()),
  borderBottomLeftRadius: Type.Optional(Type.String()),
  borderBottomRightRadius: Type.Optional(Type.String()),
  outline: Type.Optional(Type.String()),
  outlineOffset: Type.Optional(Type.String()),

  // Effects
  boxShadow: Type.Optional(Type.String()),
  filter: Type.Optional(Type.String()),
  backdropFilter: Type.Optional(Type.String()),
  transform: Type.Optional(Type.String()),
  transformOrigin: Type.Optional(Type.String()),

  // Motion
  transition: Type.Optional(Type.String()),
  animation: Type.Optional(Type.String()),

  // Interaction
  cursor: Type.Optional(Type.String()),
  pointerEvents: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('auto')])),
  userSelect: Type.Optional(Type.String()),

  // Scrollbar
  scrollBehavior: Type.Optional(Type.String()),

  // SVG / icon color utilities
  fill: Type.Optional(Type.String()),
})

export type CSSPropertyBag = Static<typeof CSSPropertyBagSchema>

// ---------------------------------------------------------------------------
// CSSClassSchema
// ---------------------------------------------------------------------------

/**
 * A named, reusable CSS class that can be assigned to any node.
 *
 * §4.1 persistence note: `styles` and `breakpointStyles` are stored as
 * `Record<string, unknown>` matching validate.ts line 822 which stores the raw
 * object without narrowing to CSSPropertyBag.  Narrowing happens at the
 * publisher boundary (`bagToCSS` in classCss.ts).
 *
 * CSSPropertyBag is used for the WRITE API (classSlice / framework generators)
 * which always writes only known CSS property keys.
 *
 * For tolerant parsing of persisted classes (with per-entry fallbacks),
 * use `parseCSSClass` instead of `parseValue(CSSClassSchema, raw)`.
 */
export const CSSClassSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  /**
   * Optional ownership scope.  If the scope object does not match the exact
   * shape, it is silently dropped — handled in parseCSSClass.
   */
  scope: Type.Optional(Type.Object({
    type: Type.Literal('node'),
    nodeId: Type.String(),
    role: Type.Literal('module-style'),
  })),
  /**
   * Base CSS styles — arbitrary string→unknown map at persistence boundary.
   * Falls back to {} when missing or invalid — handled in parseCSSClass.
   */
  styles: withFallback(Type.Record(Type.String(), Type.Unknown()), {} as Record<string, unknown>),
  /**
   * Per-breakpoint overrides — same persistence semantics as `styles`.
   * Falls back to {} when missing or invalid — handled in parseCSSClass.
   */
  breakpointStyles: withFallback(
    Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())),
    {} as Record<string, Record<string, unknown>>,
  ),
  /** Optional search/filter tags. Invalid items silently dropped — handled in parseCSSClass. */
  tags: Type.Optional(Type.Array(Type.String())),
  /** Metadata for framework-generated classes. Undefined if invalid — handled in parseCSSClass. */
  generated: Type.Optional(GeneratedClassMetadataSchema),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
})

export type CSSClass = Static<typeof CSSClassSchema>

// ---------------------------------------------------------------------------
// Color tokens — REMOVED.
//
// The legacy `site.settings.colorTokens` field was the original raw design-token
// shape (`{ '--color-primary': '#6366f1', ... }`) emitted into a `:root {}`
// block in the published `framework.css`. It has been fully superseded by the
// structured framework Color settings (`site.settings.framework.colors`), which
// is what the editor's Colors panel reads from and writes to.
//
// Keeping both paths around silently injected ghost tokens into every fresh
// project (the old `DEFAULT_COLOR_TOKENS` had seven `#6366f1`-family defaults)
// that the user could not see or remove via the UI. Per CLAUDE.md ("we are
// pre-release, don't leave both an old and new implementation side-by-side")
// the legacy field has been removed entirely; persisted snapshots that still
// carry a `colorTokens` key are silently dropped on parse.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SiteSettingsSchema
// ---------------------------------------------------------------------------

/**
 * Per-site configuration stored in SiteDocument.settings.
 * Mirrors `validateSettings` in validate.ts (lines ~614–633).
 *
 * For tolerant parsing (with fallbacks for invalid sub-fields), use
 * `parseSiteSettings` instead of `parseValue(SiteSettingsSchema, raw)`.
 */
export const SiteSettingsSchema = Type.Object({
  metaTitle: Type.Optional(Type.String()),
  metaDescription: Type.Optional(Type.String()),
  faviconUrl: Type.Optional(Type.String()),
  fontImportUrl: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  /** Structured framework token settings — absent means framework disabled. */
  framework: Type.Optional(FrameworkSettingsSchema),
  /** Library of installed fonts — absent when no fonts added. */
  fonts: Type.Optional(SiteFontsSettingsSchema),
  /** Keyboard shortcut overrides — defaults to {} — handled in parseSiteSettings. */
  shortcuts: Type.Record(Type.String(), Type.String()),
})

export type SiteSettings = Static<typeof SiteSettingsSchema>

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  shortcuts: {},
}

// ---------------------------------------------------------------------------
// SiteDocumentSchema — top-level persisted site document
// ---------------------------------------------------------------------------

/**
 * The top-level site document stored in the CMS database.
 *
 * This schema defines the validated output shape. For tolerant loading of
 * persisted data (with per-entry filtering of classes/files/visualComponents
 * and fallbacks for settings/packageJson/runtime), use `parseSiteDocument`.
 *
 * Resilience semantics:
 *   THROWS (no fallback) if missing / wrong type:
 *     id, name, pages (also ≥ 1 item), breakpoints, classes, files,
 *     visualComponents, createdAt, updatedAt
 *
 *   RESILIENT (fallback to default) via parseSiteDocument:
 *     settings → DEFAULT_SITE_SETTINGS
 *     packageJson → { dependencies: {}, devDependencies: {} }
 *     runtime → { dependencyLock: { version: 1, packages: {}, updatedAt: 0 }, scripts: {} }
 *
 * Per-entry leniency via parseSiteDocument:
 *   classes — entries missing id/name are silently dropped
 *   files — invalid entries are silently dropped
 *   visualComponents — invalid entries are silently dropped
 */
export const SiteDocumentSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** At least one page is required */
  pages: Type.Array(PageSchema, { minItems: 1 }),
  breakpoints: Type.Array(BreakpointSchema),
  settings: SiteSettingsSchema,
  /** Class registry — required object */
  classes: Type.Record(Type.String(), CSSClassSchema),
  /** Site files — required array */
  files: Type.Array(SiteFileSchema),
  /** Visual components — required array */
  visualComponents: Type.Array(VisualComponentSchema),
  packageJson: SitePackageJsonSchema,
  runtime: SiteRuntimeConfigSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
})

export type SiteDocument = Static<typeof SiteDocumentSchema>

// ---------------------------------------------------------------------------
// Tolerant parsing helpers
//
// These replace the Zod .transform() / .preprocess() / .catch() patterns.
// Call them when loading persisted site documents where one bad entry should
// not invalidate the whole document. The schemas above define the clean
// validated shape; these helpers handle all tolerance at parse time.
//
// Error format: helpers that participate in path-propagation throw Error
// with messages of the form "<relative-path>: <description>". The caller
// prepends its own path segment before re-throwing. parseSiteDocument
// accumulates the full path; validate.ts extracts it via the
// "<relative-path>: <description>" convention.
// ---------------------------------------------------------------------------

/** Parse a DynamicPropBinding, silently dropping unrecognised format/fallback values. */
function parseDynamicPropBinding(raw: unknown): DynamicPropBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const VALID_SOURCES: DynamicBindingSource[] = ['currentEntry', 'parentEntry']
  if (!VALID_SOURCES.includes(r.source as DynamicBindingSource)) return null
  if (typeof r.field !== 'string' || r.field.length === 0) return null

  const VALID_FORMATS: DynamicBindingFormat[] = ['plain', 'html', 'url', 'media']
  const format: DynamicBindingFormat | undefined = VALID_FORMATS.includes(r.format as DynamicBindingFormat)
    ? (r.format as DynamicBindingFormat)
    : undefined

  const VALID_FALLBACKS = ['static', 'empty'] as const
  type Fallback = typeof VALID_FALLBACKS[number]
  const fallback: Fallback | undefined = (VALID_FALLBACKS as readonly unknown[]).includes(r.fallback)
    ? (r.fallback as Fallback)
    : undefined

  return {
    source: r.source as DynamicBindingSource,
    field: r.field,
    ...(format !== undefined ? { format } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
  }
}

/** Parse a PageTemplateConfig, providing fallbacks for priority and conditions. */
function parsePageTemplate(raw: unknown): PageTemplateConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.enabled !== true) return null
  if (r.context !== 'entry') return null
  if (typeof r.collectionId !== 'string' || r.collectionId.length === 0) return null

  const priority = typeof r.priority === 'number' && isFinite(r.priority) ? r.priority : 0
  const conditions = Array.isArray(r.conditions)
    ? r.conditions.flatMap((c) => Value.Check(TemplateConditionSchema, c) ? [c as TemplateCondition] : [])
    : []

  return { enabled: true, context: 'entry', collectionId: r.collectionId, priority, conditions }
}

/**
 * Parse a single PageNode, throwing Error('<nodePath>.<field>: <message>') on
 * required-field failures so parsePage/parseSiteDocument can report the exact
 * invalid path.
 *
 * Replicates the Zod .catch() fallback behaviour for withFallback() fields
 * (props, breakpointOverrides, classIds) so nodes missing these fields are still
 * accepted with sensible defaults rather than rejected.
 */
function parsePageNode(raw: unknown, nodePath: string): PageNode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${nodePath}: not an object`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') throw new Error(`${nodePath}.id: Expected string`)
  if (typeof r.moduleId !== 'string') throw new Error(`${nodePath}.moduleId: Expected string`)
  if (!Array.isArray(r.children)) throw new Error(`${nodePath}.children: Expected array`)

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

  // Parse dynamicBindings: silently drop invalid entries (per-entry tolerance)
  let dynamicBindings: Record<string, DynamicPropBinding> | undefined = undefined
  if (r.dynamicBindings && typeof r.dynamicBindings === 'object' && !Array.isArray(r.dynamicBindings)) {
    const result: Record<string, DynamicPropBinding> = {}
    for (const [k, v] of Object.entries(r.dynamicBindings as Record<string, unknown>)) {
      const parsed = parseDynamicPropBinding(v)
      if (parsed) result[k] = parsed
    }
    if (Object.keys(result).length > 0) dynamicBindings = result
  }

  // Parse childNodes recursively (PageNode.childNodes is used in VC-context tree walking)
  let childNodes: PageNode[] | undefined = undefined
  if (Array.isArray(r.childNodes)) {
    const parsed = r.childNodes.flatMap((child, i) => {
      const node = parsePageNode(child, `${nodePath}.childNodes[${i}]`)
      return [node]
    })
    if (parsed.length > 0) childNodes = parsed
  }

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
    ...(dynamicBindings !== undefined ? { dynamicBindings } : {}),
    ...(childNodes !== undefined ? { childNodes } : {}),
  }
}

/** Parse a Breakpoint, providing a 'monitor' fallback for missing/invalid icon. */
function parseBreakpoint(raw: unknown): Breakpoint | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.label !== 'string') return null
  if (typeof r.width !== 'number') return null
  return {
    id: r.id,
    label: r.label,
    width: r.width,
    icon: typeof r.icon === 'string' ? r.icon : 'monitor',
  }
}

/** Parse a CSSClass, providing fallbacks for resilient fields. */
function parseCSSClass(raw: unknown): CSSClass | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.name !== 'string') return null

  // scope: required shape, silently dropped if invalid
  let scope: CSSClass['scope'] = undefined
  const s = r.scope
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    const so = s as Record<string, unknown>
    if (so.type === 'node' && typeof so.nodeId === 'string' && so.role === 'module-style') {
      scope = { type: 'node', nodeId: so.nodeId, role: 'module-style' }
    }
  }

  const styles: Record<string, unknown> =
    r.styles && typeof r.styles === 'object' && !Array.isArray(r.styles)
      ? (r.styles as Record<string, unknown>)
      : {}

  const breakpointStyles: Record<string, Record<string, unknown>> = {}
  if (r.breakpointStyles && typeof r.breakpointStyles === 'object' && !Array.isArray(r.breakpointStyles)) {
    for (const [k, v] of Object.entries(r.breakpointStyles as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        breakpointStyles[k] = v as Record<string, unknown>
      }
    }
  }

  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === 'string')
    : undefined

  const generated = Value.Check(GeneratedClassMetadataSchema, r.generated)
    ? (r.generated as CSSClass['generated'])
    : undefined

  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : Date.now()

  return {
    id: r.id,
    name: r.name,
    ...(typeof r.description === 'string' ? { description: r.description } : {}),
    ...(scope !== undefined ? { scope } : {}),
    styles,
    breakpointStyles,
    ...(tags !== undefined ? { tags } : {}),
    ...(generated !== undefined ? { generated } : {}),
    createdAt,
    updatedAt,
  }
}

/** Parse the class registry: iterate entries and silently drop those with invalid id/name. */
function parseClassRegistry(raw: unknown): Record<string, CSSClass> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, CSSClass> = {}
  for (const [id, cls] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = parseCSSClass(cls)
    if (parsed) result[id] = parsed
  }
  return result
}

/**
 * Parse a SiteFile. Keeps the file with blob=undefined when the blob is
 * malformed (mimeType or base64 missing/wrong type) — mirrors the
 * "lenient" blob semantics documented on SiteFileSchema.blob.
 *
 * Returns null only for missing required fields (id, path, type).
 */
const VALID_SITE_FILE_TYPES: SiteFileType[] = ['component', 'script', 'style', 'asset', 'config', 'doc']

function parseSiteFile(raw: unknown): SiteFile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') return null
  if (typeof r.path !== 'string') return null
  if (!VALID_SITE_FILE_TYPES.includes(r.type as SiteFileType)) return null

  // Blob: silently becomes undefined when mimeType or base64 is not a string
  let blob: SiteFile['blob'] = undefined
  if (r.blob && typeof r.blob === 'object' && !Array.isArray(r.blob)) {
    const b = r.blob as Record<string, unknown>
    if (typeof b.mimeType === 'string' && typeof b.base64 === 'string') {
      blob = { mimeType: b.mimeType, base64: b.base64 }
    }
    // malformed blob → blob remains undefined; file is still included
  }

  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : Date.now()

  return {
    id: r.id,
    path: r.path,
    type: r.type as SiteFileType,
    ...(typeof r.content === 'string' ? { content: r.content } : {}),
    ...(blob !== undefined ? { blob } : {}),
    ...(typeof r.generated === 'boolean' ? { generated: r.generated } : {}),
    ...(typeof r.ejected === 'boolean' ? { ejected: r.ejected } : {}),
    createdAt,
    updatedAt,
  }
}

/**
 * Parse SiteSettings, providing fallbacks for all resilient fields.
 *
 * Persisted snapshots from older versions may carry a top-level `colorTokens`
 * field — that legacy data path was removed in favour of the structured
 * framework Color settings (`framework.colors`). Any persisted `colorTokens`
 * key is silently dropped here (no migration: per CLAUDE.md, the dev DB is
 * disposable and there are no production users).
 */
function parseSiteSettings(raw: unknown): SiteSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SITE_SETTINGS
  const r = raw as Record<string, unknown>

  const shortcuts: Record<string, string> = {}
  if (r.shortcuts && typeof r.shortcuts === 'object' && !Array.isArray(r.shortcuts)) {
    for (const [k, v] of Object.entries(r.shortcuts as Record<string, unknown>)) {
      if (typeof v === 'string') shortcuts[k] = v
    }
  }

  const framework = Value.Check(FrameworkSettingsSchema, r.framework)
    ? (r.framework as SiteSettings['framework'])
    : undefined

  const fonts = r.fonts != null ? parseSiteFontsSettings(r.fonts) : undefined

  return {
    ...(typeof r.metaTitle === 'string' ? { metaTitle: r.metaTitle } : {}),
    ...(typeof r.metaDescription === 'string' ? { metaDescription: r.metaDescription } : {}),
    ...(typeof r.faviconUrl === 'string' ? { faviconUrl: r.faviconUrl } : {}),
    ...(typeof r.fontImportUrl === 'string' ? { fontImportUrl: r.fontImportUrl } : {}),
    ...(typeof r.language === 'string' ? { language: r.language } : {}),
    framework,
    fonts,
    shortcuts,
  }
}

/**
 * Parse a Page. Throws Error('<path>: <message>') for required-field failures
 * using path segments relative to the page's position (e.g. 'nodes.heading-1.id').
 * Invalid optional fields (template) silently become absent.
 */
function parsePage(raw: unknown, pageIndex: number): Page {
  const pagePathPrefix = `pages[${pageIndex}]`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${pagePathPrefix}: not an object`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string') throw new Error(`${pagePathPrefix}.id: Expected string`)
  if (typeof r.slug !== 'string') throw new Error(`${pagePathPrefix}.slug: Expected string`)
  if (typeof r.title !== 'string') throw new Error(`${pagePathPrefix}.title: Expected string`)
  if (typeof r.rootNodeId !== 'string') throw new Error(`${pagePathPrefix}.rootNodeId: Expected string`)
  if (!r.nodes || typeof r.nodes !== 'object' || Array.isArray(r.nodes)) {
    throw new Error(`${pagePathPrefix}.nodes: Expected object`)
  }

  const nodes: Record<string, PageNode> = {}
  for (const [nodeId, rawNode] of Object.entries(r.nodes as Record<string, unknown>)) {
    // parsePageNode throws with path e.g. 'nodes.heading-1.id: Expected string'
    const node = parsePageNode(rawNode, `${pagePathPrefix}.nodes.${nodeId}`)
    nodes[nodeId] = node
  }

  const template = parsePageTemplate(r.template)

  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    nodes,
    rootNodeId: r.rootNodeId,
    ...(template !== null ? { template } : {}),
  }
}

const DEFAULT_RUNTIME: SiteRuntimeConfig = {
  dependencyLock: { version: 1 as const, packages: {}, updatedAt: 0 },
  scripts: {},
}

const DEFAULT_PACKAGE_JSON: SitePackageJson = { dependencies: {}, devDependencies: {} }

/**
 * Tolerant parser for a SiteDocument loaded from persistent storage.
 *
 * Throws if required fields (id, name, pages, breakpoints, createdAt,
 * updatedAt) are missing or of the wrong type. Silently drops/defaults
 * invalid entries in classes, files, visualComponents, settings, etc.
 *
 * Use this in place of `parseValue(SiteDocumentSchema, raw)` when reading
 * persisted site data. After this returns, run `runDomainPostChecks` in
 * `persistence/validate.ts` for cross-cutting invariants.
 */
export function parseSiteDocument(raw: unknown): SiteDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('not an object')
  }
  const r = raw as Record<string, unknown>

  if (typeof r.id !== 'string') throw new Error('id must be a string')
  if (typeof r.name !== 'string') throw new Error('name must be a string')
  if (typeof r.createdAt !== 'number') throw new Error('createdAt must be a number')
  if (typeof r.updatedAt !== 'number') throw new Error('updatedAt must be a number')

  // Pages — required, must have ≥ 1
  if (!Array.isArray(r.pages)) throw new Error('pages must be an array')
  if (r.pages.length < 1) throw new Error('pages must have at least one page')
  const pages: Page[] = []
  for (let i = 0; i < r.pages.length; i++) {
    pages.push(parsePage(r.pages[i], i))
  }

  // Breakpoints — required array, per-item has icon fallback
  if (!Array.isArray(r.breakpoints)) throw new Error('breakpoints must be an array')
  const breakpoints: Breakpoint[] = []
  for (let i = 0; i < r.breakpoints.length; i++) {
    const bp = parseBreakpoint(r.breakpoints[i])
    if (!bp) throw new Error(`breakpoints[${i}] is invalid`)
    breakpoints.push(bp)
  }

  // Classes — required object, per-entry leniency
  const classes = parseClassRegistry(r.classes)

  // Files — required array, per-entry leniency (parseSiteFile keeps files with malformed blobs)
  const files: SiteFile[] = Array.isArray(r.files)
    ? r.files.flatMap((item) => {
        const file = parseSiteFile(item)
        return file ? [file] : []
      })
    : []

  // Visual components — required array, per-entry leniency
  const visualComponents = Array.isArray(r.visualComponents)
    ? r.visualComponents.flatMap((item) => {
        const vc = parseVisualComponent(item)
        return vc ? [vc] : []
      })
    : []

  // Settings — resilient, falls back to DEFAULT_SITE_SETTINGS
  const settings = parseSiteSettings(r.settings)

  // PackageJson — resilient, falls back to DEFAULT_PACKAGE_JSON
  const packageJson: SitePackageJson = Value.Check(SitePackageJsonSchema, r.packageJson)
    ? (r.packageJson as SitePackageJson)
    : DEFAULT_PACKAGE_JSON

  // Runtime — resilient, falls back to DEFAULT_RUNTIME
  const runtime: SiteRuntimeConfig = Value.Check(SiteRuntimeConfigSchema, r.runtime)
    ? (r.runtime as SiteRuntimeConfig)
    : DEFAULT_RUNTIME

  return {
    id: r.id,
    name: r.name,
    pages,
    breakpoints,
    settings,
    classes,
    files,
    visualComponents,
    packageJson,
    runtime,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}
