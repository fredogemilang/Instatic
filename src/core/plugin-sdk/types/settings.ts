// ---------------------------------------------------------------------------
// Server-side settings API — read / replace persisted plugin settings
// ---------------------------------------------------------------------------

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
