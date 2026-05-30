/**
 * Closure-shared helpers for the site slice.
 *
 * `buildSiteHelpers(set, get)` returns the shared mutation helpers packaged
 * into a single object that gets passed to every per-domain action factory.
 *
 * `reconcileVCRefsForVc` and `depthInTree` are pure utilities consumed by the
 * helpers / action factories — they live here so they sit next to the active
 * tree code that uses them.
 */

import { nanoid } from 'nanoid'
import type { StoreApi } from 'zustand'
import type {
  BaseNode,
  NodeTree,
  Page,
  PageNode,
  StyleRule,
  SiteDocument,
} from '@core/page-tree'
import { addPage, createNode } from '@core/page-tree'
import { syncSlotInstances, applySlotSyncResult } from '@core/visualComponents/slotSync'
import type { ImportFragment } from '@core/htmlImport'
import type { NewStyleRule } from '@core/siteImport'
import type { EditorStore } from '@site/store/types'
import { MAX_HISTORY } from './defaults'
import { indexStyleRulesByName, linkImportedClassNames } from './importLinking'
import type { SiteMutationResult, SiteSliceHelpers, SiteSliceImmerRecipe, SuperImportHelpers } from './types'

/**
 * Walk every page's tree, find every `base.visual-component-ref` that points
 * at the given vcId, and run `syncSlotInstances` on each so its slot-instance
 * children match the VC's current set of slot-outlets.
 *
 * MUST be called inside an Immer producer (operates on draft state).
 */
function reconcileVCRefsForVc(
  state: { site: SiteDocument | null },
  vcId: string,
): void {
  if (!state.site) return
  const vc = state.site.visualComponents.find((v) => v.id === vcId)
  if (!vc) return

  for (const page of state.site.pages) {
    const treeNodes = page.nodes as Record<string, BaseNode>
    // Snapshot ids first — applySlotSyncResult mutates the map.
    const refIds = Object.keys(treeNodes).filter((id) => {
      const n = treeNodes[id]
      return (
        n?.moduleId === 'base.visual-component-ref' &&
        (n.props as Record<string, unknown>).componentId === vcId
      )
    })
    for (const refId of refIds) {
      const refNode = treeNodes[refId]
      if (!refNode) continue
      const syncResult = syncSlotInstances(refNode, vc, treeNodes)
      applySlotSyncResult(treeNodes, syncResult, refId)
    }
  }
}

/**
 * Compute a node's depth in the active tree by walking up to root.
 * Used by `deleteNodes` to delete leaves before parents within a single batch
 * so descendants aren't double-removed (which would throw inside the helper).
 *
 * Returns 0 for the root, +Infinity for orphans (sorts last in DESC order →
 * effectively a no-op when the orphan slot is reached).
 */
export function depthInTree(tree: NodeTree<PageNode>, nodeId: string): number {
  if (nodeId === tree.rootNodeId) return 0
  let current = nodeId
  let depth = 0
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const parent = Object.values(tree.nodes).find((n) => n.children.includes(current))
    if (!parent) return Infinity
    depth++
    if (parent.id === tree.rootNodeId) return depth
    current = parent.id
  }
  return depth
}

/**
 * Build the closure-shared helpers passed to every per-domain action factory.
 *
 * The `mutate*` helpers snapshot the current site before running the recipe,
 * then commit that snapshot to undo history only when the recipe reports a
 * semantic mutation. Recipes return `false` for explicit no-ops; `void` keeps
 * the historical default of "changed" so existing mutating recipes remain
 * concise. They differ only in what they hand the recipe:
 *
 *   - `mutateSite`:       the SiteDocument draft.
 *   - `mutateSiteState`:  the full editor-state draft plus the SiteDocument draft.
 *   - `mutatePage`:       the active page (legacy single-document mode).
 *   - `mutateActiveTree`: the active NodeTree<PageNode>, routed by `activeDocument`.
 *
 * `mutateActiveTree` is the SOLE place that branches on `kind === 'visualComponent'`
 * — every named tree-mutation action delegates to it. Gated by
 * `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`.
 */
