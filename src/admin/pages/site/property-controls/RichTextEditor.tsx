/**
 * RichTextEditor — contentEditable-based rich text control for the properties panel.
 *
 * Design constraints:
 *   - No external rich-text library (no Tiptap, Slate, Quill, Lexical).
 *   - Formatting via document.execCommand (deprecated but universally supported;
 *     output is sanitized on blur by DOMPurify).
 *   - Value synced via ref — never through dangerouslySetInnerHTML — to avoid
 *     cursor-reset on every keystroke.
 *   - onChange is ONLY called with sanitized output (sanitizeRichtext).
 *   - CSS Modules + achromatic tokens only.
 */

import { useRef, useEffect, useState } from 'react'
import { cn } from '@ui/cn'
import { Button } from '@ui/components/Button'
import { Input } from '@ui/components/Input'
import { BoldIcon } from 'pixel-art-icons/icons/bold'
import { ItalicIcon } from 'pixel-art-icons/icons/italic'
import { UnderlineIcon } from 'pixel-art-icons/icons/underline'
import { LinkIcon } from 'pixel-art-icons/icons/link'
import { EraserSolidIcon } from 'pixel-art-icons/icons/eraser-solid'
import { sanitizeRichtext } from '@core/sanitize'
import styles from './RichTextEditor.module.css'

export interface RichTextEditorProps {
  value: string
  onChange: (sanitized: string) => void
  ariaLabel?: string
  disabled?: boolean
}

