/**
 * TypeBox response schemas for the Search plugin's admin API routes.
 *
 * All HTTP responses from plugin routes enter the admin app through these
 * schemas — `routes.json(path, Schema)` validates the response and returns
 * `Static<typeof Schema>`. There are NO `as Foo` casts at any boundary.
 *
 * These are the authoritative type definitions for the admin UI. The server
 * route handlers return plain objects that must match these shapes; the types
 * here are the single source of truth.
 */
import { Type, type Static } from '@sinclair/typebox'

// ---------------------------------------------------------------------------
// /status
// ---------------------------------------------------------------------------

export const IndexStatsSchema = Type.Object({
  docCount: Type.Number(),
  sizeBytes: Type.Union([Type.Number(), Type.Null()]),
  lastSyncedAt: Type.Union([Type.String(), Type.Null()]),
  backend: Type.String(),
  endpointHost: Type.String(),
})
export type IndexStats = Static<typeof IndexStatsSchema>

export const StatusResponseSchema = Type.Object({
  ok: Type.Boolean(),
  configured: Type.Boolean(),
  stats: Type.Optional(IndexStatsSchema),
  message: Type.Optional(Type.String()),
})
export type StatusResponse = Static<typeof StatusResponseSchema>

// ---------------------------------------------------------------------------
// /admin-search
// ---------------------------------------------------------------------------

export const SearchHitSchema = Type.Object({
  id: Type.String(),
  slug: Type.String(),
  title: Type.String(),
  excerpt: Type.String(),
})
export type SearchHit = Static<typeof SearchHitSchema>

export const SearchResponseSchema = Type.Object({
  results: Type.Array(SearchHitSchema),
  total: Type.Number(),
  took_ms: Type.Number(),
  query: Type.String(),
})
export type SearchResponse = Static<typeof SearchResponseSchema>

// ---------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------

export const OkResponseSchema = Type.Object({
  ok: Type.Boolean(),
  message: Type.Optional(Type.String()),
})
export type OkResponse = Static<typeof OkResponseSchema>

// ---------------------------------------------------------------------------
// /reindex
// ---------------------------------------------------------------------------

export const ReindexResponseSchema = Type.Object({
  ok: Type.Boolean(),
  count: Type.Number(),
  message: Type.Optional(Type.String()),
})
export type ReindexResponse = Static<typeof ReindexResponseSchema>

// ---------------------------------------------------------------------------
// /analytics
// ---------------------------------------------------------------------------

export const TopQuerySchema = Type.Object({
  query: Type.String(),
  count: Type.Number(),
  avgResultCount: Type.Number(),
})
export type TopQuery = Static<typeof TopQuerySchema>

export const AnalyticsResponseSchema = Type.Object({
  ok: Type.Boolean(),
  loggingDisabled: Type.Optional(Type.Boolean()),
  topQueries: Type.Array(TopQuerySchema),
  topNoResults: Type.Array(TopQuerySchema),
})
export type AnalyticsResponse = Static<typeof AnalyticsResponseSchema>
