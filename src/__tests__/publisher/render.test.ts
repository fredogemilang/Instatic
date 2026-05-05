import { describe, it, expect } from 'bun:test'
import {
  escapeHtml,
  escapeProps,
  isSafeUrl,
  renderNode,
  publishPage,
  type RenderContext,
} from '@core/publisher/render'
import type { ModuleDefinition } from '@core/module-engine/types'
import {
  frameworkColorClassId,
  generateFrameworkColorUtilityClasses,
} from '@core/framework/colors'
import { makeModule, makeRegistry, makePage, makeSite } from './helpers'

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes & < > " \'', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    )
    expect(escapeHtml('say "hello" & \'world\'')).toBe(
      'say &quot;hello&quot; &amp; &#x27;world&#x27;',
    )
  })

  it('passes through safe plain text unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World')
    expect(escapeHtml('foo bar 42')).toBe('foo bar 42')
  })

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// isSafeUrl
// ---------------------------------------------------------------------------

describe('isSafeUrl', () => {
  it('blocks javascript: URLs', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false) // leading whitespace
    expect(isSafeUrl('JAVASCRIPT:alert(1)')).toBe(false)   // case insensitive
    expect(isSafeUrl('\tjavascript:void(0)')).toBe(false)  // tab prefix
  })

  it('blocks vbscript: URLs', () => {
    expect(isSafeUrl('vbscript:MsgBox(1)')).toBe(false)
    expect(isSafeUrl('VBSCRIPT:MsgBox(1)')).toBe(false)
  })

  it('blocks javascript: with internal tab/newline/CR (WHATWG bypass, Advisory A)', () => {
    expect(isSafeUrl('java\tscript:alert(1)')).toBe(false)
    expect(isSafeUrl('java\nscript:alert(1)')).toBe(false)
    expect(isSafeUrl('java\rscript:alert(1)')).toBe(false)
    expect(isSafeUrl('javascript\t:')).toBe(false)
  })

  it('allows https, http, relative, and anchor URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true)
    expect(isSafeUrl('http://example.com/path?q=1')).toBe(true)
    expect(isSafeUrl('/relative/path')).toBe(true)
    expect(isSafeUrl('#section')).toBe(true)
    expect(isSafeUrl('')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// escapeProps
// ---------------------------------------------------------------------------

describe('escapeProps', () => {
  it('HTML-escapes plain string props', () => {
    const result = escapeProps({ text: '<b>bold</b> & "quoted"' })
    expect(result.text).toBe('&lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;')
  })

  it('replaces javascript: href with #', () => {
    expect(escapeProps({ href: 'javascript:alert(1)' }).href).toBe('#')
  })

  it('replaces javascript: src with #', () => {
    expect(escapeProps({ src: 'javascript:evil()' }).src).toBe('#')
  })

  it('allows safe href/src values', () => {
    expect(escapeProps({ href: 'https://example.com' }).href).toBe('https://example.com')
    expect(escapeProps({ src: '/images/logo.png' }).src).toBe('/images/logo.png')
  })

  it('passes through richtext/html props unescaped', () => {
    const html = '<p><b>bold</b></p>'
    expect(escapeProps({ richtext: html }).richtext).toBe(html)
    expect(escapeProps({ html }).html).toBe(html)
    expect(escapeProps({ bodyHtml: html }).bodyHtml).toBe(html) // suffix match
  })

  it('passes through non-string values unchanged', () => {
    const input = { level: 2, visible: true, count: 42, arr: [1, 2] }
    expect(escapeProps(input)).toEqual(input)
  })

  it('handles URL-suffix keys (imageUrl, linkHref)', () => {
    expect(escapeProps({ imageUrl: 'javascript:x' }).imageUrl).toBe('#')
    expect(escapeProps({ imageUrl: '/img.jpg' }).imageUrl).toBe('/img.jpg')
    expect(escapeProps({ linkHref: 'javascript:x' }).linkHref).toBe('#')
  })
})

// ---------------------------------------------------------------------------
// renderNode
// ---------------------------------------------------------------------------

describe('renderNode', () => {
  const headingDef: ModuleDefinition<{ text: string; level: number }> = makeModule(
    'base.text',
    {
      canHaveChildren: false,
      render: (props, _children) => ({
        html: `<h${props.level}>${props.text}</h${props.level}>`,
        css: 'h1,h2,h3,h4,h5,h6 { font-family: sans-serif; }',
      }),
    },
  )

  const containerDef: ModuleDefinition<{ className: string }> = makeModule(
    'base.container',
    {
      canHaveChildren: true,
      render: (props, children) => ({
        html: `<div class="${props.className}">${children.join('')}</div>`,
        css: '.pb-container { display: block; }',
      }),
    },
  )

  const registry = makeRegistry({
    'base.text': headingDef,
    'base.container': containerDef,
  })
  const site = makeSite()

  function ctx(page: ReturnType<typeof makePage>): RenderContext {
    const cssMap = new Map<string, string>()
    return { page, site, registry, breakpointId: undefined, cssMap }
  }

  it('renders a leaf node', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hello', level: 1 } },
    })
    const c = ctx(page)
    expect(renderNode('root', c)).toBe('<h1>Hello</h1>')
  })

  it('renders nested children bottom-up', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: 'wrapper' },
        children: ['c1', 'c2'],
      },
      c1: { moduleId: 'base.text', props: { text: 'A', level: 2 } },
      c2: { moduleId: 'base.text', props: { text: 'B', level: 3 } },
    })
    const c = ctx(page)
    expect(renderNode('root', c)).toBe(
      '<div class="wrapper"><h2>A</h2><h3>B</h3></div>',
    )
  })

  it('deduplicates CSS by moduleId — 3 heading nodes → 1 CSS entry', () => {
    const page = makePage({
      root: {
        moduleId: 'base.container',
        props: { className: '' },
        children: ['h1', 'h2', 'h3'],
      },
      h1: { moduleId: 'base.text', props: { text: 'A', level: 1 } },
      h2: { moduleId: 'base.text', props: { text: 'B', level: 2 } },
      h3: { moduleId: 'base.text', props: { text: 'C', level: 3 } },
    })
    const cssMap = new Map<string, string>()
    renderNode('root', { page, site, registry, breakpointId: undefined, cssMap })
    expect(cssMap.size).toBe(2) // base.text + base.container, NOT 4
    expect(cssMap.get('base.text')).toBe('h1,h2,h3,h4,h5,h6 { font-family: sans-serif; }')
  })

  it('returns empty string for missing nodeId', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: {} } })
    const c = ctx(page)
    expect(renderNode('nonexistent', c)).toBe('')
  })

  it('emits HTML comment for unknown moduleId', () => {
    const page = makePage({
      root: { moduleId: 'unknown.widget', props: {} },
    })
    const c = ctx(page)
    const html = renderNode('root', c)
    expect(html).toContain('<!-- pb: unknown module')
    expect(html).toContain('unknown.widget')
  })

  // Security tests (Constraint #211)
  it('XSS: escapes <script> in text props before render()', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { text: '<script>alert(1)</script>', level: 1 },
      },
    })
    const c = ctx(page)
    const html = renderNode('root', c)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('XSS: blocks javascript: href before render()', () => {
    const linkDef = makeModule('base.link', {
      render: (props, _) => ({
        html: `<a href="${(props as { href: string }).href}">click</a>`,
      }),
    })
    const reg = makeRegistry({ 'base.link': linkDef })
    const page = makePage({
      root: { moduleId: 'base.link', props: { href: 'javascript:alert(1)' } },
    })
    const cssMap = new Map<string, string>()
    const html = renderNode('root', { page, site, registry: reg, breakpointId: undefined, cssMap })
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  it('applies breakpoint overrides when breakpointId is provided', () => {
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { text: 'Desktop', level: 1 },
        breakpointOverrides: { mobile: { text: 'Mobile', level: 2 } },
      },
    })
    const cssMap = new Map<string, string>()

    const htmlDesktop = renderNode('root', {
      page, site, registry, breakpointId: undefined, cssMap,
    })
    const htmlMobile = renderNode('root', {
      page, site, registry, breakpointId: 'mobile', cssMap,
    })

    expect(htmlDesktop).toBe('<h1>Desktop</h1>')
    expect(htmlMobile).toBe('<h2>Mobile</h2>')
  })

  // Regression — parent classes must not bleed into descendants
  // ─────────────────────────────────────────────────────────────────────────────
  // Pre-fix bug: injectClassIntoRootElement used a non-anchored regex that
  // matched the FIRST `class="..."` anywhere in the rendered HTML. When the
  // root tag had no class but a nested descendant did, the parent's class was
  // wrongly prepended to that descendant. With three levels (e.g. outer
  // container with `bg`, inner container with `row`, paragraph with
  // `text-primary`), all three classes piled up on the deepest element:
  //   <p class="bg row text-primary">…</p>
  // The fix anchors the operation to the FIRST opening element tag.
  describe('class injection — parent classes never bleed into descendants', () => {
    // Bare-output stand-ins for base.container / base.text — no default class
    const bareContainerDef = makeModule('base.container', {
      canHaveChildren: true,
      render: (_, children) => ({ html: `<div>${children.join('')}</div>` }),
    })
    const bareTextDef = makeModule('base.text', {
      render: (props, _) => ({
        html: `<p>${(props as { text: string }).text}</p>`,
      }),
    })
    const bareReg = makeRegistry({
      'base.container': bareContainerDef,
      'base.text': bareTextDef,
    })

    function bareCtx(page: ReturnType<typeof makePage>): RenderContext {
      const cssMap = new Map<string, string>()
      return { page, site, registry: bareReg, breakpointId: undefined, cssMap }
    }

    it('two-level: parent class lands on parent root, not on its classed child', () => {
      const siteDoc = makeSite({
        classes: {
          'row-id':    { id: 'row-id',    name: 'row',          styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 },
          'tprim-id':  { id: 'tprim-id',  name: 'text-primary', styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 },
        },
      })
      const page = makePage({
        root: {
          moduleId: 'base.container',
          classIds: ['row-id'],
          children: ['p1'],
        },
        p1: { moduleId: 'base.text', props: { text: 'Hi' }, classIds: ['tprim-id'] },
      })
      const cssMap = new Map<string, string>()
      const html = renderNode('root', {
        page, site: siteDoc, registry: bareReg, breakpointId: undefined, cssMap,
      })

      expect(html).toBe('<div class="row"><p class="text-primary">Hi</p></div>')
      // Parent class never appears on the descendant
      expect(html).not.toMatch(/<p[^>]*class="[^"]*row/)
    })

    it('three-level: each class lands on its own element (Vamos a la playa repro)', () => {
      const siteDoc = makeSite({
        classes: {
          'bg-id':    { id: 'bg-id',    name: 'bg',           styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 },
          'row-id':   { id: 'row-id',   name: 'row',          styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 },
          'tprim-id': { id: 'tprim-id', name: 'text-primary', styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 },
        },
      })
      const page = makePage({
        outer: {
          moduleId: 'base.container',
          classIds: ['bg-id'],
          children: ['inner'],
        },
        inner: {
          moduleId: 'base.container',
          classIds: ['row-id'],
          children: ['p1'],
        },
        p1: { moduleId: 'base.text', props: { text: 'Vamos a la playa' }, classIds: ['tprim-id'] },
      }, 'outer')
      const cssMap = new Map<string, string>()
      const html = renderNode('outer', {
        page, site: siteDoc, registry: bareReg, breakpointId: undefined, cssMap,
      })

      expect(html).toBe(
        '<div class="bg"><div class="row"><p class="text-primary">Vamos a la playa</p></div></div>',
      )
      // Each ancestor class stays on its own element
      expect(html).not.toMatch(/<p[^>]*class="[^"]*\bbg\b/)
      expect(html).not.toMatch(/<p[^>]*class="[^"]*\brow\b/)
      expect(html).not.toMatch(/<div class="row"[^>]*>[\s\S]*<div[^>]*class="[^"]*\bbg\b/)
    })

    it('multi-class on root: prepends to existing class on the same element', () => {
      // This locks in the original Case-1 behaviour for the case it was meant
      // to handle: a module render() that already emits a class on the root.
      const classedDef = makeModule('base.classed', {
        render: () => ({ html: '<button class="pb-btn">Click</button>' }),
      })
      const reg = makeRegistry({ 'base.classed': classedDef })
      const siteDoc = makeSite({
        classes: {
          'cta-id': { id: 'cta-id', name: 'cta', styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 },
        },
      })
      const page = makePage({
        root: { moduleId: 'base.classed', classIds: ['cta-id'] },
      })
      const cssMap = new Map<string, string>()
      const html = renderNode('root', {
        page, site: siteDoc, registry: reg, breakpointId: undefined, cssMap,
      })

      expect(html).toBe('<button class="cta pb-btn">Click</button>')
    })

    it('html starting with a comment: skips the comment and classes the first element', () => {
      const wrappedDef = makeModule('base.wrapped', {
        render: () => ({ html: '<!-- marker --><section><p>x</p></section>' }),
      })
      const reg = makeRegistry({ 'base.wrapped': wrappedDef })
      const siteDoc = makeSite({
        classes: {
          'h-id': { id: 'h-id', name: 'hero', styles: {}, breakpointStyles: {}, createdAt: 0, updatedAt: 0 },
        },
      })
      const page = makePage({
        root: { moduleId: 'base.wrapped', classIds: ['h-id'] },
      })
      const cssMap = new Map<string, string>()
      const html = renderNode('root', {
        page, site: siteDoc, registry: reg, breakpointId: undefined, cssMap,
      })

      expect(html).toBe('<!-- marker --><section class="hero"><p>x</p></section>')
    })
  })
})

