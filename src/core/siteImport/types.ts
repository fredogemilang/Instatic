/**
 * Shared types for the Super Import pipeline (Phase 1+).
 *
 * These types are headless — no admin/React/server imports allowed here.
 * @see src/__tests__/architecture/siteImport-headless.test.ts
 */

import type { StyleRule } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'

// ---------------------------------------------------------------------------
// NewStyleRule — a StyleRule ready to insert (sans identity fields)
// ---------------------------------------------------------------------------

/**
 * A fully-specified style rule that can be committed to the site's styleRules
 * registry. The identity fields (`id`, `createdAt`, `updatedAt`) are assigned
 * by the caller (Phase 2's `applyImport.ts`) when writing to the store, not
 * by the parser.
 */
export type NewStyleRule = Omit<StyleRule, 'id' | 'createdAt' | 'updatedAt'>

// ---------------------------------------------------------------------------
// ImportWarning
// ---------------------------------------------------------------------------

/**
 * Categories of warnings that the import pipeline can emit.
 *
 * Phase 1 (CSS parser) kinds:
 * - `dropped-at-rule`: an @-rule that the engine can't model was silently
 *   dropped (@keyframes, @font-face, @supports, @container, @layer, etc.).
 * - `unmatched-media-query`: an @media query whose width couldn't be matched
 *   to any defined breakpoint within ±mediaTolerance. Inner declarations are
 *   folded into the base styles so nothing is silently lost.
 * - `invalid-rule`: a rule that the CSS engine rejected (typically a sheet-
 *   level parse error that causes `replaceSync` to throw).
 * - `unknown-property`: legacy — retained for back-compat with any persisted
 *   warnings. The Phase 1a permissive property model no longer emits this; a
 *   declaration is only dropped when its NAME is denied (see
 *   `blocked-property`), not when it's merely uncurated.
 * - `blocked-property`: a CSS declaration whose property name is on the
 *   security denylist (`behavior`, `-moz-binding`, …). Rare. The declaration
 *   is dropped from the rule.
 * - `asset-reference`: informational — a `url(...)` payload was found in a
 *   declaration value. Assets are collected in `assetRefs` (not warnings) by
 *   the Phase 1 parser; this kind is reserved for Phase 2's use.
 * - `duplicate-class`: two `.foo { ... }` rules with the same class selector
 *   appeared in the same file. The later rule's declarations win (CSS cascade
 *   semantics). One warning is emitted per duplicated class.
 *
 * Phase 2 (site import pipeline) kinds:
 * - `missing-stylesheet`: a `<link rel="stylesheet">` href referenced in an
 *   HTML file was not found in the FileMap. The page is still imported; the
 *   missing CSS is noted but not fatal.
 * - `asset-upload-failed`: an individual asset upload was rejected by the
 *   media library (e.g. unsupported MIME, oversized file, server error).
 *   The remaining assets continue to upload; the failed file is left
 *   referenced in the source HTML/CSS by its original FileMap path so the
 *   import doesn't degrade pages or rules. Surface the warning in the
 *   wizard's Done step so the user can re-upload manually.
 */
export type ImportWarningKind =
  | 'dropped-at-rule'
  | 'unmatched-media-query'
  | 'invalid-rule'
  | 'unknown-property'
  | 'blocked-property'
  | 'asset-reference'
  | 'duplicate-class'
  | 'missing-stylesheet'
  | 'asset-upload-failed'

export interface ImportWarning {
  kind: ImportWarningKind
  /** Human-readable description of what was dropped or why. */
  message: string
  /**
   * For CSS warnings: the raw CSS source text that triggered the warning,
   * truncated to ~120 chars with a trailing `…` if cut.
   * For `missing-stylesheet`: the HTML file that referenced the missing CSS.
   */
  source?: string
  /** The CSS selector relevant to the warning (for unknown-property, duplicate-class). */
  selector?: string
  /** The camelCase property name (for unknown-property warnings). */
  property?: string
  /**
   * File path relevant to the warning (for `missing-stylesheet`: the unresolved
   * CSS href as it appeared in the HTML source).
   */
  path?: string
}

// ---------------------------------------------------------------------------
// BreakpointHint — how @media queries map to named breakpoints
// ---------------------------------------------------------------------------

