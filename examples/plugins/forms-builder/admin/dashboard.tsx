/**
 * Forms Builder — admin dashboard.
 *
 * Sections (top → bottom):
 *   1. Stats row   — Today / This Week / This Month / Total counts.
 *   2. 30-day chart — daily bar chart via Bars from host-ui.
 *   3. Filter bar  — form slug selector + status filter.
 *   4. Table       — paginated submission rows with server-side filtering.
 *   5. Drawer      — full detail view with field table + Resend action.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Bars,
  Button,
  Card,
  EmptyState,
  Heading,
  Select,
  Separator,
  Stack,
  StatValue,
  Text,
} from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'
import { Type } from '@sinclair/typebox'
import type { Static } from '@sinclair/typebox'

// ---------------------------------------------------------------------------
// Schema + types
// ---------------------------------------------------------------------------

const SubmissionRecordDataSchema = Type.Object(
  {
    formId:       Type.Optional(Type.String()),
    pagePath:     Type.Optional(Type.String()),
    submittedAt:  Type.Optional(Type.String()),
    payload:      Type.Optional(Type.String()),
    ipHash:       Type.Optional(Type.String()),
    userAgent:    Type.Optional(Type.String()),
    status:       Type.Optional(Type.String()),
    errorMessage: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
)

const SubmissionRecordSchema = Type.Object({
  id: Type.String(),
  pluginId: Type.String(),
  resourceId: Type.String(),
  data: SubmissionRecordDataSchema,
  createdAt: Type.String(),
  updatedAt: Type.String(),
})

const SubmissionsResponseSchema = Type.Object({
  submissions: Type.Array(SubmissionRecordSchema),
  totalCount: Type.Integer({ minimum: 0 }),
})

type SubmissionRecord = Static<typeof SubmissionRecordSchema>

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function isToday(ts: string): boolean {
  return startOfDay(new Date(ts)) === startOfDay(new Date())
}

function isThisWeek(ts: string): boolean {
  const now = Date.now()
  return now - new Date(ts).getTime() < 7 * 24 * 60 * 60 * 1000
}

function isThisMonth(ts: string): boolean {
  const d = new Date(ts)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
}

function formatDate(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function parsePayload(payloadJson: string | undefined): Record<string, unknown> {
  if (!payloadJson) return {}
  try {
    const parsed = JSON.parse(payloadJson)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch (_e) {
    return {}
  }
}

/** Build a 30-day histogram from submission timestamps (newest day last). */
function build30DayHistogram(submissions: SubmissionRecord[]): number[] {
  const counts = new Array<number>(30).fill(0)
  const now = startOfDay(new Date())
  for (const s of submissions) {
    const ts = s.data['submittedAt'] ?? s.createdAt
    const dayAgo = Math.floor((now - startOfDay(new Date(ts))) / (24 * 60 * 60 * 1000))
    if (dayAgo >= 0 && dayAgo < 30) {
      counts[29 - dayAgo] = (counts[29 - dayAgo] ?? 0) + 1
    }
  }
  return counts
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case 'sent':    return 'Sent'
    case 'failed':  return 'Failed'
    case 'pending': return 'Pending'
    default:        return status ?? '—'
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string
  count: number
}

function StatCard({ label, count }: StatCardProps) {
  return (
    <Card padding={16}>
      <StatValue value={count} sub={label} />
    </Card>
  )
}

interface DrawerProps {
  record: SubmissionRecord
  onClose: () => void
  onResend: (id: string) => Promise<void>
  resending: boolean
}

