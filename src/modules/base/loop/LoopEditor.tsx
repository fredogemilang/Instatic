/**
 * base.loop editor preview component.
 *
 * Render strategy:
 *  - Empty (no children authored): show a hint placeholder so the author
 *    knows to drop a template subtree inside.
 *  - Has children: render them directly inside a single wrapper `<div>`
 *    that takes the user's class assignments via `mcClassName`. The
 *    canvas wrapper element is therefore the same element the publisher
 *    will emit (`<div class="<user-classes>">…</div>` from `renderLoop()`),
 *    so layout styles like `display: grid; gap: 24px` actually take
 *    effect on canvas the same way they will on the published page.
 *
 * The component intentionally adds no default visual styling — no inner
 * `display: contents` wrappers, no extra divs. Whatever the author
 * assigns is what they get.
 *
 * Component-only file so React Fast Refresh can hot-patch the canvas
 * without re-running module registration.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine/types'
import { BoxStackIcon } from 'pixel-art-icons/icons/box-stack'
import styles from './loop.module.css'

export const LoopEditor: React.FC<ModuleComponentProps> = ({ children, mcClassName }) => {
  const hasChildren = React.Children.count(children) > 0

  if (!hasChildren) {
    return (
      <div className={styles.empty}>
        <BoxStackIcon size={14} color="currentColor" aria-hidden="true" />
        <span>Drop a template subtree to repeat — the loop will iterate it per item.</span>
      </div>
    )
  }

  return <div className={mcClassName}>{children}</div>
}
