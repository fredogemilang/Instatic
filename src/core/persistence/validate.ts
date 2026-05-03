/**
 * validateSite — structural validation of raw data before store hydration.
 *
 * Constraint #230: ALL site data loaded from storage MUST be validated
 * before being passed to `store.loadSite()`. This prevents corrupted or
 * stale schema data from silently poisoning the store.
 *
 * The validator is intentionally STRICT on structure and LENIENT on values:
 * - It rejects data that would crash the editor (missing required fields,
 *   wrong types for fields the code unconditionally reads).
 * - It does NOT reject unknown extra keys — forward-compat with future schema.
 * - It does NOT validate prop VALUES against module schemas — that would
 *   require the registry at validation time, creating a circular dependency.
 *
 * Throws a descriptive SiteValidationError with a `path` field for debugging.
 */

import type {
  SiteDocument,
  Page,
  PageNode,
  Breakpoint,
  SiteSettings,
  PageTemplateConfig,
  DynamicPropBinding,
  DynamicBindingFormat,
  TemplateCondition,
  FrameworkColorSettings,
  FrameworkColorToken,
  FrameworkColorUtilityType,
  FrameworkPreferencesSettings,
  FrameworkScaleManualSize,
  FrameworkSpacingClassGenerator,
  FrameworkSpacingGroup,
  FrameworkSpacingSettings,
  FrameworkTypographyClassGenerator,
  FrameworkTypographyGroup,
  FrameworkTypographySettings,
  GeneratedClassMetadata,
} from '../page-tree/types'
import type { SiteFile, SiteFileType } from '../files/types'
import type { VisualComponent, VCNode } from '../visualComponents/types'
import { VisualComponentSchema } from '../visualComponents/schemas'
import { isSafePath, normalizePath } from '../files/pathValidation'
import { validateComponentName } from '../visualComponents/nameValidation'
import { sanitizeRichtext, isRichtextPropKey } from '../sanitize'
import { normalizeSitePackageJson } from '../site-dependencies/manifest'
import { normalizeSiteRuntimeConfig } from '../site-runtime'
import { pageSlugDuplicateError, pageSlugError } from '../page-tree/slugs'
import { generateDefaultDarkColor, normalizeFrameworkColorSlug } from '../framework/colors'

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SiteValidationError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`[persistence/validate] ${path}: ${message}`)
    this.name = 'SiteValidationError'
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function assertString(v: unknown, path: string): asserts v is string {
  if (typeof v !== 'string') throw new SiteValidationError(`expected string, got ${typeof v}`, path)
}

function assertNumber(v: unknown, path: string): asserts v is number {
  if (typeof v !== 'number' || !isFinite(v)) throw new SiteValidationError(`expected finite number, got ${typeof v}`, path)
}

function assertObject(v: unknown, path: string): asserts v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new SiteValidationError(`expected plain object, got ${Array.isArray(v) ? 'array' : typeof v}`, path)
  }
}

function assertArray(v: unknown, path: string): asserts v is unknown[] {
  if (!Array.isArray(v)) throw new SiteValidationError(`expected array, got ${typeof v}`, path)
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const VALID_DYNAMIC_FORMATS = new Set<DynamicBindingFormat>(['plain', 'html', 'url', 'media'])
const VALID_FRAMEWORK_COLOR_UTILITIES = new Set<FrameworkColorUtilityType>(['text', 'background', 'border', 'fill'])
const DEFAULT_FRAMEWORK_COLOR_UTILITIES: Record<FrameworkColorUtilityType, boolean> = {
  text: true,
  background: true,
  border: true,
  fill: false,
}
const DEFAULT_COLOR_VARIANT_COUNT = 4

function validateDynamicBindings(raw: unknown): Record<string, DynamicPropBinding> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const bindings: Record<string, DynamicPropBinding> = {}
  for (const [propKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const binding = value as Record<string, unknown>
    if (binding.source !== 'currentEntry') continue
    if (typeof binding.field !== 'string' || binding.field.trim() === '') continue

    const next: DynamicPropBinding = {
      source: 'currentEntry',
      field: binding.field,
    }

    if (typeof binding.format === 'string' && VALID_DYNAMIC_FORMATS.has(binding.format as DynamicBindingFormat)) {
      next.format = binding.format as DynamicBindingFormat
    }

    if (binding.fallback === 'static' || binding.fallback === 'empty') {
      next.fallback = binding.fallback
    }

    bindings[propKey] = next
  }

  return Object.keys(bindings).length > 0 ? bindings : undefined
}

function validateTemplateCondition(raw: unknown): TemplateCondition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const condition = raw as Record<string, unknown>
  if (typeof condition.id !== 'string') return null
  if (typeof condition.field !== 'string') return null
  if (condition.operator !== 'equals') return null
  if (typeof condition.value !== 'string') return null

  return {
    id: condition.id,
    field: condition.field,
    operator: 'equals',
    value: condition.value,
  }
}

