import { describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/cms/db'
import { CMS_MIGRATIONS } from '../../../server/cms/migrations'
import {
  createContentEntry,
  getPublishedContentEntryByRoute,
  listContentCollections,
  publishContentEntry,
  saveContentEntryDraft,
} from '../../../server/cms/contentRepository'
import { renderContentDocumentHtml } from '../../../server/cms/contentRenderer'
import { handleServerRequest } from '../../../server/router'

type QueryHandler = (sql: string, params: unknown[]) => DbResult | undefined

class ContentFakeDb implements DbClient {
  private readonly handlers: QueryHandler[]

  constructor(handlers: QueryHandler[]) {
    this.handlers = handlers
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbResult<Row>> {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
    for (const handler of this.handlers) {
      const result = handler(normalized, params)
      if (result) return result as DbResult<Row>
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }
}

function rowDate(value: string) {
  return new Date(value)
}

describe('content CMS migrations', () => {
  it('creates content tables and seeds the default Posts collection', () => {
    const sql = CMS_MIGRATIONS.map((migration) => migration.sql).join('\n')

    expect(sql).toContain('create table if not exists content_collections')
    expect(sql).toContain('create table if not exists content_entries')
    expect(sql).toContain('create table if not exists content_entry_versions')
    expect(sql).toContain("values ('posts', 'Posts', 'posts', 'Post', 'Posts')")
  })
})

describe('content CMS repository', () => {
  it('lists default collections with frontend field names', async () => {
    const db = new ContentFakeDb([
      (sql) => {
        if (!sql.startsWith('select id, name, slug, singular_label')) return undefined
        return {
          rows: [{
            id: 'posts',
            name: 'Posts',
            slug: 'posts',
            singular_label: 'Post',
            plural_label: 'Posts',
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(listContentCollections(db)).resolves.toEqual([{
      id: 'posts',
      name: 'Posts',
      slug: 'posts',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      createdAt: '2026-05-01T10:00:00.000Z',
      updatedAt: '2026-05-01T10:00:00.000Z',
    }])
  })

  it('creates drafts, saves body markdown, and publishes a snapshot', async () => {
    const calls: string[] = []
    const db = new ContentFakeDb([
      (sql, params) => {
        calls.push(sql)
        if (sql.startsWith('insert into content_entries')) {
          expect(params).toEqual([
            'entry_1',
            'posts',
            'Hello',
            'hello',
            'draft',
            '',
            null,
            '',
            '',
          ])
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:00:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('update content_entries set status =')) {
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'published',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: 'SEO Hello',
              seo_description: 'SEO Description',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:02:00Z'),
              published_at: rowDate('2026-05-01T10:02:00Z'),
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('update content_entries')) {
          expect(params).toEqual([
            'entry_1',
            'Hello',
            'hello',
            '# Hello',
            null,
            'SEO Hello',
            'SEO Description',
          ])
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: 'SEO Hello',
              seo_description: 'SEO Description',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:01:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql === 'begin' || sql === 'commit') return { rows: [], rowCount: 0 }
        if (sql.startsWith('select coalesce(max(version_number), 0)::int + 1')) {
          return { rows: [{ next_version: 1 }], rowCount: 1 }
        }
        if (sql.startsWith('select id, collection_id, title, slug')) {
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: 'SEO Hello',
              seo_description: 'SEO Description',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:01:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('insert into content_entry_versions')) {
          expect(params.slice(1)).toEqual([
            'entry_1',
            1,
            'Hello',
            'hello',
            '# Hello',
            null,
            'SEO Hello',
            'SEO Description',
          ])
          return { rows: [], rowCount: 1 }
        }
        return undefined
      },
    ])

    await createContentEntry(db, {
      id: 'entry_1',
      collectionId: 'posts',
      title: 'Hello',
      slug: 'hello',
    })
    await saveContentEntryDraft(db, 'entry_1', {
      title: 'Hello',
      slug: 'hello',
      bodyMarkdown: '# Hello',
      featuredMediaId: null,
      seoTitle: 'SEO Hello',
      seoDescription: 'SEO Description',
    })
    const result = await publishContentEntry(db, 'entry_1', 'admin_1')

    expect(result.version.versionNumber).toBe(1)
    expect(result.entry.status).toBe('published')
    expect(calls).toContain('insert into content_entry_versions (id, entry_id, version_number, title, slug, body_markdown, featured_media_id, seo_title, seo_description) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)')
  })

  it('resolves the latest published version by collection and entry slug', async () => {
    const db = new ContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select content_entry_versions.id')) return undefined
        expect(params).toEqual(['posts', 'hello'])
        return {
          rows: [{
            id: 'version_1',
            entry_id: 'entry_1',
            collection_id: 'posts',
            collection_slug: 'posts',
            version_number: 2,
            title: 'Published Hello',
            slug: 'hello',
            body_markdown: 'Published body',
            featured_media_id: null,
            seo_title: 'SEO',
            seo_description: 'Description',
            published_at: rowDate('2026-05-01T10:02:00Z'),
            created_at: rowDate('2026-05-01T10:02:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(getPublishedContentEntryByRoute(db, 'posts', 'hello')).resolves.toMatchObject({
      id: 'version_1',
      collectionSlug: 'posts',
      title: 'Published Hello',
      bodyMarkdown: 'Published body',
    })
  })
})

describe('content CMS rendering', () => {
  it('renders markdown content as safe public HTML', () => {
    const html = renderContentDocumentHtml({
      title: 'Hello <script>alert(1)</script>',
      bodyMarkdown: [
        '# Heading',
        '',
        'Paragraph with [link](https://example.com).',
        '',
        '![Alt image](/uploads/image.png)',
        '',
        '@[video](/uploads/movie.mp4)',
      ].join('\n'),
      seoTitle: 'SEO Hello',
      seoDescription: 'Description',
      featuredMediaPath: null,
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<title>SEO Hello</title>')
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<a href="https://example.com"')
    expect(html).toContain('<img src="/uploads/image.png" alt="Alt image"')
    expect(html).toContain('<video controls src="/uploads/movie.mp4"')
    expect(html).not.toContain('<script>')
  })
})

describe('content CMS public routes', () => {
  it('serves published content after page routes miss', async () => {
    const db = new ContentFakeDb([
      (sql) => {
        if (sql.startsWith('select page_versions.snapshot_json')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('select content_entry_versions.id')) {
          return {
            rows: [{
              id: 'version_1',
              entry_id: 'entry_1',
              collection_id: 'posts',
              collection_slug: 'posts',
              version_number: 1,
              title: 'Published post',
              slug: 'published-post',
              body_markdown: '# Published post',
              featured_media_id: null,
              featured_media_path: null,
              seo_title: '',
              seo_description: '',
              published_at: rowDate('2026-05-01T10:00:00Z'),
              created_at: rowDate('2026-05-01T10:00:00Z'),
            }],
            rowCount: 1,
          }
        }
        return undefined
      },
    ])

    const res = await handleServerRequest(new Request('http://localhost/posts/published-post'), { db })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<h1>Published post</h1>')
  })
})
