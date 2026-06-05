# Design Tokens

The complete catalog of design tokens declared in `src/styles/globals.css`. Every color, radius, shadow, font, and z-index used by the admin / editor / UI primitives is here. CSS Modules in `src/admin/`, `src/admin/pages/site/`, and `src/ui/` MUST reference these via `var(--*)` — hardcoded hex / rgb / hsl is gated by `css-token-policy.test.ts`.

---

## TL;DR

- One file: `src/styles/globals.css`.
- Grouped by surface: editor chrome, panels, inputs, scrollbars, canvas, tooltips, spotlight, charts.
- **Two-layer color model**: achromatic base + semantic / categorical color layer on top. See [docs/design.md](../design.md) for the rationale.
- Add a new token by editing `globals.css`. Reference it with `var(--your-token)` in CSS Modules.
- The `src/modules/` directory is **exempt** from the no-hardcoded-color rule — module CSS ships to published pages where editor tokens aren't available.

---

## Fonts

```css
--font-sans: "Inter Variable", system-ui, sans-serif;
--font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

Inter Variable is loaded via a targeted `@font-face` declaration in `globals.css` — Latin subset only (`unicode-range: U+0000-00FF, …`), with `font-display: swap`. Non-Latin characters fall back to `system-ui`. The monospace stack is entirely system-native; no custom monospace font is loaded.

If the admin UI needs broader character coverage, add a second `@font-face` block in `globals.css` with the appropriate `unicode-range` pointing at the matching subset file under `@fontsource-variable/inter/files/`.

Type sizes are per-component and don't yet have a token scale. If a recurring size emerges across 3+ primitives, promote it to a token.

---

## Editor surface hierarchy (achromatic base)

Six surface tones for depth. Lighter is higher in the stack.

| Token                  | Hex       | Use                                                            |
|------------------------|-----------|----------------------------------------------------------------|
| `--editor-bg`          | `#000000` | Page bottom — root, behind everything                          |
| `--editor-bg-subtle`   | `#323232` | Chips, badges inside nested surfaces                           |
| `--editor-surface`     | `#1b1b1b` | Darker parent of tile cards / sidebar fill                     |
| `--editor-surface-2`   | `#282828` | Tile cards themselves, panel bodies                            |
| `--editor-surface-3`   | `#323232` | Hover state for tiles, nested controls                         |
| `--editor-surface-4`   | `#4a4a4a` | Active state                                                   |
| `--editor-surface-5`   | `#605f5f` | Active + focused                                               |

Hover and active states change **tone**, not border. Skip levels only with intent.

---

## Borders

| Token                  | Hex       | Use                                                            |
|------------------------|-----------|----------------------------------------------------------------|
| `--editor-border`      | `#333333` | Default 1px borders on input controls, dividers                |
| `--editor-border-med`  | `#2e2e2e` | Slightly elevated borders (active states on bordered controls) |
| `--editor-panel-border`| `#1f1f1f` | Panels — quieter than `--editor-border`                        |

---

## Text hierarchy

Five tones, each a different meaning level.

| Token                       | Hex       | Means                          |
|-----------------------------|-----------|--------------------------------|
| `--editor-text-bright`      | `#f4f4f5` | Titles, headings, KPIs         |
| `--editor-text`             | `#ededed` | Primary body text              |
| `--editor-text-secondary`   | `#a1a1aa` | Labels, secondary UI           |
| `--editor-text-muted`       | `#787878` | Muted / placeholder            |
| `--editor-text-subtle`      | `#52525b` | Disabled / very subtle         |

Add a new text tone only by adding a new token here.

---

## Scrollbar chrome

Scrollbars are admin chrome, not identity. Keep them achromatic so the panel rail remains the dominant colored vertical affordance.

