/**
 * MediaLibraryControl — the property-panel control for `<img>` and `<video>`
 * `src` props. Two modes:
 *
 *   1. Library — click "Browse library…" to open the WordPress-style
 *      `MediaPickerModal` (a fullscreen Media-page modal). The control
 *      surface itself only renders a tiny preview of the currently picked
 *      asset + filename. No inline grid, no inline upload — those live
 *      inside the modal.
 *
 *   2. URL — manual entry for external assets (CDN, third-party hosts).
 *      Plain `<Input type="url">` with a small inline preview.
 *
 * The sidebar property panel is ~280 px wide; cramming a full grid in here
 * is what made the previous picker unreadable. By delegating to the modal
 * we get the same wide canvas, folder tree, sort, and clear "selected"
 * affordance as the standalone Media page.
 */
import { Suspense, lazy, useEffect, useMemo, useState } from 'react'
import {
  listCmsMediaAssets,
  type CmsMediaAsset,
} from '@core/persistence/cmsMedia'
import { isValidImageUrl } from '@core/utils/urlValidation'
import type { ControlProps } from './shared'
import { ControlRow } from './ControlRow'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { ImagesSolidIcon } from 'pixel-art-icons/icons/images-solid'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { blurHashToDataUrl, pickVariantUrl } from '@admin/pages/media/utils/variants'
import styles from './controls.module.css'

// Lazy-load the modal so the entire MediaPage stack (folders / canvas /
// viewer / upload queue) doesn't ship in the eager admin-layouts chunk.
// The control surface itself is tiny — a thumbnail + a "Browse" button —
// so paying the modal's ~10 KB price only on first click is the right
// trade-off. Also lets the `layouts-*.js` bundle-size budget stay tight.
const MediaPickerModal = lazy(() =>
  import('@admin/pages/media/components/MediaPickerModal/MediaPickerModal').then(
    (m) => ({ default: m.MediaPickerModal }),
  ),
)

type MediaKind = 'image' | 'video'
type MediaMode = 'library' | 'url'

interface MediaLibraryControlProps extends ControlProps<string> {
  mediaKind: MediaKind
}

const MEDIA_SOURCE_OPTIONS = [
  { value: 'library', label: 'Library', ariaLabel: 'Media library' },
  { value: 'url', label: 'URL', ariaLabel: 'Custom URL' },
] satisfies ReadonlyArray<{ value: MediaMode; label: string; ariaLabel: string }>

function isLocalMediaPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false
  for (const char of value) {
    const code = char.charCodeAt(0)
    if (char === '\\' || code <= 31) return false
  }
  return true
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

function isValidMediaUrl(value: string, mediaKind: MediaKind): boolean {
  if (!value) return true
  if (isLocalMediaPath(value)) return true
  if (mediaKind === 'image') return isValidImageUrl(value)
  return isHttpUrl(value)
}

function startsInUrlMode(value: string): boolean {
  return Boolean(value) && !value.startsWith('/uploads/')
}

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return ''
  if (sizeBytes < 1024) return `${sizeBytes} B`
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 102.4) / 10} KB`
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`
}

