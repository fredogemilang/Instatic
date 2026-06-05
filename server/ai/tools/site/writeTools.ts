/**
 * Site-scope write tools — browser-bridged. The runner emits a
 * `toolRequest` for each call and waits for the browser to POST a result
 * to /admin/api/ai/tool-result.
 *
 * Each tool defines only `name`, `description`, `inputSchema`, and the
 * sentinel `execution: 'browser'`. There is NO server-side handler — the
 * runner routes browser-execution tools through the bridge instead.
 *
 * Node/class/page/template mutation tools + design-system token tools +
 * render_snapshot + getNodeHtml (23 total).
 *
 * Input shapes mirror the browser executor at
 * `src/admin/pages/site/agent/executor.ts` (which validates each call
 * against TypeBox schemas — the schemas defined here are the single source
 * of truth that the executor reads in Phase 3).
 */

import { Type } from '@core/utils/typeboxHelpers'
import type { AiTool } from '../types'

// ---------------------------------------------------------------------------
// Shared input pieces
// ---------------------------------------------------------------------------

const StylePatch = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Number()]),
)

const BreakpointStyles = Type.Record(
  Type.String({ minLength: 1 }),
  StylePatch,
)

// ---------------------------------------------------------------------------
// HTML-native write tools
// ---------------------------------------------------------------------------

const InsertHtmlInput = Type.Object({
  parentId: Type.String({ minLength: 1 }),
  index: Type.Optional(Type.Integer({ minimum: 0 })),
  html: Type.String({ minLength: 1 }),
})

const insertHtmlTool: AiTool = {
  name: 'insertHtml',
  scope: 'site',
  execution: 'browser',
  description:
    'Insert semantic HTML as a subtree of editable nodes under an existing parent. Write structure as HTML (<section>, <h1>, <a>, <button>, <img>, <ul>, ...) and style it with CSS: put a <style> block in the HTML and/or class= attributes. The importer parses every rule — a bare `.foo {}` selector becomes a reusable Selectors-panel class bound to class="foo"; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule. Inline style= attributes land on the node\'s inline styles. To add ONLY CSS (pseudo-classes, hover, ::before, descendant selectors) with no new elements, pass a <style>-only payload (e.g. "<style>.hero a:hover{color:var(--primary)}</style>") — the rules are registered and `parentId` is ignored. This is the way to author pseudo/hover/descendant CSS that createClass/updateClassStyles cannot express.',
  inputSchema: InsertHtmlInput,
}

const GetNodeHtmlInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})

const getNodeHtmlTool: AiTool = {
  name: 'getNodeHtml',
  scope: 'site',
  execution: 'browser',
  description:
    'Return the current HTML the published page would emit for a node subtree. Use before replaceNodeHtml to read existing structure.',
  inputSchema: GetNodeHtmlInput,
}

const ReplaceNodeHtmlInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  html: Type.String({ minLength: 1 }),
})

const replaceNodeHtmlTool: AiTool = {
  name: 'replaceNodeHtml',
  scope: 'site',
  execution: 'browser',
  description:
    "Replace a node subtree's children with new HTML. The target node is preserved as the parent; its existing children are rebuilt from the HTML. Style with CSS exactly as in insertHtml: a <style> block and/or class= attributes; bare `.foo` selectors become reusable classes, other selectors become ambient rules. A <style>-only payload (no elements) registers its CSS rules WITHOUT touching the node's children — to add ambient/hover/pseudo CSS prefer insertHtml with a <style>-only payload.",
  inputSchema: ReplaceNodeHtmlInput,
}

// ---------------------------------------------------------------------------
// Node-level write tools
// ---------------------------------------------------------------------------

const DeleteNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
})

const deleteNodeTool: AiTool = {
  name: 'deleteNode',
  scope: 'site',
  execution: 'browser',
  description:
    'Remove a node and its descendants. Not undoable from inside the loop (user can Cmd+Z after).',
  inputSchema: DeleteNodeInput,
}

const UpdateNodePropsInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  patch: Type.Record(Type.String(), Type.Unknown()),
})

const updateNodePropsTool: AiTool = {
  name: 'updateNodeProps',
  scope: 'site',
  execution: 'browser',
  description:
    'Shallow-merge a patch onto an existing node\'s props. `breakpointId` is only valid for props marked `breakpointOverridable` in the schema (rejected for content props like text/tag/src). For per-breakpoint visual variation use class breakpointStyles, not this. Richtext props are auto-sanitised.',
  inputSchema: UpdateNodePropsInput,
}

const MoveNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  newParentId: Type.String({ minLength: 1 }),
  newIndex: Type.Integer({ minimum: 0 }),
})

const moveNodeTool: AiTool = {
  name: 'moveNode',
  scope: 'site',
  execution: 'browser',
  description:
    "Move a node to a different parent and/or position. `newIndex` is 0-based among the destination's children.",
  inputSchema: MoveNodeInput,
}

const RenameNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
})

const renameNodeTool: AiTool = {
  name: 'renameNode',
  scope: 'site',
  execution: 'browser',
  description:
    "Set the node's display label in the DOM tree panel. Editor-only; doesn't affect rendered HTML.",
  inputSchema: RenameNodeInput,
}

const DuplicateNodeInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
})

const duplicateNodeTool: AiTool = {
  name: 'duplicateNode',
  scope: 'site',
  execution: 'browser',
  description:
    "Deep-clone a node + subtree (props, classIds, breakpoint overrides) right after the original. `count` (1-50, default 1) produces N clones in one call. Success data includes the first new node id as `nodeId` and all new ids as `nodeIds`.",
  inputSchema: DuplicateNodeInput,
}

// ---------------------------------------------------------------------------
// Class-level write tools
// ---------------------------------------------------------------------------

const CreateClassInput = Type.Object({
  name: Type.String({ minLength: 1 }),
  styles: Type.Optional(StylePatch),
  breakpointStyles: Type.Optional(BreakpointStyles),
})

const createClassTool: AiTool = {
  name: 'createClass',
  scope: 'site',
  execution: 'browser',
  description:
    'Create a reusable CSS class with camelCase style keys (fontSize, paddingTop, gridTemplateColumns). Name must be a CSS identifier (no spaces) and unique. Success data includes the new id as `classId`; other class tools accept id OR name.',
  inputSchema: CreateClassInput,
}

const UpdateClassStylesInput = Type.Object({
  classId: Type.String({ minLength: 1 }),
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  patch: StylePatch,
})

const updateClassStylesTool: AiTool = {
  name: 'updateClassStyles',
  scope: 'site',
  execution: 'browser',
  description:
    'Shallow-merge a style patch onto an existing class. `breakpointId` writes a per-breakpoint override instead of base. `classId` accepts id or name.',
  inputSchema: UpdateClassStylesInput,
}

const AssignClassInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})

const assignClassTool: AiTool = {
  name: 'assignClass',
  scope: 'site',
  execution: 'browser',
  description:
    "Attach an existing CSS class to a node. `classId` accepts id or name.",
  inputSchema: AssignClassInput,
}

const RemoveClassInput = Type.Object({
  nodeId: Type.String({ minLength: 1 }),
  classId: Type.String({ minLength: 1 }),
})

const removeClassTool: AiTool = {
  name: 'removeClass',
  scope: 'site',
  execution: 'browser',
  description:
    'Detach a class from a node (the class itself is not deleted). `classId` accepts id or name.',
  inputSchema: RemoveClassInput,
}

// ---------------------------------------------------------------------------
// Page-level write tools
// ---------------------------------------------------------------------------

const AddPageInput = Type.Object({
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})

const addPageTool: AiTool = {
  name: 'addPage',
  scope: 'site',
  execution: 'browser',
  description:
    'Add an EMPTY page and make it the active page. `slug` defaults to a slugified title and is auto-uniqued (a repeat add becomes `-2`, `-3`) — so never call addPage twice for the same page. Success data: `pageId` and `rootNodeId`. To build into the new page, pass `rootNodeId` as insertHtml\'s `parentId` — a pageId is NOT a node id. The page is already active, so just start inserting; no need to read_page/list_pages first. For copying an existing page use duplicatePage.',
  inputSchema: AddPageInput,
}

const DeletePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
})

const deletePageTool: AiTool = {
  name: 'deletePage',
  scope: 'site',
  execution: 'browser',
  description:
    'Permanently delete a page. Fails if it would leave the site with zero pages.',
  inputSchema: DeletePageInput,
}

const RenamePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})

const renamePageTool: AiTool = {
  name: 'renamePage',
  scope: 'site',
  execution: 'browser',
  description:
    "Change a page's title and/or slug. `slug=\"index\"` makes this page the homepage. Omit slug to keep it.",
  inputSchema: RenamePageInput,
}

const DuplicatePageInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  slug: Type.Optional(Type.String()),
})

