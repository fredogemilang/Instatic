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

import type { StoreApi } from 'zustand'
import type {
  BaseNode,
  NodeTree,
  Page,
  PageNode,
  SiteDocument,
} from '@core/page-tree'
import { syncSlotInstances, applySlotSyncResult } from '@core/visualComponents/slotSync'
import type { EditorStore } from '@site/store/types'
import { MAX_HISTORY } from './defaults'
import type { SiteMutationResult, SiteSliceHelpers, SiteSliceImmerRecipe } from './types'

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
   * on `site.classes`) atomically with the node duplication. Without this
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

  return {
    set,
    get,
    pushHistory,
    mutatePage,
    mutateActiveTree,
    mutateActiveTreeAndSite,
    mutateSite,
    mutateSiteState,
  }
}
