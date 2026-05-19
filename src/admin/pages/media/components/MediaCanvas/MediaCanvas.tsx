/**
 * MediaCanvas — the central file grid / list for the Media workspace.
 *
 * Owns the filter bar (search / type / view-mode), the asset grid, and the
 * empty / loading / error states. Bulk-select, drag-out, and keyboard
 * navigation land in M3/M4 — this component is the first interactive surface.
 */
import {
  useCallback,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { Button } from '@ui/components/Button'
import { EmptyState } from '@ui/components/EmptyState'
import { FileUpload } from '@ui/components/FileUpload'
import { FilterBar, type FilterBarItem } from '@ui/components/FilterBar'
import { Select } from '@ui/components/Select'
import {
  ExplorerItemContextMenu,
  ExplorerRenameDialog,
  type ExplorerContextMenuItem,
} from '@site/explorer-actions'
import { BulletlistSolidIcon } from 'pixel-art-icons/icons/bulletlist-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import { Copy2SolidIcon } from 'pixel-art-icons/icons/copy-2-solid'
import { Grid2x22SolidIcon } from 'pixel-art-icons/icons/grid-2x2-2-solid'
import { Image2SolidIcon } from 'pixel-art-icons/icons/image-2-solid'
import { FolderGlyphIcon } from 'pixel-art-icons/icons/folder-glyph'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { cn } from '@ui/cn'
// Reuse the editor's canvas surface so the Media page matches Site / Content:
// rounded top-left, `--editor-surface-2` background. Keeps the look consistent.
import canvasStyles from '@site/canvas/CanvasRoot.module.css'
import type { CmsMediaAsset } from '@core/persistence/cmsMedia'
import type { MediaSort, MediaType } from '../../utils/filters'
import { bucketForMime } from '../../utils/filters'
import { blurHashToDataUrl, pickVariantUrl } from '../../utils/variants'
import {
  FOLDER_TRASH,
  type UseMediaWorkspaceResult,
} from '../../hooks/useMediaWorkspace'
import styles from './MediaCanvas.module.css'

interface MediaCanvasProps {
  workspace: UseMediaWorkspaceResult
}

type ViewMode = 'list' | 'grid'

const VIEW_MODE_STORAGE_KEY = 'pb-media-page-view-mode'

function readStoredViewMode(): ViewMode {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_MODE_STORAGE_KEY)
    return raw === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

function writeStoredViewMode(mode: ViewMode) {
  try {
    globalThis.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // best-effort UI persistence
  }
}

const TYPE_FILTERS: FilterBarItem<MediaType>[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'video', label: 'Videos' },
  { value: 'other', label: 'Other' },
]

const SORT_OPTIONS: Array<{ value: MediaSort; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'largest', label: 'Largest' },
  { value: 'smallest', label: 'Smallest' },
  { value: 'name-asc', label: 'Name A→Z' },
  { value: 'name-desc', label: 'Name Z→A' },
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function keyboardMenuPosition(element: HTMLElement) {
  const rect = element.getBoundingClientRect()
  return {
    x: rect.left + Math.min(rect.width - 8, 24),
    y: rect.top + Math.min(rect.height - 8, 24),
  }
}

interface ContextMenuState {
  x: number
  y: number
  asset: CmsMediaAsset
}

function isMacLike(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
}

