/**
 * Architecture gates for the cms.pages plugin API surface.
 *
 * Verifies that all four sync-points for a new permission are present:
 * the PLUGIN_PERMISSION_VALUES list, the capability matrix, the permission
 * aliases builder, and the docs table. Also checks that the SDK type surface
 * exposes the three methods.
 */

import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

async function read(relative: string): Promise<string> {
  return await readFile(join(ROOT, relative), 'utf-8')
}

describe('cms.pages plugin API surface', () => {
  it('ServerPluginApi.cms exposes pages.list, pages.republish, and pages.republishAll', async () => {
    const source = await read('src/core/plugin-sdk/types.ts')
    // The pages surface must be declared inside the cms object
    expect(source).toContain('pages.list')
    expect(source).toContain('pages.republish')
    expect(source).toContain('pages.republishAll')
  })

  it('cms.pages.read and cms.pages.publish are in PLUGIN_PERMISSION_VALUES', async () => {
    const source = await read('src/core/plugin-sdk/types.ts')
    expect(source).toContain("'cms.pages.read'")
    expect(source).toContain("'cms.pages.publish'")
  })

  it('cms.pages.read and cms.pages.publish are in PLUGIN_CAPABILITIES', async () => {
    const source = await read('src/core/plugin-sdk/capabilities.ts')
    expect(source).toContain("permission: 'cms.pages.read'")
    expect(source).toContain("permission: 'cms.pages.publish'")
  })

  it('network.outbound is in PLUGIN_CAPABILITIES (was missing — regression guard)', async () => {
    const source = await read('src/core/plugin-sdk/capabilities.ts')
    expect(source).toContain("permission: 'network.outbound'")
  })

  it('cmsPagesRead and cmsPagesPublish aliases exist in builders/permissions.ts', async () => {
    const source = await read('src/core/plugin-sdk/builders/permissions.ts')
    expect(source).toContain("cmsPagesRead: 'cms.pages.read'")
    expect(source).toContain("cmsPagesPublish: 'cms.pages.publish'")
  })

  it('docs/plugins/permissions.md documents cms.pages.read and cms.pages.publish', async () => {
    const source = await read('docs/plugins/permissions.md')
    expect(source).toContain('cms.pages.read')
    expect(source).toContain('cms.pages.publish')
  })

  it('cms.pages.list/republish/republishAll are in ALLOWED_API_TARGETS', async () => {
    const source = await read('server/plugins/protocol/targets.ts')
    expect(source).toContain("'cms.pages.list'")
    expect(source).toContain("'cms.pages.republish'")
    expect(source).toContain("'cms.pages.republishAll'")
  })

  it('quickjs BOOTSTRAP_SOURCE exposes api.cms.pages.{list,republish,republishAll}', async () => {
    const source = await read('server/plugins/quickjs/bootstrap/api.ts')
    expect(source).toContain("'cms.pages.list'")
    expect(source).toContain("'cms.pages.republish'")
    expect(source).toContain("'cms.pages.republishAll'")
    // Must be inside the pages: { ... } block of __buildApi
    expect(source).toContain('pages: {')
  })

  it('apiDispatch.ts dispatches all three cms.pages cases', async () => {
    const source = await read('server/plugins/host/apiDispatch.ts')
    expect(source).toContain("case 'cms.pages.list':")
    expect(source).toContain("case 'cms.pages.republish':")
    expect(source).toContain("case 'cms.pages.republishAll':")
  })
})
