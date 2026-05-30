/**
 * Defaults tab — per-scope default `(credentialId, modelId)` selection.
 *
 * One row per `ToolScope`. Each row has a credential picker (sourced from
 * the user's credentials) and a model picker (sourced from the active
 * credential's provider). Saving a row PUTs to /admin/api/ai/defaults/:scope.
 */

import { useEffect, useState } from 'react'
import { Button } from '@ui/components/Button'
import { Select } from '@ui/components/Select'
import { SaveSolidIcon } from 'pixel-art-icons/icons/save-solid'
import {
  type AiDefaults,
  type AiModel,
  type CredentialView,
  listCredentials,
  listDefaults,
  listModels,
  setDefault,
} from '../../../ai/api'
import { ApiError } from '@core/http'
import styles from '../AiPage.module.css'

type ToolScope = 'site' | 'content' | 'data' | 'plugin'
const SCOPES: ToolScope[] = ['site', 'content', 'data', 'plugin']
const SCOPE_DESCRIPTIONS: Record<ToolScope, string> = {
  site: 'Used by the visual site editor chat.',
  content: 'Used by the content workspace (Phase 4).',
  data: 'Used by the data workspace (Phase 4).',
  plugin: 'Used by api.ai.* calls from plugin code (Phase 5).',
}

