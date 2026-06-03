/**
 * SiteSnapshot — the page-context payload the chat handler hands to
 * site-scope tool handlers via `ToolContext.snapshot`.
 *
 * This is the same wire shape the editor's `renderEvidence` builds and POSTs
 * with each chat turn. Kept loose in shape on purpose so the snapshot can
 * evolve without coupling the server to the editor's internal types — the
 * boundary validation lives in the chat handler.
 */

export interface SiteSnapshot {
  pageId: string
  pageTitle: string
  rootNodeId: string
  pages: PageSummary[]
  activeBreakpointId: string
  breakpoints: BreakpointInfo[]
  nodes: NodeInfo[]
  availableModules: ModuleInfo[]
  selectedNodeId: string | null
  classes: ClassInfo[]
}

export interface PageSummary {
  id: string
  title: string
  slug: string
  active: boolean
  isHomepage: boolean
}

export interface BreakpointInfo {
  id: string
  label: string
  width: number
  mediaQuery?: string
  icon: string
}

export interface NodeInfo {
  id: string
  moduleId: string
  label?: string
  parentId: string | null
  children: string[]
  props: Record<string, unknown>
  breakpointOverrides: Record<string, Partial<Record<string, unknown>>>
  classIds: string[]
}

export interface ModuleInfo {
  id: string
  name: string
  description?: string
  category: string
  canHaveChildren: boolean
  defaults: Record<string, unknown>
  props: ModulePropInfo[]
  styles: ModuleStyleInfo[]
}

export interface ModulePropInfo {
  key: string
  type: string
  label: string
  description?: string
  defaultValue?: unknown
  options?: Array<{ label: string; value: unknown }>
  breakpointOverridable?: boolean
}

export interface ModuleStyleInfo {
  key: string
  type: string
  label: string
  description?: string
  defaultValue?: unknown
  cssProperties: string[]
  options?: Array<{ label: string; value: unknown }>
}

export interface ClassInfo {
  id: string
  name: string
  styles?: Record<string, unknown>
  breakpointStyles?: Record<string, Record<string, unknown>>
}
