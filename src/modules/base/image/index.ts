/**
 * base.image — responsive image module.
 *
 * Published HTML uses the full responsive pipeline produced by the
 * `prefetchMediaAssets` publisher pre-pass:
 *   - `srcset` built from `/uploads/<id>-w<width>.webp` variants
 *   - `sizes` hint (`'auto'` resolves to `100vw` for v1; users can supply
 *     a custom string like `(min-width: 1024px) 50vw, 100vw`)
 *   - intrinsic `width` / `height` to prevent CLS
 *   - `loading` / `decoding` / `fetchpriority` perf hints
 *   - BlurHash data URL as a CSS background while the variant streams in
 *
 * When the publisher hasn't pre-resolved the asset (external URL, page
 * built pre-pipeline, editor canvas preview), we fall back to a plain
 * `<img src loading decoding>` so the module never breaks.
 */
import type { ModuleDefinition } from '@core/module-engine/types'
import type { RenderResolvedMedia } from '@core/publisher/render'
import { registry } from '@core/module-engine/registry'
import { ImageSolidIcon } from 'pixel-art-icons/icons/image-solid'
import { safeUrl } from '@modules/base/utils/escape'
import { ImageEditor } from './ImageEditor'

interface ImageProps extends Record<string, unknown> {
  src: string
  alt: string
  loading: 'lazy' | 'eager'
  /**
   * `sizes` attribute. `'auto'` resolves to `100vw` at publish time —
   * future work: derive from canvas breakpoints. A custom string is
   * emitted verbatim.
   */
  sizes: string
  /**
   * `fetchpriority` hint. Use `'high'` for hero / above-the-fold images,
   * `'low'` for offscreen marketing chrome.
   */
  fetchPriority: 'auto' | 'high' | 'low'
  decoding: 'async' | 'sync' | 'auto'
  /**
   * Internal: attached by the publisher's `prefetchMediaAssets` pass.
   * Map of prop key → resolved media. Not user-editable — declared here
   * so render() picks it up without a cast and TypeScript stays happy.
   * NOT in the schema (so the picker doesn't show it as a control row).
   */
  _resolvedMediaByKey?: Record<string, RenderResolvedMedia>
}

/**
 * Resolve `'auto'` sizes hint. For v1, defaults to `100vw` — the image
 * fills its container at every breakpoint. Smart resolver that walks the
 * page tree to compute per-breakpoint container widths is a future pass.
 */
function resolveSizes(prop: string): string {
  if (!prop || prop === 'auto') return '100vw'
  return prop
}

/**
 * Convert a BlurHash string to a tiny inline SVG data URL suitable for a
 * CSS `background-image`. We render a 32×32 PNG via canvas — but we're in
 * a pure-render context (no DOM), so we approximate with an SVG
 * placeholder built from the BlurHash's first 6 chars (which encode the
 * DC term — i.e. the overall average colour). The full client-side
 * decode happens once the image hydrates; this server-side fallback just
 * paints a single-colour box so the layout doesn't flash empty.
 *
 * Why not the full 4×3 component decode? Pure render functions can't run
 * a canvas. Encoding a real SVG with multiple colour stops would require
 * porting `blurhash`' decoder to a string-builder. The single-colour DC
 * approximation is good enough for the first paint — by the time the
 * full image arrives a few hundred ms later, the difference is
 * imperceptible.
 */
function blurHashToCssBackground(hash: string): string | null {
  if (!hash || hash.length < 6) return null
  // BlurHash DC term decode: first 4 chars (after the size prefix) encode
  // the average sRGB color as a 24-bit integer in base83.
  const base83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~'
  function decodeBase83(str: string): number {
    let value = 0
    for (const c of str) {
      const i = base83.indexOf(c)
      if (i === -1) return 0
      value = value * 83 + i
    }
    return value
  }
  const dc = decodeBase83(hash.slice(2, 6))
  const r = (dc >> 16) & 0xff
  const g = (dc >> 8) & 0xff
  const b = dc & 0xff
  // SVG attributes use DOUBLE quotes inside the template — `encodeURIComponent`
  // leaves `'` raw (it's in its safe-char set, per the spec) but DOES encode
  // `"` to `%22`. By using double quotes inside the SVG, we guarantee the
  // encoded URL contains zero raw quote chars and can safely sit inside the
  // single-quoted `url('…')` and the outer double-quoted `style="…"`.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1" fill="rgb(${r},${g},${b})"/></svg>`
  return `url('data:image/svg+xml,${encodeURIComponent(svg)}')`
}

/**
 * Build the `srcset` attribute from a variant ladder. Includes the
 * original as the largest entry so the browser can pick the full-size
 * file for high-DPI displays.
 */
