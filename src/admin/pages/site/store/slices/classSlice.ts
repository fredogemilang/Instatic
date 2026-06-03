/**
 * classSlice — Phase C CSS Class System store slice.
 *
 * Manages the site's global class registry (StyleRule[]) and the
 * per-node class assignments (node.classIds). All mutations go through
 * Immer produce() for immutability and undo-ability.
 *
 * Architecture:
 * - Classes live in site.styleRules (flat map, keyed by StyleRule.id)
 * - Nodes reference class IDs in node.classIds (ordered array)
 * - The active class ID controls which class the Class Composer edits
 *
 * Guideline #242 — no-op guard: every setter must bail out if the new
 * value equals the current value (Object.is) to prevent re-render loops.
 */

import { nanoid } from 'nanoid'
import type { Draft } from 'immer'
import type { EditorStore, EditorStoreSliceCreator } from '@site/store/types'
import type { BaseNode, SiteDocument } from '@core/page-tree'
import type { StyleRule, CSSPropertyBag, Condition } from '@core/page-tree'
import { classKindSelector, conditionId, makeConditionDef } from '@core/page-tree'
import { isGeneratedClassLocked, isUserVisibleClass } from '@core/page-tree'
import { assertValidCssClassName } from '@core/page-tree'
import { buildSiteHelpers } from './site/helpers'
import { isValidCssSelector, renameStyleRule } from '../styleRuleRename'

/**
 * Inputs accepted by `createAmbientRule`. `selector` is required (e.g.
 * `'h1 > span'`); `name` defaults to the selector text for display purposes.
 */
export interface CreateAmbientRuleInput {
  selector: string
  name?: string
  styles?: Partial<CSSPropertyBag>
  contextStyles?: Record<string, Partial<CSSPropertyBag>>
}

/**
 * Compute the next cascade `order` value for a newly-inserted style rule:
 * always >= every existing order so the new rule appends at the end of the
 * cascade. Imported CSS uses explicit `order` values from the source; this
 * helper is only for user-initiated creation through the slice.
 */
function nextRuleOrder(classes: Record<string, StyleRule>): number {
  let max = -1
  for (const cls of Object.values(classes)) {
    if (typeof cls.order === 'number' && cls.order > max) max = cls.order
  }
  return max + 1
}

export interface ClassPreviewAssignment {
  nodeId: string
  classId: string
}

/**
 * Transient style preview applied on top of a class while a user hovers a
 * suggestion in a property control (e.g. spacing token dropdown). The
 * canvas style injector reads this and emits a higher-specificity rule so
 * the change is visible without committing to history.
 */
