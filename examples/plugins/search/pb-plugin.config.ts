/**
 * Search plugin — single source of truth.
 *
 * Provides full-text search for published pages via MeiliSearch or Typesense.
 * Indexes are built on publish and can be rebuilt on demand from the admin.
 *
 * Run `bun run pb-plugin build examples/plugins/search` to produce the
 * runtime zip at `examples/plugins/search.plugin.zip`.
 */
import { definePlugin, permissions } from '@core/plugin-sdk'
import searchBox from './modules/searchBox'
import searchResults from './modules/searchResults'

export default definePlugin({
  id: 'pagebuilder.search',
  name: 'Search',
  version: '1.0.0',
  description:
    'Full-text search for published pages. Indexes page content via MeiliSearch or Typesense and exposes a fast public search API.',
  author: { name: 'Page Builder', email: 'hello@davidbabinec.com' },
  license: 'MIT',
  keywords: ['search', 'fulltext', 'meilisearch', 'typesense', 'index'],
  icon: 'icon.svg',

  permissions: [
    permissions.modulesRegister,
    permissions.adminNavigation,
    permissions.cmsStorage,
    permissions.cmsRoutes,
    permissions.cmsHooks,
    permissions.networkOutbound,
    permissions.cmsPagesPublish,
  ],

  networkAllowedHosts: [
    '*.meilisearch.io',
    'cloud.typesense.org',
    '*.typesense.net',
  ],

  resources: [
    {
      id: 'queries',
      title: 'Search Queries',
      singularLabel: 'Query',
      pluralLabel: 'Queries',
      fields: [
        { id: 'query', label: 'Query', type: 'text', required: true },
        { id: 'resultCount', label: 'Result Count', type: 'number' },
        { id: 'tookMs', label: 'Took (ms)', type: 'number' },
        { id: 'searchedAt', label: 'Searched At', type: 'date' },
      ],
    },
  ],

  adminPages: [
    {
      id: 'dashboard',
      title: 'Search',
      navLabel: 'Search',
      icon: 'magnifier',
      content: {
        kind: 'app',
        heading: 'Search Plugin',
        entry: 'admin/dashboard.js',
      },
    },
  ],

  modules: [searchBox, searchResults],

  settings: [
    {
      id: 'backend',
      label: 'Search backend',
      type: 'select',
      default: 'meilisearch',
      description: 'Which search engine to use for indexing and queries.',
      options: [
        { label: 'MeiliSearch', value: 'meilisearch' },
        { label: 'Typesense', value: 'typesense' },
      ],
    },
    {
      id: 'endpoint',
      label: 'Search engine endpoint',
      type: 'url',
      placeholder: 'https://your-instance.meilisearch.io',
      description: 'Base URL of the MeiliSearch or Typesense instance.',
    },
    {
      id: 'adminApiKey',
      label: 'Admin API key',
      type: 'password',
      secret: true,
      description: 'Used to write documents and manage the index. Never exposed to the browser.',
    },
    {
      id: 'searchApiKey',
      label: 'Search (public) API key',
      type: 'password',
      secret: true,
      description: 'Read-only key used by the public /search route to query the backend.',
    },
    {
      id: 'indexName',
      label: 'Index name',
      type: 'text',
      default: 'pagebuilder',
      placeholder: 'pagebuilder',
      description: 'Name of the index / collection in the search engine.',
    },
    {
      id: 'searchableFields',
      label: 'Searchable fields',
      type: 'textarea',
      default: 'title\nheadings\ncontent',
      rows: 3,
      description: 'One field name per line. Applied when creating / updating the index settings.',
    },
    {
      id: 'excerptLength',
      label: 'Excerpt length',
      type: 'number',
      default: 200,
      min: 50,
      max: 1000,
      description: 'Maximum character length of the content excerpt in search results.',
    },
    {
      id: 'excludePaths',
      label: 'Excluded paths',
      type: 'textarea',
      default: '',
      rows: 3,
      placeholder: '/private\n/drafts',
      description: 'One path prefix per line. Pages whose URL starts with any of these are skipped.',
    },
    {
      id: 'enableQueryLogging',
      label: 'Log search queries',
      type: 'toggle',
      default: true,
      description: 'Store anonymised query logs in plugin storage. Shown on the Analytics tab.',
    },
  ],
})
