import { describe, expect, it } from 'bun:test'
import { generateCanvasClassCSS } from '../../editor/components/Canvas/canvasClassCss'
import { generateFrameworkColorUtilityClasses } from '@core/framework/colors'
import type { CSSClass } from '@core/page-tree/types'

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
