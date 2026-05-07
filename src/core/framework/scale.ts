/**
 * Shared fluid-scale math used by both the typography and spacing modules.
 *
 * Ported verbatim from the Core Framework `getTypeScale` / `getCssForSingleTypeScale`
 * helpers so the page-builder produces byte-identical clamp() values for the same
 * inputs. The function names and ordering of operations are preserved on purpose
 * — making the side-by-side comparison in code review trivial.
 *
 * The math is intentionally framework-neutral and React-free; it lives here so
 * the publisher (server-side) and the editor (client-side) share a single
 * implementation.
 */

export const TYPE_RATIO_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '1.067', label: 'Minor Second (1.067)' },
  { value: '1.125', label: 'Major Second (1.125)' },
  { value: '1.2',   label: 'Minor Third (1.2)' },
  { value: '1.25',  label: 'Major Third (1.25)' },
  { value: '1.333', label: 'Perfect Fourth (1.333)' },
  { value: '1.414', label: 'Augmented Fourth (1.414)' },
  { value: '1.5',   label: 'Perfect Fifth (1.5)' },
  { value: '1.6',   label: 'Minor Sixth (1.6)' },
  { value: '1.667', label: 'Golden Ratio (1.667)' },
  { value: '1.778', label: 'Major Sixth (1.778)' },
  { value: '1.875', label: 'Minor Seventh (1.875)' },
]

export const SPACING_RATIO_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...TYPE_RATIO_OPTIONS,
  { value: '1.999', label: 'Major Seventh (1.999)' },
  { value: '2',     label: 'Perfect Octave (2)' },
]

const DEFAULT_ROOT_FONT_SIZE = 10
const DEFAULT_MIN_SCREEN_WIDTH = 320
const DEFAULT_MAX_SCREEN_WIDTH = 1400
const DEFAULT_IS_REM = true
const DEFAULT_TREE_SHAKE_GENERATED_FRAMEWORK_UTILITIES = true

export interface FrameworkPreferences {
  rootFontSize: number
  minScreenWidth: number
  maxScreenWidth: number
  isRem: boolean
  treeShakeGeneratedFrameworkUtilities: boolean
}

export const DEFAULT_FRAMEWORK_PREFERENCES: FrameworkPreferences = {
  rootFontSize: DEFAULT_ROOT_FONT_SIZE,
  minScreenWidth: DEFAULT_MIN_SCREEN_WIDTH,
  maxScreenWidth: DEFAULT_MAX_SCREEN_WIDTH,
  isRem: DEFAULT_IS_REM,
  treeShakeGeneratedFrameworkUtilities: DEFAULT_TREE_SHAKE_GENERATED_FRAMEWORK_UTILITIES,
}

/**
 * Round to two decimals — matches Core Framework `round()` exactly.
 * Used everywhere a value flows into the rendered CSS string so output
 * does not drift between the editor preview and the published page.
 */
function round(value: number): number {
  return Number(value.toFixed(2))
}

function pxToRem(px: number, rootFontSize = 16): string {
  return `${round(px / rootFontSize)}rem`
}

function convertToDesiredUnit(
  value: number | string,
  unit: 'px' | 'rem',
  rootFontSize = 16,
): string {
  if (unit === 'px') return `${value}px`
  if (unit === 'rem') return pxToRem(Number(value), rootFontSize)
  return String(value)
}

/** Slugify a user-entered naming convention into a CSS-safe identifier root. */
function convertSafeCssName(input: string): string {
  return input.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-_]/g, '')
}

/** Convert "name" → "--name", or pass through if it already starts with "--". */
export function convertToVariableDeclarationName(name: string): string {
  const prefixed = name.startsWith('--') ? name : `--${name}`
  return prefixed.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
}

/**
 * Build the per-step variable name for a fluid scale.
 * If the namingConvention contains `{step}` it is replaced; otherwise the
 * step is appended after a dash. Mirrors Core Framework `getVariableName`.
 */