export function MediaCanvas({ workspace }: MediaCanvasProps) {
  const [viewMode, setViewModeState] = useState<ViewMode>(readStoredViewMode)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renameTarget, setRenameTarget] = useState<CmsMediaAsset | null>(null)
  const [dragActive, setDragActive] = useState(false)

  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeState(mode)
    writeStoredViewMode(mode)
  }, [])

  const trashView = workspace.folderSelection === FOLDER_TRASH

  // Modifier-aware click dispatch:
  //   - plain click → set primary selection (collapses to one)
  //   - Cmd/Ctrl-click → toggle in/out of the multi-selection
  //   - Shift-click → range-select between the current primary and this row
  // Mirrors the convention every grid-style file manager (Finder, Explorer,
  // Photos, Drive, …) uses, so the muscle memory is free.
  const handleAssetClick = useCallback((asset: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) => {
    const meta = isMacLike() ? event.metaKey : event.ctrlKey
    if (event.shiftKey && workspace.selectedAssetId) {
      event.preventDefault()
      workspace.selectRange(workspace.selectedAssetId, asset.id)
      return
    }
    if (meta) {
      event.preventDefault()
      workspace.toggleAssetInSelection(asset.id)
      return
    }
    workspace.setSelectedAssetId(asset.id)
  }, [workspace])

  const handleUpload = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (files.length === 0) return
    await workspace.uploadFiles(files)
  }, [workspace])

  const handleDrop = useCallback(async (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDragActive(false)
    if (trashView) return
    const files = Array.from(event.dataTransfer.files ?? [])
    if (files.length === 0) return
    await workspace.uploadFiles(files)
  }, [workspace, trashView])

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (trashView) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    setDragActive(true)
  }
  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (trashView) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
  }
  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget === event.target) setDragActive(false)
  }

  function openContextMenu(asset: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ asset, x: event.clientX, y: event.clientY })
  }

  function openKeyboardContextMenu(asset: CmsMediaAsset, event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ asset, ...keyboardMenuPosition(event.currentTarget) })
  }

  async function copyAssetUrl(asset: CmsMediaAsset) {
    setContextMenu(null)
    if (!navigator.clipboard?.writeText) {
      console.warn('[MediaCanvas] clipboard unavailable; cannot copy URL')
      return
    }
    try {
      await navigator.clipboard.writeText(asset.publicPath)
    } catch (err) {
      console.error('[MediaCanvas] copy URL failed:', err)
    }
  }

  function buildExtraMenuItems(asset: CmsMediaAsset): ExplorerContextMenuItem[] {
    const items: ExplorerContextMenuItem[] = [
      {
        label: 'Copy URL',
        action: () => { void copyAssetUrl(asset) },
        icon: <Copy2SolidIcon size={13} />,
      },
    ]
    if (trashView) {
      items.unshift({
        label: 'Restore',
        action: () => {
          setContextMenu(null)
          void workspace.restoreAsset(asset.id)
        },
        icon: <CheckIcon size={13} />,
      })
    }
    return items
  }

  const visibleAssets = workspace.visibleAssets
  const showingTotal = workspace.assets.length
  const showingMatching = visibleAssets.length

  // The big EmptyState below carries the message whenever `showingMatching === 0`,
  // so the status bar only narrates the non-empty cases (count, loading, error).
  // Anything else would render two empty-state messages on top of each other.
  const headerLabel = useMemo(() => {
    if (workspace.loading) return 'Loading…'
    if (workspace.error) return workspace.error
    if (showingMatching === 0) return null
    return `${showingMatching} ${showingMatching === 1 ? 'item' : 'items'}`
  }, [workspace.loading, workspace.error, showingMatching])

  return (
    <section
      className={cn(canvasStyles.canvas, styles.canvas, dragActive && styles.canvasDropping)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={(e) => void handleDrop(e)}
      aria-label="Media library"
      data-testid="media-canvas"
    >
      <header className={styles.toolbar}>
        <FilterBar<MediaType>
          items={TYPE_FILTERS}
          value={workspace.filters.type}
          onValueChange={workspace.setFilterType}
          search={{
            value: workspace.filters.q,
            onValueChange: workspace.setQuery,
            onClear: () => workspace.setQuery(''),
            placeholder: 'Search media',
            ariaLabel: 'Search media',
          }}
          groupLabel="Filter media type"
          trailing={(
            <div role="group" aria-label="Media view" className={styles.viewGroup}>
              <SortMenu
                value={workspace.filters.sort}
                onChange={workspace.setSort}
              />
              <Button
                variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                size="xs"
                iconOnly
                pressed={viewMode === 'list'}
                tooltip="List view"
                aria-label="List view"
                onClick={() => setViewMode('list')}
              >
                <BulletlistSolidIcon size={13} />
              </Button>
              <Button
                variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                size="xs"
                iconOnly
                pressed={viewMode === 'grid'}
                tooltip="Grid view"
                aria-label="Grid view"
                onClick={() => setViewMode('grid')}
              >
                <Grid2x22SolidIcon size={13} />
              </Button>
            </div>
          )}
          inlineActions={!trashView && (
            <FileUpload
              multiple
              onChange={(e) => void handleUpload(e)}
              buttonProps={{
                variant: 'primary',
                size: 'sm',
                'aria-label': 'Upload media',
              }}
            >
              <UploadIcon size={13} />
              <span>Upload</span>
            </FileUpload>
          )}
        />
      </header>

      {headerLabel !== null && (
        <div className={styles.statusBar} role="status" aria-live="polite">
          {headerLabel}
        </div>
      )}

      <div className={styles.body}>
        {showingMatching === 0 ? (
          <EmptyState
            variant="centered"
            icon={<ImagesSolidIcon size={28} />}
            title={
              trashView
                ? 'Trash is empty'
                : showingTotal > 0
                  ? 'No matching media'
                  : 'No media yet'
            }
            description={
              trashView
                ? 'Soft-deleted assets show up here.'
                : showingTotal > 0
                  ? 'Try a different search or filter.'
                  : 'Drag files into this window or click Upload.'
            }
          />
        ) : viewMode === 'grid' ? (
          <ul className={styles.grid} role="list" data-testid="media-grid">
            {visibleAssets.map((asset) => (
              <AssetTile
                key={asset.id}
                asset={asset}
                selected={workspace.selectedAssetIds.has(asset.id)}
                onSelect={(event) => handleAssetClick(asset, event)}
                onContextMenu={openContextMenu}
                onKeyboardMenu={openKeyboardContextMenu}
              />
            ))}
          </ul>
        ) : (
          <ul className={styles.list} role="list" data-testid="media-list">
            {visibleAssets.map((asset) => (
              <AssetRow
                key={asset.id}
                asset={asset}
                selected={workspace.selectedAssetIds.has(asset.id)}
                onSelect={(event) => handleAssetClick(asset, event)}
                onContextMenu={openContextMenu}
                onKeyboardMenu={openKeyboardContextMenu}
              />
            ))}
          </ul>
        )}
      </div>

      {contextMenu && (
        <ExplorerItemContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          ariaLabel="Media item options"
          onClose={() => setContextMenu(null)}
          onRename={() => {
            setRenameTarget(contextMenu.asset)
            setContextMenu(null)
          }}
          onDelete={() => {
            const target = contextMenu.asset
            setContextMenu(null)
            if (trashView) void workspace.purgeAsset(target.id)
            else void workspace.trashAsset(target.id)
          }}
          extraItems={buildExtraMenuItems(contextMenu.asset)}
        />
      )}

      {renameTarget && (
        <ExplorerRenameDialog
          title="Rename media"
          fieldLabel="Name"
          initialValue={renameTarget.filename}
          onCancel={() => setRenameTarget(null)}
          onRename={async (payload) => {
            await workspace.renameAsset(renameTarget.id, payload.value)
            setRenameTarget(null)
          }}
        />
      )}
    </section>
  )
}

