/**
 * Publisher — Recursive Renderer
 *
 * Converts a Page (flat-map PageNode tree) into a clean, standalone HTML document.
 * All string props are HTML-escaped before being passed to module render() functions.
 * CSS is deduplicated by moduleId — 50 heading nodes share one CSS entry.
 *
 * Constraint #211: escapeProps() must be called on every node before render().
 * Constraint #179: module render() is a pure function — no DOM, no React, no side effects.
 * Decision #308: CSS dedup keyed by moduleId reduces published CSS by ~60–80% on typical pages.
 */

import type { Page, PageNode, SiteDocument } from '../page-tree/schemas'
import type { IModuleRegistry } from '../module-engine/types'
import { resolveProps } from '../page-tree/selectors'
import { resolveDynamicProps, type TemplateRenderDataContext } from '../templates/dynamicBindings'
import { classNamesForClassIds } from '../page-tree/classNames'
import { sanitizeModuleCSS, collectClassCSS } from './cssCollector'
import { PUBLISHER_RESET_CSS } from './reset'
import { buildSiteRootCss } from './rootCss'
import type { SiteCssBundle } from './siteCssBundle'
import { escapeHtml, isSafeUrl } from './utils'
import type { PublishedPageRuntimeAssets } from '../site-runtime/schemas'
import { hasPublishedRuntimeScripts, scriptTagsForRuntimeAssets } from '../site-runtime'
import { sanitizeRichtext } from '../sanitize'
import { instantiateVCAtRef, type InstantiatedVCNode } from '../visualComponents/instantiate'
import type { VCNode } from '../visualComponents/schemas'
import type { LoopFetchResult, LoopItem } from '../loops/types'

// Re-export canonical utilities so existing imports from this file keep working
// (render.test.ts imports escapeHtml / isSafeUrl from here)
export { escapeHtml, isSafeUrl } from './utils'

// ---------------------------------------------------------------------------
// Security — prop escaping (Constraint #211)
// ---------------------------------------------------------------------------

/**
 * URL-related prop key suffixes and exact keys.
 * These receive URL validation rather than HTML escaping.
 */
const URL_PROP_KEYS = new Set(['href', 'src', 'action', 'url'])
const URL_PROP_SUFFIXES = ['url', 'href', 'src']

/**
 * Richtext/HTML prop keys — passed through unescaped.
 * MUST have been sanitized (e.g. DOMPurify) at input time.
 */
const RICHTEXT_PROP_KEYS = new Set(['richtext', 'html'])
const RICHTEXT_PROP_SUFFIXES = ['html', 'richtext']

function isUrlKey(key: string): boolean {
  const k = key.toLowerCase()
  if (URL_PROP_KEYS.has(k)) return true
  return URL_PROP_SUFFIXES.some((s) => k.endsWith(s))
}

function isRichtextKey(key: string): boolean {
  const k = key.toLowerCase()
  if (RICHTEXT_PROP_KEYS.has(k)) return true
  return RICHTEXT_PROP_SUFFIXES.some((s) => k.endsWith(s))
}

/**
 * Escape all string props before passing them to a module's render() function.
 *
 * Rules:
 * - String props: HTML-escaped via escapeHtml()
 * - URL props (href/src/action/url suffixes): validated with isSafeUrl(), replaced with '#' if unsafe
 * - Richtext/HTML props: passed through as-is (must be sanitised at input time)
 * - Non-string props: unchanged
 */
export function escapeProps(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const escaped: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(props)) {
    if (typeof value !== 'string') {
      escaped[key] = value
      continue
    }

    if (isRichtextKey(key)) {
      // Richtext: defense-in-depth sanitization via DOMPurify (Constraint #368).
      // DOMPurify runs at write time (editor/Properties Panel boundary); this is a
      // second pass at the publisher boundary so that corrupted or injected richtext
      // values cannot reach the published HTML unsanitized.
      // sanitizeRichtext falls back to a regex strip if DOMPurify is unavailable
      // (e.g. server-side Bun context with no DOM).
      escaped[key] = sanitizeRichtext(value)
    } else if (isUrlKey(key)) {
      // URLs: block javascript: and vbscript: schemes; pass safe URLs through raw
      // so that module render() functions can HTML-escape them via safeUrl() from
      // modules/base/utils/escape.ts.  Publisher HTML-escaping plain strings is the
      // escapeProps() contract for non-URL string props; URL props deliberately skip
      // the escapeHtml() step here to avoid double-escaping when modules call safeUrl()
      // (which also applies escapeHtml internally).
      // Note: publishPage() manually escapeHtml()'s faviconUrl/fontImportUrl because
      // those are not passed to module render() — they go directly into HTML template
      // strings that never pass through a module's safeUrl() call.
      escaped[key] = isSafeUrl(value) ? value : '#'
    } else {
      // Plain strings: HTML-escape
      escaped[key] = escapeHtml(value)
    }
  }

  return escaped
}

