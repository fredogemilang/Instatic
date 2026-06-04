/**
 * base.outlet editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import React from 'react'
import type { ModuleComponentProps } from '@core/module-engine'
import { CanvasModulePlaceholder } from '@ui/components/CanvasModulePlaceholder'
import { TextPlusIcon } from 'pixel-art-icons/icons/text-plus'

interface OutletProps extends Record<string, unknown> {
  html: string
}

export const OutletEditor: React.FC<ModuleComponentProps<OutletProps>> = ({ props, mcClassName, nodeWrapperProps }) => {
  if (!props.html) {
    return (
      <CanvasModulePlaceholder
        {...nodeWrapperProps}
        className={mcClassName}
        icon={<TextPlusIcon size={16} />}
        label="Content outlet"
      />
    )
  }

  return (
    <article
      {...nodeWrapperProps}
      className={mcClassName}
      dangerouslySetInnerHTML={{ __html: props.html }}
    />
  )
}