export function MediaLibraryControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
  layout,
  mediaKind,
}: MediaLibraryControlProps) {
  const currentValue = String(value ?? '')
  const [mode, setMode] = useState<MediaMode>(() => startsInUrlMode(currentValue) ? 'url' : 'library')
  const [pickerOpen, setPickerOpen] = useState(false)
  // We still fetch the asset list ONCE on mount so the "currently picked"
  // preview can show the right thumbnail + blurhash for the field's
  // saved publicPath. The modal mounts its own workspace when opened —
  // not used here.
  const [cmsAssets, setCmsAssets] = useState<CmsMediaAsset[]>([])
  const [libraryError, setLibraryError] = useState('')
  const [urlDraftState, setUrlDraftState] = useState(() => ({
    sourceValue: currentValue,
    draft: currentValue,
  }))

  useEffect(() => {
    let cancelled = false
    listCmsMediaAssets()
      .then((nextAssets) => {
        if (!cancelled) setCmsAssets(nextAssets)
      })
      .catch((err) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Unable to load media library'
          setLibraryError(message === 'Unauthorized' ? 'Sign in again to use CMS media.' : message)
        }
      })
    return () => { cancelled = true }
  }, [])

  const modeLabel = mediaKind === 'image' ? 'image' : 'video'
  const validCurrentValue = isValidMediaUrl(currentValue, mediaKind)
  const currentAsset = useMemo(
    () => cmsAssets.find((asset) => asset.publicPath === currentValue) ?? null,
    [cmsAssets, currentValue],
  )
  const showUrlPreview = validCurrentValue && currentValue
  const urlDraft = urlDraftState.sourceValue === currentValue ? urlDraftState.draft : currentValue
  const urlError = !isValidMediaUrl(urlDraft, mediaKind)

  function handleUrlChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value
    const valid = isValidMediaUrl(nextValue, mediaKind)
    setUrlDraftState({ sourceValue: currentValue, draft: nextValue })
    if (valid) onChange(propKey, nextValue)
  }

  function handlePickFromModal(asset: CmsMediaAsset) {
    // Keep the local asset cache up to date so the "currently picked"
    // preview can render the right thumb without re-fetching.
    setCmsAssets((current) => {
      if (current.some((a) => a.id === asset.id)) return current
      return [asset, ...current]
    })
    onChange(propKey, asset.publicPath)
  }

  function handleClear() {
    onChange(propKey, '')
  }

  return (
    <ControlRow
      propKey={propKey}
      label={label}
      inputId={`ctrl-${propKey}`}
      layout={layout}
      isOverride={isOverride}
      disabled={disabled}
      labelSuffix={mode === 'url' && urlError ? (
        <span className={styles.labelError} role="alert">
          Invalid {modeLabel} URL
        </span>
      ) : undefined}
    >
      <div className={styles.mediaPicker}>
        <SegmentedControl<MediaMode>
          value={mode}
          options={MEDIA_SOURCE_OPTIONS}
          onChange={setMode}
          size="sm"
          fullWidth
          disabled={disabled}
          aria-label={`${label ?? propKey} source`}
        />

        {mode === 'library' ? (
          <div className={styles.mediaLibraryBody}>
            <CurrentPickedTile
              asset={currentAsset}
              mediaKind={mediaKind}
              currentValue={currentValue}
            />
            <div className={styles.mediaPickerActions}>
              <Button
                variant="secondary"
                size="sm"
                disabled={disabled}
                onClick={() => setPickerOpen(true)}
                aria-label={`Browse ${modeLabel} library`}
              >
                <ImagesSolidIcon size={13} />
                <span>{currentAsset ? `Change ${modeLabel}` : `Browse library…`}</span>
              </Button>
              {currentValue && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={handleClear}
                  aria-label={`Clear ${modeLabel}`}
                >
                  Clear
                </Button>
              )}
            </div>
            {libraryError && (
              <p className={styles.mediaStatus} role="alert">{libraryError}</p>
            )}
          </div>
        ) : (
          <div className={styles.mediaUrlBody}>
            {showUrlPreview && mediaKind === 'image' && (
              <div className={styles.imagePreview}>
                <img
                  src={currentValue}
                  alt="preview"
                  className={styles.imagePreviewImg}
                  onError={(event) => {
                    ;(event.target as HTMLImageElement).style.display = 'none'
                  }}
                />
              </div>
            )}
            {showUrlPreview && mediaKind === 'video' && (
              <div className={styles.videoPreview} aria-hidden="true">
                <VideoSolidIcon size={16} />
                <span>{currentValue}</span>
              </div>
            )}
            <Input
              id={`ctrl-${propKey}`}
              type="url"
              value={urlDraft}
              placeholder={mediaKind === 'image' ? 'https://example.com/image.png' : 'https://example.com/video.mp4'}
              disabled={disabled}
              onChange={handleUrlChange}
              invalid={urlError}
            />
          </div>
        )}
      </div>

      {pickerOpen && (
        <Suspense fallback={null}>
          <MediaPickerModal
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            mediaKind={mediaKind}
            currentValue={currentValue}
            onPick={handlePickFromModal}
          />
        </Suspense>
      )}
    </ControlRow>
  )
}

