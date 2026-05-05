/**
 * Base Module Conformance Tests
 *
 * Runs the Module Conformance Suite against every base module.
 * If any base module fails the conformance suite, it cannot be merged (Guidelines #172).
 *
 * How to add a new base module to this suite:
 *   1. Import the module definition
 *   2. Call: runModuleConformanceSuite(MyModule)
 *
 * Additional module-specific tests (unique behaviour, edge cases) go below
 * the conformance suite calls in dedicated describe blocks.
 */

import { describe, it, expect } from 'bun:test'
import { existsSync } from 'fs'
import React from 'react'
import { render as renderReact } from '@testing-library/react'
import './matchers'  // Register toBeCleanHTML

import { runModuleConformanceSuite, renderModule, withBannedGlobals } from './helpers'
import { escapeProps } from '../core/publisher/render'

// ---------------------------------------------------------------------------
// Import base modules (self-register into global registry on import)
// ---------------------------------------------------------------------------

// Module bootstrap files are `.ts` (no JSX) — editor components live in
// sibling `*Editor.tsx` files so React Fast Refresh can hot-patch them
// without re-running registry.registerOrReplace().
import { TextModule } from '../modules/base/text'
import { ButtonModule } from '../modules/base/button'
import { ContainerModule } from '../modules/base/container'
import { ImageModule } from '../modules/base/image'
import { VideoModule } from '../modules/base/video'
import { ListModule } from '../modules/base/list'
import { LinkModule } from '../modules/base/link'
import { BodyModule } from '../modules/base/body'
import { VisualComponentRefModule } from '../modules/base/visualComponentRef'
import { SlotOutletModule } from '../modules/base/slotOutlet'

// ---------------------------------------------------------------------------
// Run the full conformance suite for every canonical base module (7 total)
// Context #338 — Canonical Base Module List
// ---------------------------------------------------------------------------

runModuleConformanceSuite(TextModule)
runModuleConformanceSuite(ButtonModule)
runModuleConformanceSuite(ContainerModule)
runModuleConformanceSuite(ImageModule)
runModuleConformanceSuite(VideoModule)
runModuleConformanceSuite(ListModule)
runModuleConformanceSuite(LinkModule)
runModuleConformanceSuite(VisualComponentRefModule)
runModuleConformanceSuite(SlotOutletModule)

