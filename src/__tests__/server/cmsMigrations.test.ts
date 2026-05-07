import { describe, expect, it } from 'bun:test'
import { pgMigrations } from '../../../server/db/migrations-pg'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { SYSTEM_ROLES } from '../../../server/auth/capabilities'

describe('CMS migrations', () => {
  it('creates the required CMS tables', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).toContain('create table if not exists site')
    expect(sql).toContain('create table if not exists users')
    expect(sql).toContain('create table if not exists roles')
    expect(sql).toContain('create table if not exists sessions')
    expect(sql).toContain('create table if not exists audit_events')
    expect(sql).toContain('create table if not exists pages')
    expect(sql).toContain('create table if not exists page_versions')
    expect(sql).toContain('create table if not exists media_assets')
    expect(sql).toContain('create table if not exists published_runtime_assets')
  })

  it('stores draft and published page documents as jsonb', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).toContain('draft_document_json jsonb not null')
    expect(sql).toContain('snapshot_json jsonb not null')
  })

  it('stores page sort order for reconstructing the editor draft', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).toContain('sort_order integer not null default 0')
  })

  it('stores ownership metadata for pages, content, media, and published versions', () => {
    const pgSql = pgMigrations.map((m) => m.sql).join('\n')
    const sqliteSql = sqliteMigrations.map((m) => m.sql).join('\n')

    for (const sql of [pgSql, sqliteSql]) {
      expect(sql).toContain('owner_user_id text references users(id) on delete set null')
      expect(sql).toContain('created_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('updated_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('author_user_id text references users(id) on delete set null')
      expect(sql).toContain('published_by_user_id text references users(id) on delete set null')
      expect(sql).toContain('uploaded_by_user_id text references users(id) on delete set null')
    }

    expect(pgSql).not.toContain('published_by text references users(id)')
    expect(sqliteSql).not.toContain('published_by text references users(id)')
  })

  it('does not keep retired single-admin schema names', () => {
    const sql = pgMigrations.map((m) => m.sql).join('\n')
    expect(sql).not.toContain('admin_users')
    expect(sql).not.toContain('admin_user_id')
    expect(sql).not.toContain('site_singleton')
  })

  it('seeds the expected system roles in both dialects', () => {
    const pgSql = pgMigrations.map((m) => m.sql).join('\n')
    const sqliteSql = sqliteMigrations.map((m) => m.sql).join('\n')
    for (const role of SYSTEM_ROLES) {
      expect(pgSql).toContain(`'${role.slug}'`)
      expect(sqliteSql).toContain(`'${role.slug}'`)
      for (const capability of role.capabilities) {
        expect(pgSql).toContain(capability)
        expect(sqliteSql).toContain(capability)
      }
    }
  })
})
