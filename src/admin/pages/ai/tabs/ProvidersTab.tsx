/**
 * Providers tab — list, add, test, delete AI provider credentials.
 *
 * Every credential is per-user (handled server-side); the view shown here
 * is the wire-safe `CredentialView` (no plaintext, no ciphertext).
 */

import { useEffect, useId, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Dialog } from '@ui/components/Dialog'
import { Input } from '@ui/components/Input'
import { Select } from '@ui/components/Select'
import { PlusIcon } from 'pixel-art-icons/icons/plus'
import { TrashSolidIcon } from 'pixel-art-icons/icons/trash-solid'
import { CheckIcon } from 'pixel-art-icons/icons/check'
import {
  type CredentialView,
  type CreateCredentialBody,
  type TestResult,
  createCredential,
  deleteCredential,
  listCredentials,
  testCredential,
} from '../../../ai/api'
import { ApiError } from '@core/http'
import styles from '../AiPage.module.css'

type ProviderId = 'anthropic' | 'openai' | 'ollama'
type AuthMode = 'apiKey' | 'baseUrl'

// Anthropic + OpenAI require an API key. Ollama uses a local endpoint
// URL with an optional bearer token for proxied installs.
const PROVIDERS: Array<{ id: ProviderId; label: string; modes: AuthMode[] }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)', modes: ['apiKey'] },
  { id: 'openai', label: 'OpenAI', modes: ['apiKey'] },
  { id: 'ollama', label: 'Ollama (local)', modes: ['baseUrl'] },
]

const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  apiKey: 'API key',
  baseUrl: 'Endpoint URL',
}

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
}

