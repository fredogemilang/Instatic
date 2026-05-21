import type { EditorStore } from '@site/store/types'
import { Type, type Static } from '@core/utils/typeboxHelpers'
import type {
  PluginRecord,
  StorageListOptions,
  StorageListResult,
} from './storageSchemas'

/**
 * Current host plugin-API version. A plugin manifest declares the API version
 * it was authored against; the host accepts any plugin whose `apiVersion` is
 * within `[MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION]`.
 *
 * Bumping policy:
 *  - `PLUGIN_API_VERSION` is bumped on any breaking change to the SDK shape
 *    (lifecycle, capability set, types).
 *  - `MIN_SUPPORTED_PLUGIN_API_VERSION` is bumped on a major host release
 *    that drops support for older plugins. Set both to N if you want to
 *    require every plugin to be re-released against version N.
 *  - Always equal to the literal accepted at the manifest boundary; tests
 *    enforce this so the schema doesn't drift from the type.
 *
 * Plugins SHOULD declare `apiVersion` explicitly; `definePlugin` defaults to
 * the current host version when omitted.
 */
// ---------------------------------------------------------------------------
// QuickJS sandbox global type extensions
// ---------------------------------------------------------------------------

/**
 * The QuickJS sandbox polyfill for `crypto.subtle.digest` accepts a raw
 * `string` as the `data` argument and UTF-8-encodes it internally — which
 * mirrors the most common call pattern (hashing a canonical-request string
 * for AWS Sigv4, JWT, etc.). This augmentation widens the standard DOM type
 * so plugin TypeScript code can pass strings without a cast.
 */
declare global {
  interface SubtleCrypto {
    digest(algorithm: AlgorithmIdentifier, data: BufferSource | string): Promise<ArrayBuffer>
  }
}

export const PLUGIN_API_VERSION = 1
export const MIN_SUPPORTED_PLUGIN_API_VERSION = 1
export type PluginApiVersion = number

/**
 * Decide whether a manifest's `apiVersion` is compatible with this host. The
 * manifest validator wires this in so the rejection happens at the ingress
 * boundary (zip read / JSON install) before any side effect.
 */
export function isCompatiblePluginApiVersion(version: number): boolean {
  return (
    Number.isInteger(version) &&
    version >= MIN_SUPPORTED_PLUGIN_API_VERSION &&
    version <= PLUGIN_API_VERSION
  )
}

// ---------------------------------------------------------------------------
// Page summary — returned by api.cms.pages.list()
// ---------------------------------------------------------------------------

export const PluginPageSummarySchema = Type.Object({
  id: Type.String({ description: 'Page row id (data_rows.id, a nanoid)' }),
  slug: Type.String({ description: 'URL slug' }),
  title: Type.String({ description: 'Page title' }),
  lastPublishedAt: Type.String({ description: 'ISO 8601 timestamp of when this snapshot was created' }),
})

export type PluginPageSummary = Static<typeof PluginPageSummarySchema>

// ---------------------------------------------------------------------------
// Permission constants
// ---------------------------------------------------------------------------

export const PLUGIN_PERMISSION_VALUES = [
  // Admin / nav
  'admin.navigation',
  // Storage
  'cms.storage',
  // Server runtime
  'cms.routes',
  'cms.hooks',
  // CMS pages — read and republish
  'cms.pages.read',
  'cms.pages.publish',
  // Editor surfaces
  'editor.toolbar',
  'editor.commands',
  'editor.canvas',
  'editor.panels',
  'editor.store.read',
  'editor.store.write',
  // Builder extensions
  'modules.register',
  'loops.register',
  'visualComponents.register',
  'dashboard.widgets.register',
  // Media subsystem — three independent tiers; a plugin can hold any subset.
  //
  //   • 'media.storage.adapter' — register an exclusive backend that intercepts
  //     every media WRITE / DELETE for one or more roles ('original',
  //     'variant', 'avatar', 'font'). The adapter signs upload targets;
  //     the HOST streams bytes directly to them — bytes NEVER cross the
  //     QuickJS boundary (defense against the 64 MB heap ceiling).
  //
  //   • 'media.url.transform' — register a pure URL rewriter. Applied to every
  //     media path the renderer materializes (originals + variants) in the
  //     publisher AND the editor preview iframe AND the admin media library.
  //     Multiple plugins can register; handlers chain.
  //
  //   • 'media.variant.delegate' — replace the host's local variant ladder
  //     with a URL template. For image-transform CDNs (Cloudflare Images,
  //     Imgix, Bunny Optimizer). One winning plugin per host.
  'media.storage.adapter',
  'media.url.transform',
  'media.variant.delegate',
  // Frontend / published pages
  //
  // Single permission gating EVERY declarative frontend tag a plugin can inject
  // into a published page: scripts (external or inline), styles (external or
  // inline), <link>, and <meta>. The actual tags are declared in the manifest's
  // top-level `frontend.assets[]` array — see `FrontendAsset` below. The host
  // is purely the substrate: it splices tags at four placement anchors
  // (head / head-end / body-start / body-end), rewrites the CSP based on
  // what's actually in the plan, and runs the `publish.html` filter once at
  // the dispatcher. No host-shipped scripts, no built-in trackers, no
  // implicit `window.__pb.*` — a plugin that wants `window.__pb_analytics`
  // ships the IIFE that installs it as one of its own assets.
  'frontend.assets',
  // Network — outbound HTTP from the sandbox.
  // Requires the plugin manifest to also declare `networkAllowedHosts`;
  // calls to hosts outside the allowlist are rejected at the host bridge
  // even when the permission is granted.
  'network.outbound',
  // Scheduled jobs — register handlers fired on a cadence (`daily`,
  // `hourly`, `every: { minutes }`, …) by the host's scheduler tick.
  // The handler runs inside the same QuickJS sandbox as everything else.
  'cms.schedule',
  // Reserved
  'unstable.internals',
] as const

export type PluginPermission = typeof PLUGIN_PERMISSION_VALUES[number]

export type ServerPluginLifecycleHook =
  | 'install'
  | 'activate'
  | 'deactivate'
  | 'uninstall'
  | 'migrate'

export const SERVER_PLUGIN_LIFECYCLE_HOOKS: ServerPluginLifecycleHook[] = [
  'install',
  'activate',
  'deactivate',
  'uninstall',
  'migrate',
]

/**
 * Context passed to the `migrate` hook. Plugins receive the previous
 * version's manifest version string so they can write conditional migrations
 * (e.g. "if fromVersion < 1.2.0, run X"). The new version's `migrate` is the
 * one that runs — it knows the new schema and is responsible for transforming
 * data stored under the old shape.
 *
 * Order during an upgrade:
 *   1. Old version's `deactivate(api)` (if running)
 *   2. New version's assets land on disk
 *   3. New version's `migrate({ fromVersion }, api)` — this hook
 *   4. New version's `activate(api)`
 *
 * If `migrate` throws, the host rolls back to the previous version's assets
 * and re-activates the previous version. If `activate` throws after a
 * successful migrate, ALSO rolls back — at that point migrate has typically
 * mutated stored data, so plugins SHOULD treat their migrations as
 * idempotent on the next attempt.
 */
