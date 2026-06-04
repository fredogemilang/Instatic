/** ClassRenameDialog — modal form for renaming a selector/class. */

import { useState, useRef, useEffect, useId, type FormEvent } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import dialogStyles from '../../../../shared/dialogs/SiteCreateDialog/SiteCreateDialog.module.css'

const CLASS_RENAME_FORM_ID = 'class-rename-form'

export function ClassRenameDialog({
  initialValue,
  onCancel,
  onRename,
}: {
  initialValue: string
  onCancel: () => void
  onRename: (name: string) => void
}) {
  const [name, setName] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const trimmedName = name.trim()
  const nameInputId = useId()

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.select())
  }, [])

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trimmedName) return

    try {
      onRename(trimmedName)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^\[[^\]]+\]\s*/, '') : 'Unable to rename class')
    }
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      title="Rename selector"
      size="sm"
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            form={CLASS_RENAME_FORM_ID}
            disabled={!trimmedName}
          >
            Save
          </Button>
        </>
      }
    >
      <form id={CLASS_RENAME_FORM_ID} className={dialogStyles.form} onSubmit={handleSubmit}>
        <div className={dialogStyles.field}>
          <label htmlFor={nameInputId} className={dialogStyles.label}>Name</label>
          <Input
            id={nameInputId}
            ref={inputRef}
            fieldSize="sm"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
            aria-label="Class name"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {error && <p role="alert" className={dialogStyles.errorText}>{error}</p>}
      </form>
    </Dialog>
  )
}
