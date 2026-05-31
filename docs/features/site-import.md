# Site Import

`src/core/siteImport` converts a static-site bundle (HTML pages, CSS files, images, fonts, JS) into live CMS pages, style rules, and media-library assets in one undoable step.

The pipeline has two parts: a pure analysis function (`buildImportPlan`) that produces an `ImportPlan` preview, and an async commit function (`commitImportPlan`) that uploads assets and writes to the store. The admin wizard (`src/admin/modals/SiteImport/`) drives both through a five-step modal.

---

## TL;DR

- Entry: drop files, a folder, or a `.zip` → five-step modal (Drop → Analyze → Conflicts → Run → Done).
- `buildImportPlan({ fileMap, currentSite })` — pure, synchronous — produces an `ImportPlan` with pages, style rules, media, color tokens, fonts, and scripts.
- `commitImportPlan(plan, adapter)` — uploads assets, then wraps all store writes in a single `adapter.commit` call → one Cmd+Z reverts the whole import.
- Conflict resolution: auto-rename (default), overwrite, skip, or custom-rename — per page slug and per class name.
- What imports: pages, `kind:'class'` and `kind:'ambient'` style rules, images/fonts/binaries, root CSS color tokens, `@font-face` families, JS files as site-wide scripts.
- What cannot be modeled: `@keyframes`, `@supports`, `@container`, `@layer`, `@import` — surfaced as warnings, never silently dropped.
- Headless: `src/core/siteImport/` carries no admin, React, or server imports (gated by `siteImport-headless.test.ts`).

---

## Where the code lives

```text
src/core/siteImport/
├── index.ts             — public barrel
├── types.ts             — all shared types: FileMap, ImportPlan, ImportResult, ImportWarning, error classes
├── ingestInput.ts       — normalize input(s) → FileMap (loose files / folder / .zip)
├── classifyFiles.ts     — extension/MIME → FileRole: html | css | js | image | font | binary | meta
├── htmlPagePlan.ts      — per-HTML-file plan: parse body via importHtml, derive title + slug, resolve <link>s
├── cssToStyleRules.ts   — single-file CSS → StyleRule[] + AssetRef[] + warnings
├── colorTokens.ts       — extract root custom-property color tokens from :root/html/body rules
├── scopeClasses.ts      — scope colliding class names across per-page stylesheets
├── assetPlan.ts         — normalise URL props in node fragments + CSS url(); resolve @font-face; collect assets
├── applyAssetRewrites.ts — patch fragment props + CSS url() with new media URLs (post-upload)
├── linkRewrite.ts       — rewrite intra-site <a href> to cms:page:<id> refs
├── conflicts.ts         — detect page-slug + class-name collisions; produce ConflictPlan
├── adapter.ts           — SiteImportAdapter + SiteImportTransaction interfaces
└── applyImport.ts       — top-level orchestrator: buildImportPlan + commitImportPlan

src/admin/modals/SiteImport/
├── index.ts
├── SiteImportModal.tsx          — five-step wizard shell
├── SiteImportModal.module.css
├── steps/
│   ├── DropStep.tsx             — full-modal drop zone (files, folder, .zip)
│   ├── AnalyzeStep.tsx          — category navigator (left) + detail pane (right)
│   ├── ConflictsStep.tsx        — page-slug + class-name conflict resolution rows
│   ├── RunStep.tsx              — live upload progress + log
│   └── DoneStep.tsx             — import summary + shortcuts
└── shared/
    ├── createSiteImportAdapter.ts  — wires adapter to editor store + media API
    └── ImportProgress.ts           — RunProgress type used by RunStep
```

---

## Data flow

