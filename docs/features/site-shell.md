# Site Shell

The site shell — the top-level persisted site config. Everything that's "the site" but **not** a page or a Visual Component lives here: name, viewport contexts (`breakpoints` in the persisted schema), settings (colors, typography, spacing), class registry, files, Site Explorer organization, dependencies, and runtime config.

The shell is stored in a single `site` row. Pages and VCs live separately in `data_rows`. The adapter assembles a full `SiteDocument` (shell + pages + VCs) on load.

---

## TL;DR

- One row in the `site` table. Loaded as `SiteShell`; assembled at the client into `SiteDocument` (= `SiteShell & { pages, visualComponents }`).
- Source-of-truth schema: `src/core/page-tree/siteDocument.ts` → `SiteShellSchema`.
- Sub-schemas:
  - `Breakpoint[]` — viewport contexts: canvas frame widths plus their published media queries
  - `SiteSettings` — color tokens, typography, spacing scale, framework tokens
  - `Record<string, StyleRule>` — the style rule registry (user-defined CSS rules)
  - `SiteFile[]` — arbitrary text/CSS/JS files attached to the site
  - `SiteExplorerOrganization` — decorative folders and ordering for Site Explorer sections
  - `SitePackageJson` — `package.json` for the per-site `bun install` workspace
  - `SiteRuntimeConfig` — dependency lock + scripts
- Pages and VCs are **not** embedded. The architecture gate `no-vc-in-site-shell.test.ts` enforces this.
- Tolerant parse: missing identity fields throw; missing settings / files / styleRules / runtime fall back to defaults.

---

## The shape

`src/core/page-tree/siteDocument.ts`:

```ts
export type SiteShell = {
  id:           string
  name:         string
  breakpoints:  Breakpoint[]
  settings:     SiteSettings
  styleRules:   Record<string, StyleRule>
  files:        SiteFile[]
  explorer:     SiteExplorerOrganization
  packageJson:  SitePackageJson
  runtime:      SiteRuntimeConfig
  createdAt:    number
  updatedAt:    number
}

export type SiteDocument = SiteShell & {
  pages:             Page[]
  visualComponents:  VisualComponent[]
}
```

`SiteDocument` is the **in-memory** view the editor and publisher work with. The DB persists three things separately:

| Persisted shape    | DB location                                                    |
|--------------------|----------------------------------------------------------------|
| `SiteShell`        | `site` row, `settings_json` column                             |
| `Page[]`           | `data_rows` rows where `table_id = 'pages'`                    |
| `VisualComponent[]`| `data_rows` rows where `table_id = 'components'`               |

The site shell schema **does not** include pages or VCs — gated by `no-vc-in-site-shell.test.ts`.

---

## Sub-shapes

### `Breakpoint`

`src/core/page-tree/breakpoint.ts`:

```ts
type Breakpoint = {
  id:            string     // 'mobile' | 'tablet' | 'desktop' | custom
  label:         string
  width:         number     // canvas frame width in px
  mediaQuery?:   string     // published CSS condition; defaults to `(max-width: ${width}px)`
  icon:          string     // pixel-art-icons name
  previewFrame?: boolean    // false keeps the context selectable without rendering a frame
}
```

The default set (`DEFAULT_BREAKPOINTS`):

| id        | label   | width | mediaQuery |
|-----------|---------|-------|------------|
| `mobile`  | Mobile  | 375   | `(max-width: 375px)` |
| `tablet`  | Tablet  | 768   | `(max-width: 768px)` |
| `desktop` | Desktop | 1440  | `(max-width: 1440px)` |

Viewport contexts power three things:

- The canvas's per-viewport iframes (the user sees their page rendered at each context's `width`).
- The `breakpointOverrides` on each `PageNode` (per-viewport prop overrides).
- The class registry's responsive CSS (`@media ...` queries from each context's `mediaQuery`).

