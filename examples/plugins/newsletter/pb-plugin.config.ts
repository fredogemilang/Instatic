/**
 * Newsletter plugin — Page Builder plugin configuration.
 *
 * Sends newsletters via Resend: double opt-in, list management, broadcast
 * composer, scheduled sends, delivery tracking, and webhook-driven analytics.
 *
 * Build:   bun run pb-plugin build examples/plugins/newsletter
 * Install: upload examples/plugins/newsletter.plugin.zip from /admin/plugins
 */
import { definePlugin, permissions } from '@core/plugin-sdk'
import subscribeForm from './modules/subscribeForm'
import preferencesLink from './modules/preferencesLink'

export default definePlugin({
  id: 'pagebuilder.newsletter',
  name: 'Newsletter',
  version: '0.1.0',
  description:
    'Email newsletter plugin powered by Resend. Subscriber management, double opt-in, list segmentation, broadcast composer, scheduled sends, and webhook-driven open/click tracking.',
  author: { name: 'Page Builder', email: 'plugins@pagebuilder.dev' },
  license: 'MIT',
  keywords: ['newsletter', 'email', 'resend', 'subscribers', 'broadcasts'],
  icon: 'icon.svg',

  permissions: [
    permissions.modulesRegister,
    permissions.adminNavigation,
    permissions.cmsStorage,
    permissions.cmsRoutes,
    // Public /subscribe + /confirm + /unsubscribe + /preferences/:token
    // + /webhooks/resend endpoints — all anonymous-callable.
    permissions.cmsRoutesPublic,
    permissions.cmsHooks,
    permissions.cmsSchedule,
    permissions.networkOutbound,
  ],

  networkAllowedHosts: ['api.resend.com'],

  // ── Storage resources ────────────────────────────────────────────────────
  // Each resource declares the collection name used in
  // `api.cms.storage.collection(id)` and the fields displayed in the
  // auto-generated resource admin page.

  resources: [
    {
      id: 'subscribers',
      title: 'Subscribers',
      singularLabel: 'Subscriber',
      pluralLabel: 'Subscribers',
      fields: [
        { id: 'email', label: 'Email', type: 'text', required: true },
        { id: 'name', label: 'Name', type: 'text' },
        { id: 'status', label: 'Status', type: 'text' },
        { id: 'source', label: 'Source', type: 'text' },
        { id: 'subscribed-at', label: 'Subscribed', type: 'date' },
        { id: 'confirmed-at', label: 'Confirmed', type: 'date' },
      ],
    },
    {
      id: 'lists',
      title: 'Lists',
      singularLabel: 'List',
      pluralLabel: 'Lists',
      fields: [
        { id: 'name', label: 'Name', type: 'text', required: true },
        { id: 'description', label: 'Description', type: 'text' },
        { id: 'is-default', label: 'Default?', type: 'boolean' },
      ],
    },
    {
      id: 'broadcasts',
      title: 'Broadcasts',
      singularLabel: 'Broadcast',
      pluralLabel: 'Broadcasts',
      fields: [
        { id: 'subject', label: 'Subject', type: 'text', required: true },
        { id: 'status', label: 'Status', type: 'text' },
        { id: 'scheduled-at', label: 'Scheduled At', type: 'date' },
        { id: 'sent-at', label: 'Sent At', type: 'date' },
        { id: 'recipient-count', label: 'Recipients', type: 'number' },
        { id: 'open-count', label: 'Opens', type: 'number' },
        { id: 'click-count', label: 'Clicks', type: 'number' },
      ],
    },
    {
      id: 'deliveries',
      title: 'Deliveries',
      singularLabel: 'Delivery',
      pluralLabel: 'Deliveries',
      fields: [
        { id: 'broadcast-id', label: 'Broadcast', type: 'text' },
        { id: 'subscriber-id', label: 'Subscriber', type: 'text' },
        { id: 'sent-at', label: 'Sent At', type: 'date' },
        { id: 'opened-at', label: 'Opened At', type: 'date' },
        { id: 'clicked-at', label: 'Clicked At', type: 'date' },
        { id: 'bounced', label: 'Bounced?', type: 'boolean' },
      ],
    },
  ],

  // ── Admin pages ───────────────────────────────────────────────────────────
  adminPages: [
    {
      id: 'dashboard',
      title: 'Newsletter',
      navLabel: 'Newsletter',
      icon: 'box-stack',
      content: {
        kind: 'app',
        heading: 'Newsletter',
        entry: 'admin/dashboard.js',
      },
    },
  ],

  // ── Canvas modules ────────────────────────────────────────────────────────
  modules: [subscribeForm, preferencesLink],

  // ── Settings ──────────────────────────────────────────────────────────────
  settings: [
    {
      id: 'resendApiKey',
      label: 'Resend API Key',
      type: 'password',
      secret: true,
      required: true,
      description: 'Your Resend API key (re_...). Found at resend.com/api-keys.',
      placeholder: 're_...',
    },
    {
      id: 'resendWebhookSecret',
      label: 'Resend Webhook Secret',
      type: 'password',
      secret: true,
      description:
        'The Svix signing secret for your Resend webhook endpoint (whsec_...). Register the webhook URL in the Resend dashboard under Webhooks.',
      placeholder: 'whsec_...',
    },
    {
      id: 'fromAddress',
      label: 'From address',
      type: 'text',
      required: true,
      placeholder: 'newsletter@example.com',
      description: 'Email address used as the sender. Must be verified in Resend.',
    },
    {
      id: 'fromName',
      label: 'From name',
      type: 'text',
      required: true,
      placeholder: 'My Newsletter',
      description: 'Display name shown in recipients\' email clients.',
    },
    {
      id: 'siteUrl',
      label: 'Site URL',
      type: 'url',
      required: true,
      placeholder: 'https://example.com',
      description:
        'Public base URL of your site (no trailing slash). Used to build confirmation, unsubscribe, and preferences links embedded in emails.',
    },
    {
      id: 'doubleOptIn',
      label: 'Double opt-in',
      type: 'toggle',
      default: true,
      description: 'Send a confirmation email and require a click before activating new subscribers.',
    },
    {
      id: 'optInEmailSubject',
      label: 'Opt-in email subject',
      type: 'text',
      default: 'Please confirm your subscription',
      description: 'Subject line for the confirmation email sent to new subscribers.',
    },
    {
      id: 'optInEmailBody',
      label: 'Opt-in email body',
      type: 'textarea',
      rows: 4,
      default:
        'Thank you for subscribing! Please click the link below to confirm your email address:\n\n{{confirm_url}}\n\nIf you did not request this, you can safely ignore this email.',
      description: 'Body text for the opt-in confirmation email. Use {{confirm_url}} to insert the confirmation link.',
    },
  ],
})
