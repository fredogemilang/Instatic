import { describe, expect, it } from 'bun:test'
import { buildCmsRuntimePreview, resolveCmsRuntimeDependencies } from '@core/persistence/cmsRuntime'

describe('CMS runtime client', () => {
  it('posts dependency manifests to the runtime resolve endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const dependencyLock = {
      version: 1,
      packages: {},
      updatedAt: 123,
    }

    const result = await resolveCmsRuntimeDependencies(
      { dependencies: { 'canvas-confetti': '^1.9.3' }, devDependencies: {} },
      async (input, init) => {
        calls.push({ input, init })
        return new Response(JSON.stringify({ dependencyLock }), { status: 200 })
      },
    )

    expect(result).toEqual(dependencyLock)
    expect(calls[0]).toMatchObject({
      input: '/api/cms/runtime/dependencies/resolve',
      init: { method: 'POST', credentials: 'include' },
    })
    expect(calls[0].init?.body).toBe(JSON.stringify({
      packageJson: { dependencies: { 'canvas-confetti': '^1.9.3' }, devDependencies: {} },
    }))
  })

  it('posts site preview requests to the runtime preview endpoint', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
    const result = await buildCmsRuntimePreview(
      {
        site: { id: 'site_1' },
        pageId: 'page_1',
        breakpointId: 'mobile',
        templateContext: { entryStack: [] },
      },
      async (input, init) => {
        calls.push({ input, init })
        return new Response(JSON.stringify({
          html: '<!DOCTYPE html>',
          assets: [],
          runtimeAssets: { scripts: [] },
          diagnostics: [],
        }), { status: 200 })
      },
    )

    expect(result.html).toContain('<!DOCTYPE html>')
    expect(calls[0]).toMatchObject({
      input: '/api/cms/runtime/preview',
      init: { method: 'POST', credentials: 'include' },
    })
    expect(calls[0].init?.body).toBe(JSON.stringify({
      site: { id: 'site_1' },
      pageId: 'page_1',
      breakpointId: 'mobile',
      templateContext: { entryStack: [] },
    }))
  })
})
