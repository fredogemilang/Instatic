/**
 * base.body editor preview component.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration.
 */
import type { ModuleComponentProps } from '@core/module-engine/types'

type BodyProps = Record<string, unknown>

export const BodyEditor = ({ children, mcClassName }: ModuleComponentProps<BodyProps>) => (
  <div className={mcClassName}>
    {children}
  </div>
)
