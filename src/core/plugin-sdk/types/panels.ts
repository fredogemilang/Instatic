// ---------------------------------------------------------------------------
// Editor panels — left-sidebar panels registered by a plugin
// ---------------------------------------------------------------------------

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
