/**
 * Forms Builder — plugin configuration (single source of truth).
 *
 * Run `bun run pb-plugin build examples/plugins/forms-builder` to produce
 * the installable zip at `examples/plugins/forms-builder.plugin.zip`.
 */
// `pb-plugin.config.ts` is evaluated by the build CLI in the host Bun process
// → import from `@core/plugin-sdk` (resolved via host tsconfig paths).
// Plugin source files (admin/, modules/, server/) use `@pagebuilder/plugin-sdk`
// so they are externalized at bundle time and resolved at runtime via import map.
import { definePlugin, permissions } from '@core/plugin-sdk'
import modules from './modules/index'

export default definePlugin({
  id: 'pagebuilder.forms',
  name: 'Forms Builder',
  version: '1.0.0',
  description:
    'Drag-and-drop form builder with email delivery, spam protection, and a submission dashboard.',
  author: { name: 'Page Builder' },
  license: 'MIT',
  icon: 'icon.svg',
  keywords: ['forms', 'contact', 'submissions', 'email'],

  permissions: [
    permissions.adminNavigation,
    permissions.cmsStorage,
    permissions.cmsRoutes,
    permissions.modulesRegister,
    permissions.networkOutbound,
  ],

  networkAllowedHosts: [
    'api.resend.com',
    'api.postmarkapp.com',
    'api.mailgun.net',
    'challenges.cloudflare.com',
  ],

  resources: [
    {
      id: 'submissions',
      title: 'Submissions',
      singularLabel: 'Submission',
      pluralLabel: 'Submissions',
      fields: [
        { id: 'formId',       label: 'Form',         type: 'text',     required: true },
        { id: 'pagePath',     label: 'Page Path',    type: 'text' },
        { id: 'submittedAt',  label: 'Submitted At', type: 'date' },
        { id: 'payload',      label: 'Payload',      type: 'longtext' },
        { id: 'ipHash',       label: 'IP Hash',      type: 'text' },
        { id: 'userAgent',    label: 'User Agent',   type: 'text' },
        { id: 'status',       label: 'Status',       type: 'text' },
        { id: 'errorMessage', label: 'Error',        type: 'text' },
      ],
    },
  ],

  adminPages: [
    {
      id: 'dashboard',
      title: 'Forms Builder',
      navLabel: 'Forms',
      icon: 'columns',
      content: {
        kind: 'app',
        heading: 'Forms Builder',
        entry: 'admin/dashboard.js',
      },
    },
  ],

  modules,

  settings: [
    {
      id: 'provider',
      label: 'Email provider',
      type: 'select',
      options: [
        { label: 'Resend',   value: 'resend'    },
        { label: 'Postmark', value: 'postmark'  },
        { label: 'Mailgun',  value: 'mailgun'   },
      ],
      default: 'resend',
    },
    {
      id: 'apiKey',
      label: 'API Key',
      type: 'password',
      secret: true,
      description: 'The API key for your selected email provider.',
    },
    {
      id: 'mailgunDomain',
      label: 'Mailgun Domain',
      type: 'text',
      placeholder: 'mg.example.com',
      description: 'Required when using Mailgun. Your sending domain.',
    },
    {
      id: 'fromAddress',
      label: 'From Address',
      type: 'text',
      placeholder: 'forms@example.com',
      description: 'The email address notifications are sent from.',
    },
    {
      id: 'defaultToAddress',
      label: 'Notify Email',
      type: 'text',
      placeholder: 'owner@example.com',
      description: 'Default recipient for submission notification emails.',
    },
    {
      id: 'subjectTemplate',
      label: 'Subject Template',
      type: 'text',
      placeholder: '{{form_name}} — new submission',
      default: '{{form_name}} — new submission',
      description: 'Use {{form_name}} to include the form ID in the subject.',
    },
    {
      id: 'rateLimit',
      label: 'Rate Limit (per minute per IP)',
      type: 'number',
      default: 5,
      description: 'Maximum form submissions per minute per unique IP. Range: 1–60.',
    },
    {
      id: 'enableTurnstile',
      label: 'Enable Cloudflare Turnstile',
      type: 'toggle',
      default: false,
      description: 'Verify submissions with a Cloudflare Turnstile challenge.',
    },
    {
      id: 'turnstileSiteKey',
      label: 'Turnstile Site Key',
      type: 'text',
      description: 'Public site key from your Cloudflare Turnstile widget.',
    },
    {
      id: 'turnstileSecretKey',
      label: 'Turnstile Secret Key',
      type: 'password',
      secret: true,
      description: 'Server-side secret key from your Cloudflare Turnstile widget.',
    },
  ],
})
