import type { DbClient } from '../db/client'

export interface MediaVariant {
  width: number
  height: number
  format: 'webp' | 'jpeg' | 'png' | 'avif'
  /**
   * Public URL the renderer emits (`/uploads/<storage>` for local; an
   * absolute URL like `https://cdn.example.com/...` for `'public-url'`
   * adapters; `/uploads/<storage>` again for `'signed-redirect'` /
   * `'proxy'` adapters because the router resolves them on request).
   */
  path: string
  sizeBytes: number
  /**
   * Adapter-internal storage handle. For local-disk this is the basename
   * under `uploadsDir`; for S3 it's the bucket key. Used by `dispatchDelete`
   * to remove the right bytes when the asset is purged.
   */
  storagePath: string
  /** Adapter id that wrote this variant; `''` for the built-in local-disk adapter. */
  storageAdapterId: string
}

export interface MediaAsset {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  publicPath: string
  uploadedByUserId: string | null
  createdAt: string
  altText: string
  caption: string
  title: string
  tags: string[]
  width: number | null
  height: number | null
  durationMs: number | null
  dominantColor: string | null
  deletedAt: string | null
  replacedAt: string | null
  folderIds: string[]
  blurHash: string | null
  variants: MediaVariant[]
  posterPath: string | null
  /**
   * Id of the storage adapter that wrote this asset. Empty string for the
   * built-in local-disk adapter (historical assets keep this default).
   * Reads dispatch through THIS field, not the currently-elected adapter,
   * so an election swap can't strand existing rows.
   */
  storageAdapterId: string
  /**
   * True when the bytes live outside the host's uploads dir
   * (servingMode `'public-url'`). The hard-delete path uses this to choose
   * between local `rm` and `adapter.delete()`.
   */
  externallyHosted: boolean
}

interface CreateMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  uploadedByUserId: string | null
  /** Empty string = local-disk; otherwise the namespaced adapter id. */
  storageAdapterId: string
  /** True when this row's bytes are stored outside the host's uploads dir. */
  externallyHosted: boolean
}

export interface UpdateMediaAssetMetadataInput {
  filename?: string
  altText?: string
  caption?: string
  title?: string
  tags?: string[]
}

interface MediaAssetRow {
  id: string
  filename: string
  mime_type: string
  size_bytes: number | string
  public_path: string
  uploaded_by_user_id: string | null
  created_at: Date | string
  alt_text: string | null
  caption: string | null
  title: string | null
  tags_json: unknown
  width: number | null
  height: number | null
  duration_ms: number | string | null
  dominant_color: string | null
  deleted_at: Date | string | null
  replaced_at: Date | string | null
  blur_hash: string | null
  variants_json: unknown
  poster_path: string | null
  storage_adapter_id: string
  /** PG: boolean; SQLite: integer 0/1. Read via Boolean(row.externally_hosted). */
  externally_hosted: boolean | number
}

interface DeletedMediaAssetRow {
  storage_path: string
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value == null ? null : toIsoString(value)
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === 'string')
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