Viewport contexts can be added / removed / reordered through Settings → Viewport contexts. Adding a context can create a new canvas frame when `previewFrame !== false`; frameless contexts remain selectable editing contexts for published CSS.

### `SiteSettings`

`src/core/page-tree/siteSettings.ts`. The site-level design tokens emitted into published CSS:

```ts
type SiteSettings = {
  colorTokens:        Record<string, string>     // 'primary' → '#ff7700', 'surface' → '#fff', etc.
  typographyTokens:   { fontFamily: ..., baseSize: ..., scale: ..., headingScale: ... }
  fonts:              { items: FontEntry[], tokens: FontToken[] }
  spacingScale:       number[]                   // [0, 4, 8, 16, 24, 32, ...]
  framework:          FrameworkConfig            // generated utility classes (spacing utilities)
  containerWidth:     number                     // max-width for the publisher's `--container-width`
  // ... more
}
```

`settings.fonts.items` is the installed self-hosted font asset library (Google downloads and custom media-backed font files). `settings.fonts.tokens` is the editable builder-facing contract: each token owns a stable variable such as `font-primary`, an optional assigned `FontEntry` id, and a fallback stack. The publisher emits those as `:root { --font-primary: "Family", sans-serif; }`; editor controls should prefer `font-family: var(--font-primary)` over raw family names when the design should follow future font swaps.

The `--container-width`, color, typography, font-token, and spacing values are emitted into the published CSS by `buildSiteFrameworkCss(site)` and the site font CSS bundle.

Editing the colors / typography / spacing in the Site → Framework / Colors / Typography panels writes back to `settings_json` and republishes the affected pages.

### Style rule registry — `Record<string, StyleRule>`

User-defined CSS rules the editor manages.

```ts
type StyleRule = {
  id:           string
  name:         string             // user-facing rule name (CSS class identifier for class-kind rules)
  kind:         'class' | 'ambient'
  selector:     string             // CSS selector, e.g. '.hero-button' or 'h1 > span'
  order:        number             // cascade order; emitted ascending
  description?: string
  scope?:       { nodeId: string } // optional: a scope-anchored rule (one node only)
  styles:       CSSPropertyBag     // base property map
  contextStyles: Record<string, CSSPropertyBag> // viewport/context overrides
  generated?:   { ... }
}
```

See [docs/reference/css-class-registry.md](../reference/css-class-registry.md) for the full mechanics. Key points:

- A rule compiled to CSS via `classCss.ts` in the publisher.
- A node references class-kind rules via its `classIds: string[]`.
- Ambient rules (`kind: 'ambient'`) attach by CSS selector matching — not via `classIds`.
- Scoped rules (`scope.nodeId`) generate uniquely-prefixed CSS so they don't affect other nodes.

### Site files — `SiteFile[]`

Arbitrary files attached to the site: CSS stylesheets, TypeScript scripts, React components, assets, config files, and docs.

```ts
type SiteFile = {
  id:         string          // nanoid-generated; stable (path is mutable on rename)
  path:       string          // POSIX-style path relative to site root, e.g. 'src/styles/main.css'
  type:       SiteFileType    // 'component' | 'script' | 'style' | 'asset' | 'config' | 'doc'
  content?:   string          // text content; absent for 'asset' files
  blob?:      { mimeType: string; base64: string }  // binary payload for 'asset' only
  generated?: boolean         // auto-generated by scaffold; hidden until ejected
  ejected?:   boolean         // user has edited a generated file
  createdAt:  number
  updatedAt:  number
}
```

Schema source of truth: `src/core/files/schemas.ts`.

- `'style'` files are concatenated into the page-scoped `userStyles` bundle via `userStylesheets.ts`, honouring each stylesheet's `SiteRuntimeConfig.styles[id]` (enable / scope / priority).
- `'script'` files are exposed to module render functions through `props._siteScripts`.
- `'component'`, `'config'`, and `'doc'` files are stored but not auto-emitted; modules can read them via `ctx.siteFiles`.
- `'asset'` files store binary content in `blob` (base64-encoded); the file's `content` field is absent.