// ---------------------------------------------------------------------------
// Class injection helper (Task #401 Bug 3)
// ---------------------------------------------------------------------------

/**
 * Inject a class attribute into the ROOT element of an HTML string.
 *
 * The function locates the first opening element tag in `html` and modifies
 * only that tag — never a nested descendant. Two cases on the root tag:
 *
 * 1. Root tag already has `class="..."` → prepend the new classes.
 *    `<div class="existing">` → `<div class="class_name existing">`
 * 2. Root tag has no class attribute → insert one as the first attribute.
 *    `<button type="button">` → `<button class="class_name" type="button">`
 *
 * The classAttr string is pre-validated by the caller (class tokens, HTML-escaped).
 *
 * Comments / DOCTYPE / processing-instructions before the first element tag
 * are skipped — they don't take a class attribute. If `html` contains no
 * element tag at all (e.g. a comment-only placeholder, or empty string),
 * the original `html` is returned unchanged.
 *
 * Anchoring on the FIRST tag is essential: the previous implementation used
 * a non-anchored regex that could match a nested descendant's `class="..."`
 * when the root had no class — causing parent classes to be wrongly prepended
 * to the deepest classed element rather than to the root itself.
 */
function injectClassIntoRootElement(html: string, classAttr: string): string {
  // Find the first opening element tag. Anchored on `<[a-zA-Z]` so it skips
  // `<!--`, `<!DOCTYPE`, and `<?xml`-style prefixes.
  // `[^>]*` is safe because module render() output escapes attribute values
  // (so `>` cannot appear inside an attribute value here).
  const tagMatch = html.match(/<([a-zA-Z][\w-]*)\b([^>]*)>/)
  if (!tagMatch) return html

  const [fullMatch, tagName, attrs] = tagMatch
  const tagStart = tagMatch.index ?? 0

  // Does the ROOT tag already carry a class attribute?
  const classRe = /\bclass="([^"]*)"/
  const existingClass = attrs.match(classRe)

  let newAttrs: string
  if (existingClass) {
    // Prepend the new classes to the existing list (preserve cascade order)
    newAttrs = attrs.replace(classRe, `class="${classAttr} ${existingClass[1]}"`)
  } else {
    // Insert the class as the first attribute on the root tag
    newAttrs = ` class="${classAttr}"${attrs}`
  }

  const newTag = `<${tagName}${newAttrs}>`
  return html.slice(0, tagStart) + newTag + html.slice(tagStart + fullMatch.length)
}

// ---------------------------------------------------------------------------
// Visual Component inlining
// ---------------------------------------------------------------------------

/**
 * Adapt an InstantiatedVCNode to the PageNode shape required by the publisher walker.
 *
 * VCNode is structurally compatible with PageNode for all fields the walker reads
 * (moduleId, props, breakpointOverrides, children, classIds). The extra
 * InstantiatedVCNode fields (_owningRefId, _fromSlotContent) are not part of
 * PageNode and are harmlessly ignored by the walker. childNodes is explicitly
 * cleared here because instantiateVCAtRef always sets it to undefined on all
 * emitted nodes — the flat map is the canonical representation.
 * dynamicBindings is intentionally absent: VCNodes don't support template
 * bindings (those live only on page-level nodes).
 */
function instantiatedNodeToPageNode(node: InstantiatedVCNode): PageNode {
  return {
    id: node.id,
    moduleId: node.moduleId,
    props: node.props,
    breakpointOverrides: node.breakpointOverrides,
    children: node.children,
    label: node.label,
    locked: node.locked,
    hidden: node.hidden,
    classIds: node.classIds,
    propBindings: node.propBindings,
    childNodes: undefined,
  }
}

