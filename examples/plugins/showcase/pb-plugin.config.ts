/**
 * Showcase plugin — single source of truth.
 *
 * Run `bun run plugin:build examples/plugins/showcase` to produce the
 * runtime zip at `examples/plugins/showcase.plugin.zip`.
 */
// Note: `pb-plugin.config.ts` is evaluated by the build CLI in the host's
// Bun process — it doesn't go through Bun.build, so it imports from
// `@core/plugin-sdk` (resolved via the host's tsconfig paths) directly.
// Plugin SOURCE files (admin/, editor/, modules/, frontend/) instead use
// `@pagebuilder/plugin-sdk` so they're externalized at build time and
// resolved at runtime via the host's import map.
import { definePlugin, permissions } from '@core/plugin-sdk'
import callout from './modules/callout'
import eventCounter from './modules/eventCounter'
import pack from './pack'

export default definePlugin({
  id: 'acme.showcase',
  name: 'Showcase',
  version: '1.0.0',
  description:
    'End-to-end demo plugin — exercises every plugin SDK surface: admin app, server routes, hooks, canvas modules, frontend tracker, and a Visual Component pack.',
  author: { name: 'Acme Engineering', email: 'plugins@acme.dev', url: 'https://acme.dev' },
  license: 'MIT',
  homepage: 'https://acme.dev/page-builder/showcase',
  repository: 'https://github.com/acme/page-builder-showcase',
  keywords: ['demo', 'showcase', 'analytics', 'modules', 'pack'],
  icon: 'icon.svg',
  permissions: [
    permissions.adminNavigation,
    permissions.cmsStorage,
    permissions.cmsRoutes,
    permissions.cmsHooks,
    permissions.editorToolbar,
    permissions.editorCommands,
    permissions.editorPanels,
    permissions.editorCanvas,
    permissions.modulesRegister,
    permissions.visualComponentsRegister,
    permissions.frontendAssets,
  ],
  // Every frontend tag the host injects on behalf of this plugin. The
  // showcase ships its own self-contained IIFE — there's no host runtime
  // and no shared `window.__pb`. Other plugins that want to coordinate
  // with this one can listen on a regular DOM event bus the plugin owns.
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
      title: 'Tracker Events',
      singularLabel: 'Event',
      pluralLabel: 'Events',
      fields: [
        { id: 'name', label: 'Event', type: 'text', required: true },
        { id: 'page', label: 'Page', type: 'text' },
        { id: 'visitor', label: 'Visitor', type: 'text' },
        { id: 'session', label: 'Session', type: 'text' },
        { id: 'payload', label: 'Payload', type: 'longtext' },
        { id: 'received-at', label: 'Received At', type: 'date' },
      ],
    },
  ],
  adminPages: [
    {
      id: 'dashboard',
      title: 'Showcase',
      navLabel: 'Showcase',
      icon: 'box-stack',
      content: {
        kind: 'app',
        heading: 'Showcase Plugin',
        entry: 'admin/dashboard.js',
      },
    },
    {
      id: 'events',
      title: 'Tracker Events',
      navLabel: 'Events',
      content: {
        kind: 'resource',
        heading: 'Tracker Events',
        resource: 'events',
      },
    },
  ],
  modules: [callout, eventCounter],
  pack,
  settings: [
    {
      id: 'eventLabelPrefix',
      label: 'Event label prefix',
      type: 'text',
      placeholder: 'showcase',
      description:
        'Prepended to every tracker event the plugin records. Useful for tagging events with a deployment id.',
      default: 'showcase',
    },
    {
      id: 'storeOutboundClicks',
      label: 'Store outbound clicks',
      type: 'toggle',
      description: 'When off, link-click events bypass storage but the front-end runtime still fires them.',
      default: true,
    },
    {
      id: 'apiKey',
      label: 'Upstream API key',
      type: 'password',
      description: 'Optional — forwarded to a downstream analytics service when set. Stored encrypted at rest.',
      secret: true,
    },
  ],
})