Generated files (e.g. `package.json`, `vite.config.ts`) are hidden in the Site Explorer until the user ejects them. Files are created and renamed through the Site Explorer panel and edited with the CodeMirror-backed code editor.

### Site Explorer organization — `SiteExplorerOrganization`

Decorative folders and ordering for the Site Explorer. This is editor organization only; it does not change page routing, component identity, file paths, or published URLs.

```ts
type SiteExplorerSectionId =
  | 'pages'
  | 'templates'
  | 'components'
  | 'styles'
  | 'scripts'

type SiteExplorerFolder = {
  id: string
  name: string
  order: number  // root-level ordering among folders and unpinned items
}

type SiteExplorerItemPlacement = {
  id: string
  parentFolderId?: string
  order: number
}

type SiteExplorerOrganization = Record<SiteExplorerSectionId, {
  folders: SiteExplorerFolder[]
  items: SiteExplorerItemPlacement[]
}>
```

`src/core/page-tree/siteExplorer.ts` owns the schema and reconciliation helpers. On load and after item lifecycle mutations, the editor reconciles placements against the current pages, templates, Visual Components, styles, and scripts:

- stale item placements are dropped
- missing items are appended in current item order
- generated non-ejected files stay hidden
- the homepage (`slug: 'index'`) is pinned to the root of the Pages section and rendered first

Folders are intentionally flat and decorative. Pages remain individual rows with flat slugs; putting a page in a folder does not create a parent route.

### `SitePackageJson` — the per-site `package.json`

```ts
type SitePackageJson = {
  dependencies:    Record<string, string>
  devDependencies: Record<string, string>
}
```

