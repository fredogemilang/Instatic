# Super Import — multi-page sites from files, folders, or a ZIP

## TL;DR

A user drops one or many files of an existing static site (HTML pages, CSS files, JS, images, fonts) — loose files, a folder, or a `.zip` — into the editor. The CMS imports every page as a real Page with a real node tree, every stylesheet as real style rules in a generalized **Selectors System** (not limited to single class names), every asset as a media-library upload, and rewrites every reference (`<img src>`, `<a href>`, `url(...)` in CSS) to the new locations — atomically, with a wizard that previews exactly what's going where and resolves conflicts.

The pre-requisite is a one-time extension of the styling model: today's **classes** become a special case of a more general **style rule** keyed by a selector expression (`.hero`, `h1`, `h1 > span`, `.card .title`, …). Without this, the importer would have to mangle the source CSS or skip everything but single-class rules — neither is acceptable.

## Motivation

- Today's importers (paste-HTML modal, agent `insertHtml`) handle **structure only**, with CSS limited to the `classes` array on the tool input or post-hoc `createClass` calls. There is no path to import a multi-file site.
- Real static sites (`index.html`, `about.html`, `style.css`, `assets/img/hero.png`, …) are the most natural starting point for users coming from any tool that produces a folder/zip (Webflow exports, vite/Next.js static exports, Figma → code generators, hand-written sites).
- Critically: real CSS uses **selectors that aren't single classes**: element rules (`h1 { ... }`), descendant rules (`.hero .title { ... }`), state rules (`a:hover`), reset rules (`* { box-sizing: border-box }`). A faithful importer needs the engine to understand these.
- The same selectors-system upgrade also unlocks new authoring affordances inside the editor: "style every `h1` in this site," "style the `.hero` group's `.title` descendant," etc. — long-requested patterns blocked today by the class-only constraint.

## Goals