export function getVariableName(namingConvention: string, step: string): string {
  if (namingConvention.includes('{step}')) {
    return `--${namingConvention.replace('{step}', step).replace(/\s/g, '-')}`
  }
  return `--${namingConvention.replace(/\s/g, '-')}-${step}`
}

interface Size {
  size: number
  breakpoint: number
}

export interface FluidScaleStep {
  /** Min size in px (rounded). */
  min: string
  /** Max size in px (rounded). */
  max: string
  /** "<slope>vw + <intercept>" — kept as Core Framework's preferred-string format. */
  preferred: string
}

export interface FluidScaleInput {
  minBaseSize: number
  maxBaseSize: number
  minScaleRatio: number
  maxScaleRatio: number
  steps: number
  baseScaleIndex: number
  minScreenWidth: number
  maxScreenWidth: number
}

/**
 * Compute the per-step (min, max, preferred) tuple for an entire fluid scale.
 * Replicates `getTypeScale` from Core Framework.
 */
export function computeFluidScale({
  minBaseSize,
  maxBaseSize,
  minScaleRatio,
  maxScaleRatio,
  steps,
  baseScaleIndex,
  minScreenWidth,
  maxScreenWidth,
}: FluidScaleInput): FluidScaleStep[] {
  const result: FluidScaleStep[] = []
  for (let stepIdx = 0; stepIdx < steps; stepIdx += 1) {
    const i = stepIdx - baseScaleIndex

    let min: Size = {
      size: Number(minBaseSize) * Math.pow(Number(minScaleRatio), i),
      breakpoint: minScreenWidth,
    }
    let max: Size = {
      size: Number(maxBaseSize) * Math.pow(Number(maxScaleRatio), i),
      breakpoint: maxScreenWidth,
    }

    if (min.size > max.size) {
      ;[min, max] = [max, min]
    }

    const slope = (max.size - min.size) / (max.breakpoint - min.breakpoint)
    const slopeVw = `${round(slope * 100)}vw`
    const intercept = min.size - slope * min.breakpoint

    result.push({
      min: `${round(min.size)}`,
      max: `${round(max.size)}`,
      preferred: `${slopeVw} + ${round(intercept)}`,
    })
  }
  return result
}

/**
 * Build a single `clamp(min, calc(slopeVw + intercept), max)` declaration value
 * from a per-step record. `targetUnit` controls whether the min, intercept and
 * max values come out in `px` or `rem` — `px` is fine for the canvas preview;
 * `rem` is the production default and gives users a single root-font-size knob.
 */
export function declarationFromStep(
  step: FluidScaleStep,
  targetUnit: 'px' | 'rem',
  rootFontSize: number,
): string {
  const minValue = convertToDesiredUnit(Number(step.min), targetUnit, rootFontSize)
  const maxValue = convertToDesiredUnit(Number(step.max), targetUnit, rootFontSize)
  const [slopeVw, intercept] = step.preferred.split(' + ')
  const interceptValue = convertToDesiredUnit(intercept, targetUnit, rootFontSize)
  return `clamp(${minValue}, calc(${slopeVw} + ${interceptValue}), ${maxValue})`
}

/**
 * Effective scale ratio — honours the optional `isCustomScaleRatio` override.
 */
export function effectiveScaleRatio(
  scaleRatio: number | string,
  isCustomScaleRatio: boolean | undefined,
  scaleRatioInputValue: number | undefined,
): number {
  if (isCustomScaleRatio && typeof scaleRatioInputValue === 'number') {
    return Number(scaleRatioInputValue)
  }
  return Number(scaleRatio)
}

/**
 * Produce a fresh CSS-safe step name from a manual size — mirrors how
 * Core Framework names manual entries (e.g. "text-m"). Defensive against
 * whitespace and unsafe characters.
 */
export function manualSizeVariableName(rawName: string): string {
  const safe = convertSafeCssName(rawName)
  return safe || 'size'
}