/**
 * A hint that maps a named breakpoint to its pixel width threshold.
 * Passed to `cssToStyleRules` so @media queries can be matched to existing
 * site breakpoints by width (±mediaTolerance).
 */
export interface BreakpointHint {
  /** Breakpoint identifier, matching the key used in `StyleRule.breakpointStyles`. */
  id: string
  /** The width threshold in CSS pixels (e.g. 768 for a tablet breakpoint). */
  width: number
}

// ---------------------------------------------------------------------------
// AssetRef — records a url(...) reference found in an imported rule
// ---------------------------------------------------------------------------

/**
 * A URL reference found inside a CSS declaration value.
 *
 * The parser records these but does NOT modify the rule's declaration value.
 * Phase 2 (`applyImport.ts`) rewrites the URLs once assets have been uploaded
 * and their final media-library paths are known.
 *
 * NOTE: Only references inside *emitted* rules are recorded. A `url()` inside
 * a dropped @-rule (e.g. `@font-face { src: url(foo.woff) }`) does NOT appear
 * in `assetRefs` — because the rule was never emitted.
 */
export interface AssetRef {
  /** Zero-based index into `CssToStyleRulesResult.rules`. */
  ruleIndex: number
  /**
   * The breakpoint ID this declaration lives in, or `undefined` for the rule's
   * base `styles` object.
   */
  breakpointId?: string
  /** camelCase CSS property name (e.g. `backgroundImage`). */
  property: string
  /**
   * The raw URL payload — unquoted and untrimmed. For `url('assets/bg.png')`
   * this is `assets/bg.png`.
   */
  rawUrl: string
}

// ---------------------------------------------------------------------------
// Phase 2 — Site-import pipeline types
// ---------------------------------------------------------------------------

/**
 * A normalized map of all files in the import input.
 *
 * Keys are relative paths with `/` separators (no leading `./` or `/`).
 * Produced by `ingestInput.ts` from any of the four input shapes.
 */
export interface FileMap {
  /** All files keyed by normalized relative path. */
  files: Record<string, { bytes: Uint8Array; mimeType?: string }>
  /**
   * When unpacking a ZIP whose every entry shared a single top-level folder,
   * that folder name is recorded here so consumers can surface it in the UI.
   * Undefined when no strip happened.
   */
  strippedTopLevelFolder?: string
}

/**
 * The semantic role of a file in the import.
 * Used by `classifyFiles` to decide how each file is processed.
 */
export type FileRole = 'html' | 'css' | 'js' | 'image' | 'font' | 'binary' | 'meta'

/** A single file with its resolved role and raw bytes. */
export interface ClassifiedFile {
  /** Normalized relative path (FileMap key). */
  path: string
  role: FileRole
  size: number
  bytes: Uint8Array
  mimeType?: string
}

/**
 * A single HTML file processed into a page-ready plan.
 *
 * `nodeFragment` contains the parsed body content. Class names inside the
 * fragment are still raw name strings; the admin-side adapter resolves them
 * into registry ids when calling `addPage`.
 */
export interface PagePlan {
  /** FileMap key of the source HTML file. */
  source: string
  /** Display title derived from `<title>` or prettified filename. */
  title: string
  /** URL-safe slug derived from the filename. */
  slug: string
  /**
   * FileMap keys of CSS files linked by `<link rel="stylesheet">` in the
   * page's `<head>`. Only paths that exist in the FileMap are included; missing
   * hrefs produce `missing-stylesheet` warnings instead.
   */
  linkedCssPaths: string[]
  /**
   * The body content as a flat node fragment.
   *
   * URL-shaped props (`src`, `href`, `srcset`) are normalized to FileMap keys
   * (relative paths) so that `applyAssetRewrites` can do exact-string
   * replacement without needing the original base path.
   */
  nodeFragment: ImportFragment
}

/** How a slug or rule-name conflict is resolved for a single item. */
export interface ConflictResolution {
  action: 'auto-rename' | 'overwrite' | 'skip' | 'custom-rename'
  /** Resolved slug (for page conflicts; defined when action !== 'skip'). */
  resolvedSlug?: string
  /** Resolved name (for rule conflicts; defined when action !== 'skip'). */
  resolvedName?: string
}