function validatePageTemplate(raw: unknown): PageTemplateConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const template = raw as Record<string, unknown>
  if (template.enabled !== true) return undefined
  if (template.context !== 'entry') return undefined
  if (typeof template.collectionId !== 'string' || template.collectionId.trim() === '') return undefined

  const conditions = Array.isArray(template.conditions)
    ? template.conditions
        .map((condition) => validateTemplateCondition(condition))
        .filter((condition): condition is TemplateCondition => condition !== null)
    : []

  return {
    enabled: true,
    context: 'entry',
    collectionId: template.collectionId,
    priority: typeof template.priority === 'number' && isFinite(template.priority) ? template.priority : 0,
    conditions,
  }
}

function validatePageNode(raw: unknown, path: string): PageNode {
  assertObject(raw, path)
  assertString(raw.id, `${path}.id`)
  assertString(raw.moduleId, `${path}.moduleId`)
  // props must be an object (values are unchecked — module-specific)
  assertObject(raw.props, `${path}.props`)
  // children must be an array of strings
  assertArray(raw.children, `${path}.children`)
  for (let i = 0; i < (raw.children as unknown[]).length; i++) {
    assertString((raw.children as unknown[])[i], `${path}.children[${i}]`)
  }
  // breakpointOverrides must be an object (values unchecked)
  assertObject(raw.breakpointOverrides, `${path}.breakpointOverrides`)
  // classIds: normalize missing or non-array to []. The PageNode type guarantees
  // a string[]; that guarantee is enforced here, not at the storage boundary.
  const rawClassIds = raw.classIds

  // Sanitize richtext-typed prop values before storing — prevents XSS via
  // tampered or pre-DOMPurify-boundary site data reaching the publisher.
  // Non-richtext props are passed through unchanged. Constraint #299 / Task #302.
  const rawProps = (raw.props ?? {}) as Record<string, unknown>
  const sanitizedProps: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(rawProps)) {
    if (isRichtextPropKey(key) && typeof val === 'string') {
      sanitizedProps[key] = sanitizeRichtext(val)
    } else {
      sanitizedProps[key] = val
    }
  }

  // childNodes: recursively validate each child node (VC-tree only, optional).
  // Page nodes never have childNodes — this field is absent and round-trips as undefined.
  const childNodes: PageNode[] | undefined = Array.isArray(raw.childNodes)
    ? (raw.childNodes as unknown[]).map((n, i) =>
        validatePageNode(n, `${path}.childNodes[${i}]`)
      )
    : undefined

  // propBindings: lenient per-item — preserve entries with a valid { paramId: string }
  // shape; silently drop malformed bindings rather than rejecting the whole node.
  let propBindings: Record<string, { paramId: string }> | undefined
  if (raw.propBindings && typeof raw.propBindings === 'object' && !Array.isArray(raw.propBindings)) {
    propBindings = Object.fromEntries(
      Object.entries(raw.propBindings as Record<string, unknown>)
        .filter(([, v]) => v && typeof v === 'object' && typeof (v as Record<string, unknown>).paramId === 'string')
        .map(([k, v]) => [k, { paramId: (v as Record<string, unknown>).paramId as string }])
    )
  }

  const dynamicBindings = validateDynamicBindings(raw.dynamicBindings)

  return {
    id: raw.id as string,
    moduleId: raw.moduleId as string,
    props: sanitizedProps,
    children: raw.children as string[],
    breakpointOverrides: raw.breakpointOverrides as Record<string, Partial<Record<string, unknown>>>,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    locked: typeof raw.locked === 'boolean' ? raw.locked : undefined,
    hidden: typeof raw.hidden === 'boolean' ? raw.hidden : undefined,
    classIds: Array.isArray(rawClassIds)
      ? (rawClassIds as unknown[]).filter((id) => typeof id === 'string') as string[]
      : [],
    dynamicBindings,
    childNodes,
    propBindings,
  }
}