export interface PluginMigrationContext {
  fromVersion: string
}

export interface PluginPin {
  label: string
  detail?: string
  x: number
  y: number
}

export interface PluginEntrypoints {
  server?: string
  editor?: string
  admin?: string
  /** Module pack — default-exports an array of PluginModuleDefinition. */
  modules?: string
}

// ---------------------------------------------------------------------------
// Frontend asset injection — declarative per-plugin tag list
// ---------------------------------------------------------------------------
//
// Every tag a plugin wants injected into a published page is declared up front
// in the manifest's `frontend.assets[]` array. The host reads this array at
// publish time, expands `hostRuntime` references against its small built-in
// registry, dedupes shared runtimes across plugins, and splices the resulting
// tags into the document at four well-known anchors. No worker round-trip, no
// imperative `register(...)` call at activate time — the manifest is the
// single source of truth, statically inspectable from the install consent
// screen.
//
// `frontend.assets` requires the `frontend.assets` permission. CSP is relaxed
// automatically based on what the plan actually contains (e.g. inline scripts
// trigger `script-src 'unsafe-inline'`; pure-external scripts don't).
//
// Naming the placement anchors:
//   - 'head'        → just inside <head>, before any existing tag (rare; for
//                     things that must come first, e.g. a charset reset).
//   - 'head-end'    → just before </head>. Default for <meta>, <link>,
//                     stylesheets, JSON-LD, preconnects.
//   - 'body-start'  → just after <body …>, before page content. Default for
//                     shared host runtimes that need to install
//                     `window.__pb.*` BEFORE plugin scripts that depend on it.
//   - 'body-end'    → just before </body>. Default for deferred plugin
//                     bundles (analytics trackers, widget bootstraps).
// ---------------------------------------------------------------------------

export type FrontendAssetPlacement = 'head' | 'head-end' | 'body-start' | 'body-end'

/**
 * One declarative tag the host injects into the published page. See
 * `PluginManifest.frontend` for context. Discriminated by `kind`; each
 * variant carries only the fields it needs so authors can't, for example,
 * declare both `src` and `inline` on the same script.
 */
export type FrontendAsset =
  /**
   * External JS file shipped in the plugin zip (resolved against
   * `assetBasePath`). Emits one `<script>` tag at the given placement.
   * `strategy` maps to the matching HTML attribute (or `module` for ESM).
   */
  | {
    kind: 'script'
    src: string
    placement?: FrontendAssetPlacement
    strategy?: 'defer' | 'async' | 'module' | 'sync'
    /** Extra attributes (e.g. `type`, `crossorigin`, `integrity`, `data-*`). */
    attrs?: Record<string, string>
  }
  /**
   * Inline `<script>` block. The host wraps `content` in a `<script>` tag at
   * the given placement. Triggers `script-src 'unsafe-inline'` in the page
   * CSP for the inline content to actually execute.
   */
  | {
    kind: 'script-inline'
    content: string
    placement?: FrontendAssetPlacement
    attrs?: Record<string, string>
  }
  /**
   * External CSS file shipped in the plugin zip. Emits one
   * `<link rel="stylesheet" href="…">` tag.
   */
  | {
    kind: 'style'
    href: string
    placement?: FrontendAssetPlacement
    attrs?: Record<string, string>
  }
  /**
   * Inline `<style>` block. Triggers `style-src 'unsafe-inline'` in the
   * page CSP.
   */
  | {
    kind: 'style-inline'
    content: string
    placement?: FrontendAssetPlacement
    attrs?: Record<string, string>
  }
  /**
   * Bare `<link>` tag — for preconnect, dns-prefetch, preload, alternate,
   * etc. The `attrs` object becomes the tag attributes; no body, no inline
   * content. Use `kind: 'style'` for stylesheet links — the host derives
   * the right tag shape for you.
   */
  | {
    kind: 'link'
    attrs: Record<string, string>
    placement?: FrontendAssetPlacement
  }
  /**
   * Bare `<meta>` tag. The `attrs` object becomes the tag attributes.
   */
  | {
    kind: 'meta'
    attrs: Record<string, string>
    placement?: FrontendAssetPlacement
  }

/**
 * Manifest-level `frontend` block. Currently carries only the `assets`
 * array; kept as a nested object so future host-managed runtime declarations
 * (e.g. `runtimePackages`, `importmapExtensions`) can grow alongside it
 * without another manifest-shape migration.
 */
export interface PluginFrontendDeclarations {
  /**
   * Every tag the host should inject into the published page on behalf of
   * this plugin. Order within the array is preserved per placement; tags
   * with the same placement are emitted in declaration order.
   */
  assets: FrontendAsset[]
}

export type PluginResourceFieldType = 'text' | 'longtext' | 'number' | 'date' | 'boolean'

export interface PluginResourceField {
  id: string
  label: string
  type: PluginResourceFieldType
  required?: boolean
}

export interface PluginResource {
  id: string
  title: string
  singularLabel?: string
  pluralLabel?: string
  fields: PluginResourceField[]
}

// PluginRecord, StorageListOptions, and StorageListResult are defined via
// TypeBox in ./storageSchemas and exported from index.ts via
// `export * from './storageSchemas'`. They are imported above (type-only) for
// use in the API surface defined in this file.

export type PluginLifecycleStatus = 'installed' | 'active' | 'disabled' | 'error'

export type PluginPageContent =
  | {
    kind: 'markdown'
    heading?: string
    body: string
  }
  | {
    kind: 'map'
    heading: string
    body?: string
    centerLabel?: string
    pins: PluginPin[]
  }
  | {
    kind: 'resource'
    heading: string
    resource: string
  }
  | {
    kind: 'app'
    heading: string
    entry: string
    assetPath?: string
  }

export interface PluginAdminPage {
  id: string
  title: string
  navLabel?: string
  icon?: string
  /**
   * Optional admin route override. The host derives the final route from
   * the plugin id + page id at install time (`/admin/plugins/:pluginId/:pageId`),
   * so plugin authors never need to set it. Kept on the type for forward
   * compatibility (e.g. nested plugin pages).
   */
  route?: string
  content: PluginPageContent
}

export interface PluginPackManifest {
  /**
   * Path inside the package zip (relative to plugin.json) of a JSON file
   * with the shape `{ visualComponents?: VisualComponent[]; pages?: Page[];
   * classes?: CSSClass[]; }`. The host imports these into the active site
   * on plugin activation.
   */
  path: string
}