function parseVariants(value: unknown): MediaVariant[] {
  // Variants are written by the upload pipeline as a fully-validated array
  // already; the runtime check here is defense against a hand-edited row.
  // Anything that isn't a well-shaped variant gets dropped silently — the
  // asset still serves its original file, just without the responsive ladder.
  //
  // `storagePath` / `storageAdapterId` were added when the media subsystem
  // grew pluggable storage adapters. Older rows without them are derived:
  // `storagePath` from `path` (stripping `/uploads/`), `storageAdapterId`
  // to `''` (local-disk). This is the canonical derivation — not a band-aid
  // — because old rows were always written by the local-disk adapter and
  // their storagePath is structurally `path.slice('/uploads/'.length)`.
  const raw: unknown = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => { try { return JSON.parse(value) } catch { return [] } })()
      : []
  if (!Array.isArray(raw)) return []
  const result: MediaVariant[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.width !== 'number' || typeof e.height !== 'number') continue
    if (typeof e.path !== 'string' || typeof e.sizeBytes !== 'number') continue
    if (e.format !== 'webp' && e.format !== 'jpeg' && e.format !== 'png' && e.format !== 'avif') continue
    const storagePath = typeof e.storagePath === 'string' && e.storagePath
      ? e.storagePath
      : e.path.startsWith('/uploads/')
        ? e.path.slice('/uploads/'.length)
        : e.path
    const storageAdapterId = typeof e.storageAdapterId === 'string' ? e.storageAdapterId : ''
    result.push({
      width: e.width,
      height: e.height,
      format: e.format,
      path: e.path,
      sizeBytes: e.sizeBytes,
      storagePath,
      storageAdapterId,
    })
  }
  return result
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function mapMediaAsset(row: MediaAssetRow, folderIds: string[] = []): MediaAsset {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    publicPath: row.public_path,
    uploadedByUserId: row.uploaded_by_user_id ?? null,
    createdAt: toIsoString(row.created_at),
    altText: row.alt_text ?? '',
    caption: row.caption ?? '',
    title: row.title ?? '',
    tags: parseTags(row.tags_json),
    width: numberOrNull(row.width),
    height: numberOrNull(row.height),
    durationMs: numberOrNull(row.duration_ms),
    dominantColor: row.dominant_color ?? null,
    deletedAt: toIsoOrNull(row.deleted_at),
    replacedAt: toIsoOrNull(row.replaced_at),
    folderIds,
    blurHash: row.blur_hash ?? null,
    variants: parseVariants(row.variants_json),
    posterPath: row.poster_path ?? null,
    storageAdapterId: row.storage_adapter_id ?? '',
    externallyHosted: Boolean(row.externally_hosted),
  }
}

/**
 * Hydrate the asset → folder-id map for a batch of assets. One round trip,
 * grouped by asset id. Used by every list / get path so the caller sees the
 * full multi-folder membership without an N+1.
 */
async function loadFolderIdsForAssets(
  db: DbClient,
  assetIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>()
  if (assetIds.length === 0) return map
  for (const id of assetIds) map.set(id, [])

  // Cross-dialect IN-list: SQLite has no native array binding and PG only
  // takes arrays via `= any($n)`. The shared `DbClient` tagged-template form
  // can't expand a JS array into a SQL IN list directly — so we do the
  // expansion explicitly: one row-fetch per asset id (still one DB-conn
  // round-trip per asset, but trivially fast in practice; batch sizes are
  // the visible page slice, ≤ 200).
  for (const assetId of assetIds) {
    const { rows } = await db<{ folder_id: string }>`
      select folder_id from media_asset_folders where asset_id = ${assetId}
    `
    map.set(assetId, rows.map((r) => r.folder_id))
  }
  return map
}

async function hydrateAssets(
  db: DbClient,
  rows: MediaAssetRow[],
): Promise<MediaAsset[]> {
  const folderMap = await loadFolderIdsForAssets(db, rows.map((r) => r.id))
  return rows.map((row) => mapMediaAsset(row, folderMap.get(row.id) ?? []))
}

export async function createMediaAsset(
  db: DbClient,
  input: CreateMediaAssetInput,
): Promise<MediaAsset> {
  // SQLite cross-dialect note: boolean values pass through Bun's tagged
  // template as `true`/`false` for Postgres but need 1/0 for SQLite. The
  // SQLite adapter (`server/db/sqlite.ts`) handles this coercion centrally
  // — passing a JS boolean here works against both engines.
  const { rows } = await db<MediaAssetRow>`
    insert into media_assets (
      id, filename, mime_type, size_bytes, storage_path, public_path,
      uploaded_by_user_id, storage_adapter_id, externally_hosted
    )
    values (
      ${input.id},
      ${input.filename},
      ${input.mimeType},
      ${input.sizeBytes},
      ${input.storagePath},
      ${input.publicPath},
      ${input.uploadedByUserId},
      ${input.storageAdapterId},
      ${input.externallyHosted}
    )
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path,
             storage_adapter_id, externally_hosted
  `
  return mapMediaAsset(rows[0])
}

