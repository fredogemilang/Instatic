/**
 * Breakpoints commands — §4.5 of the Command Spotlight master plan.
 *
 * - Switch breakpoint → pushes 'breakpoints' scope
 * - Open breakpoints settings → opens settings modal at breakpoints tab
 */

import type { Command } from '../types'

export function getBreakpointsCommands(): Command[] {
  return [
    // ── Switch breakpoint ────────────────────────────────────────────────────
    {
      id: 'breakpoints.switch',
      title: 'Switch breakpoint…',
      subtitle: 'Change the active canvas breakpoint',
      group: 'editor',
      iconName: 'arrows-horizontal',
      keywords: ['breakpoint', 'switch', 'responsive', 'viewport', 'mobile', 'desktop', 'tablet'],
      workspaces: ['site'],
      run: (ctx) => {
        ctx.pushScope('breakpoints')
      },
    },

    // ── Open breakpoints settings ────────────────────────────────────────────
    {
      id: 'breakpoints.openSettings',
      title: 'Manage breakpoints',
      subtitle: 'Open Settings → Breakpoints',
      group: 'editor',
      iconName: 'settings-cog-solid',
      keywords: ['breakpoint', 'settings', 'add', 'manage', 'responsive', 'viewport'],
      workspaces: ['site'],
      run: async (ctx) => {
        ctx.closeSpotlight()
        try {
          const { useEditorStore } = await import('@site/store/store')
          useEditorStore.getState().openSettings('breakpoints')
        } catch (err) {
          console.error('[spotlight] openSettings breakpoints failed:', err)
        }
      },
    },
  ]
}