/**
 * Render a base.visual-component-ref node by inlining its VC tree.
 *
 * Called from renderNode before the normal render() dispatch for all
 * base.visual-component-ref nodes. The VC is instantiated via
 * instantiateVCAtRef (which applies propOverrides and expands slot outlets),
 * then rendered recursively using a synthetic Page built from the flat
 * instantiated node map. The shared ctx.cssMap ensures CSS deduplication
 * across the whole page — a VC used three times contributes module CSS only once.
 *
 * The page-level ref node's own classIds are injected onto the VC's root
 * element after recursive rendering, preserving the page author's intent.
 */
function renderVisualComponentRef(node: PageNode, ctx: RenderContext): string {
  const componentId =
    typeof node.props.componentId === 'string' ? node.props.componentId.trim() : ''
  if (!componentId) {
    return '<!-- pb: visual-component-ref missing componentId -->'
  }

  const propOverrides =
    node.props.propOverrides !== null &&
    typeof node.props.propOverrides === 'object' &&
    !Array.isArray(node.props.propOverrides)
      ? (node.props.propOverrides as Record<string, unknown>)
      : {}

  const rawSlotContent =
    node.props.slotContent !== null &&
    typeof node.props.slotContent === 'object' &&
    !Array.isArray(node.props.slotContent)
      ? (node.props.slotContent as Record<string, VCNode[]>)
      : {}

  const vc = ctx.site.visualComponents.find((v) => v.id === componentId)
  if (!vc) {
    return `<!-- pb: unknown component "${escapeHtml(componentId)}" -->`
  }

  const { nodes: instantiatedNodes, rootNodeId } = instantiateVCAtRef(
    vc,
    propOverrides,
    rawSlotContent,
    node.id,
  )

  // Build a minimal synthetic Page from the instantiated flat node map.
  // Only nodes and rootNodeId are needed by the walker — other Page fields
  // are stubs (the VC has no URL, slug, or template configuration).
  const syntheticNodes: Record<string, PageNode> = {}
  for (const [id, vcNode] of Object.entries(instantiatedNodes)) {
    syntheticNodes[id] = instantiatedNodeToPageNode(vcNode)
  }

  const syntheticPage: Page = {
    id: `vc:${node.id}`,
    slug: '',
    title: '',
    nodes: syntheticNodes,
    rootNodeId,
  }

  // Reuse all context fields but swap the page for the VC's synthetic page.
  // Sharing cssMap is critical: CSS dedup is keyed by moduleId across the
  // whole published page, including all inlined VC instances.
  const syntheticCtx: RenderContext = {
    page: syntheticPage,
    site: ctx.site,
    registry: ctx.registry,
    breakpointId: ctx.breakpointId,
    templateContext: ctx.templateContext,
    cssMap: ctx.cssMap,
  }

  let html = renderNode(rootNodeId, syntheticCtx)

  // If the page-level ref node carries classIds, inject them onto the VC's root
  // element. The VC's own nodes contribute their classIds via the recursive call.
  if (node.classIds?.length) {
    const classAttr = classNamesForClassIds(ctx.site.classes, node.classIds)
      .map(escapeHtml)
      .join(' ')
    if (classAttr) html = injectClassIntoRootElement(html, classAttr)
  }

  return html
}

// ---------------------------------------------------------------------------
// base.loop renderer
// ---------------------------------------------------------------------------

/**
 * Render a `base.loop` node by iterating its resolved data and round-robining
 * over the loop's children.
 *
 * For a loop with N children and M items, iteration `i` (0-indexed) renders
 * the loop's child at index `i mod N` with the loop's `entryStack` extended
 * by the iteration's item. Two children → alternating layouts; three →
 * cycle of three; etc. After each iteration the entry stack is restored
 * so the loop's siblings keep seeing the outer template entry (if any).
 *
 * Loops without resolved data (server pre-fetch failed, source unregistered,
 * or no data context like in editor canvas tests) render an HTML comment so
 * the page doesn't silently lose layout. Empty result sets render as empty
 * string — author can wrap the loop in a Container to apply "if empty, hide
 * the section" patterns later.
 *
 * Pagination:
 *   - 'none': all rendered items emitted, no extra markup.
 *   - 'infinite': items emitted, plus a `data-pb-loop-id` sentinel and the
 *     loop's nodeId is added to `ctx.infiniteLoopIds` so the publisher can
 *     inject the runtime script. The runtime fetches subsequent pages from
 *     `/_pb/loop/<loopId>?page=N` and appends rendered HTML.
 *
 * The loop's own `classIds` are injected onto a wrapping `<div>` so author-
 * applied classes (e.g. grid layout) actually take effect.
 */
