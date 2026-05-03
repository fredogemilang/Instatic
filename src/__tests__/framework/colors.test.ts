import { describe, expect, it } from 'bun:test'
import type { FrameworkColorSettings } from '@core/framework/colors'
import {
  generateFrameworkColorRootCss,
  generateFrameworkColorUtilityClasses,
  generateFrameworkColorVariableSets,
  normalizeFrameworkColorSlug,
} from '@core/framework/colors'

function makeColorSettings(overrides: Partial<FrameworkColorSettings> = {}): FrameworkColorSettings {
  return {
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
          background: true,
          border: true,
          fill: true,
        },
        generateTransparent: true,
        generateShades: { enabled: true, count: 2 },
        generateTints: { enabled: true, count: 2 },
        order: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    ...overrides,
  }
}

describe('framework color generation', () => {
  it('normalizes color slugs to Core Framework-compatible names', () => {
    expect(normalizeFrameworkColorSlug(' Primary Color ')).toBe('primary-color')
    expect(normalizeFrameworkColorSlug('--color-primary')).toBe('color-primary')
    expect(normalizeFrameworkColorSlug('Accent/Hot Pink!')).toBe('accent-hot-pink')
    expect(normalizeFrameworkColorSlug('---')).toBe('color')
  })

  it('generates base, transparent, shade, and tint variables in stable order', () => {
    const sets = generateFrameworkColorVariableSets(makeColorSettings())
    expect(sets.light.map((variable) => variable.name)).toEqual([
      '--primary',
      '--primary-5',
      '--primary-10',
      '--primary-20',
      '--primary-30',
      '--primary-40',
      '--primary-50',
      '--primary-60',
      '--primary-70',
      '--primary-80',
      '--primary-90',
      '--primary-d-1',
      '--primary-d-2',
      '--primary-l-1',
      '--primary-l-2',
    ])
    expect(sets.light.find((variable) => variable.name === '--primary-20')?.value).toBe('hsla(238, 100%, 62%, 0.2)')
    expect(sets.dark.find((variable) => variable.name === '--primary')?.value).toBe('hsla(238, 100%, 42%, 1)')
    expect(sets.dark.find((variable) => variable.name === '--primary-50')?.value).toBe('hsla(238, 100%, 42%, 0.5)')
  })

  it('emits theme scopes with theme-default and theme-alt class names', () => {
    const css = generateFrameworkColorRootCss(makeColorSettings())
    expect(css).toContain(':root.theme-alt')
    expect(css).toContain(':root.theme-default .theme-inverted')
    expect(css).toContain(':root.theme-alt .theme-inverted .theme-always-alt')
    expect(css).not.toContain('theme-dark')
    expect(css).not.toContain('theme-light')
    expect(css).not.toContain('color-scheme: dark')
    expect(css).not.toContain('cf-theme')
    expect(css).toContain('--primary: hsla(238, 100%, 62%, 1);')
    expect(css).toContain('--primary: hsla(238, 100%, 42%, 1);')
  })

  it('generates locked utility classes with stable ids and variant names', () => {
    const settings = makeColorSettings()
    const classes = generateFrameworkColorUtilityClasses(settings)

    expect(classes['framework:color:primary-token:base:text']).toMatchObject({
      id: 'framework:color:primary-token:base:text',
      name: 'text-primary',
      styles: { color: 'var(--primary)' },
      generated: {
        origin: 'framework',
        family: 'color',
        sourceId: 'primary-token',
        utility: 'text',
        tokenName: 'primary',
        locked: true,
      },
    })
    expect(classes['framework:color:primary-token:base:background'].styles).toEqual({ backgroundColor: 'var(--primary)' })
    expect(classes['framework:color:primary-token:base:border'].styles).toEqual({ borderColor: 'var(--primary)' })
    expect(classes['framework:color:primary-token:base:fill'].styles).toEqual({ fill: 'var(--primary)' })
    expect(classes['framework:color:primary-token:transparent-20:text'].name).toBe('text-primary-20')
    expect(classes['framework:color:primary-token:shade-1:background'].name).toBe('bg-primary-d-1')
    expect(classes['framework:color:primary-token:tint-2:border'].name).toBe('border-primary-l-2')

    const renamed = generateFrameworkColorUtilityClasses({
      ...settings,
      tokens: [{ ...settings.tokens[0], slug: 'brand-primary' }],
    })
    expect(renamed['framework:color:primary-token:base:text'].name).toBe('text-brand-primary')
  })
})
