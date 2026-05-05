/**
 * Site CSS bundle — type definitions for the three external CSS files served
 * at `/_pb/css/<filename>` for every published page.
 *
 * The IMPLEMENTATION (`buildSiteCssBundle`) lives in `server/cms/siteCssBundle.ts`
 * because it depends on `node:crypto` for content hashing. Only the type shape
 * lives in `src/core/publisher/` so that `publishPage()` can accept a bundle
 * without dragging server-only code into the editor build.
 *
 * File split (decided with the user)
 * ──────────────────────────────────
 *   reset.<hash>.css      — The publisher reset (`PUBLISHER_RESET_CSS`).
 *                           Constant across every project; aggressive
 *                           shared-cache hit across the whole CMS install.
 *
 *   framework.<hash>.css  — Platform-emitted CSS:
 *                              · @font-face declarations (`@font-face` + `--font-*` tokens)
 *                              · `:root { --color-… }` from `site.settings.colorTokens`
 *                              · framework color / typography / spacing root variables
 *                                + utility classes
 *                              · plugin-emitted module CSS (deduped by moduleId,
 *                                collected across every page on the site).
 *                            Hash rotates when site framework settings or the
 *                            set of plugin modules in use change.
 *
 *   style.<hash>.css      — User-authored class registry (`collectClassCSS`).
 *                            Hash rotates on every class edit — most frequent
 *                            churn, isolated to its own file so the other two
 *                            stay cached.
 *
 * Cache strategy
 * ──────────────
 * Filenames embed a content-hash (SHA-256, truncated to 12 hex chars). The
 * server can therefore answer with `Cache-Control: public, max-age=31536000,
 * immutable` — any change to the bundle produces a fresh URL, so stale content
 * is impossible.
 *
 * Cascade order
 * ─────────────
 * The published page emits three `<link rel="stylesheet">` tags in this order:
 *   reset → framework → style
 * Same order as the previous in-`<style>` cascade. User class CSS still wins
 * specificity ties because it loads last.
 */

/**
 * One built CSS file. `filename` already includes the content hash and `.css`
 * extension, ready to drop into the `/_pb/css/` URL or a `<link>` href.
 */
export interface CssBundleFile {
  /** Logical bundle this file belongs to. */
  bundle: 'reset' | 'framework' | 'style'
  /** `<bundle>-<hash>.css`. */
  filename: string
  /** Content hash (SHA-256, 12 hex chars). */
  hash: string
  /** CSS body (no `<style>` wrapper). */
  content: string
}

export interface SiteCssBundle {
  reset: CssBundleFile
  framework: CssBundleFile
  style: CssBundleFile
}
