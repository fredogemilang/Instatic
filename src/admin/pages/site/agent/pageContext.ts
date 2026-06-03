/**
 * Site-editor page-context builder.
 *
 * Transforms the live editor store into the `PageContext` snapshot handed to
 * the agent's read tools on every request. This is the only *site-specific*
 * piece of the agent layer — the slice factory itself is scope-agnostic, so
 * this lives in its own module and is wired in via `agentSliceConfig.site.ts`
 * (the content workspace builds its own snapshot a different way).
 */

import { registry } from '@core/module-engine'
import type {
  AnyModuleDefinition,
  PropertyControl,
  PropertySchema,
} from '@core/module-engine'
import type { Page } from '@core/page-tree'
import type { EditorStore } from '@site/store/types'
import type {
  AgentModuleContext,
  AgentModulePropContext,
  AgentModuleStyleContext,
  PageContext,
} from './types'

export function buildPageContext(
  state: EditorStore,
  activePage: Page | undefined,
): PageContext {
  if (!activePage || !state.site) {
    return {
      pageId: '',
      pageTitle: 'Untitled',
      rootNodeId: '',
      pages: [],
      activeBreakpointId: state.activeBreakpointId,
      breakpoints: [],
      nodes: [],
      availableModules: [],
      selectedNodeId: null,
      classes: [],
    }
  }

  const parentMap: Record<string, string | null> = {}
  for (const node of Object.values(activePage.nodes)) {
    for (const childId of node.children) {
      parentMap[childId] = node.id
    }
    if (!parentMap[node.id]) parentMap[node.id] = null
  }

  const nodes = Object.values(activePage.nodes).map((node) => ({
    id: node.id,
    moduleId: node.moduleId,
    label: node.label,
    parentId: parentMap[node.id] ?? null,
    children: node.children,
    props: node.props,
    breakpointOverrides: toSerializableBreakpointRecords(node.breakpointOverrides ?? {}),
    classIds: node.classIds ?? [],
  }))

  const availableModules = registry
    .list()
    .filter((mod) => mod.id !== 'base.body')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(moduleDefinitionToAgentContext)

  // The agent works in terms of viewport contexts; surface only the
  // breakpoint-keyed subset of the unified contextStyles map. Custom @media /
  // @container / @supports conditions are not part of the agent's model yet.
  const breakpointIds = new Set(state.site.breakpoints.map((bp) => bp.id))
  const classes = Object.values(state.site.styleRules ?? {}).map((c) => {
    const breakpointStyles: Record<string, Record<string, unknown>> = {}
    for (const [contextId, bag] of Object.entries(c.contextStyles ?? {})) {
      if (breakpointIds.has(contextId)) breakpointStyles[contextId] = bag
    }
    return {
      id: c.id,
      name: c.name,
      styles: toSerializableRecord(c.styles ?? {}),
      breakpointStyles: toSerializableBreakpointStyles(breakpointStyles),
    }
  })

  const pages = state.site.pages.map((page) => ({
    id: page.id,
    title: page.title,
    slug: page.slug,
    active: page.id === activePage.id,
    isHomepage: page.slug === 'index',
  }))

  return {
    pageId: activePage.id,
    pageTitle: activePage.title,
    rootNodeId: activePage.rootNodeId,
    pages,
    activeBreakpointId: state.activeBreakpointId,
    breakpoints: state.site.breakpoints.map((breakpoint) => ({
      id: breakpoint.id,
      label: breakpoint.label,
      width: breakpoint.width,
      mediaQuery: breakpoint.mediaQuery,
      icon: breakpoint.icon,
    })),
    nodes,
    availableModules,
    selectedNodeId: state.selectedNodeId,
    classes,
  }
}

/**
 * Convenience wrapper around `buildPageContext` — looks up the active
 * page on the store and forwards it. Exported so the site editor's
 * agent-slice config can drop it straight into `buildSnapshot`.
 */