export function RichTextEditor({
  value,
  onChange,
  ariaLabel = 'Rich text editor',
  disabled = false,
}: RichTextEditorProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)
  // Track the last HTML we injected so we don't overwrite cursor position
  // when the parent echoes the same sanitized value back as a prop.
  const lastSetHtmlRef = useRef<string | null>(null)
  // Saved selection range when the link strip is opened.
  const savedRangeRef = useRef<Range | null>(null)

  // Toolbar active (pressed) states
  const [boldActive, setBoldActive] = useState(false)
  const [italicActive, setItalicActive] = useState(false)
  const [underlineActive, setUnderlineActive] = useState(false)

  // Link strip visibility + URL input value
  const [showLinkStrip, setShowLinkStrip] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  // ── Value initialisation ───────────────────────────────────────────────────
  // Inject value once on mount and whenever the prop changes to something
  // we didn't set ourselves (e.g. external undo/redo or programmatic update).
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (lastSetHtmlRef.current !== value) {
      el.innerHTML = value
      lastSetHtmlRef.current = value
    }
  }, [value])

  // ── Link-strip focus ──────────────────────────────────────────────────────
  // Focus the URL input imperatively when the strip opens, matching the
  // requestAnimationFrame pattern used elsewhere in the editor for deferred focus.
  useEffect(() => {
    if (!showLinkStrip) return
    const id = requestAnimationFrame(() => linkInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [showLinkStrip])

  // ── Formatting state refresh ───────────────────────────────────────────────
  const refreshFormattingState = () => {
    setBoldActive(document.queryCommandState('bold'))
    setItalicActive(document.queryCommandState('italic'))
    setUnderlineActive(document.queryCommandState('underline'))
  }

  // ── Root blur — save only when focus leaves the whole component ────────────
  const handleRootBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    // relatedTarget is the element receiving focus next.
    // If it's still inside this component (e.g. link strip Input), don't save.
    if (rootRef.current?.contains(e.relatedTarget as Node | null)) return
    const el = editorRef.current
    if (!el) return
    const sanitized = sanitizeRichtext(el.innerHTML)
    lastSetHtmlRef.current = sanitized
    onChange(sanitized)
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    const meta = e.metaKey || e.ctrlKey
    if (meta && e.key === 'b') {
      e.preventDefault()
      document.execCommand('bold', false)
      refreshFormattingState()
    } else if (meta && e.key === 'i') {
      e.preventDefault()
      document.execCommand('italic', false)
      refreshFormattingState()
    } else if (meta && e.key === 'u') {
      e.preventDefault()
      document.execCommand('underline', false)
      refreshFormattingState()
    }
  }

  // ── Toolbar handlers ───────────────────────────────────────────────────────
  // All toolbar buttons use onMouseDown + e.preventDefault() to keep the
  // contentEditable focused (and thus its selection intact) while the button
  // is being pressed.

  const handleBold = (e: React.MouseEvent) => {
    e.preventDefault()
    document.execCommand('bold', false)
    refreshFormattingState()
  }

  const handleItalic = (e: React.MouseEvent) => {
    e.preventDefault()
    document.execCommand('italic', false)
    refreshFormattingState()
  }

  const handleUnderline = (e: React.MouseEvent) => {
    e.preventDefault()
    document.execCommand('underline', false)
    refreshFormattingState()
  }

  const handleClearFormat = (e: React.MouseEvent) => {
    e.preventDefault()
    document.execCommand('removeFormat', false)
    document.execCommand('unlink', false)
    refreshFormattingState()
  }

  // ── Link strip ─────────────────────────────────────────────────────────────
  const handleLinkMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    // Capture the current selection before the strip opens and the Input
    // takes focus (which would clear the editor's selection).
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) {
      savedRangeRef.current = selection.getRangeAt(0).cloneRange()
    } else {
      savedRangeRef.current = null
    }
    setShowLinkStrip(true)
    setLinkUrl('')
  }

  const restoreEditorSelection = () => {
    editorRef.current?.focus()
    const range = savedRangeRef.current
    if (!range) return
    const selection = window.getSelection()
    if (selection) {
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }

  const handleLinkApply = () => {
    const url = linkUrl.trim()
    if (!url) {
      setShowLinkStrip(false)
      savedRangeRef.current = null
      return
    }

    // Return focus to editor and restore the saved selection so execCommand
    // operates on the right range.
    restoreEditorSelection()

    const selection = window.getSelection()
    const hasSelection = selection && selection.toString().length > 0

    if (hasSelection) {
      // Wrap the selected text in an <a>.
      document.execCommand('createLink', false, url)
    } else {
      // No selection — insert a new link with the URL as visible text.
      // Use Range.insertNode rather than execCommand('insertHTML', outerHTML)
      // to avoid a text→HTML round-trip (CodeQL js/xss-through-dom). The
      // sanitizeRichtext pass below is still the authoritative defence
      // against javascript: hrefs, but inserting the DOM node directly
      // means we never re-parse a serialized string in the first place.
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.textContent = url

      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        range.insertNode(anchor)
        range.setStartAfter(anchor)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
      } else {
        editorRef.current?.appendChild(anchor)
      }
    }

    setShowLinkStrip(false)
    setLinkUrl('')
    savedRangeRef.current = null

    // Persist immediately after link insertion rather than waiting for blur.
    const el = editorRef.current
    if (el) {
      const sanitized = sanitizeRichtext(el.innerHTML)
      lastSetHtmlRef.current = sanitized
      onChange(sanitized)
    }
  }

  const handleLinkCancel = () => {
    setShowLinkStrip(false)
    setLinkUrl('')
    savedRangeRef.current = null
    editorRef.current?.focus()
  }

  const handleLinkKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleLinkApply()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleLinkCancel()
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div
      ref={rootRef}
      className={cn(styles.root, disabled && styles.rootDisabled)}
      onBlur={handleRootBlur}
    >
      {/* ── Toolbar ── */}
      <div
        className={styles.toolbar}
        role="toolbar"
        aria-label="Text formatting"
        aria-controls="rte-editable"
      >
        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Bold"
          tooltip="Bold (Ctrl+B)"
          pressed={boldActive}
          disabled={disabled}
          onMouseDown={handleBold}
        >
          <BoldIcon size={14} />
        </Button>

        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Italic"
          tooltip="Italic (Ctrl+I)"
          pressed={italicActive}
          disabled={disabled}
          onMouseDown={handleItalic}
        >
          <ItalicIcon size={14} />
        </Button>

        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Underline"
          tooltip="Underline (Ctrl+U)"
          pressed={underlineActive}
          disabled={disabled}
          onMouseDown={handleUnderline}
        >
          <UnderlineIcon size={14} />
        </Button>

        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Insert link"
          tooltip="Link"
          disabled={disabled}
          onMouseDown={handleLinkMouseDown}
        >
          <LinkIcon size={14} />
        </Button>

        <Button
          variant="ghost"
          size="xs"
          iconOnly
          aria-label="Clear formatting"
          tooltip="Clear formatting"
          disabled={disabled}
          onMouseDown={handleClearFormat}
        >
          <EraserSolidIcon size={14} />
        </Button>
      </div>

      {/* ── Link strip (inline URL entry) ── */}
      {showLinkStrip && (
        <div className={styles.linkStrip}>
          <div className={styles.linkStripInput}>
            <Input
              ref={linkInputRef}
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={handleLinkKeyDown}
              placeholder="https://"
              fieldSize="xs"
              aria-label="Link URL"
            />
          </div>
          <Button
            variant="secondary"
            size="xs"
            onClick={handleLinkApply}
          >
            Apply
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={handleLinkCancel}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* ── Editable area ── */}
      <div
        id="rte-editable"
        ref={editorRef}
        className={styles.editable}
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={handleKeyDown}
        onSelect={refreshFormattingState}
        onKeyUp={refreshFormattingState}
        onMouseUp={refreshFormattingState}
        suppressContentEditableWarning
      />
    </div>
  )
}