function renderLoop(node: PageNode, ctx: RenderContext): string {
  const loopId = node.id
  const data = ctx.loopData?.get(loopId)
  // No pre-fetched data — most likely an editor preview or a test that did
  // not seed loopData. Emit a marker comment rather than an empty string so
  // diagnostics in the rendered output are visible.
  if (!data) {
    return `<!-- pb: loop "${escapeHtml(loopId)}" has no resolved data -->`
  }

  const variants = node.children ?? []
  if (variants.length === 0) {
    return '<!-- pb: loop has no child template -->'
  }
  if (data.items.length === 0) {
    return ''
  }

  // Make sure entryStack exists — bindings inside the loop body resolve
  // against this stack. Mutating in place is fine because the publisher
  // owns the context for this single render pass.
  if (!ctx.templateContext) {
    ctx.templateContext = { entryStack: [] }
  }
  const stack = ctx.templateContext.entryStack

  let body = ''
  data.items.forEach((item: LoopItem, i: number) => {
    const variantId = variants[i % variants.length]
    stack.push(item)
    try {
      body += renderNode(variantId, ctx)
    } finally {
      stack.pop()
    }
  })

  // Pagination signals — pagination='infinite' attaches a sentinel and
  // registers the loop's id so publishPage() can decide whether to emit
  // the runtime script.
  const props = node.props
  const isInfinite = props.pagination === 'infinite'
  let attrs = ` data-pb-loop="${escapeHtml(loopId)}"`
  attrs += ` data-pb-loop-page="${data.pageNumber}"`
  if (isInfinite) {
    attrs += ` data-pb-loop-mode="infinite"`
    attrs += ` data-pb-loop-has-more="${data.hasMore ? 'true' : 'false'}"`
    attrs += ` data-pb-loop-page-size="${typeof props.pageSize === 'number' ? Math.floor(props.pageSize) : 10}"`
    if (!ctx.infiniteLoopIds) ctx.infiniteLoopIds = new Set()
    ctx.infiniteLoopIds.add(loopId)
  }

  let html = `<div${attrs}>${body}</div>`

  // Inject the loop's own classIds onto the wrapper element.
  if (node.classIds?.length) {
    const classAttr = classNamesForClassIds(ctx.site.classes, node.classIds)
      .map(escapeHtml)
      .join(' ')
    if (classAttr) html = injectClassIntoRootElement(html, classAttr)
  }

  return html
}

// ---------------------------------------------------------------------------
// Recursive renderer
// ---------------------------------------------------------------------------

/**
 * Resolved loop data for one `base.loop` node, produced by the server's
 * `prefetchLoopData()` helper before publishing.
 */
export interface ResolvedLoopRenderData extends LoopFetchResult {
  /** 1-indexed page number when the loop is in `infinite` mode. */
  pageNumber: number
  /** Whether more rows remain past the current page. */
  hasMore: boolean
}

export interface RenderContext {
  page: Page
  site: SiteDocument
  registry: IModuleRegistry
  breakpointId: string | undefined
  templateContext?: TemplateRenderDataContext
  /**
   * CSS deduplication map: moduleId → CSS string.
   * Each module type contributes at most one CSS entry regardless of instance count.
   * Decision #308: keying by moduleId is O(1); at 200 nodes saves ~60–80% CSS vs naive concat.
   */
  cssMap: Map<string, string>
  /**
   * Pre-fetched loop data, keyed by loop nodeId. Populated by
   * `server/cms/loopPrefetch.ts` before `publishPage()` is called.
   * Loops without an entry here render empty.
   */
  loopData?: Map<string, ResolvedLoopRenderData>
  /**
   * Set of loop nodeIds on the page that requested the infinite-scroll
   * runtime. The publisher reads this after rendering to decide whether
   * to inject the `loop-runtime.js` `<script>` tag.
   */
  infiniteLoopIds?: Set<string>
}

/**
 * Render a single node and its entire subtree recursively (bottom-up).
 *
 * Children are rendered first; their HTML strings are passed as `renderedChildren`
 * to the parent node's render() call — exactly the contract in ModuleDefinition.
 *
 * @returns HTML string for this node and all its descendants
 */
