# Site Transfer

Export and import — move a complete site between self-hosted instances. One JSON bundle carries the shell, all data tables, all data rows, the media library (assets + their bytes + the folder tree), and published-URL redirects. Everything that defines the *site* travels in one file, so re-importing into a fresh instance reproduces an **identical** site.

The transfer format is **self-contained** — no external service, no signed URLs, no incremental sync. Use it for backup, environment promotion (staging → production), or migrating between hosts.

The **Export site** dialog (`src/admin/pages/data/components/ExportDialog`) is a sibling of the Site Import modal: a two-column category navigator with a detail pane. Every category is selected by default — the primary action is a one-click **full export**. Untick any category to narrow the bundle. A live, server-accurate size estimate updates as the selection changes.

---

## TL;DR

- Format: `SiteBundle` — TypeBox schema in `src/core/data/bundleSchema.ts`.
- Endpoints:
  - `GET /admin/api/cms/export` or `POST /admin/api/cms/export` — produce a bundle from the current site
  - `GET /admin/api/cms/export/estimate` (POST) — exact byte size for an `ExportRequest`, without reading media off disk
  - `GET /admin/api/cms/export/summary` — total counts of the non-table categories (media, folders, redirects) so the dialog can label/disable them
  - `POST /admin/api/cms/import/preview` — analyze a bundle without applying (diff summary)
  - `POST /admin/api/cms/import[?strategy=...]` — apply the bundle
- Export categories: **theme & settings** (the shell), each **content table**, the **media library**, **media folders**, and **redirects** — all on by default.
- UI entry (export): **Export site** in the Data workspace opens `src/admin/pages/data/components/ExportDialog`.
- UI entry (import): drop the exported `.json` into the canonical Site Import modal (`src/admin/modals/SiteImport`). Spotlight and workspace **Import site** actions open this same global shell modal.
- Three import strategies: `replace` (destructive — the full-restore path), `merge-add` (insert if new), `merge-overwrite` (upsert).
- Media bytes are embedded as base64. Variants are **not** exported — they regenerate on first request after import.
- Media folders + redirects are restored by the **`replace`** strategy (the full-restore path); merge strategies leave the local folder tree and redirects untouched.
- v1 caveat: bundles are assembled in memory. Large sites with heavy media will be slow / memory-hungry — chunked streaming is a future improvement.

---

## Where the code lives

```text
src/core/data/bundleSchema.ts
├── MediaAssetExportSchema       — one media asset with bytesBase64 + folderIds
├── BundleMediaFolderSchema      — one media-library folder (tree via parentId)
├── BundleRedirectSchema         — one published-URL redirect (raw row)
├── ImportStrategySchema         — 'replace' | 'merge-add' | 'merge-overwrite'
├── ExportRequestSchema          — POST /export body
├── ExportEstimateSchema         — GET/POST /export/estimate response
├── ExportSummarySchema          — GET /export/summary response (category counts)
├── BundlePreviewSchema          — diff summary
├── ImportResultSchema           — what was applied
└── SiteBundleSchema             — the full bundle shape

server/handlers/cms/
├── export.ts                    — GET+POST /admin/api/cms/export
├── import.ts                    — POST /admin/api/cms/import
└── importPreview.ts             — POST /admin/api/cms/import/preview

src/core/persistence/cmsTransfer.ts   — client-side wrapper (typed fetch helpers)
```

---

## The `SiteBundle` shape

```ts
interface SiteBundle {
  schemaVersion:  1
  exportedAt:     string                    // ISO datetime
  sourceSiteName?: string                   // human-readable name of source site

  /** Optional site shell — settings, breakpoints, classes, files, runtime, package.json */
  site?: SiteShell

  /** All (or selected) data tables — `data_tables` rows */
  tables: DataTable[]

  /** All (or selected) data rows — `data_rows` rows. Cells included verbatim. */
  rows:   DataRow[]

  /** Optional: media assets with bytes embedded as base64. Each carries its `folderIds`. */
  media?: MediaAssetExport[]

  /** Optional: the media-library folder tree (rebuilt from `parentId` links). */
  mediaFolders?: BundleMediaFolder[]

  /** Optional: published-URL redirects. Each targets a row present in `rows`. */
  redirects?: BundleRedirect[]
}
```

