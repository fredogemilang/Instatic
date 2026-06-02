/**
 * CmsBundleReviewStep — review path for CMS-native site bundles.
 *
 * Static-site imports build an `ImportPlan`; CMS-exported JSON bundles already
 * contain canonical tables, rows, optional site shell, and media bytes. This
 * step keeps those semantics intact by showing the server preview diff and
 * strategy selector before `POST /admin/api/cms/import` applies the bundle.
 */
import { Button } from '@ui/components/Button'
import type { BundlePreview, ImportStrategy } from '@core/data/bundleSchema'
import { ImportStepper } from '../shared/ImportStepper'
import styles from './CmsBundleReviewStep.module.css'

interface StrategyOption {
  value: ImportStrategy
  title: string
  description: string
}

const STRATEGY_OPTIONS: ReadonlyArray<StrategyOption> = [
  {
    value: 'replace',
    title: 'Replace everything',
    description: 'Wipe the local site and replace it with the bundle. Best for full restores.',
  },
  {
    value: 'merge-add',
    title: 'Merge: add only',
    description: "Insert bundle rows that do not exist locally. Existing rows stay untouched.",
  },
  {
    value: 'merge-overwrite',
    title: 'Merge: overwrite',
    description: 'Upsert bundle rows. Local rows that are not in the bundle stay untouched.',
  },
]

type TableEntry = BundlePreview['tables'][number]

interface CmsBundleReviewStepProps {
  filename: string
  preview: BundlePreview | null
  previewLoading: boolean
  previewError: string | null
  strategy: ImportStrategy
  onStrategyChange: (strategy: ImportStrategy) => void
  onChooseDifferentFile: () => void
}

export function CmsBundleReviewStep({
  filename,
  preview,
  previewLoading,
  previewError,
  strategy,
  onStrategyChange,
  onChooseDifferentFile,
}: CmsBundleReviewStepProps) {
  return (
    <div className={styles.step}>
      <ImportStepper current="review" />

      <div className={styles.body}>
        {previewLoading && (
          <div className={styles.statusBlock}>
            <p className={styles.statusText} aria-live="polite">
              Checking bundle against current site...
            </p>
          </div>
        )}

        {previewError && (
          <div className={styles.statusBlock}>
            <p role="alert" className={styles.errorText}>
              {previewError}
            </p>
            <Button variant="ghost" size="sm" type="button" onClick={onChooseDifferentFile}>
              Choose a different file
            </Button>
          </div>
        )}

        {preview && (
          <BundlePreviewPanel
            filename={filename}
            preview={preview}
            strategy={strategy}
            onStrategyChange={onStrategyChange}
          />
        )}
      </div>
    </div>
  )
}

function BundlePreviewPanel({
  filename,
  preview,
  strategy,
  onStrategyChange,
}: {
  filename: string
  preview: BundlePreview
  strategy: ImportStrategy
  onStrategyChange: (strategy: ImportStrategy) => void
}) {
  const exportedAt = new Date(preview.meta.exportedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
  const hasContent =
    preview.tables.some((table) => table.inBundle > 0) || preview.totals.mediaFiles > 0

  return (
    <div className={styles.preview}>
      <div className={styles.previewMeta}>
        <p className={styles.metaRow}>
          <span className={styles.metaLabel}>Bundle</span>
          <span className={styles.metaValue}>{filename}</span>
        </p>
        <p className={styles.metaRow}>
          <span className={styles.metaLabel}>Exported</span>
          <span className={styles.metaValue}>{exportedAt}</span>
        </p>
        {preview.meta.sourceSiteName && (
          <p className={styles.metaRow}>
            <span className={styles.metaLabel}>From site</span>
            <span className={styles.metaValue}>{preview.meta.sourceSiteName}</span>
          </p>
        )}
      </div>

      <div className={styles.previewSection}>
        <p className={styles.sectionHeading}>Diff against current site</p>
        {!hasContent ? (
          <p className={styles.emptyBundle}>No content in this bundle.</p>
        ) : (
          <ul className={styles.diffList}>
            {preview.tables.map((entry) => (
              <li key={entry.id} className={styles.diffRow}>
                <span className={styles.diffBullet} aria-hidden="true">-</span>
                <span className={styles.diffTableName}>{entry.name}</span>
                <span className={styles.diffDetail}>{formatDiffRow(entry)}</span>
              </li>
            ))}
            {preview.totals.mediaFiles > 0 && (
              <li className={styles.diffRow}>
                <span className={styles.diffBullet} aria-hidden="true">-</span>
                <span className={styles.diffTableName}>Media files</span>
                <span className={styles.diffDetail}>
                  {preview.totals.mediaFiles}{' '}
                  {preview.totals.mediaEmbedded
                    ? '(bytes embedded)'
                    : '(not embedded - paths only)'}
                </span>
              </li>
            )}
          </ul>
        )}
      </div>

      <fieldset className={styles.strategyFieldset}>
        <legend className={styles.sectionHeading}>Import strategy</legend>
        {STRATEGY_OPTIONS.map((option) => (
          <label
            key={option.value}
            className={styles.strategyOption}
            data-selected={strategy === option.value ? 'true' : undefined}
          >
            <input
              type="radio"
              name="cms-import-strategy"
              value={option.value}
              checked={strategy === option.value}
              onChange={() => onStrategyChange(option.value)}
              className={styles.strategyRadio}
            />
            <span className={styles.strategyContent}>
              <span className={styles.strategyTitle}>{option.title}</span>
              <span
                className={styles.strategyDescription}
                data-tone={option.value === 'replace' ? 'danger' : undefined}
              >
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  )
}

function unitLabel(kind: TableEntry['kind'], count: number): string {
  if (kind === 'page') return count === 1 ? 'page' : 'pages'
  if (kind === 'component') return count === 1 ? 'component' : 'components'
  return count === 1 ? 'row' : 'rows'
}

function formatDiffRow(entry: TableEntry): string {
  const unit = unitLabel(entry.kind, entry.currentLocal)

  if (entry.inBundle === 0) {
    return `0 in bundle (current: ${entry.currentLocal} ${unit})`
  }
  if (entry.willReplace > 0 && entry.willAdd > 0) {
    return `${entry.inBundle} in bundle, ${entry.willReplace} will replace, ${entry.willAdd} new (current: ${entry.currentLocal} ${unit})`
  }
  if (entry.willAdd > 0) {
    return `${entry.inBundle} in bundle, all new (current: ${entry.currentLocal} ${unit})`
  }
  if (entry.willReplace > 0) {
    return `${entry.inBundle} in bundle, all replace existing (current: ${entry.currentLocal} ${unit})`
  }
  return `${entry.inBundle} in bundle (current: ${entry.currentLocal} ${unit})`
}
