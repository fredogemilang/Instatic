/**
 * Azure Blob Storage adapter — official Page Builder plugin.
 *
 * Unlike S3 / R2 / GCS, Azure Blob does NOT speak S3 SigV4 — it uses
 * its own Shared Access Signature (SAS) scheme. SAS signing is
 * HMAC-SHA256 over a different canonical string-to-sign, with a
 * Base64-encoded signature. The crypto primitive is the same one
 * the host's sandbox exposes (`crypto.subtle`), so we just write a
 * new signer module per the Azure docs.
 *
 * The plugin signs Service SAS tokens (blob-scoped for read/write/delete,
 * container-scoped for verify-via-list). API version 2024-11-04 is what
 * we sign with — stable, supports every field this plugin uses.
 *
 * Build:   bun pb-plugin build examples/plugins/azure-blob-storage
 * Install: upload `examples/plugins/azure-blob-storage.plugin.zip` from /admin/plugins
 */
import { definePlugin, permissions } from '@pagebuilder/plugin-sdk'

export default definePlugin({
  id: 'pagebuilder.azure-blob-storage',
  name: 'Azure Blob Storage',
  version: '1.0.0',
  description:
    'Stores uploaded media on Azure Blob Storage using Shared Access Signatures (SAS). Pre-signed PUTs upload directly from the host; pre-signed GETs serve private containers via a host redirect.',
  author: { name: 'Page Builder', email: 'plugins@pagebuilder.dev' },
  license: 'MIT',
  keywords: ['storage', 'azure', 'blob', 'media', 'adapter'],
  icon: 'icon.svg',

  permissions: [
    permissions.mediaStorageAdapter,
    permissions.networkOutbound,
  ],

  // Azure Storage hosts every storage account on a per-account subdomain:
  // `<account>.blob.core.windows.net`. The wildcard covers all accounts.
  // Other sovereign clouds (US Government / China / Germany legacy) use
  // different suffixes — listed individually so the SAS signer can route
  // to them via the endpointSuffix setting.
  networkAllowedHosts: [
    '*.blob.core.windows.net',
    '*.blob.core.usgovcloudapi.net',
    '*.blob.core.chinacloudapi.cn',
  ],

  settings: [
    {
      id: 'account',
      label: 'Storage Account Name',
      description:
        'Your Azure storage account — find it under Storage Accounts in the Azure portal. e.g. `mymediaaccount` (NOT the full URL).',
      type: 'text',
      required: true,
      placeholder: 'mymediaaccount',
    },
    {
      id: 'accountKey',
      label: 'Account Key (Base64)',
      description:
        'Copy from Azure portal → Storage account → Security + networking → Access keys → key1 or key2. This is a base64-encoded 64-byte key Azure shows on the Access Keys page.',
      type: 'password',
      required: true,
      secret: true,
    },
    {
      id: 'container',
      label: 'Container name',
      description: 'The blob container that will receive uploads. Must already exist.',
      type: 'text',
      required: true,
      placeholder: 'media',
    },
    {
      id: 'cloud',
      label: 'Cloud',
      description:
        'The Azure cloud your storage account lives in. Public is the default; the others are sovereign Azure clouds.',
      type: 'select',
      required: true,
      default: 'public',
      options: [
        { value: 'public', label: 'Public Azure (core.windows.net)' },
        { value: 'usgov', label: 'US Government (core.usgovcloudapi.net)' },
        { value: 'china', label: 'China (core.chinacloudapi.cn)' },
      ],
    },
    {
      id: 'servingMode',
      label: 'Read serving mode',
      description:
        '`public-url` emits absolute blob URLs (the container must be Public Read OR fronted by Azure Front Door / a custom domain). `signed-redirect` keeps the container private and serves via host-signed redirects.',
      type: 'select',
      required: true,
      default: 'signed-redirect',
      options: [
        { value: 'signed-redirect', label: 'Signed redirect (recommended; works for any container)' },
        { value: 'public-url', label: 'Public URL (container must be public or behind a custom domain)' },
      ],
    },
    {
      id: 'publicUrlBase',
      label: 'Public URL base (optional)',
      description:
        "When 'Read serving mode' is 'public-url', the URL prefix the renderer emits. Defaults to `https://<account>.<endpoint>/<container>/`. Override with a custom domain (Azure Front Door, etc.). Include the trailing slash.",
      type: 'url',
      placeholder: 'https://cdn.example.com/',
    },
    {
      id: 'pathPrefix',
      label: 'Blob path prefix',
      description: 'Optional prefix prepended to every uploaded blob name (e.g. `media/`).',
      type: 'text',
      placeholder: 'media/',
      default: '',
    },
  ],
})