| Token                            | Value / source                                                      | Use                                           |
|----------------------------------|---------------------------------------------------------------------|-----------------------------------------------|
| `--editor-scrollbar-size`        | `6px`                                                               | WebKit/Blink scrollbar width and height       |
| `--editor-scrollbar-radius`      | `var(--editor-radius-sm)`                                           | Thumb radius                                  |
| `--editor-scrollbar-track`       | `transparent`                                                       | Track and corner background                   |
| `--editor-scrollbar-thumb`       | `color-mix(in srgb, var(--editor-text-muted) 58%, transparent)`     | Default thumb color, also Firefox thumb color |
| `--editor-scrollbar-thumb-hover` | `color-mix(in srgb, var(--editor-text-secondary) 72%, transparent)` | Hover thumb color                             |

`globals.css` applies these through `scrollbar-color` for Firefox and `::-webkit-scrollbar` for WebKit/Blink. Scrollable panel layouts that place rail navigation beside content should use `scrollbar-gutter: stable`.

---

## White accents (in the base layer)

Alpha-variants of white used for selected rows, pressed states, focus rings.

| Token                     | Value                              | Use                                  |
|---------------------------|------------------------------------|--------------------------------------|
| `--editor-accent`         | `#ffffff`                          | Pure white accent (Vercel-style)     |
| `--editor-accent-light`   | `#a1a1aa`                          | Subtle accent                        |
| `--editor-accent-violet`  | `rgba(255, 255, 255, 0.8)`         | Canvas selection (despite the name — it's achromatic white) |
| `--editor-selection`      | `rgba(255, 255, 255, 0.08)`        | Selected list rows, pressed buttons  |

---

## Rail tints (automatic identity layer)

Token-backed identity colors for widget categories, panel rails, sidebar icons, and storage breakdown segments. Panel rails assign these automatically from the full panel identity with repeat avoidance inside the visible rail group.

| Token              | Hex       | Conventional category                                                  |
|--------------------|-----------|------------------------------------------------------------------------|
| `--rail-tint-mint` | `#8ee6c8` | "Saved / system / status"                                                  |
| `--rail-tint-lilac`| `#c8b6ff` | "Pages / structure"                                                        |
| `--rail-tint-sky`  | `#9bdcff` | "Storage / data / configuration"                                           |
| `--rail-tint-peach`| `#ffc7a8` | "Posts / media / activity"                                                 |
| `--rail-tint-rose` | `#ffb6cd` | Secondary warm identity tint                                               |
| `--rail-tint-lime` | `#b8f28b` | Secondary green identity tint                                              |
| `--rail-tint-gold` | `#f7df72` | Secondary yellow identity tint                                             |
| `--rail-tint-cyan` | `#83e7ff` | Secondary blue identity tint                                               |
| `--rail-tint-violet` | `#f0a6ff` | Secondary violet identity tint                                           |
| `--rail-tint-coral` | `#ff9f9f` | Secondary red identity tint                                               |

Used by `Widget` (`tint` prop), the rail accent helper (`src/ui/railAccent.ts`), and the storage breakdown chart. Adding another tint requires a new token — don't inline a color.

---

## Tag pill tints (automatic identity layer)

`TagPill` maps the first meaningful alphanumeric character of its label to a
stable token. Latin letters use `--tag-pill-tint-a` through
`--tag-pill-tint-z`; digits use `--tag-pill-tint-0` through
`--tag-pill-tint-9`. This keeps selector punctuation from driving the color
while giving class names, HTML tags, and badges enough visual variety.

---

## Semantic state (meaning layer)

### Danger / error

| Token                       | Value                              | Use                                   |
|-----------------------------|------------------------------------|---------------------------------------|
| `--editor-danger`           | `#ef4444`                          | Error fill (button, badge, border)    |
| `--editor-danger-light`     | `#f87171`                          | Lighter danger for text               |
| `--editor-danger-lighter`   | `#fca5a5`                          | Very light danger tint                |
| `--editor-danger-text`      | `#fecaca`                          | Danger badge text                     |
| `--editor-danger-bg`        | `rgba(239, 68, 68, 0.1)`           | Danger pill / message surface         |
| `--editor-danger-border`    | `rgba(239, 68, 68, 0.2)`           | Danger surface border                 |

### Warning

| Token                       | Value                              | Use                                   |
|-----------------------------|------------------------------------|---------------------------------------|
| `--editor-warning`          | `#f59e0b`                          | Warning fill                          |
| `--editor-warning-text`     | `#fde68a`                          | Warning badge text                    |
| `--editor-warning-bg`       | `rgba(245, 158, 11, 0.1)`          | Warning surface                       |
| `--editor-warning-border`   | `rgba(245, 158, 11, 0.3)`          | Warning surface border                |

### Success

| Token                          | Value                              | Use                                   |
|--------------------------------|------------------------------------|---------------------------------------|
| `--editor-success-green`       | `#34d399`                          | Saved / OK indicator                  |
| `--editor-success-bright`      | `#4ade80`                          | Agent tool success                    |
| `--editor-success-text`        | `#d1fae5`                          | Success badge text                    |
| `--editor-success-text-soft`   | `#a7f3d0`                          | Success hint text                     |
| `--editor-success-bg`          | `rgba(52, 211, 153, 0.1)`          | Success pill surface                  |
| `--editor-success-border`      | `rgba(52, 211, 153, 0.3)`          | Success pill / alert border           |

### Info

| Token                  | Value         | Use                                            |
|------------------------|---------------|------------------------------------------------|
| `--editor-info-text`   | `#c4b5fd`     | Violet-tinted info text                        |

### Mint surface (canvas chrome / mode toggle)

| Token                  | Hex         | Use                                            |
|------------------------|-------------|------------------------------------------------|
| `--editor-mint-surface`| `#1a2924`   | Dark mint background for the canvas breakpoint indicator and mode toggle |

---

## Canvas (selection / hover affordances)

```css
--canvas-selection-ring:        inset 0 0 0 1px #39ff14;   /* neon green — selected node */
--canvas-hover-ring:            inset 0 0 0 1px #ff2bd6;   /* neon pink — hovered node */
--canvas-selector-ring:         inset 0 0 0 1px #ff8800;   /* neon orange — selector-panel match sweep */
--canvas-selection-ring-color:  #39ff14;
--canvas-hover-ring-color:      #ff2bd6;
--canvas-selector-ring-color:   #ff8800;
```

Bare colour variants (`*-ring-color`) are for surfaces that need an `outline` / `border-color` / custom shadow geometry rather than the full inset-ring shorthand. Keep them in sync with the shorthands. The selector ring (`#ff8800`) is a third distinct identity so a "show me everything this selector touches" sweep reads differently from selection (green) and hover (pink).

### Canvas placeholder

```css
--canvas-placeholder-bg:
    repeating-linear-gradient(
        -45deg,
        color-mix(in srgb, var(--editor-text-muted) 6%, transparent) 0 6px,
        transparent 6px 12px
    ),
    color-mix(in srgb, var(--editor-text-muted) 4%, transparent);
```

The shared diagonal-stripe pattern used by every module's "empty" placeholder (image, video, container, slot-outlet, VC ref placeholders). Strictly achromatic. Edit once, retune everywhere.

---

## Code editor syntax (GitHub Dark inspired)

Used inside CodeMirror only. Don't reach for these in editor chrome.

| Token                       | Hex         | Use                          |
|-----------------------------|-------------|------------------------------|
| `--editor-syntax-keyword`   | `#ff7b72`   | Keywords (`if`, `return`)    |
| `--editor-syntax-entity`    | `#d2a8ff`   | Function names, types        |
| `--editor-syntax-property`  | `#7ee787`   | Object properties            |
| `--editor-syntax-variable`  | `#ffa657`   | Variables                    |
| `--editor-syntax-string`    | `#a5d6ff`   | String literals              |
| `--editor-syntax-constant`  | `#79c0ff`   | Numbers, constants           |
| `--editor-syntax-comment`   | `#8b949e`   | Comments                     |
| `--editor-syntax-operator`  | `#c9d1d9`   | Operators, punctuation       |
| `--editor-syntax-invalid`   | `#ffa198`   | Invalid syntax               |

---

## Border radius

| Token                | Value | Use                                                          |
|----------------------|-------|--------------------------------------------------------------|
| `--editor-radius-sm` | 3px   | Tight chips, micro-badges, segmented-control inner indicator |
| `--editor-radius`    | 6px   | Default editor controls, toolbar buttons, ghost menu items   |
| `--panel-radius`     | 12px  | Floating overlay panels                                      |
| `--card-radius`      | 16px  | Borderless tile cards (Widget, dashboard cells, module inserter tiles) |
| `--input-radius`     | 1em   | Pill-shaped inputs, class / property chips                   |
| `--tooltip-radius`   | 6px   | Tooltips                                                     |

---

## Shadows

| Token                          | Use                                                                       |
|--------------------------------|---------------------------------------------------------------------------|
| `--editor-focus-ring`          | `0 0 0 1px rgba(255, 255, 255, 0.25)` — 1px achromatic focus ring         |
| `--panel-shadow`               | Composite for floating panels: bottom-inset shadow + drop shadow           |
| `--panel-shadow-inset-bottom`  | Sub-token: `inset 0 -1px 0 rgba(0, 0, 0, 0.35)`                            |
| `--panel-shadow-drop`          | Sub-token: `0 12px 40px rgba(0, 0, 0, 0.65)`                               |
| `--input-shadow-focus`         | Inset composite achromatic glow for focused inputs                         |
| `--tooltip-shadow`             | `0 4px 16px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.04)`   |

Use `--panel-shadow` directly when you need a floating-panel feel. Don't recompose from the sub-tokens.

---

## Floating overlay panels

```css
--panel-bg:                 rgb(30 30 30);
--panel-border:             rgba(255, 255, 255, 0.1);
--panel-radius:             12px;
--panel-blur:               24px;
```

Used by spotlight, popovers, modals — anything that floats above the editor with a blur backdrop.

---

## Inline code surface

```css
--code-bg: rgba(0, 0, 0, 0.3);
```

Used by the `Code` primitive for inline code chip backgrounds. Don't reuse for block-level code editors (that's CodeMirror, which uses the `--editor-syntax-*` tokens).