`media[].folderIds` carries each asset's folder membership; on import it's restored only into folders that arrived in `mediaFolders`. The export keeps the bundle self-consistent: it only includes a redirect when both its table and its target row are part of the same bundle, so the import never hits a dangling foreign key.

A bundle is a single JSON file. The whole thing parses through TypeBox at the import boundary; mismatched shape rejects the bundle with a clear path.

`MediaAssetExport.storagePath` (and `posterPath`) are constrained at the schema level: the TypeBox pattern forbids a leading `/` and any `..` segment. The import handler enforces a second containment check at the write sink — `assertPathWithin(uploadsDir, join(uploadsDir, storagePath))` in `server/handlers/cms/import.ts` — so a tampered bundle cannot write bytes outside the uploads root even if the schema check were bypassed.

### What's NOT in a bundle

A portable bundle deliberately carries **no secrets and no instance-runtime state** — it travels between hosts and lands as a downloadable file, so credentials must never be in it.

| Excluded                | Why                                                                   |
|-------------------------|-----------------------------------------------------------------------|
| Sessions                | Per-device, security-sensitive                                        |
| Users / roles + passwords | Bundles are for site content, not account migration; password hashes must not travel |
| AI provider keys        | Credentials — never in a portable file                                |
| Audit / login logs      | Local to the host                                                     |
| Published HTML files    | Re-rendered on first publish after import                             |
| Media variants          | Auto-generated by the upload pipeline on first request                |
| Plugin packages + install state | Plugin-owned `data_rows` are in `rows`; the installed-plugin set + package bytes are a separate subsystem |
| Per-user preferences    | Per-device — `localStorage` + `user_preferences` rows                 |

Folder and row authorship (`created_by_user_id`) is **reset to null** on import — the users it referenced don't exist on a fresh instance, exactly like data-row author references.

---

## Export

`GET /admin/api/cms/export` or `POST /admin/api/cms/export`

GET accepts filter options as query-string params. POST accepts a JSON body matching `ExportRequestSchema`:

```ts
{
  // Tables to include, each with an optional row subset. OMIT the whole field
  // for a full export (all tables, all rows). Per entry: omit `rowIds` for the
  // whole table, or list specific row ids for a subset. A table absent from
  // this array is not exported at all.
  tables?:              { tableId: string; rowIds?: string[] }[]
  includeMedia?:        boolean     // embed media bytes; default: false (the dialog sends true)
  includeSite?:         boolean     // include site shell; default: true
  includeMediaFolders?: boolean     // include the folder tree + asset membership; default: true
  includeRedirects?:    boolean     // include published-URL redirects; default: true
}
```

The redesigned **Export site** dialog defaults every category on and content tables to all rows, so its one-click action is a complete full-site export. Opening a content table reveals a **per-row checklist** (pages, posts, components, …) with per-table All / None, so an operator can include or exclude individual entries; the dialog then sends that table with an explicit `rowIds` subset. A table left untouched is sent with no `rowIds` (the whole table) and never needs its rows fetched. `GET` supports whole-table selection only (`?tables=posts,pages`); row-level subsets are POST-only.

The handler:

1. Capability-gates on `data.export`.
2. Loads the shell (always, for `sourceSiteName` even when `includeSite: false`), tables, rows.
3. If `includeMedia: true`, reads media bytes from `uploadsDir` and encodes as base64.
4. Assembles a `SiteBundle` JSON.
5. Returns it with `Content-Type: application/json` and `Content-Disposition: attachment`.

Row visibility: callers without `content.edit.any` / `content.publish.any` / `content.manage` only export their own rows (gated by `canSeeAllDataRows`).

---

## Import preview

`POST /admin/api/cms/import/preview`

Body: a `SiteBundle` JSON (verbatim — no wrapper object).

Returns a `BundlePreview`:

