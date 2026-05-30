/**
 * SpacingBoxControl — visual box-model editor for padding & margin.
 *
 * Replaces the verbose 10-row stack (padding, paddingTop/Right/Bottom/Left,
 * margin, marginTop/Right/Bottom/Left) with a unified, token-aware widget:
 *
 *   ┌─────────────── Margin ────────────────┐
 *   │  \           [ md ]            /       │
 *   │    \                         /         │
 *   │      ┌─── Padding ────┐                │
 *   │ [sm] │  \   [md]   /  │   [sm]         │
 *   │      │ [m]    \   /   │                │
 *   │      │           X    │                │
 *   │      │ [m]    /  \    │                │
 *   │      │  /  [md]    \  │                │
 *   │      └────────────────┘                │
 *   │    /                         \         │
 *   │  /           [ md ]            \       │
 *   └────────────────────────────────────────┘
 *
 * Outer dashed rectangle = margin, inner solid rectangle = padding,
 * each crossed by corner-to-corner diagonals (dashed for margin, solid
 * for padding). The widget is locked to a 4:3 aspect ratio with the
 * padding box centred at exactly 50% of the margin box, so the diagonals
 * always pass through the padding's outer corners — classic Chrome
 * DevTools box-model look. Side inputs sit at the 12.5% line of each
 * axis so they're geometrically centred in their respective segments.
 *
 * Each side input is token-aware: typing `m` (or any step label) auto-
 * completes to the matching framework spacing variable (`var(--space-m)`).
 * The link button at the top of each box mirrors edits across all four
 * sides.
 *
 * Storage model:
 *   - The control owns paddingTop/Right/Bottom/Left and marginTop/Right/
 *     Bottom/Left as the source of truth.
 *   - There is no shorthand `padding` / `margin` key in storage — that
 *     ambiguity is removed at the schema level. The publisher collapses
 *     the 4 sides into the CSS shorthand (`padding: 20px 0;`) at emission
 *     time (see `bagToCSS` in `core/publisher/classCss.ts`).
 */

import {
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import type { CSSPropertyBag } from '@core/page-tree'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import { useEditorPreference } from '@site/preferences/editorPreferences'
import {
  displayTokenValue,
  isLivePreviewable,
  looksLikeDirectValue,
  resolveTokenValue,
  useSpacingTokens,
  type Token,
} from '@site/property-controls/tokenUtils'
import styles from './SpacingBoxControl.module.css'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

const SIDES = ['top', 'right', 'bottom', 'left'] as const
type Side = (typeof SIDES)[number]
type Box = 'padding' | 'margin'

interface SpacingBoxControlProps {
  /** Stored values at the active breakpoint (no inherited base merge). */
  storedStyles: Record<string, unknown>
  /** Effective values including base-breakpoint inheritance — used for placeholders. */
  currentStyles: Record<string, unknown>
  onChange: (
    property: keyof CSSPropertyBag,
    value: string | number | undefined,
  ) => void
  onRemove: (property: keyof CSSPropertyBag) => void
  /**
   * Apply a transient style preview while a user hovers a token
   * suggestion. The preview is layered on top of the active class via
   * a higher-specificity rule and is NOT committed to history.
   */
  onPreview?: (patch: Partial<CSSPropertyBag>) => void
  /** Clear any active preview. Called on hover-leave / menu close. */
  onClearPreview?: () => void
}

// ---------------------------------------------------------------------------
// Property key helpers
// ---------------------------------------------------------------------------

function sideKey(box: Box, side: Side): keyof CSSPropertyBag {
  // Build "paddingTop", "marginRight", etc.
  return `${box}${side[0].toUpperCase()}${side.slice(1)}` as keyof CSSPropertyBag
}

// ---------------------------------------------------------------------------
// Side state — derived effective value per side & per box
// ---------------------------------------------------------------------------

interface BoxState {
  /** Per-side stored values (empty string when the side is unset). */
  effective: Record<Side, string>
  /** Whether each side has an explicit stored value. */
  storedFlags: Record<Side, boolean>
  /** All four sides are equal (and at least one is non-empty). */
  isUniform: boolean
}

function computeBoxState(
  storedStyles: Record<string, unknown>,
  box: Box,
): BoxState {
  const effective: Record<Side, string> = { top: '', right: '', bottom: '', left: '' }
  const storedFlags: Record<Side, boolean> = {
    top: false,
    right: false,
    bottom: false,
    left: false,
  }

  for (const side of SIDES) {
    const explicit = pickString(storedStyles[sideKey(box, side)])
    if (explicit) {
      effective[side] = explicit
      storedFlags[side] = true
    }
  }

  const values = SIDES.map((s) => effective[s])
  const hasAny = values.some((v) => v !== '')
  const isUniform = hasAny && values.every((v) => v === values[0])

  return { effective, storedFlags, isUniform }
}

function pickString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return `${value}px`
  return ''
}