describe('base module registration', () => {
  it('only imports available production base modules', async () => {
    const baseIndex = await Bun.file('src/modules/base/index.ts').text()

    expect(baseIndex).not.toContain("import './columns'")
    expect(baseIndex).not.toContain("import './spacer'")
    expect(baseIndex).not.toContain("import './divider'")
    expect(baseIndex).not.toContain("import './demoCard'")
    expect(baseIndex).not.toContain("import './demoScene'")
    expect(baseIndex).not.toContain("import './heading'")
    expect(baseIndex).not.toContain("import './paragraph'")

    // Component system modules — registered and shipped
    expect(baseIndex).toContain("import './visualComponentRef'")
    expect(baseIndex).toContain("import './slotOutlet'")
  })

  it('does not keep retired module directories around', () => {
    for (const retiredPath of [
      'src/modules/base/columns',
      'src/modules/base/spacer',
      'src/modules/base/divider',
      'src/modules/base/demoCard',
      'src/modules/base/demoScene',
      'src/modules/base/heading',
      'src/modules/base/paragraph',
    ]) {
      expect(existsSync(retiredPath)).toBe(false)
    }
  })

  it('keeps visual styling out of all base module schemas', () => {
    // All base module settings should be content/structural, not visual/CSS.
    // Visual styling is handled via class assignment and the CSS editor.
    for (const mod of [
      BodyModule,
      ContainerModule,
      TextModule,
      ListModule,
      ImageModule,
      VideoModule,
      ButtonModule,
      LinkModule,
      VisualComponentRefModule,
      SlotOutletModule,
    ]) {
      // No module should declare CSS-only props as module schema fields.
      const cssOnlyPropNames = ['backgroundColor', 'color', 'fontSize', 'padding', 'margin', 'border']
      for (const propName of cssOnlyPropNames) {
        expect(Object.keys(mod.schema)).not.toContain(propName)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// base.text — unified text module replacement
// ---------------------------------------------------------------------------

describe('base.text — unified text module', () => {
  it('is the only registered base typography module', async () => {
    const baseIndex = await Bun.file('src/modules/base/index.ts').text()

    expect(baseIndex).toContain("import './text'")
    expect(baseIndex).not.toContain("import './heading'")
    expect(baseIndex).not.toContain("import './paragraph'")
  })

  it('has only content and tag module settings', async () => {
    expect(TextModule.id).toBe('base.text')
    expect(Object.keys(TextModule.schema).sort()).toEqual(['tag', 'text'])
  })

  it('renders the selected semantic tag', async () => {
    for (const tag of ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      const { html } = renderModule(TextModule, { tag, text: 'Test' })
      expect(html).toContain(`<${tag}`)
      expect(html).toContain(`</${tag}>`)
    }
  })

  it('escapes text content through the publisher pipeline', async () => {
    const safeProps = escapeProps({ ...TextModule.defaults, text: '<script>xss()</script>' })
    const { html } = TextModule.render(safeProps, [])

    expect(html).toBeCleanHTML()
    expect(html).toContain('&lt;script&gt;')
  })
})

// ---------------------------------------------------------------------------
// base.button — module-specific tests
// ---------------------------------------------------------------------------

describe('base.button — render() specifics', () => {
  it('has only content and behavior module settings', () => {
    expect(Object.keys(ButtonModule.schema).sort()).toEqual(['disabled', 'href', 'label', 'target'])
  })

  it('renders an <a> element when href is set', () => {
    const { html } = renderModule(ButtonModule, { href: 'https://example.com' })
    expect(html).toMatch(/<a[\s>]/)
    expect(html).toContain('href="https://example.com"')
  })

  it('renders a <button> element when href is empty', () => {
    const { html } = renderModule(ButtonModule, { href: '' })
    expect(html).toMatch(/<button[\s>]/)
  })

  it('XSS: strips javascript: href', () => {
    const { html } = renderModule(ButtonModule, { href: 'javascript:alert(1)' })
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('javascript:')
  })

  it('XSS: escapes label text', () => {
    // Simulate the publisher pipeline (Constraint #211)
    const safeProps = escapeProps({ ...ButtonModule.defaults, label: '<script>alert(1)</script>', href: '' })
    const { html } = ButtonModule.render(safeProps, [])
    expect(html).toBeCleanHTML()
    expect(html).toContain('&lt;script&gt;')
  })

  it('adds rel="noopener noreferrer" for target="_blank" links', () => {
    const { html } = renderModule(ButtonModule, {
      href: 'https://example.com',
      target: '_blank',
    })
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => ButtonModule.render(ButtonModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.container — module-specific tests
// ---------------------------------------------------------------------------

describe('base.container — render() specifics', () => {
  it('is a container module (canHaveChildren: true)', () => {
    expect(ContainerModule.canHaveChildren).toBe(true)
  })

  it('has only the HTML tag module setting', () => {
    expect(Object.keys(ContainerModule.schema)).toEqual(['tag'])
  })

  it('renders children HTML inside the container', () => {
    const child1 = '<h1>Title</h1>'
    const child2 = '<p>Body</p>'
    const { html } = renderModule(ContainerModule, {}, [child1, child2])
    expect(html).toContain(child1)
    expect(html).toContain(child2)
  })

  it('renders an empty container when no children are provided', () => {
    const { html } = renderModule(ContainerModule, {}, [])
    expect(typeof html).toBe('string')
    expect(html.trim().length).toBeGreaterThan(0)
  })

  it('renders safely when persisted props are missing tag', () => {
    const Component = ContainerModule.component

    expect(() => {
      renderReact(React.createElement(Component, {
        props: {},
        nodeId: 'container-with-missing-tag',
        isSelected: false,
      }))
    }).not.toThrow()
  })

  it('falls back to div for invalid published tag values', () => {
    const { html } = ContainerModule.render({ tag: undefined }, ['<p>child</p>'])

    expect(html).toContain('<div>')
    expect(html).toContain('</div>')
    expect(html).not.toContain('<undefined')
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() =>
        ContainerModule.render(ContainerModule.defaults, ['<p>child</p>'])
      )
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.image — module-specific tests
// ---------------------------------------------------------------------------

describe('base.image — render() specifics', () => {
  // Image module returns empty HTML when src is absent (Guideline #226 —
  // no editor-only chrome in published output). Tests needing <img> must supply src.

  it('has only content and behavior module settings', () => {
    expect(Object.keys(ImageModule.schema).sort()).toEqual(['alt', 'loading', 'src'])
  })

  it('returns empty html when src is empty (Guideline #226)', () => {
    const { html } = renderModule(ImageModule, { src: '' })
    expect(html).toBe('')
    expect(html).not.toMatch(/<div[\s>]/)
    expect(html).not.toMatch(/<img[\s>]/)
  })

  it('renders an <img> element when src is provided', () => {
    const { html } = renderModule(ImageModule, { src: '/images/hero.jpg' })
    expect(html).toMatch(/<img[\s>]/)
    expect(html).toContain('src="/images/hero.jpg"')
  })

  it('XSS: strips javascript: src — safeUrl() returns "#" → renders <img src="#">', () => {
    // javascript: src → safeUrl() returns '#' (truthy) → renders <img src="#">.
    // This is safe: no XSS payload reaches the output. The src="#" case is
    // semantically imperfect but the malicious scheme is fully neutralised.
    const { html } = renderModule(ImageModule, { src: 'javascript:alert(1)' })
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('javascript:')
  })

  it('XSS: escapes alt text in <img>', () => {
    // Simulate the publisher pipeline (Constraint #211)
    const safeProps = escapeProps({ ...ImageModule.defaults, src: '/img.jpg', alt: '"><script>alert(1)</script>' })
    const { html } = ImageModule.render(safeProps, [])
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('<script>')
  })

  it('includes alt attribute for accessibility when src is provided', () => {
    const { html } = renderModule(ImageModule, {
      src: '/img.jpg',
      alt: 'Profile photo',
    })
    expect(html).toContain('alt="Profile photo"')
  })

  it('includes loading="lazy" by default', () => {
    const { html } = renderModule(ImageModule, { src: '/img.jpg' })
    expect(html).toContain('loading="lazy"')
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => ImageModule.render(ImageModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.video — module-specific tests
// ---------------------------------------------------------------------------

describe('base.video — render() specifics', () => {
  it('has only source and playback behavior module settings', () => {
    expect(Object.keys(VideoModule.schema).sort()).toEqual([
      'autoplay',
      'controls',
      'loop',
      'muted',
      'source',
      'videoUrl',
      'youtubeId',
    ])
  })

  it('defaults to media library video selection', () => {
    expect(VideoModule.defaults.source).toBe('media')
    expect(VideoModule.schema.source).toMatchObject({
      type: 'select',
      options: [
        { label: 'Media library', value: 'media' },
        { label: 'YouTube', value: 'youtube' },
      ],
    })
    expect(VideoModule.schema.videoUrl).toMatchObject({
      type: 'media',
      mediaKind: 'video',
      condition: { field: 'source', eq: 'media' },
    })
  })

  it('is NOT a container (canHaveChildren: false)', () => {
    expect(VideoModule.canHaveChildren).toBe(false)
  })

  it('renders a YouTube iframe for source=youtube with a valid ID', () => {
    const { html } = renderModule(VideoModule, { source: 'youtube', youtubeId: 'dQw4w9WgXcQ' })
    expect(html).toContain('youtube.com/embed/dQw4w9WgXcQ')
    expect(html).toMatch(/<iframe/)
  })

  it('renders a <video> element for source=media', () => {
    const { html } = renderModule(VideoModule, { source: 'media', videoUrl: '/uploads/intro.mp4' })
    expect(html).toMatch(/<video/)
    expect(html).toContain('/uploads/intro.mp4')
  })

  it('XSS: strips javascript: in videoUrl (url-validated by publisher)', () => {
    const { html } = renderModule(VideoModule, { source: 'media', videoUrl: 'javascript:alert(1)' })
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('javascript:')
  })

  it('XSS: strips data: URL in videoUrl (data: schemes blocked by safeUrl)', () => {
    // data:text/html URLs open a new browsing context with arbitrary HTML/JS,
    // bypassing the published page's CSP (isSafeUrl blocks all data: schemes).
    const { html } = renderModule(VideoModule, {
      source: 'media',
      videoUrl: 'data:text/html,<script>alert(1)</script>',
    })
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('javascript:')
  })

  it('XSS: strips vbscript: in videoUrl', () => {
    const { html } = renderModule(VideoModule, { source: 'media', videoUrl: 'vbscript:MsgBox(1)' })
    expect(html).not.toContain('vbscript:')
  })

  it('XSS: strips tab-normalised javascript: bypass in videoUrl', () => {
    // WHATWG URL parser strips \t before scheme detection — isSafeUrl mirrors this
    const { html } = renderModule(VideoModule, { source: 'media', videoUrl: 'java\tscript:alert(1)' })
    expect(html).not.toContain('alert(1)')
  })

  it('css field is props-independent — no prop interpolation (Constraint #310)', () => {
    const out1 = VideoModule.render(VideoModule.defaults, [])
    const out2 = VideoModule.render({ ...VideoModule.defaults, borderRadius: 99 }, [])
    // css field must be the same regardless of props
    expect(out1.css).toBe(out2.css)
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => VideoModule.render(VideoModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.list — module-specific tests
// ---------------------------------------------------------------------------

describe('base.list — render() specifics', () => {
  it('has only content and semantic module settings', () => {
    expect(Object.keys(ListModule.schema).sort()).toEqual(['items', 'listType'])
  })

  it('renders <ul> element for listType="unordered"', () => {
    const { html } = renderModule(ListModule, { listType: 'unordered' })
    expect(html).toContain('<ul')
    expect(html).toContain('</ul>')
    expect(html).not.toContain('<ol')
  })

  it('renders <ol> element for listType="ordered"', () => {
    const { html } = renderModule(ListModule, { listType: 'ordered' })
    expect(html).toContain('<ol')
    expect(html).toContain('</ol>')
    expect(html).not.toContain('<ul')
  })

  it('renders each newline-separated item as a <li> element', () => {
    const { html } = renderModule(ListModule, { items: 'Alpha\nBeta\nGamma' })
    expect(html).toContain('<li')
    expect(html).toContain('Alpha')
    expect(html).toContain('Beta')
    expect(html).toContain('Gamma')
    const liCount = (html.match(/<li/g) ?? []).length
    expect(liCount).toBe(3)
  })

  it('skips blank lines — blank entries do not produce empty <li>', () => {
    const { html } = renderModule(ListModule, { items: 'Item A\n\n\nItem B' })
    const liCount = (html.match(/<li/g) ?? []).length
    expect(liCount).toBe(2)
  })

  it('renders empty output (no <li>) when items is empty string', () => {
    const { html } = renderModule(ListModule, { items: '' })
    expect(html).not.toContain('<li')
  })

  it('XSS: HTML-escapes items via publisher pipeline (Constraint #211)', () => {
    // Publisher's escapeProps() is the sole escaping layer (Option A fix).
    // Items are pre-escaped before render() is called.
    const safeProps = escapeProps({ ...ListModule.defaults, items: '<script>alert(1)</script>\nSafe item' })
    const { html } = ListModule.render(safeProps, [])
    expect(html).toBeCleanHTML()
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('XSS: escapes & in item text without double-escaping', () => {
    const safeProps = escapeProps({ ...ListModule.defaults, items: 'Cats & Dogs\nBread & Butter' })
    const { html } = ListModule.render(safeProps, [])
    expect(html).toContain('&amp;')
    expect(html).not.toContain('&amp;amp;')
  })

  it('defaults.items is empty string — shows placeholder on canvas (Guideline #226)', () => {
    // New list modules should start with the placeholder ("List item 1" in grey)
    // rather than pre-filled sample content. Empty string triggers the placeholder
    // branch in ListEditor. This matches the in-editor placeholder UX pattern.
    expect(ListModule.defaults.items).toBe('')
  })

  it('is NOT a container module (canHaveChildren: false)', () => {
    expect(ListModule.canHaveChildren).toBe(false)
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => ListModule.render(ListModule.defaults, []))
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// base.link — module-specific tests
// ---------------------------------------------------------------------------

describe('base.link — render() specifics', () => {
  it('has URL, text, and target module settings', () => {
    expect(Object.keys(LinkModule.schema).sort()).toEqual(['href', 'target', 'text'])
  })

  it('renders target and rel for new-tab links', () => {
    const { html } = renderModule(LinkModule, {
      href: 'https://example.com',
      text: 'Example',
      target: '_blank',
    })
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('can contain child modules for composed link content', () => {
    expect(LinkModule.canHaveChildren).toBe(true)
  })

  it('does not access DOM globals', () => {
    expect(() =>
      withBannedGlobals(() => LinkModule.render(LinkModule.defaults, []))
    ).not.toThrow()
  })
})
