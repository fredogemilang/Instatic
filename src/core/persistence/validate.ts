/**
 * validateSite / validatePages / validateVisualComponents — Constraint #230:
 * ALL site data loaded from storage MUST be validated before being passed to
 * `store.loadSite()`.
 *
 * `validateSite(raw): SiteShell`
 *   Structural validation is delegated to parseSiteDocument (TypeBox).
 *   runShellPostChecks() handles cross-cutting rules for the shell:
 *     1. SiteFile path safety + deduplication
 *     2. SitePackageJson name sanitization
 *     3. SiteRuntimeConfig normalization
 *     4. Framework color slug normalization + default dark color generation
 *
 * `validateVisualComponents(rawVCs): VisualComponent[]`
 *   Parses each raw VC via `parseVisualComponent`, then runs VC-specific rules:
 *     1. Name validation + deduplication (first-wins)
 *     2. Cyclic dependency detection (cyclic VCs silently dropped)
 *     3. Strip dangling VC refs in VC trees
 *     4. Richtext prop sanitization in VC trees (XSS — Constraint #299)
 *
 * `validatePages(shell, rawPages, visualComponents?): Page[]`
 *   Parses each raw page via `parsePage`, then runs page-specific rules:
 *     1. Page slug syntax
 *     2. Page slug uniqueness
 *     3. Tree invariants: root exists, node-map keys match node ids,
 *        child ids resolve, and reachable children are acyclic
 *     4. VC slot sync (uses visualComponents for context)
 *     5. Strip dangling VC refs in page trees
 *     6. Richtext prop sanitization in page node trees
 */

import { assertValidNodeTree, parseSiteDocument, parsePage, type SiteShell } from '@core/page-tree'
import type { SiteDocument, Page } from '@core/page-tree'
import type { VisualComponent } from '@core/visualComponents'
import { isSafePath, normalizePath } from '@core/files/pathValidation'
import {
  parseVisualComponent,
  validateComponentName,
  getReferencedComponentIds,
  syncSlotInstances,
  applySlotSyncResult,
} from '@core/visualComponents'
import { sanitizeRichtext, isRichtextPropKey } from '@core/sanitize'
import { normalizeSitePackageJson } from '@core/site-dependencies/manifest'
import { normalizeSiteRuntimeConfig } from '@core/site-runtime'
import { pageSlugDuplicateError, pageSlugError } from '@core/page-tree'
import { generateDefaultDarkColor, normalizeFrameworkColorSlug } from '@core/framework/colors'
import type { BaseNode } from '@core/page-tree'

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class SiteValidationError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(`[persistence/validate] ${path}: ${message}`)
    this.name = 'SiteValidationError'
    this.path = path
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a parseSiteDocument error message to a structured site path.
 *
 * parseSiteDocument throws Error with messages in two formats:
 *   1. "<relative.path>: <description>" (from parsePageNode / parsePage)
 *      → strip the ': ...' suffix, prepend 'site.'
 *   2. "<firstWord> <rest>" (top-level field errors, e.g. "id must be a string")
 *      → extract first word as field name, prepend 'site.'
 */
function extractSiteErrorPath(message: string): string {
  const colonIndex = message.indexOf(': ')
  if (colonIndex > 0) {
    return `site.${message.slice(0, colonIndex)}`
  }
  const firstWord = message.split(' ')[0]
  return `site.${firstWord}`
}

/**
 * Validate raw data from storage and return a typed `SiteShell`, or throw
 * `SiteValidationError` describing exactly which field failed.
 *
 * Pages and Visual Components are NOT included in the return — they are stored
 * in `data_rows` and validated separately via `validatePages` and
 * `validateVisualComponents`. The adapter assembles the full `SiteDocument`
 * from shell + pages + VCs after all three calls.
 *
 * Usage:
 * ```ts
 * const shell = validateSite(raw)
 * const vcs   = validateVisualComponents(rawVcRows)
 * const pages = validatePages(shell, rawPageRows, vcs)
 * store.loadSite({ ...shell, pages, visualComponents: vcs })
 * ```
 */