export function DefaultsTab() {
  const [credentials, setCredentials] = useState<CredentialView[]>([])
  const [defaults, setDefaults] = useState<AiDefaults>({})
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, AiModel[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingScope, setSavingScope] = useState<ToolScope | null>(null)
  const [statusByScope, setStatusByScope] = useState<Record<string, string>>({})
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        setError(null)
        const [creds, defs] = await Promise.all([listCredentials(), listDefaults()])
        if (cancelled) return
        setCredentials(creds)
        setDefaults(defs)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load defaults.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [refreshKey])

  // Lazy-load models for each provider that has any credentials. Cache
  // per-provider; the picker reads from this map. The fetch is started
  // inside a microtask so we don't synchronously setState during the
  // current commit (satisfies react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false
    const providersInUse = new Set(credentials.map((c) => c.providerId))
    for (const provider of providersInUse) {
      if (modelsByProvider[provider]) continue
      void listModels(provider).then((models) => {
        if (cancelled) return
        setModelsByProvider((prev) => ({ ...prev, [provider]: models }))
      }).catch(() => { /* swallow — picker shows "loading models…" */ })
    }
    return () => { cancelled = true }
  }, [credentials, modelsByProvider])

  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <div>
          <h2>Per-scope defaults</h2>
          <p>Pick which credential + model each AI surface uses by default. Users can override in the chat picker.</p>
        </div>
      </div>

      {error && <p role="alert" className={styles.errorAlert}>{error}</p>}

      {loading ? (
        <div className={styles.emptyState}>Loading…</div>
      ) : credentials.length === 0 ? (
        <div className={styles.emptyState}>
          Add a credential on the Providers tab before setting defaults.
        </div>
      ) : (
        <div className={styles.defaultsGrid}>
          {SCOPES.map((scope) => (
            <ScopeRow
              key={scope}
              scope={scope}
              credentials={credentials}
              modelsByProvider={modelsByProvider}
              current={defaults[scope]}
              busy={savingScope === scope}
              status={statusByScope[scope]}
              onSave={async (credentialId, modelId) => {
                setSavingScope(scope)
                setStatusByScope((prev) => ({ ...prev, [scope]: '' }))
                try {
                  await setDefault(scope, { credentialId, modelId })
                  setStatusByScope((prev) => ({ ...prev, [scope]: 'Saved.' }))
                  setRefreshKey((n) => n + 1)
                } catch (err) {
                  const message = err instanceof ApiError
                    ? err.message
                    : err instanceof Error
                      ? err.message
                      : 'Failed to save.'
                  setStatusByScope((prev) => ({ ...prev, [scope]: message }))
                } finally {
                  setSavingScope(null)
                }
              }}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function ScopeRow({
  scope,
  credentials,
  modelsByProvider,
  current,
  busy,
  status,
  onSave,
}: {
  scope: ToolScope
  credentials: CredentialView[]
  modelsByProvider: Record<string, AiModel[]>
  current: { credentialId: string; modelId: string } | undefined
  busy: boolean
  status: string | undefined
  onSave: (credentialId: string, modelId: string) => Promise<void>
}) {
  // Track ONLY user overrides — the displayed values are derived from
  // `(userOverride ?? validSavedValue ?? firstAvailable)` so the visible UI
  // and the internal state can never disagree.
  //
  // Why this matters: the saved default may point to a credential the
  // current user can no longer resolve (deleted, owned by another user,
  // master-key rotated). The Select primitive silently renders the first
  // option in that case but its underlying `value` would still hold the
  // stale id — making "save" a no-op and "model dropdown" hang on
  // "Loading models…" forever because `credentials.find(...)` returned
  // undefined.
  const [userOverride, setUserOverride] = useState<{
    credentialId?: string
    modelId?: string
  }>({})

  const savedCredentialResolves = current?.credentialId
    ? credentials.some((c) => c.id === current.credentialId)
    : false

  const credentialId =
    userOverride.credentialId
    ?? (savedCredentialResolves ? current!.credentialId : credentials[0]?.id ?? '')

  const selectedCred = credentials.find((c) => c.id === credentialId)
  const providerId = selectedCred?.providerId
  const models = providerId ? (modelsByProvider[providerId] ?? []) : []
  // "loading" is honest now: provider is selected AND its model list hasn't
  // been requested yet (parent's effect populates `modelsByProvider`
  // lazily, one provider at a time).
  const modelsLoading = Boolean(providerId) && !modelsByProvider[providerId!]

  const savedModelMatches =
    current?.modelId && models.some((m) => m.id === current.modelId)
  const modelId =
    (userOverride.modelId && models.some((m) => m.id === userOverride.modelId))
      ? userOverride.modelId
      : savedModelMatches
        ? current!.modelId
        : (models[0]?.id ?? '')

  const stale =
    Boolean(current?.credentialId) && !savedCredentialResolves

  const credOptions = credentials.map((c) => ({
    value: c.id,
    label: `${c.displayLabel} (${c.providerId})`,
  }))

  // Distinguish the empty-state reasons so the user knows what's wrong:
  //   • No credential picked yet           → "Pick a credential first"
  //   • Provider picked, list still loading → "Loading models…"
  //   • Loaded and empty                    → "No models available"
  const modelOptions = models.length > 0
    ? models.map((m) => ({ value: m.id, label: m.label }))
    : !selectedCred
      ? [{ value: '', label: 'Pick a credential first' }]
      : modelsLoading
        ? [{ value: '', label: 'Loading models…' }]
        : [{ value: '', label: 'No models available' }]

  // A stale saved default is ALWAYS "needs saving" — even if the auto-
  // resolved credentialId happens to match the first row, the user needs
  // to confirm the change so the default isn't a stale phantom.
  const dirty =
    stale
    || credentialId !== (current?.credentialId ?? '')
    || modelId !== (current?.modelId ?? '')
  const canSave = !busy && Boolean(credentialId) && Boolean(modelId) && dirty

  return (
    <div className={styles.defaultRow}>
      <div>
        <div className={styles.defaultScopeLabel}>{scope}</div>
        <p className={styles.secondaryText}>{SCOPE_DESCRIPTIONS[scope]}</p>
        {stale && (
          <p role="status" className={`${styles.testResult} ${styles.danger}`}>
            Previously saved credential is no longer available. Pick another and Save.
          </p>
        )}
      </div>
      <Select
        aria-label={`Credential for ${scope}`}
        value={credentialId}
        onChange={(e) => setUserOverride((prev) => ({
          ...prev,
          credentialId: e.currentTarget.value,
          // Switching credential invalidates any explicit model pick —
          // the new credential's model list may not contain it.
          modelId: undefined,
        }))}
        options={credOptions}
      />
      <Select
        aria-label={`Model for ${scope}`}
        value={modelId}
        onChange={(e) => setUserOverride((prev) => ({
          ...prev,
          modelId: e.currentTarget.value,
        }))}
        options={modelOptions}
      />
      <div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          disabled={!canSave}
          onClick={() => void onSave(credentialId, modelId)}
        >
          <SaveSolidIcon size={14} aria-hidden="true" />
          <span>Save</span>
        </Button>
        {status && (
          <p
            role="status"
            className={`${styles.testResult} ${status === 'Saved.' ? styles.success : styles.danger}`}
          >
            {status}
          </p>
        )}
      </div>
    </div>
  )
}