export interface PluginAuthorMetadata {
  name: string
  email?: string
  url?: string
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  /**
   * SDK version the plugin was authored against. Must fall in
   * `[MIN_SUPPORTED_PLUGIN_API_VERSION, PLUGIN_API_VERSION]`. Validated by
   * the manifest parser; the host rejects incompatible plugins at install
   * time with a descriptive error.
   */
  apiVersion: PluginApiVersion
  description?: string
  permissions: PluginPermission[]
  grantedPermissions?: PluginPermission[]
  entrypoints?: PluginEntrypoints
  assetBasePath?: string
  resources: PluginResource[]
  adminPages: PluginAdminPage[]
  /** Optional Visual Component / template / class pack. */
  pack?: PluginPackManifest
  /**
   * Declarative frontend tag list — scripts, styles, meta, link, and shared
   * host-runtime references that the host injects into every published page
   * on behalf of this plugin. Requires the `frontend.assets` permission. See
   * `FrontendAsset` for the per-tag shape and `PluginFrontendDeclarations`
   * for placement semantics.
   */
  frontend?: PluginFrontendDeclarations
  /** Author / publisher metadata — surfaced on the Plugins admin card. */
  author?: PluginAuthorMetadata
  /** SPDX license identifier (e.g. `MIT`, `Apache-2.0`). */
  license?: string
  /** Marketing / docs URL. */
  homepage?: string
  /** Source repository URL. */
  repository?: string
  /** Discovery keywords. */
  keywords?: string[]
  /**
   * Allowed outbound HTTP hosts when the `network.outbound` permission is
   * granted. Plain hostnames (`api.example.com`) match exactly; the leading
   * `*.` wildcard matches one subdomain segment (`*.shopify.com` matches
   * `shop.shopify.com` but not `shopify.com` and not `a.b.shopify.com`).
   * If empty or omitted, all outbound calls are denied even when the
   * permission is granted — fail-closed defense.
   */
  networkAllowedHosts?: string[]
  /**
   * Path inside the plugin zip to a small visual icon (.png / .svg /
   * .webp / .jpg). Resolved at runtime against `assetBasePath` for
   * display on the Plugins admin card.
   */
  icon?: string
  /**
   * Declarative settings — the host renders a form for them and persists
   * the user's values in `installed_plugins.settings_json`. Plugin reads
   * values via `api.cms.settings.*`. The full setting definitions live
   * in `src/core/plugin-sdk/builders/settings.ts`; we keep the type here
   * loose (`unknown`) so the SDK builder owns the strict shape.
   */
  settings?: ReadonlyArray<{
    id: string
    label: string
    description?: string
    required?: boolean
    secret?: boolean
    type: 'text' | 'textarea' | 'number' | 'toggle' | 'select' | 'color' | 'url' | 'password'
    default?: string | number | boolean
    options?: ReadonlyArray<{ label: string; value: string }>
    placeholder?: string
    rows?: number
    min?: number
    max?: number
    step?: number
    unit?: string
    format?: 'hex' | 'rgba'
  }>
}

export interface InstalledPlugin {
  id: string
  name: string
  version: string
  enabled: boolean
  lifecycleStatus: PluginLifecycleStatus
  lastError: string | null
  grantedPermissions: PluginPermission[]
  manifest: PluginManifest
  /**
   * Current user-edited settings values, keyed by setting id. Always
   * contains every setting declared in `manifest.settings` — defaults
   * are populated on install. Secret values are masked (`'***'`) when
   * the plugin row is read by the admin UI; plugins reading their own
   * settings via `api.cms.settings.get` see the real value.
   */
  settings: Record<string, string | number | boolean>
  installedAt: string
  updatedAt: string
  /**
   * Recent worker-crash events for this plugin (newest first, capped to 10
   * by the host). Only attached when the row is read through the admin
   * `pluginsPayload` helper — internal repository reads return an empty
   * array. Surfaced in the admin UI's "Recent issues" panel so site owners
   * can see why a plugin is in `error` state without tailing server logs.
   */
  recentCrashes?: Array<{
    id: string
    pluginId: string
    occurredAt: string
    reason: string
    stack: string | null
  }>
}

export interface PluginAdminPageRoute extends Omit<PluginAdminPage, 'route'> {
  pluginId: string
  pluginName: string
  /** Plugin manifest version — surfaced to plugin code via `usePluginContext()`. */
  pluginVersion: string
  /**
   * Row-level timestamp from the plugin install. Used by the host as a
   * cache-buster suffix for the plugin's admin app entrypoint URL — the
   * browser caches stably across editor visits but refetches on upgrade
   * or re-install.
   */
  pluginUpdatedAt: string
  /** Always populated by the host's manifest parser. */
  route: string
  /**
   * Snapshot of the plugin's persisted settings at the moment the host
   * rendered the page. Plugin admin apps read via the `usePluginSettings`
   * hook which returns this snapshot synchronously.
   */
  pluginSettings: Record<string, string | number | boolean>
  /** The full settings schema declared by the plugin manifest. */
  pluginSettingsSchema: PluginManifest['settings']
}

export interface CmsPluginsPayload {
  plugins: InstalledPlugin[]
  adminPages: PluginAdminPageRoute[]
}

export type PluginCommandResult = void | {
  message?: string
}

/**
 * A single argument collected from the user before running a palette command.
 * `type: 'text'` shows a free-form text input; `type: 'select'` renders a
 * static dropdown drawn from `options`.
 */
export interface PluginPaletteArg {
  id: string
  label: string
  type: 'text' | 'select'
  placeholder?: string
  options?: ReadonlyArray<{ value: string; label: string }>
}

/**
 * Core plugin command. All optional fields (subtitle, iconName, keywords,
 * shortcutLabel, destructive, args, workspaces) are palette-specific display
 * hints — omit them for a basic command that auto-surfaces with defaults.
 *
 * Registered via `api.editor.commands.register(cmd)` or
 * `api.editor.palette.registerCommand(cmd)` — both call the same underlying
 * runtime registration.
 */
export interface PluginCommand {
  id: string
  label: string
  run: () => PluginCommandResult | Promise<PluginCommandResult>
  /** Shown beneath the label in the palette result row. */
  subtitle?: string
  /** Pixel-art-icon name; falls back to a generic plug icon. */
  iconName?: string
  /** Extra search terms (low weight, used by the palette fuzzy matcher). */
  keywords?: string[]
  /**
   * Optional shortcut hint shown in the palette row.
   * NOT auto-bound — informational only in v1.
   */
  shortcutLabel?: string
  /** Mark destructive — palette renders danger styling + inline confirm. */
  destructive?: boolean
  /**
   * Declarative arguments collected in subcommand mode before the command
   * runs. Each arg is prompted in sequence.
   */
  args?: PluginPaletteArg[]
  /**
   * Workspace gate — palette hides this command unless the user is on one
   * of the listed workspaces. Omit (or include 'any') to show everywhere.
   */
  workspaces?: ReadonlyArray<
    'dashboard' | 'site' | 'content' | 'data' | 'media' | 'plugins' | 'users' | 'account' | 'any'
  >
}

