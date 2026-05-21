/**
 * SEO Suite — single source of truth for the plugin manifest.
 *
 * Build:   bun run pb-plugin build examples/plugins/seo-suite
 * Install: upload examples/plugins/seo-suite.plugin.zip from /admin/plugins
 *
 * IMPORTANT: this file is evaluated by the build CLI in the host's Bun
 * process, so it imports from `@core/plugin-sdk` (resolved via the host's
 * tsconfig paths). Plugin SOURCE files (admin/, server/) instead use
 * `@pagebuilder/plugin-sdk` so they're externalized at build time and
 * resolved at runtime via the host's import map.
 */
import { definePlugin, permissions } from '@core/plugin-sdk'

export default definePlugin({
  id: 'pagebuilder.seo-suite',
  name: 'SEO Suite',
  version: '1.0.0',
  description:
    'Production-grade SEO tooling: sitemap, robots, per-page meta, JSON-LD, OG image generation.',
  author: { name: 'Page Builder', email: 'plugins@pagebuilder.dev' },
  license: 'MIT',
  icon: 'icon.svg',

  permissions: [
    permissions.adminNavigation,
    permissions.cmsStorage,
    permissions.cmsRoutes,
    permissions.cmsHooks,
    permissions.cmsSchedule,
    permissions.networkOutbound,
    permissions.cmsPagesRead,
  ],

  // Seeded with a placeholder that documents the pattern. Replace `og.example.com`
  // with your actual OG image provider host (e.g. `og.mysite.com`), rebuild,
  // and re-upload. The sandbox rejects calls to any host NOT in this list even
  // when `network.outbound` is granted — fail-closed design. See README.md.
  networkAllowedHosts: ['og.example.com'],

  resources: [
    {
      id: 'seo-entries',
      title: 'SEO Entries',
      singularLabel: 'SEO Entry',
      pluralLabel: 'SEO Entries',
      fields: [
        { id: 'page-id', label: 'Page ID', type: 'text', required: true },
        { id: 'title-override', label: 'Title Override', type: 'text' },
        { id: 'meta-description', label: 'Meta Description', type: 'text' },
        { id: 'og-title', label: 'OG Title', type: 'text' },
        { id: 'og-description', label: 'OG Description', type: 'text' },
        { id: 'og-image-url', label: 'OG Image URL', type: 'text' },
        { id: 'twitter-card', label: 'Twitter Card', type: 'text' },
        { id: 'canonical-url', label: 'Canonical URL', type: 'text' },
        { id: 'no-index', label: 'No Index', type: 'boolean' },
        { id: 'no-follow', label: 'No Follow', type: 'boolean' },
        { id: 'json-ld', label: 'JSON-LD', type: 'longtext' },
        { id: 'last-rendered-url', label: 'Last Rendered URL', type: 'text' },
        { id: 'last-rendered-title', label: 'Last Rendered Title', type: 'text' },
        { id: 'last-rendered-at', label: 'Last Rendered At', type: 'date' },
      ],
    },
    {
      id: 'page-index',
      title: 'Page Index',
      singularLabel: 'Page Index Entry',
      pluralLabel: 'Page Index Entries',
      fields: [
        { id: 'page-id', label: 'Page ID', type: 'text', required: true },
        { id: 'slug', label: 'Slug', type: 'text' },
        { id: 'url', label: 'URL', type: 'text' },
        { id: 'title', label: 'Title', type: 'text' },
        { id: 'last-seen-at', label: 'Last Seen At', type: 'date' },
      ],
    },
  ],

  adminPages: [
    {
      id: 'dashboard',
      title: 'SEO Suite',
      navLabel: 'SEO',
      icon: 'ruler-dimension',
      content: {
        kind: 'app',
        heading: 'SEO Suite',
        entry: 'admin/dashboard.js',
      },
    },
    {
      id: 'seo-entries',
      title: 'SEO Entries',
      navLabel: 'SEO Entries',
      content: {
        kind: 'resource',
        heading: 'SEO Entries',
        resource: 'seo-entries',
      },
    },
  ],

  settings: [
    {
      id: 'siteName',
      label: 'Site Name',
      type: 'text',
      description: 'Used in JSON-LD WebSite schema and as a fallback OG site name.',
      placeholder: 'My Website',
    },
    {
      id: 'siteUrl',
      label: 'Site URL',
      type: 'url',
      required: true,
      description:
        'Canonical root URL of the site (no trailing slash). Required. Used to build absolute URLs in the sitemap and OG tags. Example: https://example.com',
      placeholder: 'https://example.com',
    },
    {
      id: 'defaultOgImage',
      label: 'Default OG Image URL',
      type: 'url',
      description: 'Fallback OG image when a page has no specific OG image set.',
      placeholder: 'https://example.com/og-default.png',
    },
    {
      id: 'twitterHandle',
      label: 'Twitter / X Handle',
      type: 'text',
      description: 'Site-level @handle used in twitter:site tags. Include the @.',
      placeholder: '@yoursite',
    },
    {
      id: 'robotsTxt',
      label: 'robots.txt Content',
      type: 'textarea',
      description:
        'Full text of robots.txt (excluding the Sitemap: line — that is appended automatically).',
      default: 'User-agent: *\nAllow: /',
      rows: 6,
    },
    {
      id: 'ogImageProviderUrl',
      label: 'OG Image Provider URL',
      type: 'url',
      description:
        'POST endpoint that accepts { title, description, siteName, url } and returns { url: string }. Required for automatic OG image generation. The provider host must also be added to networkAllowedHosts in pb-plugin.config.ts.',
      placeholder: 'https://og.example.com/generate',
    },
    {
      id: 'enableJsonLd',
      label: 'Enable JSON-LD',
      type: 'toggle',
      description: 'Inject WebPage + WebSite JSON-LD schemas on every published page.',
      default: true,
    },
    {
      id: 'defaultNoIndex',
      label: 'Default No-Index',
      type: 'toggle',
      description: 'When on, pages are no-indexed by default unless explicitly set to indexable.',
      default: false,
    },
  ],
})