function SubmissionDrawer({ record, onClose, onResend, resending }: DrawerProps) {
  const fields = parsePayload(record.data['payload'] as string | undefined)

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        justifyContent: 'flex-end',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '420px',
          maxWidth: '100vw',
          background: 'var(--editor-surface)',
          borderLeft: '1px solid var(--editor-border)',
          overflowY: 'auto',
          padding: '24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Stack direction="row" gap={8} align="center" justify="between">
          <Heading level={3}>Submission Detail</Heading>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </Stack>

        <Separator />

        {/* Metadata */}
        <Stack gap={4}>
          <Text variant="muted">Form</Text>
          <Text>{String(record.data['formId'] ?? '—')}</Text>
        </Stack>
        <Stack gap={4}>
          <Text variant="muted">Page</Text>
          <Text>{String(record.data['pagePath'] || '—')}</Text>
        </Stack>
        <Stack gap={4}>
          <Text variant="muted">Submitted</Text>
          <Text>
            {record.data['submittedAt']
              ? formatDate(String(record.data['submittedAt']))
              : '—'}
          </Text>
        </Stack>
        <Stack gap={4}>
          <Text variant="muted">Status</Text>
          <Text>{statusLabel(record.data['status'] as string | undefined)}</Text>
        </Stack>
        {record.data['errorMessage'] ? (
          <Alert tone="danger" title="Delivery error">
            {String(record.data['errorMessage'])}
          </Alert>
        ) : null}
        <Stack gap={4}>
          <Text variant="muted">IP Hash</Text>
          <Text variant="mono">
            {String(record.data['ipHash'] ?? '—').slice(0, 16)}…
          </Text>
        </Stack>
        <Stack gap={4}>
          <Text variant="muted">User Agent</Text>
          <Text variant="muted">{String(record.data['userAgent'] || '—')}</Text>
        </Stack>

        <Separator />

        {/* Field payload */}
        <Heading level={4}>Fields</Heading>
        {Object.keys(fields).length === 0 ? (
          <Text variant="muted">No fields recorded.</Text>
        ) : (
          <Stack gap={8}>
            {Object.entries(fields).map(([key, value]) => (
              <Stack key={key} gap={2}>
                <Text variant="muted">{key}</Text>
                <Text>{String(value ?? '')}</Text>
              </Stack>
            ))}
          </Stack>
        )}

        <Separator />

        <Button
          variant="secondary"
          size="sm"
          disabled={resending}
          onClick={() => void onResend(record.id)}
        >
          {resending ? 'Resending…' : 'Resend Email'}
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

function FormsDashboard() {
  const routes = usePluginRoutes()

  // Table data — server-filtered, paginated
  const [submissions, setSubmissions] = useState<SubmissionRecord[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  // Unfiltered data for stats / histogram / form-ID picker
  const [allSubmissions, setAllSubmissions] = useState<SubmissionRecord[]>([])
  const [globalTotal, setGlobalTotal] = useState(0)

  // Filter state
  const [filterForm, setFilterForm] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')

  // Drawer + resend
  const [selected, setSelected] = useState<SubmissionRecord | null>(null)
  const [resending, setResending] = useState(false)
  const [resendError, setResendError] = useState<string | null>(null)

  // ---------------------------------------------------------------------------
  // Fetch ALL submissions (no filter, up to 1000) for stats / histogram / picker
  // ---------------------------------------------------------------------------
  const loadAll = useCallback(async () => {
    try {
      const data = await routes.json(
        'submissions?limit=1000&offset=0',
        SubmissionsResponseSchema,
      )
      setAllSubmissions(data.submissions)
      setGlobalTotal(data.totalCount)
    } catch (_err) {
      // Non-fatal: stats may be empty or stale, don't surface an error banner
    }
  }, [routes])

  // ---------------------------------------------------------------------------
  // Fetch filtered + paginated submissions for the table
  // ---------------------------------------------------------------------------
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (filterForm) params.set('formId', filterForm)
      if (filterStatus) params.set('status', filterStatus)
      params.set('limit', String(PAGE_SIZE))
      params.set('offset', String(page * PAGE_SIZE))
      const data = await routes.json(
        `submissions?${params.toString()}`,
        SubmissionsResponseSchema,
      )
      setSubmissions(data.submissions)
      setTotalCount(data.totalCount)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load submissions')
    } finally {
      setLoading(false)
    }
  }, [routes, filterForm, filterStatus, page])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  useEffect(() => {
    void load()
  }, [load])

  // ---------------------------------------------------------------------------
  // Stats — derived from the unfiltered allSubmissions
  // ---------------------------------------------------------------------------
  const todayCount = useMemo(
    () =>
      allSubmissions.filter((s) => {
        const ts = s.data['submittedAt'] as string | undefined
        return ts != null && isToday(ts)
      }).length,
    [allSubmissions],
  )
  const weekCount = useMemo(
    () =>
      allSubmissions.filter((s) => {
        const ts = s.data['submittedAt'] as string | undefined
        return ts != null && isThisWeek(ts)
      }).length,
    [allSubmissions],
  )
  const monthCount = useMemo(
    () =>
      allSubmissions.filter((s) => {
        const ts = s.data['submittedAt'] as string | undefined
        return ts != null && isThisMonth(ts)
      }).length,
    [allSubmissions],
  )

  // 30-day bar chart — derived from allSubmissions
  const histogram = useMemo(() => build30DayHistogram(allSubmissions), [allSubmissions])
  const todayIndex = 29

  // Distinct form IDs for the filter picker — derived from allSubmissions
  const formIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of allSubmissions) {
      const fid = s.data['formId'] as string | undefined
      if (fid) ids.add(fid)
    }
    return Array.from(ids).sort()
  }, [allSubmissions])

  // ---------------------------------------------------------------------------
  // Resend action
  // ---------------------------------------------------------------------------
  const handleResend = useCallback(
    async (id: string) => {
      setResending(true)
      setResendError(null)
      try {
        const res = await routes.fetch(`resend?id=${encodeURIComponent(id)}`, { method: 'POST' })
        if (!res.ok) {
          const body = (await res.json()) as { error?: string }
          throw new Error(body.error ?? 'Resend failed')
        }
        await load()
      } catch (err) {
        setResendError(err instanceof Error ? err.message : 'Resend failed')
      } finally {
        setResending(false)
      }
    },
    [routes, load],
  )

  // ---------------------------------------------------------------------------
  // Pagination helpers
  // ---------------------------------------------------------------------------
  const pageStart = page * PAGE_SIZE + 1
  const pageEnd = Math.min((page + 1) * PAGE_SIZE, totalCount)
  const hasPrev = page > 0
  const hasNext = (page + 1) * PAGE_SIZE < totalCount

  return (
    <Stack gap={24}>
      <Heading level={2}>Forms Builder</Heading>
      <Text variant="muted">
        Submission history across all forms on this site.
      </Text>

      {error && (
        <Alert tone="danger" title="Error loading submissions">
          {error}
        </Alert>
      )}

      {resendError && (
        <Alert tone="danger" title="Resend failed">
          {resendError}
        </Alert>
      )}

      {/* Stats row */}
      <Stack direction="row" gap={12} wrap>
        <StatCard label="Today" count={todayCount} />
        <StatCard label="This Week" count={weekCount} />
        <StatCard label="This Month" count={monthCount} />
        <StatCard label="Total" count={globalTotal} />
      </Stack>

      {/* 30-day chart */}
      {globalTotal > 0 && (
        <Card padding={16}>
          <Stack direction="column" gap={8} height={180}>
            <Text variant="muted">Last 30 days</Text>
            <Bars
              data={histogram}
              accentIndexes={[todayIndex]}
            />
          </Stack>
        </Card>
      )}

      <Separator />

      {/* Filter bar */}
      <Stack direction="row" gap={12} align="center" wrap>
        <Select<string>
          label="Form"
          value={filterForm}
          options={[
            { label: 'All forms', value: '' },
            ...formIds.map((id) => ({ label: id, value: id })),
          ]}
          onChange={(v) => { setFilterForm(v); setPage(0) }}
        />
        <Select<string>
          label="Status"
          value={filterStatus}
          options={[
            { label: 'All statuses', value: '' },
            { label: 'Pending', value: 'pending' },
            { label: 'Sent', value: 'sent' },
            { label: 'Failed', value: 'failed' },
          ]}
          onChange={(v) => { setFilterStatus(v); setPage(0) }}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { void loadAll(); void load() }}
          disabled={loading}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </Stack>

      {/* Submissions table */}
      {loading ? (
        <Text variant="muted">Loading submissions…</Text>
      ) : submissions.length === 0 ? (
        <EmptyState
          title="No submissions"
          body={
            filterForm || filterStatus
              ? 'No submissions match the current filters.'
              : 'Submissions appear here once visitors fill in a form on a published page.'
          }
        />
      ) : (
        <>
          {/* Showing X–Y of Z + pagination controls */}
          <Stack direction="row" gap={12} align="center" justify="between">
            <Text variant="muted">
              Showing {pageStart}–{pageEnd} of {totalCount}
            </Text>
            <Stack direction="row" gap={8}>
              <Button variant="ghost" size="sm" disabled={!hasPrev} onClick={() => setPage((p) => p - 1)}>
                Prev
              </Button>
              <Button variant="ghost" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </Stack>
          </Stack>

          <div
            style={{
              overflowX: 'auto',
              border: '1px solid var(--editor-border)',
              borderRadius: 'var(--editor-radius)',
            }}
          >
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.875rem',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid var(--editor-border)',
                    background: 'var(--editor-surface-2)',
                  }}
                >
                  {['Date', 'Form', 'Page', 'Status', 'IP (short)', 'Actions'].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: '8px 12px',
                        textAlign: 'left',
                        color: 'var(--editor-text-secondary)',
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {submissions.map((s, idx) => (
                  <tr
                    key={s.id}
                    style={{
                      borderBottom:
                        idx < submissions.length - 1 ? '1px solid var(--editor-border)' : 'none',
                      background:
                        selected?.id === s.id
                          ? 'var(--editor-selection)'
                          : 'transparent',
                      cursor: 'pointer',
                    }}
                    onClick={() => setSelected(s)}
                  >
                    <td style={{ padding: '8px 12px', color: 'var(--editor-text)' }}>
                      {s.data['submittedAt']
                        ? formatDate(String(s.data['submittedAt']))
                        : '—'}
                    </td>
                    <td style={{ padding: '8px 12px', color: 'var(--editor-text)' }}>
                      {String(s.data['formId'] ?? '—')}
                    </td>
                    <td
                      style={{
                        padding: '8px 12px',
                        color: 'var(--editor-text-secondary)',
                        maxWidth: '180px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={String(s.data['pagePath'] ?? '')}
                    >
                      {String(s.data['pagePath'] || '—')}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      {(() => {
                        const st = s.data['status'] as string | undefined
                        return (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '2px 8px',
                              borderRadius: 'var(--editor-radius-sm)',
                              fontSize: '0.8125rem',
                              fontWeight: 500,
                              background:
                                st === 'sent'
                                  ? 'var(--editor-success-bg)'
                                  : st === 'failed'
                                    ? 'var(--editor-danger-bg)'
                                    : 'var(--editor-surface-3)',
                              color:
                                st === 'sent'
                                  ? 'var(--editor-success-text)'
                                  : st === 'failed'
                                    ? 'var(--editor-danger-text)'
                                    : 'var(--editor-text-secondary)',
                            }}
                          >
                            {statusLabel(st)}
                          </span>
                        )
                      })()}
                    </td>
                    <td
                      style={{
                        padding: '8px 12px',
                        color: 'var(--editor-text-muted)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: '0.8125rem',
                      }}
                    >
                      {String(s.data['ipHash'] ?? '').slice(0, 8)}
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <Stack direction="row" gap={6}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelected(s)
                          }}
                        >
                          View
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={resending}
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleResend(s.id)
                          }}
                        >
                          Resend
                        </Button>
                      </Stack>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Bottom pagination controls (mirrors top) */}
          {(hasPrev || hasNext) && (
            <Stack direction="row" gap={8} justify="end">
              <Button variant="ghost" size="sm" disabled={!hasPrev} onClick={() => setPage((p) => p - 1)}>
                Prev
              </Button>
              <Button variant="ghost" size="sm" disabled={!hasNext} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </Stack>
          )}
        </>
      )}

      {/* Drawer */}
      {selected && (
        <SubmissionDrawer
          record={selected}
          onClose={() => setSelected(null)}
          onResend={handleResend}
          resending={resending}
        />
      )}
    </Stack>
  )
}

export default definePluginAdminApp(FormsDashboard)
