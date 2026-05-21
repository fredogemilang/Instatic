/**
 * Node mutation actions for the active document tree.
 *
 * The 11 named tree-mutation actions (`insertNode`, `deleteNode`,
 * `updateNodeProps`, `setBreakpointOverride`, `clearBreakpointOverride`,
 * `renameNode`, `toggleNodeLocked`, `toggleNodeHidden`, `moveNode`,
 * `duplicateNode`, `wrapNode`) all delegate to `mutateActiveTree(fn)` and
 * MUST NOT contain their own `kind === 'visualComponent'` branch — that
 * routing is the sole job of `mutateActiveTree`. Gated by
 * `src/__tests__/architecture/no-vc-mode-branches-in-mutations.test.ts`.
 */

import { nanoid } from 'nanoid'
import { registry } from '@core/module-engine/registry'
import { wouldCreateCycle } from '@core/visualComponents/recursionGuard'
import {
  cloneScopedClassesForNodeMap,
  createNode,
  insertNode,
  deleteNode,
  updateNodeProps,
  setBreakpointOverride,
  clearBreakpointOverride,
  renameNode,
  toggleNodeLocked,
  toggleNodeHidden,
  moveNode,
  moveNodes,
  duplicateNode,
  wrapNode,
  wrapNodes,
} from '@core/page-tree'
import type { NodeTree, PageNode, SiteDocument } from '@core/page-tree'
import { syncSlotInstances, applySlotSyncResult } from '@core/visualComponents/slotSync'
import { depthInTree } from './helpers'
import type { SiteSlice, SiteSliceHelpers } from './types'

export type NodeActions = Pick<
  SiteSlice,
  | 'insertNode'
  | 'insertComponentRef'
  | 'deleteNode'
  | 'deleteNodes'
  | 'updateNodeProps'
  | 'setBreakpointOverride'
  | 'clearBreakpointOverride'
  | 'renameNode'
  | 'toggleNodeLocked'
  | 'toggleNodeHidden'
  | 'moveNode'
  | 'moveNodes'
  | 'duplicateNode'
  | 'duplicateNodes'
  | 'wrapNode'
  | 'wrapNodes'
  | 'setNodeDynamicBinding'
  | 'clearNodeDynamicBinding'
>

/**
 * Build the oldId → newId map for the entire subtree rooted at `nodeId`.
 * Pre-computed so callers can clone scoped classes (which key on
 * `scope.nodeId`) against the same id remap that the duplicate mutation will
 * apply to the nodes themselves.
 */
function buildSubtreeIdMap(
  tree: NodeTree<PageNode>,
  nodeId: string,
): Map<string, string> {
  const idMap = new Map<string, string>()
  const stack = [nodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (idMap.has(id)) continue
    const node = tree.nodes[id]
    if (!node) continue
    idMap.set(id, nanoid())
    stack.push(...node.children)
  }
  return idMap
}

/**
 * Duplicate a node subtree AND clone every per-node scoped class owned by the
 * subtree. Mirrors the contract used by `clipboardSlice.pasteNode` and
 * `visualComponentsSlice.clonePageSubtreeToFlatNodes` so the publisher can
 * never end up with two nodes pointing at the same scoped class — see F-0005.
 *
 * Must run inside an Immer producer (mutates `tree` and `site` directly).
 */
function duplicateNodeWithScopedClasses(
  tree: NodeTree<PageNode>,
  site: SiteDocument,
  nodeId: string,
): string {
  const nodeIdMap = buildSubtreeIdMap(tree, nodeId)
  if (nodeIdMap.size === 0) return ''

  const { added, classIdRemap } = cloneScopedClassesForNodeMap(nodeIdMap, site.classes)
  for (const cls of added) site.classes[cls.id] = cls

  return duplicateNode(tree, nodeId, { nodeIdMap, classIdRemap })
}

function recordPatchChanges(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): boolean {
  return Object.entries(patch).some(([key, value]) => !Object.is(current[key], value))
}