function validatePage(raw: unknown, path: string): Page {
  assertObject(raw, path)
  assertString(raw.id, `${path}.id`)
  assertString(raw.title, `${path}.title`)
  assertString(raw.slug, `${path}.slug`)
  assertString(raw.rootNodeId, `${path}.rootNodeId`)
  assertObject(raw.nodes, `${path}.nodes`)

  const nodes: Record<string, PageNode> = {}
  for (const [nodeId, nodeRaw] of Object.entries(raw.nodes as Record<string, unknown>)) {
    nodes[nodeId] = validatePageNode(nodeRaw, `${path}.nodes[${nodeId}]`)
  }

  // Referential integrity: rootNodeId must exist in nodes
  if (!nodes[raw.rootNodeId as string]) {
    throw new SiteValidationError(
      `rootNodeId "${raw.rootNodeId}" not found in nodes`,
      `${path}.rootNodeId`,
    )
  }

  return {
    id: raw.id as string,
    title: raw.title as string,
    slug: raw.slug as string,
    rootNodeId: raw.rootNodeId as string,
    nodes,
    template: validatePageTemplate(raw.template),
  }
}

function validateBreakpoint(raw: unknown, path: string): Breakpoint {
  assertObject(raw, path)
  assertString(raw.id, `${path}.id`)
  assertString(raw.label, `${path}.label`)
  assertNumber(raw.width, `${path}.width`)
  // icon is optional in practice
  return {
    id: raw.id as string,
    label: raw.label as string,
    width: raw.width as number,
    icon: typeof raw.icon === 'string' ? raw.icon : 'monitor',
  }
}

function validateFrameworkColorVariantOptions(raw: unknown): { enabled: boolean; count: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: true, count: DEFAULT_COLOR_VARIANT_COUNT }
  }
  const options = raw as Record<string, unknown>
  const count = typeof options.count === 'number' && isFinite(options.count)
    ? Math.max(0, Math.min(12, Math.floor(options.count)))
    : DEFAULT_COLOR_VARIANT_COUNT
  return {
    enabled: typeof options.enabled === 'boolean' ? options.enabled : true,
    count,
  }
}

function validateFrameworkColorUtilities(raw: unknown): Record<FrameworkColorUtilityType, boolean> {
  const utilities = { ...DEFAULT_FRAMEWORK_COLOR_UTILITIES }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return utilities

  for (const utility of VALID_FRAMEWORK_COLOR_UTILITIES) {
    const value = (raw as Record<string, unknown>)[utility]
    if (typeof value === 'boolean') utilities[utility] = value
  }

  return utilities
}

