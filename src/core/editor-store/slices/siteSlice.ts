import { produce } from 'immer'
import { nanoid } from 'nanoid'
import type { StateCreator } from 'zustand'
import type { EditorStore } from '../store'
import { renderCache } from '@core/engine/renderCache'
import { registry } from '@core/module-engine/registry'
import {
  type SiteDocument,
  type Page,
  type PageNode,
  type Breakpoint,
  type SiteSettings,
  type PageTemplateConfig,
  type DynamicPropBinding,
  type FrameworkColorToken,
  type FrameworkColorUtilityType,
  type FrameworkPreferencesSettings,
  type FrameworkScaleManualSize,
  type FrameworkScaleMode,
  type FrameworkSpacingClassGenerator,
  type FrameworkSpacingGroup,
  type FrameworkTypographyClassGenerator,
  type FrameworkTypographyGroup,
  DEFAULT_BREAKPOINTS,
  DEFAULT_SITE_SETTINGS,
  createNode,
  addPage,
  deletePage,
  renamePage,
  reorderPages,
  insertNode,
  deleteNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  moveNode,
  duplicateNode,
  wrapNode,
} from '@core/page-tree'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import {
  cloneSiteRuntimeConfig,
  DEFAULT_SITE_RUNTIME,
} from '@core/site-runtime'
import {
  generateDefaultDarkColor,
  generateFrameworkColorUtilityClasses,
  normalizeFrameworkColorSlug,
} from '@core/framework/colors'
import { generateFrameworkTypographyUtilityClasses } from '@core/framework/typography'
import { generateFrameworkSpacingUtilityClasses } from '@core/framework/spacing'
import {
  buildDefaultSpacingGroup,
  buildDefaultTypographyGroup,
  makeFreshSpacingGroup,
  makeFreshTypographyGroup,
  nextSpacingTabValues,
  nextTypographyTabValues,
} from '@core/framework/defaults'

/** Maximum undo history depth — prevents unbounded memory growth */
const MAX_HISTORY = 50

export interface SiteSlice {
  site: SiteDocument | null

  // SiteDocument lifecycle
  createSite: (name: string) => SiteDocument
  loadSite: (site: SiteDocument) => void
  clearSite: () => void
  updateSiteName: (name: string) => void

  // Page mutations
  addPage: (title: string, slug?: string) => Page
  deletePage: (pageId: string) => void
  renamePage: (pageId: string, title: string, slug?: string) => void
  reorderPages: (fromIndex: number, toIndex: number) => void
  convertPageToTemplate: (pageId: string, config: PageTemplateConfig) => void
  convertTemplateToPage: (pageId: string) => void

  // Node mutations (operate on the active page)
  insertNode: (moduleId: string, defaults: Record<string, unknown>, parentId: string, index?: number) => string
  deleteNode: (nodeId: string) => void
  updateNodeProps: (nodeId: string, patch: Record<string, unknown>) => void
  setBreakpointOverride: (nodeId: string, breakpointId: string, patch: Record<string, unknown>) => void
  clearBreakpointOverride: (nodeId: string, breakpointId: string) => void
  renameNode: (nodeId: string, label: string) => void
  toggleNodeLocked: (nodeId: string) => void
  toggleNodeHidden: (nodeId: string) => void
  moveNode: (nodeId: string, newParentId: string, newIndex: number) => void
  duplicateNode: (nodeId: string) => string
  wrapNode: (nodeId: string, containerModuleId: string, defaults?: Record<string, unknown>) => string
  setNodeDynamicBinding: (nodeId: string, propKey: string, binding: DynamicPropBinding) => void
  clearNodeDynamicBinding: (nodeId: string, propKey: string) => void

  // Breakpoint mutations
  addBreakpoint: (bp: Omit<Breakpoint, 'id'>) => Breakpoint
  updateBreakpoint: (id: string, patch: Partial<Omit<Breakpoint, 'id'>>) => void
  removeBreakpoint: (id: string) => void
  reorderBreakpoints: (fromIndex: number, toIndex: number) => void

  // SiteDocument settings mutations
  updateSiteSettings: (patch: Partial<SiteSettings>) => void

  // Framework color mutations
  createFrameworkColorToken: (input: CreateFrameworkColorTokenInput) => FrameworkColorToken
  updateFrameworkColorToken: (tokenId: string, patch: UpdateFrameworkColorTokenPatch) => void
  duplicateFrameworkColorToken: (tokenId: string) => FrameworkColorToken | null
  reorderFrameworkColorToken: (tokenId: string, direction: 'up' | 'down') => void
  deleteFrameworkColorToken: (tokenId: string) => void

  // Framework preferences
  updateFrameworkPreferences: (patch: Partial<FrameworkPreferencesSettings>) => void

