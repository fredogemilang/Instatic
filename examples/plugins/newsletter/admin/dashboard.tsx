/**
 * Newsletter plugin — admin dashboard entry point.
 *
 * Tab navigation using the host Tabs compound component (ARIA + keyboard
 * navigation built in; underline-indicator style).
 * Each tab is a separate section component imported from ./sections/*.
 *
 * Externalised imports: react, @pagebuilder/host-ui, @pagebuilder/host-hooks,
 * @pagebuilder/plugin-sdk — resolved by the host's import map at runtime.
 */
import { useState } from 'react'
import { Heading, Stack, Tab, TabList, TabPanel, Tabs, Text } from '@pagebuilder/host-ui'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'
import { Stats } from './sections/Stats'
import { Subscribers } from './sections/Subscribers'
import { Lists } from './sections/Lists'
import { Broadcasts } from './sections/Broadcasts'

// Renamed from `Tab` to avoid collision with the imported Tab component.
type TabId = 'overview' | 'subscribers' | 'lists' | 'broadcasts'

function NewsletterDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('overview')

  return (
    <Stack gap={24}>
      <Stack gap={4}>
        <Heading level={2}>Newsletter</Heading>
        <Text variant="muted">
          Manage subscribers, lists, and broadcasts. Powered by{' '}
          <a
            href="https://resend.com"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'inherit' }}
          >
            Resend
          </a>
          .
        </Text>
      </Stack>

      <Tabs<TabId> value={activeTab} onChange={setActiveTab}>
        <TabList ariaLabel="Newsletter sections">
          <Tab value="overview">Overview</Tab>
          <Tab value="subscribers">Subscribers</Tab>
          <Tab value="lists">Lists</Tab>
          <Tab value="broadcasts">Broadcasts</Tab>
        </TabList>
        <TabPanel value="overview"><Stats /></TabPanel>
        <TabPanel value="subscribers"><Subscribers /></TabPanel>
        <TabPanel value="lists"><Lists /></TabPanel>
        <TabPanel value="broadcasts"><Broadcasts /></TabPanel>
      </Tabs>
    </Stack>
  )
}

export default definePluginAdminApp(NewsletterDashboard)