function validateFrameworkColorToken(
  raw: unknown,
  index: number,
): FrameworkColorToken | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const token = raw as Record<string, unknown>
  if (typeof token.id !== 'string' || token.id.trim() === '') return null
  if (typeof token.slug !== 'string' || token.slug.trim() === '') return null
  if (typeof token.lightValue !== 'string' || token.lightValue.trim() === '') return null

  const lightValue = token.lightValue.trim()
  const category = typeof token.category === 'string' ? token.category.trim() : ''

  return {
    id: token.id,
    category,
    slug: normalizeFrameworkColorSlug(token.slug),
    lightValue,
    darkValue: typeof token.darkValue === 'string' && token.darkValue.trim() !== ''
      ? token.darkValue.trim()
      : generateDefaultDarkColor(lightValue),
    darkModeEnabled: typeof token.darkModeEnabled === 'boolean' ? token.darkModeEnabled : false,
    generateUtilities: validateFrameworkColorUtilities(token.generateUtilities),
    generateTransparent: typeof token.generateTransparent === 'boolean' ? token.generateTransparent : true,
    generateShades: validateFrameworkColorVariantOptions(token.generateShades),
    generateTints: validateFrameworkColorVariantOptions(token.generateTints),
    order: typeof token.order === 'number' && isFinite(token.order) ? token.order : index,
    createdAt: typeof token.createdAt === 'number' && isFinite(token.createdAt) ? token.createdAt : Date.now(),
    updatedAt: typeof token.updatedAt === 'number' && isFinite(token.updatedAt) ? token.updatedAt : Date.now(),
  }
}

function validateFrameworkColorSettings(raw: unknown): FrameworkColorSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tokens: [] }
  }
  const colors = raw as Record<string, unknown>
  const tokens = Array.isArray(colors.tokens)
    ? colors.tokens
        .map((token, index) => validateFrameworkColorToken(token, index))
        .filter((token): token is FrameworkColorToken => token !== null)
    : []

  return { tokens }
}

function validateFrameworkPreferencesSettings(raw: unknown): FrameworkPreferencesSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const prefs = raw as Record<string, unknown>
  return {
    rootFontSize:
      typeof prefs.rootFontSize === 'number' && Number.isFinite(prefs.rootFontSize) && prefs.rootFontSize > 0
        ? prefs.rootFontSize
        : 10,
    minScreenWidth:
      typeof prefs.minScreenWidth === 'number' && Number.isFinite(prefs.minScreenWidth) && prefs.minScreenWidth > 0
        ? prefs.minScreenWidth
        : 320,
    maxScreenWidth:
      typeof prefs.maxScreenWidth === 'number' && Number.isFinite(prefs.maxScreenWidth) && prefs.maxScreenWidth > 0
        ? prefs.maxScreenWidth
        : 1400,
    isRem: typeof prefs.isRem === 'boolean' ? prefs.isRem : true,
  }
}

function validateFrameworkScaleManualSize(raw: unknown): FrameworkScaleManualSize | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return null
  if (typeof r.min !== 'number' || !Number.isFinite(r.min)) return null
  if (typeof r.max !== 'number' || !Number.isFinite(r.max)) return null
  return { id: r.id, name: r.name, min: r.min, max: r.max }
}

function validateFrameworkTypographyGroup(raw: unknown, index: number): FrameworkTypographyGroup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string' || !r.name) return null
  const min = r.min as Record<string, unknown> | undefined
  const max = r.max as Record<string, unknown> | undefined
  if (!min || !max) return null
  if (typeof min.fontSize !== 'number') return null
  if (typeof max.fontSize !== 'number') return null

  const manualSizes = Array.isArray(r.manualSizes)
    ? (r.manualSizes as unknown[])
        .map(validateFrameworkScaleManualSize)
        .filter((s): s is FrameworkScaleManualSize => s !== null)
    : undefined

  return {
    id: r.id,
    name: r.name,
    namingConvention: typeof r.namingConvention === 'string' ? r.namingConvention : 'text',
    min: {
      fontSize: min.fontSize,
      scaleRatio: typeof min.scaleRatio === 'number' || typeof min.scaleRatio === 'string' ? min.scaleRatio : 1.125,
      isCustomScaleRatio: typeof min.isCustomScaleRatio === 'boolean' ? min.isCustomScaleRatio : undefined,
      scaleRatioInputValue: typeof min.scaleRatioInputValue === 'number' ? min.scaleRatioInputValue : undefined,
    },
    max: {
      fontSize: max.fontSize,
      scaleRatio: typeof max.scaleRatio === 'number' || typeof max.scaleRatio === 'string' ? max.scaleRatio : 1.333,
      isCustomScaleRatio: typeof max.isCustomScaleRatio === 'boolean' ? max.isCustomScaleRatio : undefined,
      scaleRatioInputValue: typeof max.scaleRatioInputValue === 'number' ? max.scaleRatioInputValue : undefined,
    },
    steps: typeof r.steps === 'string' && r.steps ? r.steps : 'xs,s,m,l,xl,2xl,3xl,4xl',
    baseScaleIndex: typeof r.baseScaleIndex === 'number' && Number.isFinite(r.baseScaleIndex) ? r.baseScaleIndex : 2,
    mode: r.mode === 'fluid_manual' ? 'fluid_manual' : 'fluid',
    manualSizes,
    isDisabled: typeof r.isDisabled === 'boolean' ? r.isDisabled : undefined,
    order: typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : index,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

function validateFrameworkClassGenerator(
  raw: unknown,
): FrameworkTypographyClassGenerator | FrameworkSpacingClassGenerator | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string' || !r.name) return null
  if (typeof r.tabId !== 'string') return null
  const property = Array.isArray(r.property)
    ? (r.property as unknown[]).filter((p): p is string => typeof p === 'string' && p.length > 0)
    : []
  if (property.length === 0) return null
  return {
    id: r.id,
    name: r.name,
    property,
    tabId: r.tabId,
    isDisabled: typeof r.isDisabled === 'boolean' ? r.isDisabled : undefined,
  }
}