  // Framework typography mutations
  toggleFrameworkTypographyDisabled: () => void
  createFrameworkTypographyGroup: () => FrameworkTypographyGroup
  updateFrameworkTypographyGroup: (groupId: string, patch: UpdateFrameworkTypographyGroupPatch) => void
  duplicateFrameworkTypographyGroup: (groupId: string) => FrameworkTypographyGroup | null
  resetFrameworkTypographyGroup: (groupId: string) => void
  deleteFrameworkTypographyGroup: (groupId: string) => void
  upsertFrameworkTypographyManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<FrameworkScaleManualSize>,
  ) => void
  setFrameworkTypographyClassGenerators: (classes: FrameworkTypographyClassGenerator[]) => void

  // Framework spacing mutations
  toggleFrameworkSpacingDisabled: () => void
  createFrameworkSpacingGroup: () => FrameworkSpacingGroup
  updateFrameworkSpacingGroup: (groupId: string, patch: UpdateFrameworkSpacingGroupPatch) => void
  duplicateFrameworkSpacingGroup: (groupId: string) => FrameworkSpacingGroup | null
  resetFrameworkSpacingGroup: (groupId: string) => void
  deleteFrameworkSpacingGroup: (groupId: string) => void
  upsertFrameworkSpacingManualSize: (
    groupId: string,
    sizeId: string,
    patch: Partial<FrameworkScaleManualSize>,
  ) => void
  setFrameworkSpacingClassGenerators: (classes: FrameworkSpacingClassGenerator[]) => void

  // ─── Undo / Redo ──────────────────────────────────────────────────────────
  /** Snapshots of previous site states — most recent last */
  _historyPast: SiteDocument[]
  /** Snapshots popped by undo, available for redo — most recent last */
  _historyFuture: SiteDocument[]
  /** True if there's at least one state to undo to */
  canUndo: boolean
  /** True if there's at least one state to redo to */
  canRedo: boolean
  undo: () => void
  redo: () => void
  /**
   * Call before any undoable mutation to snapshot the current site.
   * Exposed so external code (e.g., batch operations) can manage history.
   */
  pushHistory: () => void
}

type ColorVariantOptions = { enabled: boolean; count: number }

interface CreateFrameworkColorTokenInput {
  category?: string
  slug: string
  lightValue: string
  darkValue?: string
  darkModeEnabled?: boolean
  generateUtilities?: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent?: boolean
  generateShades?: Partial<ColorVariantOptions>
  generateTints?: Partial<ColorVariantOptions>
}

type UpdateFrameworkColorTokenPatch = Partial<{
  category: string
  slug: string
  lightValue: string
  darkValue: string
  darkModeEnabled: boolean
  generateUtilities: Partial<Record<FrameworkColorUtilityType, boolean>>
  generateTransparent: boolean
  generateShades: Partial<ColorVariantOptions>
  generateTints: Partial<ColorVariantOptions>
  order: number
}>

export type UpdateFrameworkTypographyGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  /** Patch into the `min` breakpoint config — fields are merged, untouched fields preserved. */
  min: Partial<FrameworkTypographyGroup['min']>
  max: Partial<FrameworkTypographyGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

export type UpdateFrameworkSpacingGroupPatch = Partial<{
  name: string
  namingConvention: string
  steps: string
  baseScaleIndex: number
  mode: FrameworkScaleMode
  isDisabled: boolean
  min: Partial<FrameworkSpacingGroup['min']>
  max: Partial<FrameworkSpacingGroup['max']>
  manualSizes: FrameworkScaleManualSize[]
}>

function createDefaultSiteDocument(name: string): SiteDocument {
  const rootNode = createNode('base.root')
  const homePage: Page = {
    id: nanoid(),
    title: 'Home',
    slug: 'index',
    rootNodeId: rootNode.id,
    nodes: { [rootNode.id]: rootNode },
  }
  return {
    id: nanoid(),
    name,
    pages: [homePage],
    files: [],             // Contribution #595 — files data layer
    visualComponents: [],  // Contribution #619 — visual components data layer
    packageJson: clonePackageJson(DEFAULT_SITE_PACKAGE_JSON),
    runtime: cloneSiteRuntimeConfig(DEFAULT_SITE_RUNTIME),
    breakpoints: DEFAULT_BREAKPOINTS,
    settings: structuredClone(DEFAULT_SITE_SETTINGS),
    classes: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

const DEFAULT_COLOR_UTILITIES: Record<FrameworkColorUtilityType, boolean> = {
  text: true,
  background: true,
  border: true,
  fill: false,
}

const DEFAULT_COLOR_VARIANTS: ColorVariantOptions = { enabled: true, count: 4 }

function ensureFrameworkColors(site: SiteDocument): NonNullable<SiteSettings['framework']>['colors'] {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  if (!site.settings.framework.colors) {
    site.settings.framework.colors = { tokens: [] }
  }
  site.settings.framework.colors.tokens ??= []
  return site.settings.framework.colors
}

function normalizeCategoryLabel(input: string | undefined | null): string {
  return typeof input === 'string' ? input.trim() : ''
}

/**
 * Match a new category label against existing tokens case-insensitively.
 * If any other token already uses a category with the same letters (regardless
 * of case), the canonical casing of that existing label wins — this prevents
 * "Brand" and "brand" from drifting into separate categories when the user
 * forgets the original capitalization.
 */
function canonicalizeCategoryLabel(
  input: string | undefined | null,
  tokens: FrameworkColorToken[],
  excludeTokenId?: string,
): string {
  const trimmed = normalizeCategoryLabel(input)
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  for (const token of tokens) {
    if (token.id === excludeTokenId) continue
    const existing = token.category.trim()
    if (existing && existing.toLowerCase() === lower) return existing
  }
  return trimmed
}

function nextOrder(items: Array<{ order: number }>): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1) + 1
}