export async function getMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
           alt_text, caption, title, tags_json, width, height, duration_ms,
           dominant_color, deleted_at, replaced_at,
           blur_hash, variants_json, poster_path,
           storage_adapter_id, externally_hosted
    from media_assets
    where id = ${id}
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * List every media asset (active or in-trash, never both). The repo intentionally
 * returns the full set and lets the handler apply additional filters (folder /
 * type / search / tag / sort / pagination) in JS — cross-dialect dynamic SQL
 * with optional WHERE clauses is fragile and the media library is small enough
 * (low thousands per site) that the round-trip dominates. If a site grows past
 * the comfort zone we'll move filters server-side per-dialect; not premature
 * optimization for M2.
 */
export async function listMediaAssets(
  db: DbClient,
  options: { includeDeleted?: boolean } = {},
): Promise<MediaAsset[]> {
  // Two queries, not one, because cross-dialect optional WHERE clauses in
  // tagged templates require literal SQL text — `includeDeleted` is the
  // only branch.
  const { rows } = options.includeDeleted
    ? await db<MediaAssetRow>`
        select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
               alt_text, caption, title, tags_json, width, height, duration_ms,
               dominant_color, deleted_at, replaced_at,
               blur_hash, variants_json, poster_path,
               storage_adapter_id, externally_hosted
        from media_assets
        where deleted_at is not null
        order by deleted_at desc
      `
    : await db<MediaAssetRow>`
        select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
               alt_text, caption, title, tags_json, width, height, duration_ms,
               dominant_color, deleted_at, replaced_at,
               blur_hash, variants_json, poster_path,
               storage_adapter_id, externally_hosted
        from media_assets
        where deleted_at is null
        order by created_at desc
      `
  return hydrateAssets(db, rows)
}