export function renderNode(nodeId: string, ctx: RenderContext): string {
  const node: PageNode | undefined = ctx.page.nodes[nodeId]
  if (!node) return ''

  const def = ctx.registry.get(node.moduleId)
  if (!def) {
    // Unknown module — emit a comment so the page doesn't silently lose content
    return `<!-- pb: unknown module "${escapeHtml(node.moduleId)}" -->`
  }

  // Special case: visual-component-ref nodes inline the VC tree recursively.
  // This intercept happens BEFORE children rendering and render() dispatch because
  // the ref node's children (none — canHaveChildren: false) are irrelevant; the
  // VC body comes from instantiateVCAtRef, not from page.nodes children.
  if (node.moduleId === 'base.visual-component-ref') {
    return renderVisualComponentRef(node, ctx)
  }

  // Special case: base.loop nodes iterate a registered LoopEntitySource.
  // Like visual-component-ref, this intercept replaces the normal
  // children-then-render flow because each iteration needs its own
  // render pass with a different entry-stack frame.
  if (node.moduleId === 'base.loop') {
    return renderLoop(node, ctx)
  }

  // 1. Render children first (bottom-up) — pass their HTML to the parent
  const renderedChildren = (node.children ?? []).map((childId) =>
    renderNode(childId, ctx),
  )

  // 2. Resolve effective props (base + breakpoint shallow-merge)
  const effectiveProps = resolveProps(node, ctx.breakpointId)
  const resolvedProps = resolveDynamicProps(effectiveProps, node.dynamicBindings, ctx.templateContext)

  // 3. Escape all string props (Constraint #211) before calling render()
  const safeProps = escapeProps(resolvedProps)

  // 4. Call the pure render() function
  const output = def.render(safeProps as never, renderedChildren)

  // 5. Collect CSS — one entry per moduleId (dedup).
  //    Sanitize before storage: strip </style> to prevent style-block escape (Constraint #228).
  if (output.css && !ctx.cssMap.has(node.moduleId)) {
    ctx.cssMap.set(node.moduleId, sanitizeModuleCSS(output.css))
  }

  // 6. Inject user-facing class names into the root HTML element.
  //    base.body emits no wrapper element — its render returns naked children
  //    HTML — so there's nothing to inject onto here. Root-level classIds are
  //    applied to <body> by publishPage() instead.
  let html = output.html
  if (node.moduleId !== 'base.body' && node.classIds?.length) {
    const classAttr = classNamesForClassIds(ctx.site.classes, node.classIds)
      .map(escapeHtml)
      .join(' ')
    if (classAttr) html = injectClassIntoRootElement(html, classAttr)
  }

  return html
}

// ---------------------------------------------------------------------------
// Page publisher
// ---------------------------------------------------------------------------

interface PublishedPage {
  /** Filename for this page in the ZIP archive, e.g. "index.html", "about-us.html" */
  filename: string
  /** Complete <!DOCTYPE html> document — no editor dependencies */
  html: string
}

export interface PublishPageOptions {
  breakpointId?: string
  templateContext?: TemplateRenderDataContext
  runtimeAssets?: PublishedPageRuntimeAssets
  /**
   * Pre-fetched data for every `base.loop` node on the page, keyed by
   * loop nodeId. Produced server-side by `prefetchLoopData()` before
   * publishing. Loops without an entry here render an empty string in
   * the published page (and an HTML comment in dev/preview).
   */
  loopData?: Map<string, ResolvedLoopRenderData>
  /**
   * Optional URL hint for the loop runtime — used to construct
   * "Load more" endpoint URLs in `data-pb-loop-endpoint` attributes
   * when the page contains an infinite-mode loop. Defaults to
   * `/_pb/loop/`.
   */
  loopEndpointBaseUrl?: string
  /**
   * How site-wide CSS (reset, framework, user classes) is emitted into the
   * published HTML.
   *
   * - `'inline'` (default): one `<style>` block in `<head>` containing reset +
   *   framework root CSS + module CSS + user class CSS. Best for self-contained
   *   exports, the iframe runtime preview, and tests.
   * - `'external'`: emits three `<link rel="stylesheet">` tags pointing at the
   *   pre-built site CSS bundle (`/_pb/css/<filename>`). The HTML stays small,
   *   the bundles are content-hashed for `Cache-Control: immutable` reuse
   *   across page navigations. Pass `cssBundle` + `cssAssetBaseUrl` to use this
   *   mode.
   *
   * In external mode any per-page module CSS that would have been inlined is
   * skipped here — it's assumed to live in `cssBundle.framework.content`,
   * which is what `buildSiteCssBundle()` produces. This keeps every visitor's
   * three CSS files cacheable.
   */
  cssEmission?: 'inline' | 'external'
  /**
   * Pre-built site CSS bundle. Required when `cssEmission === 'external'`.
   * Computed once per published-snapshot via `buildSiteCssBundle(site, registry)`.
   */
  cssBundle?: SiteCssBundle
  /**
   * Base URL prepended to each bundle filename to form the `<link href>`
   * value, e.g. `'/_pb/css/'`. Defaults to `'/_pb/css/'`.
   */
  cssAssetBaseUrl?: string
}

