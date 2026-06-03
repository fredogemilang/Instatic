# Loops

The `base.loop` module — iterates a **loop entity source** and renders its child variants per item. Powers post listings, product grids, related-articles sections, media galleries, anything that displays a collection.

Loop sources are pluggable: built-in sources (`content.entries`, `site.pages`, `site.media`) cover the universal store; plugins can register more via the SDK.

---

## TL;DR

- Loop source registry: `loopSourceRegistry` in `src/core/loops/registry.ts`. First-party sources self-register from `src/core/loops/sources/index.ts` at boot.
- `LoopEntitySource` shape: `{ id, label, fields, filterSchema?, orderByOptions?, fetch, preview? }` in `src/core/loops/types.ts`.
- The `base.loop` module's children are **variants** — different per-item layouts (e.g. "Card", "Featured"). The walker round-robins across them as it iterates.
- At publish time, `loopPrefetch.ts` calls each loop's `fetch()` and stores results on the render context. The walker is then purely synchronous.
- Each iteration pushes a `LoopItem` onto the `entryStack`; nodes inside the loop resolve `currentEntry.<field>` against that item via dynamic bindings.

---

## Where the code lives

```text
src/core/loops/
├── types.ts                 — LoopItem, LoopEntitySource, LoopSourceField, LoopFetchResult, ...
├── registry.ts              — LoopSourceRegistry singleton (`loopSourceRegistry`)
└── sources/
    ├── index.ts             — register the three built-ins at boot
    ├── dataRows.ts          — content.entries (any data_table)
    ├── sitePages.ts         — site.pages
    └── siteMedia.ts         — site.media

src/modules/base/loop/        — the base.loop module definition

src/core/publisher/renderLoop.ts  — render-time walker (round-robin variants)
server/publish/loopPrefetch.ts    — server-side pre-fetch before render
```

---

## The `LoopEntitySource` shape

```ts
interface LoopEntitySource {
  /** Stable id — 'content.entries', 'site.pages', 'site.media', plugin: 'acme.products' */
  id:        string
  label:     string

  /** Field metadata — what's available to dynamic bindings inside the loop. */
  fields:    LoopSourceField[]

  /** Optional: PropertySchema of filter controls shown in the Properties panel. */
  filterSchema?:   PropertySchema

  /** Optional: allowed `orderBy` values shown in the Properties panel. */
  orderByOptions?: { value: string; label: string }[]

  /** Server-side fetch — runs at publish time (and live at editor render time). */
  fetch:     (ctx: SourceFetchContext) => Promise<LoopFetchResult>

  /** Optional: synthesized items for editor canvas preview. */
  preview?:  (ctx: SourcePreviewContext) => LoopFetchResult

  /**
   * Optional. Default `false`. Set `true` when the source returns data
   * that varies per visitor request (live API, time-of-day data, per-
   * visitor results). Loops using a request-dependent source become
   * Layer C "holes" — the publisher emits a placeholder + a tiny client
   * runtime fetches the rendered fragment lazily via `/_instatic/hole/<nodeId>`.
   *
   * Built-in sources (`content.entries`, `site.pages`, `site.media`)
   * declare `false` — their data is publish-time-deterministic, the loop
   * bakes into the static disk artefact and re-bakes on every publish.
   * Plugin sources backed by `cms.storage.*` should also stay `false`;
   * only mark `true` when the source genuinely needs per-visitor data.
   */
  requestDependent?: boolean
}

interface LoopSourceField {
  id:     string            // 'title', 'slug', 'featuredMedia', ...
  label:  string
  format?: 'plain' | 'html' | 'url' | 'media'
}

interface LoopItem {
  id:     string             // unique within the loop result
  fields: Record<string, unknown>
}

interface LoopFetchResult {
  items:    LoopItem[]
  total?:   number
  hasMore?: boolean
  cursor?:  string
}
```

Sources are **stateless** — they receive everything they need via the `ctx` argument. The publisher and editor can call `fetch` independently.

---

## Built-in sources

### `content.entries`

Iterates rows in any `data_table`. The user picks the table in the Properties panel; filters narrow by status, author, category-like fields, date.

```ts
fetch({ db, filter, orderBy, limit }) {
  const rows = await listDataRows(db, filter.tableId, { ... })
  return { items: rows.map(rowToLoopItem), total: rows.length }
}
```

This covers blog posts, products, anything in the universal store.

### `site.pages`

Iterates pages in the site. Filters by template inclusion/exclusion.

Used by sitemaps, "All pages" indexes.

The source's runtime `LoopItem.fields` map includes internal fields used by code paths that need stable identity, but its author-facing `fields` list exposes only title, slug, and permalink. The binding picker must not offer page ids or template flags as front-end content.

### `site.media`

Iterates `media_assets`. Filters by MIME type prefix.