---

## Keycap (Kbd primitive)

A sculpted, top-lit dark mechanical keycap. The face is a vertical gradient; the box-shadow stack fakes a raised cap — top highlight, concave inner shadow, a solid bottom edge, and a soft drop shadow. All values are achromatic, sitting inside the editor surface ramp.

| Token                  | Value                              | Use                                                  |
|------------------------|------------------------------------|------------------------------------------------------|
| `--kbd-face-top`       | `#434343`                          | Top of the face gradient (between surface-3 and -4) |
| `--kbd-face-bottom`    | `#2f2f2f`                          | Bottom of the face gradient (just below surface-3)  |
| `--kbd-face-top-hover` | `#4d4d4d`                          | Hover face gradient top (one step brighter)         |
| `--kbd-face-bottom-hover`| `#363636`                        | Hover face gradient bottom                          |
| `--kbd-border`         | `var(--editor-border)`             | Keycap border — achromatic, same as editor controls |
| `--kbd-text`           | `var(--editor-text-secondary)`     | Key label text — same register as surrounding labels|
| `--kbd-highlight`      | `rgba(255, 255, 255, 0.06)`        | Top inner highlight (inset box-shadow)              |
| `--kbd-inner-shadow`   | `rgba(0, 0, 0, 0.22)`              | Soft concave bottom inner shadow                    |
| `--kbd-edge`           | `rgba(0, 0, 0, 0.30)`              | 1px bottom edge — the key's simulated thickness     |
| `--kbd-drop`           | `rgba(0, 0, 0, 0.28)`              | Small drop shadow beneath the cap                  |

