/**
 * Forms Builder — server entrypoint.
 *
 * Lifecycle:
 *   install   — no-op (resources are declared in the manifest; host creates them)
 *   activate  — register public POST /submit + authenticated admin routes
 *   deactivate — no-op (routes auto-removed by host)
 *   uninstall — remove all stored submissions
 */
import type { ServerPluginApi, ServerPluginModule } from '@core/plugin-sdk'
import type { StorageFilterValue } from '@core/plugin-sdk'
import { registerSubmitRoute } from './submit'

const mod: ServerPluginModule = {
  install(api: ServerPluginApi) {
    api.plugin.log('Forms Builder installed')
  },

  activate(api: ServerPluginApi) {
    api.plugin.log('Forms Builder activated')

    const submissions = api.cms.storage.collection('submissions')

    // Public submission endpoint — unauthenticated POST from published pages
    registerSubmitRoute(api)

    // Admin: list submissions with server-side filtering and pagination.
    //
    // Supported query params:
    //   formId    — filter by exact form ID (stored as data.formId)
    //   status    — filter by status: 'pending' | 'sent' | 'failed'
    //   dateGte   — ISO 8601 lower bound on data.submittedAt (inclusive)
    //   dateLte   — ISO 8601 upper bound on data.submittedAt (inclusive)
    //   limit     — page size (1–100, default 25)
    //   offset    — record offset (default 0)
    //
    // Response: { submissions: PluginRecord[]; totalCount: number }
    api.cms.routes.get('/submissions', 'plugins.read', async (ctx) => {
      const url = new URL(ctx.req.url)
      const formId = url.searchParams.get('formId')
      const status = url.searchParams.get('status')
      const dateGte = url.searchParams.get('dateGte')
      const dateLte = url.searchParams.get('dateLte')
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? '25')), 100)
      const offset = Math.max(0, Number(url.searchParams.get('offset') ?? '0'))

      const filter: Record<string, StorageFilterValue> = {}
      if (formId) filter['formId'] = formId
      if (status) filter['status'] = status
      if (dateGte || dateLte) {
        filter['submittedAt'] = {
          ...(dateGte ? { gte: dateGte } : {}),
          ...(dateLte ? { lte: dateLte } : {}),
        }
      }

      const { records, totalCount } = await submissions.list({
        filter: Object.keys(filter).length > 0 ? filter : undefined,
        limit,
        offset,
      })
      return { submissions: records, totalCount }
    })

    // Admin: resend email for a specific submission
    api.cms.routes.post('/resend', 'plugins.configure', async (ctx) => {
      const url = new URL(ctx.req.url)
      const id = url.searchParams.get('id') ?? ''
      if (!id) return { error: 'Missing submission id' }

      const { records: all } = await submissions.list({ limit: 1000 })
      const record = all.find((r) => r.id === id)
      if (!record) return { error: 'Submission not found' }

      const { sendSubmissionEmail } = await import('./email')
      const payload = (() => {
        try {
          return JSON.parse(String(record.data['payload'] ?? '{}')) as Record<string, unknown>
        } catch (_e) {
          return {}
        }
      })()

      try {
        await sendSubmissionEmail(
          {
            formName: String(record.data['formId'] ?? ''),
            formId: String(record.data['formId'] ?? ''),
            pagePath: String(record.data['pagePath'] ?? ''),
            submittedAt: String(record.data['submittedAt'] ?? record.createdAt),
            fields: payload,
          },
          {
            provider:
              (api.cms.settings.get<string>('provider') as 'resend' | 'postmark' | 'mailgun') ??
              'resend',
            apiKey: api.cms.settings.get<string>('apiKey') ?? '',
            mailgunDomain: api.cms.settings.get<string>('mailgunDomain'),
            fromAddress: api.cms.settings.get<string>('fromAddress') ?? '',
            defaultToAddress: api.cms.settings.get<string>('defaultToAddress') ?? '',
            subjectTemplate:
              api.cms.settings.get<string>('subjectTemplate') ?? '{{form_name}} — new submission',
          },
        )
        await submissions.update(id, { status: 'sent', errorMessage: '' })
        return { ok: true }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[plugin:pagebuilder.forms] Resend failed:', err)
        await submissions
          .update(id, { status: 'failed', errorMessage: message })
          .catch((_e) => { /* non-fatal */ })
        return { error: message }
      }
    })

    // Admin: delete a submission
    api.cms.routes.delete('/submissions/:id', 'plugins.configure', async (ctx) => {
      const url = new URL(ctx.req.url)
      const id = url.pathname.split('/').at(-1) ?? ''
      if (!id) return { error: 'Missing id' }
      await submissions.delete(id)
      return { ok: true }
    })
  },

  deactivate(api: ServerPluginApi) {
    api.plugin.log('Forms Builder deactivated')
  },

  async uninstall(api: ServerPluginApi) {
    const submissions = api.cms.storage.collection('submissions')
    const { records: all } = await submissions.list({ limit: 1000 })
    await Promise.all(all.map((r) => submissions.delete(r.id)))
    api.plugin.log(`Forms Builder removed ${all.length} submissions`)
  },
}

export default mod