export interface ClassStylesPreview {
  classId: string
  /** Breakpoint id to scope the preview to, or null/undefined for the base styles. */
  breakpointId?: string | null
  styles: Partial<CSSPropertyBag>
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface ClassSlice {
  // ── UI state ──────────────────────────────────────────────────────────────
  /** The class currently being edited in the Class Composer (null = none) */
  activeClassId: string | null
  setActiveClass(id: string | null): void

  /**
   * When true, the Properties panel edits the selected node's inline styles
   * (`node.inlineStyles`) instead of a class. Mutually exclusive with
   * `activeClassId` — selecting a class clears this, and enabling this clears
   * the active class. Reset to false whenever the node selection changes.
   */
  inlineStyleEditing: boolean
  setInlineStyleEditing(active: boolean): void

  /** Transient class assignment previewed on the canvas while hovering a suggestion. */
  previewClassAssignment: ClassPreviewAssignment | null
  setPreviewNodeClass(nodeId: string, classId: string): void
  clearPreviewNodeClass(nodeId?: string, classId?: string): void

  /** Transient style patch previewed on the canvas while hovering a suggestion. */
  previewClassStyles: ClassStylesPreview | null
  setPreviewClassStyles(preview: ClassStylesPreview): void
  clearPreviewClassStyles(classId?: string): void

  // ── CRUD ──────────────────────────────────────────────────────────────────
  /**
   * Create a new class with the given name and optional initial styles.
   * Returns the new StyleRule so callers can immediately activate it.
   * Throws if a class with the same name already exists.
   */
  createClass(name: string, styles?: Partial<CSSPropertyBag>): StyleRule

  /**
   * Create an ambient style rule — one whose `selector` is not a single class
   * name (e.g. `h1`, `h1 > span`, `.hero .title`, `a:hover`). Ambient rules
   * attach by CSS matching at render time; they are never written to a
   * node's `class=` attribute. The CSS importer is the primary caller.
   *
   * Throws if the selector is empty or syntactically invalid.
   */
  createAmbientRule(input: CreateAmbientRuleInput): StyleRule

  /** Shallow-merge a style patch into a class's base styles. */
  updateClassStyles(classId: string, patch: Partial<CSSPropertyBag>): void

  // ── Per-context overrides (unified viewport-context + custom-condition axis) ─
  /**
   * Shallow-merge a style patch into a class's override bag for one editing
   * context. `contextId` is either a viewport-context id (`site.breakpoints`)
   * or a custom-condition id (`site.conditions`). Keys set to undefined/null
   * are removed. Replaces the old `setClassBreakpointStyles` +
   * `updateConditionalLayerStyles` (they were the same operation twice).
   */
  setClassContextStyles(
    classId: string,
    contextId: string,
    patch: Partial<CSSPropertyBag>,
  ): void

  // ── Site-level reusable conditions (custom @media / @container / @supports) ─
  /**
   * Add a reusable condition to the site-level `site.conditions` registry,
   * deduped by deterministic id. Returns the condition id (existing or new).
   */
  addCondition(condition: Condition, label?: string): string

  /**
   * Remove a condition from the registry AND clear its override bag from every
   * class that used it. No-op if the condition id is unknown.
   */
  removeCondition(conditionId: string): void

  /** Rename a condition's display label (registry only; id/condition unchanged). */
  renameCondition(conditionId: string, label: string): void

  /**
   * Edit a condition's query/kind (and optionally label) in place, keeping its
   * id stable so every class's `contextStyles[id]` overrides survive the edit.
   * (The id no longer matches `conditionId(condition)` afterwards — that only
   * affects future import dedup, an acceptable edge case.)
   */
  updateCondition(conditionId: string, condition: Condition, label?: string): void

  /**
   * Convenience for the style panel: ensure `condition` exists in the registry
   * and that `classId` carries an (initially empty) override bag under it, so
   * the context becomes editable. Returns the condition id, or null if the rule
   * doesn't exist / is locked.
   */
  addClassCondition(classId: string, condition: Condition): string | null

  /** Remove a class's override bag for one context (no registry change). */
  removeClassContext(classId: string, contextId: string): void

  /**
   * Fully remove a CSS property from a class — from base styles and from every
   * per-context override. Used by the X / clear affordances on visual switchers
   * (LayoutSection) where "clear this property" must mean "make it disappear"
   * regardless of which context is active. No-ops (and does NOT push history)
   * if the property isn't set anywhere.
   */
  removeClassStyleProperty(classId: string, property: keyof CSSPropertyBag): void

  /**
   * Fully remove SEVERAL CSS properties from a class in a single undo step —
   * each from base styles and every per-context override. Used when one action
   * must prune a group of related properties at once (e.g. clearing `display`
   * also clears the flex/grid container properties it governed, which would
   * otherwise linger as invisible orphans). No-ops if none are set anywhere.
   */
  clearClassStyleProperties(classId: string, properties: ReadonlyArray<keyof CSSPropertyBag>): void

  /** Ensure a hidden node-scoped class exists for module instance style fields. */
  ensureNodeStyleClass(nodeId: string, moduleName?: string): StyleRule | null

  /**
   * Rename a style rule.
   * - class-kind rules accept one class token and rebuild `selector` from it.
   * - ambient rules accept a full CSS selector and keep `name` aligned to it
   *   because selector surfaces display the selector, not an old class label.
   */
  renameClass(classId: string, name: string): void

  /** Duplicate a reusable class. Returns the new class, or null if not found. */
  duplicateClass(classId: string): StyleRule | null

  /**
   * Duplicate several reusable classes at once (Selectors panel bulk action).
   * Locked / non-user-visible ids are skipped. Returns the created copies.
   */
  duplicateClasses(classIds: string[]): StyleRule[]

  /** Delete a class and remove it from all nodes that reference it. */
  deleteClass(classId: string): void

  /**
   * Delete several classes in one batched mutation (Selectors panel bulk
   * action) so the whole removal is a single undo step. Locked classes are
   * skipped; every deleted id is scrubbed from node/VC class references and
   * from the active / selected-selector state.
   */
  deleteClasses(classIds: string[]): void

  // ── Node ↔ class assignment ───────────────────────────────────────────────
  /** Append a classId to a node's classIds (no-op if already present). */
  addNodeClass(nodeId: string, classId: string): void

  /**
   * Append several classIds to a node in ONE batched mutation, so a bulk
   * "apply" is a single undo step. Ambient rules and already-present ids are
   * skipped. No-op (no history entry) when nothing new would be added.
   */
  addNodeClasses(nodeId: string, classIds: string[]): void

  /** Remove a classId from a node's classIds (no-op if not present). */
  removeNodeClass(nodeId: string, classId: string): void

  /** Swap two classIds by index within a node's classIds array. */
  reorderNodeClasses(nodeId: string, fromIndex: number, toIndex: number): void

  /**
   * Move a classId one position up ('up' = lower index = lower cascade priority)
   * or down ('down' = higher index = higher cascade priority) in a node's classIds array.
   * No-op at array boundaries (Guideline #242 — no-op mutation guard).
   */
  reorderNodeClass(nodeId: string, classId: string, direction: 'up' | 'down'): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasStylePatchChanges(
  current: Record<string, unknown>,
  patch: Partial<CSSPropertyBag>,
): boolean {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) {
      if (key in current) return true
    } else if (!Object.is(current[key], value)) {
      return true
    }
  }
  return false
}

