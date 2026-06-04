/** useClassPickerDerivedState — derives suggestions, pills, and canvas state for the ClassPicker. */

import { isUserVisibleClass, type PageNode, type StyleRule } from '@core/page-tree'
import { useClassPickerSuggestions } from './useClassPickerSuggestions'
import { deriveSelectorPickerModel } from './selectorPickerModel'

/** Escapes a value for safe interpolation into a `[attr="…"]` CSS selector. */
export function cssAttrSelectorValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function isClassRule(rule: StyleRule): boolean {
  return !rule.kind || rule.kind === 'class'
}

function getSelectedCanvasElement(nodeId: string): HTMLElement | null {
  const selector = `[data-node-id="${cssAttrSelectorValue(nodeId)}"]`
  const localElement = document.querySelector<HTMLElement>(selector)
  if (localElement) return localElement

  for (const frame of document.querySelectorAll('iframe')) {
    try {
      const frameElement = frame.contentDocument?.querySelector<HTMLElement>(selector) ?? null
      if (frameElement) return frameElement
    } catch (_err) {
      // Canvas iframes are same-origin srcdoc documents; ignore any unexpected
      // cross-origin iframe a plugin or dev tool may add to the admin shell.
    }
  }
  return null
}

export function useClassPickerDerivedState({
  site,
  node,
  nodeId,
  activeClassId,
  inlineStyleEditing,
  query,
  highlightedIndex,
}: {
  site: { styleRules: Record<string, StyleRule> } | null
  node: PageNode | null
  nodeId: string
  activeClassId: string | null
  inlineStyleEditing: boolean
  query: string
  highlightedIndex: number
}) {
  const assignedIds = node?.classIds ?? []
  const visibleAssignedIds = assignedIds.filter((id) => isUserVisibleClass(site?.styleRules[id]))
  const nodeHasInlineStyles = !!node?.inlineStyles && Object.keys(node.inlineStyles).length > 0
  const allRules = Object.values(site?.styleRules ?? {}).filter(isUserVisibleClass)
  const allClasses = allRules.filter(isClassRule)
  const visibleRuleRegistry = Object.fromEntries(allRules.map((rule) => [rule.id, rule]))
  const selectedElement = getSelectedCanvasElement(nodeId)
  const selectorModel = deriveSelectorPickerModel({
    rules: visibleRuleRegistry,
    node,
    selectedElement,
    activeRuleId: inlineStyleEditing ? null : activeClassId,
  })
  const ambientSelectorItems = selectorModel.suggestions.filter((item) => item.rule.kind === 'ambient')
  const suggestions = useClassPickerSuggestions({
    allClasses,
    assignedIds,
    selectorItems: ambientSelectorItems,
    query,
    highlightedIndex,
  })
  const hasSuggestionRows = (
    suggestions.isEmptyQuery
      ? suggestions.candidates.length > 0
      : suggestions.filteredSuggestions.length > 0
  ) || suggestions.selectorSuggestions.length > 0

  return {
    visibleAssignedIds,
    showInlinePill: nodeHasInlineStyles || inlineStyleEditing,
    selectedElement,
    selectorModel,
    hasSuggestionRows,
    highlightedSelectorId: suggestions.highlightedSelectorItem?.rule.id ?? null,
    ...suggestions,
  }
}