interface AssetItemProps {
  asset: CmsMediaAsset
  selected: boolean
  onSelect: (event: MouseEvent<HTMLButtonElement>) => void
  onContextMenu: (asset: CmsMediaAsset, event: MouseEvent<HTMLButtonElement>) => void
  onKeyboardMenu: (asset: CmsMediaAsset, event: KeyboardEvent<HTMLButtonElement>) => void
}

// Target widths (CSS px) for the two view modes. Picked so a 1× display
// fetches the next-bigger variant (w320 for grid tiles, w64 for the list
// row's 24-px preview). DPR-aware picking happens inside pickVariantUrl.
const TILE_CSS_WIDTH = 140
const ROW_CSS_WIDTH = 24

function AssetTile({ asset, selected, onSelect, onContextMenu, onKeyboardMenu }: AssetItemProps) {
  const bucket = bucketForMime(asset.mimeType)
  // Variant + blurhash bg only meaningful for images. Videos stream from
  // the original; non-media types render a glyph.
  const thumbUrl = bucket === 'image' ? pickVariantUrl(asset, TILE_CSS_WIDTH) : null
  const blurUrl = bucket === 'image' ? blurHashToDataUrl(asset.blurHash) : null
  const previewStyle = blurUrl
    ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as React.CSSProperties)
    : undefined
  return (
    <li className={styles.tileItem}>
      <Button
        variant="ghost"
        size="sm"
        pressed={selected}
        aria-label={`Open ${asset.filename}`}
        className={cn(styles.tile, selected && styles.tileSelected)}
        onClick={(event) => onSelect(event)}
        onContextMenu={(e) => onContextMenu(asset, e)}
        onKeyDown={(e) => onKeyboardMenu(asset, e)}
      >
        <span className={styles.tilePreview} aria-hidden="true" style={previewStyle}>
          {bucket === 'image' && thumbUrl ? (
            <img src={thumbUrl} alt="" className={styles.tileImage} loading="lazy" decoding="async" />
          ) : bucket === 'video' ? (
            <video src={asset.publicPath} preload="metadata" muted className={styles.tileVideo} />
          ) : (
            <FolderGlyphIcon size={28} />
          )}
        </span>
        <span className={styles.tileBody}>
          <span className={styles.tileLabel}>{asset.filename}</span>
          <span className={styles.tileMeta}>{formatBytes(asset.sizeBytes)}</span>
        </span>
      </Button>
    </li>
  )
}

