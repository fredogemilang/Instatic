import { describe, expect, it } from 'bun:test'
import type { DbResult } from '../../../server/db'
import { pgMigrations } from '../../../server/db/migrations-pg'
import {
  createContentCollection,
  getContentEntryRedirectByRoute,
  createContentEntry,
  getPublishedContentEntryByRoute,
  listContentAuthorOptions,
  listContentCollections,
  publishContentEntry,
  saveContentEntryDraft,
  updateContentEntryAuthor,
  updateContentCollection,
  updateContentEntryCollection,
} from '../../../server/repositories/content'
import { renderContentDocumentHtml } from '../../../server/publish/contentRenderer'
import { handleServerRequest } from '../../../server/router'
import { createFakeDb } from './dbTestFake'

type QueryHandler = (sql: string, params: unknown[]) => DbResult | undefined

function makeContentFakeDb(handlers: QueryHandler[]) {
  return createFakeDb(async (rawSql, params): Promise<DbResult> => {
    const sql = rawSql.replace(/\s+/g, ' ').trim().toLowerCase()
    for (const handler of handlers) {
      const result = handler(sql, params)
      if (result) return result
    }
    throw new Error(`Unhandled SQL: ${rawSql}`)
  })
}

function rowDate(value: string) {
  return new Date(value)
}

const productCollectionFields = {
  builtIn: {
    body: true,
    featuredMedia: false,
    seo: false,
  },
  custom: [],
}

describe('content CMS migrations', () => {
  it('creates content tables and seeds the default Posts collection', () => {
    const sql = pgMigrations.map((migration) => migration.sql).join('\n')

    expect(sql).toContain('create table if not exists content_collections')
    expect(sql).toContain('create table if not exists content_entries')
    expect(sql).toContain('create table if not exists content_entry_versions')
    expect(sql).toContain('active_version_id')
    expect(sql).toContain('create table if not exists content_entry_redirects')
    expect(sql).toContain("values ('posts', 'Posts', 'posts', '/posts', 'Post', 'Posts')")
  })
})

