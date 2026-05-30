/**
 * SiteImportAdapter and SiteImportTransaction — the headless contract between
 * the import pipeline (Phase 2) and the admin-side store (Phase 3).
 *
 * The headless pipeline (`commitImportPlan`) calls the adapter to:
 *   1. Upload asset bytes and receive back media-library URLs.
 *   2. Commit all page and style-rule additions in a single atomic transaction.
 *
 * The admin-side adapter (implemented in Phase 3) wraps the Zustand store
 * mutations and the server-side asset upload endpoint.
 *
 * This file is intentionally interface-only — no implementation here.
 *
 * @see src/core/siteImport/applyImport.ts — `commitImportPlan` caller
 * @see src/admin/...   — Phase 3 adapter implementation (TBD)
 */

import type { NewStyleRule, ImportFontFamily } from './types'
import type { ConditionDef } from '@core/page-tree'
import type { ImportFragment } from '@core/htmlImport'

// ---------------------------------------------------------------------------
// SiteImportAdapter
// ---------------------------------------------------------------------------

/**
 * Top-level adapter that the Phase 3 wizard implements and passes to
 * `commitImportPlan`.
 */
export interface SiteImportAdapter {
  /**
   * Upload a single asset to the media library.
   *
   * @returns The public media URL the page tree should reference (e.g.
   *          `"/uploads/abc123.png"` or `"https://cdn.example.com/..."`).
   */
  uploadAsset(file: { path: string; bytes: Uint8Array; mimeType: string }): Promise<string>

  /**
   * Execute all page and style-rule mutations in a single atomic step.
   *
   * The callback receives a `SiteImportTransaction` and must call its methods
   * (in any order) to describe the changes. The adapter implements the
   * callback inside a single undo-history snapshot so that Cmd+Z reverts the
   * entire import in one step.
   *
   * The callback is synchronous — all data is already available at call time
   * (assets have been uploaded; URLs have been rewritten in the plan).
   */
  commit(recipe: (tx: SiteImportTransaction) => void): Promise<void>
}

// ---------------------------------------------------------------------------
// SiteImportTransaction
// ---------------------------------------------------------------------------

/**
 * Passed to `SiteImportAdapter.commit`'s callback.
 *
 * Each method corresponds to one mutation operation. The admin-side
 * implementation (`Phase 3`) maps these directly to Zustand store mutations
 * inside a single `mutateActiveTreeAndSite` Immer producer.
 */
export interface SiteImportTransaction {
  /**
   * Add a new page with the given title, slug, and body content.
   *
   * The `nodeFragment` contains class *names* (not ids) on node.classIds, as
   * produced by `importHtml`. The implementer is responsible for reconciling
   * those names to registry class ids — creating bare (style-less) classes for
   * unknown names — exactly as `insertImportedNodes` does. See
   * `src/admin/pages/site/store/slices/site/nodeActions.ts` for the reference
   * implementation of the name→id linking step.
   *
   * @returns The new page's generated id.
   */
  addPage(input: {
    title: string
    slug: string
    nodeFragment: ImportFragment
  }): string

  /**
   * Overwrite the content of an existing page (conflict: overwrite resolution).
   *
   * The existing page's id, slug, and title are retained; only the node tree
   * is replaced with the imported fragment. Class name→id linking applies
   * identically to `addPage`.
   */
  overwritePage(
    pageId: string,
    input: {
      title: string
      slug: string
      nodeFragment: ImportFragment
    },
  ): void

  /**
   * Add a new style rule to the site's global registry.
   *
   * @returns The new rule's generated id.
   */
  addStyleRule(rule: NewStyleRule): string

  /**
   * Overwrite an existing style rule (conflict: overwrite resolution).
   *
   * The existing rule's id is retained; all other fields are replaced by the
   * imported rule's values.
   */
  overwriteStyleRule(ruleId: string, rule: NewStyleRule): void

  /**
   * Merge reusable conditions into the site-level `site.conditions` registry,
   * deduped by id. Imported rules reference these via their `contextStyles`
   * keys, so they must be committed alongside the rules.
   */
  addConditions(conditions: ConditionDef[]): void

  /**
   * Add custom font families (from imported `@font-face` blocks) to
   * `site.settings.fonts`. Each file's `src` is already a final media URL.
   *
   * @returns The committed `{ id, family }` for each added font, for the
   *          import summary.
   */
  addFonts(fonts: ImportFontFamily[]): { id: string; family: string }[]
}