// ---------------------------------------------------------------------------
// SpacingBoxControl
// ---------------------------------------------------------------------------

export function SpacingBoxControl({
  storedStyles,
  currentStyles,
  onChange,
  onRemove,
  onPreview,
  onClearPreview,
}: SpacingBoxControlProps) {
  const tokens = useSpacingTokens()

  // ── Per-box state ──────────────────────────────────────────────────────
  const padding = computeBoxState(storedStyles, 'padding')
  const margin = computeBoxState(storedStyles, 'margin')

  const paddingFallback = computeBoxState(currentStyles, 'padding')
  const marginFallback = computeBoxState(currentStyles, 'margin')

  // ── Linked-mode toggles (UI state) ─────────────────────────────────────
  // Default to linked when the four effective sides are uniform (or empty).
  const [paddingLinked, setPaddingLinked] = useState<boolean>(() =>
    padding.isUniform || allEmpty(padding.effective),
  )
  const [marginLinked, setMarginLinked] = useState<boolean>(() =>
    margin.isUniform || allEmpty(margin.effective),
  )

  // Auto-relink when external changes (undo/breakpoint switch, chip-apply
  // while split) bring the four sides back into uniform shape. Update during
  // render — React 19 idiom — instead of in an effect.
  // We don't auto-unlink: the user opted into split-mode deliberately.
  if (!paddingLinked && padding.isUniform) setPaddingLinked(true)
  if (!marginLinked && margin.isUniform) setMarginLinked(true)

  // ── Last-focused side (for chip-apply target) ──────────────────────────
  const [focused, setFocused] = useState<{ box: Box; side: Side } | null>(null)

  // ── Apply value to a box ───────────────────────────────────────────────
  const applyValue = (box: Box, side: Side | 'all', resolved: string | undefined) => {
    const isLinked = box === 'padding' ? paddingLinked : marginLinked
    const sidesToWrite: Side[] =
      side === 'all' || isLinked ? [...SIDES] : [side]

    for (const s of sidesToWrite) {
      onChange(sideKey(box, s), resolved)
    }
  }

  // ── Clear a box ────────────────────────────────────────────────────────
  const clearBox = (box: Box) => {
    for (const s of SIDES) onRemove(sideKey(box, s))
  }

  // ── Preview value (transient, not history-tracked) ─────────────────────
  const previewValue = (box: Box, side: Side, resolved: string | undefined) => {
    if (!onPreview) return
    const isLinked = box === 'padding' ? paddingLinked : marginLinked
    const sidesToWrite: Side[] = isLinked ? [...SIDES] : [side]
    const patch: Partial<CSSPropertyBag> = {}
    for (const s of sidesToWrite) {
      // Cast to never because CSSPropertyBag values are typed per-key;
      // we trust the resolved value matches the property's expected type.
      ;(patch as Record<string, unknown>)[sideKey(box, s)] = resolved
    }
    onPreview(patch)
  }

  const clearPreview = () => {
    onClearPreview?.()
  }

  return (
    <div className={styles.root}>
      <SpacingBox
        box="margin"
        label="Margin"
        state={margin}
        fallback={marginFallback}
        linked={marginLinked}
        onToggleLinked={() => setMarginLinked((v) => !v)}
        focused={focused?.box === 'margin' ? focused.side : null}
        setFocused={(side) => setFocused({ box: 'margin', side })}
        tokens={tokens}
        onSideValue={(side, resolved) => applyValue('margin', side, resolved)}
        onSidePreview={(side, resolved) => previewValue('margin', side, resolved)}
        onClearPreview={clearPreview}
        onClear={() => clearBox('margin')}
        nested={
          <SpacingBox
            box="padding"
            label="Padding"
            state={padding}
            fallback={paddingFallback}
            linked={paddingLinked}
            onToggleLinked={() => setPaddingLinked((v) => !v)}
            focused={focused?.box === 'padding' ? focused.side : null}
            setFocused={(side) => setFocused({ box: 'padding', side })}
            tokens={tokens}
            onSideValue={(side, resolved) =>
              applyValue('padding', side, resolved)
            }
            onSidePreview={(side, resolved) =>
              previewValue('padding', side, resolved)
            }
            onClearPreview={clearPreview}
            onClear={() => clearBox('padding')}
          />
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// SpacingBox — one of margin / padding
// ---------------------------------------------------------------------------

interface SpacingBoxProps {
  box: Box
  label: string
  state: BoxState
  fallback: BoxState
  linked: boolean
  onToggleLinked: () => void
  focused: Side | null
  setFocused: (side: Side) => void
  tokens: ReadonlyArray<Token>
  onSideValue: (side: Side, resolved: string | undefined) => void
  onSidePreview: (side: Side, resolved: string | undefined) => void
  onClearPreview: () => void
  onClear: () => void
  nested?: React.ReactNode
}

function SpacingBox({
  box,
  label,
  state,
  fallback,
  linked,
  onToggleLinked,
  focused,
  setFocused,
  tokens,
  onSideValue,
  onSidePreview,
  onClearPreview,
  onClear,
  nested,
}: SpacingBoxProps) {
  // Set count (used to enable/disable Clear button).
  const setCount = SIDES.filter((s) => state.storedFlags[s]).length

  return (
    <div className={cn(styles.box, styles[`box--${box}`])} data-linked={linked ? 'true' : undefined}>
      <div className={styles.boxHeader}>
        <span className={styles.boxLabel}>{label}</span>
        <div className={styles.boxHeaderActions}>
          <Button
            type="button"
            variant="ghost"
            size="micro"
            iconOnly
            onClick={onToggleLinked}
            aria-pressed={linked}
            aria-label={linked ? `Unlink ${label} sides` : `Link all ${label} sides`}
            tooltip={linked ? 'Linked — edits all four sides' : 'Split — edit each side separately'}
            className={cn(styles.linkBtn, linked && styles.linkBtnActive)}
          >
            <LinkIcon size={12} aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="micro"
            iconOnly
            onClick={onClear}
            disabled={setCount === 0}
            aria-label={`Clear ${label}`}
            tooltip={`Clear ${label}`}
            className={styles.clearBtn}
          >
            <CloseIcon size={12} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className={styles.boxBody}>
        {/* Corner-to-corner diagonals — dashed for margin (echoes the
         *  dashed margin border), solid for padding. The padding box's
         *  opaque-ish background covers the margin diagonals where they
         *  overlap, producing a continuous "diagonal that turns dashed
         *  beyond the padding boundary" effect. */}
        <BoxDiagonals dashed={box === 'margin'} />

        {SIDES.map((side) => (
          <SideInput
            key={side}
            box={box}
            side={side}
            value={state.effective[side]}
            placeholder={fallback.effective[side]}
            isSet={state.storedFlags[side]}
            isLinkedTarget={linked && state.isUniform}
            isFocusedTarget={focused === side}
            tokens={tokens}
            onCommit={(resolved) => onSideValue(side, resolved)}
            onFocus={() => setFocused(side)}
            onPreview={(resolved) => onSidePreview(side, resolved)}
            onClearPreview={onClearPreview}
          />
        ))}

        {/* Centre cell — only rendered when there's a nested box to host
         *  (margin holds the padding box). Padding has nothing inside its
         *  centre — the diagonals do the visual work and free the space
         *  for the side inputs to read clearly. */}
        {nested && <div className={styles.boxInner}>{nested}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// BoxDiagonals — SVG overlay drawing two corner-to-corner diagonals.
// preserveAspectRatio="none" stretches the lines to the actual box size so
// they reach exact corners. Stroke width is held in CSS.
//
// allowed: non-icon SVG (geometric overlay)
// This is a layout overlay — two diagonal lines that scale with the
// box and switch between solid/dashed for the padding/margin layers.
// It is not iconography (Constraint #348 is about icons) and there is
// no equivalent in the pixel-art-icons catalog. CSS gradients can't
// produce a true 1px non-scaling stroke or scalable dashed diagonals,
// so SVG is the right primitive here.
// ---------------------------------------------------------------------------

function BoxDiagonals({ dashed }: { dashed: boolean }) {
  return (
    <svg
      className={styles.boxDiagonals}
      aria-hidden="true"
      preserveAspectRatio="none"
      viewBox="0 0 100 100"
    >
      <line
        x1="0"
        y1="0"
        x2="100"
        y2="100"
        className={cn(styles.diagonal, dashed && styles.diagonalDashed)}
      />
      <line
        x1="100"
        y1="0"
        x2="0"
        y2="100"
        className={cn(styles.diagonal, dashed && styles.diagonalDashed)}
      />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// SideInput — token-aware input on a box edge
// ---------------------------------------------------------------------------

interface SideInputProps {
  box: Box
  side: Side
  value: string
  placeholder: string
  isSet: boolean
  isLinkedTarget: boolean
  isFocusedTarget: boolean
  tokens: ReadonlyArray<Token>
  onCommit: (resolved: string | undefined) => void
  onFocus: () => void
  onPreview: (resolved: string | undefined) => void
  onClearPreview: () => void
}

function SideInput({
  box,
  side,
  value,
  placeholder,
  isSet,
  isLinkedTarget,
  isFocusedTarget,
  tokens,
  onCommit,
  onFocus,
  onPreview,
  onClearPreview,
}: SideInputProps) {
  const display = displayTokenValue(value, tokens)
  const placeholderDisplay = displayTokenValue(placeholder, tokens) || '0'

  // The shared "preview suggestions on hover" preference. When off, hovering
  // a token in the dropdown does NOT trigger the canvas preview — but typing
  // a value still does (live as-you-type preview is a separate UX feature
  // that the user did not opt out of).
  const hoverPreviewEnabled = useEditorPreference('hoverPreview')

  // Local draft so we don't fire onChange on every keystroke (which would
  // round-trip through Immer + re-validate every press).
  const [draft, setDraft] = useState(display)
  const [isEditing, setIsEditing] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)

  // Sync external value → draft when not actively editing. React 19 idiom:
  // adjust state during render by tracking the previous external value.
  const [lastExternalDisplay, setLastExternalDisplay] = useState(display)
  if (!isEditing && display !== lastExternalDisplay) {
    setLastExternalDisplay(display)
    setDraft(display)
  }

  // Filter tokens by typed prefix for the autocomplete dropdown.
  // When there's no query, the "Suggested" section is hidden entirely —
  // returning [] here lets the "Tokens" section render the full scale.
  const suggestionQuery = draft.trim().toLowerCase()
  const suggestions = suggestionQuery
    ? tokens
        .filter(
          (t) =>
            t.step.toLowerCase().startsWith(suggestionQuery) ||
            t.step.toLowerCase().includes(suggestionQuery),
        )
        .slice(0, 8)
    : []

  const commit = (raw: string) => {
    const resolved = resolveTokenValue(raw, tokens)
    onClearPreview()
    onCommit(resolved)
    setIsEditing(false)
  }

  // Preview a hovered token's value on the canvas. Only the resolved value
  // is forwarded — the parent decides which sides the preview affects
  // (single side or all four, depending on the linked toggle).
  //
  // Gated by the `hoverPreview` preference so users who don't want the
  // canvas to flicker as they scan the autocomplete list can opt out.
  // Note: this only gates HOVER previews — the as-you-type preview below
  // (`previewDraft`) is intentionally always on, since it reflects an
  // explicit edit the user is making.
  const previewToken = (rawValue: string) => {
    if (!hoverPreviewEnabled) return
    const resolved = resolveTokenValue(rawValue, tokens)
    onPreview(resolved)
  }

  // Defensive: if the preference is toggled off while a hover preview is
  // active (e.g. user flips the toggle in another tab), clear the canvas
  // preview so it doesn't stick around. Mirrors the same pattern in
  // ClassPicker.
  useEffect(() => {
    if (!hoverPreviewEnabled) onClearPreview()
  }, [hoverPreviewEnabled, onClearPreview])

  // Live-preview a typed draft. Updates the canvas on every keystroke so
  // users see their values applied without having to press Enter / Tab /
  // blur — matches the behaviour of every modern visual builder. When the
  // current draft is provably incomplete (e.g. `var(--spa`), we skip the
  // update and keep the last valid preview on screen instead of writing
  // garbage to the engine.
  const previewDraft = (rawValue: string) => {
    if (!isLivePreviewable(rawValue)) return
    const resolved = resolveTokenValue(rawValue, tokens)
    onPreview(resolved)
  }

  // Hide the dropdown when the user is typing a direct CSS value
  // (numbers, units, "auto", calc(...), etc.) — non-token typing should
  // commit on Enter/Tab/Blur without the menu intercepting outside-clicks.
  const isDirectValue = looksLikeDirectValue(draft)
  const showMenu = isEditing && !isDirectValue

  // Split tokens into "Suggested" (matching the typed query) and "All" (the
  // remaining tokens) so users always see the full scale even when they
  // haven't started typing.
  const queryTrim = draft.trim().toLowerCase()
  const suggestedSet = new Set(suggestions.map((t) => t.varName))
  const allOthers = tokens.filter((t) => !suggestedSet.has(t.varName))
  const showSuggestedHeader = queryTrim.length > 0 && suggestions.length > 0
  const showAllHeader = allOthers.length > 0

  return (
    <div
      className={cn(
        styles.segment,
        styles[`segment--${side}`],
        isLinkedTarget && styles.segmentLinked,
        isFocusedTarget && styles.segmentFocused,
      )}
      data-state={isSet ? 'set' : 'unset'}
      onClick={() => inputRef.current?.focus()}
    >
      <Input
        ref={inputRef}
        type="text"
        fieldSize="xs"
        value={draft}
        placeholder={placeholderDisplay}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${box} ${side}`}
        className={styles.sideInput}
        onFocus={() => {
          setIsEditing(true)
          onFocus()
        }}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          previewDraft(next)
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setDraft(display)
            setIsEditing(false)
            ;(e.target as HTMLInputElement).blur()
          } else if (e.key === 'Tab') {
            // Allow default tab behaviour but commit the current value.
            commit((e.target as HTMLInputElement).value)
          }
        }}
      />

      {showMenu &&
        createPortal(
          <ContextMenu
            anchorRef={inputRef}
            side="auto"
            align="start"
            offset={4}
            matchAnchorWidth
            minWidth={132}
            ariaLabel={`${box} ${side} spacing tokens`}
            triggerRef={inputRef}
            onClose={() => {
              onClearPreview()
            }}
            onMouseLeave={() => onClearPreview()}
          >
            {showSuggestedHeader && (
              <div className={styles.sideMenuHeader} aria-hidden="true">
                Suggested
              </div>
            )}
            {showSuggestedHeader &&
              suggestions.map((t) => (
                <ContextMenuItem
                  key={`suggested-${t.varName}`}
                  onMouseDown={(e) => {
                    // mousedown beats blur — commits the token before the input loses focus.
                    e.preventDefault()
                    commit(t.step)
                  }}
                  onMouseEnter={() => previewToken(t.step)}
                  className={styles.sideMenuItem}
                >
                  <span className={styles.sideMenuToken}>{t.step}</span>
                  <span className={styles.sideMenuVar} title={t.valueExpr}>
                    {t.varName}
                  </span>
                </ContextMenuItem>
              ))}
            {showAllHeader && (
              <div className={styles.sideMenuHeader} aria-hidden="true">
                {showSuggestedHeader ? 'All tokens' : 'Tokens'}
              </div>
            )}
            {(showAllHeader ? allOthers : tokens).map((t) => (
              <ContextMenuItem
                key={`all-${t.varName}`}
                onMouseDown={(e) => {
                  e.preventDefault()
                  commit(t.step)
                }}
                onMouseEnter={() => previewToken(t.step)}
                className={styles.sideMenuItem}
              >
                <span className={styles.sideMenuToken}>{t.step}</span>
                <span className={styles.sideMenuVar} title={t.valueExpr}>
                  {t.varName}
                </span>
              </ContextMenuItem>
            ))}
          </ContextMenu>,
          document.body,
        )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function allEmpty(map: Record<Side, string>): boolean {
  return SIDES.every((s) => !map[s])
}
