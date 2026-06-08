/**
 * Unit tests for scopeCollidingClasses — per-page class scoping.
 *
 * Reproduces the real-world failure: a multi-page export where two stylesheets
 * define the same class name (`.btn`, `.hero`) with different declarations, and
 * the CMS's single global registry would otherwise let one clobber the other.
 */

import { describe, it, expect } from 'bun:test'
import { createNode } from '@core/page-tree'
import { scopeCollidingClasses } from '@core/siteImport'
import type { CssFileResult, PagePlan, NewStyleRule } from '@core/siteImport'
import type { ImportFragment } from '@core/htmlImport'

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function classRule(name: string, styles: Record<string, unknown>): NewStyleRule {
  return { name, kind: 'class', selector: `.${name}`, order: 0, styles, contextStyles: {} }
}

function ambientRule(selector: string, styles: Record<string, unknown>): NewStyleRule {
  return { name: selector, kind: 'ambient', selector, order: 0, styles, contextStyles: {} }
}

function file(cssPath: string, rules: NewStyleRule[]): CssFileResult {
  return { cssPath, rules, assetRefs: [] }
}

/** A one-node page fragment whose single node carries the given class tokens. */
function page(source: string, linkedCssPaths: string[], classIds: string[]): PagePlan {
  const node = createNode('base.button')
  node.classIds = classIds
  const fragment: ImportFragment = { nodes: { [node.id]: node }, rootIds: [node.id] }
  return { source, title: source, slug: source, linkedCssPaths, scripts: [], nodeFragment: fragment }
}

function tokensOf(plan: PagePlan): string[] {
  return Object.values(plan.nodeFragment.nodes)[0].classIds ?? []
}

function ruleNamed(file: CssFileResult, name: string): NewStyleRule | undefined {
  return file.rules.find((r) => r.kind === 'class' && r.name === name)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scopeCollidingClasses', () => {
  it('scopes a class defined differently in two stylesheets, keeping each page faithful', () => {
    const files = [
      file('instatic.css', [classRule('btn', { borderRadius: '0', textTransform: 'uppercase' })]),
      file('style.css', [classRule('btn', { borderRadius: '999px' })]),
    ]
    const pages = [
      page('index.html', ['instatic.css'], ['btn']),
      page('original.html', ['style.css'], ['btn']),
    ]

    const result = scopeCollidingClasses(pages, files)

    // First definition keeps the bare name; the divergent one gets a suffix.
    expect(ruleNamed(result.cssFileResults[0], 'btn')).toBeDefined()
    const scopedRule = ruleNamed(result.cssFileResults[1], 'btn-2')
    expect(scopedRule).toBeDefined()
    expect(scopedRule!.selector).toBe('.btn-2')

    // Each page's token resolves to its OWN stylesheet's definition.
    expect(tokensOf(result.pagePlans[0])).toEqual(['btn'])
    expect(tokensOf(result.pagePlans[1])).toEqual(['btn-2'])

    // One summary rename recorded.
    expect(result.renames).toEqual([
      { originalName: 'btn', scopedName: 'btn-2', cssPath: 'style.css' },
    ])
  })

  it('shares a class when both stylesheets define it identically (no rename)', () => {
    const styles = { color: 'red', padding: '4px' }
    const files = [
      file('a.css', [classRule('chip', { ...styles })]),
      file('b.css', [classRule('chip', { ...styles })]),
    ]
    const pages = [
      page('a.html', ['a.css'], ['chip']),
      page('b.html', ['b.css'], ['chip']),
    ]

    const result = scopeCollidingClasses(pages, files)

    expect(result.renames).toEqual([])
    expect(tokensOf(result.pagePlans[0])).toEqual(['chip'])
    expect(tokensOf(result.pagePlans[1])).toEqual(['chip'])
    // Inputs returned untouched on the fast path.
    expect(result.cssFileResults).toBe(files)
    expect(result.pagePlans).toBe(pages)
  })

  it('rewrites ambient selectors that reference a renamed class (hover, compound, descendant)', () => {
    const files = [
      file('instatic.css', [
        classRule('btn', { borderRadius: '0' }),
        ambientRule('.btn:hover', { background: 'transparent' }),
        ambientRule('.btn.btn-lg', { fontSize: '13px' }),
      ]),
      file('style.css', [
        classRule('btn', { borderRadius: '999px' }),
        ambientRule('.btn:hover', { background: '#eee' }),
        ambientRule('.plan-cta .btn', { width: '100%' }),
      ]),
    ]
    const pages = [page('original.html', ['style.css'], ['btn'])]

    const result = scopeCollidingClasses(pages, files)
    const styleFile = result.cssFileResults[1]

    // The renamed file's ambient selectors all follow the rename.
    const selectors = styleFile.rules.map((r) => r.selector)
    expect(selectors).toContain('.btn-2:hover')
    expect(selectors).toContain('.plan-cta .btn-2')

    // The first (canonical) file's ambient selectors are untouched.
    const firstSelectors = result.cssFileResults[0].rules.map((r) => r.selector)
    expect(firstSelectors).toContain('.btn:hover')
    expect(firstSelectors).toContain('.btn.btn-lg')
  })

  it('handles three divergent definitions with sequential suffixes', () => {
    const files = [
      file('a.css', [classRule('box', { color: 'a' })]),
      file('b.css', [classRule('box', { color: 'b' })]),
      file('c.css', [classRule('box', { color: 'c' })]),
    ]
    const pages = [
      page('a.html', ['a.css'], ['box']),
      page('b.html', ['b.css'], ['box']),
      page('c.html', ['c.css'], ['box']),
    ]

    const result = scopeCollidingClasses(pages, files)

    expect(tokensOf(result.pagePlans[0])).toEqual(['box'])
    expect(tokensOf(result.pagePlans[1])).toEqual(['box-2'])
    expect(tokensOf(result.pagePlans[2])).toEqual(['box-3'])
  })

  it('avoids colliding a generated suffix with a real existing class name', () => {
    const files = [
      file('a.css', [
        classRule('box', { color: 'a' }),
        classRule('box-2', { color: 'pre-existing' }),
      ]),
      file('b.css', [classRule('box', { color: 'b' })]),
    ]
    const pages = [page('b.html', ['b.css'], ['box'])]

    const result = scopeCollidingClasses(pages, files)

    // `box-2` is taken, so the divergent `box` becomes `box-3`.
    expect(tokensOf(result.pagePlans[0])).toEqual(['box-3'])
  })
})