/**
 * Type alias for clarity in contexts that explicitly document palette usage.
 * Structurally identical to `PluginCommand` — no separate interface needed
 * since every `PluginCommand` is a valid palette command.
 */
export type PluginPaletteCommand = PluginCommand

/**
 * A single result item returned by a `PluginPaletteProvider` search call.
 */
export interface PluginPaletteResult {
  id: string
  title: string
  subtitle?: string
  iconName?: string
  run: () => void | Promise<void>
}

/**
 * Live-search provider registered by a plugin via
 * `api.editor.palette.registerProvider(p)`. The host calls `search(query)`
 * on each debounced keystroke and surfaces the returned results in the
 * palette under the provider's `label` group.
 *
 * Provider id MUST be namespaced: `"<pluginId>.<name>"`.
 * Requires the `editor.commands` permission.
 */
export interface PluginPaletteProvider {
  /** Namespaced id: `"<pluginId>.<name>"`. Must be unique across all plugins. */
  id: string
  /** Becomes the group header in the palette result list. */
  label: string
  /**
   * Return up to ~25 results for the given query string. May be async.
   * Errors are caught by the host — a failing provider surfaces as an empty
   * group rather than crashing the palette.
   */
  search: (query: string) => Promise<PluginPaletteResult[]>
}

export interface PluginToolbarButton {
  id: string
  label: string
  command: string
}

export interface RegisteredPluginToolbarButton extends PluginToolbarButton {
  pluginId: string
}

/**
 * Accent palette for the editor panel rail. Mirrors the four CSS-side
 * accents already declared in `PanelRail` (mint, lilac, sky, peach).
 */
export type PluginEditorPanelAccent = 'mint' | 'lilac' | 'sky' | 'peach'

/**
 * Editor panel registered by a plugin via `editor.panels.register`. Mounts in
 * the left sidebar's panel slot when the user opens it from the rail.
 *
 *   • `id` MUST start with `<pluginId>.` — namespace-locked at registration
 *   • `iconName` is one of the icon files in the `pixel-art-icons` package
 *     (e.g. `'box-stack'`, `'colors-swatch'`). The host renders that icon in
 *     the rail.
 *   • `component` is a real React component. The host renders it inside
 *     the panel body — chrome (header + close button) is host-provided.
 *
 * The plugin's bundle externalizes `react` / `@pagebuilder/host-ui` /
 * `@pagebuilder/host-hooks`, so the component runs against the host's
 * React instance. See `definePluginPanel` in `builders/panel.ts`.
 */
export interface PluginEditorPanel {
  id: string
  label: string
  iconName: string
  accent?: PluginEditorPanelAccent
  /** Optional keyboard shortcut hint shown in the rail tooltip. */
  shortcutLabel?: string
  component: import('react').ComponentType<{
    panel: { id: string; pluginId: string; label: string }
  }>
}

export interface RegisteredPluginEditorPanel extends PluginEditorPanel {
  pluginId: string
}

/**
 * Canvas overlay registered by a plugin via `editor.canvas.registerOverlay`.
 * Mounts inside the editor's canvas overlay layer — a positioned div that
 * sits on top of the rendered canvas and receives no pointer events by
 * default (children can opt in via `pointer-events: auto`).
 *
 * Plugins use the host's `useCanvasNodeRect(nodeId)` hook to position
 * children relative to specific nodes. Common use cases:
 *   • Comment / annotation pins (Figma-style design review)
 *   • Custom selection adornments (a11y outlines, contrast warnings)
 *   • Measurement / ruler tools
 *   • Live data badges over rendered nodes
 *
 * The component receives an `overlay` prop with the registration metadata
 * so plugins that ship multiple overlays can branch on `overlay.id`.
 */
export interface PluginCanvasOverlay {
  id: string
  component: import('react').ComponentType<{
    overlay: { id: string; pluginId: string }
  }>
}

export interface RegisteredPluginCanvasOverlay extends PluginCanvasOverlay {
  pluginId: string
}

/**
 * Tints reserved for dashboard widgets. Mirrors the four `--rail-tint-*`
 * tokens in `src/styles/globals.css`. Widget chrome reads the value to
 * colour the title-dot and default chart accents.
 */
export type PluginDashboardWidgetTint = 'mint' | 'lilac' | 'sky' | 'peach'

/**
 * Default column span on the 12-column dashboard grid. Users can resize
 * a widget after dropping it via the customize-mode resize handle; this
 * is just the initial size.
 */
export type PluginDashboardWidgetSize = 3 | 4 | 6 | 8 | 12

export interface PluginDashboardWidgetRendererProps {
  /** Current grid span (1 .. 12). */
  span: number
  /** True while the user has the dashboard in "Customize" mode. */
  editing: boolean
}

/**
 * Dashboard widget registered by a plugin via
 * `api.dashboard.widgets.register(...)`. Requires the
 * `dashboard.widgets.register` permission.
 *
 *   • `id` MUST be namespaced under the plugin id (`<pluginId>.<rest>`),
 *     enforced by the registry at registration time.
 *   • `icon` is a pixel-art-icon component reference (direct import).
 *   • `component` is a regular React component. The host renders the
 *     widget chrome (title row, drag handle, kebab menu) and mounts the
 *     component inside the body — plugins only own the content.
 */
export interface PluginDashboardWidget {
  id: string
  name: string
  description: string
  iconName: string
  defaultSize: PluginDashboardWidgetSize
  tint: PluginDashboardWidgetTint
  component: import('react').ComponentType<PluginDashboardWidgetRendererProps>
}

