/**
 * Site-scope read tools — server-side, resolve from SiteSnapshot.
 *
 * Eight tools that read the current page tree, modules, classes,
 * breakpoints, and pages. Each tool casts `ctx.snapshot` to SiteSnapshot at
 * the top of its handler — the runtime is scope-agnostic and hands tools an
 * `unknown` snapshot.
 */

import { Type, type Static } from '@core/utils/typeboxHelpers'
import type { AiTool } from '../types'
import type { SiteSnapshot } from './snapshot'
import {
  inspectPageClass,
  inspectPageNode,
  searchPageNodes,
  type InspectClassArgs,
  type InspectNodeArgs,
  type SearchNodesArgs,
} from './snapshotHelpers'

function asSnap(snapshot: unknown): SiteSnapshot {
  return snapshot as SiteSnapshot
}

// ---------------------------------------------------------------------------
// list_modules
// ---------------------------------------------------------------------------

const ListModulesInput = Type.Object({
  category: Type.Optional(Type.String()),
})

const listModulesTool: AiTool = {
  name: 'list_modules',
  scope: 'site',
  execution: 'server',
  description:
    'List registered modules with id, name, category, props schema, and style targets. `category` filters case-insensitively.',
  inputSchema: ListModulesInput,
  handler: async (input, ctx) => {
    const { category } = input as Static<typeof ListModulesInput>
    const snap = asSnap(ctx.snapshot)
    const normalized = category?.toLowerCase()
    const modules = normalized
      ? snap.availableModules.filter((m) => m.category.toLowerCase() === normalized)
      : snap.availableModules
    return { modules }
  },
}

// ---------------------------------------------------------------------------
// list_classes
// ---------------------------------------------------------------------------

const ListClassesInput = Type.Object({
  query: Type.Optional(Type.String()),
})

const listClassesTool: AiTool = {
  name: 'list_classes',
  scope: 'site',
  execution: 'server',
  description:
    'List reusable CSS classes with id, name, base + breakpoint styles. Use to discover an existing class to reuse instead of duplicating. `query` filters id/name (case-insensitive substring).',
  inputSchema: ListClassesInput,
  handler: async (input, ctx) => {
    const { query } = input as Static<typeof ListClassesInput>
    const snap = asSnap(ctx.snapshot)
    const normalized = query?.toLowerCase()
    const classes = normalized
      ? snap.classes.filter((c) =>
        c.id.toLowerCase().includes(normalized) ||
        c.name.toLowerCase().includes(normalized))
      : snap.classes
    return { classes }
  },
}

// ---------------------------------------------------------------------------
// list_breakpoints
// ---------------------------------------------------------------------------

const ListBreakpointsInput = Type.Object({})

const listBreakpointsTool: AiTool = {
  name: 'list_breakpoints',
  scope: 'site',
  execution: 'server',
  description:
    'List configured breakpoints (id, label, frame width px, media query, icon) plus the active id. Same info is already in the system suffix; only call if you lost track.',
  inputSchema: ListBreakpointsInput,
  handler: async (_input, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return {
      activeBreakpointId: snap.activeBreakpointId,
      breakpoints: snap.breakpoints,
    }
  },
}

// ---------------------------------------------------------------------------
// inspect_page
// ---------------------------------------------------------------------------

const InspectPageInput = Type.Object({})

const inspectPageTool: AiTool = {
  name: 'inspect_page',
  scope: 'site',
  execution: 'server',
  description:
    'Return the full active page tree: every node id, moduleId, label, parent, children, props, classIds, breakpointOverrides. Large payload — prefer inspect_node or search_nodes for targeted work.',
  inputSchema: InspectPageInput,
  handler: async (_input, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return {
      page: {
        pageId: snap.pageId,
        pageTitle: snap.pageTitle,
        rootNodeId: snap.rootNodeId,
        selectedNodeId: snap.selectedNodeId,
        activeBreakpointId: snap.activeBreakpointId,
        breakpoints: snap.breakpoints,
        nodes: snap.nodes,
      },
    }
  },
}

// ---------------------------------------------------------------------------
// search_nodes
// ---------------------------------------------------------------------------

const SearchNodesInput = Type.Object({
  query: Type.Optional(Type.String()),
  moduleId: Type.Optional(Type.String()),
  classId: Type.Optional(Type.String()),
  className: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
})

const searchNodesTool: AiTool = {
  name: 'search_nodes',
  scope: 'site',
  execution: 'server',
  description:
    'Find nodes by free-text `query` (matches id, moduleId, label, class names, string prop values), or filter by `moduleId`/`classId`/`className`. `limit` default 25. Use instead of inspect_page for small edits.',
  inputSchema: SearchNodesInput,
  handler: async (args, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return searchPageNodes(snap, args as SearchNodesArgs)
  },
}

// ---------------------------------------------------------------------------
// inspect_node
// ---------------------------------------------------------------------------

const InspectNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  maxDepth: Type.Optional(Type.Integer({ minimum: 0, maximum: 50 })),
})

const inspectNodeTool: AiTool = {
  name: 'inspect_node',
  scope: 'site',
  execution: 'server',
  description:
    "Return one node's full detail (resolved props, assigned classes with styles) PLUS a light subtree (id, moduleId, classNames, childCount, textPreview). One call gives the whole section structure — don't loop. `breakpointId` default active. `maxDepth` default 5; 0 for focal only.",
  inputSchema: InspectNodeInput,
  handler: async (args, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return inspectPageNode(snap, args as InspectNodeArgs)
  },
}

// ---------------------------------------------------------------------------
// inspect_class
// ---------------------------------------------------------------------------

const InspectClassInput = Type.Object({
  classId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
})

const inspectClassTool: AiTool = {
  name: 'inspect_class',
  scope: 'site',
  execution: 'server',
  description:
    "Return one class: id, name, base styles, breakpoint styles for the requested breakpoint, and assigned node ids. `classId` accepts id or name.",
  inputSchema: InspectClassInput,
  handler: async (args, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return inspectPageClass(snap, args as InspectClassArgs)
  },
}

// ---------------------------------------------------------------------------
// list_pages
// ---------------------------------------------------------------------------

const ListPagesInput = Type.Object({})

const listPagesTool: AiTool = {
  name: 'list_pages',
  scope: 'site',
  execution: 'server',
  description:
    'List every page (id, title, slug, active, isHomepage). Homepage = slug "index". Use for site-level admin (duplicate, rename, set homepage).',
  inputSchema: ListPagesInput,
  handler: async (_input, ctx) => {
    const snap = asSnap(ctx.snapshot)
    return { pages: snap.pages }
  },
}

// ---------------------------------------------------------------------------
// All read tools — convenient barrel for the registry
// ---------------------------------------------------------------------------

export const siteReadTools: AiTool[] = [
  listModulesTool,
  listClassesTool,
  listBreakpointsTool,
  inspectPageTool,
  searchNodesTool,
  inspectNodeTool,
  inspectClassTool,
  listPagesTool,
]
