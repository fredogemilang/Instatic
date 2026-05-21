/**
 * Architecture gate — undo history is centralized.
 *
 * SiteDocument writes should use the shared site mutation helpers instead of
 * calling `pushHistory()` directly from feature slices. The helpers own the
 * history/dirty/timestamp contract and can distinguish semantic no-ops from
 * real document changes.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join, relative } from 'path'

const ROOT = join(import.meta.dir, '../../../')
const SLICE_FILES = [
  'src/admin/pages/site/store/slices/classSlice.ts',
  'src/admin/pages/site/store/slices/clipboardSlice.ts',
  'src/admin/pages/site/store/slices/sitePanelSlice.ts',
]

describe('Centralized SiteDocument mutation history', () => {
  it('feature slices do not call pushHistory directly', () => {
    const offenders = SLICE_FILES.flatMap((file) => {
      const path = join(ROOT, file)
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(/\bpushHistory\s*\(/g)].map(
        (match) => `${relative(ROOT, path)}:${source.slice(0, match.index).split('\n').length}`,
      )
    })

    expect(offenders).toEqual([])
  })
})