describe('content CMS repository', () => {
  it('lists default collections with frontend field names', async () => {
    const db = makeContentFakeDb([
      (sql) => {
        if (!sql.startsWith('select id, name, slug, route_base')) return undefined
        return {
          rows: [{
            id: 'posts',
            name: 'Posts',
            slug: 'posts',
            route_base: '/posts',
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
      routeBase: '/posts',
      singularLabel: 'Post',
      pluralLabel: 'Posts',
      fields: {
        builtIn: {
          body: true,
          featuredMedia: true,
          seo: true,
        },
        custom: [],
      },
      createdAt: '2026-05-01T10:00:00.000Z',
	      updatedAt: '2026-05-01T10:00:00.000Z',
	      createdByUserId: null,
	      updatedByUserId: null,
	    }])
  })

  it('creates collections with persisted field settings', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('insert into content_collections')) return undefined
        expect(params).toEqual([
          'products',
          'Products',
          'products',
          '/products',
	          'Product',
	          'Products',
	          productCollectionFields,
	          null,
	          null,
	        ])
        return {
          rows: [{
            id: 'products',
            name: 'Products',
            slug: 'products',
            route_base: '/products',
            singular_label: 'Product',
            plural_label: 'Products',
            fields_json: productCollectionFields,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:00:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(createContentCollection(db, {
      id: 'products',
      name: 'Products',
      slug: 'products',
      routeBase: '/products',
      singularLabel: 'Product',
      pluralLabel: 'Products',
      fields: productCollectionFields,
    })).resolves.toMatchObject({
      id: 'products',
      fields: productCollectionFields,
    })
  })

  it('updates collection identity, route, labels, and field settings', async () => {
    const nextFields = {
      builtIn: {
        body: false,
        featuredMedia: true,
        seo: false,
      },
      custom: [],
    }
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('update content_collections')) return undefined
        // Template order: SET name=$1, slug=$2, route_base=$3, singular_label=$4,
        //                     plural_label=$5, fields_json=$6  WHERE id=$7
        expect(params).toEqual([
          'Catalog',
          'catalog',
          '/catalog',
          'Product',
	          'Products',
	          nextFields,
	          null,
	          'products',
	        ])
        return {
          rows: [{
            id: 'products',
            name: 'Catalog',
            slug: 'catalog',
            route_base: '/catalog',
            singular_label: 'Product',
            plural_label: 'Products',
            fields_json: nextFields,
            created_at: rowDate('2026-05-01T10:00:00Z'),
            updated_at: rowDate('2026-05-01T10:05:00Z'),
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(updateContentCollection(db, 'products', {
      name: 'Catalog',
      slug: 'catalog',
      routeBase: '/catalog',
      singularLabel: 'Product',
      pluralLabel: 'Products',
      fields: nextFields,
    })).resolves.toMatchObject({
      id: 'products',
      name: 'Catalog',
      slug: 'catalog',
      routeBase: '/catalog',
      fields: nextFields,
    })
  })

  it('moves an entry to another collection when its slug is available there', async () => {
    let moved = false
    const db = makeContentFakeDb([
      (sql, params) => {
        if (sql.startsWith('select content_entries.id')) {
          expect(params).toEqual(['entry_1'])
          return {
            rows: [{
              id: 'entry_1',
              collection_id: moved ? 'products' : 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate(
                moved ? '2026-05-01T10:02:00Z' : '2026-05-01T10:01:00Z',
              ),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select id from content_collections')) {
          expect(params).toEqual(['products'])
          return { rows: [{ id: 'products' }], rowCount: 1 }
        }
        if (sql.startsWith('select id from content_entries')) {
          // Template order: WHERE collection_id=$1 AND slug=$2 AND id <> $3
          expect(params).toEqual(['products', 'hello', 'entry_1'])
          return { rows: [], rowCount: 0 }
        }
	        if (sql.startsWith('update content_entries set collection_id')) {
	          // Template order: SET collection_id=$1, updated_by_user_id=$2 WHERE id=$3
	          expect(params).toEqual(['products', null, 'entry_1'])
          moved = true
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'products',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:02:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        return undefined
      },
    ])

    await expect(updateContentEntryCollection(db, 'entry_1', 'products')).resolves.toEqual({
      ok: true,
      entry: {
        id: 'entry_1',
        collectionId: 'products',
        title: 'Hello',
        slug: 'hello',
        status: 'draft',
	        bodyMarkdown: '# Hello',
	        featuredMediaId: null,
	        seoTitle: '',
	        seoDescription: '',
	        authorUserId: null,
	        createdByUserId: null,
	        updatedByUserId: null,
	        publishedByUserId: null,
	        author: null,
	        createdBy: null,
	        updatedBy: null,
	        publishedBy: null,
	        createdAt: '2026-05-01T10:00:00.000Z',
        updatedAt: '2026-05-01T10:02:00.000Z',
        publishedAt: null,
        deletedAt: null,
      },
    })
  })

  it('lists active content authors with role display metadata', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select users.id')) return undefined
        expect(sql).toContain('users.status = $1')
        expect(params).toEqual(['active'])
        return {
          rows: [
            {
              id: 'author_1',
              email: 'author@example.com',
              email_normalized: 'author@example.com',
              display_name: 'Author Name',
              password_hash: 'hash',
              status: 'active',
              role_id: 'editor',
              last_login_at: null,
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:00:00Z'),
              deleted_at: null,
              role_slug: 'editor',
              role_name: 'Editor',
              role_description: '',
              role_is_system: true,
              role_capabilities_json: ['content.edit.own'],
            },
          ],
          rowCount: 1,
        }
      },
    ])

    await expect(listContentAuthorOptions(db)).resolves.toEqual([{
      id: 'author_1',
      email: 'author@example.com',
      displayName: 'Author Name',
      roleSlug: 'editor',
      roleName: 'Editor',
    }])
  })

  it('updates an entry author and returns hydrated display metadata', async () => {
    let assigned = false
    const db = makeContentFakeDb([
      (sql, params) => {
        if (sql.startsWith('update content_entries set author_user_id')) {
          expect(params).toEqual(['author_2', 'editor_1', 'entry_1'])
          assigned = true
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              author_user_id: 'author_2',
              created_by_user_id: 'author_1',
              updated_by_user_id: 'editor_1',
              published_by_user_id: null,
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:04:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select content_entries.id')) {
          expect(assigned).toBe(true)
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: 'draft',
              body_markdown: '# Hello',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              author_user_id: 'author_2',
              author_email: 'author2@example.com',
              author_display_name: 'Second Author',
              author_role_slug: 'admin',
              author_role_name: 'Admin',
              created_by_user_id: 'author_1',
              updated_by_user_id: 'editor_1',
              published_by_user_id: null,
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:04:00Z'),
              published_at: null,
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        return undefined
      },
    ])

    await expect(updateContentEntryAuthor(db, 'entry_1', 'author_2', 'editor_1')).resolves.toMatchObject({
      authorUserId: 'author_2',
      author: {
        displayName: 'Second Author',
        roleName: 'Admin',
      },
      updatedByUserId: 'editor_1',
    })
  })

  it('creates drafts, saves body markdown, and publishes a snapshot', async () => {
    const calls: string[] = []
    let entryState: 'created' | 'saved' | 'published' = 'created'
    const db = makeContentFakeDb([
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
            'author_1',
            'author_1',
            'author_1',
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
              author_user_id: 'author_1',
              created_by_user_id: 'author_1',
              updated_by_user_id: 'author_1',
              published_by_user_id: null,
            }],
            rowCount: 1,
          }
        }
        // publishContentEntry: UPDATE ... SET active_version_id=$1 WHERE id=$2
        if (sql.startsWith('update content_entries set status =')) {
          entryState = 'published'
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
              author_user_id: 'author_1',
              created_by_user_id: 'author_1',
              updated_by_user_id: 'publisher_1',
              published_by_user_id: 'publisher_1',
            }],
            rowCount: 1,
          }
        }
        // saveContentEntryDraft: UPDATE ... SET title=$1, slug=$2, ... WHERE id=$7
        if (sql.startsWith('update content_entries')) {
          expect(params).toEqual([
            'Hello',
            'hello',
            '# Hello',
            null,
            'SEO Hello',
            'SEO Description',
            'editor_1',
            'entry_1',
          ])
          entryState = 'saved'
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
              author_user_id: 'author_1',
              created_by_user_id: 'author_1',
              updated_by_user_id: 'editor_1',
              published_by_user_id: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select content_entry_versions.slug as previous_slug')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('select coalesce(max(version_number), 0) + 1')) {
          return { rows: [{ next_version: 1 }], rowCount: 1 }
        }
        if (sql.startsWith('select content_entries.id')) {
          const published = entryState === 'published'
          const saved = entryState === 'saved' || published
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Hello',
              slug: 'hello',
              status: published ? 'published' : 'draft',
              body_markdown: saved ? '# Hello' : '',
              featured_media_id: null,
              seo_title: saved ? 'SEO Hello' : '',
              seo_description: saved ? 'SEO Description' : '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate(
                published
                  ? '2026-05-01T10:02:00Z'
                  : saved
                    ? '2026-05-01T10:01:00Z'
                    : '2026-05-01T10:00:00Z',
              ),
              published_at: published ? rowDate('2026-05-01T10:02:00Z') : null,
              deleted_at: null,
              author_user_id: 'author_1',
              author_email: 'author@example.com',
              author_display_name: 'Author Name',
              author_role_slug: 'editor',
              author_role_name: 'Editor',
              created_by_user_id: 'author_1',
              created_by_email: 'author@example.com',
              created_by_display_name: 'Author Name',
              created_by_role_slug: 'editor',
              created_by_role_name: 'Editor',
              updated_by_user_id: published ? 'publisher_1' : saved ? 'editor_1' : 'author_1',
              updated_by_email: published
                ? 'publisher@example.com'
                : saved
                  ? 'editor@example.com'
                  : 'author@example.com',
              updated_by_display_name: published
                ? 'Publisher Name'
                : saved
                  ? 'Editor Name'
                  : 'Author Name',
              updated_by_role_slug: published ? 'admin' : saved ? 'editor' : 'editor',
              updated_by_role_name: published ? 'Admin' : saved ? 'Editor' : 'Editor',
              published_by_user_id: published ? 'publisher_1' : null,
              published_by_email: published ? 'publisher@example.com' : null,
              published_by_display_name: published ? 'Publisher Name' : null,
              published_by_role_slug: published ? 'admin' : null,
              published_by_role_name: published ? 'Admin' : null,
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
            'publisher_1',
          ])
          return { rows: [], rowCount: 1 }
        }
        return undefined
      },
    ])

    const draft = await createContentEntry(db, {
      id: 'entry_1',
      collectionId: 'posts',
      title: 'Hello',
      slug: 'hello',
    }, 'author_1')
    expect(draft).toMatchObject({
      authorUserId: 'author_1',
      author: {
        displayName: 'Author Name',
        roleName: 'Editor',
      },
      createdByUserId: 'author_1',
      updatedByUserId: 'author_1',
      publishedByUserId: null,
    })

    await saveContentEntryDraft(db, 'entry_1', {
      title: 'Hello',
      slug: 'hello',
      bodyMarkdown: '# Hello',
      featuredMediaId: null,
      seoTitle: 'SEO Hello',
      seoDescription: 'SEO Description',
    }, 'editor_1')
    const result = await publishContentEntry(db, 'entry_1', 'publisher_1')

    expect(result.version.versionNumber).toBe(1)
    expect(result.entry.status).toBe('published')
    expect(result.entry).toMatchObject({
      authorUserId: 'author_1',
      createdByUserId: 'author_1',
      updatedByUserId: 'publisher_1',
      publishedByUserId: 'publisher_1',
    })
    expect(result.version.publishedByUserId).toBe('publisher_1')
    // Verify the insert SQL was emitted with all 9 params
    expect(calls.some((sql) => sql.startsWith('insert into content_entry_versions'))).toBe(true)
    // Template order: SET active_version_id=$1 (versionId) WHERE id=$2 (entryId)
    expect(calls.some((sql) => sql.includes('active_version_id = $1'))).toBe(true)
  })

  it('records a redirect from the previous published slug when publishing a changed slug', async () => {
    const calls: string[] = []
    const db = makeContentFakeDb([
      (sql, params) => {
        calls.push(sql)
        if (sql.startsWith('select content_entries.id')) {
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Post',
              slug: 'post',
              status: 'published',
              body_markdown: '# Post',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:03:00Z'),
              published_at: rowDate('2026-05-01T10:02:00Z'),
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select content_entry_versions.slug as previous_slug')) {
          return {
            rows: [{
              previous_slug: 'untitled',
              previous_route_base: '/posts',
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('select coalesce(max(version_number), 0) + 1')) {
          return { rows: [{ next_version: 2 }], rowCount: 1 }
        }
        if (sql.startsWith('insert into content_entry_versions')) {
          expect(params.slice(1)).toEqual([
            'entry_1',
            2,
            'Post',
            'post',
            '# Post',
            null,
	        '',
	        '',
	        'admin_1',
	      ])
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith('update content_entries set status =')) {
	          // Template order: SET active_version_id=$1, publisher/updater=$2/$3 WHERE id=$4
	          expect(typeof params[0]).toBe('string')  // versionId (nanoid)
	          expect(params[1]).toBe('admin_1')
	          expect(params[2]).toBe('admin_1')
	          expect(params[3]).toBe('entry_1')
          return {
            rows: [{
              id: 'entry_1',
              collection_id: 'posts',
              title: 'Post',
              slug: 'post',
              status: 'published',
              body_markdown: '# Post',
              featured_media_id: null,
              seo_title: '',
              seo_description: '',
              created_at: rowDate('2026-05-01T10:00:00Z'),
              updated_at: rowDate('2026-05-01T10:04:00Z'),
              published_at: rowDate('2026-05-01T10:04:00Z'),
              deleted_at: null,
            }],
            rowCount: 1,
          }
        }
        if (sql.startsWith('insert into content_entry_redirects')) {
          expect(params.slice(1)).toEqual(['posts', '/posts', 'untitled', 'entry_1'])
          return { rows: [], rowCount: 1 }
        }
        return undefined
      },
    ])

    const result = await publishContentEntry(db, 'entry_1', 'admin_1')

    expect(result.version.versionNumber).toBe(2)
    expect(result.entry.slug).toBe('post')
    expect(calls.some((sql) => sql.startsWith('insert into content_entry_redirects'))).toBe(true)
  })

  it('resolves the active published version by collection route and entry slug', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select content_entry_versions.id')) return undefined
        expect(sql).toContain('content_entry_versions.id = content_entries.active_version_id')
        expect(params).toEqual(['/posts', 'hello'])
        return {
          rows: [{
            id: 'version_1',
            entry_id: 'entry_1',
            collection_id: 'posts',
            collection_slug: 'posts',
            collection_route_base: '/posts',
            version_number: 2,
            title: 'Published Hello',
            slug: 'hello',
            body_markdown: 'Published body',
            featured_media_id: null,
            seo_title: 'SEO',
            seo_description: 'Description',
            author_user_id: 'author_1',
            author_display_name: 'Author Name',
            published_by_user_id: 'publisher_1',
            published_by_display_name: 'Publisher Name',
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
      collectionRouteBase: '/posts',
      title: 'Published Hello',
      bodyMarkdown: 'Published body',
      authorUserId: 'author_1',
      authorName: 'Author Name',
      publishedByUserId: 'publisher_1',
      publishedByName: 'Publisher Name',
    })
  })

  it('does not resolve old published slugs after a newer version becomes active', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select content_entry_versions.id')) return undefined
        expect(sql).toContain('content_entry_versions.id = content_entries.active_version_id')
        expect(params).toEqual(['/posts', 'untitled'])
        return { rows: [], rowCount: 0 }
      },
    ])

    await expect(getPublishedContentEntryByRoute(db, '/posts', 'untitled')).resolves.toBeNull()
  })

  it('resolves old published slugs as redirects to the active published slug', async () => {
    const db = makeContentFakeDb([
      (sql, params) => {
        if (!sql.startsWith('select content_entry_redirects.id')) return undefined
        expect(sql).toContain('content_entry_versions.id = target_entries.active_version_id')
        expect(params).toEqual(['/posts', 'untitled'])
        return {
          rows: [{
            id: 'redirect_1',
            from_route_base: '/posts',
            from_slug: 'untitled',
            target_route_base: '/posts',
            target_slug: 'post',
          }],
          rowCount: 1,
        }
      },
    ])

    await expect(getContentEntryRedirectByRoute(db, '/posts', 'untitled')).resolves.toEqual({
      id: 'redirect_1',
      fromPath: '/posts/untitled',
      targetPath: '/posts/post',
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
  it('renders published custom collection entries without a page template', async () => {
    const db = makeContentFakeDb([
      (sql) => {
        if (sql.startsWith('select page_versions.snapshot_json')) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.startsWith('select content_entry_versions.id')) {
          return {
            rows: [{
              id: 'version_1',
              entry_id: 'entry_1',
              collection_id: 'products',
              collection_slug: 'products',
              collection_route_base: '/products',
              version_number: 1,
              title: 'Some product',
              slug: 'some-product',
              body_markdown: 'A product body.',
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
        if (sql.startsWith('select content_entry_redirects.id')) {
          return { rows: [], rowCount: 0 }
        }
        return undefined
      },
    ])

    const res = await handleServerRequest(new Request('http://localhost/products/some-product'), { db })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('<h1>Some product</h1>')
    expect(html).toContain('<p>A product body.</p>')
  })
})