function validateFrameworkTypographySettings(raw: unknown): FrameworkTypographySettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const groups = Array.isArray(r.groups)
    ? (r.groups as unknown[])
        .map((g, i) => validateFrameworkTypographyGroup(g, i))
        .filter((g): g is FrameworkTypographyGroup => g !== null)
    : []
  const classes = Array.isArray(r.classes)
    ? (r.classes as unknown[])
        .map(validateFrameworkClassGenerator)
        .filter((c): c is FrameworkTypographyClassGenerator => c !== null)
    : undefined
  return {
    groups,
    classes,
    isDisabled: typeof r.isDisabled === 'boolean' ? r.isDisabled : undefined,
  }
}

function validateFrameworkSpacingGroup(raw: unknown, index: number): FrameworkSpacingGroup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string' || !r.name) return null
  const min = r.min as Record<string, unknown> | undefined
  const max = r.max as Record<string, unknown> | undefined
  if (!min || !max) return null
  if (typeof min.size !== 'number') return null
  if (typeof max.size !== 'number') return null

  const manualSizes = Array.isArray(r.manualSizes)
    ? (r.manualSizes as unknown[])
        .map(validateFrameworkScaleManualSize)
        .filter((s): s is FrameworkScaleManualSize => s !== null)
    : undefined

  return {
    id: r.id,
    name: r.name,
    namingConvention: typeof r.namingConvention === 'string' ? r.namingConvention : 'space',
    min: {
      size: min.size,
      scaleRatio: typeof min.scaleRatio === 'number' || typeof min.scaleRatio === 'string' ? min.scaleRatio : 1.25,
      isCustomScaleRatio: typeof min.isCustomScaleRatio === 'boolean' ? min.isCustomScaleRatio : undefined,
      scaleRatioInputValue: typeof min.scaleRatioInputValue === 'number' ? min.scaleRatioInputValue : undefined,
    },
    max: {
      size: max.size,
      scaleRatio: typeof max.scaleRatio === 'number' || typeof max.scaleRatio === 'string' ? max.scaleRatio : 1.414,
      isCustomScaleRatio: typeof max.isCustomScaleRatio === 'boolean' ? max.isCustomScaleRatio : undefined,
      scaleRatioInputValue: typeof max.scaleRatioInputValue === 'number' ? max.scaleRatioInputValue : undefined,
    },
    steps: typeof r.steps === 'string' && r.steps ? r.steps : '4xs,3xs,2xs,xs,s,m,l,xl,2xl,3xl,4xl',
    baseScaleIndex: typeof r.baseScaleIndex === 'number' && Number.isFinite(r.baseScaleIndex) ? r.baseScaleIndex : 5,
    mode: r.mode === 'fluid_manual' ? 'fluid_manual' : 'fluid',
    manualSizes,
    isDisabled: typeof r.isDisabled === 'boolean' ? r.isDisabled : undefined,
    order: typeof r.order === 'number' && Number.isFinite(r.order) ? r.order : index,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

function validateFrameworkSpacingSettings(raw: unknown): FrameworkSpacingSettings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const groups = Array.isArray(r.groups)
    ? (r.groups as unknown[])
        .map((g, i) => validateFrameworkSpacingGroup(g, i))
        .filter((g): g is FrameworkSpacingGroup => g !== null)
    : []
  const classes = Array.isArray(r.classes)
    ? (r.classes as unknown[])
        .map(validateFrameworkClassGenerator)
        .filter((c): c is FrameworkSpacingClassGenerator => c !== null)
    : undefined
  return {
    groups,
    classes,
    isDisabled: typeof r.isDisabled === 'boolean' ? r.isDisabled : undefined,
  }
}

