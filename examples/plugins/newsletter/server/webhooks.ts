/**
 * Resend webhook handler.
 *
 * Registered as a public POST route — Resend POSTs JSON to this URL when
 * email events occur. The handler verifies the Svix signature and updates
 * delivery / subscriber records accordingly.
 *
 * Supported events:
 *   email.bounced     — mark subscriber bounced + update delivery
 *   email.complained  — mark subscriber unsubscribed + update delivery
 *   email.opened      — set delivery.openedAt + increment broadcast.openCount
 *   email.clicked     — set delivery.clickedAt + increment broadcast.clickCount
 */
import type { ServerPluginApi } from '@pagebuilder/plugin-sdk'
import { verifyWebhookSignature } from './resend'

export function registerWebhookRoutes(api: ServerPluginApi): void {
  api.cms.routes.postPublic('/webhooks/resend', async (ctx) => {
    try {
      const secret = api.cms.settings.get<string>('resendWebhookSecret') ?? ''
      if (!secret) {
        api.plugin.log('[newsletter] webhook: resendWebhookSecret not configured, rejecting')
        return { __response: true, status: 400, headers: {}, body: 'Webhook secret not configured' }
      }

      // Get Svix headers for signature verification.
      const svixId = ctx.req.headers.get('svix-id') ?? ''
      const svixTimestamp = ctx.req.headers.get('svix-timestamp') ?? ''
      const svixSignature = ctx.req.headers.get('svix-signature') ?? ''

      // Read raw body for HMAC verification. The host parses JSON into ctx.body
      // before calling the handler; we attempt to read the original stream and
      // fall back to JSON.stringify(ctx.body) if the stream was already consumed.
      let rawBody: string
      try {
        rawBody = await ctx.req.text()
      } catch (_err) {
        rawBody = JSON.stringify(ctx.body)
      }

      if (svixId && svixTimestamp && svixSignature) {
        const valid = await verifyWebhookSignature(rawBody, svixId, svixTimestamp, svixSignature, secret)
        if (!valid) {
          api.plugin.log('[newsletter] webhook: signature verification failed')
          return { __response: true, status: 401, headers: {}, body: 'Invalid signature' }
        }
      }

      const event = ctx.body
      const eventType = String(event.type ?? '')
      const data = (event.data ?? {}) as Record<string, unknown>

      api.plugin.log('[newsletter] webhook event:', eventType)

      await handleWebhookEvent(eventType, data, api)

      return { ok: true }
    } catch (err) {
      console.error('[newsletter] POST /webhooks/resend error:', err)
      return { error: err instanceof Error ? err.message : 'Webhook processing failed' }
    }
  })
}

async function handleWebhookEvent(
  eventType: string,
  data: Record<string, unknown>,
  api: ServerPluginApi,
): Promise<void> {
  const resendId = String(data.email_id ?? data.id ?? '')
  const deliveries = api.cms.storage.collection('deliveries')
  const subs = api.cms.storage.collection('subscribers')
  const broadcasts = api.cms.storage.collection('broadcasts')

  // Find the delivery record by the Resend message ID.
  const { records: deliveryRecords } = await deliveries.list({ filter: { resendId: resendId }, limit: 1 })
  const delivery = deliveryRecords[0]

  switch (eventType) {
    case 'email.bounced': {
      if (delivery) {
        await deliveries.update(delivery.id, { bounced: true })
        // Update broadcast clickCount if delivery links to one.
        await incrementBroadcastCounter(broadcasts, String(delivery.data.broadcastId ?? ''), 'openCount', 0)
      }
      // Mark subscriber as bounced.
      const toEmail = String(data.to ?? '')
      if (toEmail) {
        // like without wildcards is case-insensitive exact match:
        //   lower(field) like lower('user@example.com') — no % anchors needed.
        const { records: subRecords } = await subs.list({ filter: { email: { like: toEmail } }, limit: 1 })
        const sub = subRecords[0]
        if (sub) {
          await subs.update(sub.id, { status: 'bounced' })
          await api.cms.hooks.emit('newsletter.unsubscribed', {
            subscriberId: sub.id,
            email: toEmail,
            reason: 'bounced',
          })
        }
      }
      break
    }

    case 'email.complained': {
      // Treat spam complaints as an immediate unsubscribe.
      const toEmail = String(data.to ?? '')
      if (toEmail) {
        const { records: subRecords } = await subs.list({ filter: { email: { like: toEmail } }, limit: 1 })
        const sub = subRecords[0]
        if (sub) {
          await subs.update(sub.id, { status: 'unsubscribed', unsubscribedAt: new Date().toISOString() })
          await api.cms.hooks.emit('newsletter.unsubscribed', {
            subscriberId: sub.id,
            email: toEmail,
            reason: 'complained',
          })
        }
      }
      break
    }

    case 'email.opened': {
      if (delivery && !delivery.data.openedAt) {
        await deliveries.update(delivery.id, { openedAt: new Date().toISOString() })
        await incrementBroadcastCounter(broadcasts, String(delivery.data.broadcastId ?? ''), 'openCount', 1)
      }
      break
    }

    case 'email.clicked': {
      if (delivery && !delivery.data.clickedAt) {
        await deliveries.update(delivery.id, { clickedAt: new Date().toISOString() })
        await incrementBroadcastCounter(broadcasts, String(delivery.data.broadcastId ?? ''), 'clickCount', 1)
      }
      break
    }

    default:
      api.plugin.log('[newsletter] webhook: unhandled event type', eventType)
  }
}

async function incrementBroadcastCounter(
  broadcasts: ReturnType<ServerPluginApi['cms']['storage']['collection']>,
  broadcastId: string,
  field: 'openCount' | 'clickCount',
  delta: number,
): Promise<void> {
  if (!broadcastId || delta === 0) return
  const { records: all } = await broadcasts.list()
  const bRecord = all.find((r) => r.id === broadcastId)
  if (!bRecord) return
  const current = Number(bRecord.data[field] ?? 0)
  await broadcasts.update(broadcastId, { [field]: current + delta })
}
