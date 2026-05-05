/**
 * Built-in `content.entries` loop source — iterates published content
 * entries from a content collection.
 *
 * Reads from `content_entry_versions` joined to `content_collections` and
 * `media_assets`, scoped to entries with `status = 'published'`. Mirrors
 * the projection in `getPublishedContentEntryByRoute` (server) so loop
 * iteration produces the same field shape as the single-entry route.
 *
 * Order options:
 *   - publishedAt — most natural for blog/news listings
 *   - createdAt   — first seen by editors
 *   - updatedAt   — last modified
 *   - title       — alphabetical
 *
 * Filters:
 *   - collectionId (required) — picks the collection to iterate
 *
 * Future filters (not in v1): tag/taxonomy facets, custom-field equality
 * filters. Both depend on schema work that hasn't landed yet.
 */

import type { LoopEntitySource, LoopFetchResult, LoopItem, LoopSourceDb } from '../types'
import { firstImagePathFromMarkdown } from '../../markdown/renderContentMarkdown'
import { normalizeRouteBase } from '../../templates/templateMatching'

interface PublishedEntryRow {
  version_id: string
  entry_id: string
  collection_id: string
  collection_slug: string
  collection_route_base: string
  version_number: number
  title: string
  slug: string
  body_markdown: string
  featured_media_id: string | null
  featured_media_path: string | null
  seo_title: string
  seo_description: string
  published_at: Date | string
  created_at: Date | string
}

type OrderColumn = 'publishedAt' | 'createdAt' | 'updatedAt' | 'title'

const ALLOWED_ORDER_BY: ReadonlySet<OrderColumn> = new Set([
  'publishedAt',
  'createdAt',
  'updatedAt',
  'title',
])

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function rowToLoopItem(row: PublishedEntryRow): LoopItem {
  const collectionRouteBase = normalizeRouteBase(
    row.collection_route_base || `/${row.collection_slug}`,
  )
  const permalink = `${collectionRouteBase === '/' ? '' : collectionRouteBase}/${row.slug}`
  const firstImagePath = firstImagePathFromMarkdown(row.body_markdown)

  return {
    id: row.entry_id,
    fields: {
      id: row.entry_id,
      entryId: row.entry_id,
      versionId: row.version_id,
      versionNumber: Number(row.version_number),
      collectionId: row.collection_id,
      collectionSlug: row.collection_slug,
      collectionRouteBase,
      title: row.title,
      slug: row.slug,
      body: row.body_markdown,
      bodyMarkdown: row.body_markdown,
      featuredMediaId: row.featured_media_id,
      featuredMedia: row.featured_media_path,
      featuredMediaPath: row.featured_media_path,
      featuredMediaUrl: row.featured_media_path,
      firstImage: firstImagePath,
      firstImagePath,
      firstImageUrl: firstImagePath,
      seoTitle: row.seo_title,
      seoDescription: row.seo_description,
      publishedAt: toIsoString(row.published_at),
      createdAt: toIsoString(row.created_at),
      permalink,
    },
  }
}

/**
 * Run the page-slice query for a specific (column, direction) pair.
 *
 * Each branch hard-codes its ORDER BY column so the tagged template never
 * concatenates column names from variables — keeps the SQL parameterised
 * and satisfies db-postgres-isms.test.ts.
 */
