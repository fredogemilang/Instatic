// ---------------------------------------------------------------------------
// Page Tree — the document model (flat map structure)
//
// Decision #309 / Constraint #215–216:
// - Page.nodes is a Record<string, PageNode> (flat map)
// - PageNode.children is string[] (ordered child node IDs, single default slot)
// - Props are FLAT — no dot-path keys
//
// Benefits over nested tree:
// - O(1) node lookup: page.nodes[id]
// - Immer creates exactly ONE new reference per mutation (no ancestor cascade)
// - Test fixtures are trivially constructed
// - Clean Zustand selectors
// ---------------------------------------------------------------------------

import type { SiteFile } from '../files/types'

import type { VisualComponent } from '../visualComponents/types'

import type { SitePackageJson } from '../site-dependencies/manifest'
import type { SiteRuntimeConfig } from '../site-runtime/types'

// ---------------------------------------------------------------------------
// Phase C — CSS Class System types
// ---------------------------------------------------------------------------

/**
 * A typed, serialisable CSS property bag for the class system.
 * Only CSS properties that are both safe and common in web design are included.
 * Values are stored as strings (e.g. "16px", "1.5", "bold") so they map 1-to-1
 * to CSS declaration values and are trivially serialisable.
 */
export interface CSSPropertyBag {
  // Typography
  fontFamily?: string
  fontSize?: string
  fontWeight?: string
  fontStyle?: 'normal' | 'italic'
  letterSpacing?: string
  lineHeight?: string
  textAlign?: 'left' | 'center' | 'right' | 'justify'
  textDecoration?: string
  textTransform?: 'none' | 'uppercase' | 'lowercase' | 'capitalize'
  color?: string
  textShadow?: string

  // Layout
  display?: 'block' | 'flex' | 'grid' | 'inline' | 'inline-block' | 'inline-flex' | 'none'
  flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse'
  flexWrap?: 'nowrap' | 'wrap'
  alignItems?: string
  justifyContent?: string
  justifyItems?: string
  alignSelf?: string
  justifySelf?: string
  flex?: string
  gap?: string
  rowGap?: string
  columnGap?: string
  gridTemplateColumns?: string
  gridTemplateRows?: string
  gridColumn?: string
  gridRow?: string

  // Size
  width?: string
  height?: string
  minWidth?: string
  maxWidth?: string
  minHeight?: string
  maxHeight?: string
  aspectRatio?: string
  boxSizing?: 'border-box' | 'content-box'

  // Spacing
  margin?: string
  marginTop?: string
  marginRight?: string
  marginBottom?: string
  marginLeft?: string
  padding?: string
  paddingTop?: string
  paddingRight?: string
  paddingBottom?: string
  paddingLeft?: string

  // Position
  position?: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky'
  top?: string
  right?: string
  bottom?: string
  left?: string
  zIndex?: number

  // Visual
  backgroundColor?: string
  background?: string
  backgroundImage?: string
  backgroundSize?: string
  backgroundPosition?: string
  backgroundRepeat?: string
  objectFit?: 'contain' | 'cover' | 'fill' | 'none' | 'scale-down'
  objectPosition?: string
  opacity?: number
  overflow?: string
  overflowX?: string
  overflowY?: string

  // Border
  border?: string
  borderTop?: string
  borderRight?: string
  borderBottom?: string
  borderLeft?: string
  borderColor?: string
  borderRadius?: string
  borderTopLeftRadius?: string
  borderTopRightRadius?: string
  borderBottomLeftRadius?: string
  borderBottomRightRadius?: string
  outline?: string
  outlineOffset?: string

  // Effects
  boxShadow?: string
  filter?: string
  backdropFilter?: string
  transform?: string
  transformOrigin?: string

  // Motion
  transition?: string
  animation?: string

  // Interaction
  cursor?: string
  pointerEvents?: 'none' | 'auto'
  userSelect?: string

  // Scrollbar
  scrollBehavior?: string

  // SVG / icon color utilities
  fill?: string
}

export type FrameworkColorUtilityType = 'text' | 'background' | 'border' | 'fill'

export interface GeneratedColorClassMetadata {
  origin: 'framework'
  family: 'color'
  sourceId: string
  utility: FrameworkColorUtilityType
  tokenName: string
  variantName?: string
  locked: true
}

