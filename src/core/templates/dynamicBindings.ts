/**
 * Dynamic prop binding — resolves runtime values from the publisher's
 * entry stack into a node's static props at render time.
 *
 * The stack semantics are the heart of how templates compose with loops:
 *  - The publisher seeds the stack with the page's primary entry when
 *    rendering a single-entry content template.
 *  - The `base.loop` renderer pushes each iteration's item onto the stack
 *    before recursing into the loop's child subtree, then pops on exit.
 *  - `dynamicBindings.source: 'currentEntry'` always reads the stack top,
 *    i.e. "the closest enclosing entity". Inside a loop nested in a
 *    template, that's the loop iteration; outside the loop it's still
 *    the template entry.
 *  - `dynamicBindings.source: 'parentEntry'` reads one frame below the
 *    top — useful inside a loop nested in a template, where you want to
 *    refer to the outer template entry from inside an iteration.
 *
 * Field lookup is generic: each `LoopItem` carries a `fields` map, and
 * the resolver simply reads `fields[binding.field]`. Format coercions
 * (e.g. markdown → HTML for body bindings with `format: 'html'`) happen
 * here as a thin shim so already-persisted bindings keep working without
 * the source needing to pre-render every variant.
 */

import type { DynamicPropBinding } from '../page-tree'
import type { LoopItem } from '../loops/types'
import { renderContentMarkdownToHtml } from '../markdown/renderContentMarkdown'

/**
 * Render-time context handed to the publisher.
 *
 * `entryStack` is mutated in place by the publisher's loop interceptor
 * (push on iteration enter, pop on iteration exit). Stack-top resolves
 * `source: 'currentEntry'`; one below resolves `source: 'parentEntry'`.
 */
export interface TemplateRenderDataContext {
  entryStack: LoopItem[]
}

/** Empty context helper — used by call sites that have no template entry. */
export const EMPTY_TEMPLATE_CONTEXT: TemplateRenderDataContext = { entryStack: [] }

/**
 * Resolve a single binding against the entry stack.
 *
 * Returns `undefined` for fields that don't exist on the resolved frame
 * (or when the requested frame doesn't exist) — the caller decides
 * whether to fall back to the static prop or substitute an empty value.
 */
function resolveBindingValue(
  binding: DynamicPropBinding,
  context: TemplateRenderDataContext,
): unknown {
  const stack = context.entryStack
  // currentEntry → top, parentEntry → one below, etc.
  const offsetFromTop = binding.source === 'parentEntry' ? 1 : 0
  const item = stack[stack.length - 1 - offsetFromTop]
  if (!item) return undefined

  const value = item.fields[binding.field]

  // Backward-compat shim: legacy bindings on content-entries items often
  // store `field: 'body'` with `format: 'html'`, expecting the resolver
  // to render markdown to HTML. Source authors who don't want this
  // behaviour can expose pre-rendered HTML on a different field id.
  if (
    binding.format === 'html' &&
    typeof value === 'string' &&
    (binding.field === 'body' || binding.field === 'bodyMarkdown')
  ) {
    return renderContentMarkdownToHtml(value)
  }

  return value
}

export function resolveDynamicProps(
  staticProps: Record<string, unknown>,
  bindings: Record<string, DynamicPropBinding> | undefined,
  context: TemplateRenderDataContext | undefined,
): Record<string, unknown> {
  if (!bindings || !context || context.entryStack.length === 0) return staticProps

  const resolved = { ...staticProps }
  for (const [propKey, binding] of Object.entries(bindings)) {
    const value = resolveBindingValue(binding, context)
    if (value === undefined || value === null) {
      if (binding.fallback === 'empty') resolved[propKey] = ''
      continue
    }

    resolved[propKey] = value
  }

  return resolved
}
