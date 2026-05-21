/**
 * Publisher — `base.loop` iteration renderer.
 *
 * Specialised renderer for loop nodes. The loop iterates its resolved data
 * and round-robins over the loop's children — child i renders item i,
 * pushing each item onto the template entry stack so dynamic bindings
 * inside the body resolve against the loop entry.
 *
 * Takes `renderNode` as a parameter rather than importing it directly so
 * the file graph stays acyclic — the dispatcher in `renderNode.ts` is the
 * only thing that knows both ends of the recursion.
 */

import type { PageNode } from '@core/page-tree'
import type { LoopItem } from '@core/loops/types'
import { resolveHtmlTag } from '@modules/base/utils/htmlTag'
import { injectNodeClassIds } from './classInjection'
import { escapeHtml } from './utils'
import type { RenderContext } from './renderContext'

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
export function renderLoop(
  node: PageNode,
  ctx: RenderContext,
  renderNode: (nodeId: string, ctx: RenderContext) => string,
): string {
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

  // Wrapper element — author-selectable via the shared htmlTag helper
  // (defaults to 'div'). `resolveHtmlTag` always returns a safe lowercase
  // tag name, so it's already escape-safe for interpolation.
  const tag = resolveHtmlTag(props.tag, props.customTag)
  const html = `<${tag}${attrs}>${body}</${tag}>`

  // Inject the loop's own classIds onto the wrapper element.
  return injectNodeClassIds(html, node.classIds, ctx.site)
}