// ---------------------------------------------------------------------------
// publishPage
// ---------------------------------------------------------------------------

describe('publishPage', () => {
  const headingDef = makeModule('base.text', {
    render: (props, _) => ({
      html: `<h1>${(props as { text: string }).text}</h1>`,
      css: 'h1 { color: black; }',
    }),
  })
  const registry = makeRegistry({ 'base.text': headingDef })
  const site = makeSite()

  it('produces a complete DOCTYPE html document', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hello' } },
    })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<html lang="en">')
    expect(html).toContain('<title>Test Page</title>')
    expect(html).toContain('<h1>Hello</h1>')
  })

  it('filename is index.html for slug "index"', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = 'index'
    const { filename } = publishPage(page, site, registry)
    expect(filename).toBe('index.html')
  })

  it('filename is derived from slug for non-index pages', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = 'about-us'
    const { filename } = publishPage(page, site, registry)
    expect(filename).toBe('about-us.html')
  })

  it('injects deduplicated CSS — heading CSS appears exactly once', () => {
    const containerDef = makeModule('base.container', {
      canHaveChildren: true,
      render: (_, children) => ({ html: `<div>${children.join('')}</div>` }),
    })
    const reg = makeRegistry({
      'base.container': containerDef,
      'base.text': headingDef,
    })
    const page = makePage({
      root: { moduleId: 'base.container', props: {}, children: ['h1', 'h2', 'h3'] },
      h1: { moduleId: 'base.text', props: { text: 'A' } },
      h2: { moduleId: 'base.text', props: { text: 'B' } },
      h3: { moduleId: 'base.text', props: { text: 'C' } },
    })
    const { html } = publishPage(page, site, reg)
    const count = (html.match(/h1 \{ color: black; \}/g) ?? []).length
    expect(count).toBe(1) // deduplicated — not 3
  })

  it('does not emit ghost design tokens on a fresh project', () => {
    // A brand-new project has no framework Color tokens, no framework
    // typography, no framework spacing, and no fonts. The published
    // `framework.css` body must therefore be empty — no `:root {}` block,
    // no leftover `--color-*` declarations from any legacy default. The
    // legacy `site.settings.colorTokens` field has been removed entirely;
    // all color tokens now flow through `framework.colors` (managed by
    // the editor's Colors panel).
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).not.toContain('--color-primary')
    expect(html).not.toContain('--color-secondary')
    expect(html).not.toContain('--color-accent')
    expect(html).not.toContain('--color-surface')
    expect(html).not.toContain('--color-on-surface')
  })

  it('ships the publisher reset before module CSS so canvas and front end agree', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    // Reset rules — verify both core box-model and body baseline reach the page.
    expect(html).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
    expect(html).toContain(':where(*) { margin: 0; padding: 0; }')
    expect(html).toContain('font-family: system-ui')
    // Cascade order: reset must appear before module CSS so module rules win.
    const resetIndex = html.indexOf(':where(*, *::before, *::after)')
    const moduleIndex = html.indexOf('h1 { color: black; }')
    expect(resetIndex).toBeGreaterThan(-1)
    expect(moduleIndex).toBeGreaterThan(resetIndex)
  })

  // ─── External CSS mode (per-site bundle served at /_pb/css/) ──────────────

  it('emits three <link> tags pointing at the site bundle in external mode', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const cssBundle = {
      reset: { bundle: 'reset' as const, filename: 'reset-aaaaaaaaaaaa.css', hash: 'aaaaaaaaaaaa', content: ':where(*) { margin: 0; }' },
      framework: { bundle: 'framework' as const, filename: 'framework-bbbbbbbbbbbb.css', hash: 'bbbbbbbbbbbb', content: ':root { --x: 1; }' },
      style: { bundle: 'style' as const, filename: 'style-cccccccccccc.css', hash: 'cccccccccccc', content: '.foo { color: red; }' },
    }
    const { html } = publishPage(page, site, registry, {
      cssEmission: 'external',
      cssBundle,
    })

    expect(html).toContain('<link rel="stylesheet" href="/_pb/css/reset-aaaaaaaaaaaa.css">')
    expect(html).toContain('<link rel="stylesheet" href="/_pb/css/framework-bbbbbbbbbbbb.css">')
    expect(html).toContain('<link rel="stylesheet" href="/_pb/css/style-cccccccccccc.css">')

    // No inline <style> block for site-wide CSS in external mode.
    expect(html).not.toMatch(/<style>\s*\n[^<]*:where\(\*\)/)

    // Cascade order: reset → framework → style (last loaded wins ties).
    const resetIdx = html.indexOf('reset-aaaaaaaaaaaa.css')
    const frameworkIdx = html.indexOf('framework-bbbbbbbbbbbb.css')
    const styleIdx = html.indexOf('style-cccccccccccc.css')
    expect(resetIdx).toBeLessThan(frameworkIdx)
    expect(frameworkIdx).toBeLessThan(styleIdx)
  })

  it('skips empty bundle files in external mode (no zero-byte <link> requests)', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const cssBundle = {
      reset: { bundle: 'reset' as const, filename: 'reset-aaaaaaaaaaaa.css', hash: 'aaaaaaaaaaaa', content: ':where(*) { margin: 0; }' },
      // Empty framework + style on a fresh site (no framework, no classes).
      framework: { bundle: 'framework' as const, filename: 'framework-bbbbbbbbbbbb.css', hash: 'bbbbbbbbbbbb', content: '' },
      style: { bundle: 'style' as const, filename: 'style-cccccccccccc.css', hash: 'cccccccccccc', content: '' },
    }
    const { html } = publishPage(page, site, registry, {
      cssEmission: 'external',
      cssBundle,
    })

    expect(html).toContain('reset-aaaaaaaaaaaa.css')
    expect(html).not.toContain('framework-bbbbbbbbbbbb.css')
    expect(html).not.toContain('style-cccccccccccc.css')
  })

  it('uses a custom cssAssetBaseUrl when provided', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const cssBundle = {
      reset: { bundle: 'reset' as const, filename: 'reset-aaaaaaaaaaaa.css', hash: 'aaaaaaaaaaaa', content: 'x' },
      framework: { bundle: 'framework' as const, filename: 'framework-bbbbbbbbbbbb.css', hash: 'bbbbbbbbbbbb', content: 'x' },
      style: { bundle: 'style' as const, filename: 'style-cccccccccccc.css', hash: 'cccccccccccc', content: 'x' },
    }
    const { html } = publishPage(page, site, registry, {
      cssEmission: 'external',
      cssBundle,
      cssAssetBaseUrl: 'https://cdn.example.com/css/',
    })
    expect(html).toContain('href="https://cdn.example.com/css/reset-aaaaaaaaaaaa.css"')
  })

  it('throws when external mode is requested without a bundle', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    expect(() => publishPage(page, site, registry, { cssEmission: 'external' })).toThrow(
      'cssEmission "external" requires options.cssBundle',
    )
  })

  it('inline mode (default) still emits a <style> block and no link tags', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('<style>')
    expect(html).not.toMatch(/<link\s+rel="stylesheet"\s+href="\/_pb\/css\//)
  })

  it('injects framework color variables and used generated utility CSS', () => {
    const colors = {
      tokens: [
        {
          id: 'primary-token',
          category: 'Brand',
          slug: 'primary',
          lightValue: 'hsla(238, 100%, 62%, 1)',
          darkValue: 'hsla(238, 100%, 42%, 1)',
          darkModeEnabled: true,
          generateUtilities: {
            text: true,
            background: false,
            border: false,
            fill: false,
          },
          generateTransparent: false,
          generateShades: { enabled: false, count: 0 },
          generateTints: { enabled: false, count: 0 },
          order: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    }
    const textClassId = frameworkColorClassId('primary-token', 'base', 'text')
    const page = makePage({
      root: {
        moduleId: 'base.text',
        props: { text: 'Hi' },
        classIds: [textClassId],
      },
    })
    const proj = makeSite({
      pages: [page],
      settings: {
        ...makeSite().settings,
        framework: { colors },
      },
      classes: generateFrameworkColorUtilityClasses(colors),
    })

    const { html } = publishPage(page, proj, registry)

    expect(html).toContain(':root.theme-alt')
    expect(html).toContain(':root.theme-default .theme-inverted')
    expect(html).not.toContain('theme-dark')
    expect(html).not.toContain('theme-light')
    expect(html).toContain('--primary: hsla(238, 100%, 62%, 1);')
    expect(html).toContain('--primary: hsla(238, 100%, 42%, 1);')
    expect(html).toContain('.text-primary')
    expect(html).toContain('color: var(--primary);')
    expect(html).not.toContain('cf-theme')
  })

  it('includes font import link when fontImportUrl is set', () => {
    const proj = makeSite({
      settings: {
        ...makeSite().settings,
        fontImportUrl: 'https://fonts.googleapis.com/css2?family=Inter',
      },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).toContain('fonts.googleapis.com')
    expect(html).toContain('rel="stylesheet"')
  })

  it('CSP: every published page includes Content-Security-Policy meta tag (Constraint #227)', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'CSP test' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('http-equiv="Content-Security-Policy"')
    expect(html).toContain("script-src 'none'")
    expect(html).toContain("default-src 'self'")
  })

  it('CSS injection: </style> in module CSS is stripped before injection (Constraint #228)', () => {
    // The attack: a module returns CSS containing </style> to escape the <style> block
    // and inject a <script>. After sanitization, </style> is removed, so the <script>
    // text remains INSIDE the <style> block where it is harmless raw text (not parsed as HTML).
    const evilModuleDef = makeModule('evil.module', {
      render: (_props, _children) => ({
        html: '<p>hello</p>',
        css: 'p { color: red; } </style><script>alert(1)</script><style>',
      }),
    })
    const reg = makeRegistry({ 'evil.module': evilModuleDef })
    const page = makePage({ root: { moduleId: 'evil.module', props: {} } })
    const { html } = publishPage(page, site, reg)
    // The dangerous sequence is </style> immediately followed by something outside style.
    // After sanitization the </style> from the module is gone — only the real closing tag remains.
    expect(html).not.toMatch(/<\/style>\s*<script/)
    // The style block closes properly at the end of <head>
    expect(html).toContain('</style>\n</head>')
  })

  it('CSS injection: </style> in design token value is stripped (Advisory C)', () => {
    // Token values are sanitized via sanitizeCssTokenValue(); {} and </style> are removed.
    const proj = makeSite({
      settings: {
        ...makeSite().settings,
        colorTokens: { '--evil': 'red} </style><script>alert(1)</script><style> :root{' },
      },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    // </style> was stripped — style block does not close prematurely
    expect(html).not.toMatch(/<\/style>\s*<script/)
    expect(html).toContain('</style>\n</head>')
    // { and } stripped — cannot escape :root {} block to inject rules
    expect(html).not.toContain('display: none')
  })

  it('URL validation: javascript: in faviconUrl is dropped (Advisory B)', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, faviconUrl: 'javascript:alert(1)' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).not.toContain('javascript:')
    // No <link rel="icon"> emitted when faviconUrl is unsafe
    expect(html).not.toContain('rel="icon"')
  })

  it('URL validation: javascript: in fontImportUrl is dropped (Advisory B)', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, fontImportUrl: 'javascript:alert(1)' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('rel="stylesheet"')
  })

  // WCAG 2.1 AA SC 3.1.1 — lang attribute (Constraint #317 / UX review)
  it('lang="en" by default when site.settings.language is unset', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, site, registry)
    expect(html).toContain('<html lang="en">')
  })

  it('lang attribute reflects site.settings.language when set', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, language: 'fr' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Bonjour' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).toContain('<html lang="fr">')
  })

  it('XSS: malicious language value is HTML-escaped in lang attribute', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, language: '"><script>alert(1)</script>' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  // ZIP filename / path-traversal safety (Constraint #229 / CWE-22)
  it('slug with path traversal sequences produces a safe filename', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = '../../etc/passwd'
    const { filename } = publishPage(page, site, registry)
    // slugToFilename whitelist-strips all non [a-z0-9-] chars — slashes and dots become dashes
    expect(filename).not.toContain('..')
    expect(filename).not.toContain('/')
    expect(filename).not.toContain('\\')
    expect(filename).toMatch(/^[a-z0-9-]+\.html$/)
  })

  it('slug with null bytes produces a safe filename', () => {
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    page.slug = 'about\x00page'
    const { filename } = publishPage(page, site, registry)
    expect(filename).not.toContain('\x00')
    expect(filename).toMatch(/^[a-z0-9-]+\.html$/)
  })

  it('has zero editor artifacts in output', () => {
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Published' } },
    })
    const { html } = publishPage(page, site, registry)
    expect(html).not.toContain('data-reactroot')
    expect(html).not.toContain('data-testid')
    expect(html).not.toContain('__editor')
    expect(html).not.toContain('zustand')
  })

  it('uses site metaTitle for <title> when set', () => {
    const proj = makeSite({
      settings: { ...makeSite().settings, metaTitle: 'My Site — Home' },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).toContain('<title>My Site — Home</title>')
  })

  it('XSS: escapes metaTitle with special chars', () => {
    const proj = makeSite({
      settings: {
        ...makeSite().settings,
        metaTitle: '<script>alert(1)</script>',
      },
    })
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    const { html } = publishPage(page, proj, registry)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
