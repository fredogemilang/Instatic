/**
 * applyImport — the top-level orchestrator for the Super Import pipeline.
 *
 * Two exported functions:
 *
 * `buildImportPlan(input)` — PURE, synchronous.
 *   Classifies files, parses HTML and CSS, collects assets, normalises URLs,
 *   detects conflicts.  Returns an `ImportPlan` ready for preview in the
 *   Phase 3 wizard or direct commit.
 *
 * `commitImportPlan(plan, adapter)` — ASYNC.
 *   Step A: Upload assets via `adapter.uploadAsset`. Collect `sourcePath → newUrl`.
 *   Step B: Rewrite the plan with `applyAssetRewrites`.
 *   Step C: ONE `adapter.commit` call that adds all pages + style rules.
 *
 * Atomicity note:
 *   Asset uploads (Step A) are additive — if the process aborts mid-upload,
 *   the already-uploaded assets remain in the media library.  They are harmless
 *   (unused orphans) and will be reaped by a future background sweep.  The
 *   store mutation (Step C) is wrapped in a single `adapter.commit` call that
 *   the admin side executes as one Immer history snapshot — Cmd+Z reverts the
 *   entire import in one step.
 */

import type { SiteDocument, ConditionDef } from '@core/page-tree'
import { cssToStyleRules } from './cssToStyleRules'
import { extractRootColorTokens } from './colorTokens'
import { classifyFiles } from './classifyFiles'
import { makeHtmlPagePlan } from './htmlPagePlan'
import { buildAssetPlan, type CssFileResult } from './assetPlan'
import { scopeCollidingClasses } from './scopeClasses'
import { applyAssetRewrites } from './applyAssetRewrites'
import { detectConflicts } from './conflicts'
import type {
  FileMap,
  ImportPlan,
  ImportResult,
  ImportWarning,
  ImportColorToken,
  ImportScript,
  PageConflict,
  RuleConflict,
} from './types'
import type { SiteImportAdapter } from './adapter'

// ---------------------------------------------------------------------------
// buildImportPlan
// ---------------------------------------------------------------------------

export interface BuildImportPlanInput {
  fileMap: FileMap
  currentSite: SiteDocument
  options?: {
    /** Tolerance in px for matching @media max-width to a breakpoint. Default: 10. */
    mediaTolerance?: number
  }
}

/**
 * Build a fully-analysed `ImportPlan` from a `FileMap` and the current site.
 *
 * This is a pure, synchronous function. Call it before showing the Phase 3
 * wizard so the user can preview what will be imported and resolve conflicts.
 */