```ts
{
  meta: {
    exportedAt:      string        // from the bundle
    sourceSiteName:  string | null // from the bundle
    schemaVersion:   1
  }
  tables: Array<{
    id:           string
    name:         string
    kind:         DataTableKind
    inBundle:     number    // rows in bundle for this table
    willReplace:  number    // bundle rows whose id exists locally
    willAdd:      number    // bundle rows whose id does not exist locally
    currentLocal: number    // current non-deleted rows on local instance
  }>
  totals: {
    rows:          number   // total rows in bundle
    mediaFiles:    number   // total media assets in bundle
    mediaEmbedded: boolean  // true if bytes are embedded
    mediaFolders:  number   // total folders in bundle
    redirects:     number   // total redirects in bundle
  }
}
```

The preview runs a **dry-run** of the import logic — same code path, just doesn't write. The UI shows the preview before applying.

Capability-gated by `data.export`.

---

## Import

`POST /admin/api/cms/import[?strategy=replace|merge-add|merge-overwrite]`

Body: a `SiteBundle` JSON (verbatim). Strategy is a query-string parameter (default: `replace`).

```ts
type ImportStrategy = 'replace' | 'merge-add' | 'merge-overwrite'
```

| Strategy           | Tables                            | Rows                              | Media                              | Folders + redirects          |
|--------------------|-----------------------------------|-----------------------------------|------------------------------------|------------------------------|
| `replace`          | Wipe + recreate from bundle       | Wipe + recreate                   | Wipe + write all bytes             | Wipe + recreate from bundle  |
| `merge-add`        | Skip if exists; add if new        | Skip if exists; add if new        | Skip if exists; add if new         | Left untouched               |
| `merge-overwrite`  | Upsert (incoming wins)            | Upsert (incoming wins)            | Upsert (incoming bytes win)        | Left untouched               |

