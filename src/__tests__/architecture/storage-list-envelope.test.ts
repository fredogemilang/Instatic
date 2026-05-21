/**
 * Architecture Source-Scan — Storage list() Envelope Enforcement
 *
 * `cms.storage.collection().list()` returns `{ records, totalCount }` — NOT a
 * bare array. This test guards against regressions where a caller treats the
 * result as an array by chaining array methods directly on the .list() return
 * value within the same expression.
 *
 * SCAN ROOT:
 *   examples/plugins/ * /server/**   — plugin server-side code
 *
 * WHAT IS BANNED (per-line check, comments stripped):
 *   .list(...).filter(    direct .filter() chain on list result
 *   .list(...).find(      direct .find() chain
 *   .list(...).map(       direct .map() chain
 *   .list(...).forEach(   direct .forEach() chain
 *   .list(...).slice(     direct .slice() chain
 *   .list(...).reduce(    direct .reduce() chain
 *   .list(...).length     direct .length access
 *   .list(...)[<digit>    direct numeric-index access
 *
 * WHAT IS REQUIRED:
 *   Always destructure: const { records } = await ...list()
 *   or:                 const { records, totalCount } = await ...list()
 *
 * ADDITIONALLY:
 *   Asserts that StorageListResultSchema in src/core/plugin-sdk/storageSchemas.ts
 *   declares both `records` and `totalCount` properties — the canonical shape
 *   contract for the envelope.
 *
 * @see src/core/plugin-sdk/storageSchemas.ts — StorageListResultSchema
 */

import { describe, it, expect } from 'bun:test'
import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { extname, join, relative } from 'path'

const PROJECT_ROOT = join(import.meta.dir, '../../../')
const EXAMPLES_PLUGINS_ROOT = join(PROJECT_ROOT, 'examples/plugins')
const STORAGE_SCHEMAS_FILE = join(
  PROJECT_ROOT,
  'src/core/plugin-sdk/storageSchemas.ts',
)

// ---------------------------------------------------------------------------
// File walker — .ts files only, recursive
// ---------------------------------------------------------------------------

function walkTS(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      walkTS(full, out)
    } else if (extname(entry) === '.ts') {
      out.push(full)
    }
  }
  return out
}