function validateFrameworkSettings(raw: unknown): SiteSettings['framework'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const framework = raw as Record<string, unknown>
  return {
    colors: validateFrameworkColorSettings(framework.colors),
    typography: validateFrameworkTypographySettings(framework.typography),
    spacing: validateFrameworkSpacingSettings(framework.spacing),
    preferences: validateFrameworkPreferencesSettings(framework.preferences),
  }
}

function validateSettings(raw: unknown, path: string): SiteSettings {
  assertObject(raw, path)
  return {
    metaTitle: typeof raw.metaTitle === 'string' ? raw.metaTitle : undefined,
    metaDescription: typeof raw.metaDescription === 'string' ? raw.metaDescription : undefined,
    faviconUrl: typeof raw.faviconUrl === 'string' ? raw.faviconUrl : undefined,
    fontImportUrl: typeof raw.fontImportUrl === 'string' ? raw.fontImportUrl : undefined,
    language: typeof raw.language === 'string' ? raw.language : undefined,
    colorTokens:
      raw.colorTokens && typeof raw.colorTokens === 'object' && !Array.isArray(raw.colorTokens)
        ? (raw.colorTokens as Record<string, string>)
        : {},
    framework: validateFrameworkSettings(raw.framework),
    shortcuts:
      raw.shortcuts && typeof raw.shortcuts === 'object' && !Array.isArray(raw.shortcuts)
        ? (raw.shortcuts as Record<string, string>)
        : {},
  }
}

function validateGeneratedClassMetadata(raw: unknown): GeneratedClassMetadata | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const generated = raw as Record<string, unknown>
  if (generated.origin !== 'framework') return undefined
  if (typeof generated.sourceId !== 'string' || generated.sourceId.trim() === '') return undefined
  if (typeof generated.tokenName !== 'string' || generated.tokenName.trim() === '') return undefined
  if (generated.locked !== true) return undefined

  if (generated.family === 'color') {
    if (!VALID_FRAMEWORK_COLOR_UTILITIES.has(generated.utility as FrameworkColorUtilityType)) return undefined
    return {
      origin: 'framework',
      family: 'color',
      sourceId: generated.sourceId,
      utility: generated.utility as FrameworkColorUtilityType,
      tokenName: generated.tokenName,
      variantName: typeof generated.variantName === 'string' ? generated.variantName : undefined,
      locked: true,
    }
  }

  if (generated.family === 'typography' || generated.family === 'spacing') {
    if (typeof generated.generatorId !== 'string' || generated.generatorId.trim() === '') return undefined
    if (typeof generated.step !== 'string' || generated.step.trim() === '') return undefined
    return {
      origin: 'framework',
      family: generated.family,
      sourceId: generated.sourceId,
      generatorId: generated.generatorId,
      tokenName: generated.tokenName,
      step: generated.step,
      locked: true,
    }
  }

  return undefined
}

const VALID_FILE_TYPES: SiteFileType[] = [
  'component', 'script', 'style', 'asset', 'config', 'doc',
]

