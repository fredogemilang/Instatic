/**
 * BindingPickerDialog — the two-pane DataMeta picker.
 *
 * Layout adapts to context:
 *  - Loop-bound to a specific table → fields + live preview pane.
 *  - Template page (auto-scoped)    → single fields pane.
 *  - Default (free pick)            → table list + fields panes.
 *
 * DataMeta is fetched once and cached module-level in `./cache.ts`;
 * `clearDataMetaCache` is exported from there directly (e.g. for tests).
 */

import { useEffect, useMemo, useState } from 'react'
import type { PropertyControl } from '@core/module-engine/types'
import type { DynamicPropBinding } from '@core/page-tree'
import type { LoopSourceField, LoopItem } from '@core/loops/types'
import type { DataMeta, DataMetaField, DataMetaTable } from '@core/data/schemas'
import { useEditorStore, selectActivePage } from '@site/store/store'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { EmptyState } from '@ui/components/EmptyState'
import { SearchBar } from '@ui/components/SearchBar'
import { BracesIcon } from 'pixel-art-icons/icons/braces'
import { SkeletonBlock } from '@ui/components/Skeleton'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { getFieldIcon } from '@admin/pages/data/utils/fieldIcons'
import { isFieldBindable, type PropertyControlKind } from '../bindingCompatibility'
import { _cachedMeta, loadDataMeta } from './cache'
import { previewCmsDataLoopItems } from '@core/persistence/cmsData'
import { SYSTEM_SOURCES, type SystemSourceId } from '../systemSources'
import {
  buildPageFrame,
  buildSiteFrame,
  buildRouteFrame,
} from '@core/templates/contextFrames'
import {
  LOOP_SCOPE_KEY,
  SYSTEM_KEY_PREFIX,
  systemKey,
  deriveFormat,
  loopFieldFormat,
  loopFieldMatchesControl,
  formatPreviewValue,
  type FieldEntry,
  type FieldGroup,
} from './helpers'
import styles from './DynamicBindingControl.module.css'

// ---------------------------------------------------------------------------
// Icons for loop / system source field formats
//
// Resolved at module load (not inside the component) so the linter does not
// flag them as "components created during render".
// ---------------------------------------------------------------------------

const LoopRichTextIcon = getFieldIcon('richText')
const LoopUrlIcon = getFieldIcon('url')
const LoopPlainTextIcon = getFieldIcon('text')

