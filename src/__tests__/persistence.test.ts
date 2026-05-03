/**
 * Persistence tests — validateSite (Constraint #230)
 *
 * These tests cover the pure validation layer, which is the most critical
 * safety gate (Constraint #230: validate before store hydration).
 */

import { describe, it, expect } from 'bun:test'
import { validateSite, SiteValidationError } from '../core/persistence/validate'
import type { SiteDocument } from '../core/page-tree/types'

// ── Helpers ─────────────────────────────────────────────────────────────────

function validSite(): SiteDocument {
  return {
    id: 'proj-1',
    name: 'Test SiteDocument',
    createdAt: 1000,
    updatedAt: 2000,
    files: [],
    classes: {},
    visualComponents: [],
    packageJson: { dependencies: {}, devDependencies: {} },
    runtime: {
      dependencyLock: { version: 1, packages: {}, updatedAt: 0 },
      scripts: {},
    },
    breakpoints: [
      { id: 'desktop', label: 'Desktop', width: 1440, icon: 'monitor' },
    ],
    settings: {
      colorTokens: {},
      shortcuts: {},
    },
    pages: [
      {
        id: 'page-1',
        title: 'Home',
        slug: 'index',
        rootNodeId: 'root',
        nodes: {
          root: {
            id: 'root',
            moduleId: 'base.root',
            props: {},
            children: ['heading-1'],
            breakpointOverrides: {},
            classIds: [],
          },
          'heading-1': {
            id: 'heading-1',
            moduleId: 'base.text',
            props: { text: 'Hello' },
            children: [],
            breakpointOverrides: { mobile: { text: 'Hi' } },
            classIds: [],
          },
        },
      },
    ],
  }
}

// ── Happy path ───────────────────────────────────────────────────────────────

describe('validateSite — happy path', () => {
  it('accepts a valid site and returns a typed SiteDocument', () => {
    const input = validSite()
    const result = validateSite(input)
    expect(result.id).toBe('proj-1')
    expect(result.name).toBe('Test SiteDocument')
    expect(result.pages).toHaveLength(1)
    expect(result.pages[0].nodes['heading-1'].props.text).toBe('Hello')
  })

  it('preserves breakpoint overrides on nodes', () => {
    const result = validateSite(validSite())
    expect(result.pages[0].nodes['heading-1'].breakpointOverrides.mobile).toEqual({ text: 'Hi' })
  })

  it('preserves optional fields (label, locked, hidden) when present', () => {
    const p = validSite()
    p.pages[0].nodes.root.label = 'My Root'
    p.pages[0].nodes.root.locked = true
    p.pages[0].nodes.root.hidden = false
    const result = validateSite(p)
    expect(result.pages[0].nodes.root.label).toBe('My Root')
    expect(result.pages[0].nodes.root.locked).toBe(true)
    expect(result.pages[0].nodes.root.hidden).toBe(false)
  })

  it('omits optional fields when absent', () => {
    const result = validateSite(validSite())
    expect(result.pages[0].nodes.root.label).toBeUndefined()
    expect(result.pages[0].nodes.root.locked).toBeUndefined()
  })

  it('accepts settings with all optional fields', () => {
    const p = validSite()
    p.settings.language = 'fr'
    p.settings.metaTitle = 'My Site'
    const result = validateSite(p)
    expect(result.settings.language).toBe('fr')
    expect(result.settings.metaTitle).toBe('My Site')
  })

  it('fills defaults for missing settings sub-fields', () => {
    const p = validSite()
    // @ts-expect-error — intentionally malformed
    delete p.settings.colorTokens
    const result = validateSite(p as unknown)
    expect(result.settings.colorTokens).toEqual({})
    expect(result.settings.shortcuts).toEqual({})
  })

  it('ignores unknown extra keys (forward-compat)', () => {
    const p = { ...validSite(), _futureField: 'foo' }
    expect(() => validateSite(p)).not.toThrow()
  })
})

// ── Structural errors ────────────────────────────────────────────────────────

