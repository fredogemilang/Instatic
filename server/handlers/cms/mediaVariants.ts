/**
 * mediaVariants — server-side responsive image + BlurHash pipeline.
 *
 * Runs synchronously inside the upload + replace-file handlers. Given the
 * raw bytes of an uploaded image we:
 *
 *   1. Probe intrinsic dimensions via `sharp`.
 *   2. Encode a BlurHash (~30-char placeholder for the published page +
 *      every admin preview surface so the loading flash goes away).
 *   3. Generate one WebP variant for each target width that is < the
 *      original width. The set covers the common breakpoints we serve plus
 *      a tiny 64-wide thumb the admin grid + picker use.
 *
 * Variant bytes are streamed to the storage adapter elected for the
 * `'variant'` role via `dispatchUpload(role: 'variant')`. The default
 * local-disk adapter writes each WebP next to the original under
 * `<uploadsDir>/<originalStem>-w<width>.webp`. A plugin storage adapter
 * (S3, R2, …) routes variants to its own backend without any change in
 * this pipeline — that's the point of dispatch.
 *
 * Why synchronous? Sharp + libvips processes a typical 4 MP JPEG into the
 * full ladder in ~200–500 ms. We already block the upload response on the
 * disk write; folding variants into the same critical path keeps the
 * implementation simple and gives the user one "uploading" → "done"
 * transition. If real-world uploads cross multi-second territory we move
 * this to a background job (out of scope for v1).
 */
import sharp from 'sharp'
import { encode as encodeBlurHash } from 'blurhash'
import type { DbClient } from '../../db/client'
import { dispatchDelete, dispatchUpload } from './mediaUploadDispatch'
import { getElectedVariantDelegate, type ElectedVariantDelegate } from '../../repositories/mediaStorageAdapters'

/**
 * Target widths for the responsive variant ladder. Chosen to cover the
 * common breakpoints we serve in the editor (mobile 375 / tablet 768 /
 * desktop 1024 / wide 1600+) plus a tiny 64 the admin grid uses for
 * fast-loading thumbnails, plus a 2048 high-DPI variant.
 *
 * Sorted ascending so the variant array stays small-to-large for callers
 * doing a linear "smallest >= target" pick.
 */
const TARGET_WIDTHS = [64, 320, 640, 1024, 1600, 2048] as const

/**
 * WebP encoder quality. 80 is the standard "visually lossless for
 * non-pixel-art photos" sweet spot. We don't tweak per-variant — encoding
 * cost is already the bottleneck.
 */
const WEBP_QUALITY = 80

/**
 * BlurHash component counts. (4, 3) produces a punchy ~30-character hash
 * that decodes to a recognisable placeholder without bloating the column.
 * The encoder requires the source raw RGBA in 32x32 form; we resize on the
 * fly before encoding.
 */
const BLURHASH_X_COMPONENTS = 4
const BLURHASH_Y_COMPONENTS = 3
const BLURHASH_SAMPLE_WIDTH = 32
const BLURHASH_SAMPLE_HEIGHT = 32

export interface MediaVariantRecord {
  width: number
  height: number
  format: 'webp'
  path: string
  sizeBytes: number
  /** Adapter-internal storage handle — used by the delete dispatch path. */
  storagePath: string
  /** Adapter id that wrote this variant; `''` for local-disk. */
  storageAdapterId: string
}

export interface ImageProcessingResult {
  width: number
  height: number
  blurHash: string
  variants: MediaVariantRecord[]
}

/**
 * Strip the WebP-friendly extension from the original storage name so the
 * variant filenames stay readable (e.g. `abc-hero.png` →
 * `abc-hero-w320.webp`, not `abc-hero.png-w320.webp`).
 */
function variantStorageBase(storagePath: string): string {
  const dot = storagePath.lastIndexOf('.')
  return dot >= 0 ? storagePath.slice(0, dot) : storagePath
}

/**
 * Generate the full responsive ladder for an uploaded image. Returns the
 * probed dimensions, the BlurHash placeholder, and the list of variant
 * records — each variant has been streamed to the elected `'variant'`
 * storage adapter by this point (default local-disk).
 *
 * On any non-image input (GIF, SVG — though we don't accept SVG today) or
 * on any sharp failure, returns `null` so the caller falls back to a plain
 * row with no variants. Callers MUST handle the null case — the admin grid
 * still renders fine without variants, it just loads the original.
 */
