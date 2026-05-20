/**
 * Google Cloud Storage adapter — official Page Builder plugin.
 *
 * Uses GCS's S3-compatible XML API: SigV4 with `AWS4-HMAC-SHA256`,
 * service `s3` in the credential scope, region `auto`, addressing
 * via path-style URLs (`storage.googleapis.com/<bucket>/<key>`).
 * Authentication uses an HMAC key (Access ID `GOOG…` + secret),
 * created in Cloud Console → Cloud Storage → Settings →
 * Interoperability → "Create access key".
 *
 * The signer is the same module the AWS S3 and Cloudflare R2 plugins
 * use — GCS's S3-compat surface intentionally accepts AWS4-HMAC-SHA256
 * signatures verbatim, so there's no per-provider crypto fork.
 *
 * Build:   bun pb-plugin build examples/plugins/gcs-storage
 * Install: upload `examples/plugins/gcs-storage.plugin.zip` from /admin/plugins
 */
import { definePlugin, permissions } from '@pagebuilder/plugin-sdk'

export default definePlugin({
  id: 'pagebuilder.gcs-storage',
  name: 'Google Cloud Storage',
  version: '1.0.0',
  description:
    'Stores uploaded media on Google Cloud Storage via the S3-compatible XML API. Pre-signed PUTs upload directly from the host; pre-signed GETs serve private buckets via a host redirect.',
  author: { name: 'Page Builder', email: 'plugins@pagebuilder.dev' },
  license: 'MIT',
  keywords: ['storage', 'gcs', 'google-cloud', 'media', 'adapter'],
  icon: 'icon.svg',

  permissions: [
    permissions.mediaStorageAdapter,
    permissions.networkOutbound,
  ],

  // GCS XML API is single-host (no per-project subdomain). The public
  // download host `<bucket>.storage.googleapis.com` is the same wildcard.
  networkAllowedHosts: [
    'storage.googleapis.com',
    '*.storage.googleapis.com',
  ],

  settings: [
    {
      id: 'accessKeyId',
      label: 'HMAC Access ID',
      description:
        'GCS interoperability access key — starts with `GOOG`. Create at Cloud Console → Cloud Storage → Settings → Interoperability → "Create access key for a service account".',
      type: 'text',
      required: true,
      secret: true,
      placeholder: 'GOOG1ABCDEFGHIJKLMNOPQRSTUVWXYZ…',
    },
    {
      id: 'secretAccessKey',
      label: 'HMAC Secret',
      description: 'Paired with the access ID. Shown once in the Cloud Console — copy immediately.',
      type: 'password',
      required: true,
      secret: true,
    },
    {
      id: 'bucket',
      label: 'Bucket name',
      description: 'The GCS bucket that will receive uploads. Must already exist.',
      type: 'text',
      required: true,
      placeholder: 'my-media-bucket',
    },
    {
      id: 'servingMode',
      label: 'Read serving mode',
      description:
        '`public-url` emits absolute GCS URLs — works when the bucket is public OR you have a CDN in front. `signed-redirect` keeps the bucket private and serves via host-signed redirects.',
      type: 'select',
      required: true,
      default: 'signed-redirect',
      options: [
        { value: 'signed-redirect', label: 'Signed redirect (recommended; works for any bucket)' },
        { value: 'public-url', label: 'Public URL (bucket must be public or behind a CDN)' },
      ],
    },
    {
      id: 'publicUrlBase',
      label: 'Public URL base (optional)',
      description:
        "When 'Read serving mode' is 'public-url', overrides the default `https://storage.googleapis.com/<bucket>/` prefix. Useful for a Cloud CDN behind a custom domain. Include the trailing slash.",
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