export function validateSite(raw: unknown): SiteShell {
  let shell: SiteShell
  try {
    shell = parseSiteDocument(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid site'
    throw new SiteValidationError(message, extractSiteErrorPath(message))
  }
  return runShellPostChecks(shell)
}

/**
 * Parse and validate an array of raw page objects (loaded from `data_rows`).
 * Uses `visualComponents` for VC slot-sync and dangling-ref checks. Pass the
 * result of `validateVisualComponents` here for full context; omit (or pass [])
 * to skip VC-dependent checks (dangling refs and slot sync).
 *
 * Returns the validated `Page[]` ready to assemble into a `SiteDocument`.
 * Throws `SiteValidationError` on the first invalid page.
 */
export interface ValidatePagesOptions {
  /**
   * Load semantics: a page that fails parse or tree-coherence is logged and
   * SKIPPED rather than aborting the whole batch — one corrupt row must not
   * brick the editor (ISS-017). The strict write/save path leaves this false so
   * a dropped page can never be mistaken for an intentional delete.
   */
  tolerant?: boolean
  /**
   * The set of VC ids genuinely present in storage (the raw roster, BEFORE the
   * loader's dedupe/cycle repair). Page refs are stripped only when their
   * target is absent from THIS set — never when the loader merely repaired a
   * duplicate-name or cyclic VC away, which would destroy authored slot content
   * (ISS-016). Defaults to the surviving `visualComponents` ids (correct for the
   * write path, where the roster is authoritative).
   */
  storedVcIds?: ReadonlySet<string>
}

export function validatePages(
  _shell: SiteShell,
  rawPages: unknown[],
  visualComponents: VisualComponent[] = [],
  options: ValidatePagesOptions = {},
): Page[] {
  const { tolerant = false, storedVcIds } = options
  let pages: Page[] = []
  for (let i = 0; i < rawPages.length; i++) {
    try {
      pages.push(parsePage(rawPages[i], i))
    } catch (err) {
      const message = err instanceof Error ? err.message : `page ${i} is invalid`
      if (tolerant) {
        console.error('[persistence/validate] dropping unparseable page', i, message)
        continue
      }
      throw new SiteValidationError(message, extractSiteErrorPath(message))
    }
  }
  validatePageSlugList(pages)
  pages = validatePageNodeTreesList(pages, tolerant)
  syncVCSlotInstancesInPages(pages, visualComponents)
  const knownVcIds = storedVcIds ?? new Set(visualComponents.map((vc) => vc.id))
  stripDanglingVCRefsInPages(pages, knownVcIds)
  sanitizePageNodeRichtextProps(pages)
  return pages
}

/**
 * Parse and validate an array of raw VisualComponent objects (loaded via
 * `visualComponentFromRow` from `data_rows where table_id = 'components'`).
 *
 * Steps:
 *   1. Parse each via `parseVisualComponent` — silently drops malformed entries.
 *   2. Deduplicate by name (first-wins; invalid names dropped).
 *   3. Drop VCs that form dependency cycles (DFS detection).
 *   4. Strip dangling VC refs within VC trees.
 *   5. Sanitize richtext-keyed props in VC trees (XSS — Constraint #299).
 *
 * Returns the validated `VisualComponent[]` ready to assemble into a
 * `SiteDocument`. Never throws — malformed data is silently dropped.
 */
export function validateVisualComponents(rawVCs: unknown[]): VisualComponent[] {
  // Step 1: parse
  const parsed: VisualComponent[] = rawVCs.flatMap((item) => {
    const vc = parseVisualComponent(item)
    if (!vc) return []
    try {
      assertValidNodeTree(vc.tree, 'site.visualComponents[].tree')
    } catch {
      return []
    }
    return [vc]
  })

  // Steps 2–5: run the same post-checks that were in runShellPostChecks
  const deduped = dedupeVCsByName(parsed)
  const acyclic = filterCyclicVCs(deduped)
  stripDanglingVCRefsInVCs(acyclic)
  sanitizeVCNodeRichtextProps(acyclic)
  return acyclic
}

/**
 * Strict write-boundary validation for full Visual Component roster saves.
 *
 * Unlike `validateVisualComponents`, this function never repairs by dropping a
 * malformed component, duplicate name, cyclic dependency, or dangling VC ref.
 * The caller is about to reconcile the complete roster in storage, so a dropped
 * item would be interpreted as an intentional delete.
 */
export function validateVisualComponentsForWrite(rawVCs: unknown[]): VisualComponent[] {
  const parsed: VisualComponent[] = []

  for (let i = 0; i < rawVCs.length; i++) {
    const vc = parseVisualComponent(rawVCs[i])
    if (!vc) {
      throw new SiteValidationError('invalid Visual Component', `site.visualComponents[${i}]`)
    }
    try {
      assertValidNodeTree(vc.tree, `site.visualComponents[${i}].tree`)
    } catch (err) {
      throw siteValidationErrorFromTreeInvariant(err, `site.visualComponents[${i}].tree`)
    }
    parsed.push({ ...vc, name: vc.name.trim() })
  }

  validateStrictVCIdentity(parsed)
  validateStrictVCRefs(parsed)
  validateStrictVCDependencyGraph(parsed)
  sanitizeVCNodeRichtextProps(parsed)
  return parsed
}

function siteValidationErrorFromTreeInvariant(err: unknown, fallbackPath: string): SiteValidationError {
  const message = err instanceof Error ? err.message : 'invalid node tree'
  const colonIndex = message.indexOf(': ')
  const path = colonIndex > 0 ? message.slice(0, colonIndex) : fallbackPath
  return new SiteValidationError(message, path)
}

/**
 * Walk a node's props and sanitize richtext-keyed values in-place.
 * Operates on a single flat node — no childNodes recursion (VC trees are now flat).
 */
function sanitizeNodeProps(node: unknown): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return
  const n = node as { props?: Record<string, unknown> }
  if (n.props && typeof n.props === 'object') {
    for (const [key, val] of Object.entries(n.props)) {
      if (isRichtextPropKey(key) && typeof val === 'string') {
        n.props[key] = sanitizeRichtext(val)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// stripDanglingVCRefs — exported for unit tests and pack installer.
// Strips dangling base.visual-component-ref nodes from both page trees AND
// VC trees. Accepts a full SiteDocument so callers with assembled sites (tests,
// pack installer) can use the one-shot form.
// ---------------------------------------------------------------------------

/**
 * Remove `base.visual-component-ref` nodes whose `componentId` does not resolve
 * to a known VC from the flat node map. Strips the entire subtree (ref +
 * slot-instances + user content) and splices the ref out of its parent's
 * `children[]`. Self-heals sites corrupted by the old (pre-fix) delete behaviour
 * that left dangling refs behind.
 *
 * Exported for unit tests. For server-side validation, the internal helpers
 * `stripDanglingVCRefsInPages` and `stripDanglingVCRefsInVCs` are called
 * directly by `validatePages` and `validateVisualComponents`.
 */
export function stripDanglingVCRefs(site: SiteDocument): void {
  const knownVcIds = new Set(site.visualComponents.map((vc) => vc.id))
  stripDanglingRefsFromNodeMaps(
    site.pages.map((p) => p.nodes as Record<string, BaseNode>),
    knownVcIds,
  )
  stripDanglingRefsFromNodeMaps(
    site.visualComponents.map((vc) => vc.tree.nodes as Record<string, BaseNode>),
    knownVcIds,
  )
}

/** Strip dangling VC refs from page node maps only. */
function stripDanglingVCRefsInPages(pages: Page[], knownVcIds: ReadonlySet<string>): void {
  stripDanglingRefsFromNodeMaps(pages.map((p) => p.nodes as Record<string, BaseNode>), knownVcIds)
}

/** Strip dangling VC refs from VC tree node maps only. */
function stripDanglingVCRefsInVCs(vcs: VisualComponent[]): void {
  const knownVcIds = new Set(vcs.map((vc) => vc.id))
  stripDanglingRefsFromNodeMaps(
    vcs.map((vc) => vc.tree.nodes as Record<string, BaseNode>),
    knownVcIds,
  )
}

function stripDanglingRefsFromNodeMaps(nodeMaps: Array<Record<string, BaseNode>>, knownVcIds: ReadonlySet<string>): void {
  for (const nodes of nodeMaps) {
    stripOneNodeMap(nodes, knownVcIds)
  }
}

function stripOneNodeMap(nodes: Record<string, BaseNode>, knownVcIds: ReadonlySet<string>): void {
  // Collect all top-level ref IDs pointing at an unknown VC
  const danglingRefIds: string[] = []
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node.moduleId !== 'base.visual-component-ref') continue
    const componentId = node.props.componentId
    if (typeof componentId !== 'string' || !componentId) continue
    if (!knownVcIds.has(componentId)) danglingRefIds.push(nodeId)
  }

  for (const refNodeId of danglingRefIds) {
    // DFS-collect entire subtree
    const subtreeIds: string[] = []
    const stack: string[] = [refNodeId]
    while (stack.length > 0) {
      const id = stack.pop()!
      const node = nodes[id]
      if (!node) continue
      subtreeIds.push(id)
      stack.push(...node.children)
    }

    // Remove ref from its parent's children[]
    for (const node of Object.values(nodes)) {
      const idx = node.children.indexOf(refNodeId)
      if (idx !== -1) {
        node.children.splice(idx, 1)
        break
      }
    }

    // Delete subtree nodes from the flat map
    for (const id of subtreeIds) {
      delete nodes[id]
    }
  }
}

/**
 * Drop VisualComponents that form dependency cycles.
 * Uses DFS cycle detection on the componentRef graph.
 */
function filterCyclicVCs(vcs: VisualComponent[]): VisualComponent[] {
  const vcMap = new Map(vcs.map((vc) => [vc.id, vc]))
  const cyclic = new Set<string>()
  const visited = new Set<string>()
  const inStack = new Set<string>()

  function dfs(id: string): boolean {
    if (inStack.has(id)) { cyclic.add(id); return true }
    if (visited.has(id)) return cyclic.has(id)
    visited.add(id)
    inStack.add(id)
    const vc = vcMap.get(id)
    if (vc) {
      for (const refId of getReferencedComponentIds(vc)) {
        if (dfs(refId)) cyclic.add(id)
      }
    }
    inStack.delete(id)
    return cyclic.has(id)
  }

  for (const vc of vcs) dfs(vc.id)
  return vcs.filter((vc) => !cyclic.has(vc.id))
}

// ---------------------------------------------------------------------------
// Shell post-checks (shell only — no pages, no VCs)
// ---------------------------------------------------------------------------

function runShellPostChecks(shell: SiteShell): SiteShell {
  normalizeSiteFiles(shell)
  normalizeSitePackage(shell)
  normalizeSiteRuntimeBlock(shell)
  normalizeFrameworkColors(shell)
  return shell
}

/** Rule 1: filter SiteFiles to safe, deduplicated, normalized paths (first-wins). */
function normalizeSiteFiles(shell: SiteShell): void {
  const seen = new Set<string>()
  shell.files = shell.files.filter((file) => {
    const normalized = normalizePath(file.path)
    if (!isSafePath(normalized) || seen.has(normalized)) return false
    seen.add(normalized)
    file.path = normalized
    return true
  })
}

/** Rule 2: filter unsafe npm names out of the site's package.json. */
function normalizeSitePackage(shell: SiteShell): void {
  shell.packageJson = normalizeSitePackageJson(shell.packageJson)
}

/** Rule 3: normalize site runtime config (dep-lock safety, script shape). */
function normalizeSiteRuntimeBlock(shell: SiteShell): void {
  shell.runtime = normalizeSiteRuntimeConfig(shell.runtime)
}

/** Rule 4: normalize framework color slugs + generate default dark values. */
function normalizeFrameworkColors(shell: SiteShell): void {
  const colors = shell.settings.framework?.colors
  if (!colors) return
  colors.tokens = colors.tokens.map((token) => ({
    ...token,
    slug: normalizeFrameworkColorSlug(token.slug),
    darkValue: token.darkValue || generateDefaultDarkColor(token.lightValue),
  }))
}

// ---------------------------------------------------------------------------
// VC post-checks (used by validateVisualComponents)
// ---------------------------------------------------------------------------

/** Deduplicate VCs by name (first-wins; invalid names dropped). */
function dedupeVCsByName(vcs: VisualComponent[]): VisualComponent[] {
  const seen = new Set<string>()
  return vcs.filter((vc) => {
    if (!validateComponentName(vc.name, []).ok) return false
    if (seen.has(vc.name)) return false
    seen.add(vc.name)
    return true
  })
}

function validateStrictVCIdentity(vcs: VisualComponent[]): void {
  const seenIds = new Map<string, number>()
  const seenNames = new Map<string, number>()

  for (let i = 0; i < vcs.length; i++) {
    const vc = vcs[i]
    if (seenIds.has(vc.id)) {
      throw new SiteValidationError(
        `duplicate Visual Component id "${vc.id}"`,
        `site.visualComponents[${i}].id`,
      )
    }
    seenIds.set(vc.id, i)

    const nameValidation = validateComponentName(vc.name, [])
    if (!nameValidation.ok) {
      throw new SiteValidationError(nameValidation.reason, `site.visualComponents[${i}].name`)
    }

    if (seenNames.has(vc.name)) {
      throw new SiteValidationError(
        `duplicate Visual Component name "${vc.name}"`,
        `site.visualComponents[${i}].name`,
      )
    }
    seenNames.set(vc.name, i)
  }
}

function validateStrictVCRefs(vcs: VisualComponent[]): void {
  const knownIds = new Set(vcs.map((vc) => vc.id))

  for (let i = 0; i < vcs.length; i++) {
    for (const refId of getReferencedComponentIds(vcs[i])) {
      if (!knownIds.has(refId)) {
        throw new SiteValidationError(
          `references missing Visual Component "${refId}"`,
          `site.visualComponents[${i}].tree`,
        )
      }
    }
  }
}

function validateStrictVCDependencyGraph(vcs: VisualComponent[]): void {
  const vcById = new Map(vcs.map((vc) => [vc.id, vc]))
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(id: string, stack: string[]): void {
    if (visiting.has(id)) {
      throw new SiteValidationError(
        `Visual Component dependency cycle: ${[...stack, id].join(' -> ')}`,
        `site.visualComponents`,
      )
    }
    if (visited.has(id)) return

    const vc = vcById.get(id)
    if (!vc) return

    visiting.add(id)
    for (const refId of getReferencedComponentIds(vc)) {
      visit(refId, [...stack, id])
    }
    visiting.delete(id)
    visited.add(id)
  }

  for (const vc of vcs) visit(vc.id, [])
}

/** Sanitize richtext-keyed props on every VC tree node. */
function sanitizeVCNodeRichtextProps(vcs: VisualComponent[]): void {
  for (const vc of vcs) {
    for (const node of Object.values(vc.tree.nodes)) sanitizeNodeProps(node)
  }
}

// ---------------------------------------------------------------------------
// Page post-checks (used by validatePages)
// ---------------------------------------------------------------------------

/** Rule 1 & 2: every page slug parses + slugs are unique within the site. */
function validatePageSlugList(pages: Page[]): void {
  for (let i = 0; i < pages.length; i++) {
    const { slug, id } = pages[i]
    const slugErr = pageSlugError(slug)
    if (slugErr) throw new SiteValidationError(slugErr, `site.pages[${i}].slug`)
    const dupErr = pageSlugDuplicateError(slug, pages, id)
    if (dupErr) throw new SiteValidationError(`duplicate slug: ${dupErr}`, `site.pages[${i}].slug`)
  }
}

/**
 * Rule 3: every page tree must be internally coherent before save/hydration.
 * In tolerant (load) mode an incoherent page is logged and dropped so it can't
 * brick the whole site load; in strict (write) mode it throws. Returns the
 * surviving pages.
 */
function validatePageNodeTreesList(pages: Page[], tolerant: boolean): Page[] {
  const valid: Page[] = []
  for (let i = 0; i < pages.length; i++) {
    try {
      assertValidNodeTree(pages[i], `site.pages[${i}]`)
      valid.push(pages[i]!)
    } catch (err) {
      if (tolerant) {
        const message = err instanceof Error ? err.message : `page ${i} has an invalid tree`
        console.error('[persistence/validate] dropping page with invalid tree', pages[i]?.id, message)
        continue
      }
      throw siteValidationErrorFromTreeInvariant(err, `site.pages[${i}]`)
    }
  }
  return valid
}

/**
 * Rule 4: idempotently reconcile slot-instance children on every VC ref so the
 * page tree matches each VC's current slot params. Heals drift from data
 * predating the mutation-side slot sync.
 */
function syncVCSlotInstancesInPages(pages: Page[], visualComponents: VisualComponent[]): void {
  const vcById = new Map(visualComponents.map((vc) => [vc.id, vc]))
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) {
      if (node.moduleId !== 'base.visual-component-ref') continue
      const componentId = node.props.componentId
      if (typeof componentId !== 'string' || !componentId) continue
      const vc = vcById.get(componentId)
      if (!vc) continue
      const treeNodes = page.nodes as Record<string, BaseNode>
      const syncResult = syncSlotInstances(node as BaseNode, vc, treeNodes)
      if (syncResult.ops.length > 0 || Object.keys(syncResult.newNodes).length > 0) {
        applySlotSyncResult(treeNodes, syncResult, node.id)
      }
    }
  }
}

/** Rule 5: sanitize richtext-keyed props on every page node tree. */
function sanitizePageNodeRichtextProps(pages: Page[]): void {
  for (const page of pages) {
    for (const node of Object.values(page.nodes)) sanitizeNodeProps(node)
  }
}
