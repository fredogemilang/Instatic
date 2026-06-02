/**
 * ConflictRow — a single slug or class-name conflict with its resolution picker.
 *
 * Shows the source path (or class name) and a segmented control for the resolution
 * action. When "Custom…" is selected, an `<Input>` appears inline for the
 * user to type the custom slug or name.
 */
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Input } from '@ui/components/Input'
import type { ConflictResolution } from '@core/siteImport'
import styles from './ConflictRow.module.css'

type ResolutionAction = ConflictResolution['action']

const ACTION_OPTIONS = [
  { value: 'auto-rename', label: 'Rename', tooltip: 'Rename with a numeric suffix' },
  { value: 'skip',        label: 'Skip' },
  { value: 'overwrite',   label: 'Overwrite' },
  { value: 'custom-rename', label: 'Custom' },
] satisfies ReadonlyArray<{ value: ResolutionAction; label: string; tooltip?: string }>

// Options minus "Overwrite" — used when there is no existing target to
// overwrite (an intra-batch collision between two imported items).
const ACTION_OPTIONS_NO_OVERWRITE = ACTION_OPTIONS.filter((o) => o.value !== 'overwrite')

export interface ConflictRowProps {
  kind: 'page' | 'rule'
  source: string
  desired: string
  current: ConflictResolution
  /**
   * Whether an "Overwrite" target actually exists. False for intra-batch
   * collisions (two imported items resolving to the same slug/name with no
   * pre-existing page/rule) — overwriting nothing is meaningless and would
   * abort the commit, so the option is hidden.
   */
  canOverwrite?: boolean
  onChange: (next: ConflictResolution) => void
}

export function ConflictRow({ kind, source, desired, current, canOverwrite = true, onChange }: ConflictRowProps) {
  const isCustom = current.action === 'custom-rename'
  const resolutionLabel = kind === 'page' ? (source || desired) : desired
  const customValue =
    kind === 'page'
      ? (current.resolvedSlug ?? desired)
      : (current.resolvedName ?? desired)

  function handleActionChange(action: ResolutionAction) {
    if (action === 'auto-rename') {
      onChange({ action })
    } else if (action === 'overwrite') {
      onChange({ action })
    } else if (action === 'skip') {
      onChange({ action })
    } else {
      // custom-rename — pre-fill with the desired value
      onChange(
        kind === 'page'
          ? { action, resolvedSlug: desired }
          : { action, resolvedName: desired },
      )
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.meta}>
        <span className={styles.source}>{source || desired}</span>
        <span className={styles.desired}>{desired}</span>
      </div>
      <div className={styles.controls}>
        <SegmentedControl<ResolutionAction>
          value={current.action}
          options={canOverwrite ? ACTION_OPTIONS : ACTION_OPTIONS_NO_OVERWRITE}
          onChange={handleActionChange}
          size="xs"
          aria-label={`Conflict resolution for ${resolutionLabel}`}
        />
        {isCustom && (
          <Input
            fieldSize="sm"
            value={customValue}
            onChange={(e) => {
              onChange(
                kind === 'page'
                  ? { action: 'custom-rename', resolvedSlug: e.target.value }
                  : { action: 'custom-rename', resolvedName: e.target.value },
              )
            }}
            placeholder={kind === 'page' ? 'custom-slug' : 'custom-class'}
            aria-label={kind === 'page' ? 'Custom slug' : 'Custom class name'}
          />
        )}
      </div>
    </div>
  )
}