```text
User drops files / folder / .zip
            │
            ▼
    ingestInput(input)
            │  FileMap: { files: Record<path, {bytes, mimeType}> }
            ▼
    classifyFiles(fileMap)
            │  ClassifiedFile[] — each file has a FileRole
            ▼
    ┌── per HTML file ──────────────────────────────────────────────┐
    │   makeHtmlPagePlan(path, html, fileMap)                       │
    │   → PagePlan { source, title, slug, linkedCssPaths,          │
    │               nodeFragment (via @core/htmlImport) }           │
    └───────────────────────────────────────────────────────────────┘
            │
    ┌── per linked CSS file ─────────────────────────────────────────┐
    │   cssToStyleRules(css, { breakpoints })                        │
    │   → rules[], assetRefs[], conditions[], fontFaces[]            │
    │                                                                │
    │   extractRootColorTokens(rules)                                │
    │   → rules (minus :root color props) + ImportColorToken[]       │
    └────────────────────────────────────────────────────────────────┘
            │
    scopeCollidingClasses(pagePlans, cssFileResults)
            │  renames divergent same-named classes per stylesheet
            ▼
    buildAssetPlan(pagePlans, cssFileResults, fileMap)
            │  normalizes url() in node props + CSS values to FileMap keys
            │  resolves @font-face → ImportFontFamily[]
            │  collects deduplicated asset list
            ▼
    detectConflicts(currentSite, pagePlans, styleRules)
            │
            ▼
    ImportPlan ──► wizard preview (AnalyzeStep → ConflictsStep)
            │
            ▼
    commitImportPlan(plan, adapter)
      Step A: upload assets via adapter.uploadAsset (per-asset try/catch)
      Step B: applyAssetRewrites(plan, rewriteMap) — swap FileMap keys → media URLs
      Step C: adapter.commit(tx) — single atomic store mutation:
                tx.addConditions / tx.addColorTokens / tx.addScripts
                tx.addFonts / tx.addStyleRule / tx.overwriteStyleRule
                tx.addPage / tx.overwritePage
            │
            ▼
    ImportResult → DoneStep summary
```

---

## The `ImportPlan` shape

```ts
interface ImportPlan {
  pages:           PagePlan[]
  styleRules:      NewStyleRule[]
  styleRuleSources: string[]   // index-aligned with styleRules: source CSS path per rule
  fonts:           ImportFontFamily[]
  conditions:      ConditionDef[]
  assets:          { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
  colors:          ImportColorToken[]
  scripts:         ImportScript[]
  conflicts:       { pages: PageConflict[]; rules: RuleConflict[] }
  warnings:        ImportWarning[]
  droppedAtRules:  string[]     // source text of un-modelable @-rules
  unusedCss:       string[]     // CSS files present but not linked by any page
}
```

All URL-shaped values inside `pages[].nodeFragment` and style rule `styles`/`contextStyles` are normalised to FileMap keys before the plan is returned — `applyAssetRewrites` does exact-string replacement after upload.

---

## What each category imports

| Category | What | How |
|---|---|---|
| **Pages** | One `PagePlan` per `.html` file | `makeHtmlPagePlan` parses the body via `@core/htmlImport`; slug derived from filename |
| **Style rules** | All rules from linked CSS files | `cssToStyleRules` maps each declaration block to a `NewStyleRule` (class or ambient kind) |
| **Media** | Images, fonts, binaries — and any unreferenced files in the bundle | `buildAssetPlan` collects them; unreferenced files are swept up even if nothing in the HTML/CSS references them |
| **Color tokens** | CSS custom properties on `:root` / `html` / `body` that look like colours | `extractRootColorTokens` pulls them into `ImportColorToken[]`; they become framework palette tokens |
| **Fonts** | Self-hosted `@font-face` families with at least one bundled file | `buildFontFamilies` in `assetPlan.ts` picks the best format (woff2 → woff → ttf → otf); committed via `tx.addFonts` |
| **Scripts** | Every `.js` / `.mjs` / `.cjs` file | Decoded as UTF-8; committed via `tx.addScripts` as all-pages body-end scripts |

---

## CSS rule mapping