/** A page slug that collides with an existing page. */
export interface PageConflict {
  /** FileMap key of the HTML source file. */
  source: string
  /** The slug the importer wanted to use. */
  desiredSlug: string
  /** ID of the existing page that owns the slug. */
  existingPageId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * A `kind:'class'` rule name that collides with an existing class rule.
 *
 * Ambient rules NEVER conflict — multiple ambient rules with the same
 * selector are allowed; cascade resolves by `order`.
 */
export interface RuleConflict {
  /** FileMap key of the CSS source file (or empty if unknown). */
  source: string
  /** The class name the importer wanted to use. */
  desiredName: string
  /** ID of the existing StyleRule that owns the name. */
  existingRuleId: string
  /** Default resolution (auto-rename; may be overridden by the UI). */
  defaultResolution: ConflictResolution
}

/**
 * The fully-analysed import plan.
 *
 * Produced by `buildImportPlan`. Consumed by `commitImportPlan` (which calls
 * the adapter) and by the Phase 3 wizard UI (for preview and conflict
 * resolution).
 *
 * All URL-shaped values inside `pages[].nodeFragment` and
 * `styleRules[].styles` / `breakpointStyles` are normalized to FileMap keys
 * so that `applyAssetRewrites` can replace them with new media URLs.
 */
export interface ImportPlan {
  pages: PagePlan[]
  styleRules: NewStyleRule[]
  /** Assets to upload, with their raw bytes. */
  assets: { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
  conflicts: { pages: PageConflict[]; rules: RuleConflict[] }
  warnings: ImportWarning[]
  /** FileMap paths of dropped JS files. */
  droppedJs: string[]
  /**
   * Source text snippets of @-rules that could not be modelled
   * (from `dropped-at-rule` warnings in the CSS parser).
   */
  droppedAtRules: string[]
  /** CSS files present in the FileMap but not linked by any imported page. */
  unusedCss: string[]
}

/**
 * The committed result of applying an ImportPlan through a SiteImportAdapter.
 *
 * Returned by `commitImportPlan`. Provides enough information for the
 * Phase 3 wizard's "Done" step to show a summary.
 */
export interface ImportResult {
  pages: { id: string; title: string; slug: string; source: string }[]
  styleRules: { id: string; selector: string; kind: 'class' | 'ambient' }[]
  assets: { sourcePath: string; mediaUrl: string }[]
  /** Resolved conflicts (mirrors ImportPlan.conflicts with final actions). */
  conflicts: ImportPlan['conflicts']
  warnings: ImportWarning[]
}

// ---------------------------------------------------------------------------
// Typed error classes for the import pipeline
// ---------------------------------------------------------------------------

/** Thrown when the import input contains no processable files. */
export class EmptyImportError extends Error {
  constructor() {
    super('Import input is empty — drop at least one file')
    this.name = 'EmptyImportError'
  }
}

/** Thrown when the aggregate input size exceeds the configured limit. */
export class OversizeImportError extends Error {
  readonly sizeBytes: number
  readonly limitBytes: number
  constructor(sizeBytes: number, limitBytes: number) {
    super(
      `Import aggregate size ${sizeBytes} bytes exceeds the ${limitBytes}-byte limit`,
    )
    this.name = 'OversizeImportError'
    this.sizeBytes = sizeBytes
    this.limitBytes = limitBytes
  }
}

/** Thrown when a zip's uncompressed size exceeds the zip-bomb guard limit. */
export class ZipBombError extends Error {
  readonly uncompressedBytes: number
  readonly limitBytes: number
  constructor(uncompressedBytes: number, limitBytes: number) {
    super(
      `Zip uncompressed size ${uncompressedBytes} bytes exceeds the ${limitBytes}-byte limit (zip-bomb guard)`,
    )
    this.name = 'ZipBombError'
    this.uncompressedBytes = uncompressedBytes
    this.limitBytes = limitBytes
  }
}

/** Thrown when the file count in the import exceeds the configured limit. */
export class TooManyFilesError extends Error {
  readonly count: number
  readonly limit: number
  constructor(count: number, limit: number) {
    super(`Import contains ${count} files, exceeding the ${limit}-file limit`)
    this.name = 'TooManyFilesError'
    this.count = count
    this.limit = limit
  }
}

/**
 * Thrown when a path contains `..` segments, an absolute prefix (`/` or a
 * Windows drive letter), or other traversal attempts.
 */
export class PathTraversalError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`Unsafe path rejected — path traversal or absolute path detected: "${path}"`)
    this.name = 'PathTraversalError'
    this.path = path
  }
}
