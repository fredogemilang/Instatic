/**
 * Smoke test for the showcase example plugin (TypeScript-first migration).
 *
 * Imports the plugin's pb-plugin.config.ts directly so we verify the
 * SDK output shape — including the new React-based admin app dashboard —
 * stays in lockstep with the host's runtime types.
 */
import { describe, expect, it } from 'bun:test'

const showcaseConfigPath = '../../../examples/plugins/showcase/pb-plugin.config'

describe('showcase example plugin (TypeScript source)', () => {
  it('definePlugin produces a valid PluginManifest with every SDK surface', async () => {
    const { default: definition } = await import(showcaseConfigPath) as {
      default: import('@core/plugin-sdk').PluginDefinition
    }

    expect(definition.manifest.id).toBe('acme.showcase')
    expect(definition.manifest.permissions).toContain('admin.navigation')
    expect(definition.manifest.permissions).toContain('cms.hooks')
    expect(definition.manifest.permissions).toContain('modules.register')
    expect(definition.manifest.permissions).toContain('frontend.assets')
    expect(definition.manifest.permissions).toContain('visualComponents.register')
    expect(definition.manifest.adminPages.map((p) => p.id)).toEqual(['dashboard', 'events'])
  })

  it('admin app entrypoint is a JSX file using definePluginAdminApp + host-ui', async () => {
    const { readFile } = await import('node:fs/promises')
    const path = '../../../examples/plugins/showcase/admin/dashboard.tsx'
    const url = new URL(path, import.meta.url)
    const text = await readFile(url, 'utf-8')
    expect(text).toContain('definePluginAdminApp')
    expect(text).toContain('@pagebuilder/host-ui')
    expect(text).toContain('@pagebuilder/host-hooks')
    // Real React component, not the legacy hyperscript shim.
    expect(text).toContain("import { useCallback, useEffect, useState } from 'react'")
    expect(text).not.toMatch(/document\.createElement\(/)
  })

  it('every canvas module renders escaped HTML when given its defaults', async () => {
    const { default: definition } = await import(showcaseConfigPath) as {
      default: import('@core/plugin-sdk').PluginDefinition
    }
    expect(definition.modules.length).toBeGreaterThanOrEqual(2)
    for (const mod of definition.modules) {
      const out = mod.render(mod.defaults, [])
      expect(typeof out.html).toBe('string')
      expect(out.html.length).toBeGreaterThan(0)
      const hostile = mod.render(
        { ...mod.defaults, heading: '<script>alert(1)</script>' },
        [],
      )
      expect(hostile.html).not.toContain('<script>alert(1)</script>')
    }
  })

  it('pack ships exactly one Visual Component with a namespaced id', async () => {
    const { default: definition } = await import(showcaseConfigPath) as {
      default: import('@core/plugin-sdk').PluginDefinition
    }
    if (!definition.pack) throw new Error('Pack missing')
    expect(definition.pack.visualComponents).toHaveLength(1)
    expect(definition.pack.visualComponents[0].id).toBe('acme.showcase/hero')
    expect(definition.pack.classes[0].id).toBe('acme.showcase/hero-root')
    expect(/^[A-Za-z_][A-Za-z0-9_-]*$/.test(definition.pack.classes[0].name)).toBe(true)
  })
})