Used by galleries.

Its author-facing `fields` list exposes filename, path/URL/source URL, MIME type, and upload date. Internal uploader ids stay in `LoopItem.fields` for code that needs them, but they are not binding-picker rows.

### Plugin-registered sources

A plugin with `loops.register` registers a custom source via the SDK at activation. The source runs inside the **QuickJS sandbox** — it can use `api.cms.storage.collection(...)` to fetch plugin-owned data or `fetch(...)` (with `network.outbound` permission) for external APIs.

See [docs/features/plugin-system.md](plugin-system.md) and the loop-sources section.

---

## Filters and ordering

Each source declares its filter and order options through `filterSchema` and `orderByOptions`. The editor's Properties panel renders the matching controls when a `base.loop` node is selected and its `sourceId` is set.

```ts
filterSchema: {
  status: {
    type: 'select',
    label: 'Status',
    options: [
      { value: 'published', label: 'Published' },
      { value: 'draft',     label: 'Draft' },
      { value: 'any',       label: 'Any' },
    ],
    defaultValue: 'published',
  },
  category: {
    type: 'select',
    label: 'Category',
    options: [/* populated dynamically — see below */],
  },
}
orderByOptions: [
  { value: 'publishedAt:desc', label: 'Newest first' },
  { value: 'publishedAt:asc',  label: 'Oldest first' },
  { value: 'title:asc',        label: 'Title A→Z' },
]
```

The `base.loop` node carries `props.filter: Record<string, unknown>` and `props.orderBy: string`. The publisher passes them to `fetch(ctx)` as `ctx.filter` and `ctx.orderBy`.

---

## Variants — the loop's children

A `base.loop` node has **N child nodes**, each a "variant". The walker round-robins across them:

```text
Loop with 2 variants ('A', 'B') and 5 items:
  Item 0  → variant A
  Item 1  → variant B
  Item 2  → variant A
  Item 3  → variant B
  Item 4  → variant A
```

Variants are useful for:

- **Featured + standard** — first item uses the "featured" variant, others use the "standard" variant.
- **Heading + items** — a heading variant that renders once between groups.
- **A/B layouts** — alternating layouts for visual variety.

A loop with one variant is the common case (every item uses the same layout).

---

## The render walk

```text
renderLoop(loopNode, ctx, renderNode):
    │
    ├─→ prefetched = ctx.loopPrefetch.get(loopNode.id)
    │       (results already resolved by loopPrefetch.ts at publish time)
    │
    ├─→ variants = loopNode.children     ← N variant subtrees
    │
    ├─→ const out: string[] = []
    │   for each (item, index) of prefetched.items:
    │       push item onto ctx.entryStack
    │       variant = variants[index % variants.length]
    │       out.push(renderNode(variant, ctx))
    │       pop entryStack
    │
    └─→ return out.join('')
```

The `renderNode` callback is the publisher's normal walker — so a variant's subtree renders exactly like any other tree, including:

- `currentEntry.<field>` bindings resolve against the pushed item.
- Nested loops can push a deeper item; the outer loop's item becomes `parentEntry`.
- VC refs inside variants render with their own slot fills, with `currentEntry` still pointing at the loop item.

See [docs/features/publisher.md](publisher.md) → "renderLoop" for the broader pipeline.

---

## Prefetch

The walker is **purely synchronous** — async data (loop sources, media) is resolved up-front so the publisher doesn't have to `await` per node.

`server/publish/loopPrefetch.ts`:

```ts
// collectLoopNodes uses walkRenderTree (server/publish/renderTreeWalk.ts) so
// base.loop nodes inside Visual Component definition trees are included —
// a loop inside a VC body is fetched and rendered with real data.
async function prefetchLoops(page, site, db) {
  const loopNodes = collectLoopNodes(page, site)   // descends page tree + all VC trees
  const results = await Promise.all(
    loopNodes.map(async (node) => {
      const source = loopSourceRegistry.get(node.props.sourceId)
      const result = await source.fetch({ db, filter: node.props.filter, ... })
      return [node.id, result] as const
    })
  )
  return new Map(results)
}
```

The map is passed into `RenderContext.loopData`. The walker reads from it; no async at render time.

---

## Editor canvas preview

In the editor, the canvas needs the loop to render meaningfully. Two paths:

1. **Live fetch** — the canvas POSTs `/admin/api/cms/loop` with the loop's `sourceId` + `filter`, gets results back, renders. The default for built-in sources backed by the user's DB.
2. **Preview** — the source's optional `preview(ctx)` returns synthesized items (e.g. 3 fake products). Used by sources that can't be live-queried in the editor (plugin sources that hit external APIs).

The canvas dispatches based on whether `source.preview` exists.

---

## Cookbook

### Use the built-in `content.entries` source

