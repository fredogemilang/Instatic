/**
 * ReindexPanel — "Reindex all" and "Clear index" controls.
 *
 * Both actions are destructive (Clear index removes all documents).
 * "Clear index" shows an inline confirm state to prevent accidental use.
 * We do NOT use window.confirm() — per project rules.
 *
 * "Reindex all" calls POST /reindex which triggers api.cms.pages.republishAll()
 * on the server side, re-running the publish pipeline for every published page
 * and rebuilding the search index from scratch.
 */
import { useCallback, useState } from 'react'
import { Alert, Button, Card, Heading, Stack, Text } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { OkResponseSchema, ReindexResponseSchema } from '../apiSchemas'
import styles from './ReindexPanel.module.css'

export function ReindexPanel() {
  const routes = usePluginRoutes()

  const [reindexing, setReindexing] = useState(false)
  const [reindexMessage, setReindexMessage] = useState<string | null>(null)
  const [reindexError, setReindexError] = useState<string | null>(null)

  const [clearConfirm, setClearConfirm] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearMessage, setClearMessage] = useState<string | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)

  const handleReindex = useCallback(async () => {
    setReindexing(true)
    setReindexMessage(null)
    setReindexError(null)
    try {
      const body = await routes.json('reindex', ReindexResponseSchema, { method: 'POST' })
      if (body.ok) {
        setReindexMessage(`Reindexed ${body.count} page${body.count === 1 ? '' : 's'}.`)
      } else {
        setReindexError(body.message ?? 'Reindex failed.')
      }
    } catch (err) {
      setReindexError(err instanceof Error ? err.message : 'Reindex failed.')
    } finally {
      setReindexing(false)
    }
  }, [routes])

  const handleClear = useCallback(async () => {
    setClearing(true)
    setClearMessage(null)
    setClearError(null)
    try {
      const body = await routes.json('clear', OkResponseSchema, { method: 'POST' })
      if (body.ok) {
        setClearMessage(body.message ?? 'Index cleared.')
        setClearConfirm(false)
      } else {
        setClearError(body.message ?? 'Clear failed.')
      }
    } catch (err) {
      setClearError(err instanceof Error ? err.message : 'Clear failed.')
    } finally {
      setClearing(false)
    }
  }, [routes])

  return (
    <Stack gap={12}>
      <Heading level={4}>Index Management</Heading>

      {/* Reindex all */}
      <Card padding={16}>
        <Stack gap={10}>
          <Text className={styles.sectionTitle}>Reindex all published pages</Text>
          <Text variant="muted">
            Re-runs the publish pipeline for every published page, automatically updating the search
            index. Use this to rebuild the index from scratch after configuring a new backend or
            changing indexing settings.
          </Text>
          {reindexMessage && (
            <Alert tone="success" title="Reindex complete">
              {reindexMessage}
            </Alert>
          )}
          {reindexError && (
            <Alert tone="danger" title="Reindex failed">
              {reindexError}
            </Alert>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void handleReindex()}
            disabled={reindexing}
          >
            {reindexing ? 'Reindexing…' : 'Reindex all pages'}
          </Button>
        </Stack>
      </Card>

      {/* Clear index */}
      <Card padding={16}>
        <Stack gap={10}>
          <Text className={styles.sectionTitle}>Clear index</Text>
          <Text variant="muted">
            Removes all documents from the search index. The index structure is preserved, but all
            content is deleted. Re-publish your pages to restore search.
          </Text>
          {clearMessage && (
            <Alert tone="success" title="Index cleared">
              {clearMessage}
            </Alert>
          )}
          {clearError && (
            <Alert tone="danger" title="Clear failed">
              {clearError}
            </Alert>
          )}

          {!clearConfirm ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setClearConfirm(true)}
            >
              Clear index…
            </Button>
          ) : (
            <Stack gap={8}>
              <Alert tone="danger" title="Are you sure?">
                This will remove all documents from the search index. This cannot be undone.
              </Alert>
              <Stack direction="row" gap={8}>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => void handleClear()}
                  disabled={clearing}
                >
                  {clearing ? 'Clearing…' : 'Yes, clear the index'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setClearConfirm(false)}
                  disabled={clearing}
                >
                  Cancel
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </Card>
    </Stack>
  )
}