export function createNodeActions(helpers: SiteSliceHelpers): NodeActions {
  const { get, set, mutatePage, mutateActiveTree, mutateActiveTreeAndSite } = helpers

  const actions: NodeActions = {
    insertNode: (moduleId, defaults, parentId, index) => {
      const mod = registry.get(moduleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      const newNode = createNode(moduleId, resolvedDefaults)
      mutateActiveTree((tree) => {
        insertNode(tree, newNode, parentId, index)
        return true
      })
      return newNode.id
    },

    insertComponentRef: (parentId, componentId, index) => {
      if (!componentId) return null

      const { activeDocument, site } = get()

      // In VC mode, guard against cyclic component references before insertion.
      if (activeDocument?.kind === 'visualComponent' && site) {
        if (wouldCreateCycle(site.visualComponents, activeDocument.vcId, componentId)) {
          console.warn('[component-system] cycle prevented by recursion guard')
          return null
        }
      }

      // Insert the VC ref node (no props beyond componentId + propOverrides).
      // `index` forwards through to insertNode so callers using
      // resolveInsertLocation can drop the ref at a precise sibling position.
      const refNodeId = actions.insertNode(
        'base.visual-component-ref',
        { componentId, propOverrides: {} },
        parentId,
        index,
      )

      // Immediately materialize slot-instance children for each slot param the VC declares.
      // `insertNode` → `mutateActiveTree` already committed the undo snapshot; we mutate
      // inside another set() call here to keep slot insertion in the same logical action.
      const currentSite = get().site
      const vc = currentSite?.visualComponents.find((v) => v.id === componentId)
      if (vc) {
        set((state) => {
          if (!state.site) return
          const { activeDocument: ad } = state

          type NodeMap = Record<string, import('@core/page-tree/baseNode').BaseNode>
          const treeNodes: NodeMap | null = (() => {
            if (ad?.kind === 'visualComponent') {
              const activeVc = state.site!.visualComponents.find((v) => v.id === ad.vcId)
              return activeVc ? (activeVc.tree.nodes as NodeMap) : null
            }
            const pageId = ad?.kind === 'page' ? ad.pageId : state.activePageId
            const page = state.site!.pages.find((p) => p.id === pageId)
            return page ? (page.nodes as NodeMap) : null
          })()

          if (!treeNodes) return

          const vcRefNode = treeNodes[refNodeId]
          if (!vcRefNode) return

          const syncResult = syncSlotInstances(vcRefNode, vc, treeNodes)
          applySlotSyncResult(treeNodes, syncResult, refNodeId)
          state.site.updatedAt = Date.now()
        })
      }

      return refNodeId
    },

    deleteNode: (nodeId) => {
      const deleted = mutateActiveTree((tree) => {
        if (!tree.nodes[nodeId]) return false
        deleteNode(tree, nodeId)
        return true
      })
      if (deleted && get().selectedNodeId === nodeId) {
        set((state) => { state.selectedNodeId = null })
      }
    },

    updateNodeProps: (nodeId, patch) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        if (!recordPatchChanges(node.props, patch)) return false
        updateNodeProps(tree, nodeId, patch)
        return true
      })
    },

    setBreakpointOverride: (nodeId, breakpointId, patch) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        if (!recordPatchChanges(node.breakpointOverrides[breakpointId] ?? {}, patch)) {
          return false
        }
        setBreakpointOverride(tree, nodeId, breakpointId, patch)
        return true
      })
    },

    clearBreakpointOverride: (nodeId, breakpointId) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node?.breakpointOverrides[breakpointId]) return false
        clearBreakpointOverride(tree, nodeId, breakpointId)
        return true
      })
    },

    renameNode: (nodeId, label) => {
      mutateActiveTree((tree) => {
        const node = tree.nodes[nodeId]
        if (!node) throw new Error(`[PageTree] Node "${nodeId}" not found`)
        const nextLabel = label.trim() || undefined
        if (node.label === nextLabel) return false
        renameNode(tree, nodeId, label)
        return true
      })
    },

    toggleNodeLocked: (nodeId) => {
      mutateActiveTree((tree) => {
        toggleNodeLocked(tree, nodeId)
        return true
      })
    },

    toggleNodeHidden: (nodeId) => {
      mutateActiveTree((tree) => {
        toggleNodeHidden(tree, nodeId)
        return true
      })
    },

    moveNode: (nodeId, newParentId, newIndex) => {
      mutateActiveTree((tree) => {
        moveNode(tree, nodeId, newParentId, newIndex)
        return true
      })
    },

    moveNodes: (nodeIds, newParentId, newIndex) => {
      if (nodeIds.length === 0) return
      mutateActiveTree((tree) => {
        moveNodes(tree, nodeIds, newParentId, newIndex)
        return true
      })
    },

    duplicateNode: (nodeId) => {
      let newId = ''
      // Per-node "module-style" classes (scope.type === 'node') must be cloned
      // alongside the node — otherwise the duplicate's classIds carry the
      // source's class id and editing one node restyles both. F-0005.
      mutateActiveTreeAndSite((tree, site) => {
        if (!tree.nodes[nodeId]) return false
        newId = duplicateNodeWithScopedClasses(tree, site, nodeId)
        return newId ? true : false
      })
      return newId
    },

    duplicateNodes: (nodeIds) => {
      if (nodeIds.length === 0) return []
      const newIds: string[] = []
      mutateActiveTreeAndSite((tree, site) => {
        for (const id of nodeIds) {
          // Skip the root and any id missing from the tree — duplicateNode
          // throws on the root, and silently skipping orphans matches the
          // delete/move guards.
          if (!tree.nodes[id] || id === tree.rootNodeId) continue
          newIds.push(duplicateNodeWithScopedClasses(tree, site, id))
        }
        return newIds.length > 0
      })
      return newIds
    },

    deleteNodes: (nodeIds) => {
      if (nodeIds.length === 0) return
      mutateActiveTree((tree) => {
        // Delete each id; descendants of an already-deleted id are gone, so the
        // helper's "node not found" branch handles the redundant case cleanly.
        // We sort by depth-DESC so leaves go first, avoiding noisy throws when
        // a parent is deleted before its child in the same batch.
        const ordered = [...nodeIds].sort(
          (a, b) => depthInTree(tree, b) - depthInTree(tree, a),
        )
        let changed = false
        for (const id of ordered) {
          if (id === tree.rootNodeId) continue
          if (!tree.nodes[id]) continue
          deleteNode(tree, id)
          changed = true
        }
        return changed
      })
    },

    wrapNode: (nodeId, containerModuleId, defaults = {}) => {
      // Auto-resolve the module's schema defaults so the wrapper node renders correctly.
      // Without this, wrapNode(id, 'base.container') produces props:{} → props.tag=undefined
      // → React.createElement(undefined) → "Element type is invalid" crash (Task #414).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId = ''
      mutateActiveTree((tree) => {
        wrapperId = wrapNode(tree, nodeId, containerModuleId, resolvedDefaults)
        return true
      })
      return wrapperId
    },

    wrapNodes: (nodeIds, containerModuleId, defaults = {}) => {
      if (nodeIds.length === 0) return null
      // Same defaults-resolution rule as `wrapNode` (Task #414 — defaults must
      // come from the module registry so the wrapper renders).
      const mod = registry.get(containerModuleId)
      const resolvedDefaults = { ...(mod?.defaults ?? {}), ...defaults }
      let wrapperId: string | null = null
      mutateActiveTree((tree) => {
        wrapperId = wrapNodes(tree, nodeIds, containerModuleId, resolvedDefaults)
        return true
      })
      return wrapperId
    },

    setNodeDynamicBinding: (nodeId, propKey, binding) => {
      mutatePage((page) => {
        const node = page.nodes[nodeId]
        if (!node) return false
        const current = node.dynamicBindings?.[propKey]
        if (
          current &&
          current.source === binding.source &&
          current.field === binding.field &&
          current.format === binding.format &&
          current.fallback === binding.fallback
        ) {
          return false
        }
        node.dynamicBindings = {
          ...(node.dynamicBindings ?? {}),
          [propKey]: binding,
        }
        return true
      })
    },

    clearNodeDynamicBinding: (nodeId, propKey) => {
      mutatePage((page) => {
        const node = page.nodes[nodeId]
        if (!node?.dynamicBindings?.[propKey]) return false
        delete node.dynamicBindings[propKey]
        if (Object.keys(node.dynamicBindings).length === 0) {
          delete node.dynamicBindings
        }
        return true
      })
    },
  }

  return actions
}
