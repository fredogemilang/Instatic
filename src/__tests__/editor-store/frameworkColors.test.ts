import { beforeEach, describe, expect, it } from 'bun:test'
import { useEditorStore } from '@core/editor-store/store'
import { frameworkColorClassId } from '@core/framework/colors'
import type { FrameworkColorToken } from '@core/page-tree/types'
import { makeNode, makePage, makeSite } from '../fixtures'

function resetStore() {
  useEditorStore.setState({
    site: makeSite(),
    activePageId: 'page-1',
    selectedNodeId: null,
    activeClassId: null,
    selectedSelectorClassId: null,
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
}

beforeEach(resetStore)

describe('framework color store actions', () => {
  it('creates a color token with a category label and generated locked utilities', () => {
    const token = useEditorStore.getState().createFrameworkColorToken({
      category: 'Brand',
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      darkModeEnabled: true,
      generateUtilities: {
        text: true,
        background: true,
        border: true,
        fill: true,
      },
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })

    const state = useEditorStore.getState()
    expect(state.site!.settings.framework!.colors.tokens[0]).toMatchObject({
      id: token.id,
      category: 'Brand',
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      darkModeEnabled: true,
    })
    expect(token.darkValue).toStartWith('hsla(')
    expect(token.darkValue).not.toBe(token.lightValue)

    const textClass = state.site!.classes[frameworkColorClassId(token.id, 'base', 'text')]
    const fillClass = state.site!.classes[frameworkColorClassId(token.id, 'base', 'fill')]
    expect(textClass).toMatchObject({
      name: 'text-primary',
      styles: { color: 'var(--primary)' },
      generated: { locked: true, family: 'color', sourceId: token.id },
    })
    expect(fillClass).toMatchObject({
      name: 'fill-primary',
      styles: { fill: 'var(--primary)' },
      generated: { locked: true, utility: 'fill' },
    })
  })

  it('keeps generated class assignments stable when a color slug changes', () => {
    const page = makePage({
      id: 'page-1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.root', children: ['hero'] }),
        hero: makeNode({ id: 'hero', moduleId: 'base.text', classIds: [] }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: 'page-1',
    } as Parameters<typeof useEditorStore.setState>[0])

    const token = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateUtilities: {
        text: true,
        background: false,
        border: false,
        fill: false,
      },
    })
    const classId = frameworkColorClassId(token.id, 'base', 'text')
    useEditorStore.getState().addNodeClass('hero', classId)

    useEditorStore.getState().updateFrameworkColorToken(token.id, {
      slug: 'brand-primary',
    })

    const state = useEditorStore.getState()
    expect(state.site!.pages[0].nodes.hero.classIds).toEqual([classId])
    expect(state.site!.classes[classId].name).toBe('text-brand-primary')
    expect(state.site!.classes[classId].styles).toEqual({ color: 'var(--brand-primary)' })
  })

  it('removes disabled generated utility classes from nodes', () => {
    const page = makePage({
      id: 'page-1',
      rootNodeId: 'root',
      nodes: {
        root: makeNode({ id: 'root', moduleId: 'base.root', children: ['hero'] }),
        hero: makeNode({ id: 'hero', moduleId: 'base.text', classIds: [] }),
      },
    })
    useEditorStore.setState({
      site: makeSite({ pages: [page] }),
      activePageId: 'page-1',
    } as Parameters<typeof useEditorStore.setState>[0])

    const token = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateUtilities: {
        text: false,
        background: true,
        border: false,
        fill: false,
      },
    })
    const classId = frameworkColorClassId(token.id, 'base', 'background')
    useEditorStore.getState().addNodeClass('hero', classId)

    useEditorStore.getState().updateFrameworkColorToken(token.id, {
      generateUtilities: {
        text: false,
        background: false,
        border: false,
        fill: false,
      },
    })

    const state = useEditorStore.getState()
    expect(state.site!.classes[classId]).toBeUndefined()
    expect(state.site!.pages[0].nodes.hero.classIds).toEqual([])
  })

  it('prevents locked generated utility classes from being edited through class actions', () => {
    const token = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateUtilities: {
        text: true,
        background: false,
        border: false,
        fill: false,
      },
    })
    const classId = frameworkColorClassId(token.id, 'base', 'text')

    useEditorStore.getState().updateClassStyles(classId, { color: 'red' })
    useEditorStore.getState().setClassBreakpointStyles(classId, 'mobile', { color: 'blue' })
    useEditorStore.getState().renameClass(classId, 'text-edited')
    const duplicate = useEditorStore.getState().duplicateClass(classId)
    useEditorStore.getState().deleteClass(classId)

    const state = useEditorStore.getState()
    expect(duplicate).toBeNull()
    expect(state.site!.classes[classId]).toMatchObject({
      name: 'text-primary',
      styles: { color: 'var(--primary)' },
      breakpointStyles: {},
      generated: { locked: true },
    })
  })

  it('reconciles generated utility classes when loading a site with framework colors', () => {
    const token: FrameworkColorToken = {
      id: 'primary-token',
      category: '',
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
      updatedAt: 2,
    }
    const site = makeSite({
      settings: {
        ...makeSite().settings,
        framework: {
          colors: {
            tokens: [token],
          },
        },
      },
      classes: {},
    })

    useEditorStore.getState().loadSite(site)

    expect(useEditorStore.getState().site!.classes[frameworkColorClassId(token.id, 'base', 'text')]).toMatchObject({
      name: 'text-primary',
      styles: { color: 'var(--primary)' },
      generated: { locked: true, sourceId: token.id },
    })
  })

  it('duplicates and reorders framework color tokens with regenerated utility classes', () => {
    const first = useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      generateUtilities: { text: true },
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })
    const second = useEditorStore.getState().createFrameworkColorToken({
      slug: 'secondary',
      lightValue: 'hsla(0, 94%, 68%, 1)',
      generateUtilities: { text: true },
      generateTransparent: false,
      generateShades: { enabled: false, count: 0 },
      generateTints: { enabled: false, count: 0 },
    })

    const copy = useEditorStore.getState().duplicateFrameworkColorToken(first.id)

    expect(copy).toMatchObject({
      slug: 'primary-copy',
      lightValue: first.lightValue,
      generateUtilities: first.generateUtilities,
    })
    expect(useEditorStore.getState().site!.classes[frameworkColorClassId(copy!.id, 'base', 'text')]).toMatchObject({
      name: 'text-primary-copy',
      generated: { locked: true, sourceId: copy!.id },
    })

    useEditorStore.getState().reorderFrameworkColorToken(second.id, 'up')

    const orderedSlugs = useEditorStore.getState().site!.settings.framework!.colors.tokens
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((token) => token.slug)
    expect(orderedSlugs).toEqual(['secondary', 'primary', 'primary-copy'])
  })

  it('canonicalizes a new token category to match an existing label case-insensitively', () => {
    useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      category: 'Brand',
    })
    const second = useEditorStore.getState().createFrameworkColorToken({
      slug: 'secondary',
      lightValue: 'hsla(0, 94%, 68%, 1)',
      category: 'brand',
    })

    expect(second.category).toBe('Brand')
  })

  it('canonicalizes an updated token category to match an existing label case-insensitively', () => {
    useEditorStore.getState().createFrameworkColorToken({
      slug: 'primary',
      lightValue: 'hsla(238, 100%, 62%, 1)',
      category: 'Brand',
    })
    const second = useEditorStore.getState().createFrameworkColorToken({
      slug: 'secondary',
      lightValue: 'hsla(0, 94%, 68%, 1)',
    })

    useEditorStore.getState().updateFrameworkColorToken(second.id, { category: 'BRAND' })

    const updated = useEditorStore.getState().site!.settings.framework!.colors.tokens.find(
      (token) => token.id === second.id,
    )
    expect(updated?.category).toBe('Brand')
  })
})
