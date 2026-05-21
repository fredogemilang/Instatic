/**
 * Subscribe, confirm, unsubscribe, and preferences routes.
 *
 * Public routes (no auth) use getPublic/postPublic — accessible from
 * published pages and email links. Admin routes use post/patch/delete
 * with the 'plugins.manage' capability.
 *
 * Route URL prefix (all routes):
 *   /admin/api/cms/plugins/pagebuilder.newsletter/runtime
 */
import type { ServerPluginApi, StorageFilterValue } from '@pagebuilder/plugin-sdk'
import { generateToken, sendEmail } from './resend'
import {
  renderConfirmPage,
  renderUnsubscribePage,
  renderPreferencesPage,
  renderPreferencesSavedPage,
  renderAlreadySubscribedPage,
  renderErrorPage,
  renderOptInEmail,
} from './templates'
import { toCsv } from './csv'

// ---------------------------------------------------------------------------
// Shape of subscriber data stored in the 'subscribers' collection
// ---------------------------------------------------------------------------

export interface SubscriberData {
  email: string
  name: string
  status: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced'
  listIds: string[]
  source: string
  subscribedAt: string
  confirmedAt: string | null
  unsubscribedAt: string | null
  confirmationToken: string
  unsubscribeToken: string
}

// ---------------------------------------------------------------------------
// URL utilities
// ---------------------------------------------------------------------------

/**
 * Extract path segments relative to the plugin's runtime root.
 *
 * For a request to:
 *   /admin/api/cms/plugins/pagebuilder.newsletter/runtime/preferences/abc123/save
 * Returns: ['preferences', 'abc123', 'save']
 */
function getSegments(req: Request): string[] {
  const url = new URL(req.url)
  const marker = '/runtime/'
  const idx = url.pathname.indexOf(marker)
  const relative = idx >= 0 ? url.pathname.slice(idx + marker.length) : url.pathname
  return relative.split('/').filter(Boolean)
}

