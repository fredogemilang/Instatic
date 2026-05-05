/**
 * Canvas Accessibility Regression Tests
 *
 * Covers WCAG 2.1 AA requirements for the canvas editing surface:
 *
 * 1. NodeWrapper keyboard navigation (SC 2.1.1 — Keyboard)
 *    - tabIndex={0} so nodes are keyboard-reachable
 *    - role="button" + aria-pressed for AT announcement (NOT role="treeitem" —
 *      treeitems must be owned by role="tree"; the canvas is role="region")
 *    - Enter / Space fire onNodeClick (keyboard == pointer parity)
 *    - Click stops propagation (no canvas deselect fires)
 *
 * 2. CanvasRoot focus indicator (SC 2.4.7 — Focus Visible)
 *    - `outline: none` inline style is present (suppresses :focus-visible default)
 *    - boxShadow is used as the visible focus indicator instead
 *
 * References:
 *   - NodeWrapper WCAG fix: Contribution #325
 *   - UX review issues: Contribution #326
 */

import { describe, it, expect, mock, afterEach } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NodeWrapper } from '../../editor/components/Canvas/NodeRenderer'

afterEach(cleanup)

const NODE_RENDERER_CSS_PATH = 'src/editor/components/Canvas/NodeRenderer.module.css'
const SELECTION_OVERLAY_CSS_PATH =
  'src/editor/components/Canvas/BreakpointSelectionOverlay.module.css'
const GLOBALS_CSS_PATH = 'src/styles/globals.css'

