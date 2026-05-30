/**
 * Media provider — live media file search via /admin/api/cms/media.
 *
 * SERVER provider, 150 ms debounce.
 *
 * Searches by filename and title (JS-side filter in the handler since media
 * libraries are small — see listMediaAssets comment in the repository).
 * Each result navigates to /admin/media with the file pre-selected.
 */

import type { SpotlightProvider, Command } from '../types'
import { apiRequest, isAbortError } from '@core/http'
import type { Static } from '@core/utils/typeboxHelpers'
import { MediaListResponseSchema } from './schemas'

const ENDPOINT = '/admin/api/cms/media'
const MAX_RESULTS = 25

export const mediaProvider: SpotlightProvider = {
  id: 'media',
  label: 'Media',
  debounceMs: 150,

  async search(query, _ctx, signal): Promise<Command[]> {
    if (!query.trim()) return []

    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&limit=${MAX_RESULTS}`
    let body: Static<typeof MediaListResponseSchema>
    try {
      body = await apiRequest(url, { schema: MediaListResponseSchema, signal })
    } catch (err) {
      if (isAbortError(err)) return []
      throw err
    }

    return body.assets.map((asset): Command => ({
      id: `media:${asset.id}`,
      title: asset.title || asset.filename,
      subtitle: `${humanMimeType(asset.mimeType)} · ${humanFileSize(asset.sizeBytes)}`,
      group: 'media',
      iconName: mimeToIconName(asset.mimeType),
      keywords: ['media', 'file', 'upload', asset.filename, asset.mimeType],
      run: (ctx) => {
        ctx.closeSpotlight()
        ctx.navigate(`/admin/media?file=${encodeURIComponent(asset.id)}`)
      },
    }))
  },
}

function humanFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function humanMimeType(mimeType: string): string {
  const parts = mimeType.split('/')
  return parts[1]?.toUpperCase() ?? mimeType
}

function mimeToIconName(mimeType: string): string {
  if (mimeType.startsWith('image/')) return 'image-solid'
  if (mimeType.startsWith('video/')) return 'video-camera-solid'
  if (mimeType.startsWith('audio/')) return 'music-note-solid'
  return 'document-solid'
}
