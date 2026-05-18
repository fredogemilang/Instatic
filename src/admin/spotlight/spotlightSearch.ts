/**
 * spotlightSearch — pure search utilities for the spotlight.
 *
 * Separated from SpotlightResults.tsx because react-refresh/only-export-components
 * requires TSX files to export only React components.
 *
 * These are pure functions that can be called from anywhere (Spotlight.tsx,
 * SpotlightResults.tsx, etc.) without React context.
 *
 * Phase 2: scope-aware search — `getCappedResults` accepts an optional scopeId.
 * When in a non-root scope the scope's own commands() are searched instead of
 * the full global catalog.
 *
 * Phase 3: async provider helpers — `getOrderedAsyncGroups` and
 * `getMergedCommandList` extend the search results with provider-supplied
 * commands. Used for keyboard-navigation index tracking and rendering.
 */

import type { Command, CommandContext, SpotlightProvider } from './types'
import { rankCommands } from './matcher'
import { filterCommands, getAllCommands, getScope } from './commandRegistry'
import { readRecentCommands } from './recentStore'

export const PHASE1_CAP = 30

/** Compute the row element id for a command. */
export function rowId(commandId: string): string {
  return `spotlight-row-${commandId.replace(/\./g, '-')}`
}

/** Minimal fallback context for when commandContext is null. */
function makeFallbackCtx(): CommandContext {
  return {
    workspace: 'site',
    pathname: '/',
    user: {
      id: '',
      email: '',
      displayName: '',
      role: { id: '', name: '', capabilities: [] } as never,
      capabilities: [],
    } as never,
  }
}

/**
 * Get the command list for a given scope.
 * 'root' (or undefined) → all commands; any other scope → scope.commands().
 */
function getCommandsForScope(scopeId: string | undefined): Command[] {
  if (!scopeId || scopeId === 'root') {
    return getAllCommands()
  }
  const scope = getScope(scopeId)
  return scope?.commands() ?? []
}

/**
 * Get the capped list of scored commands for a given query + context + scope.
 * Pure function — no React hooks, no side effects.
 *
 * Phase 2: accepts optional `scopeId`; defaults to 'root' (all commands).
 */
export function getCappedResults(
  query: string,
  commandContext: CommandContext | null,
  scopeId?: string,
): Array<{ command: Command; score: number; matchRanges: Array<[number, number]> }> {
  const commands = getCommandsForScope(scopeId)
  const filtered = commandContext ? filterCommands(commands, commandContext) : commands
  const recentIds = readRecentCommands()
  const scored = rankCommands(filtered, query, commandContext ?? makeFallbackCtx(), recentIds)
  return scored.slice(0, PHASE1_CAP)
}

/**
 * Compute the row element id for the currently highlighted command.
 * Returns null when the list is empty or index is out of range.
 *
 * Phase 3: pass `asyncResults` to include provider commands in the
 * navigable flat list; omit for arg-mode where providers don't apply.
 */
export function computeHighlightedRowId(
  query: string,
  commandContext: CommandContext | null,
  highlightedIndex: number,
  scopeId?: string,
  asyncResults?: Record<string, Command[]>,
): string | null {
  if (asyncResults && scopeId) {
    const merged = getMergedCommandList(query, commandContext, scopeId, asyncResults)
    const cmd = merged[highlightedIndex]
    return cmd ? rowId(cmd.id) : null
  }
  const capped = getCappedResults(query, commandContext, scopeId)
  const cmd = capped[highlightedIndex]?.command
  return cmd ? rowId(cmd.id) : null
}

/**
 * Get the command at a given highlighted index.
 *
 * Phase 3: pass `asyncResults` to include provider commands in the index.
 */
export function getCommandAtIndex(
  query: string,
  commandContext: CommandContext | null,
  index: number,
  scopeId?: string,
  asyncResults?: Record<string, Command[]>,
): Command | null {
  if (asyncResults && scopeId) {
    const merged = getMergedCommandList(query, commandContext, scopeId, asyncResults)
    return merged[index] ?? null
  }
  const capped = getCappedResults(query, commandContext, scopeId)
  return capped[index]?.command ?? null
}

// ─── Phase 3: async provider helpers ─────────────────────────────────────────

/** One provider's worth of async results, keyed by provider id and label. */
export interface AsyncProviderGroup {
  providerId: string
  provider: SpotlightProvider
  commands: Command[]
}

/**
 * Collect async provider results in the order the providers are defined in
 * the scope. Groups with zero results are omitted.
 *
 * When `scopeId` is not 'root', only that scope's providers are included
 * (root providers fire separately when the palette is at root level).
 */
export function getOrderedAsyncGroups(
  scopeId: string,
  asyncResults: Record<string, Command[]>,
): AsyncProviderGroup[] {
  const scope = getScope(scopeId)
  const providers = scope?.providers ?? []
  const groups: AsyncProviderGroup[] = []
  for (const provider of providers) {
    const cmds = asyncResults[provider.id]
    if (cmds && cmds.length > 0) {
      groups.push({ providerId: provider.id, provider, commands: cmds })
    }
  }
  return groups
}

/**
 * Collect all providers from a scope that are currently loading (present in
 * `loadingProviders`) and do not yet have results in `asyncResults`.
 * Used to decide which skeleton groups to render.
 */
export function getLoadingProviders(
  scopeId: string,
  loadingProviders: Set<string>,
  asyncResults: Record<string, Command[]>,
): SpotlightProvider[] {
  const scope = getScope(scopeId)
  const providers = scope?.providers ?? []
  return providers.filter(
    (p) => loadingProviders.has(p.id) && !asyncResults[p.id],
  )
}

/**
 * Build the merged flat command list used for keyboard-navigation index
 * tracking: static (scored) commands first, then async provider results in
 * provider-definition order.
 */
export function getMergedCommandList(
  query: string,
  commandContext: CommandContext | null,
  scopeId: string,
  asyncResults: Record<string, Command[]>,
): Command[] {
  const staticCommands = getCappedResults(query, commandContext, scopeId).map(
    (s) => s.command,
  )
  const asyncGroups = getOrderedAsyncGroups(scopeId, asyncResults)
  const asyncCommands = asyncGroups.flatMap((g) => g.commands)
  return [...staticCommands, ...asyncCommands]
}
