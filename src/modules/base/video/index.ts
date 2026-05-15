/**
 * base.video — video embed module.
 *
 * Two sources:
 *   - Media library — local `<video>` with a hand-picked poster image and
 *     the same responsive niceties as base.image where applicable
 *     (intrinsic `width` / `height` from the asset, optional `preload`,
 *     mandatory `playsinline` for iOS autoplay-on-mute scenarios).
 *   - YouTube — `<iframe>` to the standard embed URL. No poster /
 *     intrinsic dims (iframe handles its own preview).
 *
 * The publisher's `prefetchMediaAssets` pass attaches every resolved media
 * asset to `props._resolvedMediaByKey`. We read TWO entries: `videoUrl`
 * (for intrinsic width / height of the video itself) and `poster` (for the
 * picked still). Both are optional — if the user hasn't set them, the
 * markup falls back to the raw values and lets the browser figure it out.
 */
import type { ModuleDefinition } from '@core/module-engine/types'
import type { RenderResolvedMedia } from '@core/publisher/render'
import { registry } from '@core/module-engine/registry'
import { VideoSolidIcon } from 'pixel-art-icons/icons/video-solid'
import { safeUrl } from '@modules/base/utils/escape'
import { VideoEditor } from './VideoEditor'

interface VideoProps extends Record<string, unknown> {
  source: 'media' | 'youtube'
  youtubeId: string
  videoUrl: string
  /** Poster frame — picked from the Media library by the author. */
  poster: string
  autoplay: boolean
  loop: boolean
  muted: boolean
  controls: boolean
  /** Required for iOS so the video doesn't take over the screen. */
  playsinline: boolean
  /** Bandwidth hint: `'none'` for purely-decorative below-the-fold videos,
   *  `'metadata'` for most hero videos, `'auto'` only when you really mean
   *  it (e.g. the video is about to play on its own). */
  preload: 'none' | 'metadata' | 'auto'
  /** Internal: attached by the publisher's prefetchMediaAssets pass. */
  _resolvedMediaByKey?: Record<string, RenderResolvedMedia>
}

function youtubeEmbedUrl(id: unknown, autoplay: unknown): string {
  const safeId = encodeURIComponent(String(id ?? '').trim())
  if (!safeId) return ''
  return `https://www.youtube.com/embed/${safeId}${autoplay ? '?autoplay=1' : ''}`
}

export const VideoModule: ModuleDefinition<VideoProps> = {
  id: 'base.video',
  name: 'Video',
  description: 'Embed a CMS media video or YouTube video.',
  category: 'Media',
  version: '3.0.0',
  icon: VideoSolidIcon,
  trusted: true,
  canHaveChildren: false,

  schema: {
    source: {
      type: 'select',
      label: 'Video source',
      options: [
        { label: 'Media library', value: 'media' },
        { label: 'YouTube', value: 'youtube' },
      ],
    },
    youtubeId: {
      type: 'text',
      label: 'YouTube video ID',
      placeholder: 'dQw4w9WgXcQ',
      condition: { field: 'source', eq: 'youtube' },
    },
    videoUrl: {
      type: 'media',
      mediaKind: 'video',
      label: 'Video',
      condition: { field: 'source', eq: 'media' },
    },
    poster: {
      type: 'image',
      label: 'Poster image',
      condition: { field: 'source', eq: 'media' },
    },
    autoplay: { type: 'toggle', label: 'Autoplay' },
    loop: { type: 'toggle', label: 'Loop' },
    muted: { type: 'toggle', label: 'Muted' },
    controls: { type: 'toggle', label: 'Show controls' },
    playsinline: {
      type: 'toggle',
      label: 'Play inline (mobile)',
      condition: { field: 'source', eq: 'media' },
    },
    preload: {
      type: 'select',
      label: 'Preload',
      options: [
        { label: 'None', value: 'none' },
        { label: 'Metadata', value: 'metadata' },
        { label: 'Auto', value: 'auto' },
      ],
      condition: { field: 'source', eq: 'media' },
    },
  },

  defaults: {
    source: 'media',
    youtubeId: '',
    videoUrl: '',
    poster: '',
    autoplay: false,
    loop: false,
    muted: false,
    controls: true,
    playsinline: true,
    preload: 'metadata',
  },

  component: VideoEditor,

  htmlTag: (props) => (String(props.source) === 'youtube' ? 'iframe' : 'video'),

  render: (props) => {
    const isYoutube = String(props.source) === 'youtube'

    if (isYoutube) {
      const src = youtubeEmbedUrl(props.youtubeId, props.autoplay)
      if (!src) return { html: '' }
      return {
        html: `<iframe src="${src}" title="YouTube video" frameborder="0" allow="autoplay; encrypted-media; fullscreen" allowfullscreen></iframe>`,
      }
    }

    const videoSrc = safeUrl(String(props.videoUrl ?? ''))
    if (!videoSrc) return { html: '<video></video>' }

    // Resolved video asset gives us intrinsic dimensions — emits
    // `width` / `height` attrs so the browser reserves layout space
    // before the metadata downloads. Same CLS-avoidance trick as the
    // image module.
    const videoMedia = props._resolvedMediaByKey?.videoUrl ?? null
    const posterMedia = props._resolvedMediaByKey?.poster ?? null

    // Poster picks the smallest variant that's still ≥ the video's
    // own width — keeps the still file lightweight while staying sharp
    // at the rendered size. Falls back to the raw publicPath if no
    // variant ladder is available yet (poster picked but not yet
    // re-processed, or an external URL).
    const posterSrc = pickPosterVariantUrl(posterMedia) ?? safeUrl(String(props.poster ?? ''))

    const width = videoMedia?.width ?? null
    const height = videoMedia?.height ?? null
    const preload =
      props.preload === 'none' ? 'none' : props.preload === 'auto' ? 'auto' : 'metadata'

    const attrs: string[] = [`src="${videoSrc}"`]
    if (posterSrc) attrs.push(`poster="${posterSrc}"`)
    if (width !== null) attrs.push(`width="${width}"`)
    if (height !== null) attrs.push(`height="${height}"`)
    attrs.push(`preload="${preload}"`)
    if (props.playsinline) attrs.push('playsinline')
    if (props.autoplay) attrs.push('autoplay')
    if (props.loop) attrs.push('loop')
    if (props.muted) attrs.push('muted')
    if (props.controls) attrs.push('controls')

    return { html: `<video ${attrs.join(' ')}></video>` }
  },
}

/**
 * Poster picker — choose the smallest WebP variant that's still ≥ the
 * asset's intrinsic width. Targets sharp display without shipping a 4 K
 * still for a 1080 p video. Returns `null` when no usable variant exists
 * (caller falls back to the raw publicPath).
 *
 * `safeUrl` is applied so the result is HTML-attribute-safe.
 */
function pickPosterVariantUrl(media: RenderResolvedMedia | null): string | null {
  if (!media) return null
  if (!media.variants.length) {
    return media.publicPath ? safeUrl(media.publicPath) : null
  }
  const target = media.width ?? 1280
  const ladder = media.variants.slice().sort((a, b) => a.width - b.width)
  const pick = ladder.find((v) => v.width >= target) ?? ladder[ladder.length - 1]
  return safeUrl(pick.path)
}

registry.registerOrReplace(VideoModule)
