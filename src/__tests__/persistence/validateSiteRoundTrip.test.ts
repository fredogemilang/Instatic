/**
 * validateSite — round-trip and negative tests (Step 5 / Constraint #230)
 *
 * Round-trip: a fully-populated fixture survives validateSite() unchanged.
 * Negative: targeted failures each exercise a specific domain post-check rule.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { validateSite, SiteValidationError } from '@core/persistence/validate'

// ---------------------------------------------------------------------------
// Fixture loader
// ---------------------------------------------------------------------------

const fixturePath = join(import.meta.dir, 'roundTripFixture.json')
const fixtureRaw = readFileSync(fixturePath, 'utf-8')

function loadFixture(): unknown {
  return JSON.parse(fixtureRaw)
}

// ---------------------------------------------------------------------------
// Round-trip test
// ---------------------------------------------------------------------------

describe('validateSite — round-trip with representative fixture', () => {
  it('survives validateSite() and deep-equals the source fixture', () => {
    const raw = loadFixture()
    const result = validateSite(raw)
    // JSON round-trip strips undefined optional-absent fields so the comparison
    // matches raw (which also never has undefined keys, being parsed JSON).
    expect(JSON.parse(JSON.stringify(result))).toEqual(raw)
  })

  it('preserves all three generated class metadata families (color, typography, spacing)', () => {
    const result = validateSite(loadFixture())
    expect(result.classes['class-color'].generated?.family).toBe('color')
    expect(result.classes['class-typography'].generated?.family).toBe('typography')
    expect(result.classes['class-spacing'].generated?.family).toBe('spacing')
  })

  it('preserves propBindings on page nodes', () => {
    const result = validateSite(loadFixture())
    const node = result.pages[0].nodes['heading-1']
    expect(node.propBindings).toEqual({
      text:  { paramId: 'param-title' },
      extra: { paramId: 'param-desc' },
    })
  })

  it('preserves the VC rootNode childNodes tree', () => {
    const result = validateSite(loadFixture())
    const rootNode = result.visualComponents[0].rootNode
    expect(rootNode.childNodes).toHaveLength(1)
    expect((rootNode.childNodes as Array<{ id: string }>)[0].id).toBe('vc-child-1')
  })

  it('preserves the page template config including conditions', () => {
    const result = validateSite(loadFixture())
    expect(result.pages[0].template?.enabled).toBe(true)
    expect(result.pages[0].template?.conditions).toHaveLength(1)
    expect(result.pages[0].template?.conditions[0].operator).toBe('equals')
  })

  it('preserves non-empty breakpoints', () => {
    const result = validateSite(loadFixture())
    expect(result.breakpoints).toHaveLength(2)
    expect(result.breakpoints[0].id).toBe('mobile')
  })

  it('preserves non-default runtime (dep-lock + script)', () => {
    const result = validateSite(loadFixture())
    expect(result.runtime.dependencyLock.packages['three']?.version).toBe('0.160.0')
    expect(result.runtime.scripts['script-1']?.placement).toBe('body-end')
  })

  it('preserves non-default packageJson dependencies', () => {
    const result = validateSite(loadFixture())
    expect(result.packageJson.dependencies['three']).toBe('^0.160.0')
  })

  it('preserves the SiteFile with normalized path', () => {
    const result = validateSite(loadFixture())
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe('src/components/MyButton.tsx')
  })

  it('preserves framework preferences (non-default values if set)', () => {
    const result = validateSite(loadFixture())
    expect(result.settings.framework?.preferences?.rootFontSize).toBe(10)
    expect(result.settings.framework?.preferences?.isRem).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Negative tests — each exercises a specific domain post-check rule
// ---------------------------------------------------------------------------

describe('validateSite — negative: bad VC name is silently dropped (rule 4)', () => {
  it('VC with empty name is dropped; valid VCs survive', () => {
    const raw = loadFixture() as Record<string, unknown>
    const fixture = raw as { visualComponents: Array<Record<string, unknown>> }
    // Prepend an invalid VC (whitespace-only name) before the valid one
    fixture.visualComponents = [
      { id: 'vc-bad', name: '   ', rootNode: { id: 'n', moduleId: 'base.text', props: {}, breakpointOverrides: {}, children: [], classIds: [] }, params: [], breakpoints: [], classIds: [], createdAt: 1700000000000 },
      ...fixture.visualComponents,
    ]
    const result = validateSite(raw)
    expect(result.visualComponents.some((vc) => vc.name.trim().length === 0)).toBe(false)
    expect(result.visualComponents.some((vc) => vc.name === 'MyCard')).toBe(true)
  })
})

describe('validateSite — negative: duplicate page slug throws (rules 1–2)', () => {
  it('throws SiteValidationError with path site.pages[1].slug', () => {
    const raw = loadFixture() as { pages: Array<Record<string, unknown>> }
    // Add a second page with the same slug as page-home
    raw.pages.push({
      id: 'page-dup',
      slug: 'index',
      title: 'Duplicate Home',
      rootNodeId: 'root-dup',
      nodes: {
        'root-dup': { id: 'root-dup', moduleId: 'base.body', props: {}, breakpointOverrides: {}, children: [], classIds: [] },
      },
    })
    expect(() => validateSite(raw)).toThrow(SiteValidationError)
    try {
      validateSite(raw)
    } catch (e) {
      expect((e as SiteValidationError).message).toContain('duplicate slug')
      // pages[0] has slug 'index'; pages[2] also has slug 'index'.
      // The check fires at [0] since pageSlugDuplicateError finds a later page with
      // the same slug — path is the FIRST page whose slug is duplicated.
      expect((e as SiteValidationError).path).toBe('site.pages[0].slug')
    }
  })
})

describe('validateSite — negative: malformed propBindings entry silently dropped (rule 5.3)', () => {
  it('bad entry is dropped; valid entry survives intact', () => {
    const raw = loadFixture() as { pages: Array<{ nodes: Record<string, Record<string, unknown>> }> }
    // Inject a mix of good + bad propBindings on heading-1
    raw.pages[0].nodes['heading-1'].propBindings = {
      text:    { paramId: 'param-title' },   // valid
      badKey:  'not-an-object',              // invalid — should be dropped
      anotherBad: { wrongField: 'x' },       // invalid — missing paramId
      extra:   { paramId: 'param-desc' },    // valid
    }
    const result = validateSite(raw)
    const bindings = result.pages[0].nodes['heading-1'].propBindings
    expect(bindings).toEqual({
      text:  { paramId: 'param-title' },
      extra: { paramId: 'param-desc' },
    })
  })
})

describe('validateSite — negative: unsafe SiteFile path is silently dropped (rule 3)', () => {
  it('file with directory traversal is dropped; safe files survive', () => {
    const raw = loadFixture() as { files: Array<Record<string, unknown>> }
    raw.files.push({
      id: 'evil',
      path: '../../../etc/passwd',
      type: 'script',
      content: '',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    })
    const result = validateSite(raw)
    expect(result.files.some((f) => f.path.includes('passwd'))).toBe(false)
    expect(result.files.some((f) => f.path === 'src/components/MyButton.tsx')).toBe(true)
  })

  it('throws SiteValidationError with correct path for reserved-word slug', () => {
    const raw = loadFixture() as { pages: Array<Record<string, unknown>> }
    raw.pages[0].slug = 'admin'
    try {
      validateSite(raw)
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(SiteValidationError)
      expect((e as SiteValidationError).path).toBe('site.pages[0].slug')
      expect((e as SiteValidationError).message).toContain('reserved')
    }
  })
})