`cssToStyleRules` parses a CSS file using the browser's native `CSSStyleSheet.replaceSync()`.

| Source rule | Stored as |
|---|---|
| `.foo { … }` (single class) | `StyleRule{ kind:'class', name:'foo', selector:'.foo' }` |
| `h1`, `body`, `a:hover`, `.hero .title` | `StyleRule{ kind:'ambient', selector: verbatim }` |
| `@media (max-width: Npx) { … }` | Merged into matched breakpoint's `contextStyles`; unmatched folds into base styles with a warning |
| `@keyframes`, `@supports`, `@container`, `@layer`, `@import` | Dropped; source text added to `droppedAtRules`; a `dropped-at-rule` warning emitted |
| `@font-face` | Captured as `ParsedFontFace`; resolved into `ImportFontFamily` by `buildAssetPlan` |

---

## Class scoping across stylesheets

A multi-page site typically links one stylesheet per page, and those stylesheets routinely use the same class name (`.btn`, `.hero`) with different declarations. The CMS has a single global style rule registry, so a naïve merge would let one page's class clobber another's.

`scopeCollidingClasses` (`scopeClasses.ts`) runs after CSS parsing and before the asset plan:

- **One distinct definition** across all stylesheets → bare name kept; the class is shared.
- **N distinct definitions** → first keeps the bare name; the rest get a numeric suffix (`btn`, `btn-2`, …). Definitions that are identical share a name.

The rename is applied consistently: the `kind:'class'` rule's `name` + `selector`, every ambient selector in that stylesheet that references the class as a token, and the `classIds` tokens on every node of every page linked to that stylesheet. A `scoped-class` warning is emitted per scoped name.

Pure element / attribute selectors (`body`, `h1`, `a:hover`) carry no class token and cannot be scoped — they remain global, last cascade order wins.

---

## Conflict resolution

`detectConflicts` produces two lists:

- **`PageConflict`** — a desired slug collides with an existing page slug or with another slug in the same import batch.
- **`RuleConflict`** — a `kind:'class'` rule's name collides with an existing class name. Ambient rules never conflict.

Each conflict has a `defaultResolution`:
- `auto-rename` — append `-2` (or `-3`, `-4`, …) until unique. This is the default.
- `overwrite` — replace the existing page / rule.
- `skip` — do not import this item.
- `custom-rename` — the user typed a new slug or class name.

`applyConflictResolutions` applies the resolutions to the plan (renames page slugs, renames rule selectors, remaps `classIds` on nodes). `commitImportPlan` applies skip/overwrite actions from `defaultResolution` at commit time.

---

## Atomicity

| Phase | Guarantee |
|---|---|
| Asset uploads (Step A) | Network, not reversible. Per-asset failures are caught, recorded as `asset-upload-failed` warnings, and the import continues. Orphaned uploads are harmless — left in the media library for manual cleanup. |
| Store mutation (Step C) | Single `adapter.commit` call. The admin adapter wraps it in one Immer history snapshot. Cmd+Z reverts pages, style rules, fonts, color tokens, and scripts together in one step. |

---

## The wizard

Five steps in `SiteImportModal.tsx`:

**Drop** — full-modal drop zone. Accepts loose files, a folder, or a `.zip`. `ingestInput` normalizes all input shapes to `FileMap`. Size guards: 1 GB aggregate, 10 k files, 5 GB uncompressed (zip-bomb guard).

**Analyze (Review)** — category navigator. Left column: one nav entry per import category with its count and include-toggle, plus "Add more files" (files can be added at any point — re-ingests and rebuilds the plan) and a "Can't import" entry for skipped items. Right pane: detail view per category:
- **Pages** — checkbox + inline slug editor per page.
- **Style rules** — grouped by source stylesheet with a search bar and per-rule checkboxes. Groups up to 60 rules expanded; remaining are collapsed into "+N more".
- **Media** — tiles grouped by MIME class (Images / SVG / GIF / Video / Other) with a per-group Switch.
- **Color tokens** — read-only swatches; all colors always import.
- **Fonts** — Switch per font family.
- **Scripts** — Switch per JS file.
- **Can't import** — list of `unusedCss` + `droppedAtRules` with reasons.