function validateSiteFile(raw: unknown, _path: string): SiteFile | null {
  void _path
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  if (typeof r.id !== 'string' || typeof r.path !== 'string') return null
  if (!VALID_FILE_TYPES.includes(r.type as SiteFileType)) return null

  // Silently discard files with unsafe paths (rather than throwing — we want
  // the validator to be lenient on individual files to avoid rejecting whole
  // projects due to one bad entry).
  const normalized = normalizePath(r.path)
  if (!isSafePath(normalized)) return null

  return {
    id: r.id,
    path: normalized,
    type: r.type as SiteFileType,
    content: typeof r.content === 'string' ? r.content : undefined,
    blob:
      r.blob &&
      typeof r.blob === 'object' &&
      !Array.isArray(r.blob) &&
      typeof (r.blob as Record<string, unknown>).mimeType === 'string' &&
      typeof (r.blob as Record<string, unknown>).base64 === 'string'
        ? {
            mimeType: (r.blob as Record<string, unknown>).mimeType as string,
            base64: (r.blob as Record<string, unknown>).base64 as string,
          }
        : undefined,
    generated: typeof r.generated === 'boolean' ? r.generated : undefined,
    ejected: typeof r.ejected === 'boolean' ? r.ejected : undefined,
    createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  }
}

// ---------------------------------------------------------------------------
// VisualComponent validator (Zod-driven, lenient per-item)
// ---------------------------------------------------------------------------

/**
 * Walk a VCNode tree and sanitize any richtext prop values.
 * Security: prevents XSS via tampered site data (Constraint #299 / Task #302).
 * Returns a new VCNode with sanitized props (does not mutate in place).
 */
function sanitizeVCNodeTree(node: VCNode): VCNode {
  const sanitizedProps: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(node.props)) {
    sanitizedProps[key] =
      isRichtextPropKey(key) && typeof val === 'string' ? sanitizeRichtext(val) : val
  }
  return {
    ...node,
    props: sanitizedProps,
    childNodes: node.childNodes?.map(sanitizeVCNodeTree),
  }
}

/**
 * Validate a single raw VisualComponent from storage.
 *
 * Returns a fully-shaped VisualComponent or null (silently drop bad entries).
 * Uses Zod for structural validation; sanitizes richtext props post-parse.
 * Self-healing: filePath is always re-derived from name to fix stale paths.
 *
 * Architecture source: Contribution #619 §9
 */