function shallowEqualStyles(
  a: Partial<CSSPropertyBag>,
  b: Partial<CSSPropertyBag>,
): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false
    }
  }
  return true
}

function cloneContextStyles(
  contextStyles: StyleRule['contextStyles'],
): StyleRule['contextStyles'] {
  return Object.fromEntries(
    Object.entries(contextStyles).map(([contextId, styles]) => [
      contextId,
      { ...styles },
    ]),
  )
}

/**
 * Find a node by id anywhere in the site — pages **and** Visual Component
 * trees. Returns null when the node doesn't exist anywhere.
 *
 * Node↔class mutations need this because the user can be editing either a
 * page or a VC; the canvas selection lives in whichever document is active.
 * Searching only `site.pages` (the original implementation) silently
 * no-ops every class assignment when the user is in VC canvas mode.
 *
 * VCNode = BaseNode (structurally identical), so a single `BaseNode`-shaped
 * helper covers both tree kinds.
 */
function findNodeWithClassIds(
  site: SiteDocument | null,
  nodeId: string,
): BaseNode | null {
  if (!site) return null
  for (const page of site.pages) {
    const node = page.nodes[nodeId]
    if (node) return node
  }
  for (const vc of site.visualComponents) {
    const node = vc.tree.nodes[nodeId]
    if (node) return node
  }
  return null
}

/**
 * Apply a mutation to a node's `classIds` array inside an Immer producer,
 * looking up the node in pages first and falling back to Visual Component
 * trees. The recipe receives the live (draft) `classIds` array — mutate it
 * in place. Initialises `classIds` to `[]` when missing.
 *
 * Returns `true` when the node was found and the recipe ran, `false`
 * otherwise (used by callers to skip post-mutation bookkeeping when the
 * node has been removed concurrently).
 */
function mutateNodeClassIds(
  state: Draft<EditorStore>,
  nodeId: string,
  recipe: (classIds: string[]) => void,
): boolean {
  if (!state.site) return false
  for (const page of state.site.pages) {
    const node = page.nodes[nodeId]
    if (node) {
      if (!node.classIds) node.classIds = []
      recipe(node.classIds)
      return true
    }
  }
  for (const vc of state.site.visualComponents) {
    const node = vc.tree.nodes[nodeId]
    if (node) {
      if (!node.classIds) node.classIds = []
      recipe(node.classIds)
      return true
    }
  }
  return false
}