function runtimeBase(pluginId: string, siteUrl: string): string {
  return `${siteUrl}/admin/api/cms/plugins/${pluginId}/runtime`
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

function htmlResponse(body: string, status = 200): Record<string, unknown> {
  return {
    __response: true,
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body,
  }
}

function redirectResponse(location: string): Record<string, unknown> {
  return { __response: true, status: 302, headers: { Location: location }, body: '' }
}

// ---------------------------------------------------------------------------
// Public route registrations
// ---------------------------------------------------------------------------

export function registerSubscribeRoutes(api: ServerPluginApi): void {
  const subs = api.cms.storage.collection('subscribers')
  const lists = api.cms.storage.collection('lists')

  // ── GET /subscribe ──────────────────────────────────────────────────────
  // HTML form submission from published pages. Query params:
  //   email (required), name, listIds (comma-sep), consent (=true/1), redirect
  api.cms.routes.getPublic('/subscribe', async (ctx) => {
    const url = new URL(ctx.req.url)
    const email = url.searchParams.get('email')?.trim() ?? ''
    const name = url.searchParams.get('name')?.trim() ?? ''
    const listIdsRaw = url.searchParams.get('listIds') ?? ''
    const consent = url.searchParams.get('consent')
    const redirect = url.searchParams.get('redirect') ?? '/'

    if (!isValidEmail(email)) {
      return htmlResponse(renderErrorPage('Please enter a valid email address.'))
    }
    if (!consent || (consent !== 'true' && consent !== '1')) {
      return htmlResponse(renderErrorPage('You must provide consent to subscribe.'))
    }

    const requestedListIds = listIdsRaw
      ? listIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : []

    try {
      const { records: matchingSubs } = await subs.list({ filter: { email: { like: email } }, limit: 1 })
      const existing = matchingSubs[0]

      const siteName = api.cms.settings.get<string>('fromName') ?? 'Newsletter'

      if (existing) {
        const data = existing.data as SubscriberData
        if (data.status === 'confirmed' || data.status === 'pending') {
          return htmlResponse(renderAlreadySubscribedPage(siteName))
        }
        // Re-subscribe: mark pending/confirmed again
        const confirmationToken = generateToken()
        const unsubscribeToken = data.unsubscribeToken || generateToken()
        const { records: allListRecords } = await lists.list()
        const resolvedListIds = resolveListIds(requestedListIds, allListRecords)
        const doubleOptIn = api.cms.settings.get<boolean>('doubleOptIn') ?? true
        const newStatus = doubleOptIn ? 'pending' : 'confirmed'

        await subs.update(existing.id, {
          name,
          status: newStatus,
          listIds: resolvedListIds,
          subscribedAt: new Date().toISOString(),
          confirmedAt: doubleOptIn ? null : new Date().toISOString(),
          unsubscribedAt: null,
          confirmationToken,
          unsubscribeToken,
        })

        if (doubleOptIn) {
          await sendOptInEmail(api, email, siteName, confirmationToken)
        }

        await api.cms.hooks.emit('newsletter.subscribed', {
          subscriberId: existing.id,
          email,
          listIds: resolvedListIds,
          source: 'form',
        })
        return redirectResponse(`${redirect}?nl=subscribed`)
      }

      // New subscriber
      const { records: allListRecords } = await lists.list()
      const resolvedListIds = resolveListIds(requestedListIds, allListRecords)
      const doubleOptIn = api.cms.settings.get<boolean>('doubleOptIn') ?? true
      const confirmationToken = generateToken()
      const unsubscribeToken = generateToken()

      const record = await subs.create({
        email,
        name,
        status: doubleOptIn ? 'pending' : 'confirmed',
        listIds: resolvedListIds,
        source: 'form',
        subscribedAt: new Date().toISOString(),
        confirmedAt: doubleOptIn ? null : new Date().toISOString(),
        unsubscribedAt: null,
        confirmationToken,
        unsubscribeToken,
      })

      if (doubleOptIn) {
        await sendOptInEmail(api, email, siteName, confirmationToken)
      }

      await api.cms.hooks.emit('newsletter.subscribed', {
        subscriberId: record.id,
        email,
        listIds: resolvedListIds,
        source: 'form',
      })
      return redirectResponse(`${redirect}?nl=subscribed`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Subscription failed'
      console.error('[newsletter] GET /subscribe error:', err)
      return htmlResponse(renderErrorPage(message))
    }
  })

  // ── GET /confirm ─────────────────────────────────────────────────────────
  // Confirms a pending subscription via the token in the opt-in email.
  api.cms.routes.getPublic('/confirm', async (ctx) => {
    const url = new URL(ctx.req.url)
    const token = url.searchParams.get('token') ?? ''
    const siteName = api.cms.settings.get<string>('fromName') ?? 'Newsletter'

    if (!token) return htmlResponse(renderErrorPage('Invalid confirmation link.'))

    try {
      const { records: all } = await subs.list({ filter: { confirmationToken: token }, limit: 1 })
      const record = all[0]

      if (!record) return htmlResponse(renderErrorPage('This confirmation link is invalid or has already been used.'))

      const data = record.data as SubscriberData
      if (data.status === 'confirmed') {
        return htmlResponse(renderConfirmPage(siteName, data.email))
      }

      await subs.update(record.id, {
        status: 'confirmed',
        confirmedAt: new Date().toISOString(),
        confirmationToken: '', // invalidate token
      })

      await api.cms.hooks.emit('newsletter.confirmed', {
        subscriberId: record.id,
        email: data.email,
      })

      return htmlResponse(renderConfirmPage(siteName, data.email))
    } catch (err) {
      console.error('[newsletter] GET /confirm error:', err)
      return htmlResponse(renderErrorPage('Confirmation failed. Please try again.'))
    }
  })

  // ── GET /unsubscribe ──────────────────────────────────────────────────────
  // One-click unsubscribe via the token embedded in every email footer.
  api.cms.routes.getPublic('/unsubscribe', async (ctx) => {
    const url = new URL(ctx.req.url)
    const token = url.searchParams.get('token') ?? ''
    const siteName = api.cms.settings.get<string>('fromName') ?? 'Newsletter'

    if (!token) return htmlResponse(renderErrorPage('Invalid unsubscribe link.'))

    try {
      const { records: all } = await subs.list({ filter: { unsubscribeToken: token }, limit: 1 })
      const record = all[0]

      if (!record) return htmlResponse(renderErrorPage('This unsubscribe link is invalid.'))

      const data = record.data as SubscriberData
      if (data.status === 'unsubscribed') {
        return htmlResponse(renderUnsubscribePage(siteName, data.email))
      }

      await subs.update(record.id, {
        status: 'unsubscribed',
        unsubscribedAt: new Date().toISOString(),
      })

      await api.cms.hooks.emit('newsletter.unsubscribed', {
        subscriberId: record.id,
        email: data.email,
        reason: 'user',
      })

      return htmlResponse(renderUnsubscribePage(siteName, data.email))
    } catch (err) {
      console.error('[newsletter] GET /unsubscribe error:', err)
      return htmlResponse(renderErrorPage('Unsubscribe failed. Please try again.'))
    }
  })

  // ── GET /preferences/:token ───────────────────────────────────────────────
  // HTML preferences page — lets subscribers manage their list memberships.
  api.cms.routes.getPublic('/preferences/:token', async (ctx) => {
    const segments = getSegments(ctx.req)
    const token = segments[1] ?? ''
    const siteName = api.cms.settings.get<string>('fromName') ?? 'Newsletter'
    const siteUrl = (api.cms.settings.get<string>('siteUrl') ?? '').replace(/\/$/, '')

    if (!token) return htmlResponse(renderErrorPage('Invalid preferences link.'))

    try {
      const { records: all } = await subs.list({ filter: { unsubscribeToken: token }, limit: 1 })
      const record = all[0]

      if (!record) return htmlResponse(renderErrorPage('This preferences link is invalid.'))

      const data = record.data as SubscriberData
      const { records: allListRecords } = await lists.list()
      const allLists = allListRecords.map((r) => ({
        id: r.id,
        name: String(r.data.name ?? ''),
        description: String(r.data.description ?? ''),
      }))

      return htmlResponse(
        renderPreferencesPage(
          siteName,
          data.email,
          token,
          runtimeBase(api.plugin.id, siteUrl),
          allLists,
          data.listIds,
        ),
      )
    } catch (err) {
      console.error('[newsletter] GET /preferences error:', err)
      return htmlResponse(renderErrorPage('Failed to load preferences.'))
    }
  })

  // ── GET /preferences/:token/save ─────────────────────────────────────────
  // Processes the GET form submission from the preferences page.
  // Selected checkboxes appear as repeated ?listId=... params.
  api.cms.routes.getPublic('/preferences/:token/save', async (ctx) => {
    const segments = getSegments(ctx.req)
    const token = segments[1] ?? ''
    const url = new URL(ctx.req.url)
    const selectedListIds = url.searchParams.getAll('listId')
    const siteName = api.cms.settings.get<string>('fromName') ?? 'Newsletter'

    if (!token) return htmlResponse(renderErrorPage('Invalid preferences link.'))

    try {
      const { records: all } = await subs.list({ filter: { unsubscribeToken: token }, limit: 1 })
      const record = all[0]

      if (!record) return htmlResponse(renderErrorPage('This preferences link is invalid.'))

      await subs.update(record.id, { listIds: selectedListIds })

      return htmlResponse(renderPreferencesSavedPage(siteName))
    } catch (err) {
      console.error('[newsletter] GET /preferences/save error:', err)
      return htmlResponse(renderErrorPage('Failed to save preferences.'))
    }
  })

  // ── GET /subscribers ─────────────────────────────────────────────────────
  // Admin: paginated subscriber list with server-side filters.
  //   ?search=   — case-insensitive LIKE on email. Searching name would require
  //               an OR clause across two fields, which the filter API does not
  //               support (no OR combinator). Email-only search is an accepted
  //               limitation documented here.
  //   ?status=   — exact match on the status field.
  //   ?listId=   — listIds is a JSON array; array-contains cannot be expressed
  //               with the available operators (eq/like compare the whole
  //               serialised value). Filtered in JS after fetching.
  //   ?limit=    — page size (default 20, capped at 1000).
  //   ?offset=   — number of records to skip (default 0).
  api.cms.routes.get('/subscribers', 'plugins.manage', async (ctx) => {
    try {
      const url = new URL(ctx.req.url)
      const statusFilter = url.searchParams.get('status') ?? ''
      const listIdFilter = url.searchParams.get('listId') ?? ''
      const searchParam = url.searchParams.get('search') ?? ''
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10), 1), 1000)
      const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10), 0)

      const filter: Record<string, StorageFilterValue> = {}
      if (statusFilter) filter.status = statusFilter
      if (searchParam) filter.email = { like: `%${searchParam}%` }

      const { records, totalCount } = await subs.list({ filter, limit, offset })

      let subscribers = records.map((r) => {
        const d = r.data as SubscriberData
        return {
          id: r.id,
          email: d.email,
          name: d.name,
          status: d.status,
          listIds: d.listIds,
          source: d.source,
          subscribedAt: d.subscribedAt,
          confirmedAt: d.confirmedAt,
          unsubscribedAt: d.unsubscribedAt,
        }
      })

      if (listIdFilter) {
        subscribers = subscribers.filter((s) => s.listIds.includes(listIdFilter))
      }

      return { ok: true, subscribers, totalCount }
    } catch (err) {
      console.error('[newsletter] GET /subscribers error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to list subscribers' }
    }
  })

  // ── POST /subscribers ─────────────────────────────────────────────────────
  // Admin: manually add a subscriber (skips double-opt-in).
  api.cms.routes.post('/subscribers', 'plugins.manage', async (ctx) => {
    try {
      const body = ctx.body
      const email = String(body.email ?? '').trim()
      const name = String(body.name ?? '').trim()
      const listIds = Array.isArray(body.listIds) ? body.listIds.map(String) : []

      if (!isValidEmail(email)) return { error: 'Invalid email address' }

      const { records: matchingSubs } = await subs.list({ filter: { email: { like: email } }, limit: 1 })
      if (matchingSubs.length > 0) return { error: 'Subscriber already exists' }

      const record = await subs.create({
        email,
        name,
        status: 'confirmed',
        listIds,
        source: 'admin',
        subscribedAt: new Date().toISOString(),
        confirmedAt: new Date().toISOString(),
        unsubscribedAt: null,
        confirmationToken: '',
        unsubscribeToken: generateToken(),
      })

      await api.cms.hooks.emit('newsletter.subscribed', {
        subscriberId: record.id,
        email,
        listIds,
        source: 'admin',
      })

      return { ok: true, subscriber: { id: record.id, email, name, status: 'confirmed', listIds } }
    } catch (err) {
      console.error('[newsletter] POST /subscribers error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to create subscriber' }
    }
  })

  // ── DELETE /subscribers/:id ───────────────────────────────────────────────
  api.cms.routes.delete('/subscribers/:id', 'plugins.manage', async (ctx) => {
    try {
      const segments = getSegments(ctx.req)
      const id = segments[1] ?? ''
      if (!id) return { error: 'Missing subscriber id' }
      const ok = await subs.delete(id)
      return { ok }
    } catch (err) {
      console.error('[newsletter] DELETE /subscribers/:id error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to delete subscriber' }
    }
  })

  // ── GET /subscribers.csv ──────────────────────────────────────────────────
  api.cms.routes.get('/subscribers.csv', 'plugins.manage', async () => {
    try {
      const { records: all } = await subs.list({ limit: 1000 })
      const headers = ['id', 'email', 'name', 'status', 'listIds', 'subscribedAt', 'confirmedAt']
      const rows = all.map((r) => {
        const d = r.data as SubscriberData
        return {
          id: r.id,
          email: d.email,
          name: d.name,
          status: d.status,
          listIds: (d.listIds ?? []).join(';'),
          subscribedAt: d.subscribedAt,
          confirmedAt: d.confirmedAt ?? '',
        }
      })
      const csv = toCsv(headers, rows)
      return {
        __response: true,
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="subscribers.csv"',
        },
        body: csv,
      }
    } catch (err) {
      console.error('[newsletter] GET /subscribers.csv error:', err)
      return { error: err instanceof Error ? err.message : 'Export failed' }
    }
  })

  // ── GET/POST /stats ───────────────────────────────────────────────────────
  api.cms.routes.get('/stats', 'plugins.manage', async () => {
    try {
      const { records: allSubs, totalCount: totalSubs } = await subs.list({ limit: 1000 })
      const counts: Record<string, number> = { pending: 0, confirmed: 0, unsubscribed: 0, bounced: 0 }
      for (const r of allSubs) {
        const s = (r.data as SubscriberData).status
        counts[s] = (counts[s] ?? 0) + 1
      }

      const broadcasts = api.cms.storage.collection('broadcasts')
      const { records: allBroadcasts, totalCount: totalBroadcasts } = await broadcasts.list({ limit: 1000 })
      const bcastCounts: Record<string, number> = { draft: 0, scheduled: 0, sending: 0, sent: 0, failed: 0 }
      for (const r of allBroadcasts) {
        const s = String(r.data.status ?? 'draft')
        bcastCounts[s] = (bcastCounts[s] ?? 0) + 1
      }

      const deliveries = api.cms.storage.collection('deliveries')
      const { records: allDeliveries, totalCount: totalDeliveries } = await deliveries.list({ limit: 1000 })
      const openedDeliveries = allDeliveries.filter((r) => r.data.openedAt).length
      const clickedDeliveries = allDeliveries.filter((r) => r.data.clickedAt).length

      return {
        ok: true,
        subscribers: {
          total: totalSubs,
          ...counts,
        },
        broadcasts: {
          total: totalBroadcasts,
          ...bcastCounts,
        },
        deliveries: {
          total: totalDeliveries,
          opened: openedDeliveries,
          clicked: clickedDeliveries,
        },
      }
    } catch (err) {
      console.error('[newsletter] GET /stats error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to load stats' }
    }
  })

  // ── List management ───────────────────────────────────────────────────────

  api.cms.routes.get('/lists', 'plugins.manage', async () => {
    try {
      const { records: all } = await lists.list()
      return {
        ok: true,
        lists: all.map((r) => ({
          id: r.id,
          name: r.data.name,
          description: r.data.description,
          isDefault: r.data.isDefault,
          createdAt: r.createdAt,
        })),
      }
    } catch (err) {
      console.error('[newsletter] GET /lists error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to list lists' }
    }
  })

  api.cms.routes.post('/lists', 'plugins.manage', async (ctx) => {
    try {
      const body = ctx.body
      const name = String(body.name ?? '').trim()
      if (!name) return { error: 'List name is required' }
      const record = await lists.create({
        name,
        description: String(body.description ?? '').trim(),
        isDefault: body.isDefault === true,
      })
      return { ok: true, list: { id: record.id, name, description: record.data.description, isDefault: record.data.isDefault } }
    } catch (err) {
      console.error('[newsletter] POST /lists error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to create list' }
    }
  })

  api.cms.routes.patch('/lists/:id', 'plugins.manage', async (ctx) => {
    try {
      const segments = getSegments(ctx.req)
      const id = segments[1] ?? ''
      if (!id) return { error: 'Missing list id' }
      const body = ctx.body
      const updated = await lists.update(id, {
        ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
        ...(body.description !== undefined ? { description: String(body.description).trim() } : {}),
        ...(body.isDefault !== undefined ? { isDefault: body.isDefault === true } : {}),
      })
      return { ok: true, list: updated?.data ?? null }
    } catch (err) {
      console.error('[newsletter] PATCH /lists/:id error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to update list' }
    }
  })

  api.cms.routes.delete('/lists/:id', 'plugins.manage', async (ctx) => {
    try {
      const segments = getSegments(ctx.req)
      const id = segments[1] ?? ''
      if (!id) return { error: 'Missing list id' }
      const ok = await lists.delete(id)
      return { ok }
    } catch (err) {
      console.error('[newsletter] DELETE /lists/:id error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to delete list' }
    }
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve requested list IDs, falling back to the default list if none specified. */
function resolveListIds(
  requested: string[],
  allListRecords: Array<{ id: string; data: Record<string, unknown> }>,
): string[] {
  if (requested.length > 0) return requested
  const defaultList = allListRecords.find((r) => r.data.isDefault)
  return defaultList ? [defaultList.id] : []
}

async function sendOptInEmail(
  api: ServerPluginApi,
  email: string,
  siteName: string,
  confirmationToken: string,
): Promise<void> {
  const apiKey = api.cms.settings.get<string>('resendApiKey') ?? ''
  const fromAddress = api.cms.settings.get<string>('fromAddress') ?? ''
  const fromName = api.cms.settings.get<string>('fromName') ?? siteName
  const siteUrl = (api.cms.settings.get<string>('siteUrl') ?? '').replace(/\/$/, '')
  const subject = api.cms.settings.get<string>('optInEmailSubject') ?? 'Please confirm your subscription'
  const body = api.cms.settings.get<string>('optInEmailBody') ?? 'Click the link below to confirm: {{confirm_url}}'

  if (!apiKey || !fromAddress) {
    api.plugin.log('[newsletter] sendOptInEmail: resendApiKey or fromAddress not configured')
    return
  }

  const confirmUrl = `${siteUrl}/admin/api/cms/plugins/${api.plugin.id}/runtime/confirm?token=${encodeURIComponent(confirmationToken)}`
  const { html, text } = renderOptInEmail({ siteName, confirmUrl, subject, optInBody: body })

  try {
    await sendEmail(
      { to: email, subject, html, text, from: `${fromName} <${fromAddress}>` },
      apiKey,
    )
  } catch (err) {
    api.plugin.log('[newsletter] Failed to send opt-in email:', err instanceof Error ? err.message : String(err))
  }
}
