/**
 * base.video editor preview component.
 *
 * Mirrors what the publisher emits so the canvas WYSIWYG reflects the
 * shipped HTML:
 *   - resolved poster (with smallest-fits variant pick) so the still
 *     frame appears immediately instead of after `preload="metadata"`
 *     finishes.
 *   - intrinsic `width` / `height` from the resolved video asset to
 *     prevent CLS on the canvas.
 *   - the same `playsinline` / `autoplay` / `loop` / `muted` /
 *     `controls` props.
 *
 * Component-only file so React Fast Refresh can hot-patch edits without
 * re-running module registration. Per Constraint #309, this file MUST NOT
 * export non-component values — `youtubeEmbedUrl` is duplicated in
 * `index.ts` for the publisher render path.
 */
import React, { useMemo } from 'react'
import type { ModuleComponentProps } from '@core/module-engine/types'
import { cn } from '@ui/cn'
import { useCmsMediaAssetByPath } from '@admin/pages/media/hooks/useCmsMediaAssetByPath'
import { pickVariantUrl } from '@admin/pages/media/utils/variants'
import styles from './video.module.css'

interface VideoProps extends Record<string, unknown> {
  source: 'media' | 'youtube'
  youtubeId: string
  videoUrl: string
  poster: string
  autoplay: boolean
  loop: boolean
  muted: boolean
  controls: boolean
  playsinline: boolean
  preload: 'none' | 'metadata' | 'auto'
}

// Canvas tile width hint — drives the poster variant pick. Videos in the
// editor preview usually render at half the published-page width because
// the canvas is scaled down; 480 px is a sensible default DPR-aware
// target.
const CANVAS_CSS_WIDTH = 480

function youtubeEmbedUrl(id: unknown, autoplay: unknown): string {
  const safeId = encodeURIComponent(String(id ?? '').trim())
  if (!safeId) return ''
  return `https://www.youtube.com/embed/${safeId}${autoplay ? '?autoplay=1' : ''}`
}

export const VideoEditor: React.FC<ModuleComponentProps<VideoProps>> = ({ props, mcClassName }) => {
  const isYoutube = props.source === 'youtube'

  // Resolve both assets in parallel via the per-path cache — same path
  // ImageEditor uses, so 50 videos on a page share one fetch each.
  const videoAsset = useCmsMediaAssetByPath(!isYoutube ? props.videoUrl || null : null)
  const posterAsset = useCmsMediaAssetByPath(!isYoutube ? props.poster || null : null)

  const posterUrl = useMemo(() => {
    if (!posterAsset) return props.poster || null
    return pickVariantUrl(posterAsset, CANVAS_CSS_WIDTH)
  }, [posterAsset, props.poster])

  const intrinsic = useMemo(() => {
    if (!videoAsset) return null
    return { width: videoAsset.width ?? undefined, height: videoAsset.height ?? undefined }
  }, [videoAsset])

  if (isYoutube) {
    const src = youtubeEmbedUrl(props.youtubeId, props.autoplay)
    if (!src) {
      return (
        <div className={cn(styles.placeholder, mcClassName)}>
          <span className={styles.playIcon}>Play</span>
          <span>YouTube ID required</span>
        </div>
      )
    }
    return (
      <iframe
        className={mcClassName}
        src={src}
        title="YouTube video"
        frameBorder="0"
        allow="autoplay; encrypted-media; fullscreen"
        allowFullScreen
      />
    )
  }

  if (!props.videoUrl) {
    return (
      <div className={cn(styles.placeholder, mcClassName)}>
        <span className={styles.playIcon}>Play</span>
        <span>Video required</span>
      </div>
    )
  }

  return (
    <video
      className={mcClassName}
      src={props.videoUrl}
      poster={posterUrl ?? undefined}
      width={intrinsic?.width}
      height={intrinsic?.height}
      preload={props.preload}
      playsInline={props.playsinline}
      autoPlay={props.autoplay}
      loop={props.loop}
      muted={props.muted}
      controls={props.controls}
    />
  )
}