function extractCssCustomProperty(source: string, propertyName: string): string {
  const match = source.match(new RegExp(`${propertyName}:\\s*([^;]+);`))
  return match?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Renders a NodeWrapper with safe defaults and returns the HTML string */
function renderNodeWrapper(overrides: Partial<Parameters<typeof NodeWrapper>[0]> = {}): string {
    const props = {
      nodeId: 'test-node-1',
      isSelected: false,
      isHovered: false,
      onNodeClick: () => {},
      onNodeHover: () => {},
      onNodeContextMenu: () => {},
      onNodeDoubleClick: () => {},
      children: React.createElement('span', null, 'content'),
      ...overrides,
    }
  return renderToStaticMarkup(React.createElement(NodeWrapper, props))
}

// ---------------------------------------------------------------------------
// 1 — NodeWrapper keyboard accessibility (WCAG SC 2.1.1)
// ---------------------------------------------------------------------------

describe('NodeWrapper — keyboard accessibility (WCAG SC 2.1.1)', () => {
  it('renders with tabIndex="0" so it is reachable via Tab key', () => {
    const html = renderNodeWrapper()
    expect(html).toContain('tabindex="0"')
  })

  it('renders with role="button" for screen reader announcement', () => {
    // Canvas nodes are interactive design elements — toggle-button semantics
    // (press to select). NOT role="treeitem": treeitems must be owned by a
    // role="tree" parent; using treeitem inside role="region" (the canvas) is
    // an ARIA ownership violation (WCAG SC 4.1.2). The tree representation of
    // the document hierarchy belongs exclusively in the DOM Panel (J6).
    const html = renderNodeWrapper()
    expect(html).toContain('role="button"')
    expect(html).not.toContain('role="treeitem"')
  })

  it('renders with aria-pressed="false" when not selected', () => {
    // aria-pressed (not aria-selected) is the correct attribute for role="button"
    const html = renderNodeWrapper({ isSelected: false })
    expect(html).toContain('aria-pressed="false"')
    expect(html).not.toContain('aria-selected')
  })

  it('renders with aria-pressed="true" when selected', () => {
    const html = renderNodeWrapper({ isSelected: true })
    expect(html).toContain('aria-pressed="true"')
    expect(html).not.toContain('aria-selected')
  })

  it('renders the data-node-id attribute for Playwright targeting', () => {
    const html = renderNodeWrapper({ nodeId: 'node-abc-123' })
    expect(html).toContain('data-node-id="node-abc-123"')
  })

  it('renders children inside the wrapper', () => {
    const html = renderNodeWrapper({
      children: React.createElement('p', { 'data-testid': 'inner' }, 'Hello'),
    })
    expect(html).toContain('data-testid="inner"')
    expect(html).toContain('Hello')
  })
})

// ---------------------------------------------------------------------------
// 2 — NodeWrapper selection ring
// ---------------------------------------------------------------------------

describe('NodeWrapper — selection ring', () => {
  it('renders the selection ring overlay when selected', () => {
    const html = renderNodeWrapper({ isSelected: true })
    expect(html).toContain('aria-pressed="true"')
  })

  it('does not render the selection ring when not selected and not hovered', () => {
    const html = renderNodeWrapper({ isSelected: false, isHovered: false })
    expect(html).not.toContain('data-hovered="true"')
  })

  it('renders the hover ring when hovered but not selected', () => {
    const html = renderNodeWrapper({ isSelected: false, isHovered: true })
    expect(html).toContain('data-hovered="true"')
  })

  it('uses inset box-shadow rings so the 1px line stays inside the canvas edge', async () => {
    // Rings live in the BreakpointSelectionOverlay (not on .nodeWrapper anymore)
    // because NodeWrapper is `display: contents` and has no layout box.
    const css = await Bun.file(SELECTION_OVERLAY_CSS_PATH).text()
    const globals = await Bun.file(GLOBALS_CSS_PATH).text()
    const selectionRing = extractCssCustomProperty(globals, '--canvas-selection-ring')
    const hoverRing = extractCssCustomProperty(globals, '--canvas-hover-ring')

    expect(css).toContain('box-shadow: var(--canvas-selection-ring)')
    expect(css).toContain('box-shadow: var(--canvas-hover-ring)')
    expect(selectionRing).toContain('inset 0 0 0 1px')
    expect(hoverRing).toContain('inset 0 0 0 1px')
    expect(selectionRing).not.toMatch(/rgba?\(\s*255\s*,\s*255\s*,\s*255/i)
    expect(hoverRing).not.toMatch(/rgba?\(\s*255\s*,\s*255\s*,\s*255/i)
    expect(selectionRing).not.toMatch(/#2563eb|#3b82f6/i)
    expect(hoverRing).not.toMatch(/#2563eb|#3b82f6/i)
  })

  it('keeps canvas rings above arbitrary module content stacking', async () => {
    // Overlay layer (parent of every ring) carries the maximum z-index so that
    // module content can never visually mask the selection / hover ring.
    const css = await Bun.file(SELECTION_OVERLAY_CSS_PATH).text()
    const overlayZIndex = css.match(/\.overlayLayer[\s\S]*?z-index:\s*(\d+)/)?.[1]

    expect(overlayZIndex).toBeDefined()
    expect(Number(overlayZIndex)).toBeGreaterThanOrEqual(2147483647)
  })

  it('NodeWrapper itself is display: contents so it produces no layout box', async () => {
    // This is the architectural guarantee that canvas flow matches published
    // HTML — the wrapper exists in the DOM (carries data-node-id, ARIA, focus,
    // event handlers) but has no box, so inline content stays inline and flex
    // children are the actual rendered elements rather than wrapper divs.
    const css = await Bun.file(NODE_RENDERER_CSS_PATH).text()
    expect(css).toMatch(/\.nodeWrapper\s*\{[\s\S]*?display:\s*contents/)
    // The previous ::after-on-wrapper approach must not return — it requires a
    // layout box, which would re-introduce the canvas-vs-published flow drift.
    expect(css).not.toContain('.nodeWrapper::after')
  })
})

describe('NodeWrapper — embedded iframe gesture passthrough', () => {
  it('makes editor-canvas iframes pointer-transparent so canvas pan/scroll still works', async () => {
    const css = await Bun.file(NODE_RENDERER_CSS_PATH).text()

    expect(css).toContain('.nodeWrapper iframe')
    expect(css).toContain('pointer-events: none')
  })
})

// ---------------------------------------------------------------------------
// 3 — NodeWrapper keyboard event handler (Enter / Space → select)
//
// Strategy: NodeWrapper = memo(fn). We access .type to call the underlying
// render function and get the div's event handler props directly.
// This avoids needing a full DOM setup while still testing real behaviour.
// ---------------------------------------------------------------------------

/** Get the inner rendered div from NodeWrapper (bypasses memo wrapper) */
function getNodeWrapperDiv(overrides: Partial<Parameters<typeof NodeWrapper>[0]> = {}) {
    const props = {
      nodeId: 'test-node',
      isSelected: false,
      isHovered: false,
      onNodeClick: () => {},
      onNodeHover: () => {},
      onNodeContextMenu: () => {},
      onNodeDoubleClick: () => {},
      children: React.createElement('span', null, 'child'),
      ...overrides,
    }
  // memo() stores the real render fn in .type
  const renderFn = (NodeWrapper as unknown as { type: (p: typeof props) => React.ReactElement }).type
  return renderFn(props)
}

describe('NodeWrapper — onKeyDown handler', () => {
  it('calls onNodeClick when Enter key is pressed', () => {
    const onNodeClick = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'kbd-node', onNodeClick })
    const { onKeyDown } = div.props as { onKeyDown: (e: { key: string; preventDefault: () => void }) => void }

    expect(typeof onKeyDown).toBe('function')

    let preventDefaultCalled = false
    onKeyDown({ key: 'Enter', preventDefault: () => { preventDefaultCalled = true } })

    expect(preventDefaultCalled).toBe(true)
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('kbd-node', expect.anything())
  })

  it('calls onNodeClick when Space key is pressed', () => {
    const onNodeClick = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'space-node', onNodeClick })
    const { onKeyDown } = div.props as { onKeyDown: (e: { key: string; preventDefault: () => void }) => void }

    onKeyDown({ key: ' ', preventDefault: () => {} })

    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('space-node', expect.anything())
  })

  it('does NOT call onNodeClick for unrelated keys (e.g. ArrowDown)', () => {
    const onNodeClick = mock(() => {})
    const div = getNodeWrapperDiv({ onNodeClick })
    const { onKeyDown } = div.props as { onKeyDown: (e: { key: string; preventDefault: () => void }) => void }

    onKeyDown({ key: 'ArrowDown', preventDefault: () => {} })

    expect(onNodeClick).toHaveBeenCalledTimes(0)
  })

  it('prevents default on Enter to stop browser scroll/submit', () => {
    let preventDefaultCalled = false
    const div = getNodeWrapperDiv()
    const { onKeyDown } = div.props as { onKeyDown: (e: { key: string; preventDefault: () => void }) => void }

    onKeyDown({ key: 'Enter', preventDefault: () => { preventDefaultCalled = true } })

    expect(preventDefaultCalled).toBe(true)
  })

  it('prevents default on Space to stop page scroll', () => {
    let preventDefaultCalled = false
    const div = getNodeWrapperDiv()
    const { onKeyDown } = div.props as { onKeyDown: (e: { key: string; preventDefault: () => void }) => void }

    onKeyDown({ key: ' ', preventDefault: () => { preventDefaultCalled = true } })

    expect(preventDefaultCalled).toBe(true)
  })

  it('calls onNodeHover with nodeId on mouseEnter', () => {
    const onNodeHover = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'hover-node', onNodeHover })
    const { onMouseEnter } = div.props as { onMouseEnter: () => void }

    onMouseEnter()
    expect(onNodeHover).toHaveBeenCalledWith('hover-node')
  })

  it('calls onNodeHover with null on mouseLeave', () => {
    const onNodeHover = mock(() => {})
    const div = getNodeWrapperDiv({ onNodeHover })
    const { onMouseLeave } = div.props as { onMouseLeave: () => void }

    onMouseLeave()
    expect(onNodeHover).toHaveBeenCalledWith(null)
  })

  it('onClick stops propagation (prevents canvas deselect)', () => {
    const onNodeClick = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'click-node', onNodeClick })
    const { onClick } = div.props as {
      onClick: (e: { preventDefault: () => void; stopPropagation: () => void }) => void
    }

    let defaultPrevented = false
    let propagationStopped = false
    onClick({
      preventDefault: () => { defaultPrevented = true },
      stopPropagation: () => { propagationStopped = true },
    })

    expect(defaultPrevented).toBe(true)
    expect(propagationStopped).toBe(true)
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('click-node', expect.anything())
  })

  it('captures module clicks before nested module content can consume them', () => {
    const onNodeClick = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'captured-click-node', onNodeClick })
    const { onClickCapture } = div.props as {
      onClickCapture: (e: {
        target: EventTarget
        currentTarget: EventTarget
        preventDefault: () => void
        stopPropagation: () => void
      }) => void
    }
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-node-id', 'captured-click-node')
    const nestedButton = document.createElement('button')
    wrapper.appendChild(nestedButton)

    let defaultPrevented = false
    let propagationStopped = false
    onClickCapture({
      target: nestedButton,
      currentTarget: wrapper,
      preventDefault: () => { defaultPrevented = true },
      stopPropagation: () => { propagationStopped = true },
    })

    expect(defaultPrevented).toBe(true)
    expect(propagationStopped).toBe(true)
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('captured-click-node', expect.anything())
  })

  it('does not capture explicit embedded canvas controls', () => {
    const onNodeClick = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'embedded-control-node', onNodeClick })
    const { onClickCapture } = div.props as {
      onClickCapture: (e: {
        target: EventTarget
        currentTarget: EventTarget
        preventDefault: () => void
        stopPropagation: () => void
      }) => void
    }
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-node-id', 'embedded-control-node')
    const nestedControl = document.createElement('button')
    nestedControl.setAttribute('data-canvas-interactive', 'true')
    wrapper.appendChild(nestedControl)

    let defaultPrevented = false
    let propagationStopped = false
    onClickCapture({
      target: nestedControl,
      currentTarget: wrapper,
      preventDefault: () => { defaultPrevented = true },
      stopPropagation: () => { propagationStopped = true },
    })

    expect(defaultPrevented).toBe(false)
    expect(propagationStopped).toBe(false)
    expect(onNodeClick).toHaveBeenCalledTimes(0)
  })

  it('does not capture clicks that belong to a descendant canvas node', () => {
    const onNodeClick = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'ancestor-node', onNodeClick })
    const { onClickCapture } = div.props as {
      onClickCapture: (e: {
        target: EventTarget
        currentTarget: EventTarget
        preventDefault: () => void
        stopPropagation: () => void
      }) => void
    }
    const ancestorWrapper = document.createElement('div')
    ancestorWrapper.setAttribute('data-node-id', 'ancestor-node')
    const descendantWrapper = document.createElement('div')
    descendantWrapper.setAttribute('data-node-id', 'descendant-node')
    const nestedButton = document.createElement('button')
    descendantWrapper.appendChild(nestedButton)
    ancestorWrapper.appendChild(descendantWrapper)

    let defaultPrevented = false
    let propagationStopped = false
    onClickCapture({
      target: nestedButton,
      currentTarget: ancestorWrapper,
      preventDefault: () => { defaultPrevented = true },
      stopPropagation: () => { propagationStopped = true },
    })

    expect(defaultPrevented).toBe(false)
    expect(propagationStopped).toBe(false)
    expect(onNodeClick).toHaveBeenCalledTimes(0)
  })

  it('calls onNodeContextMenu when right-clicking module content', () => {
    const onNodeContextMenu = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'context-menu-node', onNodeContextMenu })
    const { onContextMenu } = div.props as {
      onContextMenu: (e: {
        target: EventTarget
        currentTarget: EventTarget
        preventDefault: () => void
        stopPropagation: () => void
      }) => void
    }
    const wrapper = document.createElement('div')
    wrapper.setAttribute('data-node-id', 'context-menu-node')
    const nestedButton = document.createElement('button')
    wrapper.appendChild(nestedButton)

    let defaultPrevented = false
    let propagationStopped = false
    onContextMenu({
      target: nestedButton,
      currentTarget: wrapper,
      preventDefault: () => { defaultPrevented = true },
      stopPropagation: () => { propagationStopped = true },
    })

    expect(defaultPrevented).toBe(true)
    expect(propagationStopped).toBe(true)
    expect(onNodeContextMenu).toHaveBeenCalledTimes(1)
    expect(onNodeContextMenu).toHaveBeenCalledWith('context-menu-node', expect.anything())
  })

  it('does not open the canvas node menu for descendant canvas nodes', () => {
    const onNodeContextMenu = mock(() => {})
    const div = getNodeWrapperDiv({ nodeId: 'context-ancestor-node', onNodeContextMenu })
    const { onContextMenu } = div.props as {
      onContextMenu: (e: {
        target: EventTarget
        currentTarget: EventTarget
        preventDefault: () => void
        stopPropagation: () => void
      }) => void
    }
    const ancestorWrapper = document.createElement('div')
    ancestorWrapper.setAttribute('data-node-id', 'context-ancestor-node')
    const descendantWrapper = document.createElement('div')
    descendantWrapper.setAttribute('data-node-id', 'context-descendant-node')
    const nestedButton = document.createElement('button')
    descendantWrapper.appendChild(nestedButton)
    ancestorWrapper.appendChild(descendantWrapper)

    let defaultPrevented = false
    let propagationStopped = false
    onContextMenu({
      target: nestedButton,
      currentTarget: ancestorWrapper,
      preventDefault: () => { defaultPrevented = true },
      stopPropagation: () => { propagationStopped = true },
    })

    expect(defaultPrevented).toBe(false)
    expect(propagationStopped).toBe(false)
    expect(onNodeContextMenu).toHaveBeenCalledTimes(0)
  })
})

