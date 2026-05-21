/**
 * SEO Suite — admin dashboard.
 *
 * Rendered inside the host's admin shell. Reads seo-entries from the plugin's
 * own GET /seo-entries route and page-index from GET /page-index, then shows:
 *
 *   1. Stat cards — total pages, % with descriptions, % with OG images,
 *      % indexable.
 *   2. Page table — each page's SEO health status at a glance.
 *   3. Inline editor — expand any row to edit its seo-entry fields.
 *
 * Settings (siteUrl, siteName, etc.) are rendered by the host automatically
 * from the manifest's `settings` array — we don't re-implement that UI here.
 *
 * Bundle externalizes `react`, `@pagebuilder/host-ui`, `@pagebuilder/host-hooks`,
 * and `@pagebuilder/plugin-sdk` — the host's import map resolves them at runtime
 * so this code shares the editor's React instance and design system.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Heading,
  Input,
  Stack,
  StatValue,
  Switch,
  Text,
  Textarea,
} from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SeoEntry {
  'page-id': string
  'title-override'?: string
  'meta-description'?: string
  'og-title'?: string
  'og-description'?: string
  'og-image-url'?: string
  'twitter-card'?: string
  'canonical-url'?: string
  'no-index'?: boolean
  'no-follow'?: boolean
  'json-ld'?: string
  'last-rendered-url'?: string
  'last-rendered-title'?: string
  'last-rendered-at'?: string
}

interface PluginRecord {
  id: string
  data: SeoEntry
}

interface PageIndexRecord {
  id: string
  data: {
    'page-id': string
    slug?: string
    url?: string
    title?: string
    'last-seen-at'?: string
  }
}

interface SeoEntriesResponse {
  ok: boolean
  entries?: PluginRecord[]
  error?: string
}

interface PageIndexResponse {
  ok: boolean
  pages?: PageIndexRecord[]
  error?: string
}

// ---------------------------------------------------------------------------
// Stat card component
// ---------------------------------------------------------------------------

interface StatCardProps {
  label: string
  value: string
  detail?: string
}

function StatCard({ label, value, detail }: StatCardProps) {
  // Use the host `StatValue` primitive so SEO numbers match the visual
  // character of the host dashboard widgets and other plugin dashboards
  // (Analytics, Forms Builder) — big tabular-num value, optional muted
  // sub-line. No more ad-hoc `<Text size="lg">` reinvention.
  return (
    <Card padding={16}>
      <Stack gap={4}>
        <Text variant="muted">{label}</Text>
        <StatValue
          value={value}
          sub={detail ? <span>{detail}</span> : undefined}
        />
      </Stack>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Status badge component
// ---------------------------------------------------------------------------

type BadgeTone = 'success' | 'warning' | 'danger' | 'muted'

function StatusBadge({ tone, label }: { tone: BadgeTone; label: string }) {
  const colors: Record<BadgeTone, { bg: string; text: string }> = {
    success: { bg: 'var(--editor-success-bg)', text: 'var(--editor-success-green)' },
    warning: { bg: 'var(--editor-warning-bg, rgba(251,188,4,0.12))', text: 'var(--editor-warning)' },
    danger: { bg: 'var(--editor-danger-bg)', text: 'var(--editor-danger)' },
    muted: { bg: 'var(--panel-border)', text: 'var(--editor-text-muted)' },
  }
  const c = colors[tone]
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        fontSize: 11,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        borderRadius: 4,
        background: c.bg,
        color: c.text,
      }}
    >
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Inline SEO editor
// ---------------------------------------------------------------------------

interface EntryEditorProps {
  pageId: string
  initial: SeoEntry
  onSave: (entry: SeoEntry) => Promise<void>
  onCancel: () => void
}

function EntryEditor({ pageId, initial, onSave, onCancel }: EntryEditorProps) {
  const [form, setForm] = useState<SeoEntry>({ ...initial, 'page-id': pageId })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function update(field: keyof SeoEntry, value: string | boolean) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  async function handleSave() {
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(form)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card padding={16}>
      <Stack gap={12}>
        <Heading level={4}>Edit SEO — {pageId}</Heading>

        {saveError && (
          <Alert tone="danger" title="Save failed">
            {saveError}
          </Alert>
        )}

        <Input
          label="Title override"
          value={form['title-override'] ?? ''}
          placeholder="Leave blank to use the page's <title>"
          onChange={(v) => update('title-override', v)}
        />
        <Textarea
          label="Meta description"
          value={form['meta-description'] ?? ''}
          placeholder="160 character summary for search results"
          rows={3}
          onChange={(v) => update('meta-description', v)}
        />
        <Input
          label="OG title"
          value={form['og-title'] ?? ''}
          placeholder="Social card title (defaults to title override)"
          onChange={(v) => update('og-title', v)}
        />
        <Textarea
          label="OG description"
          value={form['og-description'] ?? ''}
          placeholder="Social card description"
          rows={2}
          onChange={(v) => update('og-description', v)}
        />
        <Input
          label="OG image URL"
          value={form['og-image-url'] ?? ''}
          placeholder="https://example.com/og.png"
          onChange={(v) => update('og-image-url', v)}
        />
        <Input
          label="Twitter card type"
          value={form['twitter-card'] ?? 'summary_large_image'}
          placeholder="summary_large_image"
          onChange={(v) => update('twitter-card', v)}
        />
        <Input
          label="Canonical URL"
          value={form['canonical-url'] ?? ''}
          placeholder="https://example.com/page"
          onChange={(v) => update('canonical-url', v)}
        />
        <Textarea
          label="Custom JSON-LD (optional)"
          value={form['json-ld'] ?? ''}
          placeholder='{"@context":"https://schema.org","@type":"Article",...}'
          rows={4}
          onChange={(v) => update('json-ld', v)}
        />

        <Stack direction="row" gap={8}>
          <Switch
            label="No-index"
            checked={Boolean(form['no-index'])}
            description="Prevent search engines from indexing this page."
            onChange={(v) => update('no-index', v)}
          />
          <Switch
            label="No-follow"
            checked={Boolean(form['no-follow'])}
            description="Tell crawlers not to follow links on this page."
            onChange={(v) => update('no-follow', v)}
          />
        </Stack>

        <Stack direction="row" gap={8}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </Stack>
      </Stack>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Page row
// ---------------------------------------------------------------------------

interface PageRowEntry {
  pageId: string
  title: string
  slug: string
  url: string
  seoEntry: SeoEntry | null
}

interface PageRowProps {
  row: PageRowEntry
  expanded: boolean
  onToggle: () => void
  onSave: (entry: SeoEntry) => Promise<void>
}

function PageRow({ row, expanded, onToggle, onSave }: PageRowProps) {
  const entry = row.seoEntry ?? {}
  const hasDesc = Boolean(entry['meta-description'])
  const hasOg = Boolean(entry['og-image-url'])
  const noIndex = Boolean(entry['no-index'])

  return (
    <Stack gap={8}>
      <Card padding={12}>
        <Stack direction="row" gap={12} align="center">
          <Stack gap={2} style={{ flex: 1, minWidth: 0 } as React.CSSProperties}>
            <Text variant="strong">{row.title || row.pageId}</Text>
            <Text variant="muted">{row.slug || row.url || row.pageId}</Text>
          </Stack>

          <Stack direction="row" gap={4} align="center" wrap>
            <StatusBadge tone={hasDesc ? 'success' : 'warning'} label={hasDesc ? 'Has desc' : 'No desc'} />
            <StatusBadge tone={hasOg ? 'success' : 'warning'} label={hasOg ? 'Has OG' : 'No OG'} />
            {noIndex
              ? <StatusBadge tone="danger" label="no-index" />
              : <StatusBadge tone="success" label="indexable" />}
          </Stack>

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggle}
          >
            {expanded ? 'Close' : 'Edit SEO'}
          </Button>
        </Stack>
      </Card>

      {expanded && (
        <EntryEditor
          pageId={row.pageId}
          initial={entry}
          onSave={onSave}
          onCancel={onToggle}
        />
      )}
    </Stack>
  )
}

// ---------------------------------------------------------------------------
// Main dashboard component
// ---------------------------------------------------------------------------

function SeoSuiteDashboard() {
  const routes = usePluginRoutes()

  const [entries, setEntries] = useState<PluginRecord[]>([])
  const [pages, setPages] = useState<PageIndexRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedPageId, setExpandedPageId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [entriesRes, pagesRes] = await Promise.all([
        routes.fetch('seo-entries'),
        routes.fetch('page-index'),
      ])

      const entriesBody = (await entriesRes.json()) as SeoEntriesResponse
      const pagesBody = (await pagesRes.json()) as PageIndexResponse

      if (!entriesBody.ok) throw new Error(entriesBody.error ?? 'Failed to load SEO entries')
      if (!pagesBody.ok) throw new Error(pagesBody.error ?? 'Failed to load page index')

      setEntries(entriesBody.entries ?? [])
      setPages(pagesBody.pages ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [routes])

  useEffect(() => {
    void load()
  }, [load])

  // ── Derived stats ──────────────────────────────────────────────────────
  const entriesByPageId = new Map<string, SeoEntry>()
  for (const record of entries) {
    entriesByPageId.set(record.data['page-id'], record.data)
  }

  // Build merged rows: every page in the index, with its seo-entry if any.
  // Also include entries that have a page-id not yet in the index (draft state).
  const seen = new Set<string>()
  const rows: PageRowEntry[] = []

  for (const page of pages) {
    const pageId = page.data['page-id']
    if (!pageId) continue
    seen.add(pageId)
    rows.push({
      pageId,
      title: page.data.title ?? '',
      slug: page.data.slug ?? '',
      url: page.data.url ?? '',
      seoEntry: entriesByPageId.get(pageId) ?? null,
    })
  }
  for (const record of entries) {
    const pageId = record.data['page-id']
    if (!pageId || seen.has(pageId)) continue
    seen.add(pageId)
    rows.push({
      pageId,
      title: record.data['last-rendered-title'] ?? '',
      slug: '',
      url: record.data['last-rendered-url'] ?? '',
      seoEntry: record.data,
    })
  }

  const totalPages = rows.length
  const withDesc = rows.filter((r) => Boolean(r.seoEntry?.['meta-description'])).length
  const withOg = rows.filter((r) => Boolean(r.seoEntry?.['og-image-url'])).length
  const indexable = rows.filter((r) => !r.seoEntry?.['no-index']).length

  const pct = (n: number) =>
    totalPages === 0 ? '—' : `${Math.round((n / totalPages) * 100)}%`

  // ── Save handler ────────────────────────────────────────────────────────
  async function handleSave(entry: SeoEntry) {
    const res = await routes.fetch('seo-entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    })
    const body = (await res.json()) as { ok: boolean; error?: string }
    if (!body.ok) throw new Error(body.error ?? 'Save failed')
    await load()
    setExpandedPageId(null)
  }

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Stack gap={20}>
      <Heading level={2}>SEO Suite</Heading>

      {error && (
        <Alert tone="danger" title="Error loading SEO data">
          {error}
        </Alert>
      )}

      {/* Stats row */}
      <Stack direction="row" gap={12} wrap>
        <StatCard label="Total pages" value={String(totalPages)} detail="in page index" />
        <StatCard label="With description" value={pct(withDesc)} detail={`${withDesc} of ${totalPages}`} />
        <StatCard label="With OG image" value={pct(withOg)} detail={`${withOg} of ${totalPages}`} />
        <StatCard label="Indexable" value={pct(indexable)} detail={`${indexable} of ${totalPages}`} />
      </Stack>

      {/* Page table */}
      {loading && <Text variant="muted">Loading…</Text>}

      {!loading && rows.length === 0 && (
        <EmptyState
          title="No pages found"
          body="Add pages in the site editor and publish them to see their SEO health here."
        />
      )}

      {!loading && rows.length > 0 && (
        <Stack gap={8}>
          <Stack direction="row" gap={8} align="center">
            <Heading level={3}>Pages</Heading>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              Refresh
            </Button>
          </Stack>

          <Stack gap={4}>
            {rows.map((row) => (
              <PageRow
                key={row.pageId}
                row={row}
                expanded={expandedPageId === row.pageId}
                onToggle={() =>
                  setExpandedPageId((prev) => (prev === row.pageId ? null : row.pageId))
                }
                onSave={handleSave}
              />
            ))}
          </Stack>
        </Stack>
      )}

      <Text variant="muted">
        Configure global SEO defaults (site URL, OG image, robots.txt) in the{' '}
        <strong>Settings</strong> panel on the plugin card.
      </Text>
    </Stack>
  )
}

export default definePluginAdminApp(SeoSuiteDashboard)