export function buildSiteHelpers(
  set: (recipe: SiteSliceImmerRecipe) => void,
  get: StoreApi<EditorStore>['getState'],
): SiteSliceHelpers {
  function recipeDidMutate(result: SiteMutationResult): boolean {
    return result !== false
  }

  function pushHistorySnapshot(
    state: Parameters<SiteSliceImmerRecipe>[0],
    snapshot: SiteDocument,
  ): void {
    state._historyPast.push(snapshot)
    if (state._historyPast.length > MAX_HISTORY) {
      state._historyPast.shift() // evict oldest
    }
    state._historyFuture = []
    state.canUndo = true
    state.canRedo = false
  }

  function snapshotCurrentSite(): SiteDocument | null {
    const { site } = get()
    return site ? structuredClone(site) : null
  }

  /** Snapshot current site into undo history, then clear redo stack. */
  function pushHistory(): void {
    const { site } = get()
    if (!site) return
    set((state) => {
      pushHistorySnapshot(state, structuredClone(site))
    })
  }

  /** Mutate the active page — auto-snapshots undo history on real changes. */
  function mutatePage(fn: (page: Page) => SiteMutationResult): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const page = state.site.pages.find((p) => p.id === state.activePageId)
      if (!page) return
      const result = fn(page)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /**
   * Mutate the active node tree — auto-snapshots undo history on real changes.
   *
   * Routes to the correct tree based on `activeDocument`:
   *   - Page mode (null or kind === 'page'): passes the active Page directly —
   *     Page IS NodeTree<PageNode> so no conversion needed.
   *   - VC mode (kind === 'visualComponent'): passes vc.tree directly —
   *     VCNode (= BaseNode) is structurally compatible with PageNode (which only
   *     adds optional `dynamicBindings`), so the cast is safe for all tree
   *     mutations that operate on BaseNode-level fields.
   *     After the mutation, propagates any change in the VC's slot-outlet set
   *     to every consumer VC ref across all pages via `syncSlotInstances`.
   *     This is what makes adding a `base.slot-outlet` to a VC automatically
   *     materialize a `base.slot-instance` child on every consumer.
   */
  function mutateActiveTree(fn: (tree: NodeTree<PageNode>) => SiteMutationResult): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const { activeDocument } = state

      if (activeDocument?.kind === 'visualComponent') {
        const vc = state.site.visualComponents.find((v) => v.id === activeDocument.vcId)
        if (!vc) return
        // VCNode is structurally compatible with PageNode (dynamicBindings is optional).
        // All tree mutations operate on BaseNode-level fields, so the cast is safe.
        const result = fn(vc.tree as NodeTree<PageNode>)
        if (!recipeDidMutate(result)) return
        pushHistorySnapshot(state, snapshot)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
        changed = true

        // Propagate slot-outlet changes to every consumer VC ref. Idempotent
        // when the slot-outlet set is unchanged. Cheap: O(pages × refs × tree
        // size); for non-trivial sites still well below a frame budget.
        reconcileVCRefsForVc(state, vc.id)
        return
      }

      // Page mode (activeDocument is null or kind === 'page').
      // Page IS NodeTree<PageNode> — pass directly, no conversion needed.
      const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : state.activePageId
      const page = state.site.pages.find((p) => p.id === pageId)
      if (!page) return
      const result = fn(page)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /** Mutate the site — auto-snapshots undo history on real changes. */
  function mutateSite(fn: (site: SiteDocument) => SiteMutationResult): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const result = fn(state.site)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /** Mutate editor state and site together — auto-snapshots undo history on real changes. */
  const mutateSiteState: SiteSliceHelpers['mutateSiteState'] = (fn) => {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const result = fn(state, state.site)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /**
   * Mutate the active node tree AND the surrounding site — auto-snapshots
   * undo history on real changes. Same active-document routing as `mutateActiveTree`, but
   * also hands the recipe a `SiteDocument` draft so it can read or write
   * site-level state alongside the tree mutation in one transaction.
   *
   * Used by duplicate operations that must clone scoped classes (which live
   * on `site.styleRules`) atomically with the node duplication. Without this
   * the duplicate's `classIds` would point at the source's scoped classes,
   * silently coupling per-node CSS across both nodes.
   */
  function mutateActiveTreeAndSite(
    fn: (tree: NodeTree<PageNode>, site: SiteDocument) => SiteMutationResult,
  ): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const { activeDocument } = state

      if (activeDocument?.kind === 'visualComponent') {
        const vc = state.site.visualComponents.find((v) => v.id === activeDocument.vcId)
        if (!vc) return
        const result = fn(vc.tree as NodeTree<PageNode>, state.site)
        if (!recipeDidMutate(result)) return
        pushHistorySnapshot(state, snapshot)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
        changed = true
        // Mirror mutateActiveTree's slot-outlet propagation contract.
        reconcileVCRefsForVc(state, vc.id)
        return
      }

      const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : state.activePageId
      const page = state.site.pages.find((p) => p.id === pageId)
      if (!page) return
      const result = fn(page, state.site)
      if (!recipeDidMutate(result)) return
      pushHistorySnapshot(state, snapshot)
      state.site.updatedAt = Date.now()
      state.hasUnsavedChanges = true
      changed = true
    })
    return changed
  }

  /**
   * Mutate the entire site — all pages and style rules — in ONE undoable
   * history snapshot. The recipe receives a SiteDocument draft and transaction
   * helpers for adding or overwriting pages and style rules.
   *
   * Class names on imported fragment nodes are resolved to registry ids (and
   * unknown names auto-create bare classes) via the shared `byName` map that
   * the helpers build once and share across the whole recipe. This guarantees
   * that a class added by `addStyleRule` earlier in the recipe is reused by
   * `addPage` later in the same recipe — no duplicate rules for the same name.
   *
   * A history snapshot is pushed ONLY when the recipe returns a non-false
   * result AND at least one helper actually mutated the site. Explicit no-ops
   * (`return false`) never produce a history entry.
   */
  function mutateAllPagesAndSite(
    fn: (site: SiteDocument, helpers: SuperImportHelpers) => SiteMutationResult,
  ): boolean {
    const snapshot = snapshotCurrentSite()
    let changed = false
    set((state) => {
      if (!state.site || !snapshot) return
      const site = state.site
      let didMutate = false

      // Build the name→id index once. All helpers share this map so that
      // a `addStyleRule(kind:'class', name:'btn')` followed by
      // `addPage(fragment with node.classIds:['btn'])` resolves to the same id.
      const byName = indexStyleRulesByName(site.styleRules)

      const helpers: SuperImportHelpers = {
        addPage({ title, slug, nodeFragment }: { title: string; slug: string; nodeFragment: ImportFragment }): string {
          // addPage creates a fresh base.body root, normalises the slug, and
          // pushes the page onto site.pages. We then graft the fragment nodes
          // in as children of that root — same logical step as insertImportedNodes.
          const page = addPage(site as SiteDocument, title, slug)
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            page.nodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName),
            }
          }
          page.nodes[page.rootNodeId]!.children = [...nodeFragment.rootIds]
          didMutate = true
          return page.id
        },

        addStyleRule(rule: NewStyleRule): string {
          const id = nanoid()
          const now = Date.now()
          // Append after every existing rule so imports don't disrupt the
          // established cascade order.
          let maxOrder = -1
          for (const r of Object.values(site.styleRules)) {
            if (typeof r.order === 'number' && r.order > maxOrder) maxOrder = r.order
          }
          const newRule: StyleRule = {
            ...rule,
            id,
            createdAt: now,
            updatedAt: now,
            order: maxOrder + 1,
          }
          site.styleRules[id] = newRule
          // Register in byName so subsequent addPage calls referencing this
          // class name resolve to this id rather than creating a duplicate.
          if (rule.kind === 'class') byName.set(rule.name, id)
          didMutate = true
          return id
        },

        overwritePage(pageId: string, { title, slug, nodeFragment }: { title: string; slug: string; nodeFragment: ImportFragment }): void {
          const page = site.pages.find((p) => p.id === pageId)
          if (!page) throw new Error('overwritePage: page not found')

          // Mint a fresh body root; wire fragment roots as its children.
          const rootNode = createNode('base.body')
          rootNode.children = [...nodeFragment.rootIds]

          const newNodes: Record<string, PageNode> = { [rootNode.id]: rootNode }
          for (const [id, node] of Object.entries(nodeFragment.nodes)) {
            newNodes[id] = {
              ...node,
              classIds: linkImportedClassNames(node.classIds, site.styleRules, byName),
            }
          }

          // Replace tree fields; preserve identity + ownership fields.
          page.rootNodeId = rootNode.id
          page.nodes = newNodes
          page.title = title
          page.slug = slug
          didMutate = true
        },

        overwriteStyleRule(ruleId: string, rule: NewStyleRule): void {
          const existing = site.styleRules[ruleId]
          if (!existing) throw new Error('overwriteStyleRule: style rule not found')

          const now = Date.now()
          // Replace all fields except identity + cascade position.
          site.styleRules[ruleId] = {
            ...rule,
            id: ruleId,
            createdAt: existing.createdAt,
            updatedAt: now,
            order: existing.order,
          }
          if (rule.kind === 'class') byName.set(rule.name, ruleId)
          didMutate = true
        },

        addConditions(conditions): void {
          if (conditions.length === 0) return
          if (!site.conditions) site.conditions = []
          const existing = new Set(site.conditions.map((c) => c.id))
          for (const def of conditions) {
            if (existing.has(def.id)) continue
            existing.add(def.id)
            site.conditions.push(def)
            didMutate = true
          }
        },

        addFonts(fonts): { id: string; family: string }[] {
          const committed = addImportedFonts(site, fonts)
          if (committed.length > 0) didMutate = true
          return committed
        },
      }

      const result = fn(site as SiteDocument, helpers)
      if (recipeDidMutate(result) && didMutate) {
        pushHistorySnapshot(state, snapshot)
        state.site.updatedAt = Date.now()
        state.hasUnsavedChanges = true
        changed = true
      }
    })
    return changed
  }

  return {
    set,
    get,
    pushHistory,
    mutatePage,
    mutateActiveTree,
    mutateActiveTreeAndSite,
    mutateSite,
    mutateSiteState,
    mutateAllPagesAndSite,
  }
}

