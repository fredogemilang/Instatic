import {
  forwardRef,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from 'react'
import { ChevronDownIcon } from 'pixel-art-icons/icons/chevron-down'
import { cn } from '@ui/cn'
import styles from './Select.module.css'
import {
  getInitialActiveIndex,
  getOptionId,
  isEnabledOptionIndex,
  normalizeOptions,
  type SelectOption,
} from './SelectOption'
import { useSelectMenuAnchor, type MenuPlacement } from './useSelectMenuAnchor'
import { useSelectValue } from './useSelectValue'
import { handleSelectKeyDown } from './selectKeyboard'
import { SelectMenu } from './SelectMenu'

type FieldSize = 'xs' | 'sm' | 'md'
type TextEmphasis = 'default' | 'strong'

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  invalid?: boolean
  fieldSize?: FieldSize
  emphasis?: TextEmphasis
  menuMinWidth?: number
  menuPlacement?: MenuPlacement
  /**
   * Optional element whose bounding rect provides the dropdown's horizontal
   * anchor (left edge + width). When unset, the trigger's own rect is used.
   *
   * Useful when the trigger is a narrow cell in a multi-column layout but the
   * option labels are too long to fit the cell — the dropdown can span a
   * wider parent (e.g. the full grid row) so labels stay fully readable
   * instead of being truncated to the cell width.
   *
   * Vertical positioning still anchors to the trigger so the menu opens just
   * below it; only the `x` and `width` come from the anchor element.
   *
   * Ignored when `menuPlacement === 'left-start'` (left-anchored placement
   * needs trigger-relative coordinates to stay aligned with the trigger row).
   */
  menuAnchorRef?: React.RefObject<HTMLElement | null>
  options?: SelectOption[]
  placeholder?: string
  'data-testid'?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    className,
    invalid = false,
    fieldSize = 'md',
    emphasis = 'default',
    options,
    children,
    disabled = false,
    value,
    defaultValue,
    onChange,
    id,
    name,
    required,
    placeholder,
    menuMinWidth,
    menuPlacement = 'bottom-start',
    menuAnchorRef,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    'data-testid': dataTestId,
    ...props
  },
  ref,
) {
  const generatedId = useId()
  const triggerId = id ?? `select-${generatedId}`
  const menuId = `${triggerId}-menu`

  const normalizedOptions = useMemo(
    () => normalizeOptions(options, children),
    [options, children],
  )

  const {
    isControlled,
    selectedValue,
    selectedOption,
    selectedText,
    showPlaceholder,
    setInternalValue,
  } = useSelectValue({ value, defaultValue, placeholder, normalizedOptions })

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  const nativeSelectRef = useRef<HTMLSelectElement | null>(null)
  const selectRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLInputElement | null>(null)

  // The dropdown's dismiss anchor is ALWAYS the Select's own wrapper —
  // not a wider parent the caller may pass via `menuAnchorRef`. This is
  // critical for two UX behaviours:
  //
  //   1. Clicking another Select that lives inside the same wider parent
  //      (e.g. two ratio selects sharing one `baseSettings` row) closes
  //      the currently open menu, so opening the new one feels seamless.
  //   2. Clicking the trigger of an open menu toggles it closed (the
  //      `onClick` handler reads `open` and routes to closeMenu). If the
  //      wider parent gated dismiss, mousedown wouldn't fire onClose, but
  //      the click would still be eaten by the open menu's own logic.
  //
  // The wider `menuAnchorRef` only contributes to the menu's HORIZONTAL
  // extent (width + x for left edge) via `getAnchorRect()` and the
  // `menuSizing.width` prop — both used purely for layout.
  const resolvedAnchorRef = useRef<HTMLElement | null>(null)

  const { menuSizing, getAnchorRect, updateMenuSizing, clearMenuSizing } = useSelectMenuAnchor({
    open,
    menuPlacement,
    menuAnchorRef,
    menuMinWidth,
    selectRef,
  })

  const resolvedActiveIndex =
    open && isEnabledOptionIndex(normalizedOptions, activeIndex)
      ? activeIndex
      : getInitialActiveIndex(normalizedOptions, selectedValue)
  const activeOptionId =
    open && resolvedActiveIndex >= 0 ? getOptionId(menuId, resolvedActiveIndex) : undefined

  const setSelectRef = useCallback(
    (node: HTMLSelectElement | null) => {
      nativeSelectRef.current = node
      assignRef(ref, node)
    },
    [ref],
  )

  const closeMenu = useCallback(() => {
    setOpen(false)
    setActiveIndex(-1)
    clearMenuSizing()
    resolvedAnchorRef.current = null
  }, [clearMenuSizing])

  const openMenu = useCallback(() => {
    if (disabled) return
    // The dismiss anchor is always the Select itself. See comment on
    // `resolvedAnchorRef` for why this matters.
    resolvedAnchorRef.current = selectRef.current
    updateMenuSizing()
    setActiveIndex(getInitialActiveIndex(normalizedOptions, selectedValue))
    setOpen(true)
  }, [disabled, normalizedOptions, selectedValue, updateMenuSizing])

  const commitValue = useCallback(
    (nextValue: string) => {
      if (disabled) return
      if (!isControlled) setInternalValue(nextValue)
      closeMenu()

      const select = nativeSelectRef.current
      if (select) select.value = nextValue
      onChange?.({
        target: select ?? ({ value: nextValue, name } as HTMLSelectElement),
        currentTarget: select ?? ({ value: nextValue, name } as HTMLSelectElement),
      } as ChangeEvent<HTMLSelectElement>)
      requestAnimationFrame(() => triggerRef.current?.focus())
    },
    [closeMenu, disabled, isControlled, name, onChange, setInternalValue],
  )

  function handleNativeChange(event: ChangeEvent<HTMLSelectElement>) {
    if (!isControlled) setInternalValue(event.target.value)
    onChange?.(event)
  }

  function handleTriggerChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value
    const matchingOption = normalizedOptions.find(
      (option) => option.value === next || option.textValue === next,
    )
    if (matchingOption && !matchingOption.disabled) {
      commitValue(matchingOption.value)
    }
  }

  function handleSelectClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target
    if (
      event.defaultPrevented ||
      disabled ||
      !(target instanceof Node) ||
      !selectRef.current?.contains(target)
    ) {
      return
    }
    triggerRef.current?.focus()
    // Toggle so a second click on the trigger closes an already-open menu.
    // The document-level mousedown listener inside ContextMenu does NOT fire
    // for this click (the trigger is `anchorRef.current`, so dismiss is
    // suppressed), which would otherwise leave the menu permanently open.
    if (open) {
      closeMenu()
    } else {
      openMenu()
    }
  }

  function handleTriggerKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    handleSelectKeyDown(event, {
      open,
      options: normalizedOptions,
      activeIndex: resolvedActiveIndex,
      setActiveIndex,
      openMenu,
      closeMenu,
      commitValue,
    })
  }

  return (
    <div
      ref={selectRef}
      className={cn(
        styles.select,
        styles[`size-${fieldSize}`],
        invalid && styles.invalid,
        disabled && styles.disabled,
        className,
      )}
      data-emphasis={emphasis !== 'default' ? emphasis : undefined}
      data-open={open ? 'true' : undefined}
      onClick={handleSelectClick}
    >
      <select
        ref={setSelectRef}
        id={`${triggerId}-native`}
        name={name}
        required={required}
        disabled={disabled}
        value={selectedValue}
        onChange={handleNativeChange}
        tabIndex={-1}
        aria-hidden="true"
        className={styles.nativeSelect}
        {...props}
      >
        {options ? (
          normalizedOptions.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.textValue}
            </option>
          ))
        ) : children}
      </select>

      {selectedOption?.icon && (
        <span aria-hidden="true" className={styles.leadingIcon}>
          <SelectIcon icon={selectedOption.icon} />
        </span>
      )}

      <input
        ref={triggerRef}
        id={triggerId}
        role="combobox"
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={activeOptionId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={invalid || props['aria-invalid'] ? true : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        data-testid={dataTestId}
        data-placeholder={showPlaceholder ? 'true' : undefined}
        disabled={disabled}
        readOnly
        value={selectedText}
        placeholder={placeholder}
        onChange={handleTriggerChange}
        onKeyDown={handleTriggerKeyDown}
        className={styles.trigger}
      />

      <span aria-hidden="true" className={styles.chevron}>
        <ChevronDownIcon size={12} />
      </span>

      {open && menuSizing && (
        <SelectMenu
          menuId={menuId}
          anchorRef={resolvedAnchorRef}
          getAnchorRect={getAnchorRect}
          menuPlacement={menuPlacement}
          menuSizing={menuSizing}
          ariaLabel={ariaLabel}
          ariaLabelledBy={ariaLabelledBy}
          options={normalizedOptions}
          activeIndex={resolvedActiveIndex}
          selectedValue={selectedValue}
          onHover={setActiveIndex}
          onSelect={commitValue}
          onClose={closeMenu}
        />
      )}
    </div>
  )
})

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return
  if (typeof ref === 'function') {
    ref(value)
  } else {
    ref.current = value
  }
}

function SelectIcon({ icon }: { icon: ReactNode }) {
  return icon
}