1. Insert a `base.loop` node into the page.
2. In the Properties panel, set `sourceId = 'content.entries'`, pick the `data_table` (e.g. "Posts").
3. Set filters (`status: published`, `category: 'tech'`).
4. Set order (`publishedAt:desc`).
5. Configure variants:
   - Drop a `base.container` as the loop's first child — this is variant A.
   - Add nodes inside: a heading bound to `currentEntry.title`, content bound to `currentEntry.body`, an image bound to `currentEntry.featuredMedia`.
6. Publish. Each iteration renders the variant with the item's fields substituted.

### Register a plugin loop source

```ts
// plugin server/index.js
import { permissions } from '@core/plugin-sdk'

export function activate(api) {
  const products = api.cms.storage.collection('products')

  api.cms.loops.registerSource({
    id:    'acme.products',
    label: 'Acme products',
    fields: [
      { id: 'name',  label: 'Name',  format: 'text' },
      { id: 'price', label: 'Price', format: 'number' },
      { id: 'image', label: 'Image', format: 'media' },
    ],
    filterSchema: {
      category: {
        type:    'select',
        label:   'Category',
        options: [
          { value: '',           label: 'All' },
          { value: 'new',        label: 'New arrivals' },
          { value: 'clearance',  label: 'Clearance' },
        ],
      },
    },
    orderByOptions: [
      { value: 'createdAt:desc', label: 'Newest' },
      { value: 'price:asc',      label: 'Price low → high' },
    ],
    async fetch(ctx) {
      const all = await products.list()
      const items = all
        .filter((p) => !ctx.filter?.category || p.category === ctx.filter.category)
        .sort(/* by ctx.orderBy */)
        .slice(0, ctx.limit ?? 100)
        .map((p) => ({ id: p.id, fields: p }))
      return { items, total: items.length }
    },
  })
}
```

Manifest:

```json
{
  "permissions": ["cms.storage", "loops.register"],
  "resources": [{ "id": "products", "label": "Products", "fields": [...] }],
  "entrypoints": { "server": "server/index.js" }
}
```

### Add variants to a loop

Drop multiple children inside the `base.loop` node. The walker round-robins them. Use a small icon overlay or DOM-panel label to remember which variant is which.

### Two-source list (e.g. featured posts + recent posts)

Use **two `base.loop` nodes** side by side, one filtered by `featured: true` and the other by everything else. Loops can't merge results.

### Pagination

The current built-in sources fetch up to `ctx.limit` per render (no live pagination on published pages). For paginated UI:

- Use a custom `base.loop` per page (loop with `offset` filter) — works for static "page 1", "page 2" pages.
- For interactive pagination, ship a plugin frontend script that fetches from a plugin endpoint and replaces the loop's DOM.

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| `await fetch(...)` inside the loop walker                            | Pre-fetch via `loopPrefetch.ts`                          |
| Plugin sources that hit the host DB directly                         | Use `api.cms.storage.*`                                  |
| Reaching across loop iterations (e.g. "the previous item")           | Items are independent. Use a server-side fetch + materialize the relation. |
| Per-iteration state (e.g. counter)                                   | Loop iterations are independent. The walker doesn't preserve state. |
| Rendering a loop without prefetched data                             | `RenderContext.loopPrefetch` must be populated — otherwise the walker errors. |
| Cycling variants by index `% items.length` instead of `% variants.length` | Round-robin is by variants. Read `node.children.length`. |
| Source ids without a namespace (just `products`)                     | Namespace by plugin (`acme.products`) — collisions otherwise |

---

## Related

- [docs/architecture.md](../architecture.md) — universal `entryStack`
- [docs/features/publisher.md](publisher.md) — `renderLoop` is one of two specialized renderers
- [docs/features/templates.md](templates.md) — `currentEntry` resolves the same way for templates and loops
- [docs/features/content-storage.md](content-storage.md) — `data_tables` + `data_rows` is the source for `content.entries`
- [docs/features/plugin-system.md](plugin-system.md) — plugin loop sources
- Source-of-truth files:
  - `src/core/loops/types.ts` — `LoopEntitySource`, `LoopItem`, `LoopFetchResult`
  - `src/core/loops/registry.ts` — registry singleton
  - `src/core/loops/sources/dataRows.ts`, `sitePages.ts`, `siteMedia.ts` — built-in sources
  - `src/modules/base/loop/` — the `base.loop` module
  - `src/core/publisher/renderLoop.ts` — render walker
  - `server/publish/loopPrefetch.ts` — pre-fetch
  - `server/publish/loopRuntime.ts`, `server/handlers/cms/loop.ts` — runtime asset + live-fetch endpoint
- Gate tests:
  - `src/__tests__/architecture/loop-source-id-format.test.ts`
  - `src/__tests__/architecture/loop-source-sql-safety.test.ts`