export interface EditorPluginApi {
  /**
   * Plugin metadata available to editor entrypoints. Mirrors the shape of
   * `ServerPluginApi.plugin` for consistency, minus `log` (editor code can
   * use the browser console directly).
   */
  plugin: {
    id: string
    version: string
    permissions: PluginPermission[]
    /**
     * Build a URL for a static file the plugin shipped in its zip. See
     * `ServerPluginApi.plugin.assetUrl` for semantics — both forms return
     * the same `/uploads/plugins/<id>/<version>/<path>` URL.
     */
    assetUrl: (path: string) => string
  }
  editor: {
    commands: {
      register: (command: PluginCommand) => void
    }
    toolbar: {
      addButton: (button: PluginToolbarButton) => void
    }
    panels: {
      /**
       * Register a left-sidebar panel that the user can open from the rail.
       * Requires the `editor.panels` permission. The panel id MUST start
       * with `<pluginId>.` — the runtime enforces the namespace at
       * registration time.
       */
      register: (panel: PluginEditorPanel) => void
    }
    canvas: {
      /**
       * Register a canvas overlay React component that mounts on top of
       * the rendered canvas. Requires the `editor.canvas` permission.
       * Overlay id MUST start with `<pluginId>.` — namespace-locked at
       * registration time.
       */
      registerOverlay: (overlay: PluginCanvasOverlay) => void
    }
    store: {
      read: () => EditorStore
      transaction: (mutate: (store: EditorStore) => void) => void
    }
    /**
     * Command Spotlight (⌘K) integration.
     *
     * Both methods require the `editor.commands` permission.
     * If the permission is not granted, the call is a no-op and a warning
     * is logged — no exception is thrown.
     *
     * All commands registered via `editor.commands.register` are ALSO
     * auto-surfaced in the palette (§6.1 of the spotlight plan), so
     * `palette.registerCommand` is only needed when you want to register a
     * palette-only command that is NOT a toolbar-reachable command.
     */
    palette: {
      /**
       * Register a command in the Command Spotlight palette.
       * Equivalent to `editor.commands.register` but makes intent explicit
       * for commands authored specifically for the palette (with subtitle,
       * iconName, args, etc.).
       */
      registerCommand: (cmd: PluginCommand) => void
      /**
       * Register a live-search provider. The palette calls `provider.search`
       * on each debounced keystroke and groups results under `provider.label`.
       */
      registerProvider: (provider: PluginPaletteProvider) => void
    }
  }
  /**
   * Admin dashboard surface — `/admin/dashboard`. Plugins register cards
   * (analytics charts, queue counters, plugin-specific stats) for the
   * configurable widget grid via `dashboard.widgets.register(...)`.
   * Requires the `dashboard.widgets.register` permission.
   */
  dashboard: {
    widgets: {
      /**
       * Register a dashboard widget. The widget id MUST be namespaced
       * under the plugin id (`<pluginId>.<rest>`) — registration is
       * rejected otherwise. Re-registration with the same id replaces
       * the previous definition (normal on plugin upgrade).
       */
      register: (widget: PluginDashboardWidget) => void
    }
  }
  cms: {
    storage: {
      collection: (resourceId: string) => {
        list: (options?: StorageListOptions) => Promise<StorageListResult>
        create: (data: Record<string, unknown>) => Promise<PluginRecord>
        update: (recordId: string, data: Record<string, unknown>) => Promise<PluginRecord>
        delete: (recordId: string) => Promise<void>
      }
    }
  }
}

export interface EditorPluginModule {
  activate: (api: EditorPluginApi) => void | Promise<void>
}

export type RouteMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

/**
 * Simplified request object available to plugin route handlers inside the
 * QuickJS sandbox. A subset of the Web `Request` API — only the fields that
 * cross the JSON boundary from the Bun host into the VM.
 *
 * `headers` is a **case-insensitive** facade matching the standard `Headers`
 * interface surface. It normalises all key lookups to lowercase, so
 * `headers.get('Content-Type')` and `headers.get('content-type')` are
 * equivalent — matching WHATWG `Headers.get()` semantics.
 */
export interface ServerPluginRequest {
  url: string
  method: string
  headers: {
    get(name: string): string | null
    has(name: string): boolean
    entries(): Array<[string, string]>
    keys(): string[]
    values(): string[]
    forEach(cb: (value: string, name: string) => void): void
  }
  json(): Promise<unknown>
  text(): Promise<string>
}

export interface ServerPluginRouteContext {
  req: ServerPluginRequest
  body: Record<string, unknown>
  user: {
    id: string
    email: string
    capabilities: string[]
  } | null
}

/**
 * Handler for a plugin-registered server route.
 *
 * By default, any returned value is JSON-serialized and sent as
 * `application/json` with status 200. To control the HTTP status code,
 * response headers, or body encoding (e.g. CSV, plain text, HTML), return
 * the **raw-response escape hatch**:
 *
 * ```ts
 * return {
 *   __response: true,
 *   status: 200,
 *   headers: {
 *     'Content-Type': 'text/csv; charset=utf-8',
 *     'Content-Disposition': 'attachment; filename="export.csv"',
 *   },
 *   body: csvString,  // must be a string
 * }
 * ```
 *
 * Returning `undefined` is equivalent to returning `{ ok: true }` (status 200,
 * JSON body).
 */
export type ServerPluginRouteHandler = (
  context: ServerPluginRouteContext,
) => unknown | Promise<unknown>

// ---------------------------------------------------------------------------
// CMS server-side hook event surface
// ---------------------------------------------------------------------------

export interface CmsServerEvents {
  'publish.before': { siteId: string; pageId?: string }
  'publish.after': { siteId: string; pageId?: string }
  'content.entry.created': { tableSlug: string; entryId: string }
  'content.entry.updated': { tableSlug: string; entryId: string }
  'content.entry.deleted': { tableSlug: string; entryId: string }
  // Plugin-defined events fall through. The host does not pre-define any
  // frontend-specific event channels — plugins that ingest events from
  // their own published-page bundles register their own `routes.postPublic`
  // endpoints and (optionally) re-emit on the hook bus under a namespaced
  // name (`pagebuilder.analytics.page-view`) for cross-plugin coordination.
  [key: string]: Record<string, unknown>
}

export interface CmsServerFilters {
  'publish.html': string
  'publish.headers': Record<string, string>
  // Plugin-defined filters fall through.
  [key: string]: unknown
}

/**
 * Extra context fields passed to filter handlers alongside `{ pluginId }`.
 * Keyed by filter name; only named filters carry structured context — the
 * generic fallthrough gets `Record<string, unknown>`.
 *
 * Filter handlers destructure what they need:
 * ```ts
 * api.cms.hooks.filter('publish.html', (html, { siteId, pageId, slug }) => {
 *   return html.replace('</body>', `<!-- page:${slug} -->\n</body>`)
 * })
 * ```
 */
export interface CmsServerFilterContexts {
  'publish.html': { siteId: string; pageId: string; slug: string }
  'publish.headers': { siteId: string; pageId: string; slug: string }
}

export interface ServerPluginHooksApi {
  on: <K extends keyof CmsServerEvents | string>(
    event: K,
    listener: (
      payload: K extends keyof CmsServerEvents ? CmsServerEvents[K] : Record<string, unknown>,
    ) => void | Promise<void>,
  ) => void
  filter: <K extends keyof CmsServerFilters | string>(
    name: K,
    handler: (
      value: K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown,
      context: { pluginId: string } & (
        K extends keyof CmsServerFilterContexts ? CmsServerFilterContexts[K] : Record<string, unknown>
      ),
    ) =>
      | (K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown)
      | Promise<K extends keyof CmsServerFilters ? CmsServerFilters[K] : unknown>,
  ) => void
  emit: <K extends keyof CmsServerEvents | string>(
    event: K,
    payload: K extends keyof CmsServerEvents ? CmsServerEvents[K] : Record<string, unknown>,
  ) => Promise<void>
}

