/**
 * Publisher reset — minimal modern CSS reset shipped with every published page.
 *
 * Why this exists
 * ───────────────
 * Without a reset the published HTML inherits UA defaults: `box-sizing: content-box`,
 * `<body>` `margin: 8px`, heading/paragraph margins, list `padding-left`, Times-style
 * default font, etc. The design canvas (rendered inside the editor DOM) inherits the
 * editor's `globals.css` reset (`* { margin:0; padding:0; box-sizing:border-box }`,
 * Inter font, etc.). The two render surfaces therefore disagree on basics like font,
 * spacing, and box model — exactly the drift users notice when comparing the canvas
 * to the iframe preview / published front end.
 *
 * The fix is a single canonical reset string that is:
 *
 *  1. injected unscoped into the `<style>` block by `publishPage()`
 *     (so the iframe preview AND the published front end share one baseline), and
 *  2. injected scoped to `[data-breakpoint-id]` in the canvas (via canvasClassCss)
 *     so the canvas viewport matches the published page exactly. Editor chrome
 *     keeps its own `globals.css` reset because the scoping selector only catches
 *     the breakpoint frames.
 *
 * Specificity / cascade
 * ─────────────────────
 * Every selector is wrapped in `:where(...)` so the reset has zero specificity.
 * That means any user class, framework utility, or module CSS rule trivially
 * overrides reset declarations — no `!important`, no specificity wars.
 *
 * Stability
 * ─────────
 * This is the canonical baseline. If new rules are added they must be added here
 * (so canvas + published stay in sync). Don't fork a parallel reset somewhere else.
 */

/**
 * Minimal modern reset, ordered roughly Andy-Bell-style + a few extras to match
 * the editor's existing canvas reset behaviour (zero padding on every element,
 * list bullets stripped). Form controls inherit typography so site-level fonts
 * propagate into `<button>` / `<input>` without per-module work.
 */
export const PUBLISHER_RESET_CSS = [
  // Box model — apply to every element including pseudos
  ':where(*, *::before, *::after) { box-sizing: border-box; }',

  // Strip default margin and padding on every element. Matches the editor's
  // canvas reset so the design view and the published page agree on spacing.
  ':where(*) { margin: 0; padding: 0; }',

  // Sensible body baseline. font-family pinned to system-ui so the published
  // page picks the OS native font (matches what most modern stacks ship). Users
  // who want a custom default can set it on `body` via a class or framework
  // typography settings.
  ':where(html, body) { height: 100%; }',
  ':where(body) {' +
    ' line-height: 1.5;' +
    ' font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;' +
    ' -webkit-font-smoothing: antialiased;' +
    ' -moz-osx-font-smoothing: grayscale;' +
    ' }',

  // Media defaults — block-level + responsive by default, so images don't
  // overflow their containers and don't sit on a baseline by accident.
  ':where(img, picture, video, canvas, svg) { display: block; max-width: 100%; }',

  // Form controls inherit typography from their parent. Without this, browsers
  // use their own font stack for `<button>` / `<input>` which collides with the
  // site font.
  ':where(input, button, textarea, select) { font: inherit; color: inherit; }',
  ':where(button) { background: none; border: 0; cursor: pointer; }',

  // Long-word safety on text-bearing elements.
  ':where(p, h1, h2, h3, h4, h5, h6) { overflow-wrap: break-word; }',

  // Lists: no bullets by default. Most site lists are styled menus / nav, not
  // editorial bulleted lists. Users who want bullets re-enable via a class.
  ':where(ol, ul, menu) { list-style: none; }',

  // Links inherit colour and decoration so they only differ from surrounding
  // text when explicitly styled.
  ':where(a) { color: inherit; text-decoration: inherit; }',

  // Tables collapse borders by default — the standard expectation in modern CSS.
  ':where(table) { border-collapse: collapse; }',
].join('\n')

/**
 * Returns the publisher reset, scoped under the given selector prefix.
 *
 * Used by the design canvas to constrain the reset to the breakpoint frame
 * viewports (`[data-breakpoint-id]`) so it doesn't bleed into editor chrome.
 *
 * Each rule in `PUBLISHER_RESET_CSS` is rewritten as:
 *
 *   `<prefix> :where(...) { ... }`
 *
 * `:where()` keeps the contributed specificity at 0, so the only specificity
 * comes from the prefix itself — typically `[data-breakpoint-id]` (0,1,0).
 * That beats the editor `globals.css` rules (`* { margin:0 }` → 0,0,1) inside
 * the canvas while still losing to any user class (`.my-class` → 0,1,0)
 * declared after the reset (last-declared-wins on ties).
 *
 * The `:where(html, body)` and `:where(body)` rules are dropped from the
 * scoped output — there is no `<html>` / `<body>` inside the breakpoint frame
 * (the canvas root is just a `<div>`), so those selectors would never match.
 * Their effects are picked up via the prefix-only fallthrough below.
 */
export function scopedPublisherResetCss(scopeSelector: string): string {
  const trimmedScope = scopeSelector.trim()
  if (!trimmedScope) return PUBLISHER_RESET_CSS

  const lines: string[] = []

  // Body-equivalent rule on the scope itself. The breakpoint viewport `<div>`
  // plays the role of `<body>` for the rendered page tree, so we apply the
  // body baseline (font, line-height, smoothing) directly on the scope.
  //
  // `color: #000` is critical here: the editor's `globals.css` sets
  // `body { color: var(--editor-text) }` (near-white `#ededed` for the dark
  // editor chrome), and that color cascades into the canvas viewport unless
  // we override it. The published page's `<body>` has no `color` set by the
  // reset so it picks up the UA default (black on white). Pinning black
  // here makes the canvas match what visitors see — without this, an
  // unstyled `<h1>` on a fresh page renders near-invisible white-on-white
  // in the canvas while the published page shows it as black.
  lines.push(
    `${trimmedScope} {` +
      ' color: #000;' +
      ' line-height: 1.5;' +
      ' font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;' +
      ' -webkit-font-smoothing: antialiased;' +
      ' -moz-osx-font-smoothing: grayscale;' +
      ' }',
  )

  // Universal rules (box-sizing, margin/padding zero) scoped under the prefix.
  lines.push(`${trimmedScope} :where(*, *::before, *::after) { box-sizing: border-box; }`)
  lines.push(`${trimmedScope} :where(*) { margin: 0; padding: 0; }`)

  // Media inside the canvas viewport.
  lines.push(
    `${trimmedScope} :where(img, picture, video, canvas, svg) { display: block; max-width: 100%; }`,
  )

  // Form controls.
  lines.push(
    `${trimmedScope} :where(input, button, textarea, select) { font: inherit; color: inherit; }`,
  )
  lines.push(`${trimmedScope} :where(button) { background: none; border: 0; cursor: pointer; }`)

  // Text wrapping.
  lines.push(
    `${trimmedScope} :where(p, h1, h2, h3, h4, h5, h6) { overflow-wrap: break-word; }`,
  )

  // Lists.
  lines.push(`${trimmedScope} :where(ol, ul, menu) { list-style: none; }`)

  // Links and tables.
  lines.push(`${trimmedScope} :where(a) { color: inherit; text-decoration: inherit; }`)
  lines.push(`${trimmedScope} :where(table) { border-collapse: collapse; }`)

  return lines.join('\n')
}
