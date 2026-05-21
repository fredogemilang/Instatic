/**
 * Forms Builder — POST /submit handler.
 *
 * Validates incoming form submissions, applies honeypot + rate-limit + optional
 * Turnstile verification, persists to the `submissions` resource, and sends the
 * notification email asynchronously (does not block the HTTP response).
 */
import type { ServerPluginApi } from '@core/plugin-sdk'
import { sendSubmissionEmail } from './email'
import type { EmailSettings } from './email'
import { honeypotFailed, consume, verifyTurnstile } from './spam'

// Fields we strip before persisting so the payload is clean
const CONTROL_FIELDS = new Set(['_form_id', 'cf-turnstile-response'])
const HP_PREFIX = '_hp_'

function stripControlFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body)) {
    if (CONTROL_FIELDS.has(key) || key.startsWith(HP_PREFIX)) continue
    out[key] = value
  }
  return out
}

/** SHA-256 hex digest using the Web Crypto API (available in QuickJS via host). */
async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function readEmailSettings(api: ServerPluginApi): EmailSettings {
  return {
    provider:
      (api.cms.settings.get<string>('provider') as EmailSettings['provider']) ?? 'resend',
    apiKey: api.cms.settings.get<string>('apiKey') ?? '',
    mailgunDomain: api.cms.settings.get<string>('mailgunDomain'),
    fromAddress: api.cms.settings.get<string>('fromAddress') ?? '',
    defaultToAddress: api.cms.settings.get<string>('defaultToAddress') ?? '',
    subjectTemplate:
      api.cms.settings.get<string>('subjectTemplate') ?? '{{form_name}} — new submission',
  }
}

/**
 * Registers the public POST /submit route on the given API.
 * Called from server/index.ts during `activate`.
 */
export function registerSubmitRoute(api: ServerPluginApi): void {
  const submissions = api.cms.storage.collection('submissions')

  api.cms.routes.postPublic('/submit', async (ctx) => {
    const body = ctx.body as Record<string, unknown>

    // Helper: build a JSON error response with status + machine-readable
    // error body. The inline submit-intercept script reads `data.error`
    // and renders it as the inline failure status; without a JSON body,
    // the visitor would see "Sorry — something went wrong" on every
    // failure mode and have no idea what to fix.
    function errorResponse(status: number, message: string) {
      return {
        __response: true,
        status,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: message }),
      }
    }

    // 1. Honeypot — silently discard bot submissions (200, no leak about
    //    why we rejected them).
    if (honeypotFailed(body)) {
      return { ok: true }
    }

    // 2. Form ID is required. Without it, the submission can't be linked
    //    to a form in the admin dashboard. Return a clear error so the
    //    site owner sees it in the inline status — most common reason
    //    this is missing is a Form module dragged onto the canvas
    //    without configuring the "Form ID" prop.
    const formId = typeof body['_form_id'] === 'string' ? body['_form_id'].trim() : ''
    if (!formId) {
      return errorResponse(
        400,
        'Form is not configured: missing Form ID. Open the page editor, select the Form module, and set a Form ID.',
      )
    }

    // 3. Rate limiting
    const rateLimit = (api.cms.settings.get<number>('rateLimit') as number | undefined) ?? 5
    const remoteIp =
      (ctx.req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() ||
      'unknown'
    const ipHash = await sha256Hex(remoteIp)
    if (!consume(ipHash, rateLimit)) {
      return errorResponse(429, 'Too many submissions from your network. Please wait a minute and try again.')
    }

    // 4. Turnstile (optional)
    const enableTurnstile = api.cms.settings.get<boolean>('enableTurnstile') ?? false
    if (enableTurnstile) {
      const token = typeof body['cf-turnstile-response'] === 'string' ? body['cf-turnstile-response'] : ''
      const secret = api.cms.settings.get<string>('turnstileSecretKey') ?? ''
      if (token && secret) {
        const passed = await verifyTurnstile(token, secret)
        if (!passed) {
          return errorResponse(403, 'Anti-spam verification failed. Refresh the page and try again.')
        }
      }
    }

    // 5. Persist submission
    const pagePath = ctx.req.headers.get('referer') ?? ''
    const userAgent = ctx.req.headers.get('user-agent') ?? ''
    const payload = stripControlFields(body)

    let record
    try {
      record = await submissions.create({
        formId,
        pagePath,
        submittedAt: new Date().toISOString(),
        payload: JSON.stringify(payload),
        ipHash,
        userAgent,
        status: 'pending',
        errorMessage: '',
      })
    } catch (err) {
      console.error('[plugin:pagebuilder.forms] Failed to persist submission:', err)
      return errorResponse(500, 'Could not save your submission. Please try again later.')
    }

    // 6. Send email asynchronously — do not block response
    const emailSettings = readEmailSettings(api)
    ;(async () => {
      try {
        await sendSubmissionEmail(
          {
            formName: formId,
            formId,
            pagePath,
            submittedAt: record.createdAt,
            fields: payload,
          },
          emailSettings,
        )
        await submissions.update(record.id, { status: 'sent', errorMessage: '' })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[plugin:pagebuilder.forms] Email delivery failed:', err)
        await submissions
          .update(record.id, { status: 'failed', errorMessage: message })
          .catch((_e) => { /* storage update failure is non-fatal */ })
      }
    })()

    return { ok: true, message: 'Thank you!' }
  })
}