These tokens are scoped to `Kbd` and `ShortcutKeys`. Don't reach for them in other components.

---

## Inputs

```css
--input-bg:             transparent;
--input-bg-focus:       transparent;                /* yes, also transparent */
--input-border:         rgba(255, 255, 255, 0.20);
--input-border-hover:   rgba(255, 255, 255, 0.25);
--input-border-focus:   rgba(255, 255, 255, 0.50);
--input-shadow:         none;
--input-shadow-focus:   inset 0 0 5px #ffffff0f,
                        inset 0 -5px 8px #ffffff17,
                        0 0 5px #0000003d;
--input-radius:         1em;
```

Cards are filled and borderless; inputs are unfilled and bordered. That's the load-bearing visual distinction between containers and controls.

---

## Z-index layers

Three global tokens cover the layered surfaces that float above the editor:

```css
--z-dropdown:           20;
--spotlight-z-index:  9000;
--tooltip-z-index:   10001;
```

`--tooltip-z-index` is deliberately the highest token so tooltips are never occluded by the surface their trigger lives on. The body slash menu (`BodySlashMenu.module.css`) uses a raw z-index of `10000` — one step below `--tooltip-z-index` — because it predates tokenisation; see the inline comment in `globals.css`. `--spotlight-z-index` is also reused by the module inserter dialog.

