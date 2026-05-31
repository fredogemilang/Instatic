/**
 * BackgroundImageControl — property control for the CSS `background-image`
 * property on a style rule.
 *
 * Three modes, switched via a top-level SegmentedControl:
 *
 *   - **None**     stored value: `''` (the publisher treats missing /
 *                  empty values as "do not emit").
 *   - **Image**    stored value: `url('<URL>')`. Delegates to the existing
 *                  `MediaLibraryControl` (with its own Library / URL sub-toggle)
 *                  so this control inherits the media-library picker, asset
 *                  thumbnails, blurhash placeholders, edit-in-place, and the
 *                  custom-URL fallback for external CDNs. The control
 *                  translates between the field's CSS string (`url('x')`)
 *                  and the plain URL the library control expects.
 *   - **Gradient** stored value: any valid CSS `*-gradient(...)` expression
 *                  (or any string that isn't `none`/`url(...)`). v1 is a
 *                  plain text input — a visual gradient builder is planned
 *                  separately.
 *
 * Mode detection on read (so an externally-set value lands on the right tab):
 *   - `''`  / `'none'`               → 'none'
 *   - starts with `url(`             → 'image'
 *   - anything else (`linear-gradient(...)`, `radial-gradient(...)`, ...)
 *                                    → 'gradient'
 *
 * Switching modes does NOT clear the stored value — the previous value stays
 * on the rule until the user enters a new one for the active mode (or picks
 * 'None' which clears explicitly). This means switching back to the prior
 * mode restores what was there. The exception is **None**: it always clears.
 *
 * This is the single home for both imported `background-image` values (which
 * land here as `url('/uploads/...')` after `applyAssetRewrites`) and
 * user-authored values. The CSS importer (Phase 1+) already produces values
 * in the `url('...')` form so the picker recognises imported assets out of
 * the box.
 */
import { useState } from 'react'
import type { ControlProps } from './shared'
import { ControlRow } from '@ui/components/ControlRow'
import { SegmentedControl } from '@ui/components/SegmentedControl'
import { Input } from '@ui/components/Input'
import { MediaLibraryControl } from './MediaLibraryControl'
import styles from './BackgroundImageControl.module.css'

type BgImageMode = 'none' | 'image' | 'gradient'

const MODE_OPTIONS = [
  { value: 'none', label: 'None', ariaLabel: 'No background image' },
  { value: 'image', label: 'Image', ariaLabel: 'Background image from media library' },
  { value: 'gradient', label: 'Gradient', ariaLabel: 'CSS gradient' },
] satisfies ReadonlyArray<{ value: BgImageMode; label: string; ariaLabel: string }>

// ---------------------------------------------------------------------------
// Value <-> mode helpers
// ---------------------------------------------------------------------------

function detectMode(value: string): BgImageMode {
  const trimmed = value.trim()
  if (!trimmed || trimmed.toLowerCase() === 'none') return 'none'
  if (/^url\s*\(/i.test(trimmed)) return 'image'
  return 'gradient'
}

/**
 * Pull the URL payload out of a `url('x')` / `url("x")` / `url(x)` string.
 * Returns '' when the input isn't a single url(...) expression.
 */
function extractUrlPayload(value: string): string {
  const match = value.trim().match(/^url\(\s*(['"]?)([^'")]+)\1\s*\)\s*$/i)
  return match?.[2]?.trim() ?? ''
}

function wrapUrl(payload: string): string {
  const cleaned = payload.trim()
  if (!cleaned) return ''
  // Always single-quote in storage so the publisher's emitter has one
  // canonical form. Strip any quotes the picker might have included.
  return `url('${cleaned.replace(/^['"]|['"]$/g, '')}')`
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

// The control intentionally ignores the schema-level placeholder. For
// background-image the upstream default placeholder is `none`, which is
// useless inside the gradient text input — we always show a real gradient
// example instead. Image mode has its own picker affordances and never
// renders a free-form text input at this level.
type BackgroundImageControlProps = ControlProps<string>

export function BackgroundImageControl({
  propKey,
  value,
  onChange,
  label,
  isOverride,
  disabled,
}: BackgroundImageControlProps) {
  const cssValue = String(value ?? '')
  const [mode, setMode] = useState<BgImageMode>(() => detectMode(cssValue))

  // Resync with the external value when it changes from elsewhere (preset
  // applied, breakpoint switched, import landed, ...). Without this the mode
  // tab can drift out of sync with the stored value. Done by adjusting state
  // during render (tracking the previous value) rather than in an effect —
  // the React-recommended pattern, which avoids the cascading re-render an
  // effect-driven setState would trigger.
  const [prevCssValue, setPrevCssValue] = useState(cssValue)
  if (cssValue !== prevCssValue) {
    setPrevCssValue(cssValue)
    setMode(detectMode(cssValue))
  }

  function handleModeChange(newMode: BgImageMode) {
    setMode(newMode)
    // 'none' is destructive by definition — clear the stored value so the
    // publisher stops emitting `background-image`. The other modes preserve
    // the existing value; the inner control will adopt it when it matches
    // (URL for image, CSS for gradient) or show empty when it doesn't.
    if (newMode === 'none') onChange(propKey, '')
  }

  function handleImageUrlChange(_key: string, url: string) {
    onChange(propKey, url ? wrapUrl(url) : '')
  }

  function handleGradientChange(event: React.ChangeEvent<HTMLInputElement>) {
    onChange(propKey, event.target.value)
  }

  // For the image picker we hand it the bare URL extracted from `url('...')`.
  // If the current cssValue isn't a url() (e.g. user is still in gradient
  // mode visually but already switched tab), the picker sees empty.
  const imageUrl = mode === 'image' ? extractUrlPayload(cssValue) : ''

  return (
    <>
      {/*
       * Mode row — inline layout so it matches every other CSS property's
       * row anatomy (100px label column + control column). The mode-specific
       * body below sits OUTSIDE this row so it can take the full wrapper
       * width without being clipped to the 1fr control column.
       */}
      <ControlRow
        propKey={propKey}
        label={label}
        layout="inline"
        isOverride={isOverride}
        disabled={disabled}
      >
        <SegmentedControl<BgImageMode>
          value={mode}
          options={MODE_OPTIONS}
          onChange={handleModeChange}
          size="sm"
          fullWidth
          disabled={disabled}
          aria-label={`${label ?? propKey} mode`}
        />
      </ControlRow>

      {mode === 'image' && (
        <div className={styles.modeBody}>
          <MediaLibraryControl
            propKey={`${propKey}-image-url`}
            value={imageUrl}
            onChange={handleImageUrlChange}
            // Empty label suppresses MediaLibraryControl's inner labelRow
            // entirely — the parent row above already labels the whole control.
            label=""
            isOverride={isOverride}
            disabled={disabled}
            layout="stacked"
            mediaKind="image"
          />
        </div>
      )}

      {mode === 'gradient' && (
        <div className={styles.modeBody}>
          <Input
            id={`ctrl-${propKey}-gradient`}
            type="text"
            value={cssValue}
            // Always show a useful gradient example — the upstream placeholder
            // for `background-image` is `none`, which isn't a hint here.
            placeholder="linear-gradient(135deg, #f9fafb, #e5e7eb)"
            disabled={disabled}
            fieldSize="sm"
            onChange={handleGradientChange}
            aria-label={`${label ?? propKey} gradient CSS`}
          />
        </div>
      )}
    </>
  )
}
