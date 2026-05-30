/**
 * parseStyleRule — conditional style layers (CSS fidelity plan, Part 2a).
 *
 * Verifies the tolerant parser round-trips conditionalLayers, backfills the
 * absent field to undefined on legacy data, and drops malformed layers.
 */

import { describe, it, expect } from 'bun:test'
import { parseStyleRule } from '@core/page-tree/styleRule'

function baseRaw(extra: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    name: 'foo',
    kind: 'class',
    selector: '.foo',
    order: 0,
    styles: { color: 'red' },
    breakpointStyles: {},
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }
}

describe('parseStyleRule — conditionalLayers', () => {
  it('legacy rule without the field → conditionalLayers is absent', () => {
    const rule = parseStyleRule(baseRaw())
    expect(rule).not.toBeNull()
    expect(rule!.conditionalLayers).toBeUndefined()
  })

  it('round-trips a media / container / supports layer set', () => {
    const rule = parseStyleRule(
      baseRaw({
        conditionalLayers: [
          { id: 'm1', condition: { kind: 'media', query: '(orientation: landscape)' }, styles: { color: 'blue' }, order: 0 },
          { id: 'c1', condition: { kind: 'container', name: 'sidebar', query: 'min-width: 400px' }, styles: { display: 'grid' }, order: 1 },
          { id: 's1', condition: { kind: 'supports', query: '(display: grid)' }, styles: { gap: '8px' }, order: 2 },
        ],
      }),
    )
    expect(rule!.conditionalLayers).toHaveLength(3)
    expect(rule!.conditionalLayers![0].condition).toEqual({ kind: 'media', query: '(orientation: landscape)' })
    expect(rule!.conditionalLayers![1].condition).toEqual({ kind: 'container', name: 'sidebar', query: 'min-width: 400px' })
    expect(rule!.conditionalLayers![2].condition).toEqual({ kind: 'supports', query: '(display: grid)' })
  })

  it('drops layers with a missing id or unknown condition kind', () => {
    const rule = parseStyleRule(
      baseRaw({
        conditionalLayers: [
          { condition: { kind: 'media', query: '(x)' }, styles: {} },            // no id
          { id: 'bad', condition: { kind: 'totally-made-up', query: '(x)' }, styles: {} }, // bad kind
          { id: 'ok', condition: { kind: 'media', query: '(min-width: 1px)' }, styles: { color: 'red' } },
        ],
      }),
    )
    expect(rule!.conditionalLayers).toHaveLength(1)
    expect(rule!.conditionalLayers![0].id).toBe('ok')
  })

  it('a breakpoint-kind condition round-trips', () => {
    const rule = parseStyleRule(
      baseRaw({
        conditionalLayers: [
          { id: 'b1', condition: { kind: 'breakpoint', breakpointId: 'tablet' }, styles: { color: 'red' }, order: 0 },
        ],
      }),
    )
    expect(rule!.conditionalLayers![0].condition).toEqual({ kind: 'breakpoint', breakpointId: 'tablet' })
  })
})