/**
 * Build `FontEntry` items (`source: 'custom'`) from imported `@font-face`
 * families and merge them into `site.settings.fonts`, replacing any existing
 * custom entry of the same family (case-insensitive). Each file's `src` is
 * already a final media URL; `subset` defaults to `'latin'` since imported
 * faces aren't subset-sliced.
 *
 * @returns The committed `{ id, family }` for each added font.
 */
function addImportedFonts(
  site: Draft<SiteDocument>,
  fonts: ImportFontFamily[],
): { id: string; family: string }[] {
  if (fonts.length === 0) return []
  site.settings.fonts ??= { items: [] }
  const lib = site.settings.fonts
  const committed: { id: string; family: string }[] = []

  for (const font of fonts) {
    if (font.files.length === 0) continue
    const id = nanoid()
    const now = Date.now()
    const files: FontFile[] = font.files.map((f) => ({
      variant: f.variant,
      subset: 'latin',
      path: f.src,
      format: f.format,
      ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
    }))
    const variants = Array.from(new Set(files.map((f) => f.variant)))
    const entry: FontEntry = {
      id,
      source: 'custom',
      family: font.family,
      variants,
      subsets: ['latin'],
      files,
      createdAt: now,
      updatedAt: now,
    }

    const familyLower = font.family.toLowerCase()
    const idx = lib.items.findIndex(
      (f) => f.family.toLowerCase() === familyLower && f.source === 'custom',
    )
    if (idx >= 0) lib.items[idx] = entry
    else lib.items.push(entry)
    committed.push({ id, family: font.family })
  }

  return committed
}