async function fetchPage(
  db: LoopSourceDb,
  collectionId: string,
  orderBy: OrderColumn,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<PublishedEntryRow[]> {
  // The select + join + where clause is the same across every branch; the
  // ORDER BY differs. Bun.sql / bun:sqlite tagged templates can't stitch
  // identifier fragments, so each branch is a complete query.
  if (orderBy === 'publishedAt' && direction === 'asc') {
    const { rows } = await db<PublishedEntryRow>`
      select content_entry_versions.id as version_id,
             content_entries.id as entry_id,
             content_entries.collection_id,
             content_collections.slug as collection_slug,
             content_collections.route_base as collection_route_base,
             content_entry_versions.version_number,
             content_entry_versions.title,
             content_entry_versions.slug,
             content_entry_versions.body_markdown,
             content_entry_versions.featured_media_id,
             media_assets.public_path as featured_media_path,
             content_entry_versions.seo_title,
             content_entry_versions.seo_description,
             content_entry_versions.published_at,
             content_entry_versions.created_at
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      left join media_assets on media_assets.id = content_entry_versions.featured_media_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      order by content_entry_versions.published_at asc, content_entry_versions.id asc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  if (orderBy === 'publishedAt' && direction === 'desc') {
    const { rows } = await db<PublishedEntryRow>`
      select content_entry_versions.id as version_id,
             content_entries.id as entry_id,
             content_entries.collection_id,
             content_collections.slug as collection_slug,
             content_collections.route_base as collection_route_base,
             content_entry_versions.version_number,
             content_entry_versions.title,
             content_entry_versions.slug,
             content_entry_versions.body_markdown,
             content_entry_versions.featured_media_id,
             media_assets.public_path as featured_media_path,
             content_entry_versions.seo_title,
             content_entry_versions.seo_description,
             content_entry_versions.published_at,
             content_entry_versions.created_at
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      left join media_assets on media_assets.id = content_entry_versions.featured_media_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      order by content_entry_versions.published_at desc, content_entry_versions.id desc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  if (orderBy === 'createdAt' && direction === 'asc') {
    const { rows } = await db<PublishedEntryRow>`
      select content_entry_versions.id as version_id,
             content_entries.id as entry_id,
             content_entries.collection_id,
             content_collections.slug as collection_slug,
             content_collections.route_base as collection_route_base,
             content_entry_versions.version_number,
             content_entry_versions.title,
             content_entry_versions.slug,
             content_entry_versions.body_markdown,
             content_entry_versions.featured_media_id,
             media_assets.public_path as featured_media_path,
             content_entry_versions.seo_title,
             content_entry_versions.seo_description,
             content_entry_versions.published_at,
             content_entry_versions.created_at
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      left join media_assets on media_assets.id = content_entry_versions.featured_media_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      order by content_entry_versions.created_at asc, content_entry_versions.id asc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  if (orderBy === 'createdAt' && direction === 'desc') {
    const { rows } = await db<PublishedEntryRow>`
      select content_entry_versions.id as version_id,
             content_entries.id as entry_id,
             content_entries.collection_id,
             content_collections.slug as collection_slug,
             content_collections.route_base as collection_route_base,
             content_entry_versions.version_number,
             content_entry_versions.title,
             content_entry_versions.slug,
             content_entry_versions.body_markdown,
             content_entry_versions.featured_media_id,
             media_assets.public_path as featured_media_path,
             content_entry_versions.seo_title,
             content_entry_versions.seo_description,
             content_entry_versions.published_at,
             content_entry_versions.created_at
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      left join media_assets on media_assets.id = content_entry_versions.featured_media_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      order by content_entry_versions.created_at desc, content_entry_versions.id desc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  if (orderBy === 'updatedAt' && direction === 'asc') {
    const { rows } = await db<PublishedEntryRow>`
      select content_entry_versions.id as version_id,
             content_entries.id as entry_id,
             content_entries.collection_id,
             content_collections.slug as collection_slug,
             content_collections.route_base as collection_route_base,
             content_entry_versions.version_number,
             content_entry_versions.title,
             content_entry_versions.slug,
             content_entry_versions.body_markdown,
             content_entry_versions.featured_media_id,
             media_assets.public_path as featured_media_path,
             content_entry_versions.seo_title,
             content_entry_versions.seo_description,
             content_entry_versions.published_at,
             content_entry_versions.created_at
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      left join media_assets on media_assets.id = content_entry_versions.featured_media_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      order by content_entries.updated_at asc, content_entry_versions.id asc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  if (orderBy === 'updatedAt' && direction === 'desc') {
    const { rows } = await db<PublishedEntryRow>`
      select content_entry_versions.id as version_id,
             content_entries.id as entry_id,
             content_entries.collection_id,
             content_collections.slug as collection_slug,
             content_collections.route_base as collection_route_base,
             content_entry_versions.version_number,
             content_entry_versions.title,
             content_entry_versions.slug,
             content_entry_versions.body_markdown,
             content_entry_versions.featured_media_id,
             media_assets.public_path as featured_media_path,
             content_entry_versions.seo_title,
             content_entry_versions.seo_description,
             content_entry_versions.published_at,
             content_entry_versions.created_at
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      left join media_assets on media_assets.id = content_entry_versions.featured_media_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      order by content_entries.updated_at desc, content_entry_versions.id desc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  // title
  if (direction === 'asc') {
    const { rows } = await db<PublishedEntryRow>`
      select content_entry_versions.id as version_id,
             content_entries.id as entry_id,
             content_entries.collection_id,
             content_collections.slug as collection_slug,
             content_collections.route_base as collection_route_base,
             content_entry_versions.version_number,
             content_entry_versions.title,
             content_entry_versions.slug,
             content_entry_versions.body_markdown,
             content_entry_versions.featured_media_id,
             media_assets.public_path as featured_media_path,
             content_entry_versions.seo_title,
             content_entry_versions.seo_description,
             content_entry_versions.published_at,
             content_entry_versions.created_at
      from content_entries
      join content_collections on content_collections.id = content_entries.collection_id
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      left join media_assets on media_assets.id = content_entry_versions.featured_media_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
        and content_collections.deleted_at is null
      order by content_entry_versions.title asc, content_entry_versions.id asc
      limit ${limit} offset ${offset}
    `
    return rows
  }
  const { rows } = await db<PublishedEntryRow>`
    select content_entry_versions.id as version_id,
           content_entries.id as entry_id,
           content_entries.collection_id,
           content_collections.slug as collection_slug,
           content_collections.route_base as collection_route_base,
           content_entry_versions.version_number,
           content_entry_versions.title,
           content_entry_versions.slug,
           content_entry_versions.body_markdown,
           content_entry_versions.featured_media_id,
           media_assets.public_path as featured_media_path,
           content_entry_versions.seo_title,
           content_entry_versions.seo_description,
           content_entry_versions.published_at,
           content_entry_versions.created_at
    from content_entries
    join content_collections on content_collections.id = content_entries.collection_id
    join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
    left join media_assets on media_assets.id = content_entry_versions.featured_media_id
    where content_entries.collection_id = ${collectionId}
      and content_entries.status = 'published'
      and content_entries.deleted_at is null
      and content_collections.deleted_at is null
    order by content_entry_versions.title desc, content_entry_versions.id desc
    limit ${limit} offset ${offset}
  `
  return rows
}

export const ContentEntriesSource: LoopEntitySource = {
  id: 'content.entries',
  label: 'Content entries',
  description: 'Loop published items in a content collection (posts, products, etc.).',

  filterSchema: {
    collectionId: {
      type: 'select',
      label: 'Collection',
      // Options are populated dynamically by the Properties Panel from
      // the available content collections — passing an empty list here
      // keeps the schema valid when the source is registered before the
      // collection list is loaded.
      options: [],
    },
  },

  orderByOptions: [
    { id: 'publishedAt', label: 'Published date' },
    { id: 'createdAt', label: 'Created date' },
    { id: 'updatedAt', label: 'Last updated' },
    { id: 'title', label: 'Title' },
  ],

  fields: [
    { id: 'title', label: 'Title' },
    { id: 'slug', label: 'Slug' },
    { id: 'body', label: 'Body' },
    { id: 'bodyMarkdown', label: 'Body (raw markdown)' },
    { id: 'featuredMedia', label: 'Featured media', format: 'media' },
    { id: 'firstImage', label: 'First inline image', format: 'media' },
    { id: 'seoTitle', label: 'SEO title' },
    { id: 'seoDescription', label: 'SEO description' },
    { id: 'permalink', label: 'Permalink', format: 'url' },
    { id: 'publishedAt', label: 'Published date' },
    { id: 'createdAt', label: 'Created date' },
  ],

  async fetch(ctx): Promise<LoopFetchResult> {
    const collectionId =
      typeof ctx.filters.collectionId === 'string' ? ctx.filters.collectionId : ''
    if (!collectionId) return { items: [], totalItems: 0 }

    const orderBy: OrderColumn = ALLOWED_ORDER_BY.has(ctx.orderBy as OrderColumn)
      ? (ctx.orderBy as OrderColumn)
      : 'publishedAt'
    const direction: 'asc' | 'desc' = ctx.direction === 'asc' ? 'asc' : 'desc'

    const { rows: countRows } = await ctx.db<{ total: number }>`
      select count(*) as total
      from content_entries
      join content_entry_versions on content_entry_versions.id = content_entries.active_version_id
      where content_entries.collection_id = ${collectionId}
        and content_entries.status = 'published'
        and content_entries.deleted_at is null
    `
    const totalItems = Number(countRows[0]?.total ?? 0)
    if (totalItems === 0) return { items: [], totalItems: 0 }

    const rows = await fetchPage(ctx.db, collectionId, orderBy, direction, ctx.limit, ctx.offset)
    return {
      items: rows.map(rowToLoopItem),
      totalItems,
    }
  },

  preview() {
    // Editor-side preview is handled by the canvas via `useLoopPreviewItems`
    // (see `src/editor/components/Canvas/useLoopPreviewItems.ts`), which
    // fetches real content entries through the CMS API. This source's
    // synchronous `preview()` therefore returns [] — no synthetic
    // placeholder data leaks into the canvas. Plugin sources that genuinely
    // can't fetch client-side may still return synthetic items from their
    // own `preview()` implementations.
    return []
  },
}
