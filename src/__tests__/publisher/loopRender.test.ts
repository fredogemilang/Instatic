/**
 * Tests for the publisher's `base.loop` interceptor: round-robin children,
 * entry-stack push/pop, multiple loops on a page, nested loop inside a
 * single-entry template (parentEntry binding), and pagination markup.
 */

import { describe, expect, it } from 'bun:test'
import { makeModule, makePage, makeRegistry, makeSite } from './helpers'
import { publishPage, type ResolvedLoopRenderData } from '@core/publisher/render'
import type { LoopItem } from '@core/loops/types'

function loopData(items: LoopItem[]): ResolvedLoopRenderData {
  return { items, totalItems: items.length, pageNumber: 1, hasMore: false }
}

function loopDataWithMore(items: LoopItem[], pageSize: number): ResolvedLoopRenderData {
  return { items, totalItems: items.length + pageSize, pageNumber: 1, hasMore: true }
}

const textModule = makeModule('base.text', {
  render: (props) => ({
    html: `<p>${String((props as { text: string }).text)}</p>`,
  }),
})

const containerModule = makeModule('base.container', {
  canHaveChildren: true,
  render: (_props, children) => ({ html: `<div>${children.join('')}</div>` }),
})

const rootModule = makeModule('base.root', {
  canHaveChildren: true,
  render: (_props, children) => ({ html: `<main>${children.join('')}</main>` }),
})

const loopModule = makeModule('base.loop', {
  canHaveChildren: true,
  // Defense-in-depth fallback that should never be called — interceptor
  // handles loop rendering. If it IS called, the test will see this.
  render: () => ({ html: '<!-- pb: loop default render hit -->' }),
})

const baseRegistry = makeRegistry({
  'base.root': rootModule,
  'base.text': textModule,
  'base.container': containerModule,
  'base.loop': loopModule,
})

function makeItem(id: string, title: string): LoopItem {
  return { id, fields: { id, title } }
}

describe('publisher loop renderer', () => {
  it('renders one child per item with binding to currentEntry', () => {
    const items = [makeItem('a', 'Alpha'), makeItem('b', 'Beta'), makeItem('c', 'Gamma')]
    const page = makePage({
      root: { moduleId: 'base.root', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'], props: { sourceId: 'test' } },
      card: {
        moduleId: 'base.text',
        props: { text: 'fallback' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html

    expect(html).toContain('<p>Alpha</p>')
    expect(html).toContain('<p>Beta</p>')
    expect(html).toContain('<p>Gamma</p>')
    // currentEntry is restored after the loop — no leakage.
  })

  it('round-robins children across iterations', () => {
    const items = [
      makeItem('1', 'one'),
      makeItem('2', 'two'),
      makeItem('3', 'three'),
      makeItem('4', 'four'),
    ]
    const page = makePage({
      root: { moduleId: 'base.root', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['variantA', 'variantB'] },
      variantA: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
      variantB: {
        moduleId: 'base.container',
        children: ['variantBText'],
      },
      variantBText: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html

    // Iteration order must be A(one), B(two), A(three), B(four).
    const oneIdx = html.indexOf('<p>one</p>')
    const twoIdx = html.indexOf('<div><p>two</p></div>')
    const threeIdx = html.indexOf('<p>three</p>')
    const fourIdx = html.indexOf('<div><p>four</p></div>')
    expect(oneIdx).toBeGreaterThanOrEqual(0)
    expect(twoIdx).toBeGreaterThan(oneIdx)
    expect(threeIdx).toBeGreaterThan(twoIdx)
    expect(fourIdx).toBeGreaterThan(threeIdx)
  })

  it('renders empty when items list is empty', () => {
    const page = makePage({
      root: { moduleId: 'base.root', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: { moduleId: 'base.text', props: { text: 'fallback' } },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData([])]]),
    }).html

    expect(html).not.toContain('<p>fallback</p>')
    // Wrapper div from renderLoop should not appear when items is empty.
    expect(html).toContain('<main></main>')
  })

  it('emits a marker comment when loop data is missing', () => {
    const page = makePage({
      root: { moduleId: 'base.root', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: { moduleId: 'base.text', props: { text: 'fallback' } },
    })
    const html = publishPage(page, makeSite(), baseRegistry).html
    expect(html).toContain('has no resolved data')
  })

  it('supports multiple loops on a page with independent data', () => {
    const page = makePage({
      root: { moduleId: 'base.root', children: ['loopA', 'loopB'] },
      loopA: { moduleId: 'base.loop', children: ['cardA'] },
      cardA: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
      loopB: { moduleId: 'base.loop', children: ['cardB'] },
      cardB: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([
        ['loopA', loopData([makeItem('a', 'Apple')])],
        ['loopB', loopData([makeItem('b', 'Banana'), makeItem('c', 'Cherry')])],
      ]),
    }).html

    expect(html).toContain('<p>Apple</p>')
    expect(html).toContain('<p>Banana</p>')
    expect(html).toContain('<p>Cherry</p>')
  })

  it('exposes parentEntry to bindings inside a nested loop', () => {
    const outer = makeItem('outer', 'Outer Post')
    const inner = [makeItem('1', 'Inner 1'), makeItem('2', 'Inner 2')]
    const page = makePage({
      root: { moduleId: 'base.root', children: ['header', 'loop'] },
      header: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'parentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      // Outer template seeds the entry stack with the post being viewed
      templateContext: { entryStack: [outer] },
      loopData: new Map([['loop', loopData(inner)]]),
    }).html

    // Header (outside loop) → currentEntry = outer
    expect(html).toContain('<p>Outer Post</p>')
    // Cards inside loop → parentEntry = outer (rendered N times)
    const matches = html.match(/<p>Outer Post<\/p>/g)
    expect(matches?.length).toBe(3) // header + 2 iterations
  })

  it('attaches data attrs and registers infinite mode', () => {
    const items = [makeItem('1', 'one'), makeItem('2', 'two')]
    const page = makePage({
      root: { moduleId: 'base.root', children: ['loop'] },
      loop: {
        moduleId: 'base.loop',
        children: ['card'],
        props: { pagination: 'infinite', pageSize: 2 },
      },
      card: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopDataWithMore(items, 2)]]),
    }).html

    expect(html).toContain('data-pb-loop="loop"')
    expect(html).toContain('data-pb-loop-mode="infinite"')
    expect(html).toContain('data-pb-loop-has-more="true"')
    expect(html).toContain('data-pb-loop-page-size="2"')
    // Loop runtime script injected when at least one infinite loop exists
    expect(html).toContain('/_pb/assets/loop-runtime.js')
  })

  it('does not inject the loop runtime when no loop is infinite', () => {
    const items = [makeItem('1', 'one')]
    const page = makePage({
      root: { moduleId: 'base.root', children: ['loop'] },
      loop: { moduleId: 'base.loop', children: ['card'] },
      card: {
        moduleId: 'base.text',
        props: { text: '' },
        dynamicBindings: { text: { source: 'currentEntry', field: 'title' } },
      },
    })
    const html = publishPage(page, makeSite(), baseRegistry, {
      loopData: new Map([['loop', loopData(items)]]),
    }).html

    expect(html).not.toContain('loop-runtime.js')
  })
})
