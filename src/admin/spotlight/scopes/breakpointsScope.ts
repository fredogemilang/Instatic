/**
 * Breakpoints scope — lists site breakpoints for selection.
 *
 * Returns synchronous commands from the editor store's current state.
 * Each command switches the active canvas breakpoint.
 */

import type { Scope, Command } from '../types'

function getBreakpointCommands(): Command[] {
  try {
    // Dynamic require is safe here: this scope is only pushed from site workspace
    // where the store is already loaded. Using require() (synchronous) keeps
    // commands() synchronous as required by the Scope interface.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useEditorStore } = require('@site/store/store') as typeof import('@site/store/store')
    const state = useEditorStore.getState()
    const { site, activeBreakpointId } = state
    if (!site) return []
    const breakpoints = site.breakpoints

    return breakpoints.map((bp): Command => ({
      id: `breakpoints.switch.${bp.id}`,
      title: bp.label,
      subtitle: `${bp.width}px`,
      group: 'editor',
      iconName: bp.icon,
      keywords: [bp.label.toLowerCase(), `${bp.width}px`, 'breakpoint', 'viewport', 'responsive'],
      workspaces: ['site'],
      priorityBoost: activeBreakpointId === bp.id ? 1.5 : 1.0,
      run: async (ctx) => {
        ctx.closeSpotlight()
        const { useEditorStore: store } = await import('@site/store/store')
        store.getState().setActiveBreakpoint(bp.id)
      },
    }))
  } catch {
    return []
  }
}

export const breakpointsScope: Scope = {
  id: 'breakpoints',
  title: 'Switch breakpoint',
  placeholder: 'Search breakpoints…',
  commands: getBreakpointCommands,
}
