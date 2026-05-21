/**
 * Search plugin — admin dashboard.
 *
 * Tabs:
 *   Stats      — index status (doc count, backend, endpoint)
 *   Documents  — browse / search indexed documents
 *   Analytics  — top queries + top no-result queries
 *   Sync       — reindex all / clear index
 *
 * Uses @pagebuilder/host-ui primitives including the Tabs compound component
 * for full ARIA + keyboard navigation. Plugin routes via usePluginRoutes().
 */
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Heading, Stack, Tabs, TabList, Tab, TabPanel } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'

import { StatsCard } from './sections/StatsCard'
import { DocumentsList } from './sections/DocumentsList'
import { AnalyticsPanel } from './sections/AnalyticsPanel'
import { ReindexPanel } from './sections/ReindexPanel'
import styles from './dashboard.module.css'
import { StatusResponseSchema, type StatusResponse } from './apiSchemas'

type SearchTab = 'stats' | 'documents' | 'analytics' | 'sync'

function SearchDashboard() {
  const routes = usePluginRoutes()
  const [activeTab, setActiveTab] = useState<SearchTab>('stats')
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      const body = await routes.json('status', StatusResponseSchema)
      setStatus(body)
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to load status')
    } finally {
      setStatusLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  return (
    <div className={styles.root}>
      <div className={styles.headerRow}>
        <Heading level={2}>Search</Heading>
        <div className={styles.refreshBtn}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshStatus()}
            disabled={statusLoading}
          >
            {statusLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {statusError && (
        <Alert tone="danger" title="Status unavailable">
          {statusError}
        </Alert>
      )}

      <Tabs<SearchTab> value={activeTab} onChange={setActiveTab}>
        <TabList ariaLabel="Search plugin sections">
          <Tab value="stats">Stats</Tab>
          <Tab value="documents">Documents</Tab>
          <Tab value="analytics">Analytics</Tab>
          <Tab value="sync">Settings sync</Tab>
        </TabList>
        <TabPanel value="stats">
          <Stack gap={16}>
            <StatsCard status={status} loading={statusLoading} />
            {!statusLoading && status && !status.configured && (
              <Alert tone="info" title="Not configured">
                Open <strong>Settings</strong> on the plugin card to set the search backend
                endpoint and API keys.
              </Alert>
            )}
          </Stack>
        </TabPanel>
        <TabPanel value="documents">
          <DocumentsList />
        </TabPanel>
        <TabPanel value="analytics">
          <AnalyticsPanel />
        </TabPanel>
        <TabPanel value="sync">
          <ReindexPanel />
        </TabPanel>
      </Tabs>
    </div>
  )
}

export default definePluginAdminApp(SearchDashboard)