1. **Files → live site.** Drop loose files, a folder, or a `.zip` of a static site and get pages, stylesheets, and media imported into the editor with one undoable step (per the project's atomicity bar). The four input shapes — single file, multi-file selection, folder, zip — all converge on the same headless pipeline.
2. **Faithful CSS.** Every CSS rule that the engine *can* model is imported as a real style rule. Anything we drop is **explicitly surfaced** in the import summary (no silent loss).
3. **Faithful asset URLs.** Every reference inside HTML and CSS (`src`, `href`, `srcset`, `url(...)`, `<link rel="icon">`) is rewritten to its new media-library URL.
4. **Interactive, never destructive.** The wizard previews what's going where, resolves conflicts via Auto-rename + per-item override, and never overwrites silently.
5. **Generalized selectors as the foundation.** `CSSClass` becomes a special case of `StyleRule` (class kind) inside a registry that also holds element / compound / descendant / pseudo / attribute selectors (ambient kind). The Selectors panel becomes the single home for both.

## Non-goals

- **Pixel-perfect fidelity for un-modeled CSS.** `@keyframes`, `@supports`, `@container`, custom properties at non-:root scope, CSS layers, modern container queries — surfaced as warnings, addressed incrementally.

> **Implemented since the original plan:**
> - **JavaScript files are imported** (no longer dropped). Each `.js` file in the bundle becomes a `SiteFile` (`type: 'script'`) plus an all-pages `site.runtime.scripts` entry, so it runs on every published page (`placement: body-end`, `timing: dom-ready`). `ImportPlan.scripts` carries them; the wizard previews them under a **Scripts** section.
> - **Root colour custom properties become colour tokens.** Colour-valued `--*` declarations on `:root` / `html` / `body` are pulled into the CMS colours system (`site.settings.framework.colors`) as plain base tokens (just `--<slug>`; no shades/tints/utility classes) and removed from the originating rule so `--<slug>` isn't double-emitted. `ImportPlan.colors` carries them; the wizard previews them under a **Colors** section. Non-colour custom properties (`--font-sans`, `--radius`) stay on the `:root` rule.
- **Round-trip export.** This plan only covers import. Export already exists for the CMS's native bundle format (`cmsTransfer.ts`); a "matching" static export is a separate workstream.
- **Backward compatibility for the existing CSSClass shape.** Pre-release per `CLAUDE.md`; we rename in place.

## Confirmed scope decisions

| # | Decision | Source |
|---|---|---|
| 1 | **Selectors system as Phase 0.** Generalize `CSSClass` into `StyleRule` with a `selector` expression and a `kind` (`'class'` or `'ambient'`). | User instruction, this round |
| 2 | ~~**JS files — skip with warning.**~~ **Superseded:** JS files are now imported as all-pages site scripts (`ImportPlan.scripts` → `tx.addScripts`). | User instruction (later extended) |
| 3 | **Conflict policy — Auto-rename + per-item override.** Defaults: incoming `about` → `about-2`, incoming `hero` → `hero-2`. Wizard step lets the user flip any to skip / overwrite / custom-rename. | User instruction |

## Phasing overview

Each phase ships independently. Each is gated by its own architecture/test suite. Phases compose top-down — Phase 0 is a hard prerequisite for the importer's CSS faithfulness goal.

```
Phase 0 — Selectors System (model extension)
   ↓
Phase 1 — CSS file → style rules (parser + per-rule mapping)
   ↓
Phase 2 — Super Import core pipeline (zip → plan → apply, headless)
   ↓
Phase 3 — Super Import wizard UI (Drop → Analyze → Conflicts → Run → Done)
   ↓
Phase 4 — Polish & follow-ups (JS, fonts, per-page scope, advanced selectors)
```

## Phase 0 — Selectors System (the model extension)

### Why this is first

The CSS importer's value depends on whether the engine can store and emit rules like `h1 > span`. Building the importer first would force one of:
- a class-only subset (drops most rules, defeats the goal), or
- a "wrap every ambient rule in a fake class" hack (architectural band-aid, blocked by `CLAUDE.md`'s anti-band-aid rule).

Extending the model first lets every downstream phase emit faithful CSS with no remapping.

### Data model

Rename and generalize:

```ts
// src/core/page-tree/styleRule.ts  (rename of cssClass.ts)
export type StyleRuleKind = 'class' | 'ambient'

export interface StyleRule {
  id: string
  /**
   * Discriminates how the rule attaches to nodes:
   *   - 'class':   the rule's selector is `.<name>`. The rule lives in
   *                node.classIds; the publisher emits the name into the
   *                node's class attribute and the rule into the stylesheet.
   *   - 'ambient': the rule attaches by CSS matching, not node assignment.
   *                The publisher emits the rule into the stylesheet only;
   *                no class attribute changes.
   */
  kind: StyleRuleKind
  /**
   * The selector EXPRESSION written verbatim into the published CSS:
   *   - kind:'class'   → ".<name>" (auto-derived from name; not user-typed)
   *   - kind:'ambient' → any valid selector, e.g. "h1 > span", "body",
   *                      ".hero .title", "a:hover", "[data-state='on']"
   */
  selector: string
  /**
   * Human-friendly display name. For 'class' kind, this is the class
   * identifier without the leading dot. For 'ambient' kind, defaults to
   * `selector` but the user can override (e.g. "Hero headline").
   */
  name: string
  description?: string
  scope?: { type: 'node'; nodeId: string; role: 'module-style' }
  styles: CSSPropertyBag
  breakpointStyles: Record<BreakpointId, CSSPropertyBag>
  tags?: string[]
  generated?: GeneratedClassMetadata
  /**
   * Source-CSS cascade order. Imported rules preserve their position in the
   * source stylesheet so author intent survives. User-created rules append
   * at the end. The publisher emits rules in ascending `order` so the
   * resulting cascade matches the source.
   */
  order: number
  createdAt: number
  updatedAt: number
}
```

**Site document field rename:** `site.classes` → `site.styleRules`. Migration is a one-line key rename in `validate.ts`; no production data to preserve.

**Node attachment:** `node.classIds` keeps its name (it's still an array of style-rule ids that drive the class attribute). Only `kind:'class'` ids are valid in `classIds`; an ambient rule never appears there. Enforced by a runtime assertion in `addNodeClass`.

### Publisher / cascade

`src/core/publisher/cssCollector.ts` and `frameworkCss.ts` change shape:

- **Per-page rule set:** instead of just iterating `node.classIds` to collect class rules, the collector takes the union of:
  - `kind:'class'` rules referenced via any node's `classIds` on the page, and
  - **all** `kind:'ambient'` rules whose selector matches any node on the page.

  The match test for ambient rules uses the same CSS engine the browser uses: build a string of test elements from the node tree (one per `tag` + attrs subset), feed it into a `Document.implementation.createHTMLDocument()` + `querySelector(rule.selector)`. If anything matches, include the rule. Cheap because it runs once per ambient rule per published page.

- **Emission order:** rules sorted by `order` ascending. Within ties, class rules first then ambient (so a more-specific element-targeting rule can override a class default — matches authored CSS intent).

- **`cssClassSelector` becomes `styleRuleSelector`:** returns `rule.selector` verbatim (already a valid CSS selector for both kinds). No more `.${escapeIdentifier(name)}` indirection.

- **`classNamesForClassIds` becomes `classAttrTokensForClassIds`:** still resolves ids → names but skips any id whose rule is not `kind:'class'` (defensive — `classIds` is supposed to hold only class ids, but the guard prevents accidental ambient ids from polluting the class attribute).

### Validation

- For `kind:'class'`: validate `name` with the existing `assertValidCssClassName` and assert `selector === `.${escape(name)}``. Names are unique across the whole registry.
- For `kind:'ambient'`: validate `selector` by trying it through the browser's selector engine (`document.createElement('div').querySelector(selector)` throws on invalid selectors — catch and turn into a typed `StyleRuleSelectorError`). Selectors are NOT required to be unique; multiple rules with identical selectors can coexist (and cascade by `order`).
- **Blocked selector tokens at storage time:** `@import`, `@keyframes`, `@font-face` are not selectors — they're @-rules and don't fit `StyleRule`. They get their own storage (Phase 4 follow-ups).

### Editor UX

`SelectorsPanel.tsx` (already present) extends as follows:

- The filter bar (`All | User | Utility`) gains a `Class | Ambient` toggle (or merges into the existing filter). Default `All`.
- "Add selector" opens a dialog that asks: kind (radio), selector text (string for ambient, identifier for class), name, optional description. Live-validates selector text.
- Class rules behave exactly as today (ClassPicker, ClassComposer, assignment to nodes).
- Ambient rules show a usage indicator: "matches N nodes on this page" via the same DOM matching as the publisher. Clicking jumps to the first match.

### Tests

- Architecture: rename gate `cssClass → styleRule` across the codebase; new gate `node-classids-only-class-kind.test.ts` proves `classIds` never contains an ambient id.
- Unit: selector validation (valid vs invalid expressions), publisher emission order (cascade matches source), `classAttrTokensForClassIds` filters ambient ids.
- Integration: a page with both a class rule and an ambient rule renders both in the right cascade order; ambient rule's selector matches the right nodes.

### Out-of-scope for Phase 0

- The CSS importer itself (Phase 1).
- Pseudo-class-specific state UI ("style this class's :hover" with a tab) — Phase 0 just stores the rule as ambient; UX for pseudo-states is a Phase 4 follow-up.
- Per-page scoping for rules (Phase 4 follow-up — see [Open questions](#open-questions)).

---

## Phase 1 — CSS file → style rules

### Parser

Use the browser's own CSS parser. No external dependency.

```ts
const sheet = new CSSStyleSheet()
sheet.replaceSync(cssText)
for (const rule of sheet.cssRules) {
  // rule.constructor.name === 'CSSStyleRule' | 'CSSMediaRule' | ...
}
```

- Zero deps. Native error messages on invalid CSS.
- Test environment: happy-dom (already preloaded) provides `CSSStyleSheet`. If a specific construct isn't supported by happy-dom, we polyfill or hold the rule's text and round-trip it back unmodified into a `kind:'ambient'` StyleRule.

### Rule mapping

| Source rule | Storage |
|---|---|
| `.foo { ... }` (single class) | `StyleRule{ kind:'class', name:'foo', selector:'.foo', styles }` |
| `h1 { ... }`, `body { ... }`, `* { ... }` | `StyleRule{ kind:'ambient', name:'h1', selector:'h1', styles }` |
| `.hero .title { ... }`, `h1 > span` | `StyleRule{ kind:'ambient', name:<selector>, selector:<selector>, styles }` |
| `.foo:hover { ... }`, `a::after` | `StyleRule{ kind:'ambient', name:<selector>, selector:<selector>, styles }` |
| `[data-state='on']` | `StyleRule{ kind:'ambient', selector:'[data-state=\'on\']' }` |
| `@media (...) { .foo { ... } }` | Merge into the rule's `breakpointStyles` (see below) |
| `@keyframes`, `@font-face`, `@supports`, `@container`, `@layer` | **Dropped**, surfaced in import summary as warnings: `"@keyframes 'pulse' not imported"` |
| `@import url('...')` | Dropped (we already have the file in the zip; circular import would be infinite). Surfaced as warning. |

### CSSPropertyBag conversion

`CSSStyleDeclaration` returns kebab-case keys (`background-color`); our `CSSPropertyBag` uses camelCase. Convert via a small `kebabToCamel` helper applied per declaration. Values pass through as strings.

### `@media` → breakpoint mapping

The site defines breakpoints with explicit width thresholds. For each `@media` query in the source CSS:

1. **Try to match** to a defined breakpoint:
   - `max-width: Npx` matches a breakpoint whose `maxWidth ≈ N` (±10px tolerance).
   - `min-width: Npx` matches similarly via `minWidth`.
   - Combined queries (`(min-width: A) and (max-width: B)`) match a breakpoint whose `[minWidth, maxWidth]` matches the bracket.
2. **If matched:** the contained rules merge into the `breakpointStyles[matchedId]` of their target style rule.
3. **If unmatched:** surface in the wizard's Conflicts step with three options:
   - Map to an existing breakpoint (dropdown).
   - Create a new breakpoint (with derived width).
   - Drop the @media block (rules outside it are still imported).

Default: prompt — never silently drop responsive CSS.

### `url(...)` rewriting

Every `url('assets/bg.png')` inside a CSS rule's styles is recorded in the asset plan (Phase 2). After upload, the URL is rewritten to the new media path before the rule is stored.

### Tests

- Per-rule: each row of the mapping table has a snippet test.
- Selectors: every selector kind round-trips via `replaceSync` → store → `cssText` rebuild.
- @media: matching tolerance, unmatched-prompt simulation.
- url(): rewriting respects `url('...')`, `url("...")`, `url(...)`, multiple urls per rule, `image-set(...)`.
- Invalid CSS: a syntax error surfaces as a `StyleRuleParseError` with line context; the importer continues past it (per-rule resilience).

---

## Phase 2 — Super Import core pipeline (headless)

### Module layout

```
src/core/siteImport/
├── index.ts             public barrel
├── types.ts             FileMap, ImportPlan, ImportResult, ImportWarning shapes
├── ingestInput.ts       normalize input(s) → FileMap. One entry per input shape:
│                          - loose File[]            (just keep paths as name)
│                          - directory upload        (webkitRelativePath preserved)
│                          - .zip                    (unpack via JSZip; strip a
│                                                     single shared top-level
│                                                     folder if all entries
│                                                     share one)
├── classifyFiles.ts     extension/MIME → role: html | css | js | image | font | other
├── htmlPagePlan.ts      per-page importHtml + title + slug derivation + <link>-resolved CSS list
├── cssToStyleRules.ts   Phase 1 wrapper for a single CSS file → StyleRule[] + warnings
├── assetPlan.ts         scan fragments + CSS for asset refs; plan uploads + URL rewrite map
├── applyAssetRewrites.ts patch fragment node props + CSS url(...) with new media URLs
├── scopeClasses.ts      per-page class scoping for cross-stylesheet name collisions
├── conflicts.ts         detect page-slug / rule-name collisions; produce ConflictPlan
└── applyImport.ts       atomic orchestrator: upload → mutate store → return ImportResult
```

### Cross-stylesheet class scoping (`scopeClasses.ts`)

A multi-page export links **one stylesheet per page**, and those stylesheets
routinely reuse the same class name (`.btn`, `.hero`, `.site-header`, …) with
**different declarations** — e.g. `index.html`'s `instatic.css` has
`.btn { border-radius: 0 }` while `original.html`'s `style.css` has
`.btn { border-radius: 999px }`. The CMS has a single **global** class registry,
so a naive name-merge lets one page's class silently clobber the other's — the
loser renders with the wrong styles (rounded buttons that should be square, a
collapsed hero that lost its `min-height`/`position`, etc.).

`scopeCollidingClasses` runs in `buildImportPlan` between CSS parsing and the
asset plan. For each class name it groups the per-file definitions by their
*content* (base `styles` + `contextStyles`):

- **one distinct definition** → keep the bare name; the class is shared across
  pages (no duplication).
- **N distinct definitions** → the first keeps the bare name, the rest get a
  numeric suffix (`btn`, `btn-2`, …). Files sharing a definition share its name.

A rename is applied **consistently within each source stylesheet**: the
`kind:'class'` rule's `name` + `selector`, every `kind:'ambient'` selector in
that file that references the class as a token (`.btn-solid:hover`,
`.btn.btn-lg`, `.plan-cta .btn`), and the `classIds` tokens on the nodes of
every page that links that stylesheet. Each page then renders with exactly the
class definitions from its own stylesheet. One `scoped-class` warning is emitted
per scoped name for the wizard's Done step.

**Limitation:** pure element / attribute selectors (`body`, `h1`, `a:hover`)
carry no class token and cannot be scoped — they remain global and the last
definition in cascade order wins on every page.

### File classification

| Extension | Role |
|---|---|
| `.html`, `.htm` | `html` |
| `.css` | `css` |
| `.js`, `.mjs`, `.cjs` | `js` (skip + warn per scope decision) |
| `.png`, `.jpg`, `.jpeg`, `.webp`, `.avif`, `.svg`, `.gif`, `.ico` | `image` |
| `.woff`, `.woff2`, `.ttf`, `.otf`, `.eot` | `font` (uploaded; @font-face is Phase 4) |
| `.pdf`, `.zip`, `.csv`, etc. | `binary` (uploaded as media assets) |
| `.txt`, `.md`, `.json`, README*, LICENSE* | `meta` (ignored, summarized) |

Hidden files (`.DS_Store`, `Thumbs.db`, `__MACOSX/*`) silently dropped (with a summary count).

### Page metadata derivation

For each `.html` file:
- **Title:** `<title>...</title>` if present, else filename without extension, prettified (`hero-lab.html` → `Hero Lab`).
- **Slug:** filename without extension, slugified (`Hero Lab.html` → `hero-lab`). `index.html` → slug `index` (homepage).
- **Referenced CSS list:** parse `<head>` for `<link rel="stylesheet" href="...">` and resolve to the FileMap. CSS files **not** linked from any imported page are still imported (they're in the bundle) but tagged as "unused" in the summary.

### Atomicity

The whole import is one undoable step:
1. Asset uploads first (network, can't roll back cleanly — but they're additive: failed orphan uploads are harmless and reaped by a background sweep).
2. Once all uploads succeed, a single `mutateActiveTreeAndSite` (or a new `mutateAllPagesAndSite`) call commits pages + rules + class-link in one history snapshot. **Cmd+Z reverts the whole import in one step.**
3. On any failure during the store mutation: no partial state (Immer rolls the producer). The wizard surfaces the error and leaves the assets uploaded (they remain available to retry).

### ImportResult shape

```ts
interface ImportResult {
  pages: { id: string; title: string; slug: string }[]
  styleRules: { id: string; selector: string; kind: StyleRuleKind }[]
  assets: { sourcePath: string; mediaUrl: string }[]
  conflicts: {
    pages: { source: string; resolved: { action: 'renamed' | 'overwritten' | 'skipped'; toSlug?: string } }[]
    rules: { source: string; resolved: { action: 'renamed' | 'overwritten' | 'skipped'; toName?: string } }[]
  }
  warnings: ImportWarning[]  // {kind, message, source?, sample?}
  droppedJs: string[]
  droppedAtRules: string[]
}
```

### Tests

- Pipeline: each input shape (loose-files / folder / zip) with 3 pages, 2 CSS, 5 images → produces an **identical** ImportPlan + ImportResult (shape-agnostic invariant).
- Asset rewriting: every `<img src>`, `<a href>`, `url(...)` is rewritten; no source paths remain in the live tree.
- Slug derivation: filename → slug + title pretty-printing.
- Conflict resolution: incoming page `about` collides with existing — auto-rename to `about-2`; user-override skip → skipped.
- Atomicity: forced failure during the store mutation leaves no orphan classes or partial pages.
- "Unused CSS" detection: a CSS file linked by no imported page is summarized as unused, not imported by default.

---

## Phase 3 — Wizard UI

`src/admin/modals/SiteImport/SiteImportModal.tsx` — modal with five steps:

### Step 1 — Drop

- Full-modal drop zone. Accepts **any of**:
  - a single file (`.html`, `.css`, an image — useful for "drop one page in"),
  - many loose files at once (multi-select drag, Cmd-click in file picker),
  - a folder (drag a folder in, or pick a folder via `<input type="file" webkitdirectory>`),
  - a `.zip` (unpacked client-side via JSZip; if every entry shares one top-level folder, that prefix is stripped silently).
- Drag uses `DataTransferItem.webkitGetAsEntry()` to walk dropped folders; file picker uses `<input type="file" multiple>` + `webkitdirectory` for the folder-pick affordance.
- Path normalization: each input shape produces a `FileMap` keyed by relative path (`assets/img/hero.png`). The downstream pipeline is shape-agnostic.
- Validates aggregate size ≤ N MB (default 1 GB), file count (max 10k), zip uncompressed-bomb guard (max 5 GB).
- Progress for unpacking (zip) or reading (loose files / folder).

### Step 2 — Analyze (preview "what goes where")

Side-by-side panes:
- **Left:** file tree of the unpacked zip, color-coded by role.
- **Right:** grouped target list:
  - **Pages (N):** each with a checkbox, title, derived slug, source file path. Quick-edit slug inline.
  - **Style rules (N):** grouped by source CSS file. Counts of `class` vs `ambient`. Expandable list shows selector text.
  - **Media (N):** grouped by inferred folder. Counts per file type.
  - **Skipped (M):** JS files, @-rules that can't be modeled, hidden files. Each with a reason.

Top bar: "Importing N pages, M style rules, K media files. Dropping J scripts and L unmodeled @-rules."

User can deselect anything they don't want to import.

### Step 3 — Conflicts

Only shown if conflicts exist (else skipped). One section per category:
- **Page slugs:** rows of `source.html → suggested-slug`, with a dropdown per row: `Auto-rename | Overwrite | Skip | Custom…`.
- **Rule names:** same shape for `kind:'class'` rules whose name already exists.
- **Unmatched @media:** rows of `(max-width: 800px) → Map to: [breakpoint dropdown] | Create new | Drop`.

Top bar: "M conflicts to resolve."

### Step 4 — Run

- Progress bar with phase indicators: `Uploading assets (N/M) → Parsing CSS → Applying changes`.
- Cancellable until the store-mutation phase; uncancellable after (atomicity).
- Live log of "Uploaded `assets/hero.png`", "Imported class `.btn-primary`", etc.

### Step 5 — Done

- Big summary card:
  - "Imported **N pages**, **M style rules**, **K assets**."
  - "Dropped **J scripts**, **L unmodeled @-rules** — view list."
  - Three quick actions: **View first imported page**, **Open Selectors panel**, **Close**.
- Inline list of warnings, each clickable to jump to the affected page or rule.

### Entry points

- Spotlight command: **Import Site** (subtitle "files, folder, or .zip").
- Dashboard "Pages" empty-state CTA.
- Inside the existing ImportDialog: a "From static site" tab (reuses dialog chrome).
- Right-click on the page tree → **Import here…** (drops files/folder/zip into a chosen parent page-group).

### Component reuse

- Drop zone primitive: reuse `src/admin/pages/data/components/ImportDialog/` patterns (file drop UX is already proven there).
- Conflict resolution rows: a generic `ConflictRow` component (slug/name/at-rule variants).
- Progress bar + log: a shared `ImportProgress` component (will also benefit a future "site export" or "plugin install" surfacing).

### Tests

- Step navigation (back/forward/cancel).
- Drop validation across input shapes (`.tar.gz` rejected, oversized aggregate rejected, zip-bomb guarded, empty drop produces a clear empty-state).
- Conflict resolution preserves user choices when going back/forward.
- Run-step failure surfaces in a way the user can retry without re-dropping the zip.

---

## Phase 4 — Polish & follow-ups

These ship after the v1 above is solid. Order is independent.

- **JS handling.** Two flavors:
  - Per-page scripts: hook into the existing site-runtime / scriptConfig (referenced in the git history). UX: each `<script src>` referenced by an imported page becomes a per-page script asset.
  - Site-level scripts: a global injection point for `analytics.js` and similar.
- **`@font-face` + font assets.** Auto-detect, upload the font file via media, create a site-level font config; surface in the Typography panel.
- **`@keyframes`** as first-class animation rules (separate registry: `site.animations`).
- **Advanced selectors UX.** Inline preview of "this rule matches N elements" in the SelectorsPanel; pseudo-state authoring tabs (`:hover`, `:focus`, `:active`).
- **Per-page rule scope.** Some imported CSS is genuinely page-specific (e.g. `hero-lab.css` linked only from `Hero Lab.html`). Add a `pageId | null` scope to StyleRule so the publisher only emits page-scoped rules on their owning page.
- **Layout extraction.** Detect identical `<header>` / `<footer>` across imported pages and offer to extract into a Visual Component (one-shot dialog at the end of the wizard).
- **Re-import diff.** Drop the same zip again — surface a diff (pages added/changed/removed) and apply selectively.

## Decisions log

| # | Decision | Why |
|---|---|---|
| D-1 | Selectors System extension is Phase 0, before the CSS importer | Building the importer first would force a degraded subset or an architectural band-aid (CLAUDE.md anti-band-aid rule). |
| D-2 | Rename `CSSClass` → `StyleRule`, `site.classes` → `site.styleRules` | Pre-release; "fix at the source" per CLAUDE.md. The class panel name "Selectors" already matches. |
| D-3 | Two kinds: `'class'` (attached via classIds) and `'ambient'` (matched by CSS) | Cleanest split: classes are the only kind that needs the class attribute. |
| D-4 | Browser `CSSStyleSheet().replaceSync()` for the parser | Zero dep; native error reporting; works in browser + happy-dom test env. |
| D-5 | Drop all `.js` in v1 with summary | User instruction. |
| D-6 | Auto-rename + per-item override for conflicts | User instruction; never destructive. |
| D-7 | @media unmatched → prompt in wizard | Silent drop of responsive CSS would be a faithfulness failure. |
| D-8 | Imported CSS rule order preserved via `order: number` | Cascade equivalence is a faithfulness requirement. |
| D-9 | One undoable history step for the whole import | Matches the project's atomicity bar; Cmd+Z reverts. |

## Open questions

The plan is buildable as-written; these are pre-implementation refinements worth pinning down. Each has a proposed default (★) so we can move forward if unanswered.

- **Q-A.** Per-page rule scope in v1 or Phase 4? ★ **Phase 4.** Site-wide is simpler and matches the current model. If specific feedback emerges that imported sites pollute the global selectors list, we promote it.
- **Q-B.** SelectorsPanel "Add ambient rule" UX in Phase 0 or Phase 4? ★ **Phase 0** (minimal version: a single text input + live-validate). The importer creates rules programmatically anyway, but if users can't author one by hand, the model extension has no editor surface.
- **Q-C.** Layout extraction (shared `<header>`/`<footer>` → Visual Component) — opt-in dialog vs always-on? ★ **Phase 4 opt-in.** Don't surprise users in v1; analytic upgrade later.
- **Q-D.** Maximum aggregate size + count gates (any input shape) — what are the right defaults? ★ **1 GB aggregate / 10k files / 5 GB uncompressed (zip-bomb guard).** Revisit when we have one real import to benchmark.
- **Q-E.** Should `kind:'class'` rules without an attached node (no node references them) be auto-pruned? ★ **No.** Treat as user-authored "available to use later." The Selectors panel already shows usage count.

## Test plan

Per phase, the gates are:

- **Phase 0:** rename gate test; `classIds` only holds class-kind rules; publisher emission order matches source; selector validation; existing class-panel tests pass unchanged.
- **Phase 1:** mapping-table test (one snippet per row); selector round-trip; @media tolerance; `url(...)` rewriting; invalid CSS resilience.
- **Phase 2:** end-to-end fixture (`__tests__/siteImport/fixtures/sample-site.zip`) round-trips into the expected plan + result; atomicity (forced failure leaves no partial state); slug/name conflict resolution.
- **Phase 3:** wizard navigation; drop validation; conflict-choice persistence; retry without re-drop.

Architectural rules to add under `src/__tests__/architecture/`:
- `style-rule-naming.test.ts` — `CSSClass` symbol no longer exists.
- `no-class-css-selector-in-publisher.test.ts` — publisher imports `styleRuleSelector`, not `cssClassSelector`.
- `classids-only-class-kind.test.ts` — proves `addNodeClass` rejects ambient ids.
- `site-import-zip-deps.test.ts` — `src/core/siteImport/` doesn't pull React or admin-side code (must stay headless).

## Related

- [`docs/features/html-import.md`](../features/html-import.md) — the HTML pipeline this builds on; Phase 2 reuses `importHtml` per page and `insertImportedNodes`' name→id linking.
- [`docs/features/agent.md`](../features/agent.md) — the agent's `insertHtml.classes` array is conceptually a tiny inline version of the CSS importer; both paths converge in `insertImportedNodes`.
- [`docs/plans/2026-05-29-html-pipeline.md`](2026-05-29-html-pipeline.md) — the original HTML pipeline plan; this plan extends its scope from "structure" to "site."
- `src/admin/pages/site/panels/SelectorsPanel/SelectorsPanel.tsx` — the panel that grows in Phase 0 to host both kinds of rules.
- `src/core/publisher/cssCollector.ts`, `frameworkCss.ts`, `classInjection.ts` — touched in Phase 0 for the new emission rules.
