/**
 * DoneStep — the final step of the Super Import wizard.
 *
 * Shows a summary of what was imported and three action buttons:
 *   - View first imported page (opens it in the canvas)
 *   - Open Selectors panel
 *   - Close
 *
 * Also lists any warnings from the import.
 */
import { Button } from '@ui/components/Button'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { WarningDiamondSolidIcon } from 'pixel-art-icons/icons/warning-diamond-solid'
import type { ImportResult } from '@core/siteImport'
import { useEditorStore } from '@site/store/store'
import styles from './DoneStep.module.css'

interface DoneStepProps {
  result: ImportResult
  droppedJs: number
  droppedAtRules: number
  onClose: () => void
}

export function DoneStep({ result, droppedJs, droppedAtRules, onClose }: DoneStepProps) {
  function handleViewFirstPage() {
    const firstPage = result.pages[0]
    if (!firstPage) return
    useEditorStore.getState().openPageInCanvas(firstPage.id)
    onClose()
  }

  function handleOpenSelectors() {
    useEditorStore.getState().setSelectorsPanelOpen(true)
    onClose()
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.summary}>
        <CheckIcon size={20} aria-hidden="true" className={styles.successIcon} />
        <div className={styles.counts}>
          <p className={styles.countLine}>
            <strong>{result.pages.length}</strong>{' '}
            {result.pages.length === 1 ? 'page' : 'pages'} imported
          </p>
          <p className={styles.countLine}>
            <strong>{result.styleRules.length}</strong>{' '}
            style {result.styleRules.length === 1 ? 'rule' : 'rules'} imported
          </p>
          <p className={styles.countLine}>
            <strong>{result.assets.length}</strong>{' '}
            {result.assets.length === 1 ? 'asset' : 'assets'} uploaded
          </p>
          {result.fonts.length > 0 && (
            <p className={styles.countLine}>
              <strong>{result.fonts.length}</strong>{' '}
              {result.fonts.length === 1 ? 'font' : 'fonts'} imported
            </p>
          )}
          {(droppedJs > 0 || droppedAtRules > 0) && (
            <p className={styles.droppedLine}>
              Dropped: {droppedJs > 0 ? `${droppedJs} scripts` : ''}{droppedJs > 0 && droppedAtRules > 0 ? ', ' : ''}{droppedAtRules > 0 ? `${droppedAtRules} @-rules` : ''}
            </p>
          )}
        </div>
      </div>

      <div className={styles.actions}>
        {result.pages.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={handleViewFirstPage}
          >
            View first imported page
          </Button>
        )}
        {result.styleRules.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={handleOpenSelectors}
          >
            Open Selectors panel
          </Button>
        )}
      </div>

      {result.warnings.length > 0 && (
        <section className={styles.warnings}>
          <h3 className={styles.warningsHeading}>
            <WarningDiamondSolidIcon size={13} aria-hidden="true" />
            {result.warnings.length} warning{result.warnings.length !== 1 ? 's' : ''}
          </h3>
          <ul className={styles.warningList}>
            {result.warnings.slice(0, 12).map((w, i) => (
              <li key={i} className={styles.warningItem}>
                <span className={styles.warningKind}>{w.kind}</span>
                <span className={styles.warningMsg}>{w.message}</span>
              </li>
            ))}
            {result.warnings.length > 12 && (
              <li className={styles.warningItem}>
                <span className={styles.warningMsg}>…and {result.warnings.length - 12} more</span>
              </li>
            )}
          </ul>
        </section>
      )}
    </div>
  )
}
