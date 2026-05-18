/**
 * Users → Users tab.
 *
 * Lists every CMS user with their role, status and last-login time. The
 * action menu on each row exposes Edit / Reset password / Suspend (or
 * Activate) / Delete. The owner row has no actions — owner accounts are
 * permanent and immutable from the admin UI.
 *
 * Every mutation goes through `runStepUp` so the server-side step-up auth
 * gate gets a chance to re-prompt for the admin's password if the session
 * has no fresh window. Cancelling the step-up dialog resolves silently
 * (we match on `StepUpCancelledMessage`).
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { consumePendingAction } from '@admin/spotlight/pendingAction'
import { Button } from '@ui/components/Button'
import {
  DataTable,
  DataTableBody,
  DataTableCell,
  DataTableHead,
  DataTableHeader,
  DataTableRow,
} from '@ui/components/DataTable'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { EditSolidIcon } from 'pixel-art-icons/icons/edit-solid'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import {
  createCmsUser,
  deleteCmsUser,
  updateCmsUser,
  type CmsCurrentUser,
} from '@core/persistence'
import { StepUpCancelledMessage, useStepUp } from '@admin/shared/StepUp'
import { Badge } from '../components/Badge'
import { RowActionMenu } from '../components/RowActionMenu'
import { UserDialog } from '../components/UserDialog'
import { displayUserName, formatDateTime, isOwnerUser, statusLabel } from '../utils/format'
import {
  emptyUserForm,
  type UserDialogMode,
  type UserFormState,
} from '../types'
import type { UsersPageData } from '../hooks/useUsersPageData'
import styles from '../UsersPage.module.css'

interface UsersTabProps {
  data: UsersPageData
  canManageUsers: boolean
}

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active', textValue: 'Active' },
  { value: 'suspended', label: 'Suspended', textValue: 'Suspended' },
] as const

export function UsersTab({ data, canManageUsers }: UsersTabProps) {
  const { users, roles, defaultAssignableRoleId, setUsers, setError, refresh, error } = data
  const { runStepUp } = useStepUp()
  const [busy, setBusy] = useState(false)
  const [userForm, setUserForm] = useState<UserFormState>(() => ({
    ...emptyUserForm,
    roleId: defaultAssignableRoleId,
  }))
  const [dialogMode, setDialogMode] = useState<UserDialogMode | null>(null)
  const [editingUserId, setEditingUserId] = useState<string | null>(null)

  const assignableRoleOptions = useMemo(
    () =>
      roles
        .filter((role) => role.id !== 'owner')
        .map((role) => ({ value: role.id, label: role.name, textValue: role.name })),
    [roles],
  )

  function closeDialog() {
    setDialogMode(null)
    setEditingUserId(null)
    setUserForm({ ...emptyUserForm, roleId: defaultAssignableRoleId })
  }

  function openCreate() {
    if (!canManageUsers) return
    setEditingUserId(null)
    setUserForm({ ...emptyUserForm, roleId: defaultAssignableRoleId })
    setDialogMode('create')
    setError(null)
  }

  // Auto-open the invite dialog when the spotlight queued a `users.invite`
  // action while the user was on a different workspace. Only consume the
  // action once `canManageUsers` is true — otherwise openCreate's capability
  // guard would swallow the action and we'd have spent it for nothing.
  // We use queueMicrotask (not setTimeout) so the setState fires on the same
  // task: setTimeout(0) cleanup can race the timer when a fast navigation
  // tears the tab back down before the macrotask runs, which would lose
  // the dialog.
  useEffect(() => {
    if (!canManageUsers) return
    const pending = consumePendingAction('users.invite')
    if (!pending) return
    queueMicrotask(() => openCreate())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManageUsers])

  function openEdit(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    setEditingUserId(user.id)
    setUserForm({
      email: user.email,
      displayName: user.displayName,
      password: '',
      roleId: user.role.id === 'owner' ? defaultAssignableRoleId : user.role.id,
      status: user.status,
    })
    setDialogMode('edit')
    setError(null)
  }

  function openResetPassword(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    setEditingUserId(user.id)
    setUserForm({
      email: user.email,
      displayName: user.displayName,
      password: '',
      roleId: user.role.id === 'owner' ? defaultAssignableRoleId : user.role.id,
      status: user.status,
    })
    setDialogMode('reset')
    setError(null)
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canManageUsers || !dialogMode) return
    if ((dialogMode === 'create' || dialogMode === 'reset' || userForm.password) && userForm.password.length < 12) {
      setError('Password must be at least 12 characters')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (dialogMode === 'reset') {
        if (!editingUserId) throw new Error('No user selected')
        await runStepUp(() => updateCmsUser(editingUserId, { password: userForm.password }))
      } else if (dialogMode === 'edit') {
        if (!editingUserId) throw new Error('No user selected')
        const user = await runStepUp(() => updateCmsUser(editingUserId, {
          email: userForm.email,
          displayName: userForm.displayName,
          roleId: userForm.roleId,
          status: userForm.status,
          ...(userForm.password ? { password: userForm.password } : {}),
        }))
        setUsers((current) => current.map((candidate) => candidate.id === user.id ? user : candidate))
      } else {
        const user = await runStepUp(() => createCmsUser({
          email: userForm.email,
          displayName: userForm.displayName,
          password: userForm.password,
          roleId: userForm.roleId,
        }))
        setUsers((current) => [...current, user])
      }
      closeDialog()
      void refresh()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      setError(err instanceof Error ? err.message : 'Could not save user')
    } finally {
      setBusy(false)
    }
  }

  async function toggleStatus(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    setBusy(true)
    setError(null)
    try {
      const updated = await runStepUp(() => updateCmsUser(user.id, {
        status: user.status === 'active' ? 'suspended' : 'active',
      }))
      setUsers((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate))
      void refresh()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      setError(err instanceof Error ? err.message : 'Could not update user')
    } finally {
      setBusy(false)
    }
  }

  async function remove(user: CmsCurrentUser) {
    if (!canManageUsers || isOwnerUser(user)) return
    setBusy(true)
    setError(null)
    try {
      // Step-up gated server-side; the runner re-prompts for password
      // when the session has no fresh window. Cancelling the dialog
      // resolves silently without surfacing an error.
      await runStepUp(() => deleteCmsUser(user.id))
      setUsers((current) => current.filter((candidate) => candidate.id !== user.id))
      void refresh()
    } catch (err) {
      if (err instanceof Error && err.message === StepUpCancelledMessage) return
      setError(err instanceof Error ? err.message : 'Could not delete user')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby="all-users-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="all-users-title">All Users</h2>
          <p>{users.length} account{users.length === 1 ? '' : 's'} with admin access.</p>
        </div>
        {canManageUsers && (
          <Button type="button" variant="primary" size="sm" onClick={openCreate}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Create User</span>
          </Button>
        )}
      </div>
      {users.length > 0 ? (
        <DataTable aria-label="Users" density="compact">
          <DataTableHead>
            <DataTableRow>
              <DataTableHeader scope="col">User</DataTableHeader>
              <DataTableHeader scope="col">Access</DataTableHeader>
              <DataTableHeader scope="col">Last login</DataTableHeader>
              <DataTableHeader scope="col" className={styles.actionsHeader}>Actions</DataTableHeader>
            </DataTableRow>
          </DataTableHead>
          <DataTableBody>
            {users.map((user) => {
              const owner = isOwnerUser(user)
              const label = displayUserName(user)
              return (
                <DataTableRow key={user.id} aria-label={`User ${user.email}`}>
                  <DataTableCell>
                    <div className={styles.identity}>
                      <strong>{label}</strong>
                      <span>{user.email}</span>
                    </div>
                  </DataTableCell>
                  <DataTableCell>
                    <div className={styles.badges}>
                      <Badge label={statusLabel(user.status)} />
                      <Badge label={user.role.name} />
                      {owner && <Badge label="Owner account" muted />}
                    </div>
                  </DataTableCell>
                  <DataTableCell>
                    <span className={styles.secondaryText}>{formatDateTime(user.lastLoginAt)}</span>
                  </DataTableCell>
                  <DataTableCell className={styles.actionsCell}>
                    {canManageUsers && !owner && (
                      <RowActionMenu
                        triggerLabel={`Actions for ${label}`}
                        menuLabel={`User actions for ${label}`}
                        disabled={busy}
                        items={[
                          {
                            label: 'Edit',
                            icon: <EditSolidIcon size={12} aria-hidden="true" />,
                            onSelect: () => openEdit(user),
                          },
                          {
                            label: 'Reset password',
                            icon: <SaveSolidIcon size={12} aria-hidden="true" />,
                            onSelect: () => openResetPassword(user),
                          },
                          {
                            label: user.status === 'active' ? 'Suspend' : 'Activate',
                            icon: <EditSolidIcon size={12} aria-hidden="true" />,
                            onSelect: () => void toggleStatus(user),
                          },
                          {
                            label: 'Delete',
                            icon: <TrashSolidIcon size={12} aria-hidden="true" />,
                            danger: true,
                            onSelect: () => void remove(user),
                          },
                        ]}
                      />
                    )}
                  </DataTableCell>
                </DataTableRow>
              )
            })}
          </DataTableBody>
        </DataTable>
      ) : (
        <p className={styles.emptyState}>No users yet.</p>
      )}

      {canManageUsers && dialogMode && (
        <UserDialog
          mode={dialogMode}
          form={userForm}
          roleOptions={assignableRoleOptions}
          statusOptions={[...STATUS_OPTIONS]}
          busy={busy}
          error={error}
          onChange={setUserForm}
          onClose={closeDialog}
          onSubmit={handleSave}
        />
      )}
    </section>
  )
}
