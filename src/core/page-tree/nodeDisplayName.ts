/**
 * nodeDisplayName — pure helper that resolves the user-facing label of a
 * PageNode for the DOM tree, breadcrumbs, drag previews, and rename prompts.
 *
 * Resolution order (first non-empty wins):
 *   1. node.label                — explicit user-set label
 *   2. VC name (when node.moduleId === 'base.visual-component-ref' AND
 *      props.componentId resolves to a Visual Component in the site)
 *   3. definition.name           — module's display name from registry
 *   4. node.moduleId             — final fallback (registry miss)
 *
 * Step (2) is what makes a "componentized" node show up as "Header" in the
 * DOM tree instead of the generic "Component" label that the
 * base.visual-component-ref module declaration carries. Renaming the VC
 * automatically updates every ref in the tree (no per-ref node label sync).
 */

import type { PageNode } from './schemas'
import type { VisualComponent } from '@core/visualComponents/schemas'
import type { ModuleDefinition } from '@core/module-engine/types'

export function getNodeDisplayName(
  node: Pick<PageNode, 'label' | 'moduleId' | 'props'>,
  definition: ModuleDefinition | undefined,
  visualComponents: ReadonlyArray<VisualComponent> | undefined,
): string {
  if (node.label && node.label.length > 0) return node.label

  if (node.moduleId === 'base.visual-component-ref') {
    const componentId = (node.props as Record<string, unknown> | undefined)?.componentId
    if (typeof componentId === 'string' && componentId.length > 0 && visualComponents) {
      const vc = visualComponents.find((v) => v.id === componentId)
      if (vc && vc.name.length > 0) return vc.name
    }
  }

  return definition?.name ?? node.moduleId
}