export interface GeneratedTypographyClassMetadata {
  origin: 'framework'
  family: 'typography'
  /** ID of the FrameworkTypographyGroup this class was generated from. */
  sourceId: string
  /** ID of the FrameworkTypographyClassGenerator (the row in the Class Generator). */
  generatorId: string
  /** namingConvention of the source group (e.g. "text"). */
  tokenName: string
  /** Step suffix from the group's `steps` string (e.g. "xs", "m"). */
  step: string
  locked: true
}

export interface GeneratedSpacingClassMetadata {
  origin: 'framework'
  family: 'spacing'
  sourceId: string
  generatorId: string
  tokenName: string
  step: string
  locked: true
}

export type GeneratedClassMetadata =
  | GeneratedColorClassMetadata
  | GeneratedTypographyClassMetadata
  | GeneratedSpacingClassMetadata

/**
 * A named, reusable CSS class that can be assigned to any node.
 * Applied in the editor and publisher using the user-facing class name.
 */
export interface CSSClass {
  id: string
  /** User-editable name — must be unique within the site */
  name: string
  description?: string
  /**
   * Optional ownership scope.
   * Missing scope means a normal reusable user class. Node-scoped classes are
   * internal instance style layers used by module CSS fields.
   */
  scope?: { type: 'node'; nodeId: string; role: 'module-style' }
  /** Base styles applied at all breakpoints */
  styles: Partial<CSSPropertyBag>
  /** Per-breakpoint overrides — key is Breakpoint.id */
  breakpointStyles: Record<string, Partial<CSSPropertyBag>>
  /** Optional tags for search/filtering in the Class Manager */
  tags?: string[]
  /** Metadata for framework-generated classes that are assignable but not directly editable. */
  generated?: GeneratedClassMetadata
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Dynamic templates
// ---------------------------------------------------------------------------

export type TemplateContext = 'entry'

export interface TemplateCondition {
  id: string
  field: string
  operator: 'equals'
  value: string
}

export interface PageTemplateConfig {
  enabled: true
  context: TemplateContext
  collectionId: string
  priority: number
  conditions: TemplateCondition[]
}

export type DynamicBindingSource = 'currentEntry'
export type DynamicBindingFormat = 'plain' | 'html' | 'url' | 'media'

export interface DynamicPropBinding {
  source: DynamicBindingSource
  field: string
  format?: DynamicBindingFormat
  fallback?: 'static' | 'empty'
}

/**
 * A single element on the page — corresponds to exactly one ModuleDefinition.
 */
export interface PageNode {
  /** Unique ID — generated with nanoid() */
  id: string

  /**
   * References a ModuleDefinition in the registry.
   * Format: "namespace.module-name" — e.g. "base.text"
   */
  moduleId: string

  /**
   * Resolved property values for this node's module.
   * Shape validated against ModuleDefinition.schema at runtime.
   * Keys are FLAT — no dot-path nesting.
   */
  props: Record<string, unknown>

  /**
   * Per-breakpoint prop overrides — shallow-merged on top of props when
   * rendering at a given breakpoint. Key is Breakpoint.id.
   */
  breakpointOverrides: Record<string, Partial<Record<string, unknown>>>

  /**
   * Ordered array of child node IDs.
   * Only meaningful when ModuleDefinition.canHaveChildren === true.
   * All children are in a single default slot (multi-slot deferred post-MVP).
   */
  children: string[]

  /** Optional user-facing label — overrides the module name in the DOM tree panel */
  label?: string

  /** When true, cannot be selected or moved in the editor */
  locked?: boolean

  /** When true, hidden on the canvas (still present in the tree) */
  hidden?: boolean

  /**
   * Ordered class IDs from the site's class registry.
   * Applied as the referenced user-facing class names on the element.
   * Later classes in the array win in cascade order.
   * Empty array when no classes are applied.
   */
  classIds: string[]

  /**
   * Template-only prop bindings.
   * Static props remain stored as fallback values; dynamicBindings overlay them
   * at render time when a page is used as a CMS content template.
   */
  dynamicBindings?: Record<string, DynamicPropBinding>

  /**
   * VC-tree only: nested child PageNode objects for tree traversal.
   * Only populated on nodes inside a VisualComponent.rootNode tree.
   * Page nodes use the flat `nodes: Record<string, PageNode>` map instead.
   * Optional — absent on all standard Page nodes.
   */
  childNodes?: PageNode[]