export async function processImageVariants(
  db: DbClient,
  bytes: Uint8Array,
  /** storagePath of the parent original — used to derive variant filenames. */
  parentStoragePath: string,
): Promise<ImageProcessingResult | null> {
  try {
    // Pull intrinsic dimensions first. `sharp.metadata()` is cheap (header
    // only) and tells us whether we have something processable.
    const image = sharp(bytes)
    const metadata = await image.metadata()
    const originalWidth = metadata.width
    const originalHeight = metadata.height
    if (!originalWidth || !originalHeight) return null

    // ── BlurHash ─────────────────────────────────────────────────────────
    // Encode a downsampled raw RGBA buffer. `fit: 'fill'` is intentional —
    // BlurHash is rendered into a container whose aspect ratio matches the
    // FULL image (because the consumer also knows `width` / `height`), so
    // we don't need aspect-preserving downsampling here. Crucially, the
    // blurhash encoder requires the input buffer to be EXACTLY
    // `width * height * 4` bytes; `fit: 'inside'` would silently shrink one
    // dimension and produce a smaller buffer that the encoder then
    // rejects with `Width and height must match the pixels array`.
    const { data: blurBytes } = await sharp(bytes)
      .resize(BLURHASH_SAMPLE_WIDTH, BLURHASH_SAMPLE_HEIGHT, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const blurHash = encodeBlurHash(
      new Uint8ClampedArray(blurBytes.buffer, blurBytes.byteOffset, blurBytes.byteLength),
      BLURHASH_SAMPLE_WIDTH,
      BLURHASH_SAMPLE_HEIGHT,
      BLURHASH_X_COMPONENTS,
      BLURHASH_Y_COMPONENTS,
    )

    // ── Variant ladder ───────────────────────────────────────────────────
    // If a Tier-3 variant delegate is elected, we SKIP local sharp resizing
    // entirely and emit URL-template variants pointing at the delegate's
    // service (Cloudflare Images / Imgix / Bunny Optimizer / …). No bytes
    // are produced or stored for variants in that case.
    //
    // Otherwise we run the local ladder, streaming each WebP through
    // `dispatchUpload(role: 'variant')` so plugin storage adapters get
    // bytes for variants the same way they do for originals.
    const delegate = await getElectedVariantDelegate(db)
    if (delegate) {
      const variants = buildDelegateVariants(delegate, parentStoragePath, originalWidth, originalHeight)
      return {
        width: originalWidth,
        height: originalHeight,
        blurHash,
        variants,
      }
    }

    const base = variantStorageBase(parentStoragePath)
    const variants: MediaVariantRecord[] = []
    for (const width of TARGET_WIDTHS) {
      if (width >= originalWidth) continue
      const suggested = `${base}-w${width}.webp`
      const variantBytes = await sharp(bytes)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true })
      const dispatched = await dispatchUpload(db, {
        bytes: new Uint8Array(variantBytes.data),
        mimeType: 'image/webp',
        suggestedStoragePath: suggested,
        role: 'variant',
        variantOf: parentStoragePath,
      })
      variants.push({
        width: variantBytes.info.width,
        height: variantBytes.info.height,
        format: 'webp',
        path: dispatched.publicUrl,
        sizeBytes: variantBytes.data.byteLength,
        storagePath: dispatched.storagePath,
        storageAdapterId: dispatched.storageAdapterId,
      })
    }

    return {
      width: originalWidth,
      height: originalHeight,
      blurHash,
      variants,
    }
  } catch (err) {
    console.error('[mediaVariants] image processing failed:', err)
    return null
  }
}

/**
 * Compute the original public path the delegate template targets. Locally-
 * hosted originals live at `/uploads/<storagePath>`; the delegate's URL
 * template substitutes `{path}` with this value to construct the variant
 * URL. For externally-hosted originals the absolute URL would be the
 * proper substitution, but the variant pipeline doesn't currently know
 * the original's `public_path` — passing `/uploads/<storage>` is the
 * conservative choice that matches what the host's static handler serves.
 */
