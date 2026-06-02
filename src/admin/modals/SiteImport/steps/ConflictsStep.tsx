/**
 * ConflictsStep — the third step of the Super Import wizard.
 *
 * Shows page slug conflicts and class name conflicts with resolution pickers.
 * Each row uses `ConflictRow` to let the user choose between auto-rename,
 * overwrite, skip, or a custom value.
 * Section-level controls apply the common actions to every conflict in a
 * category, so large repeat imports do not require hundreds of row edits.
 *
 * The modal's Next handler auto-skips this step when there are no conflicts
 * after selection filtering. This component guards with an early return just
 * in case it's rendered without conflicts.
 */
import type { ImportPlan, ConflictResolution } from '@core/siteImport'
import { Button } from '@ui/components/Button'
import { ConflictRow } from '../shared/ConflictRow'
import styles from './ConflictsStep.module.css'

type BulkResolutionAction = Extract<ConflictResolution['action'], 'auto-rename' | 'overwrite' | 'skip'>
type PageConflict = ImportPlan['conflicts']['pages'][number]
type RuleConflict = ImportPlan['conflicts']['rules'][number]

function pageResolutionForAction(
  action: BulkResolutionAction,
  conflict: PageConflict,
): ConflictResolution {
  if (action === 'auto-rename') return conflict.defaultResolution
  return { action }
}

function ruleResolutionForAction(
  action: BulkResolutionAction,
  conflict: RuleConflict,
): ConflictResolution {
  if (action === 'auto-rename') return conflict.defaultResolution
  return { action }
}

interface ConflictsStepProps {
  plan: ImportPlan
  pageResolutions: Map<string, ConflictResolution>
  ruleResolutions: Map<string, ConflictResolution>
  onPageResolutionChange: (source: string, resolution: ConflictResolution) => void
  onRuleResolutionChange: (desiredName: string, resolution: ConflictResolution) => void
}

export function ConflictsStep({
  plan,
  pageResolutions,
  ruleResolutions,
  onPageResolutionChange,
  onRuleResolutionChange,
}: ConflictsStepProps) {
  const { pages: pageConflicts, rules: ruleConflicts } = plan.conflicts
  const pageBulkOverwriteAvailable = pageConflicts.every((conflict) => conflict.existingPageId !== '')

  if (pageConflicts.length === 0 && ruleConflicts.length === 0) {
    return null
  }

  function applyPageResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of pageConflicts) {
      onPageResolutionChange(conflict.source, pageResolutionForAction(action, conflict))
    }
  }

  function applyRuleResolutionToAll(action: BulkResolutionAction) {
    for (const conflict of ruleConflicts) {
      onRuleResolutionChange(conflict.desiredName, ruleResolutionForAction(action, conflict))
    }
  }

  return (
    <div className={styles.wrapper}>
      {pageConflicts.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.heading}>
              Page slug conflicts ({pageConflicts.length})
            </h3>
            <fieldset className={styles.bulkActions}>
              <legend className={styles.bulkLegend}>Bulk page slug conflict actions</legend>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Rename all page slug conflicts"
                onClick={() => applyPageResolutionToAll('auto-rename')}
              >
                Rename all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Skip all page slug conflicts"
                onClick={() => applyPageResolutionToAll('skip')}
              >
                Skip all
              </Button>
              {pageBulkOverwriteAvailable && (
                <Button
                  variant="secondary"
                  size="xs"
                  type="button"
                  aria-label="Overwrite all page slug conflicts"
                  onClick={() => applyPageResolutionToAll('overwrite')}
                >
                  Overwrite all
                </Button>
              )}
            </fieldset>
          </div>
          <p className={styles.hint}>
            These pages share a slug with an existing page, or with another
            page in this import. Choose how to resolve each one.
          </p>
          <div className={styles.rows}>
            {pageConflicts.map((conflict) => (
              <ConflictRow
                key={conflict.source}
                kind="page"
                source={conflict.source}
                desired={conflict.desiredSlug}
                current={pageResolutions.get(conflict.source) ?? conflict.defaultResolution}
                // No existing page id ⇒ intra-batch collision; nothing to overwrite.
                canOverwrite={conflict.existingPageId !== ''}
                onChange={(next) => onPageResolutionChange(conflict.source, next)}
              />
            ))}
          </div>
        </section>
      )}

      {ruleConflicts.length > 0 && (
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <h3 className={styles.heading}>
              Class name conflicts ({ruleConflicts.length})
            </h3>
            <fieldset className={styles.bulkActions}>
              <legend className={styles.bulkLegend}>Bulk class name conflict actions</legend>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Rename all class name conflicts"
                onClick={() => applyRuleResolutionToAll('auto-rename')}
              >
                Rename all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Skip all class name conflicts"
                onClick={() => applyRuleResolutionToAll('skip')}
              >
                Skip all
              </Button>
              <Button
                variant="secondary"
                size="xs"
                type="button"
                aria-label="Overwrite all class name conflicts"
                onClick={() => applyRuleResolutionToAll('overwrite')}
              >
                Overwrite all
              </Button>
            </fieldset>
          </div>
          <p className={styles.hint}>
            These class names are already used in this site's style registry.
          </p>
          <div className={styles.rows}>
            {ruleConflicts.map((conflict) => (
              <ConflictRow
                key={conflict.desiredName}
                kind="rule"
                source={conflict.source}
                desired={conflict.desiredName}
                current={ruleResolutions.get(conflict.desiredName) ?? conflict.defaultResolution}
                onChange={(next) => onRuleResolutionChange(conflict.desiredName, next)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
