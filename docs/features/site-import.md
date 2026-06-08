# Site Import

`src/admin/modals/SiteImport` is the canonical import surface. It routes static-site bundles (HTML pages, CSS files, images, fonts, JS) through `src/core/siteImport`, and routes CMS-exported `SiteBundle` JSON files through the CMS transfer endpoints for full import/export parity.

The static-site pipeline has two parts: a pure analysis function (`buildImportPlan`) that produces an `ImportPlan` preview, and an async commit function (`commitImportPlan`) that uploads assets and writes to the store. CMS bundle imports keep their native semantics: validate the `SiteBundle`, preview against `/admin/api/cms/import/preview`, then apply through `/admin/api/cms/import`.

---

## TL;DR

- Entry: global admin-shell modal, opened from Spotlight or workspace actions. Drop files, a folder, a `.zip`, or a CMS-exported `.json` bundle. Static files use the four-stage modal (Drop → Review → Conflicts → Import, with completion shown inside the Import stage). CMS bundles use Drop → Review bundle → Import.
- `buildImportPlan({ fileMap, currentSite })` — pure, synchronous — produces an `ImportPlan` with pages, style rules, media, color tokens, custom fonts, Google font install requests, font tokens, and scripts.
- `commitImportPlan(plan, adapter)` — uploads assets, then wraps all store writes in a single `adapter.commit` call → one Cmd+Z reverts the whole import.
- Static imports load the current CMS draft into the editor store on demand when launched outside `/admin/site`; if no draft exists, the modal creates an empty site before analysis.
- Conflict resolution: rename with a numeric suffix (default), overwrite, skip, or custom-rename — per page slug, per class name, and per design token (colour / font CSS variable), with category-level bulk actions for rename / skip / overwrite. Token renames rewrite `var(--x)` references so imports stay faithful.
- What imports: pages, `kind:'class'` and `kind:'ambient'` style rules, images/fonts/binaries, root CSS color tokens, root CSS font tokens, `@font-face` families, known external font stylesheet imports, ordinary HTML IDs and safe `data-*` attributes on base modules, and HTML-linked JS files as page-scoped runtime scripts.
- CMS bundle import preserves exported tables, rows, optional site shell, and embedded media using the same merge strategies as site transfer (`replace`, `merge-add`, `merge-overwrite`).
- HTML forms import through the shared HTML importer as first-class form primitives (`base.form`, controls, labels, submit buttons), not as custom containers.
- What cannot be modeled: `@keyframes`, `@layer`, and arbitrary/local `@import` — surfaced as warnings when the CSS engine exposes them, never silently dropped.
- Headless: `src/core/siteImport/` carries no admin, React, or server imports (gated by `siteImport-headless.test.ts`).

---

## Where the code lives

```text
src/core/siteImport/
├── index.ts             — public barrel
├── types.ts             — all shared types: FileMap, ImportPlan, ImportResult, ImportWarning, error classes
├── ingestInput.ts       — normalize input(s) → FileMap (loose files / folder / .zip)
├── classifyFiles.ts     — extension/MIME → FileRole: html | css | js | image | font | binary | meta
├── htmlPagePlan.ts      — per-HTML-file plan: parse body via importHtml, derive title + slug, resolve <link> and <script src> references
├── cssToStyleRules.ts   — single-file CSS → StyleRule[] + AssetRef[] + warnings
├── colorTokens.ts       — extract root custom-property color tokens from :root/html/body rules
├── fontTokens.ts        — extract root --font-* custom properties as ImportFontToken[] from :root/html/body rules
├── fontImports.ts       — resolve trusted Google CSS2 @import rules into installed-font requests
├── scopeClasses.ts      — scope colliding class names across per-page stylesheets
├── mimeTypes.ts         — extension → MIME fallback for FileMap entries that carry no MIME type (e.g. ZIP)
├── assetPlan.ts         — normalise URL props/data attributes in node fragments + CSS url(); resolve @font-face; collect assets
├── applyAssetRewrites.ts — patch fragment props + CSS url() with new media URLs (post-upload)
├── linkRewrite.ts       — rewrite intra-site <a href> to cms:page:<id> refs
├── conflicts.ts         — detect page-slug + class-name + design-token collisions; apply resolutions (incl. var(--x) rewrites)
├── adapter.ts           — SiteImportAdapter + SiteImportTransaction interfaces
└── applyImport.ts       — top-level orchestrator: buildImportPlan + commitImportPlan

src/admin/modals/SiteImport/
├── index.ts
├── SiteImportModal.tsx          — canonical import wizard shell + CMS bundle router
├── SiteImportModal.module.css
├── steps/
│   ├── DropStep.tsx             — full-modal drop zone (files, folder, .zip)
│   ├── AnalyzeStep.tsx          — category navigator (left) + detail pane (right)
│   ├── CmsBundleReviewStep.tsx  — CMS bundle diff + merge strategy review
│   ├── ConflictsStep.tsx        — page-slug + class-name + design-token conflict resolution rows
│   └── ImportStep.tsx           — determinate progress surface + complete/failed states
└── shared/
    ├── createSiteImportAdapter.ts  — wires adapter to editor store + media API
    ├── useCmsBundleImport.ts       — CMS bundle parse/preview/import flow
    ├── ConflictRow.tsx             — single slug / class-name / token-variable conflict row with resolution picker
    ├── ImportStepper.tsx           — shared four-stage progress rail (Review + Import)
    └── importProgress.ts           — RunProgress model used by ImportStep
```

