# Layer Hide / Unhide Design

This spec defines Hide / Unhide for the canvas editor Layers panel.

Hide / Unhide lets authors suppress a layer from the editor canvas and published output while keeping the authored node in the Layers tree so it can be inspected and restored later.

---

## TL;DR

- Use the existing `node.hidden?: boolean` field on page-tree nodes.
- Hidden state is local to each node; effective visibility is inherited because render walkers prune hidden parents.
- The Layers tree keeps hidden nodes visible and marks them with a quiet `hidden` badge.
- The context menu exposes `Hide` or `Unhide` based on the selected layer state.
- Hidden nodes render nothing in the canvas and publish nothing in HTML, CSS, dynamic holes, loops, or Visual Component output.
- Child `hidden` flags are never rewritten when a parent is hidden or unhidden.
- The structural root/body node does not expose Hide.

## Current State

The page-tree data model already supports authored hidden state:

- `src/core/page-tree/baseNode.ts` defines `hidden?: boolean`.
- `src/core/page-tree/mutations.ts` exports `toggleNodeHidden(tree, nodeId)`.
- `src/admin/pages/site/store/slices/site/nodeActions.ts` exposes the store action `toggleNodeHidden`.
- `src/admin/pages/site/panels/DomPanel/TreeNode.tsx` passes `node.hidden` to `TreeRow` and includes hidden state in the accessible row label.
- `src/admin/pages/site/panels/DomPanel/LayerTreeNodeContent.tsx` already renders a hidden indicator.

Canvas rendering already prunes hidden nodes:

- `src/admin/pages/site/canvas/NodeRenderer.tsx` returns `null` for `node.hidden`.
- `src/admin/pages/site/canvas/canvasDomGeometry.ts` skips hidden nodes when computing canvas geometry.
- `src/modules/base/visualComponentRef/VCInlineTree.tsx` skips hidden nodes in the Visual Component inline editor preview.

The missing pieces are:

- Context-menu actions to hide and unhide layers.
- A row badge treatment that matches the chosen Layers UI direction.
- Publisher pruning in `src/core/publisher/renderNode.ts` so hidden nodes cannot leak into published HTML, CSS, dynamic holes, or unknown-module comments.
- Focused tests for published-output behavior and multi-select menu semantics.

## UX Contract

Hide / Unhide is a layer operation in the Layers panel.

A hidden layer:

- stays visible in the Layers tree;
- can be selected, renamed, copied, cut, duplicated, deleted, wrapped, and unhidden from the Layers tree;
- shows a quiet `hidden` row badge;
- is omitted from the canvas preview;
- is omitted from published pages;
- suppresses its whole subtree while preserving every child node's own `hidden` flag.

The primary affordance is a context-menu action:

| Selection state | Menu label | Effect |
|-----------------|------------|--------|
| Single visible node | `Hide` | Sets that node hidden |
| Single hidden node | `Unhide` | Sets that node visible |
| Multi-selection with any visible node | `Hide selected` | Sets all selected nodes hidden |
| Multi-selection where all nodes are hidden | `Unhide selected` | Sets all selected nodes visible |

Multi-select uses one target state for the whole selection. It must not blindly toggle each selected node, because mixed selections would otherwise invert state instead of normalizing it.

The structural root/body node does not expose Hide. Hiding the document root creates a blank canvas state that is too easy to trigger and too hard to recover from visually.

## Data Model

No new persisted shape is needed.

Use the existing node metadata:

```ts
hidden?: boolean
```

Hidden state is authored state. It travels with copy, cut, paste, duplicate, Visual Component conversion, and persisted page or component trees the same way `label` and `locked` travel.

Effective visibility is not stored. It is derived by recursive render behavior: when a hidden parent is pruned, the walker never reaches its descendants. This preserves child flags exactly as authored.

## Implementation Boundaries

### Tree Mutation

Keep `toggleNodeHidden(tree, nodeId)` as the primitive tree mutation.

For context-menu multi-select, compute the target hidden state from the current selected nodes:

```ts
const shouldHide = selectedNodes.some((node) => !node.hidden)
```

Then apply `toggleNodeHidden` only to nodes whose current state differs from `shouldHide`. This preserves the existing mutation API while giving multi-select a deterministic set-state behavior.

If the implementation adds a store helper for this, keep it thin and route through `mutateActiveTree(fn)` like the other tree mutations in `src/admin/pages/site/store/slices/site/nodeActions.ts`.

### Layers Panel

Update `src/admin/pages/site/panels/DomPanel/LayerNodeContextMenu.tsx`:

