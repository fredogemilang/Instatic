/**
 * Architecture Gate — Bundle size budgets
 *
 * Locks in the production bundle sizes that the editor's first-paint cost
 * depends on. A static cap per chunk catches the silent-regression case
 * where a refactor pulls a heavy dependency into the eager admin graph
 * (e.g. a stray `import { EditorView } from '@codemirror/view'` in an
 * eager file, or a sidebar control hoisting the entire properties panel
 * into a sibling chunk).
 *
 * Why these chunks
 * ----------------
 * `index` and `react-vendor` are downloaded on **every** admin first paint
 * — they are the cost of opening any /admin route. `layouts` is downloaded
 * on every authenticated /admin route (Site, Content, Plugins, Users,
 * Account, plugin pages all import from `@admin/layouts/`), so it is the
 * second tier of "always pays it" code. `validation-vendor`, `dnd-vendor`,
 * and `state-vendor` are split into stable vendor chunks for long-term
 * caching (see vite.config.ts `vendorChunkName`); they ship with the same
 * cadence as `index` so we budget them too.
 *
 * `CodeMirrorEditor` is the heaviest lazy chunk and the most attractive
 * target for regression (a single static import unifies it with `index`
 * — the codemirror-lazy-only gate prevents that *path*, this gate
 * prevents the *size* from growing unnoticed).
 *
 * Why static byte caps rather than diff-against-baseline
 * ------------------------------------------------------
 * A diff approach would need a stored baseline file in the repo, which
 * thrashes on every PR. A static cap with ~5–10% headroom over the
 * current size gives a clear "you broke the bundle" signal without
 * spurious churn. When a chunk is *intentionally* reduced (e.g. lifting
 * the editor store out of AdminPageLayout), lower the cap in the same PR
 * — that's a one-line change that documents the win.
 *
 * Build artefact discovery
 * ------------------------
 * Vite emits hashed names: `layouts-CSneVf19.js`. We match by stable
 * prefix (`layouts-`) and resolve the hashed filename at test time.
 *
 * Dev workflow note
 * -----------------
 * `dist/assets/` only exists after `bun run build`. When dist is absent
 * the gate self-skips with a console warning rather than failing — the
 * canonical way to run this gate is `bun run test:bundle`, which builds
 * first. In CI, the build step is mandatory before tests, so the gate
 * is always active there.
 *
 * @see vite.config.ts — vendor chunk groups (long-term cache strategy)
 * @see codemirror-lazy-only.test.ts — sibling gate (lazy boundary protection)
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, statSync, existsSync } from 'fs'
import { join } from 'path'

const REPO_ROOT = join(import.meta.dir, '../../../')
const DIST_ASSETS = join(REPO_ROOT, 'dist/assets')

interface ChunkBudget {
  /** Stable prefix of the chunk filename (Vite appends `-<hash>.js`). */
  prefix: string
  /** Maximum allowed size in bytes (raw, post-minify, pre-gzip). */
  maxBytes: number
  /** One-line note explaining the budget and current size. */
  rationale: string
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------
//
// Sizes captured from `bun run build` (rolldown, production mode).
// Each cap allows ~7-10% headroom over current — enough to absorb a small
// refactor without spurious failures, tight enough to catch a real
// regression. Update caps DOWN when a chunk is intentionally shrunk.
// ---------------------------------------------------------------------------
const BUDGETS: ChunkBudget[] = [
  // Top-level eager chunks (loaded on every /admin first paint).
  {
    prefix: 'index-',
    maxBytes: 230_000,
    rationale: 'admin entry chunk (current ~211 KB raw / 61 KB gzipped)',
  },
  {
    prefix: 'react-vendor-',
    maxBytes: 200_000,
    rationale: 'react + react-dom (current ~179 KB raw / 57 KB gzipped)',
  },
  {
    prefix: 'validation-vendor-',
    maxBytes: 110_000,
    rationale: '@sinclair/typebox (current ~95 KB raw / 23 KB gzipped)',
  },
  {
    prefix: 'dnd-vendor-',
    maxBytes: 95_000,
    rationale: '@dnd-kit/core + @use-gesture (current ~80 KB raw / 25 KB gzipped)',
  },
  {
    prefix: 'state-vendor-',
    maxBytes: 40_000,
    rationale: 'dompurify + immer (current ~32 KB raw / 12 KB gzipped)',
  },

  // Editor shell — loaded eagerly only on canvas pages (Site / Content /
  // Data / Media). Contains the canvas, every panel, the property
  // controls, every first-party module, and the publisher graph. Plugin /
  // Users / Account / plugin admin pages do NOT pull this chunk.
  {
    prefix: 'AdminCanvasLayout-',
    // Pre-release allowance after React-Compiler helper-hoisting work (~45 inline handlers hoisted to module-level); parallel sessions #1607/#1580 may push it further.
    maxBytes: 770_000,
    rationale:
      'editor shell (canvas + panels + modules + publisher). Current ' +
      '~731 KB raw / gzipped ~245 KB. Includes React Compiler overhead ' +
      '(`useMemoCache` calls per component, ~30% bundle growth) and the ' +
      'module-engine default-props layer added to all base modules. Only the ' +
      'four canvas-capable routes import this chunk via the direct deep ' +
      'import `@admin/layouts/AdminCanvasLayout`.',
  },

  // Admin shell — the lightweight layout for non-canvas admin pages.
  // Must stay TINY: every byte added here ships on every non-editor admin
  // page (Plugins / Users / Account / plugin admin pages).
  {
    prefix: 'AdminPageLayout-',
    maxBytes: 12_000,
    rationale:
      'lightweight admin shell — toolbar + page header + settings modal ' +
      'mount gate. Current ~4 KB raw / 2 KB gzipped. Reads adminUi (tiny ' +
      'Zustand store) for site name + settings modal flag, fetched via ' +
      '`useSiteSummary` (lightweight cmsAdapter call) instead of ' +
      '`usePersistence`. This chunk MUST NOT pull `@site/store/store` ' +
      '— if it grows past ~12 KB, an admin-shell consumer almost ' +
      'certainly re-introduced the editor store dependency.',
  },

  // Heaviest lazy chunk — protected by the codemirror-lazy-only gate at the
  // import boundary, and by this size cap against silent CM6 dep upgrades.
  {
    prefix: 'CodeMirrorEditor-',
    maxBytes: 700_000,
    rationale:
      'lazy CodeMirror 6 chunk (current ~674 KB raw / ~230 KB gzipped). ' +
      'Only loaded when a user opens a text file in the code editor panel. ' +
      'Grew from ~606 KB when @codemirror/lang-html (bundling embedded CSS + ' +
      'JS grammar) was added for the HTML-import editor.',
  },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findChunk(prefix: string): { path: string; size: number } | null {
  if (!existsSync(DIST_ASSETS)) return null
  const matches = readdirSync(DIST_ASSETS).filter(
    (f) => f.startsWith(prefix) && f.endsWith('.js'),
  )
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new Error(
      `[bundle-size-budgets] Found ${matches.length} files matching prefix ` +
      `"${prefix}" in dist/assets/: ${matches.join(', ')}. Expected exactly one.`,
    )
  }
  const path = join(DIST_ASSETS, matches[0]!)
  return { path, size: statSync(path).size }
}

function formatKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bundle size budgets', () => {
  if (!existsSync(DIST_ASSETS)) {
    it.skip('skipped: dist/assets/ not present — run `bun run build` first (or use `bun run test:bundle`)', () => {})
    // Surface the skip visibly so it's obvious in CI / local runs why this
    // gate didn't enforce anything. Matches the Phase G pre-registered gate
    // pattern (console.log when an architecture gate is dormant).
    console.warn(
      '[bundle-size-budgets] dist/assets/ missing — bundle gates skipped. ' +
      'Run `bun run build` first, or use `bun run test:bundle` to build+test.',
    )
    return
  }

  for (const budget of BUDGETS) {
    it(`${budget.prefix}*.js stays under ${formatKB(budget.maxBytes)}`, () => {
      const chunk = findChunk(budget.prefix)
      if (!chunk) {
        throw new Error(
          `[bundle-size-budgets] Expected chunk "${budget.prefix}*.js" not found ` +
          `in dist/assets/. If this chunk was intentionally removed or renamed, ` +
          `update src/__tests__/architecture/bundle-size-budgets.test.ts.`,
        )
      }
      if (chunk.size > budget.maxBytes) {
        throw new Error(
          `[bundle-size-budgets] ${budget.prefix}*.js exceeds budget.\n` +
          `  actual:    ${formatKB(chunk.size)} (${chunk.size} B)\n` +
          `  budget:    ${formatKB(budget.maxBytes)} (${budget.maxBytes} B)\n` +
          `  rationale: ${budget.rationale}\n\n` +
          `Either (a) split the new dependency behind a lazy boundary, or ` +
          `(b) raise the cap with a one-line note in this test file ` +
          `explaining why the growth is intentional.`,
        )
      }
      expect(chunk.size).toBeLessThanOrEqual(budget.maxBytes)
    })
  }
})
