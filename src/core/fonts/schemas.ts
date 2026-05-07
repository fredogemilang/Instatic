/**
 * Fonts — TypeBox schemas and derived types.
 *
 * Schemas are the source of truth. Types are derived via `Static<typeof T>`.
 * No parallel TypeScript interfaces — schema definitions ARE the contract.
 *
 * Constraint #269: no imports from editor / editor-store here.
 */

import { Type, type Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { withFallback, filterArray } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// FontSource
// ---------------------------------------------------------------------------

export const FontSourceSchema = Type.Union([
  Type.Literal('google'),
  Type.Literal('custom'),
])

export type FontSource = Static<typeof FontSourceSchema>

// ---------------------------------------------------------------------------
// FontFile
// ---------------------------------------------------------------------------

const FONT_PATH_PATTERN = /^\/uploads\/fonts\/[^"<>\\\s]+\.woff2$/

function isSafeFontPath(path: string): boolean {
  return FONT_PATH_PATTERN.test(path) && !path.includes('..')
}

/**
 * One downloaded font file.  The `path` must be under `/uploads/fonts/`, end
 * with `.woff2`, and contain no traversal sequences — mirrors `isSafeFontPath`
 * in `validate.ts` (lines ~557–563).
 *
 * Google's CSS2 endpoint emits multiple `@font-face` blocks per (variant ×
 * subset) request, each restricted to a different `unicode-range` slice of the
 * subset (so browsers download only the slices they need at runtime). We
 * preserve every slice as its own `FontFile` and round-trip the original
 * `unicode-range` declaration; the publisher emits one `@font-face` per slice.
 *
 * `unicodeRange` is optional only because pre-slicing installs and
 * `source: 'custom'` uploads may not have one — when missing, the publisher
 * omits the `unicode-range:` declaration and the browser uses the file for
 * any character (legacy single-file behavior).
 */
export const FontFileSchema = Type.Object({
  variant: Type.String({ minLength: 1 }),
  subset: Type.String({ minLength: 1 }),
  path: Type.String({ pattern: FONT_PATH_PATTERN.source }),
  format: Type.Literal('woff2'),
  unicodeRange: Type.Optional(Type.String({ minLength: 1 })),
})

export type FontFile = Static<typeof FontFileSchema>

/**
 * Allowed characters inside a `unicode-range:` value. The CSS spec accepts
 * `U+`, hex digits, dashes, commas, and whitespace. We intentionally forbid
 * anything that could break out of the declaration (`<`, `>`, `"`, `\\`,
 * `;`, `{`, `}`, etc.) — the value is round-tripped verbatim into a `<style>`
 * block so the same hardening rule applies as for paths and family names.
 */
const UNICODE_RANGE_PATTERN = /^[\sUu+0-9A-Fa-f,-]+$/

function isSafeUnicodeRange(range: string): boolean {
  return UNICODE_RANGE_PATTERN.test(range) && range.length <= 2048
}

// Composite check used by callers that want pattern + path-traversal in one go.
export function checkFontFile(value: unknown): value is FontFile {
  if (!Value.Check(FontFileSchema, value)) return false
  const file = value as FontFile
  if (!isSafeFontPath(file.path)) return false
  if (file.unicodeRange != null && !isSafeUnicodeRange(file.unicodeRange)) {
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// FontEntry
// ---------------------------------------------------------------------------

/**
 * One font installed in the site library.
 * Invalid entries are silently dropped at the SiteFontsSettings level.
 * Mirrors `validateFontEntry` in validate.ts (lines ~575–603).
 */
export const FontEntrySchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  source: withFallback(FontSourceSchema, 'google' as const),
  family: Type.String({ minLength: 1 }),
  variants: withFallback(Type.Array(Type.String({ minLength: 1 })), []),
  subsets: withFallback(Type.Array(Type.String({ minLength: 1 })), []),
  /** Invalid font-file entries are silently dropped. */
  files: Type.Array(FontFileSchema),
  category: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
})

export type FontEntry = Static<typeof FontEntrySchema>

/**
 * Tolerant parser: silently filters out invalid `files` entries and provides
 * timestamp fallbacks. Use this when reading persisted site documents where
 * one corrupt sub-entry should not invalidate the whole library.
 */
export function parseFontEntry(raw: unknown): FontEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id.length === 0) return null
  if (typeof r.family !== 'string' || r.family.length === 0) return null

  const source: FontSource = r.source === 'custom' ? 'custom' : 'google'
  const variants = Array.isArray(r.variants)
    ? r.variants.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  const subsets = Array.isArray(r.subsets)
    ? r.subsets.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  const files = Array.isArray(r.files) ? filterArray(FontFileSchema, r.files) : []
  const createdAt = typeof r.createdAt === 'number' ? r.createdAt : Date.now()
  const updatedAt = typeof r.updatedAt === 'number' ? r.updatedAt : Date.now()
  const category = typeof r.category === 'string' ? r.category : undefined

  return {
    id: r.id,
    source,
    family: r.family,
    variants,
    subsets,
    files: files.filter(checkFontFile),
    ...(category !== undefined ? { category } : {}),
    createdAt,
    updatedAt,
  }
}

// ---------------------------------------------------------------------------
// SiteFontsSettings
// ---------------------------------------------------------------------------

/**
 * Library of installed fonts for a site.
 * Mirrors `validateSiteFontsSettings` in validate.ts (lines ~605–612).
 */
export const SiteFontsSettingsSchema = Type.Object({
  items: Type.Array(FontEntrySchema),
})

export type SiteFontsSettings = Static<typeof SiteFontsSettingsSchema>

/**
 * Tolerant parser used by site-document loaders. Drops any malformed entries
 * rather than failing the whole site validation.
 */
export function parseSiteFontsSettings(raw: unknown): SiteFontsSettings {
  if (!raw || typeof raw !== 'object') return { items: [] }
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return { items: [] }
  return {
    items: items.flatMap((item) => {
      const parsed = parseFontEntry(item)
      return parsed ? [parsed] : []
    }),
  }
}