The visual editor uses additional raw z-index values that are **not** tokenised. They fall into two independent stacking contexts:

**Editor layout context** (shared stacking context for the editor chrome):

| Value | What occupies it |
|-------|-----------------|
| 0     | `CanvasRoot` — an isolation root; all canvas-internal values are confined here |
| 30    | Main toolbar |
| 50    | Floating panels: PropertiesPanel, AgentPanel, DomPanel |
| 55    | LeftSidebar, RightSidebar, PanelRail |
| 80    | CodeEditorPanel |
| 201   | Toolbar popovers / dropdowns |
| 400–401 | PreviewOverlay |

**Canvas-internal context** (confined inside CanvasRoot's `z-index: 0`):

| Value       | What occupies it |
|-------------|-----------------|
| 24–25       | CanvasModeToggle, CanvasNotch, CanvasContextSelector |
| 50          | PluginCanvasOverlayLayer |
| 51          | Selection ring, hover ring, selection toolbar |
| 2147483647  | Drop-indicator layer inside iframe (must beat arbitrary module stacking contexts) |

`CanvasRoot` declares `z-index: 0; position: relative` to establish the isolation. Without it, the canvas-internal z-index 51 would escape into the layout context and paint over floating panels at z-index 50. See [`docs/editor.md`](../editor.md) → "Canvas stacking context isolation" for the full explanation.

Raw canvas-internal values are intentional exceptions — they cannot be tokens because they are relative to an isolated stacking context, not the global one. Do not add new raw z-index values outside this established ladder.

---

## Tooltips

| Token                  | Value                                                                       |
|------------------------|-----------------------------------------------------------------------------|
| `--tooltip-bg`         | `#0a0a0c`                                                                   |
| `--tooltip-fg`         | `#f4f4f5`                                                                   |
| `--tooltip-border`     | `rgba(255, 255, 255, 0.06)`                                                 |
| `--tooltip-shadow`     | `0 4px 16px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.04)`    |
| `--tooltip-radius`     | `6px`                                                                       |
| `--tooltip-z-index`    | `10001`                                                                     |

---

## Spotlight (Cmd+K command palette)

Spotlight has its own token group. Don't reuse outside Spotlight.

| Token                              | Value                                  |
|------------------------------------|----------------------------------------|
| `--spotlight-backdrop`             | `rgba(0, 0, 0, 0.5)`                   |
| `--spotlight-backdrop-blur`        | `8px`                                  |
| `--spotlight-z-index`              | `9000`                                 |
| `--spotlight-width`                | `640px`                                |
| `--spotlight-row-selected-bg`      | `rgba(255, 255, 255, 0.08)`            |
| `--spotlight-mark-bg`              | `rgba(52, 211, 153, 0.20)`             |
| `--spotlight-mark-fg`              | `var(--editor-text-bright)`            |
| `--spotlight-footer-bg`            | `rgba(255, 255, 255, 0.03)`            |
| `--spotlight-destructive-fg`       | `var(--editor-danger-light)`           |
| `--spotlight-confirm-bg`           | `rgba(239, 68, 68, 0.08)`              |
| `--spotlight-skeleton-base`        | `rgba(255, 255, 255, 0.06)`            |
| `--spotlight-skeleton-shimmer`     | `rgba(255, 255, 255, 0.12)`            |
| `--editor-progress-shimmer`        | `rgba(255, 255, 255, 0.4)`             | Travelling highlight on determinate progress bars (Super Import) |

---

## Charts

Default chart tint, series colors, glow halos, empty-segment styling. Used by dashboard widgets and the framework scale UI.

| Token                          | Value                              | Use                                              |
|--------------------------------|------------------------------------|--------------------------------------------------|
| `--editor-chart-default-tint`  | `var(--rail-tint-peach)`           | Fallback when no per-call tint                   |
| `--chart-series-min`           | `#38bdf8` (sky 400)                | "Mobile" series                                  |
| `--chart-series-min-glow`      | `rgba(56, 189, 248, 0.40)`         | Halo for active mobile segment                   |
| `--chart-series-max`           | `#4ade80` (green 400)              | "Desktop" series                                 |
| `--chart-series-max-glow`      | `rgba(74, 222, 128, 0.40)`         | Halo for active desktop segment                  |
| `--chart-segment-empty`        | `rgba(255, 255, 255, 0.06)`        | Empty segment fill                               |
| `--chart-segment-empty-border` | `rgba(255, 255, 255, 0.04)`        | Empty segment border                             |
| `--chart-track-bg`             | `rgba(255, 255, 255, 0.04)`        | Track background behind chart segments           |

---

## Reduced motion

`globals.css` includes a non-negotiable reduced-motion override:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

The two `!important` declarations here are the **only legitimate `!important` usages** in `globals.css`. Constraint #189.

---

## Adding a new token

1. Pick the right group in `src/styles/globals.css` (color → semantic group; radius → radius group; z-index → z-index group).
2. Add the custom property with a one-line comment if the meaning isn't obvious from the name.
3. Reference it via `var(--*)` in CSS Modules.
4. Add a row to the matching table in this doc.
5. If it introduces a new concept (not a variation of an existing group), add a paragraph explaining what it's for in this doc and in [docs/design.md](../design.md).

---

## Forbidden patterns

| Pattern                                              | Use instead                              |
|------------------------------------------------------|------------------------------------------|
| `color: #ededed;` in an admin / ui CSS module        | `color: var(--editor-text);`             |
| `border: 1px solid #333;`                            | `border: 1px solid var(--editor-border);`|
| `box-shadow: 0 4px 16px rgba(0,0,0,0.5);`            | `box-shadow: var(--panel-shadow-drop);`  |
| Inventing a one-off radius                           | Use the radius scale                     |
| Inventing a one-off z-index                          | Use the existing z-index tokens          |
| Reaching for a one-off rail color                    | Use `railAccent` / `assignRailAccents`, or add a token |
| Hardcoding the canvas selection ring color           | `var(--canvas-selection-ring)`           |

---

## Related

- [docs/design.md](../design.md) — design principles + surface systems + UI primitives
- [docs/reference/ui-primitives.md](ui-primitives.md) — which primitive uses which tokens
- Source-of-truth file: `src/styles/globals.css`
- Gate tests:
  - `src/__tests__/architecture/css-token-policy.test.ts`
  - `src/__tests__/architecture/noTailwindUtilities.test.ts`
  - `src/__tests__/architecture/no-css-var-fallbacks.test.ts`
  - `src/__tests__/architecture/scrollbar-chrome.test.ts` — scrollbar tokens declared; both Firefox and WebKit/Blink styled; properties panel uses `scrollbar-gutter: stable`
