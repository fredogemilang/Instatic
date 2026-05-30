# Custom Fonts — upload via Media, wire @font-face, fix Super Import fonts

## TL;DR

Add a first-class **custom font** path alongside the existing Google Fonts flow. A
user uploads font files (`.woff2`, `.woff`, `.ttf`, `.otf`) through the **media
library**, maps each file to a `(weight, style)` variant, and the font becomes a
real `FontEntry` (`source: 'custom'`) in `site.settings.fonts`. The publisher and
canvas already emit `@font-face` from that library, so custom fonts publish
self-hosted with zero new emit paths once the model accepts media-backed files.

The same model closes the **Super Import** gap: today `@font-face` rules are
dropped (the font binary lands in the media library as an orphan asset, but the
declaration is lost). With this change, the importer parses `@font-face`, links
each `src: url(...)` to the already-uploaded media asset, and synthesizes custom
`FontEntry` items so imported sites keep their fonts.

## Motivation

- The Typography panel only offers "Add Google font". `FontsSection.tsx` already
  carries the comment *"custom uploads are a planned next step"* and `FontRow`
  already renders a "Custom" label — the UI was built anticipating this.
- `FontEntry.source` is already `'google' | 'custom'`, but the model can't express
  a custom upload: `FontFile.format` is `Type.Literal('woff2')` and `FontFile.path`
  must match `/^\/uploads\/fonts\/.+\.woff2$/`. So no woff/ttf/otf, and no
  media-library-served font.
- Super Import explicitly lists *"@font-face + font assets … create a site-level
  font config; surface in the Typography panel"* as a Phase 4 follow-up
  (`docs/plans/2026-05-29-super-import.md`). The binary already reaches media via
  the orphan-asset path in `assetPlan.ts`; only the wiring is missing.
- The media pipeline is already font-ready: `mediaUpload.ts` accepts
  `font/woff`, `font/woff2`, `font/ttf`, `font/otf` with magic-byte sniffing,
  exposes `FONT_MIMES`, and supports `role: 'font'` — with a comment pointing at
  "a future dedicated `@font-face` upload route."

## Goals

1. **Upload custom fonts via the media library** and assemble them into a
   `FontEntry` shown in the Typography panel, next to Google fonts.
2. **Publish self-hosted**, same guarantee as Google fonts: no external CDN URLs
   in published output; `@font-face` emitted from the font library.
3. **Support woff2/woff/ttf/otf**, each with the correct `format(...)` token.
4. **Fix Super Import**: parse `@font-face`, link to uploaded media assets, and
   auto-create custom `FontEntry` items so imported fonts survive.
5. **No band-aids** (per `CLAUDE.md`): widen the model at the source rather than
   special-casing woff2-only paths.

## Non-goals

- Variable-font axis UI (`wght 100..900` ranges). v1 stores per-file static
  variants; a variable file can still be registered as a single `400` face.
- Font subsetting / `unicode-range` slicing for custom uploads (Google's flow
  keeps its slicing; custom uploads emit one face per file).
- Re-encoding uploaded ttf/otf to woff2 server-side (possible future
  optimization; out of scope here).

---

## Data model changes (`src/core/fonts/schemas.ts`)

The single source of truth. Widen `FontFile`:

- **`format`**: `Type.Literal('woff2')` → `Type.Union([Literal('woff2'),
  Literal('woff'), Literal('ttf'), Literal('otf')])`. Export a derived
  `FontFileFormat` type.
- **`path`**: today restricted to `/uploads/fonts/...woff2`. Custom fonts are
  served from the **media library**, whose public path is adapter-dependent
  (local `/uploads/media/...`, or an external URL for remote adapters). Replace
  the single woff2-only pattern with two accepted shapes:
  - the existing self-hosted **Google** namespace (`/uploads/fonts/<slug>/*.woff2`), and
  - a **media asset reference**. Prefer storing `mediaAssetId` + the resolved
    public `path`, so the publisher emits the current public URL and the entry
    survives storage-adapter migration.
- Add **`format`-aware** path validation: extension must match the declared
  `format`.

Proposed `FontFile` shape:

```ts
const FontFileSchema = Type.Object({
  variant: Type.String({ minLength: 1 }),        // "400", "700italic", …
  subset: Type.String({ minLength: 1 }),         // "latin" default for custom
  path: Type.String({ minLength: 1 }),           // public URL/path used in src:url()
  format: FontFileFormatSchema,                  // woff2 | woff | ttf | otf
  unicodeRange: Type.Optional(Type.String({ minLength: 1 })),
  /** Set for media-backed custom files; absent for Google self-host slices. */
  mediaAssetId: Type.Optional(Type.String({ minLength: 1 })),
})
```

**Path safety** must stay strict (the value is interpolated into a `<style>`
block). Keep `escapeCssUrl` in `css.ts` and validate that `path` is either:
- under `/uploads/` (self-hosted, any of the four extensions), or
- an `https://` URL on an allow-listed external media host (from the elected
  media storage adapter config).

