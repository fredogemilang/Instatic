/**
 * Cloudflare R2 storage adapter — official Page Builder plugin.
 *
 * R2 is Cloudflare's S3-compatible object storage with FREE egress —
 * a strong default for self-hosted CMS deployments that serve a lot of
 * media. The S3 protocol is identical (SigV4, presigned URLs, same
 * canonical-request shape), so this plugin reuses the same signer the
 * AWS S3 plugin uses, just with R2-specific endpoint shape + simpler UX.
 *
 * Build:   bun pb-plugin build examples/plugins/r2-storage
 * Install: upload `examples/plugins/r2-storage.plugin.zip` from /admin/plugins
 *
 * After install + permission grants + filling in Settings, open the
 * Media workspace → Storage panel and elect "Cloudflare R2" for the
 * `Originals` role. Hit "Test connection" to verify credentials.
 */
import { definePlugin, permissions } from '@pagebuilder/plugin-sdk'

export default definePlugin({
  id: 'pagebuilder.r2-storage',
  name: 'Cloudflare R2 Storage',
  version: '1.0.0',
  description:
    'Stores uploaded media on Cloudflare R2 (S3-compatible object storage with zero egress fees). Pre-signed PUTs upload directly from the host; pre-signed GETs serve private buckets via a host redirect.',
  author: { name: 'Page Builder', email: 'plugins@pagebuilder.dev' },
  license: 'MIT',
  keywords: ['storage', 'r2', 'cloudflare', 'media', 'adapter'],
  icon: 'icon.svg',

  permissions: [
    permissions.mediaStorageAdapter,
    permissions.networkOutbound,
  ],

  // R2's S3 API endpoint shape is `<ACCOUNT_ID>.r2.cloudflarestorage.com`.
  // The `*.r2.cloudflarestorage.com` wildcard covers every account. EU /
  // FedRAMP jurisdictions add a region segment — `<account>.eu.r2.cloudflarestorage.com`,
  // `<account>.fedramp.r2.cloudflarestorage.com` — both covered by the same wildcard.
  //
  // The optional `<bucket>.r2.dev` host is R2's public-access domain (when
  // the user has enabled "Public Bucket"). We include it so a public-bucket
  // setup with `servingMode: 'public-url'` can fetch from the dev host.
  networkAllowedHosts: [
    '*.r2.cloudflarestorage.com',
    '*.r2.dev',
  ],

  settings: [
    {
      id: 'accountId',
      label: 'Account ID',
      description:
        'Your Cloudflare account ID — find it on the right rail of the Cloudflare dashboard, or under R2 → "Manage R2 API Tokens".',
      type: 'text',
      required: true,
      placeholder: 'a1b2c3d4e5f6…',
    },
    {
      id: 'accessKeyId',
      label: 'R2 Access Key ID',
      description:
        'Create at Cloudflare dashboard → R2 → "Manage R2 API Tokens" → "Create API Token" → permission "Object Read & Write", scoped to your bucket. The "Access Key ID" is the token id.',
      type: 'text',
      required: true,
      secret: true,
      placeholder: '0123456789abcdef…',
    },
    {
      id: 'secretAccessKey',
      label: 'R2 Secret Access Key',
      description: 'Shown ONCE on token creation. Copy it immediately — Cloudflare can\'t recover it afterwards.',
      type: 'password',
      required: true,
      secret: true,
    },
    {
      id: 'bucket',
      label: 'Bucket name',
      description: 'The R2 bucket that will receive uploads. Must already exist; the plugin does not create buckets.',
      type: 'text',
      required: true,
      placeholder: 'my-media-bucket',
    },
    {
      id: 'jurisdiction',
      label: 'Jurisdiction',
      description:
        'Standard (multi-region) is the default. EU keeps data in EU. FedRAMP is for US government compliance. Must match the bucket\'s jurisdiction setting.',
      type: 'select',
      required: true,
      default: 'standard',
      options: [
        { value: 'standard', label: 'Standard (global)' },
        { value: 'eu', label: 'EU (data localised in EU)' },
        { value: 'fedramp', label: 'FedRAMP (US government compliance)' },
      ],
    },
    {
      id: 'servingMode',
      label: 'Read serving mode',
      description:
        '`public-url` emits an absolute URL — works when the bucket is public OR you have a custom domain in front. `signed-redirect` keeps the bucket private and serves via host-signed redirects.',
      type: 'select',
      required: true,
      default: 'signed-redirect',
      options: [
        { value: 'signed-redirect', label: 'Signed redirect (recommended; works for any bucket)' },
        { value: 'public-url', label: 'Public URL (bucket must be public or behind a custom domain)' },
      ],
    },
    {
      id: 'publicUrlBase',
      label: 'Public URL base (optional)',
      description:
        "When 'Read serving mode' is 'public-url', the URL prefix the renderer emits. For R2 public buckets use `https://pub-<HASH>.r2.dev/` (find this on the bucket's Settings page). For a custom domain use `https://media.example.com/`. Include the trailing slash.",
      type: 'url',
      placeholder: 'https://pub-abc123.r2.dev/',
    },
    {
      id: 'pathPrefix',
      label: 'Object key prefix',
      description: 'Optional prefix prepended to every uploaded object key (e.g. `media/`). Useful when the bucket is shared between environments.',
      type: 'text',
      placeholder: 'media/',
      default: '',
    },
  ],
})
