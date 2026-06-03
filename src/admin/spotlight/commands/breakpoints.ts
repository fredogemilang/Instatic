/**
 * Viewport commands — §4.5 of the Command Spotlight master plan.
 *
 * - Switch viewport → pushes 'breakpoints' scope
 * - Open viewport settings → opens settings modal at breakpoints tab
 */

import type { Command } from '../types'

export function getBreakpointsCommands(): Command[] {
  return [
    // ── Switch viewport ──────────────────────────────────────────────────────
    {
      id: 'breakpoints.switch',
      title: 'Switch viewport…',
      subtitle: 'Change the active canvas viewport',
      group: 'editor',
      iconName: 'arrows-horizontal',
      keywords: ['breakpoint', 'switch', 'responsive', 'viewport', 'mobile', 'desktop', 'tablet'],
      workspaces: ['site'],
      capability: 'site.read',
      run: (ctx) => {
        ctx.pushScope('breakpoints')
      },
    },

    // ── Open viewport settings ───────────────────────────────────────────────
    {
      id: 'breakpoints.openSettings',
      title: 'Manage viewports',
      subtitle: 'Open Settings → Viewports',
      group: 'editor',
      iconName: 'settings-cog-solid',
      keywords: ['breakpoint', 'settings', 'add', 'manage', 'responsive', 'viewport'],
      workspaces: ['site'],
      capability: 'site.style.edit',
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