function uniqueColorSlug(
  tokens: FrameworkColorToken[],
  desiredSlug: string,
  excludeTokenId?: string,
): string {
  const base = normalizeFrameworkColorSlug(desiredSlug)
  const existing = new Set(
    tokens
      .filter((token) => token.id !== excludeTokenId)
      .map((token) => normalizeFrameworkColorSlug(token.slug)),
  )
  if (!existing.has(base)) return base

  let suffix = 2
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}

function createFrameworkColorTokenFromInput(
  input: CreateFrameworkColorTokenInput,
  colors: NonNullable<SiteSettings['framework']>['colors'],
): FrameworkColorToken {
  const now = Date.now()
  const lightValue = input.lightValue.trim()
  return {
    id: nanoid(),
    category: canonicalizeCategoryLabel(input.category, colors.tokens),
    slug: uniqueColorSlug(colors.tokens, input.slug),
    lightValue,
    darkValue: input.darkValue?.trim() || generateDefaultDarkColor(lightValue),
    darkModeEnabled: input.darkModeEnabled ?? false,
    generateUtilities: {
      ...DEFAULT_COLOR_UTILITIES,
      ...(input.generateUtilities ?? {}),
    },
    generateTransparent: input.generateTransparent ?? true,
    generateShades: {
      ...DEFAULT_COLOR_VARIANTS,
      ...(input.generateShades ?? {}),
    },
    generateTints: {
      ...DEFAULT_COLOR_VARIANTS,
      ...(input.generateTints ?? {}),
    },
    order: nextOrder(colors.tokens),
    createdAt: now,
    updatedAt: now,
  }
}

function applyFrameworkColorTokenPatch(
  token: FrameworkColorToken,
  patch: UpdateFrameworkColorTokenPatch,
  colors: NonNullable<SiteSettings['framework']>['colors'],
): void {
  if (patch.category !== undefined) {
    token.category = canonicalizeCategoryLabel(patch.category, colors.tokens, token.id)
  }
  if (patch.slug !== undefined) token.slug = uniqueColorSlug(colors.tokens, patch.slug, token.id)
  if (patch.lightValue !== undefined) token.lightValue = patch.lightValue.trim()
  if (patch.darkValue !== undefined) token.darkValue = patch.darkValue.trim()
  if (patch.darkModeEnabled !== undefined) {
    token.darkModeEnabled = patch.darkModeEnabled
    if (patch.darkModeEnabled && !patch.darkValue && !token.darkValue) {
      token.darkValue = generateDefaultDarkColor(token.lightValue)
    }
  }
  if (patch.generateUtilities) {
    token.generateUtilities = {
      ...token.generateUtilities,
      ...patch.generateUtilities,
    }
  }
  if (patch.generateTransparent !== undefined) token.generateTransparent = patch.generateTransparent
  if (patch.generateShades) {
    token.generateShades = { ...token.generateShades, ...patch.generateShades }
  }
  if (patch.generateTints) {
    token.generateTints = { ...token.generateTints, ...patch.generateTints }
  }
  if (patch.order !== undefined) token.order = patch.order
  token.updatedAt = Date.now()
}

function cloneFrameworkColorToken(
  token: FrameworkColorToken,
  colors: NonNullable<SiteSettings['framework']>['colors'],
): FrameworkColorToken {
  const now = Date.now()
  return {
    ...structuredClone(token),
    id: nanoid(),
    slug: uniqueColorSlug(colors.tokens, `${token.slug}-copy`),
    order: nextOrder(colors.tokens),
    createdAt: now,
    updatedAt: now,
  }
}

function reorderFrameworkColorTokenInGroup(
  colors: NonNullable<SiteSettings['framework']>['colors'],
  tokenId: string,
  direction: 'up' | 'down',
): void {
  const token = colors.tokens.find((candidate) => candidate.id === tokenId)
  if (!token) return

  const group = colors.tokens
    .filter((candidate) => candidate.category === token.category)
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
  const currentIndex = group.findIndex((candidate) => candidate.id === tokenId)
  const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1
  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= group.length) return

  const orderValues = group.map((candidate) => candidate.order).sort((a, b) => a - b)
  const reordered = [...group]
  const [moved] = reordered.splice(currentIndex, 1)
  reordered.splice(targetIndex, 0, moved)

  for (let index = 0; index < reordered.length; index += 1) {
    reordered[index].order = orderValues[index] ?? index
    reordered[index].updatedAt = Date.now()
  }
}

function isGeneratedColorClassId(id: string, site: SiteDocument): boolean {
  return site.classes[id]?.generated?.origin === 'framework' && site.classes[id]?.generated?.family === 'color'
}

function pruneClassIdFromNodes(site: SiteDocument, classId: string): void {
  for (const page of site.pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.classIds?.includes(classId)) {
        node.classIds = node.classIds.filter((id) => id !== classId)
      }
    }
  }
}