const duplicatePageTool: AiTool = {
  name: 'duplicatePage',
  scope: 'site',
  execution: 'browser',
  description:
    'Deep-clone an existing page (every node, prop, class assignment, breakpoint override) under a new title/slug. Node ids are regenerated; class assignments preserved. Success data includes the new id as `pageId`.',
  inputSchema: DuplicatePageInput,
}

// ---------------------------------------------------------------------------
// Template write tools — convert a page to/from a CMS template.
//
// A template is a page carrying a `target` (an `everywhere` layout, or one/more
// post types) plus a single `<instatic-outlet>` where matched content flows in.
// These mirror the editor's convertPageToTemplate / convertTemplateToPage store
// actions; the browser bridge applies them. Targets mirror TemplateTargetSchema
// in `@core/page-tree`.
// ---------------------------------------------------------------------------

const TemplateTargetInput = Type.Union([
  Type.Object({ kind: Type.Literal('everywhere') }),
  Type.Object({
    kind: Type.Literal('postTypes'),
    tableSlugs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }),
])

const SetPageTemplateInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
  target: TemplateTargetInput,
  priority: Type.Optional(Type.Number()),
})

const setPageTemplateTool: AiTool = {
  name: 'setPageTemplate',
  scope: 'site',
  execution: 'browser',
  description:
    'Turn a page INTO a template (or update an existing template\'s target/priority). `target` is `{kind:"everywhere"}` for a site-wide layout that wraps every page+entry, or `{kind:"postTypes", tableSlugs:[…]}` to wrap entries of those post types (slugs from list_post_types). `priority` (default 100) breaks ties when several templates match at the same breadth level — higher wins. A template needs exactly one `<instatic-outlet>` (insert it via insertHtml) marking where matched content flows; a template with no outlet simply doesn\'t apply. Pass a real page id from the suffix / list_pages.',
  inputSchema: SetPageTemplateInput,
}

const ClearPageTemplateInput = Type.Object({
  pageId: Type.String({ minLength: 1 }),
})

const clearPageTemplateTool: AiTool = {
  name: 'clearPageTemplate',
  scope: 'site',
  execution: 'browser',
  description:
    'Revert a template back to an ordinary page: drops its template target and any dynamic bindings. The `<instatic-outlet>` node (if any) stays — delete it separately if unwanted. No-op error if the page is not a template.',
  inputSchema: ClearPageTemplateInput,
}

// ---------------------------------------------------------------------------
// Design-system token write tools — create/update framework + font tokens.
//
// Colors and fonts are LIST-shaped (one entry per token); typography and
// spacing are SCALE-shaped (a group config from which the framework generates
// per-step values). Mirror the executor schemas in
// `src/admin/pages/site/agent/executor.ts`.
// ---------------------------------------------------------------------------

const SetColorTokensInput = Type.Object({
  tokens: Type.Array(
    Type.Object({
      slug: Type.String({ minLength: 1 }),
      lightValue: Type.String({ minLength: 1 }),
      category: Type.Optional(Type.String()),
      darkValue: Type.Optional(Type.String()),
      darkModeEnabled: Type.Optional(Type.Boolean()),
    }),
    { minItems: 1 },
  ),
})

const setColorTokensTool: AiTool = {
  name: 'set_color_tokens',
  scope: 'site',
  execution: 'browser',
  description:
    'Create or update framework COLOR tokens — the source of truth for color. Each `{ slug, lightValue }` becomes `var(--<slug>)` plus generated utility classes (text-/bg-/border-) and shade/tint variants. Create-or-update is keyed by `slug`: an existing slug is patched, a new one is created. `lightValue` is any CSS color (hex/rgb/hsl); omit `darkValue` to auto-generate it. Establish color tokens before styling and reference them as `var(--<slug>)` instead of raw hex.',
  inputSchema: SetColorTokensInput,
}

const SetFontTokensInput = Type.Object({
  tokens: Type.Array(
    Type.Object({
      name: Type.String({ minLength: 1 }),
      variable: Type.Optional(Type.String()),
      fallback: Type.Optional(Type.String()),
      googleFamily: Type.Optional(Type.String()),
      variants: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      subsets: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      familyId: Type.Optional(Type.String({ minLength: 1 })),
    }),
    { minItems: 1 },
  ),
})

const setFontTokensTool: AiTool = {
  name: 'set_font_tokens',
  scope: 'site',
  execution: 'browser',
  description:
    'Create or update FONT tokens — named typefaces referenced as `var(--<variable>)`. Pass `googleFamily` (e.g. "Inter") to install a new Google web font (downloads the files, then binds the token to it); `variants` defaults to ["400","700"] and `subsets` to ["latin"]. Pass `familyId` to reference an already-installed family. Pass neither for a fallback-only/system token. Create-or-update is keyed by `variable` (defaults from `name`). `googleFamily` and `familyId` are mutually exclusive.',
  inputSchema: SetFontTokensInput,
}

