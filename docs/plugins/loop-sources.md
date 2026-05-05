# Loop entity sources

The `base.loop` module iterates a registered **loop entity source** and renders
its child template per item. The CMS ships three built-in sources
(`content.entries`, `site.pages`, `site.media`); plugins can register more
via the SDK.

## Concepts

| Concept | Description |
|---|---|
| `LoopEntitySource` | Registered backend that produces `LoopItem` rows for a loop. |
| `LoopItem`         | `{ id, fields }` — the unit a loop iterates. `fields` is read by `dynamicBindings`. |
| `LoopSourceField`  | Metadata describing a field's id, label, and format hint. |
| `filterSchema`     | `PropertySchema` of source-specific filter controls (Properties Panel). |
| `orderByOptions`   | Allowed `orderBy` values shown in the Properties Panel. |
| `entry stack`      | Publisher state: stack of `LoopItem` frames. Top resolves `currentEntry`; second-from-top resolves `parentEntry`. |

## Registering a custom source

```ts
import { loopSources, type LoopEntitySource } from '@core/plugin-sdk'

const ProductsSource: LoopEntitySource = {
  id: 'acme.products',
  label: 'Acme products',
  filterSchema: {
    category: {
      type: 'select',
      label: 'Category',
      options: [
        { label: 'All', value: '' },
        { label: 'New arrivals', value: 'new' },
      ],
    },
  },
  orderByOptions: [
    { id: 'name', label: 'Name' },
    { id: 'price', label: 'Price' },
  ],
  fields: [
    { id: 'name', label: 'Name' },
    { id: 'price', label: 'Price' },
    { id: 'image', label: 'Image', format: 'media' },
    { id: 'permalink', label: 'Permalink', format: 'url' },
  ],
  async fetch(ctx) {
    const category = typeof ctx.filters.category === 'string' ? ctx.filters.category : ''
    const { rows } = await ctx.db<{ id: string; name: string; price: number; image: string }>`
      select id, name, price, image_path as image
      from acme_products
      where ${category ? `category = ${category}` : '1=1'}
      order by name asc
      limit ${ctx.limit} offset ${ctx.offset}
    `
    const totalRow = await ctx.db<{ total: number }>`select count(*) as total from acme_products`
    return {
      items: rows.map((r) => ({
        id: r.id,
        fields: { ...r, permalink: `/products/${r.id}` },
      })),
      totalItems: Number(totalRow.rows[0]?.total ?? 0),
    }
  },
  preview() {
    return [
      { id: 'sample-1', fields: { name: 'Sample 1', price: 19.99, image: '', permalink: '#' } },
      { id: 'sample-2', fields: { name: 'Sample 2', price: 29.99, image: '', permalink: '#' } },
    ]
  },
}

loopSources.registerOrReplace(ProductsSource)
```

The plugin's manifest must request the `loops.register` permission for this
to be allowed at install time.

## SQL safety rules

Sources that issue SQL via `ctx.db` are scanned by
`src/__tests__/architecture/loop-source-sql-safety.test.ts` for the same
dialect-neutral SQL rules as `server/cms/*` (no `now()` — use
`current_timestamp`; no `::int` / `::jsonb` casts; no `distinct on`; etc.).

## Round-robin children

A loop with N child nodes renders iteration `i` with child `i mod N`. Two
children alternate (1,2,1,2…); three cycle (1,2,3,1,2,3…). Empty children
list renders nothing.

## Pagination

The loop has two pagination modes:

- `none` — render up to `limit` items.
- `infinite` — render `pageSize` items inline; the loop runtime appends
  subsequent pages on user click. Endpoint:
  `GET /_pb/loop/<loopId>?page=N&pagePath=<page>` returns `{ html, hasMore }`.

Numeric pagination (page numbers in URL) is **not** part of the loop
itself — it will live in a separate `base.pagination` module that pairs
with a loop by id.
