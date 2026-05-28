/**
 * Broadcast management routes + scheduled-send worker.
 *
 * Routes — GET requires `plugins.read`; mutating routes require `plugins.configure`:
 *   GET    /broadcasts            — list all broadcasts
 *   POST   /broadcasts            — create draft
 *   PATCH  /broadcasts/:id        — update draft (subject, body, lists, scheduledAt)
 *   POST   /broadcasts/:id/send   — trigger immediate send
 *   POST   /broadcasts/:id/preview — send preview to a single address
 *
 * Scheduled job ('send-scheduled', every 5 min):
 *   Finds broadcasts with status='scheduled' and scheduledAt ≤ now; sends each.
 */
import type { ServerPluginApi } from '@pagebuilder/plugin-sdk'
import { sendEmail, sendBatch } from './resend'
import { renderBroadcastEmail } from './templates'
import type { SubscriberData } from './subscribe'

// ---------------------------------------------------------------------------
// Storage shapes
// ---------------------------------------------------------------------------

export interface BroadcastData {
  subject: string
  htmlBody: string
  plainBody: string
  listIds: string[]
  status: 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed'
  scheduledAt: string | null
  sentAt: string | null
  recipientCount: number
  openCount: number
  clickCount: number
}


// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function getSegments(req: Request): string[] {
  const url = new URL(req.url)
  const marker = '/runtime/'
  const idx = url.pathname.indexOf(marker)
  const relative = idx >= 0 ? url.pathname.slice(idx + marker.length) : url.pathname
  return relative.split('/').filter(Boolean)
}

// ---------------------------------------------------------------------------
// Route registrations
// ---------------------------------------------------------------------------