function buildSrcset(media: RenderResolvedMedia): string | null {
  if (!media.variants.length) return null
  const entries = media.variants
    .slice()
    .sort((a, b) => a.width - b.width)
    .map((v) => `${safeUrl(v.path)} ${v.width}w`)
  if (media.width) entries.push(`${safeUrl(media.publicPath)} ${media.width}w`)
  return entries.join(', ')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export const ImageModule: ModuleDefinition<ImageProps> = {
  id: 'base.image',
  name: 'Image',
  description: 'A responsive image.',
  category: 'Media',
  version: '3.0.0',
  icon: ImageSolidIcon,
  trusted: true,
  canHaveChildren: false,

  schema: {
    src: { type: 'image', label: 'Image' },
    alt: { type: 'text', label: 'Alt text', placeholder: 'Describe the image…', layout: 'stacked' },
    loading: {
      type: 'select',
      label: 'Loading',
      options: [
        { label: 'Lazy', value: 'lazy' },
        { label: 'Eager', value: 'eager' },
      ],
    },
    sizes: {
      type: 'text',
      label: 'Sizes',
      placeholder: 'auto · or e.g. (min-width: 1024px) 50vw, 100vw',
      layout: 'stacked',
    },
    fetchPriority: {
      type: 'select',
      label: 'Fetch priority',
      options: [
        { label: 'Auto', value: 'auto' },
        { label: 'High (above the fold)', value: 'high' },
        { label: 'Low (offscreen)', value: 'low' },
      ],
    },
    decoding: {
      type: 'select',
      label: 'Decoding',
      options: [
        { label: 'Async', value: 'async' },
        { label: 'Sync', value: 'sync' },
        { label: 'Auto', value: 'auto' },
      ],
    },
  },

  defaults: {
    src: '',
    alt: '',
    loading: 'lazy',
    sizes: 'auto',
    fetchPriority: 'auto',
    decoding: 'async',
  },

  component: ImageEditor,

  htmlTag: 'img',

  render: (props) => {
    const src = safeUrl(props.src)
    if (!src) return { html: '' }

    // Effective alt text — module override wins, otherwise fall back to
    // the library's asset.altText so the library is the single source of
    // truth for accessibility metadata.
    //
    // `props.alt` came in via the publisher's `escapeProps` (Constraint
    // #211) so it's already HTML-escaped — do NOT re-escape. The library
    // fallback comes straight from the resolved-media payload and IS raw,
    // so we escape it ourselves only on the fallback path.
    const moduleAlt = String(props.alt ?? '').trim()
    const media = props._resolvedMediaByKey?.src
    const libraryAltRaw = media?.altText?.trim() ?? ''
    const alt = moduleAlt || escapeAttr(libraryAltRaw)

    const loading = props.loading === 'eager' ? 'eager' : 'lazy'
    const decoding = props.decoding === 'sync' ? 'sync' : props.decoding === 'auto' ? 'auto' : 'async'
    const fetchPriority = props.fetchPriority === 'high'
      ? 'high'
      : props.fetchPriority === 'low' ? 'low' : 'auto'

    // `buildSrcset` already runs each variant path through `safeUrl`
    // (which HTML-escapes + sanitises). No extra escape needed.
    const srcset = media ? buildSrcset(media) : null
    // `sizes` is a plain-string user prop → already escaped by escapeProps.
    const sizes = srcset ? resolveSizes(String(props.sizes ?? 'auto')) : null
    const width = media?.width ?? null
    const height = media?.height ?? null
    const blurBg = media?.blurHash ? blurHashToCssBackground(media.blurHash) : null

    // Build the attribute string. Each attribute is conditionally appended
    // so the output is clean (no `width="null"` or empty `srcset=""`).
    const attrs: string[] = [`src="${src}"`, `alt="${alt}"`]
    if (srcset) attrs.push(`srcset="${srcset}"`)
    if (sizes) attrs.push(`sizes="${sizes}"`)
    if (width !== null) attrs.push(`width="${width}"`)
    if (height !== null) attrs.push(`height="${height}"`)
    attrs.push(`loading="${loading}"`)
    attrs.push(`decoding="${decoding}"`)
    if (fetchPriority !== 'auto') attrs.push(`fetchpriority="${fetchPriority}"`)
    // BlurHash background sits BEHIND the image via inline style. Once
    // the variant loads, the opaque <img> covers it. Skipped when
    // loading="eager" — those are above-the-fold images where the user
    // wants the real pixels ASAP, and the blur-then-flash effect is more
    // distracting than helpful at the top of the page.
    if (blurBg && loading === 'lazy') {
      attrs.push(`style="background-image:${blurBg};background-size:cover;background-position:center"`)
    }

    return { html: `<img ${attrs.join(' ')}>` }
  },
}

registry.registerOrReplace(ImageModule)
