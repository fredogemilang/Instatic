import { describe, expect, it } from 'bun:test'
import type { DbClient, DbResult } from '../../../server/cms/db'
import type { PublishedPageSnapshot } from '../../../server/cms/publishRepository'
import { renderPublishedSnapshot } from '../../../server/cms/publicRenderer'
import { handleServerRequest } from '../../../server/router'

function snapshot(text: string): PublishedPageSnapshot {
  return {
    cmsSnapshotVersion: 1,
    pageId: 'page_home',
    site: {
      id: 'project_1',
      name: 'Public Site',
      pages: [
        {
          id: 'page_home',
          title: 'Home',
          slug: 'index',
          rootNodeId: 'root',
          nodes: {
            root: {
              id: 'root',
              moduleId: 'base.root',
              props: {},
              breakpointOverrides: {},
              children: ['text_1'],
            },
            text_1: {
              id: 'text_1',
              moduleId: 'base.text',
              props: { text, tag: 'h1' },
              breakpointOverrides: {},
              children: [],
            },
          },
        },
      ],
      files: [],
      visualComponents: [],
      breakpoints: [
        { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
      ],
      settings: {
        metaTitle: 'Public Site',
        colorTokens: {},
        shortcuts: {},
      },
      classes: {},
      createdAt: 1000,
      updatedAt: 2000,
    },
  }
}

function makeFakeDb(
  activeSnapshot: PublishedPageSnapshot | null,
  runtimeAssets: Record<string, unknown>[] = [],
): DbClient {
  const handle = async <Row extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<DbResult<Row>> => {
    // Reconstruct a parameterized SQL string for pattern matching.
    const sql = strings.reduce<string>((acc, str, i) => (i === 0 ? str : `${acc}$${i}${str}`), '')
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    // getPublishedRuntimeAsset — values[0]=publicPath
    if (normalized.includes('select public_path, content_type, content_bytes')) {
      const row = runtimeAssets.find((asset) => asset.public_path === values[0])
      return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 }
    }
    // getPublishedPageBySlug / publishRepository queries — return active snapshot
    if (normalized.includes('select page_versions.snapshot_json')) {
      return {
        rows: activeSnapshot ? [{ snapshot_json: activeSnapshot } as Row] : [],
        rowCount: activeSnapshot ? 1 : 0,
      }
    }
    // getSetupStatus — public-rendering tests assume CMS is already set up
    if (normalized.includes('count(*) as count from site')) {
      return { rows: [{ count: 1 } as unknown as Row], rowCount: 1 }
    }
    if (normalized.includes('count(*) as count from admin_users')) {
      return { rows: [{ count: 1 } as unknown as Row], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }

  handle.transaction = async <T>(cb: (tx: DbClient) => Promise<T>): Promise<T> =>
    cb(handle as unknown as DbClient)

  return handle as DbClient
}

describe('public rendering', () => {
  it('renders complete HTML from a published snapshot', async () => {
    const snap = snapshot('Visible to public')
    const html = await renderPublishedSnapshot(snap, { db: makeFakeDb(snap) })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Visible to public')
    expect(html).toContain('<title>Public Site</title>')
  })

  it('injects stored runtime asset manifests when rendering a published snapshot', async () => {
    const published = snapshot('Runtime page')
    published.runtimeAssets = {
      scripts: [
        {
          fileId: 'entry',
          src: '/_pb/assets/version_1/entries/entry.js',
          placement: 'body-end',
          timing: 'dom-ready',
          priority: 10,
        },
      ],
    }

    const html = await renderPublishedSnapshot(published, { db: makeFakeDb(published) })

    expect(html).toContain("script-src 'self'")
    expect(html).toContain('/_pb/assets/version_1/entries/entry.js')
  })

  it('serves / from the active published index snapshot', async () => {
    const res = await handleServerRequest(new Request('http://localhost/'), {
      db: makeFakeDb(snapshot('Homepage')),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('Homepage')
  })

  it('serves immutable published runtime assets by public path', async () => {
    const res = await handleServerRequest(new Request('http://localhost/_pb/assets/version_1/entries/entry.js'), {
      db: makeFakeDb(null, [
        {
          public_path: '/_pb/assets/version_1/entries/entry.js',
          content_type: 'text/javascript; charset=utf-8',
          content_bytes: new TextEncoder().encode('console.log("runtime")'),
        },
      ]),
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe('console.log("runtime")')
  })

  it('returns 404 when there is no active published snapshot', async () => {
    const res = await handleServerRequest(new Request('http://localhost/'), {
      db: makeFakeDb(null),
    })

    expect(res.status).toBe(404)
  })

  it('emits external CSS <link> tags pointing at the per-site bundle', async () => {
    const snap = snapshot('Hello')
    const html = await renderPublishedSnapshot(snap, { db: makeFakeDb(snap) })
    expect(html).toMatch(/<link rel="stylesheet" href="\/_pb\/css\/reset-[a-f0-9]{12}\.css">/)
    // No inline reset block — site-wide CSS lives in the external bundle.
    expect(html).not.toContain(':where(*, *::before, *::after)')
  })

  it('serves the reset bundle file from /_pb/css/<filename> with immutable cache', async () => {
    const published = snapshot('Hello')
    // First request the page to discover the current bundle filenames.
    const pageRes = await handleServerRequest(new Request('http://localhost/'), {
      db: makeFakeDb(published),
    })
    const pageHtml = await pageRes.text()
    const resetMatch = pageHtml.match(/href="(\/_pb\/css\/reset-[a-f0-9]{12}\.css)"/)
    expect(resetMatch).not.toBeNull()

    // Now fetch the bundle.
    const cssRes = await handleServerRequest(
      new Request(`http://localhost${resetMatch![1]}`),
      { db: makeFakeDb(published) },
    )
    expect(cssRes.status).toBe(200)
    expect(cssRes.headers.get('content-type')).toContain('text/css')
    expect(cssRes.headers.get('cache-control')).toContain('immutable')
    expect(cssRes.headers.get('cache-control')).toContain('max-age=31536000')
    const cssBody = await cssRes.text()
    expect(cssBody).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
  })

  it('returns 404 for stale CSS hashes so cached HTML refetches the page', async () => {
    const cssRes = await handleServerRequest(
      new Request('http://localhost/_pb/css/reset-deadbeefdead.css'),
      { db: makeFakeDb(snapshot('Hello')) },
    )
    expect(cssRes.status).toBe(404)
  })

  it('returns 404 for malformed CSS bundle paths', async () => {
    const cssRes = await handleServerRequest(
      new Request('http://localhost/_pb/css/whatever.css'),
      { db: makeFakeDb(snapshot('Hello')) },
    )
    expect(cssRes.status).toBe(404)
  })
})
