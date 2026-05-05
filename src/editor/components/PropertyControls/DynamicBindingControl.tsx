import { useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { PropertyControl, PropertyControlLayout } from '@core/module-engine/types'
import type { DynamicPropBinding } from '@core/page-tree'
import type { LoopSourceField } from '@core/loops/types'
import { Button } from '@ui/components/Button'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { cn } from '@ui/cn'
import styles from './controls.module.css'

interface BindingOption {
  label: string
  binding: DynamicPropBinding
}

interface DynamicBindingControlProps {
  propKey: string
  label: string
  control: PropertyControl
  /**
   * Resolved layout for the bound state. Forwards the parent renderer's
   * layout decision so a stacked image binding doesn't snap back into the
   * 100px label column when a binding is set.
   */
  layout?: PropertyControlLayout
  binding?: DynamicPropBinding
  onSet: (binding: DynamicPropBinding) => void
  onClear: () => void
  /**
   * Fields offered by the closest enclosing scope's source (loop or
   * template). When provided, the picker generates options from these
   * instead of the legacy hard-coded "Current post X" set.
   */
  availableFields?: LoopSourceField[]
  /** Human label for the source — prefixed onto each option for clarity. */
  sourceLabel?: string
  children: ReactNode
}

/**
 * Decide whether a source field is offerable for the given control type.
 *
 * The match is intentionally permissive — the format hint is metadata,
 * not a constraint, so a `plain` text field can be bound to a `text`
 * control AND to an `url` control if the author wants. We only restrict
 * media-shaped fields to media-shaped controls and HTML to richtext.
 */
function fieldMatchesControl(field: LoopSourceField, control: PropertyControl): boolean {
  switch (control.type) {
    case 'image':
      return field.format === 'media'
    case 'media':
      return field.format === 'media'
    case 'richtext':
      return field.format === 'html'
    case 'text':
    case 'textarea':
    case 'url':
    case 'color':
      return field.format !== 'media' && field.format !== 'html'
    default:
      return false
  }
}

function optionsFromSourceFields(
  fields: LoopSourceField[],
  control: PropertyControl,
  sourceLabel: string,
): BindingOption[] {
  const seen = new Set<string>()
  const result: BindingOption[] = []
  for (const field of fields) {
    if (!fieldMatchesControl(field, control)) continue
    // De-dup by `field.id + format` — sources sometimes expose multiple aliases
    // (e.g. featuredMedia/featuredMediaPath/featuredMediaUrl all resolve to the
    // same path). The first alias wins; later duplicates are dropped.
    const key = `${field.id}::${field.format ?? 'plain'}`
    if (seen.has(key)) continue
    seen.add(key)
    const labelPrefix = sourceLabel ? `${sourceLabel} → ` : ''
    result.push({
      label: `${labelPrefix}${field.label}`,
      binding: {
        source: 'currentEntry',
        field: field.id,
        ...(field.format ? { format: field.format } : {}),
      },
    })
  }
  return result
}

/** Hard-coded fallback option set for legacy single-entry template pages. */
function legacyContentEntryOptions(control: PropertyControl): BindingOption[] {
  if (control.type === 'image' || (control.type === 'media' && control.mediaKind === 'image')) {
    return [
      {
        label: 'Current post featured media',
        binding: { source: 'currentEntry', field: 'featuredMedia', format: 'media' },
      },
      {
        label: 'Current post first image',
        binding: { source: 'currentEntry', field: 'firstImage', format: 'media' },
      },
    ]
  }

  if (control.type === 'richtext') {
    return [
      {
        label: 'Current post body',
        binding: { source: 'currentEntry', field: 'body', format: 'html' },
      },
    ]
  }

  if (control.type === 'text' || control.type === 'textarea' || control.type === 'url') {
    return [
      { label: 'Current post title', binding: { source: 'currentEntry', field: 'title' } },
      { label: 'Current post slug', binding: { source: 'currentEntry', field: 'slug' } },
      { label: 'Current post SEO title', binding: { source: 'currentEntry', field: 'seoTitle' } },
      { label: 'Current post SEO description', binding: { source: 'currentEntry', field: 'seoDescription' } },
    ]
  }

  return []
}

function bindingLabelFromFields(
  binding: DynamicPropBinding,
  fields: LoopSourceField[] | undefined,
  sourceLabel: string | undefined,
): string {
  if (fields && fields.length > 0) {
    const match = fields.find((f) => f.id === binding.field)
    if (match) {
      const prefix = sourceLabel ? `${sourceLabel} → ` : ''
      return `${prefix}${match.label}`
    }
  }
  // Fallback to legacy labels for known content-entry field ids.
  switch (binding.field) {
    case 'title': return 'Current post title'
    case 'slug': return 'Current post slug'
    case 'body':
    case 'bodyMarkdown': return 'Current post body'
    case 'featuredMedia':
    case 'featuredMediaPath':
    case 'featuredMediaUrl': return 'Current post featured media'
    case 'firstImage':
    case 'firstImagePath':
    case 'firstImageUrl': return 'Current post first image'
    case 'seoTitle': return 'Current post SEO title'
    case 'seoDescription': return 'Current post SEO description'
    default: return `Current entry ${binding.field}`
  }
}

export function DynamicBindingControl({
  propKey,
  label,
  control,
  layout = 'inline',
  binding,
  onSet,
  onClear,
  availableFields,
  sourceLabel,
  children,
}: DynamicBindingControlProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const options = useMemo(
    () =>
      availableFields && availableFields.length > 0
        ? optionsFromSourceFields(availableFields, control, sourceLabel ?? '')
        : legacyContentEntryOptions(control),
    [availableFields, control, sourceLabel],
  )
  const resolvedBindingLabel = (b: DynamicPropBinding) =>
    bindingLabelFromFields(b, availableFields, sourceLabel)

  if (options.length === 0 && !binding) return <>{children}</>

  if (binding) {
    return (
      <div
        className={cn(
          styles.boundControlWrapper,
          layout === 'stacked' && styles.boundControlWrapperStacked,
        )}
        data-bound="true"
      >
        <div className={styles.labelRow}>
          <label>{label}</label>
        </div>
        <div className={styles.boundValueRow}>
          <Button variant="ghost" size="md" className={styles.boundValueButton} aria-label={resolvedBindingLabel(binding)}>
            {resolvedBindingLabel(binding)}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            iconOnly
            aria-label={`Remove binding for ${label}`}
            tooltip={`Remove binding for ${label}`}
            onClick={onClear}
          >
            <CloseIcon size={11} />
          </Button>
        </div>
      </div>
    )
  }

  // Unbound state — focusing/clicking inside the input wrapper opens the
  // bindings dropdown anchored to the wrapper. Uses the shared ContextMenu
  // primitive so positioning, auto-flip, focus trap, dismiss-on-outside-click
  // and keyboard handling all match the rest of the app's dropdowns.
  return (
    <div
      ref={wrapperRef}
      className={styles.bindingWrapper}
      onFocusCapture={() => setOpen(true)}
      onMouseDownCapture={() => setOpen(true)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      {children}
      {open && createPortal(
        <ContextMenu
          anchorRef={wrapperRef}
          side="auto"
          align="start"
          offset={6}
          width={wrapperRef.current?.getBoundingClientRect().width ?? 240}
          minWidth={wrapperRef.current?.getBoundingClientRect().width ?? 240}
          zIndex={10000}
          ariaLabel={`${label} dynamic bindings`}
          onClose={() => setOpen(false)}
          triggerRef={wrapperRef}
        >
          {options.map((option) => (
            <ContextMenuItem
              key={`${propKey}-${option.binding.field}-${option.binding.format ?? 'plain'}`}
              onClick={() => {
                onSet(option.binding)
                setOpen(false)
              }}
            >
              {option.label}
            </ContextMenuItem>
          ))}
        </ContextMenu>,
        document.body,
      )}
    </div>
  )
}