function AssetRow({ asset, selected, onSelect, onContextMenu, onKeyboardMenu }: AssetItemProps) {
  const bucket = bucketForMime(asset.mimeType)
  const thumbUrl = bucket === 'image' ? pickVariantUrl(asset, ROW_CSS_WIDTH) : null
  const blurUrl = bucket === 'image' ? blurHashToDataUrl(asset.blurHash) : null
  const previewStyle = blurUrl
    ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as React.CSSProperties)
    : undefined
  return (
    <li className={styles.rowItem}>
      <Button
        variant="ghost"
        size="sm"
        pressed={selected}
        aria-label={`Open ${asset.filename}`}
        className={cn(styles.row, selected && styles.rowSelected)}
        onClick={(event) => onSelect(event)}
        onContextMenu={(e) => onContextMenu(asset, e)}
        onKeyDown={(e) => onKeyboardMenu(asset, e)}
      >
        <span className={styles.rowPreview} aria-hidden="true" style={previewStyle}>
          {bucket === 'image' && thumbUrl ? (
            <img src={thumbUrl} alt="" className={styles.rowImage} loading="lazy" decoding="async" />
          ) : bucket === 'video' ? (
            <VideoSolidIcon size={13} />
          ) : (
            <Image2SolidIcon size={13} />
          )}
        </span>
        <span className={styles.rowLabel}>{asset.filename}</span>
        <span className={styles.rowMeta}>{formatBytes(asset.sizeBytes)}</span>
      </Button>
    </li>
  )
}

interface SortMenuProps {
  value: MediaSort
  onChange: (next: MediaSort) => void
}

function SortMenu({ value, onChange }: SortMenuProps) {
  return (
    <Select
      aria-label="Sort media"
      fieldSize="xs"
      value={value}
      onChange={(event) => onChange(event.target.value as MediaSort)}
      options={SORT_OPTIONS.map((option) => ({
        value: option.value,
        label: `Sort ${option.label}`,
        textValue: option.label,
      }))}
    />
  )
}
