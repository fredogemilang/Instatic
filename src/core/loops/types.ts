/**
 * Loop entity sources — pluggable data backends for the `base.loop` module.
 *
 * A `LoopEntitySource` describes WHERE a loop pulls items from (content
 * entries, site pages, media assets, plugin-defined collections) and WHAT
 * fields are available for `dynamicBindings` inside the loop's child
 * subtrees. Sources self-register with the singleton in `./registry.ts`,
 * the same pattern used by ModuleRegistry.
 *
 * The shape stays deliberately neutral: each source produces `LoopItem`
 * objects with a generic `fields: Record<string, unknown>` map. The
 * publisher's dynamic-binding resolver reads field values by name; format
 * coercions (e.g. markdown → HTML for body, mediaId → public path for
 * featured media) happen in the source's `fetch()` so the resolver stays
 * a one-line lookup.
 *
 * IDs MUST be namespaced (e.g. `content.entries`, `site.pages`,
 * `acme.products`) so plugins can't shadow built-in sources. Enforced by
 * the registry and by the architecture test
 * `loop-source-id-format.test.ts`.
 */

import type { PropertySchema } from '../module-engine/types'
import type { SiteDocument } from '../page-tree/schemas'

// ---------------------------------------------------------------------------
// Field metadata
// ---------------------------------------------------------------------------

/**
 * One field offered by a source. The optional `format` hint travels with
 * the binding so the publisher knows whether to HTML-escape, treat as a
 * URL, or pass-through richtext. See `escapeProps` in the publisher.
 */
export interface LoopSourceField {
  id: string
  label: string
  description?: string
  /**
   * Format hint for downstream rendering:
   *  - 'plain' (default): treat as a string, HTML-escape on emit
   *  - 'html'           : already-rendered HTML, pass through unescaped
   *  - 'url'            : run through `isSafeUrl` before emitting
   *  - 'media'          : URL pointing at a media asset path
   */
  format?: 'plain' | 'html' | 'url' | 'media'
}

// ---------------------------------------------------------------------------
// LoopItem — the unit a loop iterates over
// ---------------------------------------------------------------------------

/**
 * A single item produced by a `LoopEntitySource`. The `fields` map carries
 * resolved values — never IDs that need a second lookup. For example, a
 * `content.entries` LoopItem stores `featuredMediaPath` (the resolved
 * public URL) rather than just `featuredMediaId`.
 *
 * The shape is intentionally generic across source types so that the same
 * publisher / resolver code paths handle every source.
 */
export interface LoopItem {
  /** Stable identity — used for keying in the editor and infinite-load dedup. */
  id: string
  /** Field values keyed by `LoopSourceField.id`. */
  fields: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Source contract
// ---------------------------------------------------------------------------

/**
 * Minimal tagged-template SQL surface used by source fetch implementations.
 *
 * The full server-side `DbClient` (with `.transaction()`, `.unsafe()`, etc.)
 * lives in `server/cms/db/client.ts`. Loop sources only need the
 * tagged-template callable form, so we narrow to this shape to keep the
 * core/loops module free of server-only imports. The publisher passes
 * the real `DbClient` at runtime; this type is structurally compatible.
 */
export interface LoopSourceDb {
  <Row = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number }>
}

/**
 * Context handed to `LoopEntitySource.fetch()` server-side.
 *
 * `db` is the per-request DB connection — Postgres or SQLite. Sources
 * MUST write only ANSI-standard SQL that works on both engines per the
 * rules in CLAUDE.md.
 */
export interface SourceFetchContext {
  db: LoopSourceDb
  site: SiteDocument
  /** Source-specific filter values, validated against `filterSchema`. */
  filters: Record<string, unknown>
  /** One of the source's `orderByOptions[].id` values. */
  orderBy: string
  direction: 'asc' | 'desc'
  /** Hard cap from the loop instance; sources may further clamp. */
  limit: number
  offset: number
}

/**
 * Context handed to `LoopEntitySource.preview()` editor-side. No DB
 * available — sources synthesise representative items from the site
 * document or from in-memory state.
 */
export interface SourcePreviewContext {
  site: SiteDocument
  filters: Record<string, unknown>
  limit: number
}

export interface LoopFetchResult {
  items: LoopItem[]
  /** Total matching items across all pages. Used for hasMore + paginators. */
  totalItems: number
}

/**
 * Pluggable entity source.
 *
 * Built-in sources live under `src/core/loops/sources/*` and self-register
 * on import. Plugins register additional sources via the plugin SDK
 * (see `src/core/plugin-sdk`).
 */
export interface LoopEntitySource {
  /** Namespaced ID, e.g. `content.entries`, `site.pages`, `acme.products`. */
  id: string
  /** Human label for the source picker. */
  label: string
  description?: string
  /**
   * Property controls rendered in the loop's Properties Panel after the
   * source has been picked. Empty schema = no source-specific filters.
   */
  filterSchema: PropertySchema
  /** Allowed values for the loop's `orderBy` property. */
  orderByOptions: { id: string; label: string }[]
  /** Fields available for `dynamicBindings` inside the loop. */
  fields: LoopSourceField[]
  /** Server-side: produce items + totalItems for the resolved filters/page. */
  fetch(ctx: SourceFetchContext): Promise<LoopFetchResult>
  /** Editor-side: synthesise representative items without DB access. */
  preview(ctx: SourcePreviewContext): LoopItem[]
}

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

export interface ILoopSourceRegistry {
  register(source: LoopEntitySource): void
  registerOrReplace(source: LoopEntitySource): void
  unregister(id: string): void
  get(id: string): LoopEntitySource | undefined
  getOrThrow(id: string): LoopEntitySource
  has(id: string): boolean
  list(): LoopEntitySource[]
}
