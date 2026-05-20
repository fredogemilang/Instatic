/**
 * Amazon S3 storage adapter — official Page Builder plugin.
 *
 * Routes every media write through Amazon S3 (or any S3-compatible
 * backend — Cloudflare R2 with `https://*.r2.cloudflarestorage.com`,
 * DigitalOcean Spaces with `*.digitaloceanspaces.com`, Backblaze B2
 * `*.backblazeb2.com`, MinIO on-prem, …). The plugin signs PUT / GET /
 * DELETE / HEAD requests using AWS Signature V4 inside the sandbox via
 * `crypto.subtle.digest` + `crypto.subtle.sign`; the host streams the
 * actual byte payload to the signed URLs directly — bytes NEVER cross
 * the QuickJS boundary.
 *
 * Build:   bun pb-plugin build examples/plugins/s3-storage
 * Install: upload `examples/plugins/s3-storage.plugin.zip` from /admin/plugins
 *
 * After install + permission grants + filling in Settings, open the
 * Media workspace → Storage panel and elect "Amazon S3" for the
 * `Originals` role (and `Variants` if you want the responsive ladder
 * on S3 too). Hit "Test connection" to verify your credentials before
 * uploading.
 */
import { definePlugin, permissions } from '@pagebuilder/plugin-sdk'

export default definePlugin({
  id: 'pagebuilder.s3-storage',
  name: 'Amazon S3 Storage',
  version: '1.0.0',
  description:
    'Stores uploaded media on Amazon S3 (or any S3-compatible backend: R2, B2, DO Spaces, MinIO). Pre-signed PUTs upload directly from the host; pre-signed GETs serve private buckets via a host redirect.',
  author: { name: 'Page Builder', email: 'plugins@pagebuilder.dev' },
  license: 'MIT',
  keywords: ['storage', 's3', 'media', 'adapter'],
  icon: 'icon.svg',

  // Adapter registration + outbound HTTP are the only privileges this
  // plugin uses. No editor / admin / content / sandbox-storage surface.
  permissions: [
    permissions.mediaStorageAdapter,
    permissions.networkOutbound,
  ],

  // The set of hosts the plugin is allowed to call. We list every AWS
  // S3 endpoint shape (path-style, virtual-hosted-style, dualstack,
  // FIPS) PLUS the most common S3-compatible providers.
  //
  // For a custom S3-compatible endpoint not listed here (e.g. self-hosted
  // MinIO at `s3.internal.example.com`), publish a new plugin version
  // with the extra host added. The manifest IS the audit boundary —
  // the operator approves it at install time.
  networkAllowedHosts: [
    // Amazon S3 — virtual-hosted-style includes the bucket name as a
    // subdomain, so `*.s3.*.amazonaws.com` covers every region. The
    // bare `s3.amazonaws.com` is path-style and the dual-stack /
    // accelerate endpoints follow the same hostname pattern.
    's3.amazonaws.com',
    '*.s3.amazonaws.com',
    '*.s3.dualstack.us-east-1.amazonaws.com',
    // Region-specific virtual-hosted-style. The plugin always signs for
    // a specific region, so this wildcard suffices.
    '*.amazonaws.com',
    // Cloudflare R2 — S3-compatible, signature shape identical to S3
    // except the endpoint is `<account>.r2.cloudflarestorage.com`.
    '*.r2.cloudflarestorage.com',
    // Backblaze B2 — S3-compatible, region in the hostname.
    '*.backblazeb2.com',
    // DigitalOcean Spaces — S3-compatible.
    '*.digitaloceanspaces.com',
  ],

  settings: [
    {
      id: 'awsAccessKeyId',
      label: 'AWS Access Key ID',
      description:
        'IAM access key with s3:ListBucket on the bucket ARN plus s3:PutObject / s3:GetObject / s3:DeleteObject on the bucket\'s object ARN. Use a dedicated IAM user — do NOT use the root account key.',
      type: 'text',
      required: true,
      secret: true,
      placeholder: 'AKIA…',
    },
    {
      id: 'awsSecretAccessKey',
      label: 'AWS Secret Access Key',
      description: 'Paired with the access key. Never echoed back after save.',
      type: 'password',
      required: true,
      secret: true,
    },
    {
      id: 'region',
      label: 'AWS Region',
      description: 'The AWS region (or compatible-provider region) hosting the bucket. e.g. `us-east-1`, `eu-west-1`, `auto` for R2.',
      type: 'text',
      required: true,
      default: 'us-east-1',
      placeholder: 'us-east-1',
    },
    {
      id: 'bucket',
      label: 'Bucket name',
      description: 'The bucket that will receive uploads. Must already exist; the plugin does not create buckets.',
      type: 'text',
      required: true,
      placeholder: 'my-media-bucket',
    },
    {
      id: 'endpoint',
      label: 'Endpoint override',
      description:
        "Leave blank for Amazon S3. Set for an S3-compatible backend, e.g. `https://<account>.r2.cloudflarestorage.com` for Cloudflare R2.",
      type: 'url',
      placeholder: 'https://<account>.r2.cloudflarestorage.com',
    },
    {
      id: 'servingMode',
      label: 'Read serving mode',
      description:
        '`public-url` emits absolute S3 URLs for renderers (your bucket / CDN must be public-read). `signed-redirect` keeps the bucket private and serves via host-signed redirects — slower but works for private buckets.',
      type: 'select',
      required: true,
      default: 'public-url',
      options: [
        { value: 'public-url', label: 'Public URL (recommended for public buckets / CDN)' },
        { value: 'signed-redirect', label: 'Signed redirect (private buckets)' },
      ],
    },
    {
      id: 'publicUrlBase',
      label: 'Public URL base (optional)',
      description:
        "When 'Read serving mode' is 'public-url', override the URL prefix the renderer emits. Useful for CloudFront / a custom CDN domain. Defaults to `https://<bucket>.s3.<region>.amazonaws.com/`. Include the trailing slash.",
      type: 'url',
      placeholder: 'https://cdn.example.com/',
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
