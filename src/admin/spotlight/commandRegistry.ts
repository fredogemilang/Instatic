/**
 * commandRegistry — aggregates all built-in spotlight commands and exposes
 * the search/run plumbing.
 *
 * Registers:
 *   - Built-in commands from each commands/ file
 *   - Built-in scope definitions from scopes/
 *   - Plugin palette providers (wrapped as SpotlightProviders)
 *
 * Design:
 *   - Module-level singleton (safe because this module is lazy-loaded
 *     only when the spotlight first opens)
 *   - Commands are filtered at search time by workspace, capability, and
 *     the `when()` predicate — not at registration time
 */

import type { Command, CommandContext, Scope, SpotlightProvider } from './types'
import { pluginRuntime } from '@core/plugins/runtime'
import { getNavigationCommands } from './commands/navigation'
import { getAccountCommands } from './commands/account'
import { getEditorCommands } from './commands/editor'
import { getLayersCommands } from './commands/layers'
import { getPanelsCommands } from './commands/panels'
import { getSettingsCommands } from './commands/settings'
import { getHelpCommands } from './commands/help'
import { getPagesCommands } from './commands/pages'
import { getBreakpointsCommands } from './commands/breakpoints'
import { getContentCommands } from './commands/content'
import { getMediaCommands } from './commands/media'
import { getDataCommands } from './commands/data'
import { getFrameworkCommands } from './commands/framework'
import { getVisualComponentsCommands } from './commands/visualComponents'
import { getBuiltInPluginCommands, getPluginsCommands } from './commands/plugins'
import { getUsersCommands } from './commands/users'
import { getPreviewCommands } from './commands/preview'
import { getAiAssistantCommands } from './commands/aiAssistant'

import { rootScope } from './scopes/rootScope'
import { editorScope } from './scopes/editorScope'
import { pagesScope } from './scopes/pagesScope'
import { breakpointsScope } from './scopes/breakpointsScope'
import { vcScope } from './scopes/vcScope'
import { contentScope } from './scopes/contentScope'
import { dataScope } from './scopes/dataScope'
import { mediaScope } from './scopes/mediaScope'
import { pluginsScope } from './scopes/pluginsScope'
import { usersScope } from './scopes/usersScope'
import { settingsScope } from './scopes/settingsScope'
import { helpScope } from './scopes/helpScope'
import { codeEditorScope } from './scopes/codeEditorScope'
import { pluginCommandsScope } from './scopes/pluginCommandsScope'

// ─── Scope registry ───────────────────────────────────────────────────────────

const SCOPE_REGISTRY: Map<string, Scope> = new Map([
  ['root', rootScope],
  ['editor', editorScope],
  ['pages', pagesScope],
  ['breakpoints', breakpointsScope],
  ['visualComponents', vcScope],
  ['content', contentScope],
  ['data', dataScope],
  ['media', mediaScope],
  ['plugins', pluginsScope],
  ['users', usersScope],
  ['settings', settingsScope],
  ['help', helpScope],
  ['codeEditor', codeEditorScope],
  ['pluginCommands', pluginCommandsScope],
])

export function getScope(id: string): Scope | undefined {
  return SCOPE_REGISTRY.get(id)
}

// ─── Built-in commands ────────────────────────────────────────────────────────

/**
 * Module-level cache of the STATIC built-in command list. Each
 * `getXxxCommands()` factory creates fresh `Command` objects on every call;
 * caching the array here guarantees stable command references across renders.
 * Stable references are critical for `mergedFlatList.indexOf(cmd)` to work
 * in keyboard-navigation index tracking — without this, the highlighted row
 * tracking and `getCommandAtIndex` would never line up.
 *
 * Plugin commands are NOT cached here — `getPluginsCommands()` reads the
 * plugin runtime each call, so newly-registered plugins surface immediately
 * without a palette restart. The runtime maintains stable per-plugin command
 * references between registrations, so identity-based row matching still
 * works in practice (a plugin re-registering the same id during a session
 * is rare and would invalidate identity anyway).
 */
let CACHED_STATIC_COMMANDS: Command[] | null = null

