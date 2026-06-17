/**
 * Client-side persistence layer for site-transfer endpoints:
 *   POST /admin/api/cms/export
 *   POST /admin/api/cms/import/preview
 *   POST /admin/api/cms/import?strategy=<strategy>
 *
 * All HTTP calls use `credentials: 'include'`. Export returns a raw Blob
 * (the endpoint streams an attachment, not an envelope). Preview and import
 * return standard JSON envelopes validated with TypeBox via `readEnvelope`.
 */

import type { SiteBundle, BundlePreview, ImportResult, ImportStrategy, ExportRequest, ExportEstimate, ExportSummary } from '@core/data/bundleSchema'
import { SiteBundleSchema, BundlePreviewSchema, ImportResultSchema, ExportEstimateSchema, ExportSummarySchema } from '@core/data/bundleSchema'
import { parseValue, formatValueErrors, compiled } from '@core/utils/typeboxHelpers'
import { apiRequest, readEnvelope, assertOk } from '@core/http'

// ---------------------------------------------------------------------------
// SiteBundleParseError
// ---------------------------------------------------------------------------

/**
 * Thrown by `parseSiteBundle` when the raw string fails JSON parsing or
 * TypeBox validation. Carries `path` so callers (e.g. an import dialog) can
 * show where in the bundle the problem was detected.
 *
 * `path` is `''` when the file is not valid JSON at all, or the first failing
 * TypeBox path (e.g. `'/schemaVersion'`) for structural validation errors.
 */
export class SiteBundleParseError extends Error {
  readonly path: string

  constructor(message: string, path: string) {
    super(message)
    this.name = 'SiteBundleParseError'
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// exportSiteBundle
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/export
 *
 * Returns the raw Blob of the JSON bundle so callers can trigger a browser
 * download or read the bytes themselves. Uses POST so arbitrary-length
 * `rowIds` arrays don't hit URL length limits.
 *
 * The export endpoint returns raw JSON with `content-disposition: attachment`,
 * NOT the standard `{ data, error }` envelope — so we do NOT use `readEnvelope`.
 */
export async function exportSiteBundle(opts: ExportRequest): Promise<Blob> {
  const res = await fetch('/admin/api/cms/export', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  })
  await assertOk(res, 'Failed to export site')
  return res.blob()
}

// ---------------------------------------------------------------------------
// estimateSiteBundle
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/export/estimate
 *
 * Returns the exact byte size the bundle WOULD have for the given request,
 * computed server-side from the same selection logic as the real export (it
 * never reads media files off disk). Used to drive the "Estimated size" line
 * live as the operator toggles options. Pass an `AbortSignal` so superseded
 * requests cancel cleanly; detect cancellation with `isAbortError`.
 */
export async function estimateSiteBundle(
  opts: ExportRequest,
  signal?: AbortSignal,
): Promise<ExportEstimate> {
  return apiRequest('/admin/api/cms/export/estimate', {
    method: 'POST',
    body: opts,
    schema: ExportEstimateSchema,
    signal,
    fallbackMessage: 'Failed to estimate export size',
  })
}

// ---------------------------------------------------------------------------
// getExportSummary
// ---------------------------------------------------------------------------

/**
 * GET /admin/api/cms/export/summary
 *
 * Total counts of the non-table export categories (media, media folders,
 * redirects), so the export dialog can label each category and disable empty
 * ones — independent of the current selection. Data-table row counts come from
 * the workspace, not this endpoint.
 */
export async function getExportSummary(signal?: AbortSignal): Promise<ExportSummary> {
  return apiRequest('/admin/api/cms/export/summary', {
    method: 'GET',
    schema: ExportSummarySchema,
    signal,
    fallbackMessage: 'Failed to load export summary',
  })
}

// ---------------------------------------------------------------------------
// previewSiteBundle
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/import/preview
 *
 * Server validates the bundle and returns a read-only diff against the local
 * site. No DB writes are performed. Use this to show the operator what would
 * happen before they commit an import.
 */
export async function previewSiteBundle(bundle: SiteBundle): Promise<BundlePreview> {
  const res = await fetch('/admin/api/cms/import/preview', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  })
  return readEnvelope(res, BundlePreviewSchema, 'Failed to preview bundle')
}

// ---------------------------------------------------------------------------
// importSiteBundle
// ---------------------------------------------------------------------------

/**
 * POST /admin/api/cms/import?strategy=<strategy>
 *
 * Applies the bundle to the local instance using the given strategy:
 *   - `replace`         — wipe everything, reimport from bundle (destructive)
 *   - `merge-add`       — insert rows/tables that don't exist; skip existing
 *   - `merge-overwrite` — upsert: add missing, overwrite existing with bundle values
 */
export async function importSiteBundle(
  bundle: SiteBundle,
  strategy: ImportStrategy,
): Promise<ImportResult> {
  const res = await fetch(`/admin/api/cms/import?strategy=${encodeURIComponent(strategy)}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  })
  return readEnvelope(res, ImportResultSchema, 'Failed to import bundle')
}

// ---------------------------------------------------------------------------
// parseSiteBundle
// ---------------------------------------------------------------------------

/**
 * Parse and validate a `SiteBundle` from a raw JSON string (e.g. file
 * contents read by a `<input type="file">` handler).
 *
 * Throws `SiteBundleParseError` on failure:
 *   - `path: ''`    — the string is not valid JSON
 *   - `path: '/...'` — the JSON parses but fails TypeBox validation; path
 *                      points to the first failing location in the document
 */
export function parseSiteBundle(raw: string): SiteBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new SiteBundleParseError(
      `Invalid JSON: ${err instanceof Error ? err.message : 'parse error'}`,
      '',
    )
  }

  try {
    return parseValue(SiteBundleSchema, parsed)
  } catch {
    // Collect the first TypeBox error to give a precise location.
    let firstPath = ''
    let message = 'Bundle does not match the expected SiteBundle schema'
    try {
      // formatValueErrors gives up to 5 issues; we also fish out the first
      // path separately so we can populate SiteBundleParseError.path.
      const firstErr = compiled(SiteBundleSchema).Errors(parsed).First()
      if (firstErr) {
        firstPath = firstErr.path
        message = formatValueErrors(SiteBundleSchema, parsed)
      }
    } catch {
      // Error collection itself failed — keep defaults.
    }
    throw new SiteBundleParseError(message, firstPath)
  }
}