function originPathForDelegate(parentStoragePath: string): string {
  return parentStoragePath.startsWith('/')
    ? parentStoragePath
    : `/uploads/${parentStoragePath}`
}

/**
 * Substitute the delegate's URL template placeholders. The template is
 * declared once at plugin registration and is the same for every variant
 * (only width / format / quality / path vary), so this is a cheap string
 * replace — no JIT, no eval.
 *
 * Supported placeholders: `{path}`, `{width}`, `{format}`, `{quality}`,
 * `{originalMime}` (matches the SDK's `MediaVariantDelegate` JSDoc).
 */
function fillDelegateTemplate(
  template: string,
  vars: { path: string; width: number; format: string; quality: number; originalMime: string },
): string {
  return template
    .replaceAll('{path}', vars.path)
    .replaceAll('{width}', String(vars.width))
    .replaceAll('{format}', vars.format)
    .replaceAll('{quality}', String(vars.quality))
    .replaceAll('{originalMime}', vars.originalMime)
}

/**
 * Materialise the delegate's variant ladder. `sizeBytes` is `0` for every
 * entry because we never produced the bytes — the delegate generates the
 * variant on demand at the CDN edge. Consumers that depend on
 * `sizeBytes` for prefetch budgeting will treat a `0` as "unknown" (the
 * UI already does for non-image MIMEs).
 */
function buildDelegateVariants(
  delegate: ElectedVariantDelegate,
  parentStoragePath: string,
  originalWidth: number,
  originalHeight: number,
): MediaVariantRecord[] {
  const aspect = originalHeight > 0 ? originalHeight / originalWidth : 1
  // The variant ladder is one entry per (width, format) pair — but we
  // only emit ONE format per width to keep `srcset` lean. Picking the
  // first declared format (typically 'webp' or 'avif') matches the
  // strategy of every image-CDN: serve the modern format unless the
  // browser explicitly opts out via Accept headers.
  const format = delegate.formats[0] ?? 'webp'
  const path = originPathForDelegate(parentStoragePath)
  const out: MediaVariantRecord[] = []
  for (const width of delegate.widths) {
    if (width >= originalWidth) continue
    const url = fillDelegateTemplate(delegate.variantUrlTemplate, {
      path,
      width,
      format,
      quality: 80,
      originalMime: 'image/jpeg',
    })
    out.push({
      width,
      height: Math.round(width * aspect),
      // The format literal is widened to `'webp'` because the on-disk
      // emitter only ever wrote webp; the SDK shape accepts `webp | jpeg
      // | avif`, and storing the actual delegate format keeps the
      // renderer's `<picture>` emission honest.
      format: format as 'webp',
      path: url,
      sizeBytes: 0,
      // Variants emitted by the delegate aren't backed by host-stored
      // bytes — they live entirely on the delegate's CDN. We label them
      // with the delegate id so the delete path knows they're virtual
      // (and the prefix `delegate:` keeps the field's "namespaced adapter
      // id" semantics intact).
      storagePath: `delegate:${delegate.delegateId}`,
      storageAdapterId: `delegate:${delegate.delegateId}`,
    })
  }
  return out
}

/**
 * Remove the underlying bytes for every variant in `variants` via the
 * adapter that wrote each one. Variants written by an adapter that's
 * since been disabled are logged and skipped — bytes remain in the
 * backend (the user can clean them up out-of-band or wait for a future
 * orphan-sweep job).
 *
 * Failures are non-fatal — the database row removal has already succeeded.
 * Orphaned files just sit in the backend until a future GC sweeps them.
 */
export async function removeVariantFiles(
  variants: ReadonlyArray<{ storagePath: string; storageAdapterId: string }>,
): Promise<void> {
  for (const variant of variants) {
    // Virtual variants emitted by a Tier-3 delegate (Cloudflare Images
    // etc.) aren't backed by host-stored bytes — the delegate generates
    // them on demand at the CDN edge — so there's nothing to delete.
    // Their storage_adapter_id carries the `delegate:` prefix as a tag.
    if (variant.storageAdapterId.startsWith('delegate:')) continue
    try {
      await dispatchDelete(variant.storageAdapterId, variant.storagePath)
    } catch (err) {
      console.error('[mediaVariants] variant delete failed (orphaned bytes):', err)
    }
  }
}
