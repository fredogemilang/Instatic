/**
 * Response-shape TypeBox schemas for the CMS persistence layer.
 *
 * Each `await res.json() as Foo` call site in this directory previously
 * trusted the server response without runtime checking. These schemas
 * tighten the boundary so a server-side regression returning the wrong
 * shape now produces a clear validation error instead of triggering an
 * undefined-access TypeError deep in callers.
 *
 * Strategy:
 *   - Shallow domain types (CmsMediaAsset, CmsPublishStatus, …) are
 *     validated fully — the schemas double as the source of truth.
 *   - Deep domain types (SiteDocument, SiteDependencyLock,
 *     PublishedPageRuntimeAssets, …) live in separate modules with
 *     hundreds of fields. Validating their full structure is a separate
 *     audit-types pass; for now we validate the *envelope* (the
 *     wrapping object key) and pass the inner value through as unknown.
 *     This still catches the "server returned an array / null / wrong
 *     envelope key" class of bug — the most common runtime failure.
 *
 * Surfaced by /audit-types — see #1 in /health-check report.
 */

import { Type, type Static } from '@sinclair/typebox'

// Re-exported types are inferred from the schemas below — these schemas are
// the source of truth, the types follow. Removes the previous duplication
// where each consumer module also declared its own TS interface.

// ---------------------------------------------------------------------------
// Error envelope used by every CMS endpoint
// ---------------------------------------------------------------------------

export const ErrorEnvelopeSchema = Type.Object(
  { error: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// cmsAuth.ts
// ---------------------------------------------------------------------------

export const CmsSetupStatusSchema = Type.Object({
  hasSite: Type.Boolean(),
  hasAdmin: Type.Boolean(),
  needsSetup: Type.Boolean(),
})

export type CmsSetupStatus = Static<typeof CmsSetupStatusSchema>

// ---------------------------------------------------------------------------
// cmsMedia.ts
// ---------------------------------------------------------------------------

export const CmsMediaAssetSchema = Type.Object({
  id: Type.String(),
  filename: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Type.Number(),
  publicPath: Type.String(),
  createdAt: Type.String(),
})

export type CmsMediaAsset = Static<typeof CmsMediaAssetSchema>

export const CmsMediaListResponseSchema = Type.Object(
  { assets: Type.Optional(Type.Array(CmsMediaAssetSchema)) },
  { additionalProperties: true },
)

export const CmsMediaAssetEnvelopeSchema = Type.Object({
  asset: CmsMediaAssetSchema,
})

// ---------------------------------------------------------------------------
// cmsPublish.ts
// ---------------------------------------------------------------------------

export const CmsPublishResultSchema = Type.Object({
  publishedPages: Type.Number(),
})

export type CmsPublishResult = Static<typeof CmsPublishResultSchema>

export const CmsPublishStatusSchema = Type.Object({
  hasPublishedVersion: Type.Boolean(),
  draftMatchesPublished: Type.Boolean(),
  draftPages: Type.Number(),
  publishedPages: Type.Number(),
  lastPublishedAt: Type.Optional(Type.String()),
})

export type CmsPublishStatus = Static<typeof CmsPublishStatusSchema>

// ---------------------------------------------------------------------------
// cmsRuntime.ts — envelopes only; inner types are deep
// ---------------------------------------------------------------------------

export const CmsRuntimeDependencyEnvelopeSchema = Type.Object({
  dependencyLock: Type.Unknown(),
})

export const CmsRuntimePreviewResponseSchema = Type.Object(
  {
    html: Type.String(),
    assets: Type.Array(Type.Unknown()),
    runtimeAssets: Type.Unknown(),
    diagnostics: Type.Array(Type.Unknown()),
  },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// cms.ts — envelope only; SiteDocument is too deep to schema here
// ---------------------------------------------------------------------------

export const CmsSiteEnvelopeSchema = Type.Object(
  { site: Type.Optional(Type.Unknown()) },
  { additionalProperties: true },
)

// ---------------------------------------------------------------------------
// fonts API — bundled Google directory + install/uninstall envelopes
// ---------------------------------------------------------------------------

export const GoogleFontFamilySchema = Type.Object({
  family: Type.String(),
  category: Type.String(),
  subsets: Type.Array(Type.String()),
  variants: Type.Array(Type.String()),
  popularity: Type.Optional(Type.Number()),
})

export type GoogleFontFamilyDto = Static<typeof GoogleFontFamilySchema>

export const CmsGoogleFontsEnvelopeSchema = Type.Object({
  families: Type.Array(GoogleFontFamilySchema),
})

// FontEntry mirrors @core/fonts/schemas FontEntry. We schema the envelope
// shallowly here — full structural validation runs server-side via
// validateSite when the next save happens, so the install response is
// consumed as `unknown` and immediately committed via the addFont action
// which only reads stable top-level fields.
export const CmsFontEntryEnvelopeSchema = Type.Object({
  font: Type.Unknown(),
})

/**
 * Pre-install size estimate for a (family × variants × subsets) request.
 * The server fetches the Google CSS2 stylesheets for the selection and HEADs
 * each woff2 URL, summing `Content-Length`. Some faces may not resolve (Google
 * occasionally drops a subset for a given variant) — `fileCount` reports how
 * many woff2 URLs actually contributed to `totalBytes`.
 */
export const CmsFontEstimateEnvelopeSchema = Type.Object({
  totalBytes: Type.Number(),
  fileCount: Type.Number(),
})

export type CmsFontEstimateDto = Static<typeof CmsFontEstimateEnvelopeSchema>