export function buildCurrentPageContext(get: () => EditorStore): PageContext {
  const storeState = get()
  const activePage = storeState.site?.pages.find(
    (p) => p.id === storeState.activePageId,
  ) ?? storeState.site?.pages[0]
  return buildPageContext(storeState, activePage)
}

function moduleDefinitionToAgentContext(mod: AnyModuleDefinition): AgentModuleContext {
  return {
    id: mod.id,
    name: mod.name,
    description: mod.description,
    category: mod.category,
    canHaveChildren: mod.canHaveChildren,
    defaults: toSerializableRecord(mod.defaults ?? {}),
    props: schemaToAgentProps(mod.schema, mod.defaults ?? {}),
    styles: genericAgentStyleHintsForModule(mod),
  }
}

function genericAgentStyleHintsForModule(mod: AnyModuleDefinition): AgentModuleStyleContext[] {
  if (mod.id === 'base.text' || mod.category.toLowerCase() === 'typography') {
    return [
      { key: 'fontFamily', type: 'text', label: 'Font family', defaultValue: 'inherit', cssProperties: ['fontFamily'] },
      { key: 'fontSize', type: 'text', label: 'Font size', defaultValue: '16px', cssProperties: ['fontSize'] },
      { key: 'fontWeight', type: 'select', label: 'Font weight', defaultValue: '400', cssProperties: ['fontWeight'], options: [
        { label: 'Regular', value: '400' },
        { label: 'Medium', value: '500' },
        { label: 'Semi bold', value: '600' },
        { label: 'Bold', value: '700' },
        { label: 'Black', value: '900' },
      ] },
      { key: 'lineHeight', type: 'text', label: 'Line height', defaultValue: '1.4', cssProperties: ['lineHeight'] },
      { key: 'letterSpacing', type: 'text', label: 'Letter spacing', defaultValue: '0px', cssProperties: ['letterSpacing'] },
      { key: 'color', type: 'color', label: 'Text color', defaultValue: 'inherit', cssProperties: ['color'] },
      { key: 'textAlign', type: 'select', label: 'Text align', defaultValue: 'left', cssProperties: ['textAlign'], options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
        { label: 'Right', value: 'right' },
        { label: 'Justify', value: 'justify' },
      ] },
      { key: 'marginBottom', type: 'text', label: 'Bottom margin', defaultValue: '0px', cssProperties: ['marginBottom'] },
    ]
  }

  return []
}

function schemaToAgentProps(
  schema: PropertySchema,
  defaults: Record<string, unknown>,
): AgentModulePropContext[] {
  const props: AgentModulePropContext[] = []

  for (const [key, control] of Object.entries(schema)) {
    if (control.type === 'group') {
      props.push(...schemaToAgentProps(control.children, defaults))
      continue
    }
    props.push(controlToAgentProp(key, control, defaults[key]))
  }

  return props
}

function controlToAgentProp(
  key: string,
  control: Exclude<PropertyControl, { type: 'group' }>,
  defaultValue: unknown,
): AgentModulePropContext {
  const prop: AgentModulePropContext = {
    key,
    type: control.type,
    label: control.label,
    description: control.description,
    defaultValue: toSerializableValue(defaultValue),
  }

  if (control.breakpointOverridable === true) {
    prop.breakpointOverridable = true
  }

  if (control.type === 'select') {
    prop.options = control.options.map((option) => ({
      label: option.label,
      value: toSerializableValue(option.value),
    }))
  }

  return prop
}

function toSerializableRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = toSerializableValue(value)
  }
  return result
}

function toSerializableBreakpointStyles(
  breakpointStyles: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return toSerializableBreakpointRecords(breakpointStyles)
}

function toSerializableBreakpointRecords(
  breakpointStyles: Record<string, Partial<Record<string, unknown>>>,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const [breakpointId, styles] of Object.entries(breakpointStyles)) {
    result[breakpointId] = toSerializableRecord(styles)
  }
  return result
}

function toSerializableValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) return value.map(toSerializableValue)

  if (typeof value === 'object' && value) {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toSerializableValue(nestedValue)
    }
    return result
  }

  return String(value)
}
