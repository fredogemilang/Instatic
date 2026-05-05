/**
 * siteCssBundle — unit tests for the server-side CSS bundle builder.
 *
 * Verifies:
 * - The three layered files are produced (reset / framework / style).
 * - Each file's content is correctly populated from the corresponding source
 *   (reset constant, framework root + module CSS, user class CSS).
 * - Filenames embed a content hash so cache busting works.
 * - Identical sites produce identical hashes (deterministic).
 * - Different sites produce different hashes for the layer that changed.
 */

import { describe, it, expect } from 'bun:test'
import { buildSiteCssBundle } from '../../../server/cms/siteCssBundle'
import { makeModule, makeRegistry, makePage, makeSite } from '../publisher/helpers'

describe('buildSiteCssBundle', () => {
  const styledTextDef = makeModule('base.text', {
    render: (_props, _children) => ({
      html: '<h1>Hello</h1>',
      // Plugins MAY emit module CSS via render(); base modules don't, but the
      // bundle builder must handle both. This stand-in proves the path works.
      css: 'h1 { color: black; }',
    }),
  })
  const registry = makeRegistry({ 'base.text': styledTextDef })

  it('builds three files with sensible filenames + hashes', () => {
    const site = makeSite()
    const page = makePage({
      root: { moduleId: 'base.text', props: { text: 'Hi' } },
    })
    site.pages = [page]

    const bundle = buildSiteCssBundle(site, registry)

    expect(bundle.reset.bundle).toBe('reset')
    expect(bundle.framework.bundle).toBe('framework')
    expect(bundle.style.bundle).toBe('style')

    expect(bundle.reset.filename).toMatch(/^reset-[a-f0-9]{12}\.css$/)
    expect(bundle.framework.filename).toMatch(/^framework-[a-f0-9]{12}\.css$/)
    expect(bundle.style.filename).toMatch(/^style-[a-f0-9]{12}\.css$/)
  })

  it('reset.css carries the publisher reset content', () => {
    const site = makeSite()
    const page = makePage({ root: { moduleId: 'base.text', props: { text: 'Hi' } } })
    site.pages = [page]

    const bundle = buildSiteCssBundle(site, registry)
    expect(bundle.reset.content).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
    expect(bundle.reset.content).toContain('font-family: system-ui')
  })

  it('framework.css carries module CSS deduped across pages', () => {
    const site = makeSite()
    // Same module on three pages — its CSS must appear exactly once.
    site.pages = [
      makePage({ id: 'p1', root: { moduleId: 'base.text', props: { text: 'A' } } }),
      makePage({ id: 'p2', root: { moduleId: 'base.text', props: { text: 'B' } } }),
      makePage({ id: 'p3', root: { moduleId: 'base.text', props: { text: 'C' } } }),
    ]

    const bundle = buildSiteCssBundle(site, registry)
    const occurrences = bundle.framework.content.match(/h1 \{ color: black; \}/g) ?? []
    expect(occurrences.length).toBe(1)
  })

  it('style.css carries user class CSS', () => {
    const site = makeSite()
    site.classes = {
      hero: {
        id: 'hero',
        name: 'hero',
        styles: { fontSize: '48px' },
        breakpointStyles: {},
        createdAt: 0,
        updatedAt: 0,
      },
    }
    site.pages = [
      makePage({
        root: {
          moduleId: 'base.text',
          props: { text: 'Hi' },
          classIds: ['hero'],
        },
      }),
    ]

    const bundle = buildSiteCssBundle(site, registry)
    expect(bundle.style.content).toContain('.hero')
    expect(bundle.style.content).toContain('font-size: 48px')
  })

  it('is deterministic: identical sites produce identical hashes', () => {
    const site1 = makeSite()
    const site2 = makeSite()
    site1.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]
    site2.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]

    const bundle1 = buildSiteCssBundle(site1, registry)
    const bundle2 = buildSiteCssBundle(site2, registry)

    expect(bundle1.reset.hash).toBe(bundle2.reset.hash)
    expect(bundle1.framework.hash).toBe(bundle2.framework.hash)
    expect(bundle1.style.hash).toBe(bundle2.style.hash)
  })

  it('rotates the style hash when user classes change (the others stay)', () => {
    const baseSite = makeSite()
    baseSite.pages = [makePage({ root: { moduleId: 'base.text', props: { text: 'X' } } })]
    const before = buildSiteCssBundle(baseSite, registry)

    const editedSite = makeSite()
    editedSite.pages = [
      makePage({
        root: {
          moduleId: 'base.text',
          props: { text: 'X' },
          classIds: ['hero'],
        },
      }),
    ]
    editedSite.classes = {
      hero: {
        id: 'hero',
        name: 'hero',
        styles: { color: '#ff0000' },
        breakpointStyles: {},
        createdAt: 0,
        updatedAt: 0,
      },
    }
    const after = buildSiteCssBundle(editedSite, registry)

    expect(after.reset.hash).toBe(before.reset.hash)
    expect(after.framework.hash).toBe(before.framework.hash)
    expect(after.style.hash).not.toBe(before.style.hash)
  })
})