const ScaleBreakpointInput = (sizeKey: 'fontSize' | 'size') =>
  Type.Object({
    [sizeKey]: Type.Optional(Type.Number()),
    scaleRatio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
  })

const SetTypeScaleInput = Type.Object({
  groupId: Type.Optional(Type.String({ minLength: 1 })),
  namingConvention: Type.Optional(Type.String({ minLength: 1 })),
  steps: Type.Optional(Type.String({ minLength: 1 })),
  baseScaleIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  min: Type.Optional(ScaleBreakpointInput('fontSize')),
  max: Type.Optional(ScaleBreakpointInput('fontSize')),
})

const setTypeScaleTool: AiTool = {
  name: 'set_type_scale',
  scope: 'site',
  execution: 'browser',
  description:
    'Configure the TYPOGRAPHY scale — the fluid type ramp generating `--text-*` variables (default prefix "text"). A scale is a config: `min`/`max` give the base `fontSize` (px) and `scaleRatio` at the small/large screen anchors; `steps` is the comma-separated step list (e.g. "xs,s,m,l,xl,2xl,3xl,4xl") and `baseScaleIndex` picks which step equals the base size. Creates the group if none exists, else updates it (target a specific one with `groupId`). Reference sizes as `var(--text-l)` rather than raw px.',
  inputSchema: SetTypeScaleInput,
}

const SetSpacingScaleInput = Type.Object({
  groupId: Type.Optional(Type.String({ minLength: 1 })),
  namingConvention: Type.Optional(Type.String({ minLength: 1 })),
  steps: Type.Optional(Type.String({ minLength: 1 })),
  baseScaleIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  min: Type.Optional(ScaleBreakpointInput('size')),
  max: Type.Optional(ScaleBreakpointInput('size')),
})

const setSpacingScaleTool: AiTool = {
  name: 'set_spacing_scale',
  scope: 'site',
  execution: 'browser',
  description:
    'Configure the SPACING scale — the fluid spacing ramp generating `--space-*` variables (default prefix "space"). Same shape as set_type_scale but `min`/`max` carry `size` (px) instead of `fontSize`; `steps` defaults to an 11-step scale and `baseScaleIndex` to 5 ("m"). Creates the group if none exists, else updates it. Reference gaps/padding as `var(--space-l)` rather than raw px.',
  inputSchema: SetSpacingScaleInput,
}

// ---------------------------------------------------------------------------
// render_snapshot — browser-bridged, returns a special payload
// ---------------------------------------------------------------------------

const RenderSnapshotInput = Type.Object({
  breakpointId: Type.Optional(Type.String({ minLength: 1 })),
  nodeId: Type.Optional(Type.String({ minLength: 1 })),
})

const renderSnapshotTool: AiTool = {
  name: 'render_snapshot',
  scope: 'site',
  execution: 'browser',
  description:
    "Inspect the rendered canvas. Returns a layout report: viewport size, per-node bounding boxes, image-load status, and warnings (overflow / broken-image / invisible-node) — enough to catch most layout bugs in text. On a vision-capable model a screenshot is also attached as an image. Pass `breakpointId` to choose which breakpoint frame (defaults to active). Pass `nodeId` to capture just that node's subtree — a sharper, cheaper image than the whole page, and a report scoped to that section with coordinates relative to the node; omit `nodeId` to capture the full page.",
  inputSchema: RenderSnapshotInput,
}

// ---------------------------------------------------------------------------
// All write tools — convenient barrel for the registry
// ---------------------------------------------------------------------------

export const siteWriteTools: AiTool[] = [
  insertHtmlTool,
  getNodeHtmlTool,
  replaceNodeHtmlTool,
  deleteNodeTool,
  updateNodePropsTool,
  moveNodeTool,
  renameNodeTool,
  duplicateNodeTool,
  createClassTool,
  updateClassStylesTool,
  assignClassTool,
  removeClassTool,
  addPageTool,
  deletePageTool,
  renamePageTool,
  duplicatePageTool,
  setPageTemplateTool,
  clearPageTemplateTool,
  setColorTokensTool,
  setFontTokensTool,
  setTypeScaleTool,
  setSpacingScaleTool,
  renderSnapshotTool,
]
