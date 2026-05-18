import type { EditorStore } from '@site/store/types'

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

export const PLUGIN_PERMISSION_VALUES = [
  // Admin / nav
  'admin.navigation',
  // Storage
  'cms.storage',
  // Server runtime
  'cms.routes',
  'cms.hooks',
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
  // Frontend / published pages
  'frontend.scripts',
  'frontend.tracker',
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
  /** Bundle injected on every published page (frontend.scripts permission). */
  frontend?: string
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

export interface PluginRecord {
  id: string
  pluginId: string
  resourceId: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

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
    'site' | 'content' | 'data' | 'media' | 'plugins' | 'users' | 'account' | 'any'
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

export interface EditorPluginApi {
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
  cms: {
    storage: {
      collection: (resourceId: string) => {
        list: () => Promise<PluginRecord[]>
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

export interface ServerPluginRouteContext {
  req: Request
  body: Record<string, unknown>
  user: {
    id: string
    email: string
    capabilities: string[]
  } | null
}

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
  'tracker.event': {
    pluginId: string
    eventName: string
    payload: Record<string, unknown>
    visitorId?: string
    sessionId?: string
    pagePath?: string
    referrer?: string
    receivedAt: string
  }
  // Plugin-defined events fall through.
  [key: string]: Record<string, unknown>
}

export interface CmsServerFilters {
  'publish.html': string
  'publish.headers': Record<string, string>
  // Plugin-defined filters fall through.
  [key: string]: unknown
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
      context: { pluginId: string },
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

export interface ServerPluginApi {
  plugin: {
    id: string
    version: string
    permissions: PluginPermission[]
    log: (...args: unknown[]) => void
  }
  cms: {
    routes: {
      get: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      post: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      patch: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      delete: (path: string, capability: string, handler: ServerPluginRouteHandler) => void
      getPublic: (path: string, handler: ServerPluginRouteHandler) => void
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
        list: () => Promise<PluginRecord[]>
        create: (data: Record<string, unknown>) => Promise<PluginRecord>
        update: (recordId: string, data: Record<string, unknown>) => Promise<PluginRecord | null>
        delete: (recordId: string) => Promise<boolean>
      }
    }
    hooks: ServerPluginHooksApi
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
