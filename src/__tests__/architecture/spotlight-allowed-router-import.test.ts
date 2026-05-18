/**
 * Architecture Gate — Spotlight router import allowlist.
 *
 * src/admin/spotlight/ is ALLOWED to import from '@admin/lib/routing' because
 * it lives in the admin shell (not in core/, modules/, or editor/).
 *
 * This test extends the constraint checked by no-router-in-site-page.test.ts:
 *   - It verifies that spotlight/ CAN import the router (positive assertion).
 *   - It verifies that core/, modules/, and editor/ (site page) still CANNOT.
 *
 * The negative side is already enforced by no-router-in-site-page.test.ts.
 * We add the positive check here so an over-zealous broadening of that test
 * would fail loudly before breaking the spotlight.
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'

const SRC_ROOT = join(import.meta.dir, '../../')
const SPOTLIGHT_DIR = join(SRC_ROOT, 'admin/spotlight')

const ROUTER_IMPORT_RE =
  /from\s+['"](?:@admin\/lib\/routing|(?:[./]+)admin\/lib\/routing)['"]/

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTsFiles(full))
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      results.push(full)
    }
  }
  return results
}

describe('Spotlight router import policy', () => {
  it('src/admin/spotlight/ is allowed to import @admin/lib/routing', () => {
    // Positive assertion: at least one spotlight file imports the router.
    // This confirms the allow-list is working as intended and nobody
    // accidentally moved spotlight out of admin/.
    const files = collectTsFiles(SPOTLIGHT_DIR)
    const importers = files.filter((f) =>
      ROUTER_IMPORT_RE.test(readFileSync(f, 'utf8')),
    )
    // SpotlightProvider.tsx imports the router — if this list is empty,
    // something has been refactored incorrectly.
    expect(importers.length).toBeGreaterThanOrEqual(1)
  })

  it('src/admin/spotlight/ does not import react-router-dom (only the in-house router)', () => {
    const files = collectTsFiles(SPOTLIGHT_DIR)
    const violations = files.filter((f) =>
      /from\s+['"]react-router-dom['"]/.test(readFileSync(f, 'utf8')),
    )

    if (violations.length > 0) {
      throw new Error(
        '[spotlight] Use @admin/lib/routing instead of react-router-dom:\n' +
          violations.map((f) => `  ${f.replace(SRC_ROOT, 'src/')}`).join('\n'),
      )
    }

    expect(violations).toHaveLength(0)
  })
})