export function buildImportPlan({ fileMap, currentSite, options }: BuildImportPlanInput): ImportPlan {
  const mediaTolerance = options?.mediaTolerance ?? 10
  const warnings: ImportWarning[] = []
  const droppedAtRules: string[] = []

  // 1. Classify every file
  const classified = classifyFiles(fileMap)

  // 2. Import every JS file as an all-pages site script (decoded UTF-8 source).
  const scripts: ImportScript[] = []
  for (const f of classified) {
    if (f.role === 'js') scripts.push({ path: f.path, content: decodeUtf8(f.bytes) })
  }

  // 3. Process each HTML file into a raw PagePlan
  const breakpointHints = currentSite.breakpoints.map((bp) => ({
    id: bp.id,
    width: bp.width,
  }))

  const rawPagePlans = []
  const allLinkedCssPaths = new Set<string>()

  for (const f of classified) {
    if (f.role !== 'html') continue
    const htmlSource = decodeUtf8(f.bytes)
    const { pagePlan, warnings: pageWarnings } = makeHtmlPagePlan(f.path, htmlSource, fileMap)
    warnings.push(...pageWarnings)
    rawPagePlans.push(pagePlan)
    for (const cssPath of pagePlan.linkedCssPaths) allLinkedCssPaths.add(cssPath)
  }

  // 4. Parse CSS files linked from ≥1 page; record unused CSS
  const unusedCss: string[] = []
  const cssFileResults: CssFileResult[] = []
  // Reusable conditions discovered across all CSS files, deduped by id.
  const conditionsById = new Map<string, ConditionDef>()
  // Colour tokens pulled from root-scope rules, deduped by slug (first wins).
  const colorsBySlug = new Map<string, ImportColorToken>()

  for (const f of classified) {
    if (f.role !== 'css') continue
    if (!allLinkedCssPaths.has(f.path)) {
      unusedCss.push(f.path)
      continue
    }
    const cssSource = decodeUtf8(f.bytes)
    const { rules, warnings: cssWarnings, assetRefs, conditions: cssConditions, fontFaces } = cssToStyleRules(cssSource, {
      breakpoints: breakpointHints,
      mediaTolerance,
    })
    warnings.push(...cssWarnings)
    for (const def of cssConditions) {
      if (!conditionsById.has(def.id)) conditionsById.set(def.id, def)
    }

    // Collect dropped at-rules from CSS warnings for the summary
    for (const w of cssWarnings) {
      if (w.kind === 'dropped-at-rule' && w.source) droppedAtRules.push(w.source)
    }

    // Pull colour-valued root custom properties out of the rules so they become
    // framework colour tokens instead of a leftover `:root` rule (which would
    // double-emit each `--<slug>` alongside the framework's own output).
    const { rules: rulesAfterColors, colorTokens } = extractRootColorTokens(rules)
    for (const token of colorTokens) {
      if (!colorsBySlug.has(token.slug)) colorsBySlug.set(token.slug, token)
    }

    cssFileResults.push({ cssPath: f.path, rules: rulesAfterColors, assetRefs, fontFaces })
  }

  // 4b. Scope class names that are defined differently across stylesheets.
  //     A multi-page export links one stylesheet per page and reuses class
  //     names (`.btn`, `.hero`, …) with divergent declarations; the CMS has a
  //     single global registry, so naive merging lets one page's class clobber
  //     another's. `scopeCollidingClasses` keeps each page faithful to its own
  //     stylesheet by giving divergent definitions distinct names and rewriting
  //     the affected selectors + node class tokens. Identical defs stay shared.
  const scoped = scopeCollidingClasses(rawPagePlans, cssFileResults)
  warnings.push(...summariseScopeRenames(scoped.renames))

  // 5. Build asset plan — normalises URLs in node props and CSS values,
  //    resolves @font-face blocks into custom fonts, collects assets to upload
  const { normalizedPagePlans, normalizedStyleRules, fonts, assets, warnings: assetWarnings } =
    buildAssetPlan(scoped.pagePlans, scoped.cssFileResults, fileMap)
  warnings.push(...assetWarnings)

  // 6. Detect conflicts against the current site
  const conflicts = detectConflicts(currentSite, normalizedPagePlans, normalizedStyleRules)

  return {
    pages: normalizedPagePlans,
    styleRules: normalizedStyleRules,
    fonts,
    conditions: [...conditionsById.values()],
    assets,
    colors: [...colorsBySlug.values()],
    scripts,
    conflicts,
    warnings,
    droppedAtRules,
    unusedCss,
  }
}

// ---------------------------------------------------------------------------
// commitImportPlan
// ---------------------------------------------------------------------------

/**
 * Apply a `plan` to the site via the adapter, returning an `ImportResult`
 * describing what was actually committed.
 *
 * The plan is assumed to already have conflict resolutions applied (via
 * `applyConflictResolutions`) before being passed here.  The raw conflicts
 * stored on the plan are forwarded unchanged to the ImportResult for the
 * Phase 3 Done step.
 *
 * Atomicity guarantee:
 *   - Step A (asset uploads): network, cannot be rolled back. Per-asset
 *     failures (e.g. an unsupported file type, oversized file, server-side
 *     reject) are caught and recorded as `asset-upload-failed` warnings.
 *     The remaining assets continue to upload — one bad file no longer
 *     aborts the whole import. Orphaned uploads from a partial failure
 *     are left in place; they are harmless and will be swept up by a
 *     future background job.
 *   - Step C (store mutation): a single `adapter.commit` call — the adapter
 *     executes it as one Immer history snapshot; Cmd+Z reverts everything.
 *
 * @throws When the store mutation itself fails (Step C). Per-asset failures
 *         in Step A do NOT throw — they are reported in the result's
 *         warnings list.
 */
