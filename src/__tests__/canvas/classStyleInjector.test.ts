import { describe, expect, it } from 'bun:test'
import { generateCanvasClassCSS } from '../../editor/components/Canvas/canvasClassCss'
import { generateFrameworkColorUtilityClasses } from '@core/framework/colors'
import type { CSSClass } from '@core/page-tree/schemas'

function makeClass(
  id: string,
  styles: CSSClass['styles'],
  breakpointStyles: CSSClass['breakpointStyles'] = {},
): CSSClass {
  return {
    id,
    name: id,
    styles,
    breakpointStyles,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('generateCanvasClassCSS', () => {
  it('prepends the publisher reset scoped to the breakpoint frame so canvas matches published', () => {
    const css = generateCanvasClassCSS({}, [])

    // Reset rules are scoped under [data-breakpoint-id] so they only affect
    // canvas content — editor chrome (panels, toolbars) keeps its own globals.
    expect(css).toContain('[data-breakpoint-id]')
    expect(css).toContain(':where(*, *::before, *::after) { box-sizing: border-box; }')
    expect(css).toContain(':where(*) { margin: 0; padding: 0; }')
    expect(css).toContain('font-family: system-ui')
  })

  it('overrides the editor body color in the canvas viewport so unstyled text is readable', () => {
    // The editor's globals.css sets body color to a near-white token for the
    // dark editor chrome (`--editor-text: #ededed`). That color cascades into
    // the canvas viewport (which has a white background) and would render
    // unstyled headings invisibly white-on-white. The scoped canvas reset
    // pins `color: #000` so canvas content reads the same black-on-white as
    // the published page (where UA defaults give that color naturally).
    const css = generateCanvasClassCSS({}, [])
    expect(css).toMatch(/\[data-breakpoint-id\][^{]*\{[^}]*color:\s*#000/)
  })

  it('scopes breakpoint class styles to their canvas frame instead of viewport media queries', () => {
    const css = generateCanvasClassCSS(
      {
        title: makeClass('title', { fontSize: '64px' }, {
          mobile: { fontSize: '36px' },
        }),
      },
      [{ id: 'mobile', width: 375 }],
    )

    expect(css).toContain('.title')
    expect(css).toContain('font-size: 64px')
    expect(css).toContain('[data-breakpoint-id="mobile"] .title')
    expect(css).toContain('font-size: 36px')
    expect(css).not.toContain('@media')
  })

  it('includes framework color variables for editor preview', () => {
    const colors = {
      tokens: [
        {
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
          updatedAt: 1,
        },
      ],
    }

    const css = generateCanvasClassCSS(
      generateFrameworkColorUtilityClasses(colors),
      [],
      colors,
    )

    expect(css).toContain(':root.theme-alt')
    expect(css).not.toContain('theme-dark')
    expect(css).toContain('--primary: hsla(238, 100%, 62%, 1);')
    expect(css).toContain('.text-primary')
    expect(css).toContain('color: var(--primary);')
  })
})