export function registerBroadcastRoutes(api: ServerPluginApi): void {
  const broadcasts = api.cms.storage.collection('broadcasts')
  const subs = api.cms.storage.collection('subscribers')
  const deliveries = api.cms.storage.collection('deliveries')

  // ── GET /broadcasts ───────────────────────────────────────────────────────
  api.cms.routes.get('/broadcasts', 'plugins.read', async () => {
    try {
      const { records: all } = await broadcasts.list()
      return {
        ok: true,
        broadcasts: all.map((r) => {
          const d = r.data as BroadcastData
          return {
            id: r.id,
            subject: d.subject,
            status: d.status,
            scheduledAt: d.scheduledAt,
            sentAt: d.sentAt,
            listIds: d.listIds,
            recipientCount: d.recipientCount,
            openCount: d.openCount,
            clickCount: d.clickCount,
            createdAt: r.createdAt,
          }
        }),
      }
    } catch (err) {
      console.error('[newsletter] GET /broadcasts error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to list broadcasts' }
    }
  })

  // ── POST /broadcasts ──────────────────────────────────────────────────────
  api.cms.routes.post('/broadcasts', 'plugins.configure', async (ctx) => {
    try {
      const body = ctx.body
      const subject = String(body.subject ?? '').trim()
      if (!subject) return { error: 'Subject is required' }

      const record = await broadcasts.create({
        subject,
        htmlBody: String(body.htmlBody ?? ''),
        plainBody: String(body.plainBody ?? ''),
        listIds: Array.isArray(body.listIds) ? body.listIds.map(String) : [],
        status: 'draft',
        scheduledAt: null,
        sentAt: null,
        recipientCount: 0,
        openCount: 0,
        clickCount: 0,
      })

      return { ok: true, broadcast: { id: record.id, ...(record.data as BroadcastData) } }
    } catch (err) {
      console.error('[newsletter] POST /broadcasts error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to create broadcast' }
    }
  })

  // ── PATCH /broadcasts/:id ─────────────────────────────────────────────────
  api.cms.routes.patch('/broadcasts/:id', 'plugins.configure', async (ctx) => {
    try {
      const segments = getSegments(ctx.req)
      const id = segments[1] ?? ''
      if (!id) return { error: 'Missing broadcast id' }

      const body = ctx.body
      const patch: Record<string, unknown> = {}
      if (body.subject !== undefined) patch.subject = String(body.subject).trim()
      if (body.htmlBody !== undefined) patch.htmlBody = String(body.htmlBody)
      if (body.plainBody !== undefined) patch.plainBody = String(body.plainBody)
      if (body.listIds !== undefined) patch.listIds = Array.isArray(body.listIds) ? body.listIds.map(String) : []
      if (body.scheduledAt !== undefined) {
        patch.scheduledAt = body.scheduledAt ? String(body.scheduledAt) : null
        patch.status = body.scheduledAt ? 'scheduled' : 'draft'
      }

      const updated = await broadcasts.update(id, patch)
      return { ok: true, broadcast: updated?.data ?? null }
    } catch (err) {
      console.error('[newsletter] PATCH /broadcasts/:id error:', err)
      return { error: err instanceof Error ? err.message : 'Failed to update broadcast' }
    }
  })

  // ── POST /broadcasts/:id/send ─────────────────────────────────────────────
  api.cms.routes.post('/broadcasts/:id/send', 'plugins.configure', async (ctx) => {
    try {
      const segments = getSegments(ctx.req)
      const id = segments[1] ?? ''
      if (!id) return { error: 'Missing broadcast id' }

      const result = await executeSend(id, api, broadcasts, subs, deliveries)
      return result
    } catch (err) {
      console.error('[newsletter] POST /broadcasts/:id/send error:', err)
      return { error: err instanceof Error ? err.message : 'Send failed' }
    }
  })

  // ── POST /broadcasts/:id/preview ──────────────────────────────────────────
  api.cms.routes.post('/broadcasts/:id/preview', 'plugins.configure', async (ctx) => {
    try {
      const segments = getSegments(ctx.req)
      const id = segments[1] ?? ''
      if (!id) return { error: 'Missing broadcast id' }

      const toEmail = String(ctx.body.email ?? '').trim()
      if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
        return { error: 'Valid email address required' }
      }

      const { records: allBroadcasts } = await broadcasts.list()
      const bRecord = allBroadcasts.find((r) => r.id === id)
      if (!bRecord) return { error: 'Broadcast not found' }

      const d = bRecord.data as BroadcastData
      const apiKey = api.cms.settings.get<string>('resendApiKey') ?? ''
      const fromAddress = api.cms.settings.get<string>('fromAddress') ?? ''
      const fromName = api.cms.settings.get<string>('fromName') ?? ''
      const siteUrl = (api.cms.settings.get<string>('siteUrl') ?? '').replace(/\/$/, '')
      const runtimeBase = `${siteUrl}/admin/api/cms/plugins/${api.plugin.id}/runtime`

      if (!apiKey || !fromAddress) return { error: 'Resend API key or from address not configured' }

      const { html, text } = renderBroadcastEmail({
        siteName: fromName,
        subject: `[PREVIEW] ${d.subject}`,
        htmlBody: d.htmlBody,
        plainBody: d.plainBody,
        preferencesUrl: `${runtimeBase}/preferences/preview-token`,
        unsubscribeUrl: `${runtimeBase}/unsubscribe?token=preview-token`,
      })

      await sendEmail(
        { to: toEmail, subject: `[PREVIEW] ${d.subject}`, html, text, from: `${fromName} <${fromAddress}>` },
        apiKey,
      )

      return { ok: true }
    } catch (err) {
      console.error('[newsletter] POST /broadcasts/:id/preview error:', err)
      return { error: err instanceof Error ? err.message : 'Preview send failed' }
    }
  })
}

// ---------------------------------------------------------------------------
// Scheduled job registration
// ---------------------------------------------------------------------------