---

## Data flow

```text
User drops files / folder / .zip / CMS bundle JSON
            │
            ├─ valid SiteBundle JSON → previewSiteBundle → CmsBundleReviewStep
            │                                      │
            │                                      └─ importSiteBundle(strategy)
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
    │   extractGoogleFontImports(css)                                  │
    │   → ImportGoogleFont[] install requests for trusted CSS2 imports │
    │                                                                │
    │   cssToStyleRules(css, { breakpoints })                        │
    │   → rules[], assetRefs[], conditions[], fontFaces[]            │
    │                                                                │
    │   extractRootColorTokens(rules)                                │
    │   → rules (minus :root color props) + ImportColorToken[]       │
    │                                                                │
    │   extractRootFontTokens(rules)                                 │
    │   → rules (minus :root --font-* props) + ImportFontToken[]     │
    └────────────────────────────────────────────────────────────────┘
            │
    scopeCollidingClasses(pagePlans, cssFileResults)
            │  renames divergent same-named classes per stylesheet
            ▼
    buildAssetPlan(pagePlans, cssFileResults, fileMap)
            │  normalizes url() in node props, data attributes, and CSS values to FileMap keys
            │  resolves @font-face → ImportFontFamily[]
            │  collects deduplicated asset list
            ▼
    detectConflicts(currentSite, pagePlans, styleRules, colorTokens, fontTokens)
            │
            ▼
    ImportPlan ──► wizard preview (AnalyzeStep → ConflictsStep)
            │
            ▼
    commitImportPlan(plan, adapter)
      Step A: upload assets via adapter.uploadAsset (per-asset try/catch)
      Step B: applyAssetRewrites(plan, rewriteMap) — swap FileMap keys → media URLs
      Step C: adapter.commit(tx) — single atomic store mutation:
                tx.addConditions / tx.addColorTokens / tx.overwriteColorTokens / tx.addScripts
                tx.addFonts / tx.addFontTokens / tx.overwriteFontTokens
                tx.addStyleRule / tx.overwriteStyleRule
                tx.addPage / tx.overwritePage
            │
            ▼
    ImportResult → ImportStep complete state (summary + per-category counts)
```

---

## The `ImportPlan` shape

```ts
interface ImportPlan {
  pages:           PagePlan[]
  styleRules:      NewStyleRule[]
  styleRuleSources: string[]   // index-aligned with styleRules: source CSS path per rule
  fonts:           ImportFontFamily[]
  googleFonts:     ImportGoogleFont[]
  fontTokens:      ImportFontToken[]
  conditions:      ConditionDef[]
  assets:          { sourcePath: string; mimeType: string; bytes: Uint8Array }[]
  colors:          ImportColorToken[]
  scripts:         ImportScript[]
  conflicts:       { pages: PageConflict[]; rules: RuleConflict[]; tokens: TokenConflict[] }
  warnings:        ImportWarning[]
  droppedAtRules:  string[]     // source text of un-modelable @-rules
  unusedCss:       string[]     // CSS files present but not linked by any page
}
```