/**
 * Build the `<style>` block (inline mode) or `<link>` tags (external mode)
 * that go into `<head>`.
 *
 * Cascade order is identical in both modes: reset → framework (root tokens +
 * module CSS) → user class CSS. User class CSS loads last so it wins
 * specificity ties — same behaviour as the previous in-`<style>` cascade.
 */
function buildStyleHead(
  cssEmission: 'inline' | 'external',
  options: PublishPageOptions,
  site: SiteDocument,
  cssMap: Map<string, string>,
): string {
  if (cssEmission === 'external') {
    if (!options.cssBundle) {
      throw new Error('publishPage: cssEmission "external" requires options.cssBundle')
    }
    const baseUrl = options.cssAssetBaseUrl ?? '/_pb/css/'
    const links = [options.cssBundle.reset, options.cssBundle.framework, options.cssBundle.style]
      // Skip empty bundles — emitting `<link>` to a 0-byte file is a wasted
      // request. `framework.css` and `style.css` are routinely empty on a
      // fresh site (no framework configured, no classes defined).
      .filter((file) => file.content.length > 0)
      .map((file) => `  <link rel="stylesheet" href="${escapeHtml(baseUrl + file.filename)}">`)
      .join('\n')
    return links ? `${links}\n` : ''
  }

  const rootCss = buildSiteRootCss(site)
  const moduleCss = Array.from(cssMap.values()).join('\n')
  const classCss = collectClassCSS(site)
  const allCss = [PUBLISHER_RESET_CSS, rootCss, moduleCss, classCss]
    .filter(Boolean)
    .join('\n')
  return `  <style>\n${allCss}\n  </style>\n`
}

/**
 * Convert a page title/slug to a safe HTML filename.
 * "About Us" → "about-us.html", "index" → "index.html"
 */
function slugToFilename(slug: string, title: string): string {
  const base = (slug || title || 'page')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return base === '' || base === 'index' ? 'index.html' : `${base}.html`
}

/**
 * Publish a single page to a standalone HTML document.
 *
 * - Walks the node tree bottom-up, collecting HTML and CSS.
 * - Deduplicates CSS across all nodes (one entry per moduleId).
 * - Injects site design tokens as CSS :root custom properties.
 * - Embeds the deduplicated CSS in a single <style> block — no external stylesheets.
 * - No editor code, no React, no framework runtime in the output.
 *
 * @param page         The page to publish
 * @param site      The site (used for settings, title, tokens)
 * @param registry     The module registry
 * @param breakpointId Optional breakpoint to publish at (uses breakpoint prop overrides)
 */