function LoopFieldIcon({ format }: { format?: LoopSourceField['format'] }) {
  if (format === 'media') return <ImageSolidIcon size={12} aria-hidden="true" />
  if (format === 'html') return <LoopRichTextIcon size={12} aria-hidden="true" />
  if (format === 'url') return <LoopUrlIcon size={12} aria-hidden="true" />
  return <LoopPlainTextIcon size={12} aria-hidden="true" />
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface PickerDialogProps {
  open: boolean
  label: string
  control: PropertyControl
  availableFields?: LoopSourceField[]
  sourceLabel?: string
  loopTableId?: string | null
  /**
   * Insert mode — confirm button reads "Insert", dialog title indicates
   * insertion rather than binding, and the result is delivered as a
   * token by the parent `DynamicBindingControl`.
   */
  insertMode?: boolean
  onClose: () => void
  onSet: (binding: DynamicPropBinding) => void
}

export function BindingPickerDialog({
  open,
  label,
  control,
  availableFields,
  sourceLabel,
  loopTableId,
  insertMode = false,
  onClose,
  onSet,
}: PickerDialogProps) {
  // ─── Meta fetching ─────────────────────────────────────────────────────
  // Lazy initializer picks up the cached value so already-loaded meta is
  // immediately available without a synchronous setState in the effect.
  const [meta, setMeta] = useState<DataMeta | null>(() => _cachedMeta)
  const [metaLoading, setMetaLoading] = useState(false)
  const [metaError, setMetaError] = useState<string | null>(null)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    if (_cachedMeta) return // already in state via lazy initializer
    let cancelled = false
    setMetaLoading(true)
    loadDataMeta()
      .then((m) => {
        if (cancelled) return
        setMeta(m)
        setMetaLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setMetaError(err instanceof Error ? err.message : 'Failed to load data meta')
        setMetaLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  // ─── Active page template for auto-scope ───────────────────────────────
  const activePageTableSlug = useEditorStore((s) => {
    const page = selectActivePage(s)
    return page?.template?.tableSlug ?? null
  })

  // Live page/site frames for the system-source preview pane. Read off
  // the store so the preview shows the same values bindings will resolve
  // to on the actual page.
  const activePageForFrame = useEditorStore(selectActivePage)
  const activeSite = useEditorStore((s) => s.site)

  // Auto-scope precedence:
  //   1. `loopTableId` (Loop bound to a specific data table) — most specific.
  //      The user picked a table on the loop, so the binding picker should
  //      offer that table's fields directly.
  //   2. `activePageTableSlug` (template page) — the page is bound to a row
  //      from this table, so currentEntry resolves against it.
  // Once auto-scoped, the left pane is hidden and the right pane shows the
  // table's fields. The loop's synthetic fields (authorName, permalink,
  // publishedAt, etc.) appear as a separate group at the bottom of the
  // right pane so they remain reachable.
  const scopedTable: DataMetaTable | null = useMemo(() => {
    if (!meta) return null
    if (loopTableId) {
      const byId = meta.tables.find((t) => t.id === loopTableId)
      if (byId) return byId
    }
    if (activePageTableSlug) {
      return meta.tables.find((t) => t.slug === activePageTableSlug) ?? null
    }
    return null
  }, [loopTableId, activePageTableSlug, meta])

  // Loop scope as a standalone left-pane entry: only when we have loop
  // fields AND no specific table to auto-scope to (otherwise the synthetic
  // fields are appended to the table-fields pane instead).
  const hasLoopScope = !scopedTable && (availableFields?.length ?? 0) > 0

  // ─── Picker state ──────────────────────────────────────────────────────
  const [selectedTableKey, setSelectedTableKey] = useState<string | null>(null)
  const [fieldSearch, setFieldSearch] = useState('')
  const [pendingBinding, setPendingBinding] = useState<DynamicPropBinding | null>(null)
  // Hovered field id — drives the live preview pane on the right so users
  // can "scrub" through fields and see what each one actually contains
  // before committing to a binding.
  const [hoveredFieldId, setHoveredFieldId] = useState<string | null>(null)
  // Sample rows for the loop's bound table. Fetched lazily when the dialog
  // opens with a `loopTableId` so the preview pane shows real values from
  // the user's data instead of synthetic placeholders.
  const [previewItems, setPreviewItems] = useState<LoopItem[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !loopTableId) {
      return
    }
    let cancelled = false
    setPreviewLoading(true)
    previewCmsDataLoopItems(loopTableId, { limit: 3, orderBy: 'publishedAt', direction: 'desc' })
      .then((result) => {
        if (cancelled) return
        setPreviewItems(result.items)
        setPreviewLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setPreviewItems([])
        setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, loopTableId])

  // Reset state and apply auto-scope when dialog opens / meta loads.
  // Picks the most specific source available so the right pane is never
  // blank: a scoped table → that table; a loop scope → the loop entry;
  // otherwise the first System source (`page`).
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return
    setFieldSearch('')
    setPendingBinding(null)
    if (scopedTable) {
      setSelectedTableKey(`table:${scopedTable.id}`)
    } else if (hasLoopScope) {
      setSelectedTableKey(LOOP_SCOPE_KEY)
    } else {
      setSelectedTableKey(systemKey(SYSTEM_SOURCES[0]!.id))
    }
  }, [open, scopedTable, hasLoopScope])

  // When meta finishes loading and we have an auto-scope, select it.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!meta || !open) return
    if (selectedTableKey) return
    if (scopedTable) {
      setSelectedTableKey(`table:${scopedTable.id}`)
    } else if (hasLoopScope) {
      setSelectedTableKey(LOOP_SCOPE_KEY)
    } else {
      setSelectedTableKey(systemKey(SYSTEM_SOURCES[0]!.id))
    }
  }, [meta, open, hasLoopScope, scopedTable, selectedTableKey])

  // ─── Computed field list for the right pane ────────────────────────────
  const controlKind = control.type as PropertyControlKind

  // Post-type-only loop synthetic fields. Hidden when the auto-scoped table
  // is `kind: 'data'` because they're irrelevant noise there (no body,
  // featured media, SEO, etc.).
  const POST_TYPE_ONLY_LOOP_FIELDS = useMemo(
    () => new Set(['title', 'body', 'featuredMedia', 'firstImage', 'seoTitle', 'seoDescription']),
    [],
  )

  const rightPaneGroups: FieldGroup[] | null = useMemo(() => {
    if (!selectedTableKey) return null

    // Loop-only scope (no specific table chosen) — flat list of the source's
    // synthetic fields under a single "Loop metadata" group.
    if (selectedTableKey === LOOP_SCOPE_KEY) {
      const entries = (availableFields ?? []).map((f) => ({ kind: 'loop' as const, field: f }))
      return [{ label: sourceLabel ? `${sourceLabel} fields` : 'Loop metadata', entries }]
    }

    // System source scope (page / site / route).
    if (selectedTableKey.startsWith(SYSTEM_KEY_PREFIX)) {
      const sourceId = selectedTableKey.slice(SYSTEM_KEY_PREFIX.length) as SystemSourceId
      const source = SYSTEM_SOURCES.find((s) => s.id === sourceId)
      if (!source) return null
      const entries: FieldEntry[] = source.fields.map((f) => ({
        kind: 'system' as const,
        source: source.id,
        field: f,
      }))
      return [{ label: `${source.label} fields`, entries }]
    }

    const tableId = selectedTableKey.replace('table:', '')
    const table = meta?.tables.find((t) => t.id === tableId)
    if (!table) return null

    const tableEntries: FieldEntry[] = table.fields.map((f) => ({ kind: 'meta' as const, field: f }))
    const tableGroup: FieldGroup = { label: `${table.name} fields`, entries: tableEntries }

    // When auto-scoped to the loop's bound table, surface the loop's
    // synthetic source fields (authorName, permalink, publishedAt, etc.)
    // as a separate group so users can tell what came from THEIR table vs
    // what the loop adds automatically. Dedupe by field id and filter out
    // post-type-only synthetics for `kind: 'data'` tables.
    if (scopedTable && scopedTable.id === table.id && availableFields && availableFields.length > 0) {
      const tableFieldIds = new Set(table.fields.map((f) => f.id))
      const loopEntries: FieldEntry[] = availableFields
        .filter((f) => !tableFieldIds.has(f.id))
        .filter((f) => table.kind === 'postType' || !POST_TYPE_ONLY_LOOP_FIELDS.has(f.id))
        .map((f) => ({ kind: 'loop' as const, field: f }))
      if (loopEntries.length > 0) {
        return [tableGroup, { label: 'Loop metadata', entries: loopEntries }]
      }
    }
    return [tableGroup]
  }, [
    selectedTableKey,
    meta,
    availableFields,
    scopedTable,
    sourceLabel,
    POST_TYPE_ONLY_LOOP_FIELDS,
  ])

  // Apply the search filter to each group (dropping empty groups so the
  // section header doesn't render against zero rows).
  const filteredRightPaneGroups = useMemo(() => {
    if (!rightPaneGroups) return null
    const q = fieldSearch.trim().toLowerCase()
    if (!q) return rightPaneGroups
    return rightPaneGroups
      .map((g) => ({
        ...g,
        entries: g.entries.filter((entry) => {
          const label = entry.field.label.toLowerCase()
          const id = entry.field.id.toLowerCase()
          return label.includes(q) || id.includes(q)
        }),
      }))
      .filter((g) => g.entries.length > 0)
  }, [rightPaneGroups, fieldSearch])

  const allFieldsIncompatible = useMemo(() => {
    if (!rightPaneGroups || rightPaneGroups.length === 0) return false
    return rightPaneGroups.every((g) =>
      g.entries.every((entry) => {
        // System and loop fields share the same format-based compat rule.
        if (entry.kind === 'loop' || entry.kind === 'system') {
          return !loopFieldMatchesControl(entry.field, controlKind)
        }
        return !isFieldBindable(controlKind, entry.field)
      }),
    )
  }, [rightPaneGroups, controlKind])

  const totalRightPaneFieldCount = useMemo(
    () => rightPaneGroups?.reduce((sum, g) => sum + g.entries.length, 0) ?? 0,
    [rightPaneGroups],
  )

  // ─── Table existence checks ────────────────────────────────────────────
  // The unscoped left pane only lists System sources. We still need to
  // know whether ANY tables exist in the system so the footer hint can
  // point authors at the loop / template workflow when relevant.
  const postTypeTables = useMemo(
    () => (meta ? meta.tables.filter((t) => t.kind === 'postType') : []),
    [meta],
  )

  const dataTables = useMemo(
    () => (meta ? meta.tables.filter((t) => t.kind === 'data') : []),
    [meta],
  )

  // ─── Handlers ──────────────────────────────────────────────────────────
  function handleTableSelect(key: string) {
    setSelectedTableKey(key)
    setFieldSearch('')
    setPendingBinding(null)
  }

  function handleMetaFieldClick(field: DataMetaField) {
    const format = deriveFormat(controlKind, field.type)
    setPendingBinding({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleLoopFieldClick(field: LoopSourceField) {
    const format = loopFieldFormat(field.format)
    setPendingBinding({
      source: 'currentEntry',
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleSystemFieldClick(source: SystemSourceId, field: LoopSourceField) {
    const format = loopFieldFormat(field.format)
    setPendingBinding({
      source,
      field: field.id,
      ...(format !== undefined ? { format } : {}),
    })
  }

  function handleConfirm() {
    if (!pendingBinding) return
    onSet(pendingBinding)
  }

  function handleClose() {
    setPendingBinding(null)
    onClose()
  }

  // ─── Render helpers ────────────────────────────────────────────────────
  const isAutoScoped = scopedTable !== null
  // Distinguish auto-scope source for the chip copy: loop-bound vs. template-page.
  const isLoopTableScope = isAutoScoped && Boolean(loopTableId) && scopedTable?.id === loopTableId
  const autoScopeChipLabel = scopedTable
    ? isLoopTableScope
      ? `Loop row — ${scopedTable.name}`
      : `Current row — ${scopedTable.name}`
    : ''

  // Selection lives in `selectedTableKey` and starts with `system:` when
  // a system source is active. We surface that to the preview pane so
  // it can render the chosen frame's current value.
  const selectedSystemSourceId: SystemSourceId | null = useMemo(() => {
    if (!selectedTableKey?.startsWith(SYSTEM_KEY_PREFIX)) return null
    const id = selectedTableKey.slice(SYSTEM_KEY_PREFIX.length) as SystemSourceId
    return SYSTEM_SOURCES.some((s) => s.id === id) ? id : null
  }, [selectedTableKey])

  // The right preview pane is meaningful when:
  //   - the picker is auto-scoped to a loop-bound table (sample rows), OR
  //   - a system source is selected (page/site/route current value).
  const showPreviewPane = isLoopTableScope || selectedSystemSourceId !== null

  // What's "focused" in the field list — the field whose value we render
  // in the preview pane. Selection wins (sticky after click); hover is a
  // transient secondary signal. Fall back to the first bindable field so
  // the preview pane is never empty when there's data to show.
  const focusedFieldId: string | null = useMemo(() => {
    if (pendingBinding?.field) return pendingBinding.field
    if (hoveredFieldId) return hoveredFieldId
    const firstGroup = rightPaneGroups?.[0]
    return firstGroup?.entries[0]?.field.id ?? null
  }, [pendingBinding, hoveredFieldId, rightPaneGroups])

  const focusedEntry = useMemo<FieldEntry | null>(() => {
    if (!focusedFieldId || !rightPaneGroups) return null
    for (const group of rightPaneGroups) {
      const found = group.entries.find((e) => e.field.id === focusedFieldId)
      if (found) return found
    }
    return null
  }, [focusedFieldId, rightPaneGroups])

  function renderFieldRow(entry: FieldEntry): React.ReactNode {
    if (entry.kind === 'meta') {
      const { field } = entry
      const FieldIcon = getFieldIcon(field.type)
      const bindable = isFieldBindable(controlKind, field)
      const tooltip = !bindable
        ? `Cannot bind a ${field.type} field to a ${control.label} control`
        : undefined
      const isSelected = pendingBinding?.field === field.id
      // Hide id pill when it's just the slugified label — redundant noise.
      const showIdPill = field.id.toLowerCase() !== field.label.toLowerCase()

      return (
        <div
          key={field.id}
          onMouseEnter={() => setHoveredFieldId(field.id)}
          onMouseLeave={() => setHoveredFieldId((curr) => (curr === field.id ? null : curr))}
        >
          <Button
            variant="ghost"
            size="md"
            fullWidth
            align="start"
            pressed={isSelected}
            disabled={!bindable}
            tooltip={tooltip}
            onClick={() => { if (bindable) handleMetaFieldClick(field) }}
            onFocus={() => setHoveredFieldId(field.id)}
            type="button"
          >
            <span className={styles.fieldRowInner}>
              <span className={styles.fieldTypeIcon}>
                {field.type === 'media' && (field.mediaKind === 'video')
                  ? <VideoSolidIcon size={12} aria-hidden="true" />
                  : <FieldIcon size={12} aria-hidden="true" />
                }
              </span>
              <span className={styles.fieldRowText}>
                <span className={styles.fieldLabel}>{field.label}</span>
              </span>
              {showIdPill && <span className={styles.fieldId}>{field.id}</span>}
            </span>
          </Button>
        </div>
      )
    }

    // System source field (page / site / route).
    // Selection match requires BOTH source + field id because the same
    // field id ('id', 'slug') exists on multiple system sources.
    if (entry.kind === 'system') {
      const { source, field } = entry
      const bindable = loopFieldMatchesControl(field, controlKind)
      const tooltip = !bindable
        ? `Cannot bind this ${source} field to a ${control.label} control`
        : undefined
      const isSelected =
        pendingBinding?.source === source && pendingBinding?.field === field.id
      const showIdPill = field.id.toLowerCase() !== field.label.toLowerCase()

      return (
        <div
          key={`${source}.${field.id}`}
          onMouseEnter={() => setHoveredFieldId(field.id)}
          onMouseLeave={() => setHoveredFieldId((curr) => (curr === field.id ? null : curr))}
        >
          <Button
            variant="ghost"
            size="md"
            fullWidth
            align="start"
            pressed={isSelected}
            disabled={!bindable}
            tooltip={tooltip}
            onClick={() => { if (bindable) handleSystemFieldClick(source, field) }}
            onFocus={() => setHoveredFieldId(field.id)}
            type="button"
          >
            <span className={styles.fieldRowInner}>
              <span className={styles.fieldTypeIcon}>
                <LoopFieldIcon format={field.format} />
              </span>
              <span className={styles.fieldRowText}>
                <span className={styles.fieldLabel}>{field.label}</span>
              </span>
              {showIdPill && <span className={styles.fieldId}>{field.id}</span>}
            </span>
          </Button>
        </div>
      )
    }

    // Loop source field
    const { field } = entry
    const bindable = loopFieldMatchesControl(field, controlKind)
    const tooltip = !bindable
      ? `Cannot bind this loop field to a ${control.label} control`
      : undefined
    const isSelected = pendingBinding?.field === field.id
    const showIdPill = field.id.toLowerCase() !== field.label.toLowerCase()

    return (
      <div
        key={field.id}
        onMouseEnter={() => setHoveredFieldId(field.id)}
        onMouseLeave={() => setHoveredFieldId((curr) => (curr === field.id ? null : curr))}
      >
        <Button
          variant="ghost"
          size="md"
          fullWidth
          align="start"
          pressed={isSelected}
          disabled={!bindable}
          tooltip={tooltip}
          onClick={() => { if (bindable) handleLoopFieldClick(field) }}
          onFocus={() => setHoveredFieldId(field.id)}
          type="button"
        >
          <span className={styles.fieldRowInner}>
            <span className={styles.fieldTypeIcon}>
              <LoopFieldIcon format={field.format} />
            </span>
            <span className={styles.fieldRowText}>
              <span className={styles.fieldLabel}>{field.label}</span>
            </span>
            {showIdPill && <span className={styles.fieldId}>{field.id}</span>}
          </span>
        </Button>
      </div>
    )
  }

  // ─── Right pane content ────────────────────────────────────────────────
  function renderRightPane() {
    if (!selectedTableKey) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState
            variant="centered"
            title="Select a source"
            description="Pick a source from the left — System for page / site / route data, or the current loop's fields when available."
          />
        </div>
      )
    }
    if (!filteredRightPaneGroups) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState variant="centered" title="Table not found." />
        </div>
      )
    }
    const noMatches = filteredRightPaneGroups.length === 0 && fieldSearch
    // Section headers add visual noise when there's only one group AND no
    // separation to convey (e.g. a single table's fields, no loop overlay).
    // Render them only when there are at least two groups to distinguish.
    const showSectionHeaders = (rightPaneGroups?.length ?? 0) > 1

    return (
      <>
        <div className={styles.fieldSearchHeader}>
          <SearchBar
            value={fieldSearch}
            onValueChange={setFieldSearch}
            placeholder="Search fields…"
            aria-label="Search fields"
          />
        </div>
        <div className={styles.fieldList}>
          {allFieldsIncompatible && (
            <p className={styles.incompatibleHint}>
              No fields in this table are compatible with this control.
            </p>
          )}
          {noMatches ? (
            <EmptyState
              variant="card"
              title={`No fields match "${fieldSearch}"`}
            />
          ) : totalRightPaneFieldCount === 0 ? (
            <EmptyState variant="card" title="No fields available" />
          ) : (
            filteredRightPaneGroups.map((group) => (
              <div key={group.label} className={styles.fieldGroup}>
                {showSectionHeaders && (
                  <div className={styles.fieldGroupHeader}>
                    <span className={styles.fieldGroupHeaderText}>{group.label}</span>
                    <span className={styles.fieldGroupHeaderCount}>
                      {group.entries.length}
                    </span>
                  </div>
                )}
                {group.entries.map(renderFieldRow)}
              </div>
            ))
          )}
        </div>
      </>
    )
  }

  // ─── Left pane content ─────────────────────────────────────────────────
  //
  // Post-type / data-table groups are intentionally NOT listed here. The
  // picker is auto-scoped (left pane hidden) when `currentEntry` has a
  // real scope (template page or in-loop with a CMS table source). With
  // no such scope, a `{ source: 'currentEntry', field }` binding against
  // any table would silently resolve to empty — so only the sources that
  // actually resolve here are System (page / site / route) and the
  // current loop's synthetic fields when present. A small footer note
  // points authors at the loop / template flow when tables exist in the
  // system but aren't reachable.
  function renderLeftPane() {
    // The unscoped left pane lists at most 4 sources (a loop scope plus
    // page/site/route). A search box would be pure UI noise — every row
    // is always on screen.
    const tablesExist = postTypeTables.length > 0 || dataTables.length > 0

    return (
      <div className={styles.tablePane}>
        <div className={styles.tableList}>
          {/* Loop scope entry — when the node is inside a loop whose
              source declared synthetic fields. Lets authors bind to the
              iteration item directly. */}
          {hasLoopScope && (
            <Button
              variant="ghost"
              size="sm"
              fullWidth
              align="start"
              pressed={selectedTableKey === LOOP_SCOPE_KEY}
              onClick={() => handleTableSelect(LOOP_SCOPE_KEY)}
              type="button"
            >
              <span className={styles.fieldRowInner}>
                <span className={styles.tableRowIcon}>
                  <BracesIcon size={12} aria-hidden="true" />
                </span>
                <span>{sourceLabel ?? 'Current loop'}</span>
              </span>
            </Button>
          )}

          {/* System sources — Page / Site / Route. Always available since
              the publisher seeds these frames on every render. */}
          {SYSTEM_SOURCES.map((source) => (
            <Button
              key={source.id}
              variant="ghost"
              size="sm"
              fullWidth
              align="start"
              pressed={selectedTableKey === systemKey(source.id)}
              onClick={() => handleTableSelect(systemKey(source.id))}
              type="button"
              tooltip={source.description}
            >
              <span className={styles.fieldRowInner}>
                <span className={styles.tableRowIcon}>
                  <BracesIcon size={12} aria-hidden="true" />
                </span>
                <span>{source.label}</span>
              </span>
            </Button>
          ))}
        </div>

        {/* Subtle footer hint pointing at the loop / template workflow
            when there are tables but the current node can't bind to
            them. Lives outside the scrolling list so it doesn't
            compete with the source rows above. */}
        {tablesExist && (
          <p className={styles.subtleHint}>
            Wrap in a Loop or open a postType template to bind to row
            fields.
          </p>
        )}
      </div>
    )
  }

  // ─── Live preview pane ─────────────────────────────────────────────────
  // Right-hand pane shown when the picker is auto-scoped to a loop's
  // bound table, OR when a system source is selected. For the loop
  // case it renders the focused field's value across up to 3 sample
  // rows; for the system case it renders the focused field's current
  // value from the page/site/route frame.
  function renderPreviewPane() {
    // ── System source preview: render the current frame value ────────
    if (selectedSystemSourceId) {
      // Build the chosen frame from the in-memory site state. Anonymous
      // visitor preview for `viewer` until we surface the current admin
      const frame: Record<string, unknown> | null = (() => {
        if (selectedSystemSourceId === 'page') {
          return activePageForFrame
            ? (buildPageFrame(activePageForFrame) as unknown as Record<string, unknown>)
            : null
        }
        if (selectedSystemSourceId === 'site') {
          return activeSite
            ? (buildSiteFrame(activeSite) as unknown as Record<string, unknown>)
            : null
        }
        if (selectedSystemSourceId === 'route') {
          return activePageForFrame
            ? (buildRouteFrame(buildPageFrame(activePageForFrame).permalink) as unknown as Record<string, unknown>)
            : null
        }
        return null
      })()

      if (!focusedEntry) {
        return (
          <div className={styles.previewPane}>
            <div className={styles.previewEmpty}>
              <EmptyState
                variant="centered"
                title="Hover a field"
                description="Pick a field on the left to see its current value."
              />
            </div>
          </div>
        )
      }

      const fieldId = focusedEntry.field.id
      const fieldLabel = focusedEntry.field.label

      return (
        <div className={styles.previewPane}>
          <div className={styles.previewHeader}>
            <span className={styles.previewHeaderLabel}>Current value</span>
            <span className={styles.previewHeaderField}>{fieldLabel}</span>
          </div>
          <div className={styles.previewBody}>
            <div className={styles.previewRow}>
              <div className={styles.previewRowMeta}>
                <span className={styles.previewRowIndex}>{selectedSystemSourceId}</span>
                <span className={styles.previewRowId}>{fieldId}</span>
              </div>
              <div className={styles.previewRowValue}>
                {frame ? formatPreviewValue(frame[fieldId]) : '—'}
              </div>
            </div>
          </div>
        </div>
      )
    }

    // ── Loop preview: real published rows ────────────────────────────
    if (previewLoading && previewItems.length === 0) {
      return (
        <div className={styles.previewPane}>
          <SkeletonBlock minHeight={140} ariaLabel="Loading sample rows" />
        </div>
      )
    }

    if (previewItems.length === 0) {
      return (
        <div className={styles.previewPane}>
          <div className={styles.previewEmpty}>
            <EmptyState
              variant="centered"
              title="No rows yet"
              description={`Add a row to ${scopedTable?.name ?? 'this table'} to preview real values.`}
            />
          </div>
        </div>
      )
    }

    if (!focusedEntry) {
      return (
        <div className={styles.previewPane}>
          <div className={styles.previewEmpty}>
            <EmptyState
              variant="centered"
              title="Hover a field"
              description="The right pane previews real values from your first rows."
            />
          </div>
        </div>
      )
    }

    const fieldId = focusedEntry.field.id
    const fieldLabel = focusedEntry.field.label

    return (
      <div className={styles.previewPane}>
        <div className={styles.previewHeader}>
          <span className={styles.previewHeaderLabel}>Preview</span>
          <span className={styles.previewHeaderField}>{fieldLabel}</span>
        </div>
        <div className={styles.previewBody}>
          {previewItems.map((item, idx) => (
            <div key={item.id} className={styles.previewRow}>
              <div className={styles.previewRowMeta}>
                <span className={styles.previewRowIndex}>Row {idx + 1}</span>
                <span className={styles.previewRowId}>#{item.id.slice(0, 8)}</span>
              </div>
              <div className={styles.previewRowValue}>
                {formatPreviewValue(item.fields[fieldId])}
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ─── Dialog body ───────────────────────────────────────────────────────
  function renderBody() {
    if (metaLoading) {
      return <SkeletonBlock minHeight={200} ariaLabel="Loading data tables" />
    }
    if (metaError) {
      return (
        <div className={styles.pickerEmptyWrapper}>
          <EmptyState variant="centered" title="Could not load tables" description={metaError} />
        </div>
      )
    }

    // Layout selection:
    //   - Loop-bound (showPreviewPane): two panes — fields | live preview.
    //   - Other auto-scoped (template page): single pane, no preview pane
    //     because there's no specific row to preview against here.
    //   - Default: two panes — table list | fields.
    const layoutClass = showPreviewPane
      ? styles.fieldsAndPreview
      : isAutoScoped
        ? styles.singlePane
        : styles.twoPanes

    return (
      <>
        {/* Auto-scope chip — shown whenever the left pane is hidden */}
        {isAutoScoped && scopedTable && (
          <div className={styles.scopeChip} aria-label={`Scoped to ${scopedTable.name}`}>
            <span className={styles.scopeChipDot} aria-hidden="true" />
            {autoScopeChipLabel}
          </div>
        )}

        <div className={layoutClass}>
          {!isAutoScoped && renderLeftPane()}
          <div className={styles.fieldPane}>
            {renderRightPane()}
          </div>
          {showPreviewPane && renderPreviewPane()}
        </div>
      </>
    )
  }

  const dialogTitle = insertMode ? `Insert into "${label}"` : `Bind "${label}"`
  const confirmLabel = insertMode ? 'Insert' : 'Confirm'

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title={dialogTitle}
      // Width by layout:
      //  - Two-pane with preview (loop-bound) → xl, full 640px.
      //  - Two-pane default (table list + fields) → xl.
      //  - Single-pane (template-page auto-scope) → md, 440px.
      size={isAutoScoped && !showPreviewPane ? 'md' : 'xl'}
      bodyClassName={styles.dialogBody}
      footer={
        <>
          <Button variant="ghost" size="sm" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={handleConfirm}
            disabled={!pendingBinding}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {renderBody()}
    </Dialog>
  )
}
