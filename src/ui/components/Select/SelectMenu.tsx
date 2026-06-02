import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'
import styles from './Select.module.css'
import { getOptionId, type NormalizedSelectOption } from './SelectOption'
import type { MenuPlacement, MenuSizing } from './useSelectMenuAnchor'

interface SelectMenuProps {
  menuId: string
  anchorRef: RefObject<HTMLElement | null>
  getAnchorRect: () => DOMRect | null
  menuPlacement: MenuPlacement
  menuSizing: MenuSizing
  ariaLabel: string | undefined
  ariaLabelledBy: string | undefined
  options: NormalizedSelectOption[]
  activeIndex: number
  selectedValue: string
  onHover: (index: number) => void
  /**
   * Optional hover-preview hook. Fired with an option's value when the
   * pointer enters its row, so callers can transiently apply the value
   * (e.g. preview a CSS value on the canvas) without committing it.
   */
  onOptionPreview?: (value: string) => void
  onSelect: (value: string) => void
  onClose: () => void
}

export function SelectMenu({
  menuId,
  anchorRef,
  getAnchorRect,
  menuPlacement,
  menuSizing,
  ariaLabel,
  ariaLabelledBy,
  options,
  activeIndex,
  selectedValue,
  onHover,
  onOptionPreview,
  onSelect,
  onClose,
}: SelectMenuProps) {
  return createPortal(
    <ContextMenu
      id={menuId}
      anchorRef={anchorRef}
      getAnchorRect={getAnchorRect}
      side={menuPlacement === 'left-start' ? 'left' : 'auto'}
      align="start"
      offset={6}
      width={menuSizing.width}
      minWidth={menuSizing.minWidth}
      zIndex={10000}
      ariaLabel={ariaLabel ?? 'Select option'}
      aria-labelledby={ariaLabelledBy}
      role="listbox"
      onClose={onClose}
    >
      {options.map((option, index) => (
        <ContextMenuItem
          key={option.value}
          id={getOptionId(menuId, index)}
          active={index === activeIndex}
          role="option"
          aria-selected={option.value === selectedValue}
          disabled={option.disabled}
          data-placeholder-option={option.placeholder ? 'true' : undefined}
          className={option.placeholder ? styles.placeholderOption : undefined}
          tabIndex={-1}
          onMouseEnter={() => {
            if (option.disabled) return
            onHover(index)
            onOptionPreview?.(option.value)
          }}
          onClick={() => onSelect(option.value)}
        >
          {option.icon && (
            <span aria-hidden="true">
              {option.icon}
            </span>
          )}
          <span className={styles.optionLabel}>{option.label}</span>
        </ContextMenuItem>
      ))}
    </ContextMenu>,
    document.body,
  )
}