// Forward-declared opaque type — full shape lives in `@core/loops/types`.
// We keep it opaque on the SDK boundary so plugin authors aren't pulled
// into the loops module dependency graph until they need it.
export type LoopEntitySource = {
  id: string
  label: string
  description?: string
  filterSchema: Record<string, unknown>
  orderByOptions: Array<{ id: string; label: string }>
  fields: Array<{ id: string; label: string; description?: string; format?: 'plain' | 'html' | 'url' | 'media' }>
  fetch: (ctx: unknown) => Promise<{ items: unknown[]; totalItems: number }>
  preview: (ctx: unknown) => unknown[]
}

export interface ServerPluginSettingsApi {
  /** Resolve a single setting value, returning `undefined` if unset. */
  get: <T extends string | number | boolean = string>(key: string) => T | undefined
  /** Snapshot of every declared setting, populated with defaults. */
  getAll: () => Record<string, string | number | boolean>
  /**
   * Replace the full settings record. Validated against the plugin's
   * declared schema before persistence; emits `settings.changed`. Only
   * the host (admin user) is expected to call this normally — plugins
   * mutating their own settings is allowed but rare.
   */
  replace: (next: Record<string, unknown>) => Promise<void>
}

// ---------------------------------------------------------------------------
// Scheduled jobs — `api.cms.schedule.*`
// ---------------------------------------------------------------------------

/**
 * Cadence shapes the plugin can register. All times are interpreted in
 * UTC. The full set is restricted to a small enum of common intervals —
 * full cron strings are intentionally not supported. Plugin authors who
 * need irregular cadences ("every 13 minutes during business hours") can
 * implement that inside a handler that runs `every: { minutes: 1 }` and
 * gates internally.
 */