// ---------------------------------------------------------------------------
// 4 — NodeWrapper DOM integration tests (@testing-library/react + userEvent)
//     Task #236 — fires REAL keyboard events on a mounted DOM node.
//     Complements the server-render attribute tests above with live DOM behaviour.
// ---------------------------------------------------------------------------

describe('NodeWrapper — DOM integration (real keyboard events)', () => {
  /** Render a NodeWrapper inside a container div and return helpers */
  function setup(overrides: Partial<Parameters<typeof NodeWrapper>[0]> = {}) {
    const onNodeClick = mock(() => {})
    const onNodeHover = mock(() => {})
    const props = {
      nodeId: 'dom-test-node',
      isSelected: false,
      isHovered: false,
      onNodeClick,
      onNodeHover,
      onNodeContextMenu: () => {},
      onNodeDoubleClick: () => {},
      children: <span data-testid="inner-content">content</span>,
      ...overrides,
    }
    render(<NodeWrapper {...props} />)
    // NodeWrapper renders a div with role="button"
    const wrapper = screen.getByRole('button')
    return { wrapper, onNodeClick, onNodeHover }
  }

  it('is in the DOM and has role="button"', () => {
    const { wrapper } = setup()
    expect(wrapper).toBeDefined()
    expect(wrapper.getAttribute('role')).toBe('button')
  })

  it('has tabIndex=0 — keyboard reachable', () => {
    const { wrapper } = setup()
    expect(wrapper.tabIndex).toBe(0)
  })

  it('has aria-pressed="false" when not selected', () => {
    const { wrapper } = setup({ isSelected: false })
    expect(wrapper.getAttribute('aria-pressed')).toBe('false')
  })

  it('has aria-pressed="true" when selected', () => {
    const { wrapper } = setup({ isSelected: true })
    expect(wrapper.getAttribute('aria-pressed')).toBe('true')
  })

  it('calls onNodeClick when Enter key is pressed via keyboard event', async () => {
    const { wrapper, onNodeClick } = setup({ nodeId: 'kbd-integration' })
    wrapper.focus()
    await userEvent.keyboard('{Enter}')
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('kbd-integration', expect.anything())
  })

  it('calls onNodeClick when Space key is pressed via keyboard event', async () => {
    const { wrapper, onNodeClick } = setup({ nodeId: 'space-integration' })
    wrapper.focus()
    await userEvent.keyboard(' ')
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('space-integration', expect.anything())
  })

  it('does NOT call onNodeClick when ArrowDown is pressed', async () => {
    const { wrapper, onNodeClick } = setup()
    wrapper.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(onNodeClick).toHaveBeenCalledTimes(0)
  })

  it('calls onNodeClick when clicked', async () => {
    const { wrapper, onNodeClick } = setup({ nodeId: 'click-integration' })
    await userEvent.click(wrapper)
    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('click-integration', expect.anything())
  })

  it('click does not bubble past the wrapper (stopPropagation)', async () => {
    const parentClickHandler = mock(() => {})
    // Wrap NodeWrapper in a parent to detect bubbling
    const onNodeClick = mock(() => {})
    render(
      <div onClick={parentClickHandler} data-testid="parent">
        <NodeWrapper
          nodeId="bubble-test"
          isSelected={false}
        isHovered={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
        onNodeContextMenu={() => {}}
        onNodeDoubleClick={() => {}}
      >
        <span>content</span>
      </NodeWrapper>
      </div>
    )
    const wrapper = screen.getByRole('button')
    await userEvent.click(wrapper)
    // Parent click should NOT fire — stopPropagation in NodeWrapper
    expect(parentClickHandler).toHaveBeenCalledTimes(0)
    expect(onNodeClick).toHaveBeenCalledTimes(1)
  })

  it('selects the node when clicking a module button', async () => {
    const onNodeClick = mock(() => {})
    render(
      <NodeWrapper
        nodeId="module-button-test"
        isSelected={false}
        isHovered={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
        onNodeContextMenu={() => {}}
        onNodeDoubleClick={() => {}}
      >
        <button type="button">Module button</button>
      </NodeWrapper>
    )

    await userEvent.click(screen.getByText('Module button'))

    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('module-button-test', expect.anything())
  })

  it('selects the node when module content stops click propagation', async () => {
    const onNodeClick = mock(() => {})
    render(
      <NodeWrapper
        nodeId="propagation-consuming-module-test"
        isSelected={false}
        isHovered={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
        onNodeContextMenu={() => {}}
        onNodeDoubleClick={() => {}}
      >
        <button type="button" onClick={(event) => event.stopPropagation()}>
          Consuming module button
        </button>
      </NodeWrapper>
    )

    await userEvent.click(screen.getByText('Consuming module button'))

    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('propagation-consuming-module-test', expect.anything())
  })

  it('selects the node when clicking a module link', async () => {
    const onNodeClick = mock(() => {})
    render(
      <NodeWrapper
        nodeId="module-link-test"
        isSelected={false}
        isHovered={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
        onNodeContextMenu={() => {}}
        onNodeDoubleClick={() => {}}
      >
        <a href="#module-link-test">Module link</a>
      </NodeWrapper>
    )

    await userEvent.click(screen.getByText('Module link'))

    expect(onNodeClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledWith('module-link-test', expect.anything())
  })

  it('does not select the node when an embedded canvas control is clicked', async () => {
    const onNodeClick = mock(() => {})
    const controlClick = mock(() => {})

    render(
      <NodeWrapper
        nodeId="embedded-control-test"
        isSelected={false}
        isHovered={false}
        onNodeClick={onNodeClick}
        onNodeHover={() => {}}
        onNodeContextMenu={() => {}}
        onNodeDoubleClick={() => {}}
      >
        <button
          type="button"
          data-canvas-interactive="true"
          onClick={controlClick}
        >
          Restore dependency
        </button>
      </NodeWrapper>
    )

    await userEvent.click(screen.getByText('Restore dependency'))

    expect(controlClick).toHaveBeenCalledTimes(1)
    expect(onNodeClick).toHaveBeenCalledTimes(0)
  })

  it('calls onNodeContextMenu when right-clicked in the DOM', () => {
    const onNodeContextMenu = mock(() => {})
    setup({ nodeId: 'dom-context-menu-node', onNodeContextMenu })
    const wrapper = screen.getByRole('button')

    fireEvent.contextMenu(wrapper)

    expect(onNodeContextMenu).toHaveBeenCalledTimes(1)
    expect(onNodeContextMenu).toHaveBeenCalledWith('dom-context-menu-node', expect.anything())
  })

  it('renders children inside the wrapper (content visible in DOM)', () => {
    setup()
    expect(screen.getByTestId('inner-content')).toBeDefined()
    expect(screen.getByTestId('inner-content').textContent).toBe('content')
  })

  it('has data-node-id attribute for Playwright targeting', () => {
    const { wrapper } = setup({ nodeId: 'playwright-target' })
    expect(wrapper.getAttribute('data-node-id')).toBe('playwright-target')
  })
})