function uniqueClassCopyName(classes: Record<string, StyleRule>, originalName: string): string {
  const existingNames = new Set(Object.values(classes).map((cls) => cls.name))
  const baseName = `${originalName}-copy`
  if (!existingNames.has(baseName)) return baseName

  let suffix = 2
  while (existingNames.has(`${baseName}-${suffix}`)) {
    suffix += 1
  }
  return `${baseName}-${suffix}`
}

// ---------------------------------------------------------------------------
// Slice implementation
// ---------------------------------------------------------------------------

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@site/store/types' {
  interface EditorStore extends ClassSlice {}
}

export const createClassSlice: EditorStoreSliceCreator<ClassSlice> = (set, get) => {
  const { mutateSite, mutateSiteState } = buildSiteHelpers(set, get)

  return {
  // ── UI state ───────────────────────────────────────────────────────────────

  activeClassId: null,
  inlineStyleEditing: false,
  previewClassAssignment: null,
  previewClassStyles: null,

  setActiveClass(id) {
    const { activeClassId, inlineStyleEditing } = get()
    // Selecting a real class always switches away from inline editing.
    const nextInline = id !== null ? false : inlineStyleEditing
    // Guideline #242 no-op guard — bail only when nothing actually changes.
    if (Object.is(activeClassId, id) && nextInline === inlineStyleEditing) return
    set({ activeClassId: id, inlineStyleEditing: nextInline })
  },

  setInlineStyleEditing(active) {
    if (get().inlineStyleEditing === active) return
    // Enabling inline editing clears the active class so the two targets stay
    // mutually exclusive; disabling leaves the active class untouched.
    set({ inlineStyleEditing: active, ...(active ? { activeClassId: null } : {}) })
  },

  setPreviewNodeClass(nodeId, classId) {
    const current = get().previewClassAssignment
    if (current?.nodeId === nodeId && current.classId === classId) return
    set({ previewClassAssignment: { nodeId, classId } })
  },

  clearPreviewNodeClass(nodeId, classId) {
    const current = get().previewClassAssignment
    if (!current) return
    if (nodeId !== undefined && current.nodeId !== nodeId) return
    if (classId !== undefined && current.classId !== classId) return
    set({ previewClassAssignment: null })
  },

  setPreviewClassStyles(preview) {
    const current = get().previewClassStyles
    if (
      current &&
      current.classId === preview.classId &&
      (current.breakpointId ?? null) === (preview.breakpointId ?? null) &&
      shallowEqualStyles(current.styles, preview.styles)
    ) {
      return
    }
    set({ previewClassStyles: preview })
  },

  clearPreviewClassStyles(classId) {
    const current = get().previewClassStyles
    if (!current) return
    if (classId !== undefined && current.classId !== classId) return
    set({ previewClassStyles: null })
  },

  // ── CRUD ───────────────────────────────────────────────────────────────────

  createClass(name, styles = {}) {
    const { site } = get()
    if (!site) throw new Error('[classSlice] Site document is not initialized')
    assertValidCssClassName(name)

    // Uniqueness check
    const existing = Object.values(site.styleRules).find((c) => c.name === name)
    if (existing) throw new Error(`[classSlice] A class named "${name}" already exists`)

    const now = Date.now()
    const newClass: StyleRule = {
      id: nanoid(),
      name,
      kind: 'class',
      selector: classKindSelector(name),
      order: nextRuleOrder(site.styleRules),
      styles,
      contextStyles: {},
      createdAt: now,
      updatedAt: now,
    }

    mutateSite((site) => {
      site.styleRules[newClass.id] = newClass
      return true
    })

    return newClass
  },

  createAmbientRule(input) {
    const { site } = get()
    if (!site) throw new Error('[classSlice] Site document is not initialized')

    const selector = input.selector.trim()
    if (selector.length === 0) {
      throw new Error('[classSlice] Ambient selector cannot be empty')
    }
    if (!isValidCssSelector(selector)) {
      throw new Error(`[classSlice] Invalid CSS selector: ${selector}`)
    }

    // Default display name to the selector text. Unlike class-kind rules,
    // ambient rule names are not required to be globally unique — multiple
    // rules can share a selector (cascade resolves by `order`).
    const name = (input.name && input.name.trim().length > 0) ? input.name.trim() : selector

    const now = Date.now()
    const newRule: StyleRule = {
      id: nanoid(),
      name,
      kind: 'ambient',
      selector,
      order: nextRuleOrder(site.styleRules),
      styles: input.styles ?? {},
      contextStyles: input.contextStyles ?? {},
      createdAt: now,
      updatedAt: now,
    }

    mutateSite((site) => {
      site.styleRules[newRule.id] = newRule
      return true
    })

    return newRule
  },

  updateClassStyles(classId, patch) {
    const { site } = get()
    const cls = site?.styleRules[classId]
    if (!cls) return
    if (isGeneratedClassLocked(cls)) return
    if (!hasStylePatchChanges(cls.styles, patch)) return

    mutateSite((site) => {
      const draftClass = site.styleRules[classId]
      if (!draftClass) return false
      Object.assign(draftClass.styles, patch)
      // Remove keys explicitly set to undefined/null (allow clearing a property)
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null) {
          delete draftClass.styles[k]
        }
      }
      draftClass.updatedAt = Date.now()
      return true
    })
  },

  setClassContextStyles(classId, contextId, patch) {
    const { site } = get()
    const cls = site?.styleRules[classId]
    if (!cls) return
    if (isGeneratedClassLocked(cls)) return
    const currentStyles = cls.contextStyles[contextId] ?? {}
    if (!hasStylePatchChanges(currentStyles, patch)) return

    mutateSite((site) => {
      const draftClass = site.styleRules[classId]
      if (!draftClass) return false
      if (!draftClass.contextStyles[contextId]) {
        draftClass.contextStyles[contextId] = {}
      }
      Object.assign(draftClass.contextStyles[contextId], patch)
      // Remove keys explicitly set to undefined/null
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null) {
          delete draftClass.contextStyles[contextId][k]
        }
      }
      draftClass.updatedAt = Date.now()
      return true
    })
  },

  addCondition(condition, label) {
    const def = makeConditionDef(condition, label)
    const { site } = get()
    if (!site) return def.id
    if ((site.conditions ?? []).some((c) => c.id === def.id)) return def.id

    mutateSite((site) => {
      if (!site.conditions) site.conditions = []
      if (site.conditions.some((c) => c.id === def.id)) return false
      site.conditions.push(def)
      return true
    })
    return def.id
  },

  removeCondition(condId) {
    const { site } = get()
    if (!site) return
    const exists = (site.conditions ?? []).some((c) => c.id === condId)
    const usedByAnyClass = Object.values(site.styleRules).some(
      (cls) => condId in cls.contextStyles,
    )
    if (!exists && !usedByAnyClass) return

    mutateSite((site) => {
      if (site.conditions) {
        site.conditions = site.conditions.filter((c) => c.id !== condId)
        if (site.conditions.length === 0) delete site.conditions
      }
      // Clear the override bag from every class that referenced it.
      for (const cls of Object.values(site.styleRules)) {
        if (condId in cls.contextStyles) {
          delete cls.contextStyles[condId]
          cls.updatedAt = Date.now()
        }
      }
      return true
    })
  },

  renameCondition(condId, label) {
    const { site } = get()
    if (!site) return
    const trimmed = label.trim()
    if (!trimmed) return
    const current = (site.conditions ?? []).find((c) => c.id === condId)
    if (!current || current.label === trimmed) return

    mutateSite((site) => {
      const def = site.conditions?.find((c) => c.id === condId)
      if (!def || def.label === trimmed) return false
      def.label = trimmed
      return true
    })
  },

  updateCondition(condId, condition, label) {
    const { site } = get()
    if (!site) return
    const current = (site.conditions ?? []).find((c) => c.id === condId)
    if (!current) return

    mutateSite((site) => {
      const def = site.conditions?.find((c) => c.id === condId)
      if (!def) return false
      def.condition = condition
      if (label && label.trim()) def.label = label.trim()
      return true
    })
  },

  addClassCondition(classId, condition) {
    const { site } = get()
    const cls = site?.styleRules[classId]
    if (!cls) return null
    if (isGeneratedClassLocked(cls)) return null

    const id = conditionId(condition)
    const def = makeConditionDef(condition)
    mutateSite((site) => {
      if (!site.conditions) site.conditions = []
      if (!site.conditions.some((c) => c.id === id)) site.conditions.push(def)
      const draftClass = site.styleRules[classId]
      if (!draftClass) return false
      // Ensure an (initially empty) override bag exists so the context surfaces
      // as an editable tab even before any property is set under it.
      if (!draftClass.contextStyles[id]) {
        draftClass.contextStyles[id] = {}
        draftClass.updatedAt = Date.now()
      }
      return true
    })
    return id
  },

  removeClassContext(classId, contextId) {
    const { site } = get()
    const cls = site?.styleRules[classId]
    if (!cls) return
    if (isGeneratedClassLocked(cls)) return
    if (!(contextId in cls.contextStyles)) return

    mutateSite((site) => {
      const draftClass = site.styleRules[classId]
      if (!draftClass || !(contextId in draftClass.contextStyles)) return false
      delete draftClass.contextStyles[contextId]
      draftClass.updatedAt = Date.now()
      return true
    })
  },

  removeClassStyleProperty(classId, property) {
    const { site } = get()
    const cls = site?.styleRules[classId]
    if (!cls) return
    if (isGeneratedClassLocked(cls)) return

    const propKey = property as string
    const isInBase = propKey in cls.styles
    // Every per-context override (viewport contexts AND custom conditions) lives
    // in one map now — "clear everywhere" iterates it uniformly.
    const contextIdsWithProperty = Object.entries(cls.contextStyles)
      .filter(([, bag]) => propKey in (bag ?? {}))
      .map(([id]) => id)
    if (!isInBase && contextIdsWithProperty.length === 0) {
      return
    }

    mutateSite((site) => {
      const draftClass = site.styleRules[classId]
      if (!draftClass) return false
      delete (draftClass.styles as Record<string, unknown>)[propKey]
      for (const contextId of contextIdsWithProperty) {
        const bag = draftClass.contextStyles[contextId]
        if (bag) delete (bag as Record<string, unknown>)[propKey]
      }
      draftClass.updatedAt = Date.now()
      return true
    })
  },

  clearClassStyleProperties(classId, properties) {
    const { site } = get()
    const cls = site?.styleRules[classId]
    if (!cls) return
    if (isGeneratedClassLocked(cls)) return

    const keys = properties.map((p) => p as string)
    // Determine whether anything is actually set, so a no-op clear doesn't push
    // an empty history entry (mirrors removeClassStyleProperty's guard).
    const anySet =
      keys.some((k) => k in cls.styles) ||
      Object.values(cls.contextStyles).some((bag) => keys.some((k) => k in (bag ?? {})))
    if (!anySet) return

    mutateSite((site) => {
      const draftClass = site.styleRules[classId]
      if (!draftClass) return false
      for (const key of keys) {
        delete (draftClass.styles as Record<string, unknown>)[key]
        for (const bag of Object.values(draftClass.contextStyles)) {
          if (bag) delete (bag as Record<string, unknown>)[key]
        }
      }
      draftClass.updatedAt = Date.now()
      return true
    })
  },

  ensureNodeStyleClass(nodeId, moduleName = 'Module') {
    const { site } = get()
    if (!site) return null

    const node = findNodeWithClassIds(site, nodeId)
    if (!node) return null

    const existingId = node.classIds?.find((id) => {
      const cls = site.styleRules[id]
      return cls?.scope?.type === 'node' && cls.scope.nodeId === nodeId && cls.scope.role === 'module-style'
    })
    if (existingId && site.styleRules[existingId]) {
      return site.styleRules[existingId]
    }

    const now = Date.now()
    const instanceName = `${moduleName} instance ${nodeId.slice(0, 6)}`
    const newClass: StyleRule = {
      id: nanoid(),
      name: instanceName,
      kind: 'class',
      selector: classKindSelector(instanceName),
      order: nextRuleOrder(site.styleRules),
      description: 'Node-scoped module style layer',
      scope: { type: 'node', nodeId, role: 'module-style' },
      styles: {},
      contextStyles: {},
      tags: ['module-instance'],
      createdAt: now,
      updatedAt: now,
    }

    mutateSiteState((state, site) => {
      const mutated = mutateNodeClassIds(state, nodeId, (classIds) => {
        // Drop any prior module-style class scoped to this node before
        // appending the freshly created one. The filter is in-place via
        // splice so we don't reassign `node.classIds` inside the recipe.
        for (let i = classIds.length - 1; i >= 0; i--) {
          const cls = site.styleRules[classIds[i]]
          if (
            cls?.scope?.type === 'node' &&
            cls.scope.nodeId === nodeId &&
            cls.scope.role === 'module-style'
          ) {
            classIds.splice(i, 1)
          }
        }
        classIds.push(newClass.id)
      })
      if (!mutated) return false
      site.styleRules[newClass.id] = newClass
      return true
    })

    return newClass
  },

  renameClass(classId, name) {
    const { site } = get()
    if (!site?.styleRules[classId]) return
    mutateSite((site) => renameStyleRule(site.styleRules, classId, name))
  },

  duplicateClass(classId) {
    const { site } = get()
    const cls = site?.styleRules[classId]
    if (!site || !cls || !isUserVisibleClass(cls)) return null
    if (isGeneratedClassLocked(cls)) return null

    const now = Date.now()
    const copyName = uniqueClassCopyName(site.styleRules, cls.name)
    // Duplicating preserves the source rule's kind and selector pattern. For
    // class-kind rules the selector is rebuilt from the new (unique) name; for
    // ambient rules the selector text is copied verbatim so the rule still
    // matches the same elements after duplication.
    const kind = cls.kind ?? 'class'
    const selector = kind === 'class' ? classKindSelector(copyName) : (cls.selector || classKindSelector(copyName))
    const newClass: StyleRule = {
      id: nanoid(),
      name: copyName,
      kind,
      selector,
      order: nextRuleOrder(site.styleRules),
      description: cls.description,
      styles: { ...cls.styles },
      // Per-context overrides reference the shared site-level conditions
      // registry by id, so cloning the bags (independent copies) is enough —
      // no per-rule condition definitions to clone.
      contextStyles: cloneContextStyles(cls.contextStyles),
      tags: cls.tags ? [...cls.tags] : undefined,
      createdAt: now,
      updatedAt: now,
    }

    mutateSite((site) => {
      site.styleRules[newClass.id] = newClass
      return true
    })

    return newClass
  },

  duplicateClasses(classIds) {
    // Each duplicateClass() call re-reads the live registry, so cloning one at a
    // time keeps copy-name uniqueness correct across the whole batch.
    const copies: StyleRule[] = []
    for (const classId of classIds) {
      const copy = get().duplicateClass(classId)
      if (copy) copies.push(copy)
    }
    return copies
  },

  deleteClass(classId) {
    get().deleteClasses([classId])
  },

  deleteClasses(classIds) {
    const { site } = get()
    if (!site) return
    // Resolve the deletable set up front: existing, non-locked classes only.
    const targets = new Set(
      classIds.filter((id) => {
        const cls = site.styleRules[id]
        return cls && !isGeneratedClassLocked(cls)
      }),
    )
    if (targets.size === 0) return

    mutateSiteState((state, site) => {
      let mutated = false
      for (const classId of targets) {
        if (!site.styleRules[classId]) continue
        // Remove from registry
        delete site.styleRules[classId]
        mutated = true
        // Remove from every node on every page AND every Visual Component
        // tree — class IDs are global, so a deleted class must disappear
        // from both surfaces or a VC keeps a dangling reference.
        for (const page of site.pages) {
          for (const node of Object.values(page.nodes)) {
            if (node.classIds && node.classIds.includes(classId)) {
              node.classIds = node.classIds.filter((id) => id !== classId)
            }
          }
        }
        for (const vc of site.visualComponents) {
          for (const node of Object.values(vc.tree.nodes)) {
            if (node.classIds && node.classIds.includes(classId)) {
              node.classIds = node.classIds.filter((id) => id !== classId)
            }
          }
        }
      }
      if (!mutated) return false
      // Clear active / selected references that pointed at a deleted class.
      if (state.activeClassId && targets.has(state.activeClassId)) {
        state.activeClassId = null
      }
      if (state.selectedSelectorClassId && targets.has(state.selectedSelectorClassId)) {
        state.selectedSelectorClassId = null
      }
      if (state.selectedSelectorClassIds.length > 0) {
        state.selectedSelectorClassIds = state.selectedSelectorClassIds.filter(
          (id) => !targets.has(id),
        )
      }
      return true
    })
  },

  // ── Node ↔ class assignment ────────────────────────────────────────────────

  addNodeClass(nodeId, classId) {
    const { site } = get()
    const node = findNodeWithClassIds(site, nodeId)
    if (!node) return
    // No-op if already assigned
    if (node.classIds?.includes(classId)) return
    // Invariant: node.classIds only holds class-kind rule ids. Ambient rules
    // attach by selector matching, not by class-attribute assignment, so
    // pushing one here would leak into the rendered class attribute via
    // a never-matching token. Surface the misuse and bail.
    const cls = site?.styleRules[classId]
    if (cls && cls.kind && cls.kind !== 'class') {
      console.error(
        '[classSlice] addNodeClass refused: classId references an ambient rule',
        { nodeId, classId, selector: cls.selector },
      )
      return
    }

    mutateSiteState((state) => {
      const mutated = mutateNodeClassIds(state, nodeId, (classIds) => {
        if (!classIds.includes(classId)) classIds.push(classId)
      })
      return mutated
    })
  },

  addNodeClasses(nodeId, classIds) {
    const { site } = get()
    const node = findNodeWithClassIds(site, nodeId)
    if (!node) return
    // Keep only class-kind rules the node doesn't already have. Ambient rules
    // attach by selector matching, not by class attribute, so they're skipped
    // (same invariant as addNodeClass).
    const toAdd = classIds.filter((classId) => {
      if (node.classIds?.includes(classId)) return false
      const cls = site?.styleRules[classId]
      if (cls && cls.kind && cls.kind !== 'class') {
        console.error(
          '[classSlice] addNodeClasses skipped an ambient rule',
          { nodeId, classId, selector: cls.selector },
        )
        return false
      }
      return true
    })
    if (toAdd.length === 0) return

    mutateSiteState((state) => {
      const mutated = mutateNodeClassIds(state, nodeId, (existing) => {
        for (const id of toAdd) {
          if (!existing.includes(id)) existing.push(id)
        }
      })
      return mutated
    })
  },

  removeNodeClass(nodeId, classId) {
    const { site } = get()
    const node = findNodeWithClassIds(site, nodeId)
    if (!node?.classIds?.includes(classId)) return

    mutateSiteState((state) => {
      const mutated = mutateNodeClassIds(state, nodeId, (classIds) => {
        const idx = classIds.indexOf(classId)
        if (idx >= 0) classIds.splice(idx, 1)
      })
      return mutated
    })
  },

  reorderNodeClasses(nodeId, fromIndex, toIndex) {
    const { site } = get()
    if (!site) return
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || toIndex < 0) return
    const node = findNodeWithClassIds(site, nodeId)
    const classIds = node?.classIds
    if (!classIds || classIds.length <= Math.max(fromIndex, toIndex)) return

    mutateSiteState((state) => {
      let moved = false
      const mutated = mutateNodeClassIds(state, nodeId, (arr) => {
        if (arr.length <= Math.max(fromIndex, toIndex)) return
        const [item] = arr.splice(fromIndex, 1)
        arr.splice(toIndex, 0, item)
        moved = true
      })
      return mutated && moved
    })
  },

  reorderNodeClass(nodeId, classId, direction) {
    const { site } = get()
    if (!site) return
    const node = findNodeWithClassIds(site, nodeId)
    const classIds = node?.classIds
    if (!classIds || classIds.length < 2) return
    const idx = classIds.indexOf(classId)
    if (idx === -1) return
    const newIdx = direction === 'up' ? idx - 1 : idx + 1
    // No-op at array boundaries — Guideline #242
    if (newIdx < 0 || newIdx >= classIds.length) return

    mutateSiteState((state) => {
      let moved = false
      const mutated = mutateNodeClassIds(state, nodeId, (arr) => {
        const i = arr.indexOf(classId)
        if (i === -1) return
        const target = direction === 'up' ? i - 1 : i + 1
        if (target < 0 || target >= arr.length) return
        const [item] = arr.splice(i, 1)
        arr.splice(target, 0, item)
        moved = true
      })
      return mutated && moved
    })
  },
  }
}