  /**
   * VC-tree only: prop bindings for render-time parameter substitution.
   * Maps prop key → { paramId } (stable VCParam.id reference).
   * When present, the renderer substitutes instanceProps[param.name] for
   * the bound prop key at render time (Contribution #619 §4 Option β).
   * Optional — absent on all standard Page nodes and unbound VC nodes.
   */
  propBindings?: Record<string, { paramId: string }>
}

// ---------------------------------------------------------------------------
// Breakpoint
// ---------------------------------------------------------------------------

export interface Breakpoint {
  id: string
  /** Display label e.g. "Mobile", "Tablet", "Desktop" */
  label: string
  /** Viewport width in pixels */
  width: number
  /**
   * @motion/icons kebab-case icon name — e.g. "smartphone", "tablet", "monitor".
   * Rendered by the editor through the breakpoint icon option list.
   */
  icon: string
}

export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
  { id: 'mobile', label: 'Mobile', width: 375, icon: 'smartphone' },
  { id: 'tablet', label: 'Tablet', width: 768, icon: 'tablet' },
  { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
]

// ---------------------------------------------------------------------------
// Page — a single page in the site
// ---------------------------------------------------------------------------

export interface Page {
  id: string
  /** URL-safe slug — used as the public URL path when published */
  slug: string
  /** Display title e.g. "Home", "About Us" */
  title: string
  /**
   * FLAT MAP of all nodes on this page.
   * All mutations go through page-tree/mutations.ts.
   * Direct mutation outside Immer patches is forbidden (Constraint #182).
   */
  nodes: Record<string, PageNode>
  /**
   * ID of the root container node — always "base.root".
   * Entry point for all tree traversal and the publisher.
   */
  rootNodeId: string