function reconcileFrameworkColorClasses(site: SiteDocument): void {
  const colors = ensureFrameworkColors(site)
  const nextClasses = generateFrameworkColorUtilityClasses(colors)
  const nextClassIds = new Set(Object.keys(nextClasses))

  for (const classId of Object.keys(site.classes)) {
    if (!isGeneratedColorClassId(classId, site)) continue
    if (nextClassIds.has(classId)) continue
    delete site.classes[classId]
    pruneClassIdFromNodes(site, classId)
  }

  for (const [classId, nextClass] of Object.entries(nextClasses)) {
    const existing = site.classes[classId]
    site.classes[classId] = {
      ...nextClass,
      createdAt: existing?.createdAt ?? nextClass.createdAt,
    }
  }
}

function ensureFrameworkTypography(
  site: SiteDocument,
): NonNullable<NonNullable<SiteSettings['framework']>['typography']> {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  if (!site.settings.framework.typography) {
    site.settings.framework.typography = { groups: [], classes: [] }
  }
  site.settings.framework.typography.groups ??= []
  site.settings.framework.typography.classes ??= []
  return site.settings.framework.typography
}

function ensureFrameworkSpacing(
  site: SiteDocument,
): NonNullable<NonNullable<SiteSettings['framework']>['spacing']> {
  if (!site.settings.framework) {
    site.settings.framework = { colors: { tokens: [] } }
  }
  if (!site.settings.framework.spacing) {
    site.settings.framework.spacing = { groups: [], classes: [] }
  }
  site.settings.framework.spacing.groups ??= []
  site.settings.framework.spacing.classes ??= []
  return site.settings.framework.spacing
}

function nextOrderValue(items: Array<{ order: number }>): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1) + 1
}

function applyFrameworkTypographyGroupPatch(
  group: FrameworkTypographyGroup,
  patch: UpdateFrameworkTypographyGroupPatch,
): void {
  if (patch.name !== undefined) group.name = patch.name
  if (patch.namingConvention !== undefined) group.namingConvention = patch.namingConvention
  if (patch.steps !== undefined) group.steps = patch.steps
  if (patch.baseScaleIndex !== undefined) group.baseScaleIndex = patch.baseScaleIndex
  if (patch.mode !== undefined) group.mode = patch.mode
  if (patch.isDisabled !== undefined) group.isDisabled = patch.isDisabled
  if (patch.min) group.min = { ...group.min, ...patch.min }
  if (patch.max) group.max = { ...group.max, ...patch.max }
  if (patch.manualSizes !== undefined) group.manualSizes = patch.manualSizes
  group.updatedAt = Date.now()
}

function applyFrameworkSpacingGroupPatch(
  group: FrameworkSpacingGroup,
  patch: UpdateFrameworkSpacingGroupPatch,
): void {
  if (patch.name !== undefined) group.name = patch.name
  if (patch.namingConvention !== undefined) group.namingConvention = patch.namingConvention
  if (patch.steps !== undefined) group.steps = patch.steps
  if (patch.baseScaleIndex !== undefined) group.baseScaleIndex = patch.baseScaleIndex
  if (patch.mode !== undefined) group.mode = patch.mode
  if (patch.isDisabled !== undefined) group.isDisabled = patch.isDisabled
  if (patch.min) group.min = { ...group.min, ...patch.min }
  if (patch.max) group.max = { ...group.max, ...patch.max }
  if (patch.manualSizes !== undefined) group.manualSizes = patch.manualSizes
  group.updatedAt = Date.now()
}

function isGeneratedTypographyClassId(id: string, site: SiteDocument): boolean {
  return (
    site.classes[id]?.generated?.origin === 'framework' &&
    site.classes[id]?.generated?.family === 'typography'
  )
}

function isGeneratedSpacingClassId(id: string, site: SiteDocument): boolean {
  return (
    site.classes[id]?.generated?.origin === 'framework' &&
    site.classes[id]?.generated?.family === 'spacing'
  )
}

function reconcileFrameworkTypographyClasses(site: SiteDocument): void {
  const typography = ensureFrameworkTypography(site)
  const nextClasses = generateFrameworkTypographyUtilityClasses(typography)
  const nextClassIds = new Set(Object.keys(nextClasses))

  for (const classId of Object.keys(site.classes)) {
    if (!isGeneratedTypographyClassId(classId, site)) continue
    if (nextClassIds.has(classId)) continue
    delete site.classes[classId]
    pruneClassIdFromNodes(site, classId)
  }

  for (const [classId, nextClass] of Object.entries(nextClasses)) {
    const existing = site.classes[classId]
    site.classes[classId] = {
      ...nextClass,
      createdAt: existing?.createdAt ?? nextClass.createdAt,
    }
  }
}

function reconcileFrameworkSpacingClasses(site: SiteDocument): void {
  const spacing = ensureFrameworkSpacing(site)
  const nextClasses = generateFrameworkSpacingUtilityClasses(spacing)
  const nextClassIds = new Set(Object.keys(nextClasses))

  for (const classId of Object.keys(site.classes)) {
    if (!isGeneratedSpacingClassId(classId, site)) continue
    if (nextClassIds.has(classId)) continue
    delete site.classes[classId]
    pruneClassIdFromNodes(site, classId)
  }

  for (const [classId, nextClass] of Object.entries(nextClasses)) {
    const existing = site.classes[classId]
    site.classes[classId] = {
      ...nextClass,
      createdAt: existing?.createdAt ?? nextClass.createdAt,
    }
  }
}