export function publishPage(
  page: Page,
  site: SiteDocument,
  registry: IModuleRegistry,
  breakpointIdOrOptions?: string | PublishPageOptions,
  templateContext?: TemplateRenderDataContext,
): PublishedPage {
  const options: PublishPageOptions =
    typeof breakpointIdOrOptions === 'object' && breakpointIdOrOptions !== null
      ? breakpointIdOrOptions
      : { breakpointId: breakpointIdOrOptions, templateContext }
  const { breakpointId, runtimeAssets } = options
  const cssEmission = options.cssEmission ?? 'inline'
  const cssMap = new Map<string, string>()
  const ctx: RenderContext = {
    page,
    site,
    registry,
    breakpointId,
    templateContext: options.templateContext,
    cssMap,
    loopData: options.loopData,
    infiniteLoopIds: undefined,
  }

  // Render entire tree from root. The walker also accumulates module CSS
  // into `cssMap`; in external mode that result is discarded because the
  // same data is already in the pre-built `framework.css` bundle.
  const bodyHtml = renderNode(page.rootNodeId, ctx)

  // Compute the <body> class attribute from the root node's classIds.
  // base.body emits no wrapper element, so any user classes applied to the
  // page root land on <body> directly — clean HTML, no freeloader <div>.
  const rootNode = page.nodes[page.rootNodeId]
  const bodyClassAttr =
    rootNode?.classIds?.length
      ? classNamesForClassIds(site.classes, rootNode.classIds)
          .map(escapeHtml)
          .join(' ')
      : ''
  const bodyOpenTag = bodyClassAttr ? `<body class="${bodyClassAttr}">` : '<body>'

  // Build CSS head content based on emission mode.
  //
  // Cascade order (both modes): reset → framework (tokens + module CSS) →
  // user class CSS. User classes load last so they win specificity ties on
  // identically-specific selectors.
  const styleHeadHtml = buildStyleHead(cssEmission, options, site, cssMap)

  const { settings } = site
  const pageTitle = escapeHtml(settings.metaTitle ?? page.title ?? site.name)
  const metaDesc = settings.metaDescription
    ? `\n  <meta name="description" content="${escapeHtml(settings.metaDescription)}">`
    : ''
  // URL-validate icon and font URLs — isSafeUrl() blocks javascript:/vbscript: schemes.
  // escapeHtml() then makes the validated URL safe for HTML attribute injection.
  const favicon =
    settings.faviconUrl && isSafeUrl(settings.faviconUrl)
      ? `\n  <link rel="icon" href="${escapeHtml(settings.faviconUrl)}">`
      : ''
  const fontImport =
    settings.fontImportUrl && isSafeUrl(settings.fontImportUrl)
      ? `\n  <link rel="stylesheet" href="${escapeHtml(settings.fontImportUrl)}">`
      : ''

  const headRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'head')
  const bodyEndRuntimeScripts = scriptTagsForRuntimeAssets(runtimeAssets, 'body-end')
  const hasRuntimeScripts = hasPublishedRuntimeScripts(runtimeAssets)
  const hasInfiniteLoops = (ctx.infiniteLoopIds?.size ?? 0) > 0
  // Loop runtime is a self-hosted script bundle served at a known fixed
  // path; only injected when at least one loop on the page uses
  // pagination='infinite'. This keeps the "no JS by default" line for
  // pages that don't need it.
  const loopEndpointBaseUrl = options.loopEndpointBaseUrl ?? '/_pb/loop/'
  const loopRuntimeScript = hasInfiniteLoops
    ? `  <script type="module" src="/_pb/assets/loop-runtime.js" data-pb-loop-endpoint="${escapeHtml(loopEndpointBaseUrl)}" defer></script>`
    : ''
  const anyScriptTag = hasRuntimeScripts || hasInfiniteLoops
  const scriptSource = anyScriptTag ? "'self'" : "'none'"
  const workerSource = anyScriptTag ? "'self' blob:" : "'none'"

  // Constraint #227: every published page must carry a Content-Security-Policy meta tag.
  // Runtime-enabled pages only allow self-hosted external script assets.
  const csp =
    `\n  <meta http-equiv="Content-Security-Policy"` +
    ` content="default-src 'self'; script-src ${scriptSource};` +
    ` style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;` +
    ` frame-src 'none'; worker-src ${workerSource};">`

  // WCAG 2.1 AA SC 3.1.1: lang attribute must reflect the site's declared language.
  // Escape the tag value — even a BCP-47 tag is user-controlled and must be safe for HTML output.
  const langAttr = escapeHtml(settings.language ?? 'en')

  const html =
    `<!DOCTYPE html>\n` +
    `<html lang="${langAttr}">\n` +
    `<head>\n` +
    `  <meta charset="UTF-8">\n` +
    `  <meta name="viewport" content="width=device-width, initial-scale=1.0">${csp}\n` +
    `  <title>${pageTitle}</title>${metaDesc}${favicon}${fontImport}\n` +
    styleHeadHtml +
    `${headRuntimeScripts ? `${headRuntimeScripts}\n` : ''}` +
    `</head>\n` +
    `${bodyOpenTag}\n` +
    `${bodyHtml}\n` +
    `${bodyEndRuntimeScripts ? `${bodyEndRuntimeScripts}\n` : ''}` +
    `${loopRuntimeScript ? `${loopRuntimeScript}\n` : ''}` +
    `</body>\n` +
    `</html>`

  return {
    filename: slugToFilename(page.slug, page.title),
    html,
  }
}