All URL-shaped values inside `pages[].nodeFragment` props, hidden imported `data-*` attribute bags, and style rule `styles`/`contextStyles` are normalised to FileMap keys before the plan is returned — `applyAssetRewrites` does exact-string replacement after upload.

---

## What each category imports

| Category | What | How |
|---|---|---|
| **Pages** | One `PagePlan` per `.html` file | `makeHtmlPagePlan` parses the body via `@core/htmlImport`; slug derived from the relative file path (`documentation/index.html` → `documentation`, `guides/install.html` → `guides/install`) |
| **HTML IDs** | `id="…"` on ordinary elements | The HTML importer stores IDs as `props.htmlId` on base container/text/link/button/image modules so imported CSS selectors, anchors, and classic scripts can target the published DOM |
| **Data attributes** | Safe `data-*` attributes on ordinary elements | Stored as hidden `props.dataAttributes` on base container/text/link/button/image modules so template runtime hooks such as `data-bg-src`, `data-aos`, and `data-bs-*` survive import. Reserved Instatic/editor `data-*` names are not imported. Local asset URLs inside these attributes are uploaded and rewritten. |
| **Style rules** | All rules from linked CSS files | `cssToStyleRules` maps each declaration block to a `NewStyleRule` (class or ambient kind) |
| **Media** | Images, fonts, binaries — and any unreferenced files in the bundle | `buildAssetPlan` collects them; unreferenced files are swept up even if nothing in the HTML/CSS references them |
| **Color tokens** | CSS custom properties on `:root` / `html` / `body` that look like colours | `extractRootColorTokens` pulls them into `ImportColorToken[]`; they become framework palette tokens. A `--<slug>` that collides with an existing colour token surfaces as a `TokenConflict` (rename / skip / overwrite) |
| **Fonts** | Self-hosted `@font-face` families with at least one bundled file, plus trusted Google CSS2 imports | `buildFontFamilies` in `assetPlan.ts` picks the best bundled format (woff2 → woff → ttf → otf); `extractGoogleFontImports` turns Google CSS2 `@import` rules into install requests. Commit uploads custom files via `tx.addFonts`, installs Google families through the CMS Google-font installer, then merges those returned `FontEntry` records via `tx.addInstalledFonts` |
| **Font tokens** | Root `--font-*` variables with font-family stacks | `extractRootFontTokens` pulls them into `ImportFontToken[]`; committed via `tx.addFontTokens` after fonts so matching imported families can be assigned. A `--font-*` that collides with an existing font token surfaces as a `TokenConflict` (rename / skip / overwrite) |
| **Scripts** | JS files linked by imported HTML via `<script src>` | Decoded as UTF-8; committed via `tx.addScripts` with page scope from the source HTML. Classic scripts remain plain `<script>` assets and bypass bundling; `type="module"` scripts keep module semantics. |

---

## CSS rule mapping

`cssToStyleRules` parses a CSS file using the browser's native `CSSStyleSheet.replaceSync()`.

| Source rule | Stored as |
|---|---|
| `.foo { … }` (single class) | `StyleRule{ kind:'class', name:'foo', selector:'.foo' }` |
| `h1`, `body`, `a:hover`, `.hero .title` | `StyleRule{ kind:'ambient', selector: verbatim }` |
| `@media ... { … }` | Merged into a matching viewport context's `contextStyles` when it matches a configured media query (or an older/default max-width threshold); otherwise preserved as a reusable media condition |
| Trusted Google CSS2 `@import` | Parsed into `ImportGoogleFont` install requests and committed as self-hosted installed font entries |
| Arbitrary/local `@import`, `@keyframes`, `@layer` | Dropped; source text added to `droppedAtRules`; a `dropped-at-rule` warning emitted when surfaced by the CSS engine |
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

`detectConflicts(currentSite, pagePlans, styleRules, colorTokens, fontTokens)` produces three lists:

- **`PageConflict`** — a desired slug collides with an existing page slug or with another slug in the same import batch.
- **`RuleConflict`** — a `kind:'class'` rule's name collides with an existing class name. Ambient rules never conflict.
- **`TokenConflict`** — a design-token CSS custom property collides with an existing token. One type covers both colour tokens (keyed by `--<slug>`, against `framework.colors.tokens`) and font tokens (keyed by `--font-*`, against `fonts.tokens`), since both are just a `--var` contract referenced by `var(--x)` in the imported CSS. Imported tokens are deduped per kind upstream, so only site-vs-import collisions occur.

Page slugs can be slash-delimited public paths. Root `index.html` stays the homepage slug `index`; nested `index.html` files use their directory route, so `documentation/index.html` imports as `/documentation` and does not collide with `download-version/index.html`.

Each conflict has a `defaultResolution`:
- `auto-rename` — append `-2` (or `-3`, `-4`, …) until unique. This is the default.
- `overwrite` — replace the existing page / rule / token value.
- `skip` — do not import this item.
- `custom-rename` — the user typed a new slug / class / token variable.

`applyConflictResolutions(plan, pageResolutions, ruleResolutions, tokenResolutions)` applies the resolutions to the plan:
- Page renames update the slug; rule renames update the `name` + `selector` and remap `classIds` on nodes.
- **Token renames** rename the imported token in `plan.colors` / `plan.fontTokens` AND rewrite every `var(--old)` → `var(--new)` reference across the imported style rules (`styles` + `contextStyles`) and node `inlineStyles`, so the imported design keeps resolving to its own token instead of silently binding to the pre-existing same-named one (fallbacks like `var(--x, serif)` are preserved).
- **Token skip** drops the imported token (references keep the old name and bind to the existing token).
- **Token overwrite** keeps the imported token in place; `commitImportPlan` replaces the existing token's value by id via `tx.overwriteColorTokens` / `tx.overwriteFontTokens` (the variable name is unchanged, so both sides keep resolving).

`commitImportPlan` applies page/rule skip/overwrite actions from `defaultResolution` at commit time, and partitions tokens into add vs. overwrite (skip and rename were already materialised into the plan by `applyConflictResolutions`).

The conflict wizard renders bulk controls in each of the three conflict categories — pages, class names, and design tokens — each settable to rename with a numeric suffix, skip, or overwrite in one action; the page overwrite bulk action is hidden when any listed page conflict is only an intra-import collision and has no existing page to replace. Individual rows use segmented controls for the same actions and still allow custom renames after a bulk action.

---

## Atomicity

| Phase | Guarantee |
|---|---|
| Asset uploads (Step A) | Network, not reversible. Per-asset failures are caught, recorded as `asset-upload-failed` warnings, and the import continues. Orphaned uploads are harmless — left in the media library for manual cleanup. |
| Store mutation (Step C) | Single `adapter.commit` call. The admin adapter wraps it in one `mutateAllPagesAndSite` call — one patch-based undo entry. Cmd+Z reverts pages, style rules, fonts, color tokens, and scripts together in one step. |

---

## The wizard

`SiteImportModal.tsx` drives four user-visible stages — **Drop → Review → Conflicts → Import** — shown in the shared `ImportStepper` rail. Completion lives inside the Import stage (the stepper has no separate "Done" stage). Internally the `run` step renders `ImportStep`, whose `RunProgress.phase` switches it between the running, complete, and failed surfaces.

The modal is mounted once at the authenticated admin shell (`AuthenticatedAdmin.tsx`) behind `useAdminUi().siteImportOpen`. It is not owned by the Site editor route. The Site editor, Data workspace, and Spotlight command all open the same shell-level modal state, so importing works from any admin workspace with the required capability.

**Drop** — full-modal drop zone. Accepts loose files, a folder, a `.zip`, or a CMS-exported `.json` bundle. A single JSON file is first checked with `parseSiteBundle`; valid bundles route to the CMS bundle review path. Everything else goes through `ingestInput`, which normalizes static import input shapes to `FileMap`. Static import analysis needs a `currentSite`; when the modal opens outside the Site editor, it loads the CMS draft through `cmsAdapter.loadSite('default')` before calling `buildImportPlan`. Size guards: 1 GB aggregate, 10 k files, 5 GB uncompressed (zip-bomb guard).

