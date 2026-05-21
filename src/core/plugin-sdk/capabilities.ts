import type { PluginPermission } from './types'

export type PluginCapabilitySurface = 'manifest' | 'admin' | 'editor' | 'server' | 'cms' | 'frontend'
export type PluginCapabilityRisk = 'low' | 'medium' | 'high' | 'dangerous'

export interface PluginCapability {
  permission: PluginPermission
  label: string
  description: string
  risk: PluginCapabilityRisk
  surfaces: PluginCapabilitySurface[]
}

export const PLUGIN_CAPABILITIES: PluginCapability[] = [
  {
    permission: 'admin.navigation',
    label: 'Add pages to the admin navigation',
    description: 'Allows the plugin to add pages to the CMS admin sidebar and plugin page router.',
    risk: 'low',
    surfaces: ['manifest', 'admin'],
  },
  {
    permission: 'cms.storage',
    label: 'Read and write plugin backend storage',
    description: 'Allows the plugin to read and write records in resources declared by its manifest.',
    risk: 'medium',
    surfaces: ['admin', 'editor', 'server', 'cms'],
  },
  {
    permission: 'cms.routes',
    label: 'Register backend CMS routes',
    description: 'Allows the plugin server entrypoint to register authenticated backend routes.',
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.hooks',
    label: 'Subscribe to CMS lifecycle events and filters',
    description: 'Allows the plugin server entrypoint to listen to CMS events (publish, content changes, page updates) and to register filters that transform values before they leave the CMS.',
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'editor.toolbar',
    label: 'Add controls to the editor toolbar',
    description: 'Allows the plugin editor entrypoint to add toolbar buttons.',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.commands',
    label: 'Register editor commands',
    description: 'Allows the plugin editor entrypoint to register commands that can be invoked by editor UI. Also grants registration of Command Spotlight palette commands (api.editor.palette.registerCommand) and live-search providers (api.editor.palette.registerProvider).',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.store.read',
    label: 'Read editor state',
    description: 'Allows the plugin to inspect the current editor store state.',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.store.write',
    label: 'Modify editor state',
    description: 'Allows the plugin to mutate editor store state through a host transaction.',
    risk: 'high',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.canvas',
    label: 'Add canvas overlays',
    description: 'Allows the plugin to register canvas overlay React components — annotation pins, custom selection adornments, measurement tools — that mount on top of the rendered canvas via `editor.canvas.registerOverlay`.',
    risk: 'high',
    surfaces: ['editor'],
  },
  {
    permission: 'editor.panels',
    label: 'Add editor panels',
    description: 'Allows the plugin to register panels that mount in the editor\'s left sidebar (custom inspectors, plugin dashboards, review queues).',
    risk: 'medium',
    surfaces: ['editor'],
  },
  {
    permission: 'modules.register',
    label: 'Register page builder modules',
    description: 'Allows the plugin to ship new modules that show up in the canvas module library.',
    risk: 'high',
    surfaces: ['editor', 'manifest'],
  },
  {
    permission: 'loops.register',
    label: 'Register loop entity sources',
    description: 'Allows the plugin to register data sources for the base.loop module (e.g. external collections, custom queries).',
    risk: 'medium',
    surfaces: ['editor', 'server', 'manifest'],
  },
  {
    permission: 'visualComponents.register',
    label: 'Install Visual Components / templates into the site',
    description: 'Allows the plugin to ship Visual Components, page templates, and class packs that are imported into the user\'s site on activation.',
    risk: 'medium',
    surfaces: ['admin', 'manifest'],
  },
  {
    permission: 'dashboard.widgets.register',
    label: 'Register dashboard widgets',
    description: 'Allows the plugin to add cards to the admin dashboard grid (e.g. analytics charts, queue counters, plugin-specific stats). Each widget runs as a regular React component inside the host\'s admin shell.',
    risk: 'medium',
    surfaces: ['admin'],
  },
  {
    permission: 'frontend.assets',
    label: 'Inject tags into published pages',
    description:
      'Allows the plugin to declare scripts, styles, meta/link tags, and shared host-runtime references in its manifest. The host injects them into every published page at well-defined placements (head / head-end / body-start / body-end). One permission covers external bundles, inline content, and built-in runtimes like the page tracker.',
    risk: 'high',
    surfaces: ['frontend', 'manifest'],
  },
  {
    permission: 'cms.schedule',
    label: 'Register scheduled jobs',
    description: 'Allows the plugin to register handlers that fire on a cadence (hourly / daily / weekly / monthly / every-N-minutes). Each handler runs inside the QuickJS sandbox with a per-fire wall-clock budget; the host scheduler tick drives dispatch and records run history.',
    risk: 'high',
    surfaces: ['server'],
  },
  {
    permission: 'cms.pages.read',
    label: 'Read CMS pages',
    description: 'Allows the plugin to enumerate all published pages on the site via api.cms.pages.list(). Read-only — does not grant write access or republish capability.',
    risk: 'low',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'cms.pages.publish',
    label: 'Republish pages',
    description: 'Allows the plugin to trigger a republish of one or all published pages via api.cms.pages.republish() / api.cms.pages.republishAll(). The full publish pipeline runs (publish.before → publish.html filter → publish.after), so hook listeners and filters registered by other plugins fire as part of the chain.',
    risk: 'medium',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'network.outbound',
    label: 'Outbound network access',
    description: 'Allows the plugin to make outbound HTTP requests from the QuickJS sandbox via the gated fetch() polyfill. Requires a networkAllowedHosts allowlist in the manifest; calls to hosts outside the list are rejected at the host bridge even when the permission is granted. See sandbox.md#network-access.',
    risk: 'high',
    surfaces: ['server'],
  },
  {
    permission: 'media.storage.adapter',
    label: 'Provide a media storage backend',
    description: 'Allows the plugin to register an exclusive storage adapter that the host elects per asset role (original / variant / avatar / font). The adapter issues signed upload targets; the host streams bytes directly. Required for S3, R2, GCS, Azure, and similar backends.',
    risk: 'dangerous',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'media.url.transform',
    label: 'Rewrite media URLs at render time',
    description: 'Allows the plugin to register a pure URL transformer applied to every media path (originals + responsive variants) in the publisher, editor preview, and admin media library. Typical use: passive CDN URL prefixing.',
    risk: 'medium',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'media.variant.delegate',
    label: 'Delegate responsive variant generation to an external service',
    description: "Allows the plugin to replace the host's local image-variant ladder with a URL template (image-transform CDNs — Cloudflare Images, Imgix, Bunny Optimizer). Only one such plugin can win per host.",
    risk: 'high',
    surfaces: ['server', 'cms'],
  },
  {
    permission: 'unstable.internals',
    label: 'Use unstable internal APIs',
    description: 'Reserved for trusted first-party plugins that need unstable host internals.',
    risk: 'dangerous',
    surfaces: ['admin', 'editor', 'server', 'cms'],
  },
]

const capabilityByPermission = new Map(
  PLUGIN_CAPABILITIES.map((capability) => [capability.permission, capability]),
)

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && capabilityByPermission.has(value as PluginPermission)
}

export function permissionLabel(permission: PluginPermission): string {
  return capabilityByPermission.get(permission)?.label ?? permission
}

export function permissionDescription(permission: PluginPermission): string {
  return capabilityByPermission.get(permission)?.description ?? ''
}

export function permissionsForSurface(surface: PluginCapabilitySurface): PluginPermission[] {
  return PLUGIN_CAPABILITIES
    .filter((capability) => capability.surfaces.includes(surface))
    .map((capability) => capability.permission)
}