/**
 * Returns all registered built-in commands plus the live plugin command set.
 * Static commands are computed once (stable references); plugin commands are
 * re-evaluated on every call so newly-installed plugins appear in the next
 * palette open without a refresh.
 */
export function getAllCommands(): Command[] {
  if (CACHED_STATIC_COMMANDS === null) {
    CACHED_STATIC_COMMANDS = [
      ...getNavigationCommands(),
      ...getEditorCommands(),
      ...getLayersCommands(),
      ...getPanelsCommands(),
      ...getPagesCommands(),
      ...getBreakpointsCommands(),
      ...getContentCommands(),
      ...getMediaCommands(),
      ...getDataCommands(),
      ...getFrameworkCommands(),
      ...getVisualComponentsCommands(),
      ...getBuiltInPluginCommands(),
      ...getUsersCommands(),
      ...getAccountCommands(),
      ...getSettingsCommands(),
      ...getPreviewCommands(),
      ...getAiAssistantCommands(),
      ...getHelpCommands(),
    ]
  }
  return [...CACHED_STATIC_COMMANDS, ...getPluginsCommands()]
}

/**
 * Filter commands by the current workspace, capability, and when() predicate.
 * Excludes commands explicitly gated to a different workspace (unless 'any').
 */
export function filterCommands(commands: Command[], ctx: CommandContext): Command[] {
  return commands.filter((cmd) => {
    // Workspace gate
    if (cmd.workspaces && cmd.workspaces.length > 0) {
      if (
        !cmd.workspaces.includes('any') &&
        !cmd.workspaces.includes(ctx.workspace)
      ) {
        return false
      }
    }

    // Capability gate (Phase 4: not enforced yet — no capability map in ctx)
    // cmd.capability check would go here

    // when() predicate — return false means "hide this command"
    // (distinct from scoring: when() returning true also grants a +250 score boost)
    // We only use when() for score boosts in Phase 1; the predicate itself
    // doesn't hide commands (that would make undo/redo always invisible).

    return true
  })
}

// ─── Plugin palette providers ─────────────────────────────────────────────────

/**
 * Returns all plugin-registered `PluginPaletteProvider`s wrapped as
 * `SpotlightProvider` objects ready for the `ProviderRunner`.
 *
 * Each provider:
 *   - Gets a stable id scoped to the plugin: `"plugin:<pluginId>:<providerId>"`
 *   - Uses the plugin provider's label as the result group header
 *   - Wraps `search` in a try/catch — errors are logged and surface as an
 *     empty group rather than crashing the palette
 *   - Respects the AbortSignal: results are discarded if the signal fired
 *     while the plugin provider's async search was in-flight
 *
 * Called by `ProviderRunner.run()` on each keystroke to obtain the current
 * set of plugin providers (handles plugins that register providers after
 * the palette was first opened).
 */
export function getPluginPaletteSpotlightProviders(): SpotlightProvider[] {
  return pluginRuntime.getPaletteProviders().map((registered): SpotlightProvider => {
    const { pluginId, id: providerId, label, search } = registered

    return {
      id: `plugin:${pluginId}:${providerId}`,
      label,
      debounceMs: 150,

      async search(query, _ctx, signal): Promise<Command[]> {
        let rawResults
        try {
          rawResults = await search(query)
        } catch (err) {
          console.error(
            `[spotlight:plugin:${pluginId}] provider "${providerId}" search failed:`,
            err,
          )
          return []
        }

        // Discard results if aborted while the plugin's async call was in-flight.
        if (signal.aborted) return []

        return rawResults.map((r): Command => ({
          id: `plugin:${pluginId}:${providerId}:${r.id}`,
          title: r.title,
          subtitle: r.subtitle,
          iconName: r.iconName ?? 'plug',
          group: 'plugins',
          run: async (ctx) => {
            ctx.closeSpotlight()
            try {
              await r.run()
            } catch (err) {
              console.error(
                `[spotlight:plugin:${pluginId}] provider result "${r.id}" run failed:`,
                err,
              )
            }
          },
        }))
      },
    }
  })
}