**Conflicts** — shown only when conflicts exist. Page-slug rows and class-name rows, each with a dropdown: `Auto-rename | Overwrite | Skip | Custom…`.

**Run** — live upload progress (count + log). The commit phase is uncancellable; the upload phase is cancellable (orphaned uploads are harmless).

**Done** — import summary: N pages, M style rules, K assets. Action buttons: **View first imported page**, **Open Selectors panel**. Warnings list for anything that needs attention.

---

## Warning kinds

| Kind | When emitted |
|---|---|
| `dropped-at-rule` | A `@keyframes`, `@supports`, `@container`, `@layer`, or `@import` was present but cannot be modelled |
| `unmatched-media-query` | An `@media` max-width/min-width did not match any defined breakpoint within ±10 px; inner rules folded into base styles |
| `invalid-rule` | A CSS rule caused `replaceSync` to throw (sheet-level parse error) |
| `blocked-property` | A CSS property name is on the security denylist (`behavior`, `-moz-binding`, …) — declaration dropped |
| `duplicate-class` | Two `.foo {}` rules in the same file; later declarations win |
| `scoped-class` | A class was defined differently across stylesheets; definitions scoped to distinct names |
| `missing-stylesheet` | A `<link rel="stylesheet">` href was not found in the FileMap |
| `asset-upload-failed` | An individual asset upload was rejected by the server; the original FileMap path remains in the import |
| `external-font` | An `@font-face` with no bundled file (all `src` entries are external URLs) — skipped |

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing from `src/core/siteImport/` deep paths outside the module | Use the barrel: `import { buildImportPlan } from '@core/siteImport'` |
| Adding React, admin, or server imports to any file in `src/core/siteImport/` | Keep the pipeline headless; gated by `siteImport-headless.test.ts` |
| Using `as Foo` at a boundary instead of the TypeBox schema | All boundaries use `readValidatedBody` / TypeBox schemas |
| Silent empty `catch (_err)` in the commit loop | Per-asset failures emit an `asset-upload-failed` warning and continue |
| Calling `commitImportPlan` without running `buildImportPlan` first | The plan's `styleRuleSources`, `conflicts`, and `droppedAtRules` fields are required by the wizard |

---

## Related

- [docs/features/html-import.md](html-import.md) — `@core/htmlImport` is used by `htmlPagePlan.ts` to parse each HTML file's body into a `PageNode` fragment
- [docs/features/site-transfer.md](site-transfer.md) — the separate CMS bundle export/import (JSON-based round-trip for CMS-native data, not static HTML)
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<PageNode>`, `ImportFragment` shape
- [docs/reference/typebox-patterns.md](../reference/typebox-patterns.md) — boundary validation
- Source-of-truth files:
  - `src/core/siteImport/types.ts` — `ImportPlan`, `ImportResult`, `ImportWarning`, error classes
  - `src/core/siteImport/applyImport.ts` — `buildImportPlan`, `commitImportPlan`
  - `src/core/siteImport/adapter.ts` — `SiteImportAdapter`, `SiteImportTransaction` interfaces
  - `src/admin/modals/SiteImport/SiteImportModal.tsx` — wizard shell
  - `src/admin/modals/SiteImport/steps/AnalyzeStep.tsx` — category navigator + detail panes
- Gate tests:
  - `src/__tests__/architecture/siteImport-headless.test.ts` — no admin/React/server imports in the pipeline
  - `src/__tests__/siteImport/applyAssetRewrites.test.ts`
  - `src/__tests__/siteImport/conflicts.test.ts`
  - `src/__tests__/admin/siteImport/SiteImportModal.test.tsx`
