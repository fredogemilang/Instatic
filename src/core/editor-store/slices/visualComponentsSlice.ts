/**
 * visualComponentsSlice — Visual Components Data Layer store slice.
 *
 * Architecture source: Contribution #619 §2, §3, §6, §10 (Task #436)
 *
 * Manages site.visualComponents[] CRUD.
 * State lives in site.visualComponents (owned by siteSlice);
 * this slice owns only the action methods — same pattern as filesSlice.
 *
 * Every write boundary:
 *  - Calls validateComponentName() and throws on invalid name.
 *  - Calls wouldCreateCycle() at addNodeToVc boundary and throws on cycle.
 *
 * Constraint #269: MUST NOT import from editor/.
 * This is a pure data-layer slice.
 */

import { nanoid } from 'nanoid'
import type { EditorStoreSliceCreator } from '../types'
import type { VisualComponent, VCParam, VCNode } from '@core/visualComponents/schemas'
import type { PageNode, CSSClass } from '@core/page-tree/schemas'
import { validateComponentName, validateParamName } from '@core/visualComponents/nameValidation'
import { wouldCreateCycle } from '@core/visualComponents/recursionGuard'

// ---------------------------------------------------------------------------
// Custom error types (exported so UI + tests can catch by class)
// ---------------------------------------------------------------------------

export class VisualComponentNameError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentNameError'
    this.code = code
  }
}

class VisualComponentParamNameError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentParamNameError'
    this.code = code
  }
}