export async function commitImportPlan(
  plan: ImportPlan,
  adapter: SiteImportAdapter,
): Promise<ImportResult> {
  // ── Step A: Upload all assets ──────────────────────────────────────────────
  //
  // Upload sequentially to avoid saturating the server. The spec does not
  // require parallelism here and sequential uploads give clearer progress.
  //
  // Per-asset try/catch: a single rejected file (unsupported MIME from the
  // server's allowlist, oversized payload, network blip) used to abort the
  // entire commit and stranded every following asset. We now record the
  // failure as a warning and continue — pages and rules that referenced
  // a failed asset keep their original `url('FileMap-key')` reference, so
  // the publisher emits the unrewritten path. The user sees the warning in
  // the Done step and can re-upload manually.
  const rewriteMap: Record<string, string> = {}
  const uploadWarnings: import('./types').ImportWarning[] = []

  for (const asset of plan.assets) {
    try {
      const newUrl = await adapter.uploadAsset({
        path: asset.sourcePath,
        bytes: asset.bytes,
        mimeType: asset.mimeType,
      })
      rewriteMap[asset.sourcePath] = newUrl
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown upload error'
      uploadWarnings.push({
        kind: 'asset-upload-failed',
        message: `Failed to upload ${asset.sourcePath} (${asset.mimeType}): ${reason}`,
        path: asset.sourcePath,
      })
    }
  }

  // ── Step B: Rewrite plan URLs ──────────────────────────────────────────────
  const rewrittenPlan = applyAssetRewrites(plan, rewriteMap)

  // ── Step C: Commit pages + style rules (single atomic transaction) ─────────
  const resultPages: ImportResult['pages'] = []
  const resultRules: ImportResult['styleRules'] = []
  const resultFonts: ImportResult['fonts'] = []
  const resultColors: ImportResult['colors'] = []
  const resultScripts: ImportResult['scripts'] = []

  // Build conflict resolution lookup maps (source → resolution)
  const pageConflictsBySource = new Map<string, PageConflict>(
    rewrittenPlan.conflicts.pages.map((c) => [c.source, c]),
  )
  const ruleConflictsByName = new Map<string, RuleConflict>(
    rewrittenPlan.conflicts.rules.map((c) => [c.desiredName, c]),
  )

  await adapter.commit((tx) => {
    // Merge reusable conditions first so rule contextStyles keys resolve.
    if ((rewrittenPlan.conditions ?? []).length > 0) {
      tx.addConditions(rewrittenPlan.conditions)
    }

    // Colour tokens: register before style rules so any framework `--<slug>`
    // they emit is available to everything that follows.
    if ((rewrittenPlan.colors ?? []).length > 0) {
      resultColors.push(...tx.addColorTokens(rewrittenPlan.colors))
    }

    // Site scripts: commit imported JS as all-pages scripts.
    if ((rewrittenPlan.scripts ?? []).length > 0) {
      resultScripts.push(...tx.addScripts(rewrittenPlan.scripts))
    }

    // Custom fonts: only commit files whose src actually became a media URL
    // (a failed upload leaves a FileMap key). A family with no usable files is
    // dropped rather than producing a broken @font-face.
    const commitableFonts = rewrittenPlan.fonts
      .map((font) => ({
        ...font,
        files: font.files.filter((f) => isMediaUrl(f.src)),
      }))
      .filter((font) => font.files.length > 0)
    if (commitableFonts.length > 0) {
      resultFonts.push(...tx.addFonts(commitableFonts))
    }
    // Commit style rules first so pages that auto-create class links can
    // reference newly-imported rules.
    for (const rule of rewrittenPlan.styleRules) {
      const conflict = rule.kind === 'class'
        ? ruleConflictsByName.get(rule.name)
        : undefined
      const resolution = conflict?.defaultResolution

      if (resolution?.action === 'skip') continue

      let id: string
      if (resolution?.action === 'overwrite' && conflict) {
        tx.overwriteStyleRule(conflict.existingRuleId, rule)
        id = conflict.existingRuleId
      } else {
        id = tx.addStyleRule(rule)
      }

      resultRules.push({ id, selector: rule.selector, kind: rule.kind })
    }

    // Commit pages
    for (const page of rewrittenPlan.pages) {
      const conflict = pageConflictsBySource.get(page.source)
      const resolution = conflict?.defaultResolution

      if (resolution?.action === 'skip') continue

      let id: string
      if (resolution?.action === 'overwrite' && conflict) {
        tx.overwritePage(conflict.existingPageId, {
          title: page.title,
          slug: page.slug,
          nodeFragment: page.nodeFragment,
        })
        id = conflict.existingPageId
      } else {
        id = tx.addPage({
          title: page.title,
          slug: resolution?.resolvedSlug ?? page.slug,
          nodeFragment: page.nodeFragment,
        })
      }

      resultPages.push({ id, title: page.title, slug: page.slug, source: page.source })
    }
  })

  // Build asset result — only include the ones that actually uploaded.
  // The user-facing "K assets imported" count needs to match reality; if
  // we listed failed uploads here they'd inflate the count and confuse the
  // Done step.
  const resultAssets: ImportResult['assets'] = plan.assets
    .filter((a) => rewriteMap[a.sourcePath] !== undefined)
    .map((a) => ({
      sourcePath: a.sourcePath,
      mediaUrl: rewriteMap[a.sourcePath]!,
    }))

  return {
    pages: resultPages,
    styleRules: resultRules,
    fonts: resultFonts,
    assets: resultAssets,
    colors: resultColors,
    scripts: resultScripts,
    conflicts: plan.conflicts,
    // Carry forward the plan-level warnings (CSS parser / asset planner /
    // missing stylesheet …) AND surface any per-asset upload failures from
    // Step A above. The wizard's Done step renders this list verbatim.
    warnings: [...plan.warnings, ...uploadWarnings],
  }
}

