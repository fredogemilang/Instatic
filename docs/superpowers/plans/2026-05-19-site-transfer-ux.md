# Site transfer UX: state-of-the-art export / import

**Status:** Draft plan, not yet implemented. Replaces the v1 export/import shipped in the unified-content-storage refactor.
**Author:** Design discussion 2026-05-19 (continuation).
**Scope:** Export and import dialogs, strategy picker, preview-with-diff, bulk-export integration.

## Motivation

The v1 export/import is a single round-trip with no UX scaffolding. Concretely:

- Export is a single button — no choice of what to include. Always exports every table, every row, the site shell. Media is included unconditionally if `uploadsDir` is set.
- Import is a file-picker that immediately wipes and replaces everything. No preview, no strategy, no feedback beyond a (just-added) toast.
- There is no way to export only the selected rows even though the grid has bulk-select.
- No way to merge incoming content into the current site without destroying existing data.

For the CMS to be the canonical site-transfer tool (so users don't need a plugin), this needs the standard set of features mature CMSes ship:

1. Pick what to export (tables, optionally specific rows, optionally include media).
2. Preview what's in a bundle before applying.
3. Three import strategies: replace all, merge-add, merge-overwrite.
4. Per-table diff before commit.
5. Bulk-export from the grid's existing checkbox selection.

This plan covers the redesign end-to-end.

## Non-goals

- Resumable / streaming uploads for very large bundles. Bundles stay one-shot JSON for v2. Streaming is a v3 concern.
- Cloud-targeted export (e.g. push directly to another running CMS via API). Bundle stays a downloadable JSON file.
- Selective field-level merging (cherry-pick per-cell changes). Granularity is row-level — you import a row or you don't.
- Plugin-managed import sources. We provide one canonical endpoint pair; plugins that want custom transfer can build on top of it but the core CMS owns the UX.

## End-state behavior

### Export

Sidebar "Export site" button opens a dialog (no more direct download).

```
┌─ Export site ─────────────────────────────────────┐
│ What to include                                   │
│  ☑ Site shell (breakpoints, settings, classes)    │
│  ☐ Media files (will increase bundle size)        │
│                                                   │
│ Tables                                            │
│  ☑ Posts        14 rows                           │
│  ☑ Pages         2 pages                          │
│  ☑ Components    0 components                     │
│  ☑ My data       3 rows                           │
│                                                   │
│ Scope                                             │
│  ● All rows of the selected tables                │
│  ○ Only the 3 rows I've selected in the grid      │
│                                                   │
│  Estimated size: ~127 KB                          │
│                                                   │
│           [Cancel]      [Download bundle]         │
└───────────────────────────────────────────────────┘
```

- "Site shell" toggle controls whether `bundle.site` is included. Defaults on.
- "Media files" toggle controls whether bytes are embedded. Defaults **off** — the file paths still serialize as media references inside row cells, so a bundle imported on a target that already has those files keeps working.
- "Tables" checkboxes filter `bundle.tables` + `bundle.rows`. All tables checked by default.
- "Scope" radio:
  - **All rows** (default) — every row from every checked table.
  - **Only the N rows I've selected in the grid** — only available when the user has rows checked in the active grid. Disables the "Tables" checkboxes and forces the active table.
- Estimated size: computed client-side from rough row size + media file count × 100KB estimate.

Grid bulk-action bar gets an **"Export selected"** button alongside Publish / Move to draft / Delete. Clicking it opens the same Export dialog but pre-selects the "Only the N rows" radio.

### Import

Sidebar "Import site" button opens a dialog.

**Step 1 — file picker.** Drop zone or file input. Client parses + validates the bundle against `SiteBundleSchema` immediately. If invalid, show the validation error and stop.

**Step 2 — preview (after a valid file is loaded).**

```
┌─ Import site ─────────────────────────────────────┐
│ Bundle: site-bundle-2026-05-18T12-30-00.json      │
│ Exported: 18 May 2026, 12:30                      │
│ From site: "My Production Site"                   │
│                                                   │
│ Diff against current site:                        │
│  • Posts        12 in bundle, 2 will replace,     │
│                 10 new (current: 14 rows)         │
│  • Pages        2 in bundle, 1 will replace,      │
│                 1 new (current: 2 pages)          │
│  • Components   0 in bundle (current: 0)          │
│  • Media files  43 (not embedded — paths only)    │
│                                                   │
│ Import strategy                                   │
│  ○ Replace everything                             │
│     Wipe the local site and replace with the      │
│     bundle. Default for full restores.            │
│  ● Merge — add only                               │
│     Insert bundle rows that don't exist locally;  │
│     skip when an id already exists. Safe.         │
│  ○ Merge — overwrite                              │
│     Upsert every bundle row. Local rows that      │
│     aren't in the bundle stay untouched.          │
│                                                   │
│           [Cancel]      [Import]                  │
└───────────────────────────────────────────────────┘
```

The diff is computed by `POST /admin/api/cms/import/preview` (validates + diffs, does **not** commit). Result:

```ts
{
  meta: { exportedAt, sourceSiteName },
  tables: [
    { id, name, kind, inBundle: N, willReplace: N, willAdd: N, currentLocal: N }
  ],
  totals: { rows: N, mediaFiles: N, mediaEmbedded: boolean },
}
```

After commit, a success toast surfaces the strategy + row counts:

> ✓ Import complete · Merge-add · 11 rows added · 1 row skipped (already present)

### Bulk-export shortcut

`DataGrid.tsx` already has the bulk action bar (Publish, Move to draft, Delete) when rows are checked. Add an **Export selected** button. Clicking it dispatches to a context callback (`onExportRows`) that opens the Export dialog with `mode: 'selected', rowIds: [...]`.

## Backend changes

### Bundle schema

`SiteBundleSchema` gets two new optional fields, both backwards-compatible (new bundles fill them; older bundles still validate):

```ts
const SiteBundleSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  exportedAt: Type.String(),
  /** New: human-readable source identifier so the import preview can say
   *  "Exported from site 'X'". Falls back to schemaVersion if absent. */
  sourceSiteName: Type.Optional(Type.String()),
  site: Type.Optional(SiteShellSchema),    // was required — now optional (user can deselect)
  tables: Type.Array(DataTableSchema),
  rows: Type.Array(DataRowSchema),
  media: Type.Optional(Type.Array(MediaAssetExportSchema)),
})
```

Pre-release per CLAUDE.md: no migration shim, just change the schema and update consumers.

### Export endpoint

```
GET /admin/api/cms/export
    ?tables=<comma-separated table ids>
    ?rowIds=<comma-separated row ids>
    ?includeMedia=0|1
    ?includeSite=0|1
```

Behavior:

- Default (no params) — full export, media off, site shell on. Same as v1 minus the media-by-default.
- `tables` filters which tables and their rows are included.
- `rowIds` further filters rows (only used when the dialog's "selected rows" scope is chosen). Implies tables = the parent tables of those rows.
- `includeMedia=1` embeds asset bytes; `includeMedia=0` omits the `media` field entirely.
- `includeSite=0` omits the `site` field.

For large `rowIds` lists, fall back to `POST /admin/api/cms/export` with a JSON body of the same shape:

```ts
const ExportRequestSchema = Type.Object({
  tables: Type.Optional(Type.Array(Type.String())),
  rowIds: Type.Optional(Type.Array(Type.String())),
  includeMedia: Type.Optional(Type.Boolean()),
  includeSite: Type.Optional(Type.Boolean()),
})
```

POST is the canonical path for the dialog; GET stays for bookmarkable / scriptable exports.

### Import preview endpoint

```
POST /admin/api/cms/import/preview
Body: SiteBundle JSON
```

Returns a `BundlePreview` (no DB writes):

```ts
const BundlePreviewSchema = Type.Object({
  meta: Type.Object({
    exportedAt: Type.String(),
    sourceSiteName: Type.Union([Type.String(), Type.Null()]),
    schemaVersion: Type.Literal(1),
  }),
  tables: Type.Array(Type.Object({
    id: Type.String(),
    name: Type.String(),
    kind: DataTableKindSchema,
    inBundle: Type.Number(),       // rows in bundle for this table
    willReplace: Type.Number(),    // rows in bundle whose id exists locally
    willAdd: Type.Number(),        // rows in bundle whose id does NOT exist locally
    currentLocal: Type.Number(),   // rows currently in the local DB for this table
  })),
  totals: Type.Object({
    rows: Type.Number(),
    mediaFiles: Type.Number(),
    mediaEmbedded: Type.Boolean(),
  }),
})
```

Implementation: parse + validate bundle, fetch local row ids per table, compute the per-table counts via set intersection. No transaction, no writes.

### Import endpoint — strategy dispatch

```
POST /admin/api/cms/import?strategy=replace|merge-add|merge-overwrite
Body: SiteBundle JSON
```

Three strategies:

| Strategy | Tables | Rows | Site shell |
|---|---|---|---|
| `replace` (current behavior) | Delete non-system tables, upsert tables from bundle | `DELETE FROM data_rows`, then insert bundle rows | Overwrite |
| `merge-add` | Insert bundle tables that don't exist locally; leave existing tables alone (fields stay as-is) | For each bundle row: insert if id not present, skip if id exists | Only overwrite when `bundle.site` is present **and** local `site.settings_json` is the default (untouched) |
| `merge-overwrite` | Insert bundle tables that don't exist; for existing tables, update fields | Upsert all bundle rows | Overwrite when `bundle.site` is present |

Response:

```ts
{
  ok: true,
  strategy: 'replace' | 'merge-add' | 'merge-overwrite',
  tablesAffected: N,
  rowsInserted: N,
  rowsReplaced: N,
  rowsSkipped: N,
  mediaImported: N,
}
```

### Repository changes

`importDataRow` currently does upsert (good for `merge-overwrite`). We need:

- `insertDataRowIfAbsent(db, input)` — for `merge-add`. Insert only if `id` doesn't exist; return whether it inserted.
- `replaceDataRow(db, input)` — for `replace`. Insert; assumes table was wiped before.
- `upsertDataRow(db, input)` — rename of existing `importDataRow`. For `merge-overwrite`.

The import handler picks the right repository fn based on `strategy`.

## Frontend changes

### New components

```
src/admin/pages/data/components/ExportDialog/
  ExportDialog.tsx
  ExportDialog.module.css
  useExportEstimate.ts        — client-side bundle size estimator
src/admin/pages/data/components/ImportDialog/
  ImportDialog.tsx
  ImportDialog.module.css
  ImportFileDropZone.tsx      — drop / pick / parse + validate
  ImportPreviewPanel.tsx      — renders BundlePreview as a per-table diff list
  useImportPreview.ts         — POSTs to /import/preview, returns the result
```

### Wiring

- **`DataSidebar.tsx`** — Replace the two action handlers (`handleExport`, `handleFileChange`) with dialog triggers. Keep the toast feedback.
- **`DataPage.tsx`** — hold dialog open-state (`exportDialog`, `importDialog`), wire `onImportComplete` to refresh tables AND rows (already fixed in the bug-fix pass).
- **`DataGrid.tsx`** — add `onExportRows?(rowIds: string[])` prop; render an "Export selected" button in the bulk-action bar that calls it.
- **`DataCanvas.tsx`** — pass `onExportRows` through to the grid.

### Client-side persistence helpers

```
src/core/persistence/cmsTransfer.ts
  exportSiteBundle(opts: ExportRequest): Promise<Blob>
  previewSiteBundle(bundle: SiteBundle): Promise<BundlePreview>
  importSiteBundle(bundle: SiteBundle, strategy: ImportStrategy): Promise<ImportResult>
```

All three use `readEnvelope` / TypeBox validation at the boundary per CLAUDE.md.

## Test gates

| Test | Purpose |
|---|---|
| `cmsTransferExport.test.ts` | Verify `tables` / `rowIds` / `includeMedia` / `includeSite` filters compose correctly |
| `cmsTransferPreview.test.ts` | Diff math: willReplace = bundle.rows[id] ∩ local.rows[id], willAdd = bundle \ local |
| `cmsTransferImport.test.ts` | Each of the three strategies produces the right final DB state |
| `import-export-roundtrip.test.ts` (extend) | Roundtrip with each strategy; assert counts match the response |
| Component tests for ExportDialog / ImportDialog | Form interactions, validation, strategy picker, preview render |

## Implementation order

1. **Backend schema + endpoints** (~1 day)
   - Extend `SiteBundleSchema`, add `BundlePreviewSchema`, `ImportStrategySchema`, `ExportRequestSchema`
   - Refactor export handler to accept query/body filters
   - Add `/import/preview` handler
   - Refactor import handler to dispatch on strategy
   - New / renamed repository helpers (`insertDataRowIfAbsent`, `upsertDataRow`)
2. **Client persistence layer** (~½ day)
   - `cmsTransfer.ts` with the three helpers
3. **ExportDialog** (~1 day)
   - Form, size estimator, "selected rows" mode
4. **ImportDialog** (~1 day)
   - Drop zone, validate, preview, strategy picker
5. **Grid integration** (~½ day)
   - `onExportRows` prop, bulk-action bar button
6. **Polish + tests** (~1 day)
   - Toast copy, focus management, keyboard nav, the test gates above

**Honest range: 4–6 days of focused work.**

## Decision log

| Question | Decision | Rationale |
|---|---|---|
| Import strategies | All three (replace, merge-add, merge-overwrite) | Covers restore, append, and update workflows |
| Export scope | Per-table checkboxes + bulk-selected rows | Matches user's mental model of "what's in the grid right now"; integrates with existing multi-select |
| Preview | Per-table diff against current site | Confirms intent before destructive operation; mature-CMS expectation |
| Media default | Off, opt-in | Keeps bundles small; refs survive when files exist on target |
| Bundle schema versioning | `schemaVersion: 1` stays | Pre-release; the v1 bundle from this same project is the only consumer |
| Site shell inclusion | Optional, default on | Users may want to export just data without overwriting their site config |
| Streaming / chunking | Out of scope | v3 concern; in-memory JSON is fine for the row volumes we target |

## Risks

- **Strategy mismatch**: A user picks `replace` when they meant `merge-add` and wipes their site. Mitigation: the preview clearly says "Replace 23 rows" vs "Add 5 rows", and the confirm button label matches the strategy. The dialog also surfaces a "this is destructive" warning specifically on `replace`.
- **Large bundles in memory**: A site with 10K rows + 1GB media in one JSON blob will OOM the browser. v2 caps at "everything in memory" — we document the limit and address it in v3 with chunked uploads.
- **Stale preview**: If another user changes the DB between the preview and the commit, the diff is wrong. Acceptable for self-hosted single-user use; multi-user instances rarely hit it. Mitigation note: preview returns row counts but not row content, so the actual commit is the source of truth.

## Open questions during implementation

1. **Strategy-specific copy** — exact wording for each toast and the confirm button. Defer to UX pass during step 6.
2. **Empty bundle handling** — if a bundle has 0 rows / 0 tables, what does the preview show? Probably an info-state with "No content in this bundle" and a disabled Import button.
3. **Custom table id conflicts on `merge-add`** — if the bundle has a custom table `foo` and the local site also has `foo` with different fields, what happens? Decision: tables in `merge-add` are insert-if-absent; fields stay local. Document this in the preview ("Posts: fields will NOT be updated in merge-add mode").