export async function renameMediaAsset(
  db: DbClient,
  id: string,
  filename: string,
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    update media_assets set filename = ${filename}
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path,
             storage_adapter_id, externally_hosted
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Patch user-editable metadata. The query updates every field unconditionally
 * using COALESCE — undefined inputs map to NULL which preserves the existing
 * column value. This keeps the query shape stable across dialects.
 */
export async function updateMediaAssetMetadata(
  db: DbClient,
  id: string,
  input: UpdateMediaAssetMetadataInput,
): Promise<MediaAsset | null> {
  // Canonical form for the tag column: lowercased, dedup, sorted so equality
  // checks against a "{ tag }" filter behave predictably and the JSON
  // representation is stable across writes.
  const tags = input.tags
    ? Array.from(new Set(input.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))).sort()
    : null

  const filename = input.filename ?? null
  const altText = input.altText ?? null
  const caption = input.caption ?? null
  const title = input.title ?? null

  const { rows } = await db<MediaAssetRow>`
    update media_assets set
      filename = coalesce(${filename}, filename),
      alt_text = coalesce(${altText}, alt_text),
      caption = coalesce(${caption}, caption),
      title = coalesce(${title}, title),
      tags_json = coalesce(${tags}, tags_json)
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path,
             storage_adapter_id, externally_hosted
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Stamp the responsive-pipeline output (intrinsic dimensions + BlurHash +
 * variant index) onto a media row. Called by the upload + replace-file
 * handlers immediately after the variants are written to disk. Kept
 * separate from `updateMediaAssetMetadata` because:
 *   1. These columns are NOT user-editable; they're set exactly once per
 *      binary (or once per replace).
 *   2. We always want to overwrite even when the value happens to be
 *      `null` (e.g. a replaced image with no probable dimensions) — the
 *      COALESCE-keep semantics in `updateMediaAssetMetadata` would be
 *      wrong here.
 */
export async function setMediaAssetVariants(
  db: DbClient,
  id: string,
  input: {
    width: number | null
    height: number | null
    blurHash: string | null
    variants: MediaVariant[]
  },
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    update media_assets set
      width = ${input.width},
      height = ${input.height},
      blur_hash = ${input.blurHash},
      variants_json = ${input.variants}
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path,
             storage_adapter_id, externally_hosted
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Soft delete: stamp `deleted_at`. Restore un-stamps; `deleteMediaAsset`
 * finishes the job by removing the row (and caller removes the on-disk file).
 */
export async function softDeleteMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const nowIso = new Date().toISOString()
  const { rows } = await db<MediaAssetRow>`
    update media_assets set deleted_at = ${nowIso}
    where id = ${id} and deleted_at is null
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path,
             storage_adapter_id, externally_hosted
  `
  if (rows.length === 0) return getMediaAsset(db, id)
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

export async function restoreMediaAsset(
  db: DbClient,
  id: string,
): Promise<MediaAsset | null> {
  const { rows } = await db<MediaAssetRow>`
    update media_assets set deleted_at = null
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path,
             storage_adapter_id, externally_hosted
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Hard delete — removes the row. Caller is responsible for removing the
 * on-disk file using the returned `storagePath`.
 */
export async function deleteMediaAsset(
  db: DbClient,
  id: string,
): Promise<{ storagePath: string } | null> {
  const { rows } = await db<DeletedMediaAssetRow>`
    delete from media_assets
    where id = ${id}
    returning storage_path
  `
  const row = rows[0]
  return row ? { storagePath: row.storage_path } : null
}

/**
 * Replace the binary backing this asset while keeping the same id so every
 * existing reference stays valid.
 *
 * `public_path` is no longer guaranteed stable — when the storage adapter
 * elected for the role differs from the one that wrote the previous
 * binary, the new bytes live on a different backend with a different
 * URL. Renderers reference media by asset id (or path) via the
 * `prefetchMediaAssets` lookup, which re-resolves on each publish, so a
 * URL change is transparent to consumers.
 */
export async function replaceMediaAssetBinary(
  db: DbClient,
  id: string,
  input: {
    filename: string
    mimeType: string
    sizeBytes: number
    storagePath: string
    publicPath: string
    storageAdapterId: string
    externallyHosted: boolean
  },
): Promise<MediaAsset | null> {
  const nowIso = new Date().toISOString()
  const { rows } = await db<MediaAssetRow>`
    update media_assets set
      filename = ${input.filename},
      mime_type = ${input.mimeType},
      size_bytes = ${input.sizeBytes},
      storage_path = ${input.storagePath},
      public_path = ${input.publicPath},
      storage_adapter_id = ${input.storageAdapterId},
      externally_hosted = ${input.externallyHosted},
      replaced_at = ${nowIso}
    where id = ${id}
    returning id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
             alt_text, caption, title, tags_json, width, height, duration_ms,
             dominant_color, deleted_at, replaced_at,
             blur_hash, variants_json, poster_path,
             storage_adapter_id, externally_hosted
  `
  if (rows.length === 0) return null
  const assets = await hydrateAssets(db, rows)
  return assets[0] ?? null
}

/**
 * Storage path of an existing asset without deleting it — used by the
 * replace-file handler to remove the previous binary after writing the new
 * one.
 */
export async function getMediaAssetStoragePath(
  db: DbClient,
  id: string,
): Promise<string | null> {
  const { rows } = await db<{ storage_path: string }>`
    select storage_path from media_assets where id = ${id}
  `
  return rows[0]?.storage_path ?? null
}

/**
 * Pull just the responsive variants for an asset so the replace + purge
 * paths can sweep them off disk alongside the original. Returns an empty
 * array for assets that never had variants (non-image uploads, very small
 * images that didn't need a ladder).
 */
export async function getMediaAssetVariants(
  db: DbClient,
  id: string,
): Promise<MediaVariant[]> {
  const { rows } = await db<{ variants_json: unknown }>`
    select variants_json from media_assets where id = ${id}
  `
  if (rows.length === 0) return []
  return parseVariants(rows[0].variants_json)
}

/**
 * Add and/or remove an asset's folder memberships in one transactional step.
 * Idempotent: re-adding an existing membership is a no-op (relies on the
 * primary key + an INSERT … ON CONFLICT DO NOTHING).
 */
export async function assignAssetToFolders(
  db: DbClient,
  assetId: string,
  input: { add?: string[]; remove?: string[] },
): Promise<MediaAsset | null> {
  return db.transaction(async (tx) => {
    for (const folderId of input.remove ?? []) {
      await tx`
        delete from media_asset_folders
        where asset_id = ${assetId} and folder_id = ${folderId}
      `
    }
    for (const folderId of input.add ?? []) {
      // Cross-dialect upsert — PG 9.5+ and SQLite 3.24+ both accept
      // `ON CONFLICT DO NOTHING` on a primary key conflict.
      await tx`
        insert into media_asset_folders (asset_id, folder_id)
        values (${assetId}, ${folderId})
        on conflict do nothing
      `
    }
    return getMediaAsset(tx, assetId)
  })
}

// ---------------------------------------------------------------------------
// Bundle export / import helpers
// ---------------------------------------------------------------------------

/** Extended asset row that also returns the storage_path column. */
interface MediaAssetExportRow extends MediaAssetRow {
  storage_path: string
}

/**
 * List all non-deleted media assets including their storage paths for bundle
 * export. Storage path is kept separate from the normal `listMediaAssets` query
 * because the public read paths never need to expose it.
 */
export async function listMediaAssetsForExport(db: DbClient): Promise<Array<MediaAsset & { storagePath: string }>> {
  const { rows } = await db<MediaAssetExportRow>`
    select id, filename, mime_type, size_bytes, public_path, uploaded_by_user_id, created_at,
           alt_text, caption, title, tags_json, width, height, duration_ms,
           dominant_color, deleted_at, replaced_at,
           blur_hash, variants_json, poster_path,
           storage_adapter_id, externally_hosted, storage_path
    from media_assets
    where deleted_at is null
    order by created_at asc
  `
  const folderMap = await loadFolderIdsForAssets(db, rows.map((r) => r.id))
  return rows.map((row) => ({
    ...mapMediaAsset(row, folderMap.get(row.id) ?? []),
    storagePath: row.storage_path,
  }))
}

interface ImportMediaAssetInput {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storagePath: string
  publicPath: string
  altText: string
  caption: string
  title: string
  tags: string[]
  width: number | null
  height: number | null
  durationMs: number | null
  dominantColor: string | null
  blurHash: string | null
  posterPath: string | null
  /** Optional; defaults to local-disk when omitted. */
  storageAdapterId?: string
  /** Optional; defaults to false when omitted. */
  externallyHosted?: boolean
}

/**
 * Insert a media asset record preserving its original id and metadata.
 * Used exclusively by the bundle import handler.
 *
 * Variants are intentionally omitted — they regenerate on first request.
 * Folder memberships are not imported (no folder rows to link to yet in
 * the target instance).
 *
 * If an asset with the same id already exists it is replaced.
 */
export async function importMediaAsset(
  db: DbClient,
  input: ImportMediaAssetInput,
): Promise<void> {
  const tags = Array.from(new Set(input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))).sort()
  const storageAdapterId = input.storageAdapterId ?? ''
  const externallyHosted = input.externallyHosted ?? false
  await db`
    insert into media_assets (
      id, filename, mime_type, size_bytes, storage_path, public_path,
      alt_text, caption, title, tags_json, width, height, duration_ms,
      dominant_color, blur_hash, poster_path,
      storage_adapter_id, externally_hosted
    )
    values (
      ${input.id}, ${input.filename}, ${input.mimeType}, ${input.sizeBytes},
      ${input.storagePath}, ${input.publicPath},
      ${input.altText}, ${input.caption}, ${input.title}, ${tags},
      ${input.width}, ${input.height}, ${input.durationMs},
      ${input.dominantColor}, ${input.blurHash}, ${input.posterPath},
      ${storageAdapterId}, ${externallyHosted}
    )
    on conflict (id) do update
      set filename      = excluded.filename,
          mime_type     = excluded.mime_type,
          size_bytes    = excluded.size_bytes,
          storage_path  = excluded.storage_path,
          public_path   = excluded.public_path,
          alt_text      = excluded.alt_text,
          caption       = excluded.caption,
          title         = excluded.title,
          tags_json     = excluded.tags_json,
          width         = excluded.width,
          height        = excluded.height,
          duration_ms   = excluded.duration_ms,
          dominant_color = excluded.dominant_color,
          blur_hash     = excluded.blur_hash,
          poster_path   = excluded.poster_path,
          storage_adapter_id = excluded.storage_adapter_id,
          externally_hosted = excluded.externally_hosted
  `
}