describe('validateSite — rejects invalid data', () => {
  it('throws SiteValidationError for null', () => {
    expect(() => validateSite(null)).toThrow(SiteValidationError)
  })

  it('throws for missing site.id', () => {
    const p = validSite() as Record<string, unknown>
    delete p.id
    expect(() => validateSite(p)).toThrow(SiteValidationError)
    try { validateSite(p) } catch (e) {
      expect((e as SiteValidationError).path).toBe('site.id')
    }
  })

  it('throws for non-string site.name', () => {
    const p = { ...validSite(), name: 42 }
    expect(() => validateSite(p as unknown)).toThrow(SiteValidationError)
  })

  it('throws for non-array site.pages', () => {
    const p = { ...validSite(), pages: 'not-an-array' }
    expect(() => validateSite(p as unknown)).toThrow(SiteValidationError)
  })

  it('throws for empty pages array', () => {
    const p = { ...validSite(), pages: [] }
    expect(() => validateSite(p as unknown)).toThrow(SiteValidationError)
    try { validateSite(p as unknown) } catch (e) {
      expect((e as SiteValidationError).path).toBe('site.pages')
    }
  })

  it('throws when rootNodeId is missing from nodes', () => {
    const p = validSite()
    p.pages[0].rootNodeId = 'nonexistent-id'
    expect(() => validateSite(p)).toThrow(SiteValidationError)
    try { validateSite(p) } catch (e) {
      expect((e as SiteValidationError).path).toBe('site.pages[0].rootNodeId')
    }
  })

  it('throws for invalid public page slugs', () => {
    const p = validSite()
    p.pages[0].slug = 'About Us'

    expect(() => validateSite(p)).toThrow(SiteValidationError)
    try { validateSite(p) } catch (e) {
      expect((e as SiteValidationError).path).toBe('site.pages[0].slug')
    }
  })

  it('throws for reserved public page slugs', () => {
    const p = validSite()
    p.pages[0].slug = 'admin'

    expect(() => validateSite(p)).toThrow(SiteValidationError)
    try { validateSite(p) } catch (e) {
      expect((e as SiteValidationError).message).toContain('reserved')
    }
  })

  it('throws for duplicate public page slugs', () => {
    const p = validSite()
    p.pages.push({ ...structuredClone(p.pages[0]), id: 'page-2', title: 'Duplicate Home' })

    expect(() => validateSite(p)).toThrow(SiteValidationError)
    try { validateSite(p) } catch (e) {
      expect((e as SiteValidationError).message).toContain('duplicate slug')
    }
  })

  it('throws for non-array node.children', () => {
    const p = validSite()
    ;(p.pages[0].nodes.root as Record<string, unknown>).children = 'bad'
    expect(() => validateSite(p as unknown)).toThrow(SiteValidationError)
  })

  it('throws for non-numeric createdAt', () => {
    const p = { ...validSite(), createdAt: 'not-a-number' }
    expect(() => validateSite(p as unknown)).toThrow(SiteValidationError)
  })

  it('throws for missing node.moduleId', () => {
    const p = validSite()
    const node = p.pages[0].nodes.root as Record<string, unknown>
    delete node.moduleId
    expect(() => validateSite(p as unknown)).toThrow(SiteValidationError)
  })

  it('provides a descriptive path in the error', () => {
    const p = validSite()
    ;(p.pages[0].nodes['heading-1'] as Record<string, unknown>).id = 99
    try {
      validateSite(p as unknown)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SiteValidationError)
      expect((e as SiteValidationError).path).toContain('heading-1')
      expect((e as SiteValidationError).path).toContain('.id')
    }
  })
})

// ── Richtext prop sanitization (Task #302 / Constraint #299) ─────────────────
//
// validateSite() must sanitize all richtext-keyed props before returning.
// This closes the tampered-site-file XSS vector: a site saved before the
// DOMPurify write boundary was in place (or modified in storage) would carry
// unsanitized richtext that would reach the publisher's pass-through unguarded.

describe('validateSite — richtext prop sanitization on hydration', () => {
  it('strips <script> from a richtext-keyed prop', () => {
    const p = validSite()
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).richtext =
      '<b>hello</b><script>alert(1)</script>'
    const result = validateSite(p)
    const sanitized = result.pages[0].nodes['heading-1'].props.richtext as string
    expect(sanitized).not.toContain('<script>')
    expect(sanitized).not.toContain('alert(1)')
    expect(sanitized).toContain('<b>hello</b>')
  })

  it('strips onerror attribute from richtext html prop', () => {
    const p = validSite()
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).html =
      '<img src="x" onerror="alert(1)">'
    const result = validateSite(p)
    const sanitized = result.pages[0].nodes['heading-1'].props.html as string
    expect(sanitized).not.toContain('onerror')
    expect(sanitized).not.toContain('alert(1)')
  })

  it('strips javascript: href from richtext props', () => {
    const p = validSite()
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).richtext =
      '<a href="javascript:alert(1)">click me</a>'
    const result = validateSite(p)
    const sanitized = result.pages[0].nodes['heading-1'].props.richtext as string
    expect(sanitized).not.toContain('javascript:')
  })

  it('sanitizes props with richtext suffix (bodyHtml, contentRichtext)', () => {
    const p = validSite()
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).bodyHtml =
      '<p>safe</p><script>evil()</script>'
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).contentRichtext =
      '<em>ok</em><iframe src="evil.com"></iframe>'
    const result = validateSite(p)
    expect(result.pages[0].nodes['heading-1'].props.bodyHtml as string).not.toContain('<script>')
    expect(result.pages[0].nodes['heading-1'].props.contentRichtext as string).not.toContain('<iframe>')
  })

  it('preserves safe formatting HTML in richtext props', () => {
    const p = validSite()
    const safe = '<p><strong>Bold</strong> and <em>italic</em> <a href="https://example.com">link</a></p>'
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).richtext = safe
    const result = validateSite(p)
    const sanitized = result.pages[0].nodes['heading-1'].props.richtext as string
    expect(sanitized).toContain('<strong>Bold</strong>')
    expect(sanitized).toContain('<em>italic</em>')
  })

  it('leaves non-richtext props untouched', () => {
    const p = validSite()
    // 'text', 'label', 'fontSize' are not richtext keys — must not be altered
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).text = 'Hello World'
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).fontSize = 24
    const result = validateSite(p)
    expect(result.pages[0].nodes['heading-1'].props.text).toBe('Hello World')
    expect(result.pages[0].nodes['heading-1'].props.fontSize).toBe(24)
  })

  it('handles empty richtext prop without error', () => {
    const p = validSite()
    ;(p.pages[0].nodes['heading-1'].props as Record<string, unknown>).richtext = ''
    const result = validateSite(p)
    expect(result.pages[0].nodes['heading-1'].props.richtext).toBe('')
  })
})