interface CurrentPickedTileProps {
  asset: CmsMediaAsset | null
  mediaKind: MediaKind
  currentValue: string
}

function CurrentPickedTile({ asset, mediaKind, currentValue }: CurrentPickedTileProps) {
  // The "currently picked" affordance gets a proper thumbnail + filename so
  // the user can never guess what's saved on the field. Three states:
  //   1. asset matched in the library → real thumb + blurhash bg
  //   2. publicPath set but library hasn't matched yet (loading / stale) →
  //      filename derived from the path
  //   3. nothing saved → empty hint
  if (!asset && !currentValue) {
    return (
      <div className={styles.mediaCurrentEmpty}>
        <span className={styles.mediaCurrentEmptyIcon} aria-hidden="true">
          {mediaKind === 'image' ? <ImagesSolidIcon size={18} /> : <VideoSolidIcon size={18} />}
        </span>
        <span>No {mediaKind} selected</span>
      </div>
    )
  }

  if (!asset) {
    // We have a saved URL but no matched asset (probably a /uploads/ path
    // that got deleted, or the library is still loading).
    const filename = currentValue.split('/').pop() ?? currentValue
    return (
      <div className={styles.mediaCurrent}>
        <span className={styles.mediaCurrentThumb} aria-hidden="true">
          {mediaKind === 'image' ? <ImagesSolidIcon size={18} /> : <VideoSolidIcon size={18} />}
        </span>
        <span className={styles.mediaCurrentMeta}>
          <span className={styles.mediaCurrentName}>{filename}</span>
          <span className={styles.mediaCurrentSub}>Saved path</span>
        </span>
      </div>
    )
  }

  const thumbUrl = mediaKind === 'image' ? pickVariantUrl(asset, 48) : null
  const blurUrl = mediaKind === 'image' ? blurHashToDataUrl(asset.blurHash) : null
  const thumbStyle = blurUrl
    ? ({ backgroundImage: `url(${blurUrl})`, backgroundSize: 'cover' } as React.CSSProperties)
    : undefined
  // Surface the library's saved alt-text + dimensions so the author can
  // see what will be published (and decide whether to override via the
  // sibling Alt text field). Image modules ship the library alt as a
  // render-time fallback — see `_resolvedMediaByKey.src.altText` in the
  // Image module's render().
  const libraryAlt = asset.altText.trim()
  const dimensions = asset.width && asset.height ? `${asset.width} × ${asset.height}` : null
  const subParts = [
    asset.mimeType,
    formatBytes(asset.sizeBytes),
    dimensions,
  ].filter(Boolean).join(' · ')

  return (
    <div className={styles.mediaCurrent}>
      <span className={styles.mediaCurrentThumb} aria-hidden="true" style={thumbStyle}>
        {mediaKind === 'image' && thumbUrl ? (
          <img src={thumbUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <VideoSolidIcon size={18} />
        )}
      </span>
      <span className={styles.mediaCurrentMeta}>
        <span className={styles.mediaCurrentName}>{asset.filename}</span>
        {subParts && <span className={styles.mediaCurrentSub}>{subParts}</span>}
        {mediaKind === 'image' && (
          <span className={styles.mediaCurrentAlt}>
            {libraryAlt ? (
              <>
                <strong>Library alt:</strong> {libraryAlt}
              </>
            ) : (
              <em>No library alt text — edit the asset in Media to add one.</em>
            )}
          </span>
        )}
      </span>
    </div>
  )
}
