import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Heading,
  Input,
  SearchBar,
  Select,
  Stack,
  Text,
} from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'

interface SubscriberRow {
  id: string
  email: string
  name: string
  status: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced'
  listIds: string[]
  subscribedAt: string
  confirmedAt: string | null
}

interface ListRow {
  id: string
  name: string
}

const PAGE_SIZE = 20

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'pending', label: 'Pending' },
  { value: 'unsubscribed', label: 'Unsubscribed' },
  { value: 'bounced', label: 'Bounced' },
]

function statusStyle(status: string): React.CSSProperties {
  const map: Record<string, { background: string; color: string }> = {
    confirmed: { background: 'var(--editor-success-bg)', color: 'var(--editor-success-green)' },
    pending: { background: 'var(--panel-border)', color: 'var(--editor-text-muted)' },
    unsubscribed: { background: 'var(--panel-border)', color: 'var(--editor-text-muted)' },
    bounced: { background: 'var(--editor-danger-bg)', color: 'var(--editor-danger)' },
  }
  const s = map[status] ?? map.pending
  return {
    display: 'inline-block',
    padding: '1px 7px',
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    ...s,
  }
}

export function Subscribers() {
  const routes = usePluginRoutes()
  const [subscribers, setSubscribers] = useState<SubscriberRow[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [lists, setLists] = useState<ListRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Filters + pagination
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [listFilter, setListFilter] = useState('')
  const [page, setPage] = useState(0)

  // Add subscriber modal
  const [modalOpen, setModalOpen] = useState(false)
  const [addEmail, setAddEmail] = useState('')
  const [addName, setAddName] = useState('')
  const [addListId, setAddListId] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (statusFilter) params.set('status', statusFilter)
      if (listFilter) params.set('listId', listFilter)
      // search and pagination are pushed to the server so filtering and
      // totalCount are computed there rather than on a full client-side array.
      if (search) params.set('search', search)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(page * PAGE_SIZE))
      const [subRes, listRes] = await Promise.all([
        routes.fetch(`subscribers?${params}`),
        routes.fetch('lists'),
      ])
      const subBody = (await subRes.json()) as {
        ok: boolean
        subscribers: SubscriberRow[]
        totalCount: number
        error?: string
      }
      const listBody = (await listRes.json()) as { ok: boolean; lists: ListRow[]; error?: string }
      if (subBody.error) throw new Error(subBody.error)
      setSubscribers(subBody.subscribers ?? [])
      setTotalCount(subBody.totalCount ?? 0)
      setLists(listBody.lists ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load subscribers')
    } finally {
      setLoading(false)
    }
  }, [routes, statusFilter, listFilter, search, page])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Filtering and pagination are server-driven; totalCount comes from the server.
  const totalPages = Math.ceil(totalCount / PAGE_SIZE)

  async function handleDelete(id: string) {
    try {
      await routes.fetch(`subscribers/${id}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  async function handleAdd() {
    if (!addEmail.trim()) {
      setAddError('Email is required')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const res = await routes.fetch('subscribers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: addEmail.trim(),
          name: addName.trim(),
          listIds: addListId ? [addListId] : [],
        }),
      })
      const body = (await res.json()) as { ok?: boolean; error?: string }
      if (body.error) throw new Error(body.error)
      setModalOpen(false)
      setAddEmail('')
      setAddName('')
      setAddListId('')
      await refresh()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add subscriber')
    } finally {
      setAdding(false)
    }
  }

  async function handleExportCsv() {
    try {
      const res = await routes.fetch('subscribers.csv')
      const csv = await res.text()
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'subscribers.csv'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    }
  }

  const listOptions = [
    { value: '', label: 'All lists' },
    ...lists.map((l) => ({ value: l.id, label: l.name })),
  ]

  return (
    <Stack gap={16}>
      <Stack direction="row" gap={8}>
        <Heading level={3} style={{ flex: 1 }}>
          Subscribers
        </Heading>
        <Button variant="secondary" size="sm" onClick={() => void handleExportCsv()}>
          Export CSV
        </Button>
        <Button variant="primary" size="sm" onClick={() => setModalOpen(true)}>
          Add subscriber
        </Button>
      </Stack>

      {error && (
        <Alert tone="danger" title="Error" role="alert">
          {error}
        </Alert>
      )}

      <Stack direction="row" gap={8} wrap>
        <SearchBar
          placeholder="Search by email…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0) }}
          style={{ flex: '1 1 200px' }}
        />
        <Select
          value={statusFilter}
          options={STATUS_OPTIONS}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(0) }}
          style={{ flex: '0 0 160px' }}
        />
        <Select
          value={listFilter}
          options={listOptions}
          onChange={(e) => { setListFilter(e.target.value); setPage(0) }}
          style={{ flex: '0 0 160px' }}
        />
      </Stack>

      {loading ? (
        <Text variant="muted">Loading…</Text>
      ) : subscribers.length === 0 ? (
        <Alert tone="info" title="No subscribers found">
          {search || statusFilter || listFilter ? 'Try adjusting your filters.' : 'No subscribers yet.'}
        </Alert>
      ) : (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--panel-border)' }}>
                {['Email', 'Name', 'Status', 'Lists', 'Subscribed', ''].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      color: 'var(--editor-text-muted)',
                      fontWeight: 500,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subscribers.map((sub) => (
                <tr
                  key={sub.id}
                  style={{ borderBottom: '1px solid var(--panel-border)' }}
                >
                  <td style={{ padding: '8px 8px' }}>{sub.email}</td>
                  <td style={{ padding: '8px 8px', color: 'var(--editor-text-muted)' }}>
                    {sub.name || '—'}
                  </td>
                  <td style={{ padding: '8px 8px' }}>
                    <span style={statusStyle(sub.status)}>{sub.status}</span>
                  </td>
                  <td style={{ padding: '8px 8px', color: 'var(--editor-text-muted)' }}>
                    {sub.listIds.length === 0
                      ? '—'
                      : sub.listIds
                          .map((id) => lists.find((l) => l.id === id)?.name ?? id)
                          .join(', ')}
                  </td>
                  <td style={{ padding: '8px 8px', color: 'var(--editor-text-muted)' }}>
                    {sub.subscribedAt ? new Date(sub.subscribedAt).toLocaleDateString() : '—'}
                  </td>
                  <td style={{ padding: '8px 8px' }}>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void handleDelete(sub.id)}
                    >
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <Stack direction="row" gap={8}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                ← Prev
              </Button>
              <Text variant="muted">
                Page {page + 1} of {totalPages} ({totalCount} total)
              </Text>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                Next →
              </Button>
            </Stack>
          )}
        </>
      )}

      {modalOpen && (
        <div role="dialog" aria-modal="true" aria-label="Add subscriber">
          <Card padding={24}>
            <Stack gap={16}>
              <Heading level={4}>Add subscriber</Heading>
              {addError && (
                <Alert tone="danger" title="Error" role="alert">
                  {addError}
                </Alert>
              )}
              <Input
                label="Email"
                type="email"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                placeholder="subscriber@example.com"
              />
              <Input
                label="Name (optional)"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Jane Smith"
              />
              <Select
                label="List"
                value={addListId}
                options={[{ value: '', label: 'Default list' }, ...lists.map((l) => ({ value: l.id, label: l.name }))]}
                onChange={(e) => setAddListId(e.target.value)}
              />
              <Stack direction="row" gap={8}>
                <Button variant="primary" size="sm" onClick={() => void handleAdd()} disabled={adding}>
                  {adding ? 'Adding…' : 'Add'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setModalOpen(false)}>
                  Cancel
                </Button>
              </Stack>
            </Stack>
          </Card>
        </div>
      )}
    </Stack>
  )
}
