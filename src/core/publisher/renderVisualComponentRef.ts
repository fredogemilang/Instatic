/**
 * Publisher — `base.visual-component-ref` inlining.
 *
 * Specialised renderer for VC ref nodes. Instead of the standard
 * "render children → resolve props → call module.render()" flow, a VC ref
 * is materialised into a synthetic Page from the live VC definition and
 * walked recursively. Slot fills (the ref node's `base.slot-instance`
 * children) become the slot-outlet contents inside the instantiated tree.
 *
 * Takes `renderNode` as a parameter rather than importing it directly so
 * the file graph stays acyclic — the dispatcher in `renderNode.ts` is the
 * only thing that knows both ends of the recursion.
 */

import type { Page, PageNode } from '@core/page-tree'
import { selectVisualComponentById } from '@core/page-tree'
import { instantiateVCAtRef, type InstantiatedVCNode } from '@core/visualComponents'
import { injectNodeClassIds, injectNodeId, injectNodeInlineStyles } from './classInjection'
import { escapeHtml } from './utils'
import type { RenderContext } from './renderContext'

/**
 * Adapt an InstantiatedVCNode to the PageNode shape required by the publisher walker.
 *
 * VCNode is structurally compatible with PageNode for all fields the walker reads
 * (moduleId, props, breakpointOverrides, children, classIds). The extra
 * InstantiatedVCNode fields (_owningRefId, _fromSlotContent) are not part of
 * PageNode and are harmlessly ignored by the walker.
 * dynamicBindings is intentionally absent: VCNodes don't support template
 * bindings (those live only on page-level nodes).
 */
function instantiatedNodeToPageNode(node: InstantiatedVCNode): PageNode {
  return {
    id: node.id,
    moduleId: node.moduleId,
    props: node.props,
    breakpointOverrides: node.breakpointOverrides,
    children: node.children,
    label: node.label,
    locked: node.locked,
    hidden: node.hidden,
    classIds: node.classIds,
    propBindings: node.propBindings,
  }
}

/**
 * Render a base.visual-component-ref node by inlining its VC tree.
 *
 * Called by `renderNode` via the specialised-renderer dispatch for all
 * base.visual-component-ref nodes. The VC is instantiated via
 * instantiateVCAtRef (which applies propOverrides and expands slot outlets),
 * then rendered recursively using a synthetic Page built from the flat
 * instantiated node map. The shared ctx.cssMap ensures CSS deduplication
 * across the whole page — a VC used three times contributes module CSS only once.
 *
 * The page-level ref node's own classIds are injected onto the VC's root
 * element after recursive rendering, preserving the page author's intent.
 */
export function renderVisualComponentRef(
  node: PageNode,
  ctx: RenderContext,
  renderNode: (nodeId: string, ctx: RenderContext) => string,
): string {
  const componentId =
    typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
  if (!componentId) {
    return '<!-- instatic: visual-component-ref missing componentId -->'
  }

  const propOverrides =
    node.props.propOverrides !== null &&
    typeof node.props.propOverrides === 'object' &&
    !Array.isArray(node.props.propOverrides)
      ? (node.props.propOverrides as Record<string, unknown>)
      : {}

  const vc = selectVisualComponentById(ctx.site, componentId)
  if (!vc) {
    return `<!-- instatic: unknown component "${escapeHtml(componentId)}" -->`
  }

  // Build slotInstancesByName from this VC ref node's base.slot-instance children
  // in the page tree. Each slot-instance's children are the user-authored slot content.
  const slotInstancesByName: Record<string, string[]> = {}
  for (const childId of node.children ?? []) {
    const child = ctx.page.nodes[childId]
    if (child?.moduleId === 'base.slot-instance') {
      const slotName =
        typeof child.props.slotName === 'string' && child.props.slotName
          ? child.props.slotName
          : 'children'
      slotInstancesByName[slotName] = child.children ?? []
    }
  }

  const { nodes: instantiatedNodes, rootNodeId } = instantiateVCAtRef(
    vc,
    propOverrides,
    slotInstancesByName,
    ctx.page.nodes,
    node.id,
  )

  // Build a minimal synthetic Page from the instantiated flat node map.
  // Only nodes and rootNodeId are needed by the walker — other Page fields
  // are stubs (the VC has no URL, slug, or template configuration).
  const syntheticNodes: Record<string, PageNode> = {}
  for (const [id, vcNode] of Object.entries(instantiatedNodes)) {
    syntheticNodes[id] = instantiatedNodeToPageNode(vcNode)
  }

  const syntheticPage: Page = {
    id: `vc:${node.id}`,
    slug: '',
    title: '',
    nodes: syntheticNodes,
    rootNodeId,
  }

  // Reuse all context fields but swap the page for the VC's synthetic page.
  // Sharing cssMap is critical: CSS dedup is keyed by moduleId across the
  // whole published page, including all inlined VC instances.
  const syntheticCtx: RenderContext = {
    page: syntheticPage,
    site: ctx.site,
    registry: ctx.registry,
    breakpointId: ctx.breakpointId,
    templateContext: ctx.templateContext,
    cssMap: ctx.cssMap,
    // Thread the data-bearing fields so a base.loop / image inside the VC body
    // resolves with data (ISS-022). instantiateVCAtRef preserves vc.tree node
    // ids, so these maps (keyed by those ids) match the synthetic page nodes.
    // dynamicNodeIds is intentionally omitted: VC-internal holes aren't
    // supported — the OUTER ref is what gets holed.
    loopData: ctx.loopData,
    mediaAssets: ctx.mediaAssets,
    infiniteLoopIds: ctx.infiniteLoopIds,
    publishVersion: ctx.publishVersion,
    holeNodeIds: ctx.holeNodeIds,
    // Intentionally NOT propagated: VC-definition nodes are not part of the
    // page snapshot the agent reads, so they must not be annotated. Only the
    // page-level ref node id (applied below) lands on the VC's root element.
    annotateNodeIds: undefined,
  }

  // The page-level ref node's classIds + inline styles belong on the VC's root
  // element; the VC's own nodes contribute their classIds via the recursive call.
  const rendered = injectNodeClassIds(renderNode(rootNodeId, syntheticCtx), node.classIds, ctx.site)
  const withStyles = injectNodeInlineStyles(rendered, node.inlineStyles)
  // Annotate the VC root with the ref node id (the page-tree node the agent can
  // target) — outermost element only, exactly one uid per element.
  return ctx.annotateNodeIds ? injectNodeId(withStyles, node.id) : withStyles
}