**CMS bundle review** — shown when the dropped file validates as `SiteBundle`. The wizard calls `previewSiteBundle` to render a diff against the local site, then lets the user pick `replace`, `merge-add`, or `merge-overwrite`. Commit calls `importSiteBundle`; on success the modal closes and the caller can refresh workspace data.

**Analyze (Review)** — category navigator. Left column: one nav entry per import category with its count and include-toggle, plus "Add more files" (files can be added at any point — re-ingests and rebuilds the plan) and a "Can't import" entry for skipped items. Right pane: detail view per category:
- **Pages** — checkbox + inline slug editor per page.
- **Style rules** — grouped by source stylesheet with a search bar and per-rule checkboxes. Groups up to 60 rules expanded; remaining are collapsed into "+N more".
- **Media** — tiles grouped by MIME class (Images / SVG / GIF / Video / Other) with a per-group Switch.
- **Color tokens** — read-only swatches; all colors always import.
- **Fonts** — Switch per font family; extracted root font variables are shown in the same category and follow the selected family when they reference one.
- **Scripts** — Switch per JS file.
- **Can't import** — list of `unusedCss` + `droppedAtRules` with reasons.

**Conflicts** — shown only when conflicts exist. Page-slug rows and class-name rows each use a segmented control: `Rename | Skip | Overwrite | Custom`.

**Import** (`ImportStep`) — a calm, determinate progress surface (no terminal log). A headline activity (phase verb + N of M), a determinate bar with a travelling shimmer, a one-line current-item ticker, and a per-category breakdown mirroring the Review navigator (pending ring → spinner → mint check, with a tint-washed progress fill). Everything is driven by real pipeline state: media (asset uploads) is the only incremental phase, so it dominates the bar; the other categories land together at the atomic commit. The commit phase is uncancellable; the upload phase is cancellable (orphaned uploads are harmless).

On success the same step switches to its **complete** state — a success mark, an "Imported into &lt;site&gt;" summary, and every category shown as done. Footer actions: **View import log** (reveals per-category counts + warnings) and **Open site →** (jumps to the first imported page). On failure it shows an inline error surface, and the failure is also surfaced via toast.

---

## Warning kinds

| Kind | When emitted |
|---|---|
| `dropped-at-rule` | An unsupported at-rule such as `@keyframes`, `@layer`, or arbitrary/local `@import` was present but cannot be modelled |
| `unmatched-media-query` | Legacy warning kind retained for old import reports; current imports preserve unmatched `@media` blocks as reusable conditions |
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
- [docs/features/site-transfer.md](site-transfer.md) — CMS bundle export/import format and server endpoints used by the JSON branch of this modal
- [docs/reference/page-tree.md](../reference/page-tree.md) — `NodeTree<PageNode>`, `ImportFragment` shape
- [docs/reference/typebox-patterns.md](../reference/typebox-patterns.md) — boundary validation
- Source-of-truth files:
  - `src/core/siteImport/types.ts` — `ImportPlan`, `ImportResult`, `ImportWarning`, `ImportFontToken`, `ImportColorToken`, error classes
  - `src/core/siteImport/applyImport.ts` — `buildImportPlan`, `commitImportPlan`
  - `src/core/siteImport/adapter.ts` — `SiteImportAdapter`, `SiteImportTransaction` interfaces
  - `src/core/siteImport/colorTokens.ts` — `extractRootColorTokens`
  - `src/core/siteImport/fontTokens.ts` — `extractRootFontTokens`
  - `src/core/siteImport/fontImports.ts` — `extractGoogleFontImports`
  - `src/core/siteImport/conflicts.ts` — `detectConflicts`, `applyConflictResolutions`
  - `src/admin/modals/SiteImport/SiteImportModal.tsx` — wizard shell
  - `src/admin/modals/SiteImport/steps/AnalyzeStep.tsx` — category navigator + detail panes
- Gate tests:
  - `src/__tests__/architecture/siteImport-headless.test.ts` — no admin/React/server imports in the pipeline
  - `src/__tests__/siteImport/applyAssetRewrites.test.ts`
  - `src/__tests__/siteImport/conflicts.test.ts`
  - `src/__tests__/admin/siteImport/SiteImportModal.test.tsx`
