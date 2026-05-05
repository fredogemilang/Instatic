/**
 * base.loop — pluggable repeater that iterates a data source and renders
 * its child subtree(s) per item.
 *
 * Round-robin children: a loop with N children renders iteration `i`
 * with child `i mod N`. Two children alternate (1,2,1,2,…); three
 * children cycle (1,2,3,1,2,3…). Empty list of children renders nothing.
 *
 * Data comes from a registered `LoopEntitySource` (see
 * `src/core/loops/types.ts`). Built-ins are content.entries, site.pages,
 * site.media. Plugins can register more.
 *
 * The publisher's `renderLoop()` interceptor handles rendering — this
 * module's own `render()` is a no-op fallback. Same pattern as
 * `base.visual-component-ref`.
 *
 * Pagination property:
 *   - 'none'     — render up to `limit` items, no paginator
 *   - 'infinite' — render `pageSize` items then a "load more" sentinel
 *                  serviced by the loop runtime (Phase 6)
 *
 * Numeric pagination is intentionally NOT a mode here — it will live in
 * a separate `base.pagination` module that pairs with a loop by ID.
 */
import type { ModuleDefinition } from '@core/module-engine/types'
import { registry } from '@core/module-engine/registry'
import { BoxStackIcon } from 'pixel-art-icons/icons/box-stack'
import { LoopEditor } from './LoopEditor'

interface LoopProps extends Record<string, unknown> {
  sourceId: string
  filters: Record<string, unknown>
  orderBy: string
  direction: 'asc' | 'desc'
  limit: number
  offset: number
  pagination: 'none' | 'infinite'
  pageSize: number
}

export const LoopModule: ModuleDefinition<LoopProps> = {
  id: 'base.loop',
  name: 'Loop',
  description: 'Iterate a data source and repeat the child template per item.',
  category: 'Layout',
  version: '1.0.0',
  icon: BoxStackIcon,
  trusted: true,
  canHaveChildren: true,

  // Loop properties are NOT panel-edited via the generic schema renderer
  // because filterSchema is dynamic per source. The Properties Panel
  // branches on moduleId === 'base.loop' (Phase 7).
  schema: {},

  defaults: {
    sourceId: '',
    filters: {},
    orderBy: '',
    direction: 'desc',
    limit: 10,
    offset: 0,
    pagination: 'none',
    pageSize: 10,
  },

  component: LoopEditor,

  /**
   * Defense-in-depth fallback: the publisher walker intercepts base.loop
   * nodes via `renderLoop()` in `render.ts` before this method is ever
   * called. This implementation is intentionally unreachable under
   * normal operation.
   */
  render: () => ({ html: '<!-- pb: loop render fell through to default -->' }),
}

registry.registerOrReplace(LoopModule)
