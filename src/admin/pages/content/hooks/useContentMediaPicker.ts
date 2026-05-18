import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  listCmsMediaAssets,
  type CmsMediaAsset,
} from '@core/persistence'
import { createMediaBlock } from '@core/markdown/blockModel'
import type { ContentBlock } from '@core/markdown/blockModel'
import { readFeaturedMediaCell } from '@core/data/cells'
import type { DataRow } from '@core/data/schemas'
import { mediaTypeFromAsset } from '@content/utils/contentEntryUtils'

export type MediaPickerKind = 'media' | 'featured'

export interface MediaPickerState {
  kind: MediaPickerKind
  targetBlockId?: string
}

interface UseContentMediaPickerOptions {
  featuredMediaId: string | null
  setFeaturedMediaId: (mediaId: string | null) => void
  setBlocks: (updater: (blocks: ContentBlock[]) => ContentBlock[]) => void
  /**
   * Entries currently shown in the sidebar list. Any entry with a non-null
   * `featuredMedia` cell triggers the asset list to load so the explorer can
   * render the featured image as a row thumbnail.
   */
  entries: readonly DataRow[]
}

/**
 * Coordinates the content-page media picker. The picker UI itself is the
 * full WordPress-style `MediaPickerModal` (folder tree + canvas grid + upload
 * queue) — this hook owns only the open/close state and the post-pick
 * routing (set featured media vs insert/replace a body block).
 *
 * We still fetch the CMS media list locally so the right-rail settings panel
 * can render the picked featured media (thumbnail + filename). The modal
 * mounts its own workspace when opened, so it doesn't share this asset list.
 */
export function useContentMediaPicker({
  featuredMediaId,
  setFeaturedMediaId,
  setBlocks,
  entries,
}: UseContentMediaPickerOptions) {
  const [mediaAssets, setMediaAssets] = useState<CmsMediaAsset[]>([])
  const [mediaAssetsLoaded, setMediaAssetsLoaded] = useState(false)
  const [mediaError, setMediaError] = useState<string | null>(null)
  const [mediaPicker, setMediaPicker] = useState<MediaPickerState | null>(null)

  const assetsById = useMemo(() => {
    const map = new Map<string, CmsMediaAsset>()
    for (const asset of mediaAssets) map.set(asset.id, asset)
    return map
  }, [mediaAssets])

  const featuredMediaAsset = featuredMediaId ? assetsById.get(featuredMediaId) ?? null : null

  // True when at least one shown entry references a featured media asset, so
  // the explorer list can render a thumbnail. Combined with the active entry's
  // own `featuredMediaId` so the right-rail preview also triggers a load.
  const needsAssetList = featuredMediaId !== null
    || entries.some((entry) => readFeaturedMediaCell(entry.cells) !== null)

  // Fetch the asset list once the page actually needs to resolve a featured
  // media reference — either for the right-rail preview of the selected entry
  // or for thumbnails in the sidebar list. The picker modal mounts its own
  // workspace, so we don't need to eagerly load assets just to open the picker.
  useEffect(() => {
    if (!needsAssetList || mediaAssetsLoaded) return
    let cancelled = false
    listCmsMediaAssets()
      .then((assets) => {
        if (!cancelled) {
          setMediaAssets(assets)
          setMediaError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : 'Could not load media'
          setMediaError(message)
          console.error('[ContentPage] load media list error:', err)
        }
      })
      .finally(() => {
        if (!cancelled) setMediaAssetsLoaded(true)
      })
    return () => { cancelled = true }
  }, [needsAssetList, mediaAssetsLoaded])

  const getFeaturedMediaAssetForEntry = useCallback(
    (entry: DataRow): CmsMediaAsset | null => {
      const mediaId = readFeaturedMediaCell(entry.cells)
      if (!mediaId) return null
      return assetsById.get(mediaId) ?? null
    },
    [assetsById],
  )

  const openMediaPicker = useCallback((kind: MediaPickerKind, targetBlockId?: string) => {
    setMediaPicker({ kind, targetBlockId })
  }, [])

  const closeMediaPicker = useCallback(() => {
    setMediaPicker(null)
  }, [])

  const pickMedia = useCallback((asset: CmsMediaAsset) => {
    if (!mediaPicker) return

    // Keep the local asset cache in sync so the featured-media preview can
    // render the freshly picked asset's thumbnail without re-fetching the
    // whole list.
    setMediaAssets((current) => {
      if (current.some((a) => a.id === asset.id)) return current
      return [asset, ...current]
    })

    if (mediaPicker.kind === 'featured') {
      setFeaturedMediaId(asset.id)
      setMediaPicker(null)
      return
    }

    const mediaType = mediaTypeFromAsset(asset)
    setBlocks((current) => {
      if (!mediaPicker.targetBlockId) {
        return [
          ...current,
          createMediaBlock(asset.publicPath, mediaType, mediaType === 'image' ? asset.filename : ''),
        ]
      }

      return current.map((block) => {
        if (block.id !== mediaPicker.targetBlockId) return block
        return {
          id: block.id,
          type: 'media',
          mediaType,
          src: asset.publicPath,
          alt: mediaType === 'image' ? asset.filename : '',
        }
      })
    })
    setMediaPicker(null)
  }, [mediaPicker, setBlocks, setFeaturedMediaId])

  return {
    mediaError,
    mediaPicker,
    featuredMediaAsset,
    getFeaturedMediaAssetForEntry,
    openMediaPicker,
    closeMediaPicker,
    pickMedia,
  }
}