Folder membership (`media_asset_folders`) is restored **after** the media bytes land, and only into folders the bundle actually carried. Redirect rows are inserted after their target rows exist (in `replace`, the rows' cascade-delete clears the old redirects first). Folders + redirects ride only the `replace` (full-restore) path because merging a folder tree or redirect set into a populated instance risks unique-key collisions — the same reason the site shell is `replace`/`merge-overwrite`-only.

The handler:

1. Validates the bundle against `SiteBundleSchema`.
2. Runs the same preview logic to compute the change set.
3. Wraps the apply in a **single DB transaction**:
   - Tables: insert / update / delete per strategy.
   - Rows: insert / update / soft-delete per strategy.
   - Site shell: if the bundle carries `site`, overwrite the `site` row.
4. **Outside the transaction**, writes media bytes to `uploads/<storagePath>`. Before writing, the handler calls `assertPathWithin(uploadsDir, target)` (from `server/util/pathWithin.ts`) as a defense-in-depth check — the schema already forbids traversal, but the sink re-asserts containment after `path.join()` resolves symlinks. Media writes are best-effort — if a disk write fails, the row import has already committed and the asset is skipped with a log entry.
5. Returns `ImportResult` with counts.

The transaction is **all-or-nothing** for the DB side — if any insert fails, the DB rolls back. Media may have been partially written; the warning reports which bytes landed.

### Conflict resolution

Per strategy:

- **`replace`**: incoming bundle wins for everything.
- **`merge-add`**: existing rows / tables / media are untouched. Incoming-only items added.
- **`merge-overwrite`**: matching ids upsert. Items not in the bundle are **kept** (vs. `replace` which deletes them).

Conflicts are resolved by **id**, not slug or name. A row in the bundle with the same id as an existing row is the same row.

### Capability gates

| Operation                             | Required capability                                 |
|---------------------------------------|-----------------------------------------------------|
| Export                                | `data.export`                                       |
| Preview                               | `data.export`                                       |
| Apply (any strategy)                  | `data.import`                                       |
| Apply with `replace` strategy         | `data.import` AND `content.manage` AND step-up      |
| Apply bundle that carries `site` shell| ALSO `site.structure.edit`                          |

---

## Round-trip parity

The export → import path round-trips losslessly for everything in the bundle. This is verified by:

- `src/__tests__/architecture/cmsTransferExport.test.ts` — export produces a valid bundle.
- `src/__tests__/architecture/cmsTransferPreview.test.ts` — preview matches what import would do.
- `src/__tests__/architecture/cmsTransferImport.test.ts` — applying then re-exporting produces a bundle equivalent to the original.
- `src/__tests__/architecture/import-export-roundtrip.test.ts` — full round-trip, including a dedicated block that proves the **media folder tree, asset folder membership, and redirects** survive an export → `replace`-import into a pristine instance.

If you change a persisted shape (a new column on `data_rows`, a new field on `data_tables`), you also need to:

1. Add the new field to the matching schema in `bundleSchema.ts`.
2. Handle the new field in `export.ts` (read into the bundle).
3. Handle it in `import.ts` (write from the bundle).
4. Update the round-trip tests so they cover the new field.

---

## Cookbook

### Export everything

```text
POST /admin/api/cms/export
{
  "includeSite": true,
  "includeMedia": true
}
```

Save the response JSON to disk (browser handles the download automatically).

### Move a site between hosts

1. On the source host: export with `includeSite: true, includeMedia: true`.
2. On the destination host: setup wizard completes (creates an owner account, empty site).
3. On the destination host: open **Import Site** from Spotlight or the Data workspace, then drop the exported JSON bundle.
4. Review the preview and import with `strategy: replace`.
5. After import, the published HTML is regenerated on next publish (or `republish-all`).

### Selective export (one table only)

```text
POST /admin/api/cms/export
{
  "includeSite": false,
  "tables": [{ "tableId": "posts" }],
  "includeMedia": true
}
```

Or a specific subset of rows from one table:

```text
POST /admin/api/cms/export
{
  "includeSite": false,
  "tables": [{ "tableId": "posts", "rowIds": ["row_abc", "row_def"] }]
}
```

Useful for moving content (not styling) between sites with similar layouts.

### Backup script

A nightly cron can hit `/admin/api/cms/export` with an admin session cookie and pipe the response to disk. For larger sites, prefer the DB-level `pg_dump` (Postgres) or file copy (SQLite + `Litestream`) — see [docs/deployment/backup-restore.md](../deployment/backup-restore.md).

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| Importing without a preview                                          | Always preview first — `replace` is destructive          |
| Customising the export to add server secrets (DB URL, API keys)      | Bundles travel between hosts — never include secrets     |
| Hand-editing a bundle JSON to patch a row                            | The bundle is validated against `SiteBundleSchema`. Hand edits will be rejected if the shape's wrong; use the admin UI for one-off edits. |
| Renaming a `data_table.id` between export and import                 | Match is by id — different id = different table         |
| Importing media without the matching `data_rows` references           | Orphan media is fine but won't render anywhere          |
| Concurrent imports on the same site                                  | Wrap import in a transaction (already done) but don't run two at once — capability gate + step-up reduces accidental concurrency |
| Storing bundles in version control                                   | Large + binary media bloats the repo. Use object storage / drive. |
| Crafting a bundle with a `storagePath` containing `..` or a leading `/` | Rejected by `MediaAssetExportSchema` at parse time and by `assertPathWithin` at the write sink. Do not rely on either check alone — both must hold. |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/server.md](../server.md) — handler patterns + transactions
- [docs/features/content-storage.md](content-storage.md) — `data_tables` + `data_rows` schemas
- [docs/features/media.md](media.md) — media variants regenerate after import
- [docs/features/site-shell.md](site-shell.md) — site shell shape
- [docs/deployment/backup-restore.md](../deployment/backup-restore.md) — broader backup options
- Source-of-truth files:
  - `src/core/data/bundleSchema.ts` — `SiteBundleSchema`, `ImportStrategySchema`, `BundlePreviewSchema`, `ImportResultSchema`
  - `server/handlers/cms/export.ts` — `GET+POST /export`
  - `server/handlers/cms/import.ts` — `POST /import`
  - `server/handlers/cms/importPreview.ts` — `POST /import/preview`
  - `src/core/persistence/cmsTransfer.ts` — client-side fetch helpers
  - `server/util/pathWithin.ts` — `assertPathWithin` containment helper (media write sink)
- Gate tests:
  - `src/__tests__/architecture/cmsTransferExport.test.ts`
  - `src/__tests__/architecture/cmsTransferPreview.test.ts`
  - `src/__tests__/architecture/cmsTransferImport.test.ts`
  - `src/__tests__/architecture/import-export-roundtrip.test.ts`
