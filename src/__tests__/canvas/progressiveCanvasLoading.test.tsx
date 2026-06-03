import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { CanvasRoot } from '@site/canvas/CanvasRoot'
import { useEditorStore } from '@site/store/store'
import {
  DEFAULT_MODULE_INSERTER_PREFERENCE,
} from '@core/persistence/userPreferences'
import { __resetModuleInserterPreferenceForTests } from '@site/module-picker/useModuleInserterPreference'
import { makeNode, makePage, makeSite } from '../fixtures'
import { queryCanvasNodeInFrame } from './iframeCanvasQuery'
import '@modules/base'

afterEach(cleanup)

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  __resetModuleInserterPreferenceForTests()
})

beforeEach(() => {
  __resetModuleInserterPreferenceForTests()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/admin/api/cms/me/preferences/module-inserter')) {
      return new Response(JSON.stringify({ value: DEFAULT_MODULE_INSERTER_PREFERENCE }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('', { status: 404 })
  }) as typeof globalThis.fetch

  const rootId = 'root'
  const textId = 'headline'
  const page = makePage({
    id: 'page-1',
    rootNodeId: rootId,
    nodes: {
      [rootId]: makeNode({ id: rootId, moduleId: 'base.body', children: [textId] }),
      [textId]: makeNode({
        id: textId,
        moduleId: 'base.text',
        props: { text: 'Progressive headline', tag: 'h1' },
      }),
    },
  })
  const site = makeSite({ pages: [page] })
  useEditorStore.setState({
    site,
    activePageId: 'page-1',
    activeDocument: null,
    activeBreakpointId: 'desktop',
    canvasView: 'design',
    runScripts: false,
    selectedNodeId: null,
    selectedNodeIds: [],
    hoveredNodeId: null,
    hoveredBreakpointId: null,
    previewClassAssignment: null,
    propertiesPanel: { collapsed: false, x: 0, y: 0, width: 360 },
    propertiesPanelMode: 'docked',
    _historyPast: [],
    _historyFuture: [],
    canUndo: false,
    canRedo: false,
    hasUnsavedChanges: false,
  } as Parameters<typeof useEditorStore.setState>[0])
})

async function flushAnimationFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

async function flushIdleFallback() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 90))
  })
}

describe('progressive canvas loading', () => {
  it('paints frame skeletons before mounting node trees, then loads the active frame first', async () => {
    render(<CanvasRoot />)

    expect(screen.getByTestId('canvas-frame-skeleton-mobile')).toBeDefined()
    expect(queryCanvasNodeInFrame('mobile', 'headline')).toBeNull()

    await flushAnimationFrame()

    expect(queryCanvasNodeInFrame('desktop', 'headline')).toBeTruthy()
    expect(queryCanvasNodeInFrame('mobile', 'headline')).toBeNull()
    expect(screen.queryByTestId('canvas-frame-skeleton-desktop')).toBeNull()
    expect(screen.getByTestId('canvas-frame-skeleton-mobile')).toBeDefined()

    await flushIdleFallback()

    expect(queryCanvasNodeInFrame('mobile', 'headline')).toBeTruthy()
    expect(screen.queryByTestId('canvas-frame-skeleton-mobile')).toBeNull()
  })
})
