/**
 * TypeBox response schemas for spotlight async providers.
 *
 * One schema per HTTP endpoint. Every provider validates its fetch response
 * through these schemas via parseJsonResponse / readEnvelope so the provider
 * code never does `as Foo` past a JSON boundary.
 *
 * §3 of the master plan: TypeBox at every untyped boundary.
 */
import { Type, type Static } from '@core/utils/typeboxHelpers'

// ─── Media provider ───────────────────────────────────────────────────────────
// GET /admin/api/cms/media?query=<q>&limit=<n>

export const MediaAssetSummarySchema = Type.Object(
  {
    id: Type.String(),
    filename: Type.String(),
    mimeType: Type.String(),
    sizeBytes: Type.Number(),
    publicPath: Type.String(),
    title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    deletedAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
)

export const MediaListResponseSchema = Type.Object(
  { assets: Type.Array(MediaAssetSummarySchema) },
  { additionalProperties: true },
)

export type MediaAssetSummary = Static<typeof MediaAssetSummarySchema>
export type MediaListResponse = Static<typeof MediaListResponseSchema>

// ─── Data tables provider ─────────────────────────────────────────────────────
// GET /admin/api/cms/data/tables?query=<q>&limit=<n>

export const DataTableSummarySchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    slug: Type.String(),
    kind: Type.Optional(Type.String()),
    singularLabel: Type.Optional(Type.String()),
    pluralLabel: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

export const DataTablesListResponseSchema = Type.Object(
  { tables: Type.Array(DataTableSummarySchema) },
  { additionalProperties: true },
)

export type DataTableSummary = Static<typeof DataTableSummarySchema>
export type DataTablesListResponse = Static<typeof DataTablesListResponseSchema>

// ─── Content (data row) provider ─────────────────────────────────────────────
// GET /admin/api/cms/data/search?query=<q>&limit=<n>

export const DataRowSearchEntrySchema = Type.Object(
  {
    id: Type.String(),
    tableId: Type.String(),
    tableSlug: Type.String(),
    tableName: Type.String(),
    slug: Type.String(),
    status: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: true },
)

export const DataSearchResponseSchema = Type.Object(
  { entries: Type.Array(DataRowSearchEntrySchema) },
  { additionalProperties: true },
)

export type DataRowSearchEntry = Static<typeof DataRowSearchEntrySchema>
export type DataSearchResponse = Static<typeof DataSearchResponseSchema>

// ─── Plugins / plugin pages provider ─────────────────────────────────────────
// GET /admin/api/cms/plugins

export const PluginAdminPageSummarySchema = Type.Object(
  {
    id: Type.String(),
    title: Type.String(),
    navLabel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    icon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    route: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
)

export const InstalledPluginSummarySchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    enabled: Type.Boolean(),
    manifest: Type.Object(
      {
        adminPages: Type.Optional(Type.Array(PluginAdminPageSummarySchema)),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
)

export const PluginsListResponseSchema = Type.Object(
  { plugins: Type.Array(InstalledPluginSummarySchema) },
  { additionalProperties: true },
)

export type InstalledPluginSummary = Static<typeof InstalledPluginSummarySchema>
export type PluginsListResponse = Static<typeof PluginsListResponseSchema>