/** Collect all server .ts files from examples/plugins/<plugin>/server/** */
function collectPluginServerFiles(): string[] {
  const result: string[] = []
  if (!existsSync(EXAMPLES_PLUGINS_ROOT)) return result
  for (const plugin of readdirSync(EXAMPLES_PLUGINS_ROOT)) {
    const serverDir = join(EXAMPLES_PLUGINS_ROOT, plugin, 'server')
    if (existsSync(serverDir) && statSync(serverDir).isDirectory()) {
      walkTS(serverDir, result)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Comment stripper — preserves line numbers by replacing non-newline chars
// ---------------------------------------------------------------------------

const COMMENT_RE = /\/\/.*$|\/\*[\s\S]*?\*\//gm

function stripComments(src: string): string {
  return src.replace(COMMENT_RE, (m) => m.replace(/[^\n]/g, ' '))
}

// ---------------------------------------------------------------------------
// Violation patterns
//
// Each regex checks for a .list() call on a line that ALSO directly chains an
// array accessor on its result — i.e., .list(args).someArrayMethod(...) within
// the same source line (after comment stripping).
//
// The regex uses greedy .* for the argument span; because .* doesn't cross
// line boundaries this reliably detects single-line chaining while ignoring
// the common multiline `const { records } = await col\n  .list({...})` form.
// ---------------------------------------------------------------------------

interface ForbiddenChain {
  name: string
  regex: RegExp
}

const FORBIDDEN_CHAINS: ForbiddenChain[] = [
  {
    name: 'direct .filter() chain — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\.\s*filter\s*\(/,
  },
  {
    name: 'direct .find() chain — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\.\s*find\s*\(/,
  },
  {
    name: 'direct .map() chain — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\.\s*map\s*\(/,
  },
  {
    name: 'direct .forEach() chain — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\.\s*forEach\s*\(/,
  },
  {
    name: 'direct .slice() chain — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\.\s*slice\s*\(/,
  },
  {
    name: 'direct .reduce() chain — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\.\s*reduce\s*\(/,
  },
  {
    name: 'direct .length access — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\.\s*length\b/,
  },
  {
    name: 'direct index access [N] — use const { records } = await ...list()',
    regex: /\.list\s*\(.*\)\s*\[\s*\d/,
  },
]

// ---------------------------------------------------------------------------
// Violation record
// ---------------------------------------------------------------------------

interface Violation {
  file: string
  line: number
  pattern: string
  text: string
}

function scanForViolations(): Violation[] {
  const files = collectPluginServerFiles()
  const violations: Violation[] = []

  for (const file of files) {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    const lines = stripComments(content).split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes('.list(')) continue

      for (const { name, regex } of FORBIDDEN_CHAINS) {
        if (regex.test(line)) {
          violations.push({
            file: relative(PROJECT_ROOT, file),
            line: i + 1,
            pattern: name,
            text: line.trim(),
          })
          break // one violation per line is enough
        }
      }
    }
  }

  return violations
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Storage list() envelope — examples/plugins/*/server/**', () => {
  it('has at least one plugin server file to scan (sanity check)', () => {
    const files = collectPluginServerFiles()
    if (files.length === 0) {
      throw new Error(
        '[storage-list-envelope] No plugin server files found under examples/plugins/*/server/. ' +
          'Update EXAMPLES_PLUGINS_ROOT or the plugin folder layout if the structure has changed.',
      )
    }
    expect(files.length).toBeGreaterThan(0)
  })

  it('no .list() call chains an array method or accessor directly on its result', () => {
    const violations = scanForViolations()

    if (violations.length === 0) {
      expect(violations).toHaveLength(0)
      return
    }

    const lines = violations.map(
      (v) =>
        `  ${v.file}:${v.line} — ${v.pattern}\n` +
        `    ${v.text}`,
    )

    throw new Error(
      `[storage-list-envelope] ${violations.length} violation(s): .list() result treated as a bare array.\n` +
        `list() returns { records, totalCount } — destructure before accessing records:\n` +
        `  const { records } = await col.list()\n` +
        `  const { records, totalCount } = await col.list(options)\n\n` +
        `Violations:\n` +
        lines.join('\n'),
    )
  })

  it('StorageListResultSchema declares both records and totalCount', () => {
    const source = readFileSync(STORAGE_SCHEMAS_FILE, 'utf8')

    // Locate the schema object block starting from `StorageListResultSchema`
    const schemaMatch = source.match(
      /StorageListResultSchema\s*=\s*Type\.Object\s*\(\s*\{([\s\S]*?)\}\s*\)/,
    )

    if (!schemaMatch) {
      throw new Error(
        `[storage-list-envelope] StorageListResultSchema not found in ${STORAGE_SCHEMAS_FILE}. ` +
          'The schema or its name may have been changed; update this test accordingly.',
      )
    }

    const schemaBody = schemaMatch[1]

    const hasRecords = /\brecords\s*:/.test(schemaBody)
    const hasTotalCount = /\btotalCount\s*:/.test(schemaBody)

    if (!hasRecords) {
      throw new Error(
        '[storage-list-envelope] StorageListResultSchema is missing the `records` property. ' +
          'Callers destructure `const { records } = await ...list()` — the property must exist.',
      )
    }
    if (!hasTotalCount) {
      throw new Error(
        '[storage-list-envelope] StorageListResultSchema is missing the `totalCount` property. ' +
          'Callers destructure `const { records, totalCount } = await ...list()` — the property must exist.',
      )
    }

    expect(hasRecords).toBe(true)
    expect(hasTotalCount).toBe(true)
  })
})