  /** Optional CMS template configuration. Missing means a normal static page. */
  template?: PageTemplateConfig
}

// ---------------------------------------------------------------------------
// SiteDocument Settings
// ---------------------------------------------------------------------------

export interface SiteSettings {
  metaTitle?: string
  metaDescription?: string
  faviconUrl?: string
  /** Google Fonts @import URL */
  fontImportUrl?: string
  /**
   * BCP-47 language tag for the published HTML `lang` attribute — e.g. "en", "fr", "zh-Hant".
   * Defaults to "en" if omitted (WCAG 2.1 AA SC 3.1.1).
   */
  language?: string
  /** Global CSS custom property tokens (design tokens) */
  colorTokens: Record<string, string>
  /** Structured framework token settings (colors, typography, spacing, preferences). */
  framework?: FrameworkSettings
  /** Keyboard shortcut overrides: action → key combo string */
  shortcuts: Record<string, string>
}

export interface FrameworkSettings {
  colors: FrameworkColorSettings
  typography?: FrameworkTypographySettings
  spacing?: FrameworkSpacingSettings
  /** Shared scale preferences (root font size, screen widths, rem/px output). */
  preferences?: FrameworkPreferencesSettings
}

export interface FrameworkPreferencesSettings {
  /** Root font size used to convert px → rem in published CSS. Default 10 (Core Framework). */
  rootFontSize: number
  /** Lower clamp anchor in px for fluid scales. Default 320. */
  minScreenWidth: number
  /** Upper clamp anchor in px for fluid scales. Default 1400. */
  maxScreenWidth: number
  /** Whether to emit clamp() values in `rem` (true) or `px` (false). */
  isRem: boolean
}

// ─── Typography ──────────────────────────────────────────────────────────────

export type FrameworkScaleMode = 'fluid' | 'fluid_manual'

export interface FrameworkScaleBreakpointConfig {
  /** Per-breakpoint scale ratio — references TYPE_RATIO_OPTIONS / SPACING_RATIO_OPTIONS by value, or any number. */
  scaleRatio: number | string
  /** When true, override scaleRatio with a free-form number from scaleRatioInputValue. */
  isCustomScaleRatio?: boolean
  scaleRatioInputValue?: number
}

export interface FrameworkTypographyBreakpointConfig extends FrameworkScaleBreakpointConfig {
  /** Base font size at this breakpoint in px. */
  fontSize: number
}

export interface FrameworkSpacingBreakpointConfig extends FrameworkScaleBreakpointConfig {
  /** Base size at this breakpoint in px. */
  size: number
}

export interface FrameworkScaleManualSize {
  id: string
  name: string
  min: number
  max: number
}

export interface FrameworkTypographyGroup {
  id: string
  /** Display name shown on the tab. */
  name: string
  /** Variable prefix — e.g. "text" produces --text-xs, --text-m, …  */
  namingConvention: string
  min: FrameworkTypographyBreakpointConfig
  max: FrameworkTypographyBreakpointConfig
  /** Comma-separated step labels — e.g. "xs,s,m,l,xl,2xl,3xl,4xl". */
  steps: string
  /** Index in the steps list whose value equals min.fontSize / max.fontSize. */
  baseScaleIndex: number
  mode: FrameworkScaleMode
  /** Manual mode entries — only consulted when mode === 'fluid_manual'. */
  manualSizes?: FrameworkScaleManualSize[]
  isDisabled?: boolean
  /** Sort order across the tabs row. Smaller values render first. */
  order: number
  createdAt: number
  updatedAt: number
}

export interface FrameworkTypographyClassGenerator {
  id: string
  /** Class name pattern — `*` or `{step}` is replaced with the step suffix. */
  name: string
  /** kebab-case CSS properties this generated class targets (e.g. ['font-size']). */
  property: string[]
  /** ID of the FrameworkTypographyGroup this generator targets. */
  tabId: string
  isDisabled?: boolean
}

export interface FrameworkTypographySettings {
  groups: FrameworkTypographyGroup[]
  classes?: FrameworkTypographyClassGenerator[]
  isDisabled?: boolean
}

// ─── Spacing ────────────────────────────────────────────────────────────────

export interface FrameworkSpacingGroup {
  id: string
  name: string
  namingConvention: string
  min: FrameworkSpacingBreakpointConfig
  max: FrameworkSpacingBreakpointConfig
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  manualSizes?: FrameworkScaleManualSize[]
  isDisabled?: boolean
  order: number
  createdAt: number
  updatedAt: number
}

export interface FrameworkSpacingClassGenerator {
  id: string
  name: string
  property: string[]
  tabId: string
  isDisabled?: boolean
}

export interface FrameworkSpacingSettings {
  groups: FrameworkSpacingGroup[]
  classes?: FrameworkSpacingClassGenerator[]
  isDisabled?: boolean
}

export interface FrameworkColorSettings {
  tokens: FrameworkColorToken[]
}

export interface FrameworkColorToken {
  id: string
  /**
   * Free-form category label. Empty string means "uncategorized".
   * Categories are derived from the union of token category strings — there is
   * no separate registry. When no token references a given label it ceases to
   * exist in the UI.
   */
  category: string
  slug: string
  lightValue: string
  darkValue: string
  darkModeEnabled: boolean
  generateUtilities: Record<FrameworkColorUtilityType, boolean>
  generateTransparent: boolean
  generateShades: {
    enabled: boolean
    count: number
  }
  generateTints: {
    enabled: boolean
    count: number
  }
  order: number
  createdAt: number
  updatedAt: number
}

export const DEFAULT_COLOR_TOKENS: Record<string, string> = {
  '--color-primary': '#6366f1',
  '--color-secondary': '#8b5cf6',
  '--color-accent': '#ec4899',
  '--color-surface': '#ffffff',
  '--color-on-surface': '#0f172a',
  '--color-border': '#e2e8f0',
  '--color-muted': '#94a3b8',
}

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  colorTokens: DEFAULT_COLOR_TOKENS,
  shortcuts: {},
}

// ---------------------------------------------------------------------------
// SiteDocument — the top-level document
// ---------------------------------------------------------------------------

export interface SiteDocument {
  id: string
  name: string
  pages: Page[]
  /**
   * Flat list of every non-page file in the site.
   *
   * Pages are NOT stored here — they remain first-class in `pages[]`.
   *
   * Why flat array: same reasoning as Page.nodes — a single Immer reference per
   * mutation and trivial serialization.
   */
  files: SiteFile[]
  /** User-authored reusable canvas trees. Each VC is stored as a reusable canvas tree. */
  visualComponents: VisualComponent[]
  /** SiteDocument-owned package manifest used by dependency-backed editor runtimes. */
  packageJson: SitePackageJson
  /** Runtime configuration for dependency-backed user scripts. */
  runtime: SiteRuntimeConfig
  breakpoints: Breakpoint[]
  settings: SiteSettings
  /**
   * Global class registry — flat map of all CSSClass definitions for this site.
   * Key is CSSClass.id (nanoid). Applied to nodes via node.classIds[].
   */
  classes: Record<string, CSSClass>
  createdAt: number
  updatedAt: number
}
