/**
 * Analytics plugin — manifest and configuration.
 *
 * Self-hosted, privacy-first analytics. A Plausible/Fathom alternative built
 * entirely inside the plugin: this plugin ships its own page-runtime IIFE
 * (declared under `frontend.assets[]`) and its own public ingest route. The
 * host provides only the substrate — declarative asset injection + public
 * route registration — and contributes zero tracker code.
 *
 * NOTE: this file runs in the host's Bun process (not bundled), so it imports
 * from `@core/plugin-sdk` via the host's tsconfig paths. Plugin source files
 * (admin/, server/, frontend/) import from `@pagebuilder/plugin-sdk` so they
 * are externalized at build time and resolved by the host's import map at
 * runtime.
 */
import { definePlugin, permissions } from '@core/plugin-sdk'

export default definePlugin({
  id: 'pagebuilder.analytics',
  name: 'Analytics',
  version: '1.0.0',
  apiVersion: 1,
  description: 'Self-hosted, privacy-preserving page-view and event analytics.',
  author: { name: 'Page Builder' },
  license: 'MIT',
  icon: 'icon.svg',

  permissions: [
    permissions.frontendAssets,
    permissions.adminNavigation,
    permissions.cmsStorage,
    permissions.cmsRoutes,
    permissions.cmsHooks,
    permissions.cmsSchedule,
    // Registers the Visitors dashboard widget on /admin via the editor
    // entrypoint. The widget body uses the host `Widget` + `RangeTabs` +
    // `Sparkline` + `StatValue` primitives — same visuals as every other
    // dashboard tile.
    permissions.dashboardWidgetsRegister,
  ],

  // Every tag the host injects on behalf of this plugin. Order here is
  // preserved: the deferred external tracker bundle lands at the end of
  // `<body>` so it doesn't block page rendering. The plugin owns the IIFE
  // entirely — the host ships no shared runtime; analytics uses its own
  // `window.__pb_analytics` namespace.
  frontend: {
    assets: [
      {
        kind: 'script',
        src: 'frontend/tracker.js',
        placement: 'body-end',
        strategy: 'defer',
      },
    ],
  },

  resources: [
    {
      id: 'events',
      title: 'Raw Events',
      singularLabel: 'Event',
      pluralLabel: 'Events',
      fields: [
        { id: 'name',          label: 'Event',           type: 'text',     required: true },
        { id: 'path',          label: 'Page Path',       type: 'text' },
        { id: 'visitorHash',   label: 'Visitor Hash',    type: 'text' },
        { id: 'session',       label: 'Session ID',      type: 'text' },
        { id: 'referrer',      label: 'Referrer',        type: 'text' },
        { id: 'device',        label: 'Device',          type: 'text' },
        { id: 'country',       label: 'Country',         type: 'text' },
        { id: 'payload',       label: 'Payload JSON',    type: 'longtext' },
        { id: 'receivedAt',    label: 'Received At',      type: 'date' },
      ],
    },
    {
      id: 'daily-stats',
      title: 'Daily Stats',
      singularLabel: 'Day',
      pluralLabel: 'Days',
      fields: [
        { id: 'date',                label: 'Date (YYYY-MM-DD)',     type: 'text',     required: true },
        { id: 'pageviews',           label: 'Page Views',            type: 'number' },
        { id: 'visitors',            label: 'Unique Visitors',       type: 'number' },
        { id: 'sessions',            label: 'Sessions',              type: 'number' },
        { id: 'bounce-rate',         label: 'Bounce Rate (%)',       type: 'number' },
        { id: 'avg-session-seconds', label: 'Avg Session (s)',       type: 'number' },
        { id: 'top-pages',           label: 'Top Pages JSON',        type: 'longtext' },
        { id: 'top-referrers',       label: 'Top Referrers JSON',    type: 'longtext' },
        { id: 'top-countries',       label: 'Top Countries JSON',    type: 'longtext' },
        { id: 'top-devices',         label: 'Top Devices JSON',      type: 'longtext' },
      ],
    },
  ],

  adminPages: [
    {
      id: 'dashboard',
      title: 'Analytics',
      navLabel: 'Analytics',
      icon: 'box-stack',
      content: {
        kind: 'app',
        heading: 'Analytics',
        entry: 'admin/dashboard.js',
      },
    },
  ],

  settings: [
    {
      id: 'salt',
      label: 'Visitor hash salt',
      type: 'password',
      secret: true,
      description: 'Random secret used to hash visitor IDs daily. Auto-seeded on install. Changing this resets all visitor identity.',
    },
    {
      id: 'retentionDays',
      label: 'Event retention (days)',
      type: 'number',
      default: 90,
      min: 1,
      max: 365,
      description: 'Raw events older than this are pruned by the nightly job.',
    },
    {
      id: 'respectDnt',
      label: 'Honour Do-Not-Track header',
      type: 'toggle',
      default: true,
      description: 'When enabled, visitors with DNT=1 set in their browser are not tracked.',
    },
    {
      id: 'excludeAdmins',
      label: 'Exclude admin users',
      type: 'toggle',
      default: true,
      description: 'Do not record events fired while an admin session cookie is present.',
    },
    {
      id: 'excludePaths',
      label: 'Exclude paths',
      type: 'textarea',
      rows: 4,
      placeholder: '/admin/*\n/api/*',
      description: 'Newline-separated glob patterns. Events whose page path matches any pattern are discarded.',
    },
    {
      id: 'excludeIps',
      label: 'Exclude IPs',
      type: 'textarea',
      rows: 3,
      placeholder: '192.168.1.1\n10.0.0.0',
      description: 'Newline-separated IP addresses. Events from these IPs are discarded (matched against X-Forwarded-For).',
    },
    {
      id: 'publicStatsToken',
      label: 'Public stats token',
      type: 'password',
      secret: true,
      description: 'When non-empty, the /public-stats.json endpoint is accessible with ?token=<value>. Leave empty to disable.',
    },
  ],
})
