/**
 * Architecture Gate — Site-transfer export filters
 *
 * Verifies that `handleExportRoute` correctly applies the `tables`, `rowIds`,
 * `includeMedia`, and `includeSite` filter options for both GET (query string)
 * and POST (JSON body) requests.
 *
 * Uses a real in-memory SQLite database with all migrations applied. Auth is
 * seeded directly via repositories (no HTTP round-trip to /setup).
 *
 * @see server/handlers/cms/export.ts
 * @see src/core/data/bundleSchema.ts
 * @see docs/plans/2026-05-19-site-transfer-ux.md
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteClient } from '../../../server/db/sqlite'
import { runMigrations } from '../../../server/db/runMigrations'
import { sqliteMigrations } from '../../../server/db/migrations-sqlite'
import { saveDraftSite } from '../../../server/repositories/site'
import { createUser } from '../../../server/repositories/users'
import { createSession } from '../../../server/auth/sessions'
import { createMediaAsset } from '../../../server/repositories/media'
import {
  createSessionToken,
  hashSessionToken,
  SESSION_COOKIE_NAME,
  sessionExpiry,
} from '../../../server/auth/tokens'
import { createDataTable } from '../../../server/repositories/data/tables'
import { createDataRow } from '../../../server/repositories/data/rows'
import { handleExportRoute } from '../../../server/handlers/cms/export'
import { parseValue } from '@core/utils/typeboxHelpers'
import { SiteBundleSchema } from '@core/data/bundleSchema'
import type { DbClient } from '../../../server/db/client'
import type { SiteShell } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Minimal valid site shell for seeding
// ---------------------------------------------------------------------------

const TEST_SHELL: SiteShell = {
  id: 'default',
  name: 'Transfer Test Site',
  breakpoints: [],
  settings: { shortcuts: {} },
  styleRules: {},
  files: [],
  packageJson: { dependencies: {}, devDependencies: {} },
  runtime: {
    dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
    scripts: {},
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

// ---------------------------------------------------------------------------
// seedAuth — seeds site + owner user + session; returns the cookie string
// ---------------------------------------------------------------------------

async function seedAuth(db: DbClient): Promise<string> {
  await saveDraftSite(db, TEST_SHELL)
  await createUser(db, {
    id: 'test-owner',
    email: 'owner@export.test',
    displayName: 'Test Owner',
    passwordHash: 'placeholder-hash',
    roleId: 'owner',
    allowOwnerRole: true,
  })
  const token = createSessionToken()
  await createSession(db, {
    idHash: await hashSessionToken(token),
    userId: 'test-owner',
    expiresAt: sessionExpiry(),
    ipAddress: null,
    userAgent: null,
  })
  return `${SESSION_COOKIE_NAME}=${token}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGetRequest(path: string, cookie: string): Request {
  const req = new Request(`http://localhost${path}`, { method: 'GET' })
  // The `cookie` header is a forbidden header per WHATWG Fetch spec and is
  // stripped by Bun's Request constructor. Set it after construction instead.
  req.headers.set('cookie', cookie)
  return req
}

function makePostRequest(path: string, cookie: string, body: unknown): Request {
  const req = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  req.headers.set('cookie', cookie)
  return req
}

// ---------------------------------------------------------------------------
// Shared state set up in beforeAll
// ---------------------------------------------------------------------------

let db: DbClient
let cookie: string
let post1Id: string
let post2Id: string
let pageId: string
let customRowId: string
const CUSTOM_TABLE_ID = 'my-data-test'

beforeAll(async () => {
  db = createSqliteClient(':memory:')
  await runMigrations(db, sqliteMigrations)
  cookie = await seedAuth(db)

  // Create 1 custom table ("My Data")
  await createDataTable(db, {
    id: CUSTOM_TABLE_ID,
    name: 'My Data',
    slug: 'my-data-test',
    kind: 'data',
    singularLabel: 'My Item',
    pluralLabel: 'My Data',
  })

  // Seed 2 rows in posts
  const p1 = await createDataRow(db, {
    tableId: 'posts',
    cells: { title: 'Post One', slug: 'post-one' },
    slug: 'post-one',
  })
  const p2 = await createDataRow(db, {
    tableId: 'posts',
    cells: { title: 'Post Two', slug: 'post-two' },
    slug: 'post-two',
  })
  post1Id = p1.id
  post2Id = p2.id

  // Seed 1 row in pages
  const pg = await createDataRow(db, {
    tableId: 'pages',
    cells: { title: 'Home Page', slug: 'home', body: { nodes: {}, rootNodeId: 'root' } },
    slug: 'home',
  })
  pageId = pg.id

  // Seed 1 row in My Data
  const cr = await createDataRow(db, {
    tableId: CUSTOM_TABLE_ID,
    cells: { name: 'Custom Item One' },
    slug: '',
  })
  customRowId = cr.id
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleExportRoute — GET no filters', () => {
  test('returns all 4 rows across all tables', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(200)

    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(4)
  })

  test('includes all tables (system + custom)', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    const tableIds = bundle.tables.map((t) => t.id)
    expect(tableIds).toContain('posts')
    expect(tableIds).toContain('pages')
    expect(tableIds).toContain('components')
    expect(tableIds).toContain(CUSTOM_TABLE_ID)
  })

  test('site shell is present by default', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeDefined()
    expect(bundle.site!.name).toBe('Transfer Test Site')
  })

  test('sourceSiteName is set from the site shell name', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.sourceSiteName).toBe('Transfer Test Site')
  })

  test('media is absent (not requested)', async () => {
    const req = makeGetRequest('/admin/api/cms/export', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.media).toBeUndefined()
  })
})

describe('handleExportRoute — GET ?tables=posts', () => {
  test('returns only the posts table', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('posts')
  })

  test('returns only the 2 posts rows', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(2)
    expect(bundle.rows.every((r) => r.tableId === 'posts')).toBe(true)
  })

  test('site is still present when only tables are filtered', async () => {
    const req = makeGetRequest('/admin/api/cms/export?tables=posts', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeDefined()
  })
})

describe('handleExportRoute — POST { tables: [{ tableId: "posts", rowIds: [id1, id2] }] }', () => {
  test('returns only the 2 specified rows', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'posts', rowIds: [post1Id, post2Id] }],
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    const returnedIds = bundle.rows.map((r) => r.id)
    expect(returnedIds).toContain(post1Id)
    expect(returnedIds).toContain(post2Id)
    expect(returnedIds).not.toContain(pageId)
    expect(returnedIds).not.toContain(customRowId)
    expect(bundle.rows.length).toBe(2)
  })

  test('only the selected table is included (others are excluded)', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'posts', rowIds: [post1Id, post2Id] }],
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    const tableIds = bundle.tables.map((t) => t.id)
    expect(tableIds).toContain('posts')
    expect(tableIds).not.toContain('pages')
    expect(tableIds).not.toContain(CUSTOM_TABLE_ID)
  })
})

describe('handleExportRoute — GET ?includeMedia=1', () => {
  test('media array is present (empty when no assets seeded and uploadsDir set)', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeMedia=1', cookie)
    // Pass a temp uploads dir so the handler enters the media-loading branch
    const res = await handleExportRoute(req, db, { uploadsDir: '/tmp/test-uploads-export' })
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    // No assets seeded → empty array, but the field must be present
    expect(Array.isArray(bundle.media)).toBe(true)
    expect(bundle.media!.length).toBe(0)
  })
})

describe('handleExportRoute — GET ?includeSite=0', () => {
  test('site shell is absent', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeSite=0', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeUndefined()
  })

  test('sourceSiteName is still set even when includeSite=0', async () => {
    const req = makeGetRequest('/admin/api/cms/export?includeSite=0', cookie)
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.sourceSiteName).toBe('Transfer Test Site')
  })
})

describe('handleExportRoute — POST { tables: ["pages"], includeSite: false }', () => {
  test('returns only the pages table', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages' }],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('pages')
  })

  test('returns only the 1 pages row', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages' }],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(1)
    expect(bundle.rows[0].tableId).toBe('pages')
    expect(bundle.rows[0].id).toBe(pageId)
  })

  test('site is absent when includeSite: false', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages' }],
      includeSite: false,
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.site).toBeUndefined()
  })
})

describe('handleExportRoute — POST { tables: [{ tableId: "pages", rowIds: [bogusId] }] }', () => {
  test('returns empty rows when the row subset matches nothing', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages', rowIds: ['completely-bogus-row-id-that-does-not-exist'] }],
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    expect(bundle.rows.length).toBe(0)
  })

  test('still includes the selected table structure (a subset keeps its table)', async () => {
    const req = makePostRequest('/admin/api/cms/export', cookie, {
      tables: [{ tableId: 'pages', rowIds: ['completely-bogus-row-id-that-does-not-exist'] }],
    })
    const res = await handleExportRoute(req, db)
    const body = JSON.parse(await res!.text())
    const bundle = parseValue(SiteBundleSchema, body)

    // New model: a table named in `tables` is exported (its structure) even
    // when its row subset is empty — only tables NOT listed are dropped.
    expect(bundle.tables.length).toBe(1)
    expect(bundle.tables[0].id).toBe('pages')
  })
})

describe('handleExportRoute — auth', () => {
  test('returns 401 when no session cookie', async () => {
    // Deliberately no cookie set
    const req = new Request('http://localhost/admin/api/cms/export', { method: 'GET' })
    const res = await handleExportRoute(req, db)
    expect(res!.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// Estimate endpoint — must equal the real download size exactly, because both
// run the same selection logic. The estimate just skips reading media bytes
// and sizes them analytically (Base64 length) instead.
// ---------------------------------------------------------------------------

async function estimateBytes(path: string, body: unknown, cookieStr: string, opts?: { uploadsDir?: string }): Promise<number> {
  const res = await handleExportRoute(makePostRequest(path, cookieStr, body), db, opts)
  expect(res!.status).toBe(200)
  const parsed = JSON.parse(await res!.text()) as { bytes: number }
  return parsed.bytes
}

describe('handleExportRoute — POST /export/estimate', () => {
  test('estimate equals the real download byte length exactly (no media)', async () => {
    const dl = await handleExportRoute(makePostRequest('/admin/api/cms/export', cookie, {}), db)
    const realBytes = Buffer.byteLength(await dl!.text(), 'utf8')

    const bytes = await estimateBytes('/admin/api/cms/export/estimate', {}, cookie)
    expect(bytes).toBe(realBytes)
  })

  test('estimate drops the shell cost when includeSite is false, still matching the real download', async () => {
    const withSite = await estimateBytes('/admin/api/cms/export/estimate', { includeSite: true }, cookie)
    const withoutSite = await estimateBytes('/admin/api/cms/export/estimate', { includeSite: false }, cookie)
    expect(withoutSite).toBeLessThan(withSite)

    const realNoSite = await handleExportRoute(
      makePostRequest('/admin/api/cms/export', cookie, { includeSite: false }),
      db,
    )
    expect(withoutSite).toBe(Buffer.byteLength(await realNoSite!.text(), 'utf8'))
  })

  test('requires a session (401 without a cookie)', async () => {
    const req = new Request('http://localhost/admin/api/cms/export/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const res = await handleExportRoute(req, db)
    expect(res!.status).toBe(401)
  })
})

describe('handleExportRoute — POST /export/estimate with embedded media', () => {
  test('estimate equals the real download byte length exactly, including Base64 media bytes', async () => {
    const mediaDb = createSqliteClient(':memory:')
    await runMigrations(mediaDb, sqliteMigrations)
    const mediaCookie = await seedAuth(mediaDb)

    const uploadsDir = await mkdtemp(join(tmpdir(), 'instatic-export-estimate-'))
    try {
      // Seed one media asset whose bytes live on disk. 5000 raw bytes → a
      // Base64 payload that isn't a clean multiple of 3 (exercises padding).
      const fileBytes = Buffer.alloc(5000, 7)
      await writeFile(join(uploadsDir, 'seed.bin'), fileBytes)
      await createMediaAsset(mediaDb, {
        id: 'asset-1',
        filename: 'seed.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: fileBytes.length,
        storagePath: 'seed.bin',
        publicPath: '/uploads/seed.bin',
        uploadedByUserId: null,
        storageAdapterId: '',
        externallyHosted: false,
      })

      const dl = await handleExportRoute(
        makePostRequest('/admin/api/cms/export', mediaCookie, { includeMedia: true }),
        mediaDb,
        { uploadsDir },
      )
      const realBytes = Buffer.byteLength(await dl!.text(), 'utf8')

      const estRes = await handleExportRoute(
        makePostRequest('/admin/api/cms/export/estimate', mediaCookie, { includeMedia: true }),
        mediaDb,
        { uploadsDir },
      )
      const { bytes } = JSON.parse(await estRes!.text()) as { bytes: number }

      expect(bytes).toBe(realBytes)
      // Sanity: media actually dominated (the asset's bytes are present).
      expect(bytes).toBeGreaterThan(5000)
    } finally {
      await rm(uploadsDir, { recursive: true, force: true })
    }
  })
})