function validateVisualComponent(raw: unknown): VisualComponent | null {
  const result = VisualComponentSchema.safeParse(raw)
  if (!result.success) return null

  const vc = result.data

  // Name must pass PascalCase + reserved-word checks (drop on fail)
  const nameValidation = validateComponentName(vc.name, [])
  if (!nameValidation.ok) return null

  // filePath: always re-derive from name (self-healing, Contribution #619 §9 VP-6)
  const filePath = `src/components/${vc.name}.tsx`

  // Sanitize richtext props in the rootNode tree (security: Constraint #299)
  const rootNode = sanitizeVCNodeTree(vc.rootNode)

  return { ...vc, filePath, rootNode }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validate raw data from storage and return a typed SiteDocument, or throw
 * SiteValidationError describing exactly which field failed.
 *
 * Usage:
 * ```ts
 * const raw = await adapter.loadSite(id)
 * const site = validateSite(raw)   // throws if corrupt
 * store.loadSite(site)
 * ```
 */
export function validateSite(raw: unknown): SiteDocument {
  assertObject(raw, 'site')
  assertString(raw.id, 'site.id')
  assertString(raw.name, 'site.name')
  assertArray(raw.pages, 'site.pages')
  assertArray(raw.breakpoints, 'site.breakpoints')
  assertNumber(raw.createdAt, 'site.createdAt')
  assertNumber(raw.updatedAt, 'site.updatedAt')

  const pages: Page[] = (raw.pages as unknown[]).map((p, i) =>
    validatePage(p, `site.pages[${i}]`),
  )

  const breakpoints: Breakpoint[] = (raw.breakpoints as unknown[]).map((b, i) =>
    validateBreakpoint(b, `site.breakpoints[${i}]`),
  )

  const settings = validateSettings(raw.settings ?? {}, 'site.settings')
  const packageJson = normalizeSitePackageJson(raw.packageJson)
  const runtime = normalizeSiteRuntimeConfig(raw.runtime)

  // Validate class registry — required field, must be an object (may be empty).
  assertObject(raw.classes, 'site.classes')
  const classes: SiteDocument['classes'] = {}
  {
    for (const [id, cls] of Object.entries(raw.classes as Record<string, unknown>)) {
      if (cls && typeof cls === 'object' && !Array.isArray(cls)) {
        const c = cls as Record<string, unknown>
        if (typeof c.id === 'string' && typeof c.name === 'string') {
          const scope =
            c.scope &&
            typeof c.scope === 'object' &&
            !Array.isArray(c.scope) &&
            (c.scope as Record<string, unknown>).type === 'node' &&
            typeof (c.scope as Record<string, unknown>).nodeId === 'string'
              ? {
                  type: 'node' as const,
                  nodeId: (c.scope as Record<string, unknown>).nodeId as string,
                  role: 'module-style' as const,
                }
              : undefined
          classes[id] = {
            id: c.id as string,
            name: c.name as string,
            description: typeof c.description === 'string' ? c.description : undefined,
            scope,
            styles: (c.styles && typeof c.styles === 'object' && !Array.isArray(c.styles) ? c.styles : {}) as Record<string, unknown>,
            breakpointStyles: (c.breakpointStyles && typeof c.breakpointStyles === 'object' && !Array.isArray(c.breakpointStyles) ? c.breakpointStyles : {}) as Record<string, Record<string, unknown>>,
            tags: Array.isArray(c.tags) ? (c.tags as string[]).filter((t) => typeof t === 'string') : undefined,
            generated: validateGeneratedClassMetadata(c.generated),
            createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
            updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
          }
        }
      }
    }
  }

  // Must have at least one page
  if (pages.length === 0) {
    throw new SiteValidationError('site must have at least one page', 'site.pages')
  }

  for (let i = 0; i < pages.length; i++) {
    const slugError = pageSlugError(pages[i].slug)
    if (slugError) throw new SiteValidationError(slugError, `site.pages[${i}].slug`)

    const duplicateError = pageSlugDuplicateError(pages[i].slug, pages, pages[i].id)
    if (duplicateError) {
      throw new SiteValidationError(`duplicate slug: ${duplicateError}`, `site.pages[${i}].slug`)
    }
  }

  // Validate files[] — required field. Individual files with unsafe paths are
  // silently dropped rather than rejecting the whole site. Duplicate paths are
  // deduplicated (last-write-wins on the normalized path).
  assertArray(raw.files, 'site.files')
  const files: SiteFile[] = []
  {
    const seenPaths = new Set<string>()
    for (let i = 0; i < raw.files.length; i++) {
      const file = validateSiteFile(raw.files[i], `site.files[${i}]`)
      if (file === null) continue
      if (seenPaths.has(file.path)) continue // deduplicate
      seenPaths.add(file.path)
      files.push(file)
    }
  }

  // Validate visualComponents[] — required field. Individual VCs with invalid
  // names are silently dropped. Duplicate names are deduplicated (first-wins).
  // filePath is always re-derived from name (self-healing).
  assertArray(raw.visualComponents, 'site.visualComponents')
  const visualComponents: VisualComponent[] = []
  {
    const seenNames = new Set<string>()
    for (let i = 0; i < raw.visualComponents.length; i++) {
      const vc = validateVisualComponent(raw.visualComponents[i])
      if (vc === null) continue
      if (seenNames.has(vc.name)) continue // first-wins deduplication
      seenNames.add(vc.name)
      visualComponents.push(vc)
    }
  }

  return {
    id: raw.id as string,
    name: raw.name as string,
    pages,
    files,
    visualComponents,
    packageJson,
    runtime,
    breakpoints,
    settings,
    classes,
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number,
  }
}