This replaces the brittle `startsWith('/uploads/fonts/')` filter in
`generateSiteFontsCss` with a `isSafeFontSrc(path)` helper shared by schema +
CSS emit (mirrors the existing `isSafeFontPath` / `isSafeUnicodeRange` pattern).

## CSS emit changes (`src/core/fonts/css.ts`)

- `fontFaceRule` takes `format` and emits the matching token:
  `woff2 → format("woff2")`, `woff → format("woff")`,
  `ttf → format("truetype")`, `otf → format("opentype")`.
- `generateSiteFontsCss` swaps the `startsWith('/uploads/fonts/')` guard for the
  shared `isSafeFontSrc`. Everything else (token block, fallback chain,
  `familySlug`) is unchanged and already source-agnostic.

No changes needed in `frameworkCss.ts` (line 248 `generateFontsCss(site.settings?.fonts)`)
or `canvasClassCss.ts` (line 51) — they consume the library wholesale, so custom
fonts publish + preview the moment the model accepts them.

---

## Server (`server/`)

### New endpoint: register an uploaded custom font

Custom font **binaries upload through the existing media route** (multipart →
`acceptUploadedMedia` with `role: 'font'`, `allowedMimes: FONT_MIMES`). That
returns a `MediaAsset` with `id` + `publicPath`. No new byte-handling code — the
security layer (magic bytes, server-chosen extension) is reused verbatim.

Add to `server/handlers/cms/fonts.ts`:

- **`POST /admin/api/cms/fonts/custom`** — body: `{ family, files: [{ mediaAssetId,
  variant, format }] }`. The handler:
  1. Validates each `mediaAssetId` exists and is a font MIME (look up via media repo).
  2. Resolves each asset's current `publicPath`.
  3. Builds + returns a `FontEntry` (`source: 'custom'`, `category` omitted or
     a user-picked generic fallback) for the client to merge into settings.
  - Gated by `site.style.edit` (same as the Google routes).
- **Deletion**: custom fonts reference media assets the user may also use
  elsewhere, so removing a custom `FontEntry` does **not** delete the media
  asset. `FontsSection.handleRemove` already only calls `deleteCmsFontFamily`
  for `source === 'google'`; custom removal is metadata-only (drop from
  `settings.fonts.items`). No server delete call for custom — keep it that way.

`server/repositories/fonts.ts` stays Google-specific (it's the CDN downloader).
The custom-font assembly is small and lives in the handler (or a tiny
`buildCustomFontEntry` helper in the repo file for symmetry).

### Client (`src/core/persistence/cmsFonts.ts`)

Add `registerCustomFont(request)` posting to `/fonts/custom`, returning a
`FontEntry` (same envelope shape as `installCmsGoogleFont`). Add the matching
`CmsFontEntryEnvelopeSchema` reuse (the install + custom endpoints return the
same `{ font }` envelope, so no new schema needed).

---

## Editor UI (`src/admin/pages/site/panels/TypographyPanel/FontsSection/`)

### FontsSection.tsx

- The add affordance becomes two actions: **"Add Google font"** (existing) and
  **"Upload custom font"** (new). In the empty state, surface both.
- `handleRemove` already branches on `source`; no change needed beyond confirming
  custom entries skip the server delete.

### New: AddCustomFontDialog.tsx

A dialog mirroring `AddGoogleFontDialog`'s chrome (shared `Dialog`, `Button`,
error `role="alert"`), with this flow:

1. **Family name** input (free text; validated non-empty, deduped against
   installed families case-insensitively like the Google picker does).
2. **Add files**: a `FileUpload` (shared `src/ui` primitive) accepting
   `.woff2,.woff,.ttf,.otf`. Each selected file uploads immediately through the
   media route; the row then shows the filename + a **variant picker**
   (weight dropdown 100–900 + italic toggle, reusing the `WEIGHT_NAMES` map and
   `parseVariant`/`compareVariants` helpers). Default `400` normal; the dialog
   nudges sensible defaults from the filename (`*-bold*` → 700, `*italic*` → italic).
3. **Live preview**: render the family name + a pangram in the uploaded face by
   injecting a transient `@font-face` into the dialog (editor-session only,
   same "never reaches published HTML" guarantee as the Google preview).
4. **Install**: posts `{ family, files }` to `/fonts/custom`, receives a
   `FontEntry`, calls `addFont(entry)`.

No manual memoization (React Compiler is on). CSS Modules only; reuse
`FontsSection.module.css` patterns, add classes as needed with design tokens.

---

## Super Import @font-face wiring

Three touch points:

### 1. CSS parser (`src/core/siteImport/cssToStyleRules.ts`)

Today `@font-face` is dropped as a `dropped-at-rule` warning and its `url()`
becomes an orphan asset ref in `assetPlan.ts`. Instead, **capture** `@font-face`
blocks into a new structured output:

```ts
interface ParsedFontFace {
  family: string                 // from font-family descriptor
  variant: string                // derived from font-weight + font-style
  srcRefs: { rawUrl: string; format?: string }[]  // each src url()
  unicodeRange?: string
}
```

Add `fontFaces: ParsedFontFace[]` to `CssToStyleRulesResult`. The
`CSSFontFaceRule` is available via `CSSStyleSheet.replaceSync` in happy-dom /
browser; read `style.getPropertyValue('font-family' | 'font-weight' |
'font-style' | 'src' | 'unicode-range')`. Parse the `src` for `url(...)` +
optional `format(...)`.

### 2. Asset plan (`src/core/siteImport/assetPlan.ts`)

The `url(...)` inside `@font-face` already records the binary as an asset (the
orphan-ref path at lines ~258-263). Extend the plan to **keep the link**: map
each `ParsedFontFace.srcRefs[].rawUrl` → FileMap key → (after upload) media
asset id + URL, so the font face can be rebuilt with the real media path.

### 3. Apply (`src/core/siteImport/applyImport.ts` + adapter)

After assets upload, group `ParsedFontFace[]` by `family` and synthesize custom
`FontEntry` items:
- one `FontFile` per `srcRefs` entry, `format` inferred from extension/`format()`,
  `path` = uploaded media public URL, `mediaAssetId` = uploaded asset id,
  `variant` from the parsed weight/style, `subset: 'latin'` default.
- Merge into `site.settings.fonts.items` in the **same atomic commit** as pages +
  style rules (the import is one undoable step — `mutateAllPagesAndSite`).
- Drop the corresponding `dropped-at-rule` warning for `@font-face` (it's no
  longer dropped); keep warnings for genuinely unmodellable faces (e.g. a
  `src: local(...)`-only face with no uploadable file, or an external `https://`
  src — surface those as a new `external-font` warning).

Update `ImportResult`/wizard "Done" summary to report imported fonts
("Imported N fonts").

---

## Tests

- **schemas**: woff/ttf/otf accepted; format↔extension mismatch rejected; media
  URL path accepted; traversal / `</style>` injection rejected.
- **css.ts**: each format emits the right `format(...)` token; media-served path
  emits; unsafe path skipped.
- **server**: `/fonts/custom` rejects non-font media ids, builds a valid
  `FontEntry`; capability gate enforced.
- **siteImport**: an `@font-face` fixture produces a `ParsedFontFace`, links to
  the uploaded asset, and yields a custom `FontEntry`; external `src` → warning,
  not a crash; the `dropped-at-rule` warning for modellable faces disappears.
- **architecture**: existing `db-*`, `button-primitive-usage`,
  `css-token-policy`, `siteImport-headless` gates stay green; update any test
  that asserts woff2-only.

## Files touched

```
src/core/fonts/schemas.ts            widen FontFile (format union, media path, mediaAssetId)
src/core/fonts/css.ts                format-aware fontFaceRule + isSafeFontSrc
src/core/fonts/types.ts              FontFileFormat (if not derived in schemas)
server/handlers/cms/fonts.ts         POST /fonts/custom
server/repositories/fonts.ts         buildCustomFontEntry helper (optional)
src/core/persistence/cmsFonts.ts     registerCustomFont client
src/admin/.../FontsSection/FontsSection.tsx        add "Upload custom font" action
src/admin/.../FontsSection/AddCustomFontDialog.tsx new dialog
src/admin/.../FontsSection/FontsSection.module.css new classes (tokens only)
src/core/siteImport/cssToStyleRules.ts   capture @font-face → ParsedFontFace[]
src/core/siteImport/types.ts             fontFaces in result; external-font warning kind
src/core/siteImport/assetPlan.ts         keep @font-face url→media link
src/core/siteImport/applyImport.ts       synthesize custom FontEntry items atomically
src/admin/modals/SiteImport/steps/DoneStep.tsx   report imported fonts
docs/features/ (fonts doc) + docs/plans/2026-05-29-super-import.md  mark @font-face done
+ tests for each of the above
```

## Decisions log

| # | Decision | Why |
|---|---|---|
| D-1 | Custom fonts stored in the **media library**, referenced by id + URL | Reuses the font-ready upload security layer; unifies with Super Import (fonts already land in media); works with external storage adapters. |
| D-2 | Support woff2/woff/ttf/otf with correct `format()` tokens | Real-world uploads + imported sites use all four. |
| D-3 | Removing a custom font is metadata-only (no media delete) | The asset may be referenced elsewhere; media deletion stays a media-library action. |
| D-4 | Super Import auto-creates custom `FontEntry` from `@font-face` | Closes the "fonts can't be imported" gap; one atomic, undoable commit. |
| D-5 | External (`https://`) `@font-face` src → warning, not import | Keeps the no-external-CDN publishing guarantee; user can re-host manually. |
```