function clearDynamicBindingsFromNode(node: PageNode): void {
  delete node.dynamicBindings
  for (const child of node.childNodes ?? []) {
    clearDynamicBindingsFromNode(child)
  }
}

export const createSiteSlice: StateCreator<EditorStore, [], [], SiteSlice> = (set, get) => {
  // ---------------------------------------------------------------------------
  // Internal helpers — note: these use `get()` before calling set() so they
  // can snapshot the current site for history.
  // ---------------------------------------------------------------------------

  /** Snapshot current site into undo history, then clear redo stack. */
  function pushHistory(): void {
    const { site } = get()
    if (!site) return
    set(
      produce((state: EditorStore) => {
        const snapshot = structuredClone(site)
        state._historyPast.push(snapshot)
        if (state._historyPast.length > MAX_HISTORY) {
          state._historyPast.shift() // evict oldest
        }
        state._historyFuture = []
        state.canUndo = true
        state.canRedo = false
      })
    )
  }

  /** Mutate the active page — auto-snapshots history first. */
  function mutatePage(fn: (page: Page) => void): void {
    pushHistory()
    set(
      produce((state: EditorStore) => {
        if (!state.site) return
        const page = state.site.pages.find((p) => p.id === state.activePageId)
        if (!page) return
        fn(page)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
      })
    )
  }

  /** Mutate the site — auto-snapshots history first. */
  function mutateSite(fn: (site: SiteDocument) => void): void {
    pushHistory()
    set(
      produce((state: EditorStore) => {
        if (!state.site) return
        fn(state.site)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
      })
    )
  }

  return {
    site: null,

    // ─── Undo / Redo ─────────────────────────────────────────────────────────
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,

    pushHistory,

    undo: () => {
      const { _historyPast, site } = get()
      if (_historyPast.length === 0 || !site) return
      const previous = _historyPast[_historyPast.length - 1]
      set(
        produce((state: EditorStore) => {
          state._historyPast.pop()
          state._historyFuture.push(structuredClone(site))
          const packageJson = clonePackageJson(previous.packageJson)
          const siteRuntime = cloneSiteRuntimeConfig(previous.runtime)
          state.site = { ...previous, packageJson, runtime: siteRuntime }
          state.packageJson = packageJson
          state.siteRuntime = siteRuntime
          state.canUndo = state._historyPast.length > 0
          state.canRedo = true
          state.hasUnsavedChanges = true
          // Keep activePageId valid
          if (!state.site.pages.find((p) => p.id === state.activePageId)) {
            state.activePageId = state.site.pages[0]?.id ?? null
          }
        })
      )
    },

    redo: () => {
      const { _historyFuture, site } = get()
      if (_historyFuture.length === 0 || !site) return
      const next = _historyFuture[_historyFuture.length - 1]
      set(
        produce((state: EditorStore) => {
          state._historyFuture.pop()
          state._historyPast.push(structuredClone(site))
          const packageJson = clonePackageJson(next.packageJson)
          const siteRuntime = cloneSiteRuntimeConfig(next.runtime)
          state.site = { ...next, packageJson, runtime: siteRuntime }
          state.packageJson = packageJson
          state.siteRuntime = siteRuntime
          state.canUndo = true
          state.canRedo = state._historyFuture.length > 0
          state.hasUnsavedChanges = true
          // Keep activePageId valid
          if (!state.site.pages.find((p) => p.id === state.activePageId)) {
            state.activePageId = state.site.pages[0]?.id ?? null
          }
        })
      )
    },

    // ─── SiteDocument lifecycle ────────────────────────────────────────────────────
    createSite: (name) => {
      const site = createDefaultSiteDocument(name)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      set({
        site: { ...site, runtime: siteRuntime },
        packageJson: clonePackageJson(site.packageJson),
        siteRuntime,
        activePageId: site.pages[0].id,
        _historyPast: [],
        _historyFuture: [],
        canUndo: false,
        canRedo: false,
        hasUnsavedChanges: false,
      })
      return site
    },

    loadSite: (site) => {
      // Clear the render cache BEFORE store hydration so stale HTML from a previous
      // site cannot bleed into the canvas after switching projects.
      // (Guideline #307 / Architect message #1216 — critical integration note)
      renderCache.clear()
      if (site.settings.framework?.colors) {
        reconcileFrameworkColorClasses(site)
      }
      if (site.settings.framework?.typography) {
        reconcileFrameworkTypographyClasses(site)
      }
      if (site.settings.framework?.spacing) {
        reconcileFrameworkSpacingClasses(site)
      }
      const packageJson = clonePackageJson(site.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      set({
        site: { ...site, packageJson, runtime: siteRuntime },
        packageJson,
        siteRuntime,
        activePageId: site.pages[0]?.id ?? null,
        _historyPast: [],
        _historyFuture: [],
        canUndo: false,
        canRedo: false,
        hasUnsavedChanges: false,
      })
    },

    clearSite: () => {
      set({
        site: null,
        packageJson: clonePackageJson(DEFAULT_SITE_PACKAGE_JSON),
        siteRuntime: cloneSiteRuntimeConfig(DEFAULT_SITE_RUNTIME),
        activePageId: null,
        selectedNodeId: null,
        _historyPast: [],
        _historyFuture: [],
        canUndo: false,
        canRedo: false,
      })
    },

    updateSiteName: (name) => {
      mutateSite((p) => { p.name = name })
    },

    // ─── Page mutations ───────────────────────────────────────────────────────
    addPage: (title, slug) => {
      let newPage!: Page
      mutateSite((p) => {
        newPage = addPage(p, title, slug ?? title)
      })
      set({ activePageId: newPage.id })
      return newPage
    },

    deletePage: (pageId) => {
      mutateSite((p) => deletePage(p, pageId))
      const { site, activePageId } = get()
      if (activePageId === pageId && site) {
        set({ activePageId: site.pages[0]?.id ?? null })
      }
    },

    renamePage: (pageId, title, slug) => {
      mutateSite((p) => renamePage(p, pageId, title, slug))
    },

    reorderPages: (fromIndex, toIndex) => {
      mutateSite((p) => reorderPages(p, fromIndex, toIndex))
    },

    convertPageToTemplate: (pageId, config) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return
        page.template = config
      })
    },

    convertTemplateToPage: (pageId) => {
      mutateSite((site) => {
        const page = site.pages.find((candidate) => candidate.id === pageId)
        if (!page) return
        delete page.template
        for (const node of Object.values(page.nodes)) {
          clearDynamicBindingsFromNode(node)
        }
      })
    },

    // ─── Node mutations ───────────────────────────────────────────────────────
    insertNode: (moduleId, defaults, parentId, index) => {
      const mod = registry.get(moduleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      const newNode = createNode(moduleId, resolvedDefaults)
      mutatePage((page) => insertNode(page, newNode, parentId, index))
      return newNode.id
    },

    deleteNode: (nodeId) => {
      mutatePage((page) => deleteNode(page, nodeId))
      if (get().selectedNodeId === nodeId) set({ selectedNodeId: null })
    },

    updateNodeProps: (nodeId, patch) => {
      mutatePage((page) => updateNodeProps(page, nodeId, patch))
    },

    setBreakpointOverride: (nodeId, breakpointId, patch) => {
      mutatePage((page) => setBreakpointOverride(page, nodeId, breakpointId, patch))
    },

    clearBreakpointOverride: (nodeId, breakpointId) => {
      mutatePage((page) => clearBreakpointOverride(page, nodeId, breakpointId))
    },

    renameNode: (nodeId, label) => {
      mutatePage((page) => renameNode(page, nodeId, label))
    },

    toggleNodeLocked: (nodeId) => {
      mutatePage((page) => toggleNodeLocked(page, nodeId))
    },

    toggleNodeHidden: (nodeId) => {
      mutatePage((page) => toggleNodeHidden(page, nodeId))
    },

    moveNode: (nodeId, newParentId, newIndex) => {
      mutatePage((page) => moveNode(page, nodeId, newParentId, newIndex))
    },

    duplicateNode: (nodeId) => {
      let newId = ''
      mutatePage((page) => { newId = duplicateNode(page, nodeId) })
      return newId
    },

    wrapNode: (nodeId, containerModuleId, defaults = {}) => {
      // Auto-resolve the module's schema defaults so the wrapper node renders correctly.
      // Without this, wrapNode(id, 'base.container') produces props:{} → props.tag=undefined
      // → React.createElement(undefined) → "Element type is invalid" crash (Task #414).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId = ''
      mutatePage((page) => { wrapperId = wrapNode(page, nodeId, containerModuleId, resolvedDefaults) })
      return wrapperId
    },

    setNodeDynamicBinding: (nodeId, propKey, binding) => {
      mutatePage((page) => {
        const node = page.nodes[nodeId]
        if (!node) return
        node.dynamicBindings = {
          ...(node.dynamicBindings ?? {}),
          [propKey]: binding,
        }
      })
    },

    clearNodeDynamicBinding: (nodeId, propKey) => {
      mutatePage((page) => {
        const node = page.nodes[nodeId]
        if (!node?.dynamicBindings) return
        delete node.dynamicBindings[propKey]
        if (Object.keys(node.dynamicBindings).length === 0) {
          delete node.dynamicBindings
        }
      })
    },

    // ─── Breakpoint mutations ─────────────────────────────────────────────────
    addBreakpoint: (bp) => {
      const newBp: Breakpoint = { ...bp, id: nanoid(8) }
      mutateSite((p) => { p.breakpoints.push(newBp) })
      return newBp
    },

    updateBreakpoint: (id, patch) => {
      mutateSite((p) => {
        const idx = p.breakpoints.findIndex((b) => b.id === id)
        if (idx !== -1) Object.assign(p.breakpoints[idx], patch)
      })
    },

    removeBreakpoint: (id) => {
      mutateSite((p) => {
        p.breakpoints = p.breakpoints.filter((b) => b.id !== id)
      })
      // If the active breakpoint was removed, fall back to desktop
      if (get().activeBreakpointId === id) {
        set({ activeBreakpointId: 'desktop' })
      }
    },

    reorderBreakpoints: (fromIndex, toIndex) => {
      mutateSite((p) => {
        const [item] = p.breakpoints.splice(fromIndex, 1)
        p.breakpoints.splice(toIndex, 0, item)
      })
    },

    // ─── SiteDocument settings mutations ───────────────────────────────────────────
    updateSiteSettings: (patch) => {
      mutateSite((p) => {
        Object.assign(p.settings, patch)
      })
    },

    createFrameworkColorToken: (input) => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      const token = createFrameworkColorTokenFromInput(input, ensureFrameworkColors(site))

      mutateSite((draftSite) => {
        const colors = ensureFrameworkColors(draftSite)
        colors.tokens.push(token)
        reconcileFrameworkColorClasses(draftSite)
      })

      return token
    },

    updateFrameworkColorToken: (tokenId, patch) => {
      mutateSite((site) => {
        const colors = ensureFrameworkColors(site)
        const token = colors.tokens.find((candidate) => candidate.id === tokenId)
        if (!token) return
        applyFrameworkColorTokenPatch(token, patch, colors)
        reconcileFrameworkColorClasses(site)
      })
    },

    duplicateFrameworkColorToken: (tokenId) => {
      const { site } = get()
      if (!site) return null
      const colors = ensureFrameworkColors(site)
      const token = colors.tokens.find((candidate) => candidate.id === tokenId)
      if (!token) return null
      const copy = cloneFrameworkColorToken(token, colors)

      mutateSite((draftSite) => {
        const draftColors = ensureFrameworkColors(draftSite)
        draftColors.tokens.push(copy)
        reconcileFrameworkColorClasses(draftSite)
      })

      return copy
    },

    reorderFrameworkColorToken: (tokenId, direction) => {
      mutateSite((site) => {
        const colors = ensureFrameworkColors(site)
        reorderFrameworkColorTokenInGroup(colors, tokenId, direction)
        reconcileFrameworkColorClasses(site)
      })
    },

    deleteFrameworkColorToken: (tokenId) => {
      mutateSite((site) => {
        const colors = ensureFrameworkColors(site)
        colors.tokens = colors.tokens.filter((token) => token.id !== tokenId)
        reconcileFrameworkColorClasses(site)
      })
    },

    // ─── Framework preferences ───────────────────────────────────────────────
    updateFrameworkPreferences: (patch) => {
      mutateSite((site) => {
        if (!site.settings.framework) {
          site.settings.framework = { colors: { tokens: [] } }
        }
        const current = site.settings.framework.preferences ?? {
          rootFontSize: 10,
          minScreenWidth: 320,
          maxScreenWidth: 1400,
          isRem: true,
        }
        site.settings.framework.preferences = { ...current, ...patch }
      })
    },

    // ─── Framework typography ───────────────────────────────────────────────
    toggleFrameworkTypographyDisabled: () => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        typography.isDisabled = !typography.isDisabled
        reconcileFrameworkTypographyClasses(site)
      })
    },

    createFrameworkTypographyGroup: () => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      const typography = ensureFrameworkTypography(site)
      const { name, varName } = nextTypographyTabValues(typography.groups)
      const order = nextOrderValue(typography.groups)
      const group = makeFreshTypographyGroup(name, varName, order)

      mutateSite((draftSite) => {
        const draftTypography = ensureFrameworkTypography(draftSite)
        draftTypography.groups.push(group)
        reconcileFrameworkTypographyClasses(draftSite)
      })
      return group
    },

    updateFrameworkTypographyGroup: (groupId, patch) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        const group = typography.groups.find((g) => g.id === groupId)
        if (!group) return
        applyFrameworkTypographyGroupPatch(group, patch)
        reconcileFrameworkTypographyClasses(site)
      })
    },

    duplicateFrameworkTypographyGroup: (groupId) => {
      const { site } = get()
      if (!site) return null
      const typography = ensureFrameworkTypography(site)
      const source = typography.groups.find((g) => g.id === groupId)
      if (!source) return null

      const { name, varName } = nextTypographyTabValues(typography.groups)
      const order = nextOrderValue(typography.groups)
      const now = Date.now()
      const copy: FrameworkTypographyGroup = {
        ...structuredClone(source),
        id: nanoid(),
        name,
        namingConvention: varName,
        manualSizes: source.manualSizes?.map((m) => ({
          ...m,
          id: nanoid(),
          name: m.name.replace(source.namingConvention, varName),
        })),
        order,
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((draftSite) => {
        const draftTypography = ensureFrameworkTypography(draftSite)
        draftTypography.groups.push(copy)
        reconcileFrameworkTypographyClasses(draftSite)
      })
      return copy
    },

    resetFrameworkTypographyGroup: (groupId) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        const idx = typography.groups.findIndex((g) => g.id === groupId)
        if (idx < 0) return
        const order = typography.groups[idx].order
        typography.groups[idx] = { ...buildDefaultTypographyGroup(order), id: groupId }
        reconcileFrameworkTypographyClasses(site)
      })
    },

    deleteFrameworkTypographyGroup: (groupId) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        typography.groups = typography.groups.filter((g) => g.id !== groupId)
        typography.classes = typography.classes?.filter((c) => c.tabId !== groupId) ?? []
        reconcileFrameworkTypographyClasses(site)
      })
    },

    upsertFrameworkTypographyManualSize: (groupId, sizeId, patch) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        const group = typography.groups.find((g) => g.id === groupId)
        if (!group) return
        group.manualSizes ??= []
        const idx = group.manualSizes.findIndex((m) => m.id === sizeId)
        if (idx < 0) {
          if (typeof patch.name !== 'string' || patch.min === undefined || patch.max === undefined) return
          group.manualSizes.push({
            id: sizeId,
            name: patch.name,
            min: patch.min,
            max: patch.max,
          })
        } else {
          group.manualSizes[idx] = { ...group.manualSizes[idx], ...patch }
        }
        group.updatedAt = Date.now()
        reconcileFrameworkTypographyClasses(site)
      })
    },

    setFrameworkTypographyClassGenerators: (classes) => {
      mutateSite((site) => {
        const typography = ensureFrameworkTypography(site)
        typography.classes = classes
        reconcileFrameworkTypographyClasses(site)
      })
    },

    // ─── Framework spacing ───────────────────────────────────────────────
    toggleFrameworkSpacingDisabled: () => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        spacing.isDisabled = !spacing.isDisabled
        reconcileFrameworkSpacingClasses(site)
      })
    },

    createFrameworkSpacingGroup: () => {
      const { site } = get()
      if (!site) throw new Error('[siteSlice] Site document is not initialized')
      const spacing = ensureFrameworkSpacing(site)
      const { name, varName } = nextSpacingTabValues(spacing.groups)
      const order = nextOrderValue(spacing.groups)
      const group = makeFreshSpacingGroup(name, varName, order)

      mutateSite((draftSite) => {
        const draftSpacing = ensureFrameworkSpacing(draftSite)
        draftSpacing.groups.push(group)
        reconcileFrameworkSpacingClasses(draftSite)
      })
      return group
    },

    updateFrameworkSpacingGroup: (groupId, patch) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        const group = spacing.groups.find((g) => g.id === groupId)
        if (!group) return
        applyFrameworkSpacingGroupPatch(group, patch)
        reconcileFrameworkSpacingClasses(site)
      })
    },

    duplicateFrameworkSpacingGroup: (groupId) => {
      const { site } = get()
      if (!site) return null
      const spacing = ensureFrameworkSpacing(site)
      const source = spacing.groups.find((g) => g.id === groupId)
      if (!source) return null

      const { name, varName } = nextSpacingTabValues(spacing.groups)
      const order = nextOrderValue(spacing.groups)
      const now = Date.now()
      const copy: FrameworkSpacingGroup = {
        ...structuredClone(source),
        id: nanoid(),
        name,
        namingConvention: varName,
        manualSizes: source.manualSizes?.map((m) => ({
          ...m,
          id: nanoid(),
          name: m.name.replace(source.namingConvention, varName),
        })),
        order,
        createdAt: now,
        updatedAt: now,
      }

      mutateSite((draftSite) => {
        const draftSpacing = ensureFrameworkSpacing(draftSite)
        draftSpacing.groups.push(copy)
        reconcileFrameworkSpacingClasses(draftSite)
      })
      return copy
    },

    resetFrameworkSpacingGroup: (groupId) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        const idx = spacing.groups.findIndex((g) => g.id === groupId)
        if (idx < 0) return
        const order = spacing.groups[idx].order
        spacing.groups[idx] = { ...buildDefaultSpacingGroup(order), id: groupId }
        reconcileFrameworkSpacingClasses(site)
      })
    },

    deleteFrameworkSpacingGroup: (groupId) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        spacing.groups = spacing.groups.filter((g) => g.id !== groupId)
        spacing.classes = spacing.classes?.filter((c) => c.tabId !== groupId) ?? []
        reconcileFrameworkSpacingClasses(site)
      })
    },

    upsertFrameworkSpacingManualSize: (groupId, sizeId, patch) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        const group = spacing.groups.find((g) => g.id === groupId)
        if (!group) return
        group.manualSizes ??= []
        const idx = group.manualSizes.findIndex((m) => m.id === sizeId)
        if (idx < 0) {
          if (typeof patch.name !== 'string' || patch.min === undefined || patch.max === undefined) return
          group.manualSizes.push({
            id: sizeId,
            name: patch.name,
            min: patch.min,
            max: patch.max,
          })
        } else {
          group.manualSizes[idx] = { ...group.manualSizes[idx], ...patch }
        }
        group.updatedAt = Date.now()
        reconcileFrameworkSpacingClasses(site)
      })
    },

    setFrameworkSpacingClassGenerators: (classes) => {
      mutateSite((site) => {
        const spacing = ensureFrameworkSpacing(site)
        spacing.classes = classes
        reconcileFrameworkSpacingClasses(site)
      })
    },
  }
}