export class VisualComponentRecursionError extends Error {
  constructor(message: string) {
    super(`[visualComponentsSlice] ${message}`)
    this.name = 'VisualComponentRecursionError'
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** DFS to find a node by ID in a VC tree (walks childNodes) */
function findNodeById(root: VCNode, id: string): VCNode | null {
  if (root.id === id) return root
  if (root.childNodes) {
    for (const child of root.childNodes) {
      const found = findNodeById(child, id)
      if (found) return found
    }
  }
  return null
}

/**
 * Collect all paramIds currently referenced by propBindings in the VC tree.
 * Used by clearNodePropBinding to determine if an orphan param can be GC'd.
 */
function collectAllBoundParamIds(root: VCNode): Set<string> {
  const result = new Set<string>()
  function visit(node: VCNode) {
    if (node.propBindings) {
      for (const binding of Object.values(node.propBindings)) {
        result.add(binding.paramId)
      }
    }
    if (node.childNodes) {
      for (const child of node.childNodes) visit(child)
    }
  }
  visit(root)
  return result
}

/**
 * Walk a VCNode tree and delete every propBinding entry where
 * binding.paramId === targetParamId. Leaves the propBindings object
 * intact (even if empty) for consistency with existing slice behaviour.
 */
function removePropBindingsByParamId(node: VCNode, targetParamId: string): void {
  if (node.propBindings) {
    for (const propKey of Object.keys(node.propBindings)) {
      if (node.propBindings[propKey].paramId === targetParamId) {
        delete node.propBindings[propKey]
      }
    }
  }
  if (node.childNodes) {
    for (const child of node.childNodes) {
      removePropBindingsByParamId(child, targetParamId)
    }
  }
}

/**
 * Collect all VC componentIds referenced by base.visual-component-ref nodes
 * in the page's flat-map subtree rooted at rootNodeId.
 */
function collectVCRefsFromPageSubtree(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
): Set<string> {
  const refs = new Set<string>()
  const stack: string[] = [rootNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = pageNodes[id]
    if (!node) continue
    if (node.moduleId === 'base.visual-component-ref') {
      const componentId = node.props.componentId
      if (typeof componentId === 'string' && componentId.length > 0) {
        refs.add(componentId)
      }
    }
    stack.push(...node.children)
  }
  return refs
}

/**
 * Collect all node IDs in the page flat-map subtree rooted at rootNodeId (DFS).
 */
function collectSubtreeNodeIds(
  pageNodes: Record<string, PageNode>,
  rootNodeId: string,
): string[] {
  const ids: string[] = []
  const stack: string[] = [rootNodeId]
  while (stack.length > 0) {
    const id = stack.pop()!
    const node = pageNodes[id]
    if (!node) continue
    ids.push(id)
    stack.push(...node.children)
  }
  return ids
}

/**
 * Recursively clone a page's flat-map subtree into a nested VCNode tree.
 *
 * - Allocates a fresh nanoid() for every cloned node.
 * - Populates idMap (oldId → newId) for each visited node so that
 *   parent `children` string arrays can reference the correct new IDs.
 * - For node-scoped classes (scope.type === 'node' && scope.nodeId === oldId):
 *   rewrites scope.nodeId to the new ID in-place (must run inside an Immer
 *   producer) and records the classId in hoistedClassIds so the caller can
 *   attach it to the new VC's top-level classIds array.
 * - dynamicBindings is intentionally NOT copied — VCNode has no dynamicBindings.
 */
function clonePageSubtreeAsVCNode(
  pageNodes: Record<string, PageNode>,
  nodeId: string,
  siteClasses: Record<string, CSSClass>,
  idMap: Map<string, string>,
  hoistedClassIds: Set<string>,
): VCNode {
  const pageNode = pageNodes[nodeId]
  if (!pageNode) {
    throw new Error(`convertNodeToComponent: page node "${nodeId}" not found during clone`)
  }

  // Allocate fresh ID for this node FIRST so children can reference it via idMap
  const newId = nanoid()
  idMap.set(nodeId, newId)

  // Recursively clone all children (each call populates idMap for that child)
  const childNodes: VCNode[] = pageNode.children.map((childId) =>
    clonePageSubtreeAsVCNode(pageNodes, childId, siteClasses, idMap, hoistedClassIds),
  )

  // Process classIds: rewrite node-scoped ones to the new ID and hoist to VC level
  const clonedClassIds: string[] = []
  for (const classId of pageNode.classIds) {
    const cls = siteClasses[classId]
    if (cls && cls.scope?.type === 'node' && cls.scope.nodeId === nodeId) {
      // Rewrite scope in-place (Immer draft mutation)
      cls.scope.nodeId = newId
      hoistedClassIds.add(classId)
    }
    // Always carry classId onto the cloned node (whether scoped or generic)
    clonedClassIds.push(classId)
  }

  const vcNode: VCNode = {
    id: newId,
    moduleId: pageNode.moduleId,
    props: { ...pageNode.props },
    breakpointOverrides: Object.fromEntries(
      Object.entries(pageNode.breakpointOverrides).map(([k, v]) => [k, { ...v }]),
    ),
    // children string[] must reference the NEW ids of direct children
    children: pageNode.children.map((childId) => idMap.get(childId)!),
    classIds: clonedClassIds,
    childNodes,
  }

  // Carry optional fields (dynamicBindings excluded — VCNode has no dynamicBindings field)
  if (pageNode.label !== undefined) vcNode.label = pageNode.label
  if (pageNode.locked !== undefined) vcNode.locked = pageNode.locked
  if (pageNode.hidden !== undefined) vcNode.hidden = pageNode.hidden
  if (pageNode.propBindings !== undefined) {
    vcNode.propBindings = Object.fromEntries(
      Object.entries(pageNode.propBindings).map(([k, v]) => [k, { ...v }]),
    )
  }

  return vcNode
}

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface VisualComponentsSlice {
  /**
   * Create a new Visual Component with the given (free-form) name.
   * Returns the new VC's id.
   *
   * Throws VisualComponentNameError if:
   * - `name` is empty / whitespace-only, or already used by another VC in the site.
   */
  createVisualComponent(name: string): string

  /**
   * Rename a Visual Component.
   *
   * Throws VisualComponentNameError if the new name is invalid.
   * No-op if the id does not exist.
   * Self-rename (same name) is a no-op and does NOT throw.
   */
  renameVisualComponent(id: string, newName: string): void

  /**
   * Delete a Visual Component by id.
   * No-op if the id does not exist.
   */
  deleteVisualComponent(id: string): void

  /**
   * Add a param to a VC's param surface.
   * Returns the new param's stable id.
   * No-op if the VC does not exist.
   */
  addParam(vcId: string, name: string, type: VCParam['type'], defaultValue?: unknown): string

  /**
   * Remove a param from a VC by its stable id AND clean up all references to it:
   *  - Deletes every propBinding in the VC tree that references the param.
   *  - For every page node that is a base.visual-component-ref pointing at this VC,
   *    deletes node.props.propOverrides[paramId] and (for slot params)
   *    node.props.slotContent[param.name].
   *
   * No-op if the VC or param does not exist.
   */
  removeParamWithCleanup(vcId: string, paramId: string): void

  /**
   * Add a new node to a VC's canvas tree under `parentNodeId`.
   *
   * Throws VisualComponentRecursionError if `newNode` is a
   * base.visual-component-ref that would create a cycle.
   *
   * No-op if the VC or parent node does not exist.
   */
  addNodeToVc(vcId: string, parentNodeId: string, newNode: VCNode): void

  /**
   * Bind a node's prop to a VC param.
   * Operates on the active VC tree (activeDocument.kind === 'visualComponent') or
   * the active page (activeDocument is null or kind === 'page').
   * Throws if no page is active in the editor.
   * No-op if the node or document is not found.
   */
  setNodePropBinding(nodeId: string, propKey: string, paramId: string): void

  /**
   * Remove a prop binding from a node.
   * In VC mode: GCs the param from vc.params if no other node still references it.
   * No-op if the node or binding is not found.
   */
  clearNodePropBinding(nodeId: string, propKey: string): void

  /**
   * Update the defaultValue of a VC param.
   * No-op if the VC or param is not found.
   */
  updateParamDefaultValue(vcId: string, paramId: string, value: unknown): void

  /**
   * Rename a VC param. Validates non-empty + uniqueness before mutating.
   * Throws VisualComponentParamNameError on invalid name.
   * Because propBindings and propOverrides reference paramId (not name),
   * no other rewriting is needed.
   * No-op if the VC or param is not found.
   */
  renameParam(vcId: string, paramId: string, newName: string): void

  /**
   * Partial update of a param's metadata: required, description, enumOptions.
   * Strips enumOptions when param.type !== 'enum' (defensive).
   * Treats empty description as undefined (removes the field).
   * No-op if the VC or param is not found.
   */
  updateParamMeta(vcId: string, paramId: string, patch: { required?: boolean; description?: string; enumOptions?: string[] }): void

  /**
   * Convert an existing page node (and its entire subtree) into a new Visual Component.
   *
   * The source node is removed from the page and replaced with a
   * base.visual-component-ref pointing at the new VC. The editor switches
   * to the new VC's canvas automatically.
   *
   * Returns the new VC's id.
   *
   * Throws VisualComponentNameError if `name` is invalid.
   * Throws VisualComponentRecursionError if the subtree would introduce a
   * reference cycle (checked via subtree VC reference integrity).
   * Throws a plain Error for:
   *   - Called while editing a visual component (activeDocument.kind === 'visualComponent')
   *   - No page is active in the editor (activeDocument === null && activePageId === null)
   *   - nodeId not found on the active page
   *   - Source node is a base.visual-component-ref or base.body (cannot re-wrap)
   *   - nodeId is the page root
   */
  convertNodeToComponent(nodeId: string, name: string): string
}

// ---------------------------------------------------------------------------
// Slice implementation
// ---------------------------------------------------------------------------

// Contribute this slice's fields to the combined `EditorStore` type via TS
// module augmentation. See `../types.ts` for why we use this pattern.
declare module '@core/editor-store/types' {
  interface EditorStore extends VisualComponentsSlice {}
}

export const createVisualComponentsSlice: EditorStoreSliceCreator<VisualComponentsSlice> = (set, get) => ({

  createVisualComponent(name) {
    const { site } = get()
    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    const validation = validateComponentName(name, site.visualComponents ?? [])
    if (!validation.ok) {
      throw new VisualComponentNameError(validation.reason, validation.error)
    }

    const trimmedName = name.trim()
    const id = nanoid()
    const rootNodeId = nanoid()
    const now = Date.now()

    const rootNode: VCNode = {
      id: rootNodeId,
      moduleId: 'base.body',
      props: {},
      children: [],
      breakpointOverrides: {},
      classIds: [],
    }

    const newVC: VisualComponent = {
      id,
      name: trimmedName,
      rootNode,
      params: [],
      breakpoints: [],
      classIds: [],
      createdAt: now,
    }

    set((state) => {
        if (!state.site) return
        if (!state.site.visualComponents) state.site.visualComponents = []
        state.site.visualComponents.push(newVC)
        state.site.updatedAt = now
      })

    return id
  },

  renameVisualComponent(id, newName) {
    const { site } = get()
    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    const validation = validateComponentName(newName, site.visualComponents ?? [], id)
    if (!validation.ok) {
      throw new VisualComponentNameError(validation.reason, validation.error)
    }

    const trimmedName = newName.trim()

    set((state) => {
        if (!state.site) return
        const vc = (state.site.visualComponents ?? []).find((v) => v.id === id)
        if (!vc) return
        vc.name = trimmedName
        state.site.updatedAt = Date.now()
      })
  },

  deleteVisualComponent(id) {
    set((state) => {
        if (!state.site) return
        if (!state.site.visualComponents) return
        const idx = state.site.visualComponents.findIndex((v) => v.id === id)
        if (idx === -1) return
        state.site.visualComponents.splice(idx, 1)
        state.site.updatedAt = Date.now()
      })
  },

  addParam(vcId, name, type, defaultValue = '') {
    // Validate param name BEFORE entering Immer (pure read from current state)
    const { site } = get()
    if (site) {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (vc) {
        const validation = validateParamName(name, vc.params)
        if (!validation.ok) {
          throw new VisualComponentParamNameError(validation.reason, validation.error)
        }
      }
    }

    const paramId = nanoid()
    const trimmedName = name.trim()

    set((state) => {
        if (!state.site) return
        const vc = (state.site.visualComponents ?? []).find((v) => v.id === vcId)
        if (!vc) return

        const newParam: VCParam = {
          id: paramId,
          name: trimmedName,
          type,
          defaultValue,
          required: false,
        }
        vc.params.push(newParam)
        state.site.updatedAt = Date.now()
      })

    return paramId
  },

  removeParamWithCleanup(vcId, paramId) {
    set((state) => {
        if (!state.site) return

        const vc = (state.site.visualComponents ?? []).find((v) => v.id === vcId)
        if (!vc) return

        const paramIdx = vc.params.findIndex((p) => p.id === paramId)
        if (paramIdx === -1) return

        // Capture before deletion — slotContent is keyed by param name, not id
        const param = vc.params[paramIdx]
        const paramName = param.name
        const isSlot = param.type === 'slot'

        // 1. Remove propBindings referencing this param from the VC tree
        removePropBindingsByParamId(vc.rootNode, paramId)

        // 2. Clean up every page node that is a base.visual-component-ref for this VC
        for (const page of state.site.pages) {
          for (const node of Object.values(page.nodes)) {
            if (
              node.moduleId === 'base.visual-component-ref' &&
              node.props.componentId === vcId
            ) {
              const overrides = node.props.propOverrides
              if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
                delete (overrides as Record<string, unknown>)[paramId]
              }

              if (isSlot) {
                const slotContent = node.props.slotContent
                if (slotContent && typeof slotContent === 'object' && !Array.isArray(slotContent)) {
                  delete (slotContent as Record<string, unknown>)[paramName]
                }
              }
            }
          }
        }

        // 3. Remove the param itself
        vc.params.splice(paramIdx, 1)

        state.site.updatedAt = Date.now()
      })
  },

  addNodeToVc(vcId, parentNodeId, newNode) {
    const { site } = get()
    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    const vcs = site.visualComponents ?? []

    // Cycle guard — runs BEFORE any state mutation (slice write boundary, §3)
    if (newNode.moduleId === 'base.visual-component-ref') {
      const componentId = (newNode.props as Record<string, unknown>).componentId
      if (typeof componentId === 'string') {
        if (wouldCreateCycle(vcs, vcId, componentId)) {
          throw new VisualComponentRecursionError(
            `Circular component reference: embedding "${componentId}" inside "${vcId}" would create a cycle.`,
          )
        }
      }
    }

    set((state) => {
        if (!state.site) return
        const vc = (state.site.visualComponents ?? []).find((v) => v.id === vcId)
        if (!vc) return

        const parent = findNodeById(vc.rootNode, parentNodeId)
        if (!parent) return

        // Duplicate-node-id guard — silently no-op if node ID already exists in the tree
        if (findNodeById(vc.rootNode, newNode.id)) return

        // Add to flat children IDs list (standard PageNode.children)
        if (!parent.children) parent.children = []
        parent.children.push(newNode.id)

        // Add to nested childNodes list (VC tree traversal format)
        if (!parent.childNodes) parent.childNodes = []
        parent.childNodes.push(newNode)

        state.site.updatedAt = Date.now()
      })
  },

  setNodePropBinding(nodeId, propKey, paramId) {
    const { activeDocument, activePageId } = get()

    set((state) => {
        if (!state.site) return

        if (activeDocument?.kind === 'visualComponent') {
          const vc = (state.site.visualComponents ?? []).find((v) => v.id === activeDocument.vcId)
          if (!vc) return
          const node = findNodeById(vc.rootNode, nodeId)
          if (!node) return
          if (!node.propBindings) node.propBindings = {}
          node.propBindings[propKey] = { paramId }
        } else {
          const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : activePageId
          if (pageId == null) {
            throw new Error('setNodePropBinding: no page is active in the editor')
          }
          const page = (state.site.pages ?? []).find((p) => p.id === pageId)
          if (!page) return
          const node = page.nodes[nodeId]
          if (!node) return
          if (!node.propBindings) node.propBindings = {}
          node.propBindings[propKey] = { paramId }
        }

        state.site.updatedAt = Date.now()
      })
  },

  clearNodePropBinding(nodeId, propKey) {
    const { activeDocument, activePageId } = get()

    set((state) => {
        if (!state.site) return

        if (activeDocument?.kind === 'visualComponent') {
          const vc = (state.site.visualComponents ?? []).find((v) => v.id === activeDocument.vcId)
          if (!vc) return
          const node = findNodeById(vc.rootNode, nodeId)
          if (!node?.propBindings) return

          const removedParamId = node.propBindings[propKey]?.paramId
          delete node.propBindings[propKey]

          // GC: remove orphan param if no other node references it
          if (removedParamId) {
            const stillBound = collectAllBoundParamIds(vc.rootNode)
            if (!stillBound.has(removedParamId)) {
              const idx = vc.params.findIndex((p) => p.id === removedParamId)
              if (idx !== -1) vc.params.splice(idx, 1)
            }
          }
        } else {
          const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : activePageId
          if (pageId == null) {
            throw new Error('clearNodePropBinding: no page is active in the editor')
          }
          const page = (state.site.pages ?? []).find((p) => p.id === pageId)
          if (!page) return
          const node = page.nodes[nodeId]
          if (!node?.propBindings) return
          delete node.propBindings[propKey]
        }

        state.site.updatedAt = Date.now()
      })
  },

  updateParamDefaultValue(vcId, paramId, value) {
    set((state) => {
        if (!state.site) return
        const vc = (state.site.visualComponents ?? []).find((v) => v.id === vcId)
        if (!vc) return
        const param = vc.params.find((p) => p.id === paramId)
        if (!param) return
        param.defaultValue = value
        state.site.updatedAt = Date.now()
      })
  },

  renameParam(vcId, paramId, newName) {
    // Validate BEFORE entering Immer (reads current state via get())
    const { site } = get()
    if (site) {
      const vc = (site.visualComponents ?? []).find((v) => v.id === vcId)
      if (vc) {
        const validation = validateParamName(newName, vc.params, paramId)
        if (!validation.ok) {
          throw new VisualComponentParamNameError(validation.reason, validation.error)
        }
      }
    }

    const trimmedName = newName.trim()

    set((state) => {
        if (!state.site) return
        const vc = (state.site.visualComponents ?? []).find((v) => v.id === vcId)
        if (!vc) return
        const param = vc.params.find((p) => p.id === paramId)
        if (!param) return
        param.name = trimmedName
        state.site.updatedAt = Date.now()
      })
  },

  updateParamMeta(vcId, paramId, patch) {
    set((state) => {
        if (!state.site) return
        const vc = (state.site.visualComponents ?? []).find((v) => v.id === vcId)
        if (!vc) return
        const param = vc.params.find((p) => p.id === paramId)
        if (!param) return

        if ('required' in patch) param.required = patch.required ?? false
        if ('description' in patch) {
          param.description = patch.description || undefined
        }
        if ('enumOptions' in patch) {
          if (param.type === 'enum') {
            param.enumOptions = patch.enumOptions
          }
          // Defensive: strip enumOptions if param.type !== 'enum' (no-op via the if check)
        }

        state.site.updatedAt = Date.now()
      })
  },

  convertNodeToComponent(nodeId, name) {
    const { activeDocument, activePageId, site } = get()

    if (!site) throw new Error('[visualComponentsSlice] Site document is not initialized')

    // 1. Pre-validate name (mirrors renameVisualComponent pattern)
    const nameValidation = validateComponentName(name, site.visualComponents ?? [])
    if (!nameValidation.ok) {
      throw new VisualComponentNameError(nameValidation.reason, nameValidation.error)
    }
    const trimmedName = name.trim()

    // 2. Active document must be a page (null = default page canvas) — VC mode is not allowed
    if (activeDocument?.kind === 'visualComponent') {
      throw new Error('convertNodeToComponent: cannot convert from inside a visual component')
    }
    const pageId = activeDocument?.kind === 'page' ? activeDocument.pageId : activePageId
    if (pageId == null) {
      throw new Error('convertNodeToComponent: no page is active in the editor')
    }

    const page = (site.pages ?? []).find((p) => p.id === pageId)
    if (!page) {
      throw new Error(`convertNodeToComponent: page "${pageId}" not found`)
    }

    const sourceNode = page.nodes[nodeId]
    if (!sourceNode) {
      throw new Error(`convertNodeToComponent: node "${nodeId}" not found on page "${pageId}"`)
    }

    // 3. Reject re-wrapping a ref or root
    if (sourceNode.moduleId === 'base.visual-component-ref') {
      throw new Error('convertNodeToComponent: cannot convert a base.visual-component-ref node')
    }
    if (sourceNode.moduleId === 'base.body') {
      throw new Error('convertNodeToComponent: cannot convert a base.body node')
    }

    // 4. Data integrity check: all VCs referenced in the subtree must exist
    const vcRefs = collectVCRefsFromPageSubtree(page.nodes, nodeId)
    for (const vcRefId of vcRefs) {
      const refExists = (site.visualComponents ?? []).some((v) => v.id === vcRefId)
      if (!refExists) {
        throw new VisualComponentRecursionError(
          `Subtree references missing Visual Component "${vcRefId}" — data integrity error.`,
        )
      }
    }

    // newVcId is captured here so the producer can return it via closure
    let newVcId = ''

    set((state) => {
        if (!state.site) return

        const draftPage = (state.site.pages ?? []).find((p) => p.id === pageId)
        if (!draftPage) return

        // 5a. Generate the new VC id
        newVcId = nanoid()

        // 5b. Deep-clone the subtree from the page's flat nodes into a nested VCNode tree.
        // hoistedClassIds accumulates node-scoped class IDs that should be declared
        // at the new VC level (scope.nodeId is rewritten inside the helper).
        const idMap = new Map<string, string>()
        const hoistedClassIds = new Set<string>()
        const clonedRoot = clonePageSubtreeAsVCNode(
          draftPage.nodes,
          nodeId,
          state.site.classes,
          idMap,
          hoistedClassIds,
        )

        // 5d. Build the new VisualComponent
        const newVc: VisualComponent = {
          id: newVcId,
          name: trimmedName,
          rootNode: clonedRoot,
          params: [],
          breakpoints: [],
          classIds: [...hoistedClassIds],
          createdAt: Date.now(),
        }
        state.site.visualComponents.push(newVc)

        // 5e. Find the parent of the source node in the page
        let parentNode: PageNode | undefined
        for (const pNode of Object.values(draftPage.nodes)) {
          if (pNode.children.includes(nodeId)) {
            parentNode = pNode
            break
          }
        }

        if (!parentNode) {
          // nodeId has no parent — it is the page body; cannot convert
          throw new Error('convertNodeToComponent: cannot convert page body')
        }

        // Replace source nodeId with the new VC-ref node id in the parent's children
        const childIdx = parentNode.children.indexOf(nodeId)
        const refNodeId = nanoid()
        parentNode.children[childIdx] = refNodeId

        // Create the base.visual-component-ref page node
        draftPage.nodes[refNodeId] = {
          id: refNodeId,
          moduleId: 'base.visual-component-ref',
          props: { componentId: newVcId, propOverrides: {}, slotContent: {} },
          breakpointOverrides: {},
          children: [],
          classIds: [],
        }

        // Delete the original subtree from page.nodes (remove all descended nodes)
        const subtreeIds = collectSubtreeNodeIds(draftPage.nodes, nodeId)
        for (const oldId of subtreeIds) {
          delete draftPage.nodes[oldId]
        }

        // 5f. Switch activeDocument to the new VC; clear selection
        state.activeDocument = { kind: 'visualComponent', vcId: newVcId }
        state.selectedNodeId = null

        // 5g. Stamp updatedAt
        state.site.updatedAt = Date.now()
      })

    return newVcId
  },
})