- Add `Hide` / `Unhide` near the other node metadata operations.
- Hide the action for the structural root/body node.
- Support multi-select labels and target-state behavior.
- Keep the action available for ordinary locked nodes. Continue using the existing slot-instance lockdown rules for managed `base.slot-instance` rows.

Update `src/admin/pages/site/panels/DomPanel/LayerTreeNodeContent.tsx` and adjacent CSS so hidden rows show a text badge rather than relying only on the existing icon indicator. The badge should use editor surface/text tokens and stay visually quiet.

### Canvas

Keep `src/admin/pages/site/canvas/NodeRenderer.tsx` as the primary canvas pruning boundary:

```ts
if (node.hidden) return null
```

Hidden selected nodes can remain selected in store state. They simply have no canvas element, so selection and hover rings do not render until the node is unhidden.

`src/admin/pages/site/canvas/canvasDomGeometry.ts` already skips hidden nodes and should continue doing so.

### Publisher

Add a hard guard in `src/core/publisher/renderNode.ts` immediately after node lookup:

```ts
const node = ctx.page.nodes[nodeId]
if (!node) return ''
if (node.hidden) return ''
```

This guard must run before:

- unknown-module comments;
- Layer C dynamic-hole placeholders;
- `base.visual-component-ref` inlining;
- `base.loop` rendering;
- standard node rendering;
- module CSS collection;
- class and inline-style injection.

Hidden nodes in Visual Component definitions are pruned when the synthetic VC page calls back into `renderNode`. Hidden slot-fill nodes are pruned the same way because slot fills remain ordinary page-tree nodes.

### Search And Inspection

Layers search continues to search authored structure. Hidden rows stay searchable even though they are not present on the canvas or public page.

Properties inspection remains available for hidden nodes selected from the Layers tree. This lets authors edit a hidden node before unhiding it.

## Edge Cases

- Hiding a parent does not rewrite child flags.
- Unhiding a parent restores all descendants that are not individually hidden.
- A child that was hidden before its parent was hidden remains hidden after the parent is unhidden.
- Hidden dynamic nodes emit no `<instatic-hole>` placeholders and do not register hole ids.
- Hidden unknown modules emit nothing, not an unknown-module comment.
- Hidden loop children do not render as loop variants.
- Hidden Visual Component definition nodes do not render through refs.
- Hidden slot-fill nodes do not render into slot outlets.
- Copy and duplicate preserve `hidden`.
- Delete and cut work from the Layers tree even though the node is absent from the canvas.

## Testing

Add focused tests around the boundaries where hidden content can leak.

Publisher tests in `src/__tests__/publisher/render.test.ts` or a small adjacent file:

- `renderNode` returns `''` for a hidden standard node.
- Hidden standard node does not collect module CSS.
- Hidden dynamic node does not emit a hole placeholder or register a hole id.
- Hidden unknown module emits nothing.
- Hidden child under visible parent is omitted from published HTML.
- Hidden parent suppresses visible children without mutating child flags.
- Hidden loop children are not rendered as variants.

Visual Component publisher tests in `src/__tests__/publisher/visualComponentRef.test.ts`:

- Hidden VC definition node is omitted from ref output.
- Hidden slot-fill node is omitted from slot outlet output.

DOM panel/context-menu tests:

- Visible node context menu shows `Hide`.
- Hidden node context menu shows `Unhide`.
- Root/body context menu does not show Hide.
- Mixed multi-select shows `Hide selected` and makes all selected nodes hidden.
- All-hidden multi-select shows `Unhide selected` and makes all selected nodes visible.

Existing mutation tests in `src/__tests__/page-tree/mutations.test.ts` and `src/__tests__/core/treeMutations.test.ts` continue to cover the raw toggle primitive.

End-of-task verification:

```sh
bun test
bun run build
bun run lint
```

## Related

- `docs/reference/page-tree.md` — `NodeTree<TNode>` shape and mutation API.
- `docs/editor.md` — editor store, Layers panel, and canvas overview.
- `docs/features/publisher.md` — public-page rendering pipeline.
- `src/core/page-tree/baseNode.ts` — node metadata schema.
- `src/core/page-tree/mutations.ts` — tree mutation primitive.
- `src/admin/pages/site/panels/DomPanel/LayerNodeContextMenu.tsx` — Layers context menu.
- `src/admin/pages/site/canvas/NodeRenderer.tsx` — canvas render pruning.
- `src/core/publisher/renderNode.ts` — published-output render pruning.