The CMS supports plugins that ship their own npm deps and runtime imports (e.g. `three`). When a site declares a dependency, `bun install` runs against a per-site workspace under `uploads/sites/<siteId>/runtime/`, producing a hashed cache directory the server serves at `/_instatic/runtime/cache/<hash>/...`. See [docs/features/site-runtime.md](#) (TODO).

The Site → Dependencies panel edits this `package.json`. Saving triggers a `bun install` and updates the runtime lock.

### `SiteRuntimeConfig`

```ts
type SiteAssetScope =
  | { type: 'all-pages' }
  | { type: 'pages'; pageIds: string[] }
  | { type: 'templates'; templatePageIds: string[] }

type SiteRuntimeConfig = {
  dependencyLock: {
    version:   1
    packages:  Record<string, { resolved: string; integrity?: string }>
    updatedAt: number
  }
  // Per-script targeting + load behaviour, keyed by SiteFile id.
  scripts: Record<string, {
    enabled: boolean
    runInCanvas: boolean
    placement: 'head' | 'body-end'
    timing: 'immediate' | 'dom-ready' | 'idle'
    scope: SiteAssetScope
    priority: number
  }>
  // Per-stylesheet targeting + cascade, keyed by SiteFile id.
  styles: Record<string, {
    enabled: boolean
    scope: SiteAssetScope
    priority: number
  }>
}
```

`dependencyLock` is the resolved snapshot from the last successful `bun install` — the publisher uses it to build the `<script type="importmap">` entries that map bare specifiers (`three`) to `/_instatic/runtime/cache/<hash>/...` URLs.

`scripts` and `styles` share the `SiteAssetScope` shape and the `assetScopeAppliesToPage` helper, so a script and a stylesheet target pages identically. Scripts additionally carry `placement`/`timing`/`runInCanvas` (a `<link>` has no execution model, so stylesheets omit those). Both are edited from the floating code editor's left rail (`ScriptSettingsPane` / `StyleSettingsPane`).

---

## Loading the site

```text
GET /admin/api/cms/site
    │
    ▼
server/handlers/cms/site.ts
    │
    ├─→ loadDraftSite(db)              ← server/repositories/site.ts
    │       (reads the site row, validates settings_json via parseSiteDocument)
    ├─→ listDataRows(db, 'pages')      ← page rows
    ├─→ listDataRows(db, 'components') ← VC rows
    │
    ▼
Client: assembleSiteDocument(shell, pages, vcs) → SiteDocument
    │
    ▼
Editor store: siteSlice initial state
```

The shell's `parseSiteDocument(raw)` is **tolerant in the right places**:

| Field         | Behavior on invalid input                        |
|---------------|--------------------------------------------------|
| `id`          | Throw (required identity)                        |
| `name`        | Throw                                            |
| `breakpoints` | Throw (default would silently destroy customization) |
| `createdAt`, `updatedAt` | Throw                                  |
| `settings`    | Fall back to `DEFAULT_SITE_SETTINGS`             |
| `classes`     | Per-entry: drop entries missing `id` or `name`   |
| `files`       | Per-entry: drop invalid entries                  |
| `explorer`    | Fall back to empty folders / current item order  |
| `packageJson` | Fall back to `{ dependencies: {}, devDependencies: {} }` |
| `runtime`     | Fall back to empty lock + scripts                |

Hard fallbacks let the editor render a partially-corrupt site instead of hard-failing; identity-field throws prevent the editor from rendering against the wrong site.

---

## Saving the site

The shell is saved independently of pages / VCs. Three save paths:

| Endpoint                                    | Saves                                          |
|---------------------------------------------|------------------------------------------------|
| `PUT /admin/api/cms/site`                   | The shell — settings, breakpoints, classes, files |
| `PUT /admin/api/cms/pages`                  | Page roster (batch upsert)                     |
| `PUT /admin/api/cms/components`             | VC roster (batch upsert)                       |

The editor's auto-save scheduler (`usePersistence.ts`) batches dirty changes and fires the matching save endpoint. Granular write gates (`SITE_WRITE_CAPABILITIES`) enforce what each role can actually change inside the diff.

The page and component roster endpoints are fail-closed: because each reconcile soft-deletes stored rows missing from the incoming roster, malformed entries reject the whole save instead of being repaired by dropping entries. Page and VC trees must have a valid root, matching node-map keys, resolvable child IDs, and no reachable child cycles. Component saves also reject duplicate IDs/names, missing VC refs, and dependency cycles. Tolerant repair remains limited to reads of persisted data where dropping bad entries cannot be misread as an intentional delete request.

### Atomic diff validation

The shell save handler validates the diff before applying — e.g. a user with only `site.content.edit` can't change a class definition (style-edit) or rename a breakpoint (structure-edit). The diff validator is in `src/core/persistence/validate.ts` → `validateSite`.

---

## In-memory ↔ persisted

The editor's store works with the in-memory `SiteDocument`:

```ts
{
  ...siteShell,             // id, name, breakpoints, settings, classes, files, runtime, packageJson
  pages:             Page[],
  visualComponents:  VisualComponent[],
}
```

When the editor saves, the persistence layer **splits** the in-memory document back into:

- A `SiteShell` (everything except `pages` and `visualComponents`) → `PUT /site`
- A `Page[]` → `PUT /pages`
- A `VisualComponent[]` → `PUT /components`

The split prevents an "all-or-nothing" save: editing the page roster doesn't risk overwriting a concurrent settings change.

---

## Cookbook

### Read site settings from a panel

```ts
import { useEditorStore } from '@site/store/store'

const settings = useEditorStore((s) => s.site.settings)
const colors   = settings.colorTokens
```

### Add a new viewport context

The editor's Viewport contexts panel calls a `siteSlice` action:

```ts
addBreakpoint({
  label: 'Wide',
  width: 1440,
  mediaQuery: '(min-width: 1440px)',
  icon: 'monitor',
  previewFrame: true,
})
```

The panel rail's per-viewport canvas iframe shows up automatically when `previewFrame` is enabled. Existing nodes can target the new context via `setBreakpointOverride(nodeId, breakpointId, propKey, value)`.

### Add a color token

Settings → Colors panel adds an entry to `settings.colorTokens`. Saving updates the framework CSS (`buildSiteFrameworkCss(site)`) and republishes affected pages.

### Add a site file

The Site Explorer calls `createFile(path, type, content)` from `filesSlice`. For example, adding a stylesheet:

```ts
createFile('src/styles/analytics.css', 'style', '/* ... */')
```

`'style'` files are auto-concatenated into the published bundle. Other types are stored and accessible via `ctx.siteFiles` at render time. `'asset'` files use `updateFileBlob(id, { mimeType, base64 })` instead.

### Declare a site dependency

Site → Dependencies panel edits `packageJson.dependencies`:

```jsonc
{
  "dependencies": { "three": "^0.171.0" }
}
```

Save → server runs `bun install` in the per-site workspace → `runtime.dependencyLock` updates → the publisher emits a `<script type="importmap">` mapping `three` to `/_instatic/runtime/cache/<hash>/three/build/three.module.js`.

A plugin canvas module can then `import * as THREE from 'three'` and it resolves at runtime.

---

## Forbidden patterns

| Pattern                                                              | Use instead                                                 |
|----------------------------------------------------------------------|-------------------------------------------------------------|
| Adding `pages: ...` or `visualComponents: ...` to `SiteShellSchema`  | They're stored separately. Gated by `no-vc-in-site-shell.test.ts`. |
| Reading `site.settings.colorTokens.primary as string` without fallback | `parseSiteSettings` already applies defaults; the type is `string`. Don't add `as string`. |
| Persisting the in-memory `SiteDocument` directly as JSON              | Split into shell / pages / VCs before save                  |
| Hard-failing the entire editor on a corrupt `settings_json`           | The parser falls back; the editor renders with defaults     |
| Hardcoding the breakpoint list                                       | Read from `site.breakpoints` — users can add custom ones    |
| Writing CSS for a user class manually                                | Add a `StyleRule` to the registry; the publisher compiles it |
| Editing `runtime.dependencyLock` by hand                             | It's the output of `bun install` — let the install handler write it |

---

## Related

- [docs/architecture.md](../architecture.md) — system overview
- [docs/editor.md](../editor.md) — editor store consumes `SiteDocument`
- [docs/features/publisher.md](publisher.md) — framework CSS + class CSS pipelines
- [docs/features/content-storage.md](content-storage.md) — pages and VCs live in `data_rows`
- [docs/reference/css-class-registry.md](../reference/css-class-registry.md) — class registry details
- [docs/reference/design-tokens.md](../reference/design-tokens.md) — editor token catalog
- Source-of-truth files:
  - `src/core/page-tree/siteDocument.ts` — `SiteShellSchema`, `SiteDocument`, `parseSiteDocument`
  - `src/core/page-tree/siteSettings.ts` — `SiteSettingsSchema`, `DEFAULT_SITE_SETTINGS`
  - `src/core/page-tree/breakpoint.ts` — `BreakpointSchema`, `DEFAULT_BREAKPOINTS`
  - `src/core/page-tree/styleRule.ts` — `StyleRuleSchema`
  - `src/core/files/schemas.ts` — `SiteFileSchema`, `SiteFileType`, `SiteFileBlobSchema`
  - `src/core/site-dependencies/manifest.ts` — `SitePackageJsonSchema`
  - `src/core/site-runtime/schemas.ts` — `SiteRuntimeConfigSchema`
  - `src/core/persistence/validate.ts` — `validateSite`
  - `server/repositories/site.ts` — `loadDraftSite`, save handlers
  - `server/handlers/cms/site.ts` — `/admin/api/cms/site` endpoint
- Gate tests:
  - `src/__tests__/architecture/no-vc-in-site-shell.test.ts`