// ---------------------------------------------------------------------------
// Re-export applyConflictResolutions for callers that need to override defaults
// ---------------------------------------------------------------------------

export { applyConflictResolutions } from './conflicts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode UTF-8 bytes to a string. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/**
 * Collapse per-file class renames into one `scoped-class` warning per original
 * class name, so the wizard reports "`.btn` was defined 2 different ways across
 * stylesheets → kept as btn, btn-2" rather than a flood of per-file entries.
 */
function summariseScopeRenames(
  renames: ReadonlyArray<{ originalName: string; scopedName: string; cssPath: string }>,
): ImportWarning[] {
  if (renames.length === 0) return []
  const scopedByOriginal = new Map<string, Set<string>>()
  for (const { originalName, scopedName } of renames) {
    let set = scopedByOriginal.get(originalName)
    if (!set) {
      set = new Set<string>()
      scopedByOriginal.set(originalName, set)
    }
    set.add(scopedName)
  }
  const warnings: ImportWarning[] = []
  for (const [originalName, scopedNames] of scopedByOriginal) {
    const variants = [originalName, ...[...scopedNames].filter((n) => n !== originalName)]
    warnings.push({
      kind: 'scoped-class',
      message: `Class ".${originalName}" was defined differently across stylesheets; kept per-page fidelity by scoping it to: ${variants.map((n) => `.${n}`).join(', ')}`,
      selector: `.${originalName}`,
    })
  }
  return warnings
}

/**
 * A font file `src` that was successfully rewritten to a media URL — either a
 * self-hosted `/uploads/` path or an absolute `https://` URL. A leftover FileMap
 * key (e.g. `fonts/Inter.woff2`) is neither, so the file is dropped.
 */
function isMediaUrl(src: string): boolean {
  return src.startsWith('/uploads/') || src.startsWith('https://')
}