export function ProvidersTab() {
  const [credentials, setCredentials] = useState<CredentialView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  const [testResults, setTestResults] = useState<Record<string, TestResult & { ts: number }>>({})
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  // Bump this to force a re-load (after create / delete). Avoids the
  // `react-hooks/set-state-in-effect` lint by funneling all loads through
  // a single effect whose dependency is a plain primitive.
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        setError(null)
        const list = await listCredentials()
        if (cancelled) return
        setCredentials(list)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load credentials.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [refreshKey])

  async function handleDelete(id: string) {
    setBusyIds((prev) => new Set(prev).add(id))
    try {
      await deleteCredential(id)
      setRefreshKey((n) => n + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete credential.')
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  async function handleTest(id: string) {
    setBusyIds((prev) => new Set(prev).add(id))
    try {
      const result = await testCredential(id)
      setTestResults((prev) => ({ ...prev, [id]: { ...result, ts: Date.now() } }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed.'
      setTestResults((prev) => ({ ...prev, [id]: { ok: false, error: message, ts: Date.now() } }))
    } finally {
      setBusyIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Credentials</h2>
          <p>API keys for each AI provider. Plaintext is encrypted at rest.</p>
        </div>
        <Button type="button" variant="primary" size="sm" onClick={() => setShowDialog(true)}>
          <PlusIcon size={14} aria-hidden="true" />
          <span>Add credential</span>
        </Button>
      </div>

      {error && <p role="alert" className={styles.errorAlert}>{error}</p>}

      {loading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : credentials.length === 0 ? (
        <div className={styles.emptyState}>
          No credentials yet. Add one to start using AI features.
        </div>
      ) : (
        <div className={styles.credentialGrid}>
          {credentials.map((cred) => {
            const isBusy = busyIds.has(cred.id)
            const result = testResults[cred.id]
            return (
              <div key={cred.id} className={styles.credentialCard}>
                <div className={styles.credentialIdentity}>
                  <div className={styles.credentialLabel}>{cred.displayLabel}</div>
                  <div className={styles.credentialMeta}>
                    <span>{PROVIDER_LABEL[cred.providerId]}</span>
                    <span>·</span>
                    <span>{AUTH_MODE_LABEL[cred.authMode]}</span>
                    {!cred.keyFingerprintCurrent && (
                      <span className={`${styles.statusBadge} ${styles.warning}`}>
                        Master key rotated — re-enter
                      </span>
                    )}
                    {cred.lastUsedAt && (
                      <>
                        <span>·</span>
                        <span>Last used {new Date(cred.lastUsedAt).toLocaleString()}</span>
                      </>
                    )}
                  </div>
                  {result && (
                    <p
                      role="status"
                      className={`${styles.testResult} ${result.ok ? styles.success : styles.danger}`}
                    >
                      {result.ok
                        ? `✓ Test ok (${result.modelCount ?? 0} models available)`
                        : `✗ ${result.error ?? 'Test failed.'}`}
                    </p>
                  )}
                </div>
                <div className={styles.credentialActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleTest(cred.id)}
                    disabled={isBusy}
                  >
                    <CheckIcon size={14} aria-hidden="true" />
                    <span>Test</span>
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void handleDelete(cred.id)}
                    disabled={isBusy}
                  >
                    <TrashSolidIcon size={14} aria-hidden="true" />
                    <span>Delete</span>
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showDialog && (
        <AddCredentialDialog
          onClose={() => setShowDialog(false)}
          onCreated={() => {
            setShowDialog(false)
            setRefreshKey((n) => n + 1)
          }}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Add credential dialog
// ---------------------------------------------------------------------------

function AddCredentialDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const providerInputId = useId()
  const authModeInputId = useId()
  const labelInputId = useId()
  const apiKeyInputId = useId()
  const baseUrlInputId = useId()
  const formId = useId()

  const [providerId, setProviderId] = useState<ProviderId>('anthropic')
  const [authMode, setAuthMode] = useState<AuthMode>('apiKey')
  const [displayLabel, setDisplayLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerSpec = PROVIDERS.find((p) => p.id === providerId)!
  const availableModes = providerSpec.modes

  // Coerce auth mode when provider changes if it's no longer supported.
  const effectiveAuthMode = availableModes.includes(authMode) ? authMode : availableModes[0]!

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const body: CreateCredentialBody =
        effectiveAuthMode === 'apiKey' ? {
          providerId, authMode: 'apiKey', displayLabel, apiKey,
        } : {
          providerId, authMode: 'baseUrl', displayLabel, baseUrl,
          ...(apiKey ? { apiKey } : {}),
        }
      await createCredential(body)
      onCreated()
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Failed to create credential.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add AI credential"
      size="md"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            <span>Cancel</span>
          </Button>
          <Button type="submit" form={formId} variant="primary" size="sm" disabled={busy}>
            <PlusIcon size={14} aria-hidden="true" />
            <span>Add credential</span>
          </Button>
        </>
      }
    >
      <form id={formId} className={styles.dialogForm} onSubmit={(e) => void handleSubmit(e)}>
        <div className={styles.dialogField}>
          <label htmlFor={providerInputId} className={styles.dialogFieldLabel}>Provider</label>
          <Select
            id={providerInputId}
            value={providerId}
            onChange={(e) => setProviderId(e.currentTarget.value as ProviderId)}
            options={PROVIDERS.map((p) => ({ value: p.id, label: p.label }))}
          />
        </div>

        <div className={styles.dialogField}>
          <label htmlFor={authModeInputId} className={styles.dialogFieldLabel}>Authentication</label>
          <Select
            id={authModeInputId}
            value={effectiveAuthMode}
            onChange={(e) => setAuthMode(e.currentTarget.value as AuthMode)}
            options={availableModes.map((m) => ({ value: m, label: AUTH_MODE_LABEL[m] }))}
          />
        </div>

        <div className={styles.dialogField}>
          <label htmlFor={labelInputId} className={styles.dialogFieldLabel}>Display label</label>
          <Input
            id={labelInputId}
            value={displayLabel}
            onChange={(e) => setDisplayLabel(e.currentTarget.value)}
            placeholder="e.g. Production"
            required
          />
        </div>

        {effectiveAuthMode === 'apiKey' && (
          <div className={styles.dialogField}>
            <label htmlFor={apiKeyInputId} className={styles.dialogFieldLabel}>API key</label>
            <Input
              id={apiKeyInputId}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
              placeholder={providerId === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
              autoComplete="off"
              required
            />
          </div>
        )}

        {effectiveAuthMode === 'baseUrl' && (
          <>
            <div className={styles.dialogField}>
              <label htmlFor={baseUrlInputId} className={styles.dialogFieldLabel}>Base URL</label>
              <Input
                id={baseUrlInputId}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.currentTarget.value)}
                placeholder="http://localhost:11434"
                required
              />
            </div>
            <div className={styles.dialogField}>
              <label htmlFor={apiKeyInputId} className={styles.dialogFieldLabel}>Bearer token (optional)</label>
              <Input
                id={apiKeyInputId}
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.currentTarget.value)}
                placeholder="Leave blank if no auth"
                autoComplete="off"
              />
            </div>
          </>
        )}

        {error && <p role="alert" className={styles.dialogError}>{error}</p>}
      </form>
    </Dialog>
  )
}
