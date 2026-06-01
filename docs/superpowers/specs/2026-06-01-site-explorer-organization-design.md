# Site Explorer Organization Design

This spec defines the editor-only organization model for the Site Explorer panel.

Site Explorer organization is a persisted shell-level registry that lets authors group and reorder pages, templates, Visual Components, stylesheets, and scripts without changing public routes or the storage shape of the organized items.

---

## TL;DR

- Folders are decorative editor containers only. They never create URL segments, page parents, component namespaces, or filesystem paths.
- Organization lives on the site shell as `site.explorer`, not on `Page`, `VisualComponent`, or `SiteFile`.
- The registry is section-scoped: `pages`, `templates`, `components`, `styles`, and `scripts` each own their own folders and order.
- The Site Explorer UI uses the existing `Tree*` primitives from `src/admin/pages/site/ui/Tree/` and `@dnd-kit/core` for row drag-and-drop.
- Phase 1 ships the schema, store actions, and Tree-based Pages/Templates UI. Phase 2 applies the same reusable section component to Components, Styles, and Scripts. Phase 3 adds homepage action polish and browser smoke coverage.

## Current State

The current Site Explorer panel is `src/admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.tsx`. It renders flat sections for pages, templates, components, styles, and scripts with local row markup.

Pages are stored separately from the site shell:

- `src/core/page-tree/page.ts` defines `PageSchema` as page metadata plus a `NodeTree<PageNode>`.
- `src/core/data/pageFromRow.ts` maps `Page` to and from `data_rows` where `table_id = 'pages'`.
- `server/handlers/cms/pages.ts` batch-reconciles the page roster through `PUT /admin/api/cms/pages`.

Visual Components also live outside the shell:

- `src/core/data/componentFromRow.ts` maps Visual Components to and from `data_rows` where `table_id = 'components'`.
- `server/handlers/cms/components.ts` owns the component roster endpoint.

The shell is the right place for organization metadata because it already persists editor-level site structure that is not a page or VC row:

- `src/core/page-tree/siteDocument.ts` defines `SiteShellSchema`.
- `server/repositories/site.ts` stores the shell in `site.settings_json`.
- `src/core/persistence/cms.ts` splits saves into shell, pages, and components.

## Data Model

Add a new `site.explorer` field to `SiteShellSchema` in `src/core/page-tree/siteDocument.ts`.

```ts
type SiteExplorerSectionId = 'pages' | 'templates' | 'components' | 'styles' | 'scripts'

type SiteExplorerFolder = {
  id: string
  name: string
}

type SiteExplorerItemPlacement = {
  id: string
  parentFolderId?: string
  order: number
}

type SiteExplorerSection = {
  folders: SiteExplorerFolder[]
  items: SiteExplorerItemPlacement[]
}

type SiteExplorerOrganization = Record<SiteExplorerSectionId, SiteExplorerSection>
```

`id` in `items` is the existing item id:

| Section | Item id source |
|---------|----------------|
| `pages` | `Page.id` where `page.template` is absent |
| `templates` | `Page.id` where `page.template` is present |
| `components` | `VisualComponent.id` |
| `styles` | `SiteFile.id` where `file.type === 'style'` |
| `scripts` | `SiteFile.id` where `file.type === 'script'` |

Folder ids are local to the organization registry. They do not need to be globally meaningful, but they are unique across the whole `site.explorer` object to keep drag payloads simple.

The parser is tolerant on read:

- Missing `site.explorer` becomes empty sections.
- Unknown section keys are dropped.
- Placements for missing items are dropped.
- Items missing a placement are appended after persisted placements in current item-array order.
- Folders that become empty remain; folders are user-created organization, not derived state.

Write validation is strict enough to reject impossible state:

- `parentFolderId` must reference a folder in the same section.
- `order` must be finite.
- A section must not contain duplicate folder ids or duplicate item ids.
- A placement cannot reference an item from another section.

## Store Actions

Add organization actions to `src/admin/pages/site/store/slices/site/` and expose them through `SiteSlice` in `src/admin/pages/site/store/slices/site/types.ts`.

Required actions:

```ts
createExplorerFolder(sectionId: SiteExplorerSectionId, name: string): string
renameExplorerFolder(sectionId: SiteExplorerSectionId, folderId: string, name: string): void
deleteExplorerFolder(sectionId: SiteExplorerSectionId, folderId: string): void
moveExplorerFolder(sectionId: SiteExplorerSectionId, folderId: string, nextIndex: number): void
moveExplorerItem(sectionId: SiteExplorerSectionId, itemId: string, parentFolderId: string | null, nextIndex: number): void
reconcileSiteExplorerOrganization(): void
```

Deletion of a folder moves its children back to the section root at the folder's position. It does not delete pages, templates, components, styles, or scripts.

Existing item lifecycle actions update organization in the same undoable mutation:

- `addPage`, `duplicatePage`, and template conversion add or move the relevant placement.
- `deletePage` removes the placement.
- `createVisualComponent` and `deleteVisualComponent` add/remove component placements.
- `createFile`, `renameFile`, and `deleteFile` preserve or remove stylesheet/script placements according to file type.

`reconcileSiteExplorerOrganization()` is called when loading a site and after any operation that can change section membership. It repairs organization against the current `site.pages`, `site.visualComponents`, and `site.files`.

## UI Architecture

Replace the flat row rendering in `src/admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.tsx` with a reusable tree section component.

Proposed files:

| File | Responsibility |
|------|----------------|
| `src/admin/pages/site/panels/SiteExplorerPanel/siteExplorerModel.ts` | Builds section trees from site data and `site.explorer`. |
| `src/admin/pages/site/panels/SiteExplorerPanel/SiteExplorerTreeSection.tsx` | Renders one section with folders, item rows, context menu hooks, and drop indicators. |
| `src/admin/pages/site/panels/SiteExplorerPanel/useSiteExplorerDnd.ts` | Owns `@dnd-kit/core` drag state and computes reorder/folder targets. |
| `src/admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.tsx` | Wires store actions, dialogs, and section definitions. |

Rows use:

- `TreeContainer`, `TreeRow`, `TreeChevron`, `TreeIconSlot`, `TreeLabel`, and `TreeMeta` from `src/admin/pages/site/ui/Tree/`.
- `Button`, `Input`, and existing context menu primitives from `src/ui/components/` and `src/admin/pages/site/explorer-actions/`.
- Existing pixel-art icons, deep-imported from `pixel-art-icons/icons/<name>`.

Each section supports:

- Create item through the existing plus button.
- Create folder through a section header or section context action.
- Expand/collapse folders.
- Rename/delete folders.
- Rename/delete items using existing dialogs and handlers.
- Drag item before/after another item or into a folder.
- Drag folder before/after another folder in the same section.

Cross-section drops are rejected. A template is not dragged into Pages and a page is not dragged into Templates. Converting a page to a template moves the placement from `pages` to `templates`.

## Homepage Behavior

The homepage remains the page whose slug is `index`, as defined by `isHomePage` in `src/core/page-tree/slugs.ts`.

Add a page context action: `Set as homepage`.

When applied to page `target`:

1. Find the current home page with slug `index`.
2. Rename the current home page's slug to a unique slug derived from its title.
3. Rename `target.slug` to `index`.
4. Keep both pages in their current explorer folders and order.

This action affects public routing because slug `index` publishes at `/`. It does not imply parent/child page relationships.

## Error Handling

Schema parsing follows the existing TypeBox boundary pattern:

- `SiteExplorerOrganizationSchema` lives in `src/core/page-tree/siteExplorer.ts`.
- `parseSiteExplorerOrganization(raw)` returns a normalized organization object.
- `parseSiteDocument` in `src/core/page-tree/siteDocument.ts` calls that parser.
- `validateSite` in `src/core/persistence/validate.ts` runs post-checks that reconcile organization against the shell-level files. Page and VC item reconciliation also runs after pages and VCs are assembled in `src/core/persistence/cms.ts` and store load.

UI errors follow existing Site Explorer patterns:

- Catch async UI handlers when an API boundary is involved.
- Use `console.error('[SiteExplorerPanel] ...:', err)` for developer-visible errors.
- Use role-based dialog or inline state for user-visible errors.
- No native `alert`, `confirm`, or `prompt`.

## Testing

Unit tests cover the data model:

- `src/__tests__/page-tree/siteExplorerOrganization.test.ts` verifies parse/reconcile behavior.
- `src/__tests__/page-tree/page-mutations.test.ts` gains cases for organization updates during page add/delete/duplicate/template conversion.

Panel tests cover the UI:

- `src/__tests__/site-explorer/siteExplorerPanel.test.tsx` verifies folder rendering, folder create/rename/delete, item placement, and context menu behavior.
- `src/__tests__/site-explorer/siteExplorerTemplates.test.tsx` verifies template section placement and conversion.

Architecture tests update the previous invariant:

- `src/__tests__/architecture/task455-tree-primitive.test.ts` changes to require Site Explorer to use `TreeContainer`/`TreeRow` instead of forbidding `<Tree*>`.

Browser smoke testing covers the persistence path:

- Run `bun run dev`.
- Open `http://127.0.0.1:5173/admin/site`.
- Use the seeded local admin account from `CLAUDE.md`.
- Create a folder under Pages, drag a page into it, save, reload, and verify the folder placement persists.
- Rename a page from the Site Explorer and verify the row, slug, and reload state.

## Phase Plan

### Phase 1: Pages and Templates

Implement `site.explorer`, parser/reconcile helpers, store actions, and a Tree-based section renderer for Pages/Templates only.

Acceptance:

- Existing flat page/template behavior still works.
- Pages and templates can be placed in folders.
- Folder state survives save/reload.
- Rename and delete still work.

### Phase 2: Components, Styles, and Scripts

Reuse the same section renderer for Components, Styles, and Scripts.

Acceptance:

- Every Site Explorer category supports folders and ordering.
- Component rows remain draggable onto the canvas with the existing `visualComponentRef` payload.
- Style/script file opening and renaming behavior is unchanged.

### Phase 3: Polish and Live Verification

Add `Set as homepage`, improve DnD drop indicators, and run browser smoke coverage.

Acceptance:

- Setting a homepage swaps slugs correctly.
- Cross-section drops are visibly rejected.
- Full verification runs: `bun run build`, `bun test`, and `bun run lint`.

## Related

- `docs/features/site-shell.md` — shell persistence model.
- `docs/editor.md` — Site editor store and UI architecture.
- `docs/reference/ui-primitives.md` — `Tree*` and UI primitive rules.
- `docs/reference/typebox-patterns.md` — TypeBox validation patterns.
- Source-of-truth files:
  - `src/core/page-tree/siteDocument.ts`
  - `src/core/page-tree/page.ts`
  - `src/core/data/pageFromRow.ts`
  - `src/core/data/componentFromRow.ts`
  - `src/admin/pages/site/panels/SiteExplorerPanel/SiteExplorerPanel.tsx`
  - `src/admin/pages/site/ui/Tree/`
  - `src/admin/pages/site/store/slices/site/`
  - `server/handlers/cms/pages.ts`
  - `server/handlers/cms/components.ts`
- Gate tests:
  - `src/__tests__/architecture/task455-tree-primitive.test.ts`
  - `src/__tests__/architecture/no-vc-in-site-shell.test.ts`
