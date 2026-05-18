/**
 * SpotlightArgInput — argument prompt for subcommand flow.
 *
 * Phase 2 stub: minimal implementation, full flow is Phase 2.
 * Present so the directory structure is complete and Phase 2 can fill it in.
 */

import type { ReactNode } from 'react'
import type { CommandArg } from './types'
import styles from './Spotlight.module.css'

export interface SpotlightArgInputProps {
  arg: CommandArg
  value: string
  onChange: (value: string) => void
}

/**
 * Phase 2 stub — renders a minimal input for argument collection.
 * Full implementation (select/pick types, validation) is Phase 2.
 */
export function SpotlightArgInput({
  arg,
  value,
  onChange,
}: SpotlightArgInputProps): ReactNode {
  return (
    <div className={styles.argInput}>
      <span className={styles.argLabel}>↳ {arg.label}</span>
      <input
        className={styles.argInputField}
        type="text"
        value={value}
        placeholder={arg.placeholder ?? ''}
        onChange={(e) => onChange(e.target.value)}
        aria-label={arg.label}
      />
    </div>
  )
}
