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

const FontSourceSchema = Type.Union([
  Type.Literal('google'),
  Type.Literal('custom'),
])

type FontSource = Static<typeof FontSourceSchema>

// ---------------------------------------------------------------------------
// FontFileFormat
// ---------------------------------------------------------------------------

/**
 * Web-font container formats we can self-host + emit an `@font-face src` for.
 * Google installs are always `woff2`; custom uploads (and imported `@font-face`
 * sources) may be any of the four.
 */
const FontFileFormatSchema = Type.Union([
  Type.Literal('woff2'),
  Type.Literal('woff'),
  Type.Literal('ttf'),
  Type.Literal('otf'),
])

export type FontFileFormat = Static<typeof FontFileFormatSchema>

/** On-disk extension for each format — used for the path↔format consistency check. */
const EXTENSION_FOR_FONT_FORMAT: Record<FontFileFormat, string> = {
  woff2: '.woff2',
  woff: '.woff',
  ttf: '.ttf',
  otf: '.otf',
}

/**
 * Strict legacy check: a `.woff2` file under `/uploads/fonts/` with no traversal
 * sequences. Retained as a named export for the bundle export/import schema,
 * whose font parser only round-trips self-hosted Google (woff2) installs. New
 * code paths use `isSafeFontSrc`, which also accepts media-backed custom fonts.
 */
const LEGACY_FONT_PATH_PATTERN = /^\/uploads\/fonts\/[^"<>\\\s]+\.woff2$/

export function isSafeFontPath(path: string): boolean {
  return LEGACY_FONT_PATH_PATTERN.test(path) && !path.includes('..')
}

// ---------------------------------------------------------------------------
// FontFile
// ---------------------------------------------------------------------------

/**
 * Validate a font `src` path before it's interpolated into a `<style>` block.
 *
 * Two accepted shapes:
 *   - Self-hosted: a root-relative path under `/uploads/` (the Google installer
 *     writes to `/uploads/fonts/<slug>/`, custom + imported uploads land in the
 *     media library under `/uploads/media/`). Any of the four font extensions.
 *   - Media-backed external: an `https://` URL — accepted ONLY when the file
 *     carries a `mediaAssetId`, proving it came from our media pipeline on a
 *     deployment whose storage adapter serves assets off an external host.
 *     Arbitrary `https://` font URLs (no `mediaAssetId`) are rejected so a
 *     corrupted site document can't make the publisher fetch a third-party CDN.
 *
 * Always rejects traversal sequences and characters that could break out of a
 * CSS `url("...")` string or the surrounding `<style>` tag.
 */
function isSafeFontSrc(path: string, mediaAssetId?: string): boolean {
  if (!path || path.includes('..')) return false
  if (/["<>\\\s]/.test(path)) return false
  if (path.startsWith('/uploads/')) return true
  if (path.startsWith('https://')) return mediaAssetId != null && mediaAssetId.length > 0
  return false
}

/**
 * One font file backing an `@font-face` slice.
 *
 * `path` is the public URL the publisher emits inside `src: url("...")`. For
 * Google installs and self-hosted custom uploads it's a `/uploads/...` path;
 * for media-backed fonts on an external storage adapter it may be an `https://`
 * URL (gated by `mediaAssetId`, see `isSafeFontSrc`).
 *
 * Google's CSS2 endpoint emits multiple `@font-face` blocks per (variant ×
 * subset) request, each restricted to a different `unicode-range` slice. We
 * preserve every slice as its own `FontFile`. `unicodeRange` is optional;
 * custom uploads and imported faces typically have none.
 *
 * `mediaAssetId` is set for media-backed custom / imported fonts (so the entry
 * survives a storage-adapter migration and external URLs are trusted). Google
 * installs leave it unset.
 */
const FontFileSchema = Type.Object({
  variant: Type.String({ minLength: 1 }),
  subset: Type.String({ minLength: 1 }),
  path: Type.String({ minLength: 1 }),
  format: FontFileFormatSchema,
  unicodeRange: Type.Optional(Type.String({ minLength: 1 })),
  mediaAssetId: Type.Optional(Type.String({ minLength: 1 })),
})

export type FontFile = Static<typeof FontFileSchema>

/**
 * A self-hosted `/uploads/` path must carry the extension matching its declared
 * `format` (the media pipeline picks a server-trusted extension from the sniffed
 * MIME). External media URLs are exempt — a signed CDN URL may not end in `.woff2`.
 */
function fontPathMatchesFormat(file: FontFile): boolean {
  if (!file.path.startsWith('/uploads/')) return true
  const expected = EXTENSION_FOR_FONT_FORMAT[file.format]
  const pathname = file.path.split('?')[0]
  return pathname.toLowerCase().endsWith(expected)
}

/**
 * Allowed characters inside a `unicode-range:` value. The CSS spec accepts
 * `U+`, hex digits, dashes, commas, and whitespace. We forbid anything that
 * could break out of the declaration — the value is round-tripped verbatim
 * into a `<style>` block.
 */
const UNICODE_RANGE_PATTERN = /^[\sUu+0-9A-Fa-f,-]+$/

function isSafeUnicodeRange(range: string): boolean {
  return UNICODE_RANGE_PATTERN.test(range) && range.length <= 2048
}

// Composite check used by callers that want schema + path-safety in one go.
function checkFontFile(value: unknown): value is FontFile {
  if (!Value.Check(FontFileSchema, value)) return false
  const file = value as FontFile
  if (!isSafeFontSrc(file.path, file.mediaAssetId)) return false
  if (!fontPathMatchesFormat(file)) return false
  if (file.unicodeRange != null && !isSafeUnicodeRange(file.unicodeRange)) {
    return false
  }
  return true
}

/** Re-exported so the CSS emitter applies the same path-safety rule at the
 *  `<style>` boundary that the schema applies at the storage boundary. */
export { isSafeFontSrc }

// ---------------------------------------------------------------------------
// FontEntry
// ---------------------------------------------------------------------------

/**
 * One font installed in the site library.
 * Invalid entries are silently dropped at the SiteFontsSettings level.
 */
const FontEntrySchema = Type.Object({
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
function parseFontEntry(raw: unknown): FontEntry | null {
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

/** Library of installed fonts for a site. */
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