describe('validateSite — site package manifest', () => {
  it('preserves safe site dependencies and filters unsafe package names', () => {
    const p = {
      ...validSite(),
      packageJson: {
        dependencies: {
          three: '^0.184.0',
          'three; rm -rf /': '^1.0.0',
        },
        devDependencies: {
          '@types/react': '^18.2.0',
        },
      },
    }
    const result = validateSite(p as unknown)
    expect(result.packageJson?.dependencies.three).toBe('^0.184.0')
    expect(result.packageJson?.dependencies['three; rm -rf /']).toBeUndefined()
    expect(result.packageJson?.devDependencies['@types/react']).toBe('^18.2.0')
  })

  it('preserves normalized site runtime dependency lock and script config', () => {
    const p = {
      ...validSite(),
      runtime: {
        dependencyLock: {
          version: 1,
          packages: {
            'canvas-confetti': {
              name: 'canvas-confetti',
              requested: '^1.9.3',
              version: '1.9.3',
              resolvedAt: 123,
            },
            'bad;pkg': {
              name: 'bad;pkg',
              requested: '*',
              version: '1.0.0',
              resolvedAt: 123,
            },
          },
          updatedAt: 123,
        },
        scripts: {
          'script-1': {
            enabled: true,
            runInCanvas: false,
            placement: 'head',
            timing: 'idle',
            scope: { type: 'pages', pageIds: ['page-1'] },
            priority: 25,
          },
        },
      },
    }

    const result = validateSite(p as unknown)
    expect(result.runtime?.dependencyLock.packages['canvas-confetti']?.version).toBe('1.9.3')
    expect(result.runtime?.dependencyLock.packages['bad;pkg']).toBeUndefined()
    expect(result.runtime?.scripts['script-1']).toEqual({
      enabled: true,
      runInCanvas: false,
      placement: 'head',
      timing: 'idle',
      scope: { type: 'pages', pageIds: ['page-1'] },
      priority: 25,
    })
  })
})

// ── classes round-trip ────────────────────────────────────────────────────────

describe('validateSite — classes field', () => {
  it('preserves generated framework class lock metadata', () => {
    const p = validSite()
    p.classes = {
      'framework:color:primary-token:base:text': {
        id: 'framework:color:primary-token:base:text',
        name: 'text-primary',
        styles: { color: 'var(--primary)' },
        breakpointStyles: {},
        generated: {
          origin: 'framework',
          family: 'color',
          sourceId: 'primary-token',
          utility: 'text',
          tokenName: 'primary',
          locked: true,
        },
        createdAt: 1,
        updatedAt: 2,
      },
    }

    const result = validateSite(p)
    expect(result.classes['framework:color:primary-token:base:text'].generated).toEqual({
      origin: 'framework',
      family: 'color',
      sourceId: 'primary-token',
      utility: 'text',
      tokenName: 'primary',
      locked: true,
    })
  })
})

describe('validateSite — framework color settings', () => {
  it('preserves structured color framework settings', () => {
    const p = validSite()
    p.settings.framework = {
      colors: {
        tokens: [
          {
            id: 'primary-token',
            category: 'Brand',
            slug: 'Primary Color',
            lightValue: 'hsla(238, 100%, 62%, 1)',
            darkValue: 'hsla(238, 100%, 42%, 1)',
            darkModeEnabled: true,
            generateUtilities: {
              text: true,
              background: true,
              border: true,
              fill: true,
            },
            generateTransparent: true,
            generateShades: { enabled: true, count: 4 },
            generateTints: { enabled: false, count: 0 },
            order: 0,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    }

    const result = validateSite(p)
    expect(result.settings.framework?.colors.tokens[0]).toMatchObject({
      id: 'primary-token',
      category: 'Brand',
      slug: 'primary-color',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      darkValue: 'hsla(238, 100%, 42%, 1)',
      darkModeEnabled: true,
      generateUtilities: {
        text: true,
        background: true,
        border: true,
        fill: true,
      },
      generateTransparent: true,
      generateShades: { enabled: true, count: 4 },
      generateTints: { enabled: false, count: 0 },
    })
  })
})