export function registerBroadcastSchedule(api: ServerPluginApi): void {
  const broadcasts = api.cms.storage.collection('broadcasts')
  const subs = api.cms.storage.collection('subscribers')
  const deliveries = api.cms.storage.collection('deliveries')

  api.cms.schedule.register({
    id: 'send-scheduled',
    cadence: { interval: 'every', minutes: 5 },
    overlap: 'skip',
    // 2 minutes — large enough for a moderate subscriber list (50 per chunk).
    maxDurationMs: 120_000,
    handler: async () => {
      const now = new Date().toISOString()
      // Push the status + scheduledAt filter to the DB layer.
      // ISO 8601 strings compare correctly lexicographically, so lte works fine.
      const { records: due } = await broadcasts.list({
        filter: { status: 'scheduled', scheduledAt: { lte: now } },
      })

      for (const bRecord of due) {
        try {
          await executeSend(bRecord.id, api, broadcasts, subs, deliveries)
        } catch (err) {
          api.plugin.log(
            '[newsletter] Scheduled send failed for broadcast',
            bRecord.id,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Core send logic — shared by the on-demand route and the scheduled job
// ---------------------------------------------------------------------------

async function executeSend(
  broadcastId: string,
  api: ServerPluginApi,
  broadcasts: ReturnType<ServerPluginApi['cms']['storage']['collection']>,
  subs: ReturnType<ServerPluginApi['cms']['storage']['collection']>,
  deliveries: ReturnType<ServerPluginApi['cms']['storage']['collection']>,
): Promise<Record<string, unknown>> {
  const { records: allBroadcasts } = await broadcasts.list()
  const bRecord = allBroadcasts.find((r) => r.id === broadcastId)
  if (!bRecord) return { error: 'Broadcast not found' }

  const d = bRecord.data as BroadcastData
  if (d.status === 'sending' || d.status === 'sent') {
    return { error: `Broadcast is already in status "${d.status}"` }
  }

  await broadcasts.update(broadcastId, { status: 'sending' })

  const apiKey = api.cms.settings.get<string>('resendApiKey') ?? ''
  const fromAddress = api.cms.settings.get<string>('fromAddress') ?? ''
  const fromName = api.cms.settings.get<string>('fromName') ?? ''
  const siteUrl = (api.cms.settings.get<string>('siteUrl') ?? '').replace(/\/$/, '')
  const runtimeBase = `${siteUrl}/admin/api/cms/plugins/${api.plugin.id}/runtime`

  if (!apiKey || !fromAddress) {
    await broadcasts.update(broadcastId, { status: 'draft' })
    return { error: 'Resend API key or from address not configured' }
  }

  // Fetch only confirmed subscribers — status is a scalar field so eq works.
  // listId membership still requires JS filtering (listIds is a JSON array;
  // array-contains is not expressible with the available filter operators).
  // Limit: 1000 (storage API cap). Newsletters with more recipients would
  // need cursor-based pagination — acceptable for a pre-release build.
  const { records: confirmedSubs } = await subs.list({
    filter: { status: 'confirmed' },
    limit: 1000,
  })
  const targetSubs = confirmedSubs.filter((r) => {
    const sub = r.data as SubscriberData
    if (d.listIds.length === 0) return true
    return d.listIds.some((lid) => sub.listIds.includes(lid))
  })

  let sentCount = 0
  let failed = false
  const BATCH_SIZE = 50

  try {
    for (let i = 0; i < targetSubs.length; i += BATCH_SIZE) {
      const chunk = targetSubs.slice(i, i + BATCH_SIZE)
      const messages = chunk.map((subRecord) => {
        const sub = subRecord.data as SubscriberData
        const preferencesUrl = `${runtimeBase}/preferences/${sub.unsubscribeToken}`
        const unsubscribeUrl = `${runtimeBase}/unsubscribe?token=${encodeURIComponent(sub.unsubscribeToken)}`
        const { html, text } = renderBroadcastEmail({
          siteName: fromName,
          subject: d.subject,
          htmlBody: d.htmlBody,
          plainBody: d.plainBody,
          preferencesUrl,
          unsubscribeUrl,
        })
        return {
          to: sub.email,
          subject: d.subject,
          html,
          text,
          from: `${fromName} <${fromAddress}>`,
          subscriberId: subRecord.id,
        }
      })

      const batchPayload = messages.map(({ subscriberId: _s, ...m }) => m)
      let batchResult: { data: Array<{ id: string }> }
      try {
        batchResult = await sendBatch(batchPayload, apiKey)
      } catch (err) {
        api.plugin.log('[newsletter] Batch send failed:', err instanceof Error ? err.message : String(err))
        failed = true
        break
      }

      // Record deliveries
      const now = new Date().toISOString()
      for (let j = 0; j < chunk.length; j++) {
        const resendId = batchResult.data[j]?.id ?? null
        await deliveries.create({
          broadcastId,
          subscriberId: messages[j].subscriberId,
          sentAt: now,
          openedAt: null,
          clickedAt: null,
          bounced: false,
          resendId,
        })
      }

      sentCount += chunk.length
    }
  } catch (err) {
    api.plugin.log('[newsletter] executeSend error:', err instanceof Error ? err.message : String(err))
    failed = true
  }

  const finalStatus = failed ? 'failed' : 'sent'
  await broadcasts.update(broadcastId, {
    status: finalStatus,
    sentAt: new Date().toISOString(),
    recipientCount: sentCount,
  })

  if (!failed) {
    await api.cms.hooks.emit('newsletter.broadcast.sent', {
      broadcastId,
      recipientCount: sentCount,
      listIds: d.listIds,
    })
  }

  return { ok: !failed, status: finalStatus, recipientCount: sentCount }
}