export type PluginScheduleCadence =
  | { interval: 'hourly' }
  | { interval: 'daily'; at: string }
  | { interval: 'weekly'; at: string; day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun' }
  | { interval: 'monthly'; at: string; dayOfMonth: number }
  | { interval: 'every'; minutes: number }

export type PluginScheduleOverlapPolicy = 'skip' | 'queue' | 'parallel'

export interface PluginScheduleDefinition {
  /**
   * Schedule id within the plugin's namespace. Final id is
   * `<pluginId>.<scheduleId>`. Must be unique per plugin.
   */
  id: string
  cadence: PluginScheduleCadence
  /**
   * What to do when a fire arrives while the previous run is still in
   * progress:
   *   - `'skip'`     — drop the new fire (default; safest)
   *   - `'queue'`    — FIFO queue, capped at 10
   *   - `'parallel'` — run concurrently (handler must be safe under it)
   */
  overlap?: PluginScheduleOverlapPolicy
  /**
   * Wall-clock budget for one fire of the handler. Defaults to 5_000ms.
   * Bounded by the host to 5 minutes to prevent any single plugin from
   * monopolising a worker.
   */
  maxDurationMs?: number
  /** Async handler — receives no arguments. Use closure scope for state. */
  handler: () => void | Promise<void>
}

export interface ServerPluginScheduleApi {
  /**
   * Register or update a scheduled job. Idempotent on re-activation —
   * calling with the same `id` keeps last-run history while replacing the
   * cadence + handler with whatever the latest `activate()` declared.
   */
  register: (def: PluginScheduleDefinition) => void
  /**
   * Cancel a previously-registered schedule. Removes the handler from the
   * VM and disables the row in the host. The row stays for audit; future
   * `register` calls re-enable it.
   */
  cancel: (scheduleId: string) => void
  /** Short form for `register({ id, cadence: { interval: 'daily', at }, handler })`. */
  daily: (id: string, at: string, handler: () => void | Promise<void>) => void
  /** Short form for `register({ id, cadence: { interval: 'hourly' }, handler })`. */
  hourly: (id: string, handler: () => void | Promise<void>) => void
  /** Short form for `register({ id, cadence: { interval: 'every', minutes }, handler })`. */
  every: (minutes: number, id: string, handler: () => void | Promise<void>) => void
}

// ---------------------------------------------------------------------------
// Media storage adapter — Tier 2 of the media plugin surface.
//
// Adapters register exclusively per role via api.cms.media.registerStorageAdapter
// and are elected by the admin from "Settings → Media storage". The host
// writes ROUND ONE (beginWrite → adapter returns a signed PUT plan), then
// streams the bytes itself, then commits ROUND TWO (finalizeWrite). Bytes
// never cross the QuickJS sandbox boundary.
//
// Three independent permissions gate the three media tiers; see
// PLUGIN_PERMISSION_VALUES for the full mapping.
// ---------------------------------------------------------------------------

/**
 * Asset roles the storage subsystem distinguishes. An adapter declares the
 * subset of roles it wants to handle. Different adapters may be elected
 * for different roles (e.g. S3 for `original`, local for `avatar`).
 *
 * `'plugin-pack'` covers plugin-shipped static files (icons, frontend JS,
 * module bundles) extracted under `/uploads/plugins/<id>/<version>/`. It is
 * NOT routable to a storage adapter today — plugin assets remain local for
 * cold-start latency — but is reserved in the enum so the type stays stable
 * if we change that decision later.
 */
export type MediaAssetRole =
  | 'original'
  | 'variant'
  | 'avatar'
  | 'font'
  | 'plugin-pack'

/**
 * How the adapter wants reads served. Picked once at registration; the host
 * wires the read path differently per mode.
 *
 *   • `'public-url'`      — `write()` returned a forever-fetchable URL. Renderers
 *                           emit that URL directly. The host's `/uploads/*`
 *                           handler is bypassed entirely for this asset.
 *   • `'signed-redirect'` — Host issues `getReadUrl()` per request, 302-redirects
 *                           the browser. Required for private buckets or
 *                           hotlink-protected CDNs.
 *   • `'proxy'`           — Host streams the bytes via `readStream()` back to
 *                           the browser. Rare; required only when the backend
 *                           offers neither public URLs nor signed URLs.
 */
export type MediaStorageServingMode = 'public-url' | 'signed-redirect' | 'proxy'

export interface MediaStorageBeginWriteInput {
  /** Server-validated MIME (one of `EXTENSION_FOR_MIME`'s keys). */
  mimeType: string
  /**
   * Server-chosen safe filename WITH the server-trusted extension. The
   * adapter is free to use it as-is, prefix it, hash it, or remap it — the
   * `storagePath` it returns in the plan is what the host stores on the
   * DB row.
   */
  suggestedStoragePath: string
  /** SHA-256 of the bytes (lowercase hex). Adapters can dedupe / verify. */
  contentHash: string
  /** Total bytes the host will stream — adapter knows the exact Content-Length. */
  sizeBytes: number
  role: MediaAssetRole
  /** When `role === 'variant'`, the storagePath of the parent original. */
  variantOf?: string
}

/**
 * One step in the upload plan. Most providers need a single PUT — that's
 * one entry. S3 multipart / GCS resumable need multiple steps; the host
 * walks the array in order and POSTs/PUTs each one.
 */
export interface MediaStorageUploadStep {
  method: 'PUT' | 'POST'
  url: string
  headers: Record<string, string>
  /**
   * For multipart uploads: which byte range of the original is sent in
   * this step. Omit for single-part uploads — the host sends the full body.
   */
  range?: { start: number; end: number }
}

export interface MediaStorageUploadPlan {
  /**
   * Adapter's final on-storage handle. Persisted in `media_assets.storage_path`
   * and passed back to `finalizeWrite` / `delete` / `getReadUrl`.
   */
  storagePath: string
  /**
   * Steps the host executes in order. `[]` is legal and means "no bytes to
   * upload" (the built-in local-disk adapter uses this — see internals).
   */
  steps: ReadonlyArray<MediaStorageUploadStep>
  /** Plan expiry epoch ms; the host aborts if any step is initiated after this. */
  expiresAt: number
}

export interface MediaStorageFinalizeWriteInput {
  storagePath: string
  /** Echoed receipts (ETag, version-id, part number) from each completed step. */
  uploadReceipts: ReadonlyArray<{
    etag?: string
    versionId?: string
    partNumber?: number
  }>
}

export interface MediaStorageWriteResult {
  /**
   * What the renderer / browser emits. May be:
   *   • absolute URL (`https://cdn.example.com/...`) for `'public-url'` adapters
   *   • host-relative path (`/uploads/<storagePath>`) for `'signed-redirect'`
   *     and `'proxy'` adapters — host resolves at request time.
   */
  publicUrl: string
  /** Adapter-specific tags; opaque to host, surfaced in admin debug. */
  metadata?: Record<string, string>
}

export interface MediaStorageVerifyResult {
  ok: boolean
  /** Short prose surfaced inline next to the "Test connection" button. */
  reason?: string
  /** Optional follow-up hint (e.g. "check IAM policy"). */
  hint?: string
}

export interface MediaStorageAdapter {
  /**
   * Adapter id — MUST be `<pluginId>.<rest>`. Surfaced in the admin
   * storage-backend picker.
   */
  id: string
  /** Display name in the admin picker, e.g. "Amazon S3", "Cloudflare R2". */
  label: string
  /**
   * Roles this adapter is willing to handle. Election is per-role: the admin
   * can pick `s3` for originals and `local` for avatars independently. An
   * adapter that omits a role cannot be elected for it.
   */
  roles: ReadonlyArray<MediaAssetRole>
  /** How reads are served — see `MediaStorageServingMode`. */
  servingMode: MediaStorageServingMode
  /**
   * Round one: return a signed upload plan. The host then streams bytes
   * directly to the URLs in the plan using its own runtime fetch — bytes
   * NEVER cross the sandbox boundary.
   *
   * Adapters MUST be idempotent on `suggestedStoragePath` — the host may
   * retry `beginWrite` on transient failures before giving up.
   */
  beginWrite: (input: MediaStorageBeginWriteInput) => Promise<MediaStorageUploadPlan>
  /**
   * Round two: confirm the upload landed. Host calls this AFTER it has
   * received 2xx on every step. Adapter returns the final shape persisted
   * on the DB row.
   */
  finalizeWrite: (input: MediaStorageFinalizeWriteInput) => Promise<MediaStorageWriteResult>
  /**
   * Cleanup. Called when round-one succeeded but round-two (host PUT) failed.
   * Idempotent — adapter MUST swallow "already gone".
   */
  abortWrite: (input: { storagePath: string }) => Promise<void>
  /**
   * Required for `servingMode === 'public-url'`     — return a stable URL.
   * Required for `servingMode === 'signed-redirect'` — return a short-lived URL.
   * MUST be `undefined` for `servingMode === 'proxy'`.
   */
  getReadUrl?: (
    storagePath: string,
    ttlSeconds: number,
  ) => Promise<{ url: string; expiresAt: number }>
  /**
   * Required for `servingMode === 'proxy'` only. Host iterates the async-iter,
   * piping chunks into the response body so the VM heap never holds the
   * whole object. Bytes flow plugin → host as base64-encoded chunks of at
   * most 256 KB each.
   */
  readStream?: (storagePath: string) => AsyncIterable<Uint8Array>
  /** Hard-delete. Idempotent — MUST swallow "already gone". */
  delete: (storagePath: string) => Promise<void>
  /**
   * Pre-flight connectivity check called from the admin "Test connection"
   * button BEFORE election. Returns a structured diagnosis the host renders
   * inline — never throws.
   */
  verify: () => Promise<MediaStorageVerifyResult>
  /**
   * Optional. Declared CSP origins the host should add to `img-src` /
   * `media-src` / `connect-src` in the editor preview iframe and the
   * published-page CSP. Static — declared once at registration.
   */
  cspOrigins?: ReadonlyArray<{
    directive: 'img-src' | 'media-src' | 'connect-src'
    origin: string
  }>
}

// ---------------------------------------------------------------------------
// Media URL transformer — Tier 1.
// ---------------------------------------------------------------------------

export interface MediaUrlTransformContext {
  kind: 'original' | 'variant'
  /** Intrinsic width when `kind === 'variant'`. Absent for originals. */
  width?: number
  /** Variant pixel format. Absent for originals. */
  format?: 'webp' | 'jpeg' | 'png' | 'avif'
  /** MIME type of the original asset (`'image/jpeg'`, `'video/mp4'`, …). */
  originalMimeType: string
}

/**
 * Pure path → path rewriter. Runs at every point the renderer materializes
 * a media URL. Returning `null` means "no change; pass through to the next
 * transformer in the chain".
 */
export type MediaUrlTransformer = (
  path: string,
  ctx: MediaUrlTransformContext,
) => string | null

// ---------------------------------------------------------------------------
// Media variant delegate — Tier 3.
// ---------------------------------------------------------------------------

/**
 * Replaces the host's local image-variant ladder with a URL template. When
 * a plugin registers a delegate and is elected, the host STOPS generating
 * local variants — only the original + BlurHash are stored. Variant URLs
 * are computed on demand by the renderer using the template.
 *
 * Template placeholders the host substitutes:
 *   {path}          → original asset path (e.g. `/uploads/foo.jpg`)
 *   {width}         → variant intrinsic width
 *   {format}        → `'webp'` | `'jpeg'` | `'png'` | `'avif'`
 *   {quality}       → integer 1..100 (defaults to 80)
 *   {originalMime}  → mime type of the original (`image/jpeg`)
 *
 * Example (Cloudflare Images):
 *   `https://example.com/cdn-cgi/image/width={width},format={format},quality=80{path}`
 */
export interface MediaVariantDelegate {
  /** Delegate id — MUST be `<pluginId>.<rest>`. */
  id: string
  /** URL template. Static; declared once at registration. */
  variantUrlTemplate: string
  /** Widths the renderer should emit in `srcset` (replaces the local ladder). */
  widths: ReadonlyArray<number>
  /** Formats emitted; usually `['webp']` or `['avif', 'webp']`. */
  formats: ReadonlyArray<'webp' | 'jpeg' | 'avif'>
}

export interface ServerPluginMediaApi {
  /**
   * Register an exclusive storage adapter. The admin elects which adapter
   * handles each role from "Settings → Media storage". An adapter cannot
   * be elected for a role it doesn't declare in `roles`.
   *
   * Requires the `media.storage.adapter` permission. Adapter id MUST be
   * `<pluginId>.<rest>`. Re-registering an adapter with the same id
   * (e.g. on plugin re-activation) replaces the previous definition.
   */
  registerStorageAdapter: (adapter: MediaStorageAdapter) => void
  /**
   * Register a URL transformer. Chained with every other registered
   * transformer (registration order = chain order). Requires the
   * `media.url.transform` permission.
   */
  registerUrlTransformer: (transformer: MediaUrlTransformer) => void
  /**
   * Register a variant delegate. Only one delegate is active per host —
   * the admin picks the winner. Requires the `media.variant.delegate`
   * permission. Delegate id MUST be `<pluginId>.<rest>`.
   */
  registerVariantDelegate: (delegate: MediaVariantDelegate) => void
}

export interface ServerPluginApi {
  plugin: {
    id: string
    version: string
    permissions: PluginPermission[]
    log: (...args: unknown[]) => void
    /**
     * Build a public URL for a static file the plugin ships in its zip.
     *
     * Plugin packages can include any number of static assets (images,
     * CSS, fonts, JSON, …) alongside the bundled JS entrypoints. They are
     * extracted to `/uploads/plugins/<id>/<version>/<path>` at install
     * time and served by the host's static handler.
     *
     * This helper returns the canonical URL for the given package-relative
     * path. It works inside the sandbox AND from admin / editor / frontend
     * bundles (which receive the same context through their host wrappers).
     *
     * @example
     *   const url = api.plugin.assetUrl('icon.svg')
     *   // → "/uploads/plugins/acme.template/1.0.0/icon.svg"
     */
    assetUrl: (path: string) => string
  }
  cms: {
    routes: {
      get: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      post: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      patch: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      delete: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      getPublic: (path: string, handler: ServerPluginRouteHandler) => void
      postPublic: (path: string, handler: ServerPluginRouteHandler) => void
      patchPublic: (path: string, handler: ServerPluginRouteHandler) => void
      deletePublic: (path: string, handler: ServerPluginRouteHandler) => void
    }
    loops: {
      /**
       * Register a loop entity source. Source ID must be `<pluginId>.<name>`.
       * The host enforces the namespace lock at registration time.
       */
      registerSource: (source: LoopEntitySource) => void
    }
    /**
     * Read / replace the plugin's persisted settings. The schema declared
     * via `definePlugin({ settings: [...] })` is the source of truth; the
     * host populates defaults at install time and validates updates at the
     * boundary. Emits the `settings.changed` event when values change.
     */
    settings: ServerPluginSettingsApi
    storage: {
      collection: (resourceId: string) => {
        list: (options?: StorageListOptions) => Promise<StorageListResult>
        create: (data: Record<string, unknown>) => Promise<PluginRecord>
        update: (recordId: string, data: Record<string, unknown>) => Promise<PluginRecord | null>
        delete: (recordId: string) => Promise<boolean>
      }
    }
    hooks: ServerPluginHooksApi
    /**
     * Register handlers that fire on a cadence. Requires the
     * `cms.schedule` permission. Handlers run inside the same QuickJS
     * sandbox as the rest of the plugin's server code, with a per-fire
     * wall-clock budget (default 5_000ms, configurable per schedule).
     * The host's scheduler tick (`server/plugins/scheduler.ts`) drives
     * dispatch and persists last-run state across restarts.
     */
    schedule: ServerPluginScheduleApi
    /**
     * Enumerate and republish CMS pages.
     *
     *   • `pages.list()`         — enumerate all currently-published pages.
     *   • `pages.republish(id)`  — re-run the full publish pipeline for a single
     *                              page (publish.before → publish.html filter →
     *                              publish.after). Useful after a plugin activates
     *                              to ensure its filters are applied to existing
     *                              published pages.
     *   • `pages.republishAll()` — republish every published page; returns the
     *                              total count.
     *
     * `pages.list` requires `cms.pages.read`; `pages.republish` and
     * `pages.republishAll` require `cms.pages.publish`.
     */
    pages: {
      list: () => Promise<ReadonlyArray<PluginPageSummary>>
      republish: (pageId: string) => Promise<void>
      republishAll: () => Promise<{ count: number }>
    }
    /**
     * Media subsystem extension points. Three independent tiers:
     *
     *   • registerStorageAdapter   — handle WRITE/DELETE bytes (S3, R2, …).
     *                                Two-phase: adapter signs upload plan,
     *                                host streams bytes itself.
     *   • registerUrlTransformer   — pure URL rewriter (passive CDN).
     *   • registerVariantDelegate  — replace local variant ladder with
     *                                a URL template (image-transform CDN).
     *
     * Each call requires its own permission — see PLUGIN_PERMISSION_VALUES.
     */
    media: ServerPluginMediaApi
  }
}

export interface ServerPluginModule {
  install?: (api: ServerPluginApi) => void | Promise<void>
  activate?: (api: ServerPluginApi) => void | Promise<void>
  deactivate?: (api: ServerPluginApi) => void | Promise<void>
  uninstall?: (api: ServerPluginApi) => void | Promise<void>
  /**
   * Called during an upgrade install — between the old version's
   * `deactivate` and the new version's `activate`. Receives the previous
   * version string in `ctx.fromVersion` and the new version's `ServerPluginApi`.
   * If the hook throws, the host rolls back to the previous version's assets.
   * Plugins SHOULD make migrations idempotent.
   */
  migrate?: (ctx: PluginMigrationContext, api: ServerPluginApi) => void | Promise<void>
}
