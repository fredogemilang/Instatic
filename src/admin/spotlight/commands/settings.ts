/**
 * Settings commands — §4.1 (open settings) + §4.8 (editor preferences).
 *
 * Two sources:
 *   1. Static "open settings" commands for each section.
 *   2. Derived commands from PREFERENCE_CATALOG — one toggle command per
 *      boolean preference, one select command per static-select preference.
 *      Dynamic-select prefs (e.g. defaultBreakpoint) are excluded — their
 *      options depend on runtime site data and belong in a scope provider.
 *
 * No hand-mirroring: the catalog is the single source of truth.
 */

import { PREFERENCE_CATALOG } from '@admin/pages/site/preferences/catalog'
import {
  readEditorPreferenceBool,
  setEditorPreference,
  setEditorSelectPreference,
} from '@admin/pages/site/preferences/editorPreferences'
import type { Command } from '../types'

// ─── Static section commands ──────────────────────────────────────────────────

const SECTION_COMMANDS: Command[] = [
  {
    id: 'settings.open',
    title: 'Open Settings',
    subtitle: 'General, Pages, Breakpoints, Publishing, Preferences',
    group: 'settings',
    iconName: 'settings-cog-solid',
    keywords: ['settings', 'preferences', 'config', 'configuration', 'options'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings()
    },
  },
  {
    id: 'settings.openPages',
    title: 'Open Settings → Pages',
    subtitle: 'Manage site pages and routing',
    group: 'settings',
    iconName: 'file-text-solid',
    keywords: ['settings', 'pages', 'routing', 'sitemap'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('pages')
    },
  },
  {
    id: 'settings.openBreakpoints',
    title: 'Open Settings → Breakpoints',
    subtitle: 'Configure responsive breakpoints',
    group: 'settings',
    iconName: 'arrows-horizontal',
    keywords: ['settings', 'breakpoints', 'responsive', 'mobile', 'desktop', 'viewport'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('breakpoints')
    },
  },
  {
    id: 'settings.openPreferences',
    title: 'Open Settings → Preferences',
    subtitle: 'Editor preferences and auto-save settings',
    group: 'settings',
    iconName: 'sliders-horizontal',
    keywords: ['settings', 'preferences', 'autosave', 'editor', 'behavior'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('preferences')
    },
  },
  {
    id: 'settings.openPublishing',
    title: 'Open Settings → Publishing',
    subtitle: 'Configure publishing and deployment settings',
    group: 'settings',
    iconName: 'send-solid',
    keywords: ['settings', 'publishing', 'deploy', 'production', 'domain'],
    workspaces: ['site'],
    run: async (ctx) => {
      ctx.closeSpotlight()
      const { useEditorStore } = await import('@site/store/store')
      useEditorStore.getState().openSettings('publishing')
    },
  },
]

// ─── Derived preference commands ──────────────────────────────────────────────
// One command per boolean preference (toggle), one per static select preference.

function buildPrefCommands(): Command[] {
  const commands: Command[] = []

  for (const pref of PREFERENCE_CATALOG) {
    if (pref.type === 'boolean') {
      commands.push({
        id: `settings.pref.${pref.id}`,
        title: `Toggle: ${pref.label}`,
        subtitle: pref.description,
        group: 'settings',
        iconName: 'sliders-horizontal',
        keywords: [pref.label.toLowerCase(), pref.category, 'preference', 'toggle'],
        workspaces: ['site'],
        run: (ctx) => {
          ctx.closeSpotlight()
          const current = readEditorPreferenceBool(pref.id)
          setEditorPreference(pref.id, !current)
        },
      })
    } else if (pref.type === 'select') {
      // Build a select arg from static options
      commands.push({
        id: `settings.pref.${pref.id}`,
        title: `Set: ${pref.label}…`,
        subtitle: pref.description,
        group: 'settings',
        iconName: 'sliders-horizontal',
        keywords: [pref.label.toLowerCase(), pref.category, 'preference', 'select'],
        workspaces: ['site'],
        args: [
          {
            id: 'value',
            label: pref.label,
            type: 'select',
            options: pref.options.map((o) => ({ value: o.value, label: o.label })),
          },
        ],
        run: (ctx) => {
          ctx.closeSpotlight()
          const value = ctx.args['value']
          if (value) setEditorSelectPreference(pref.id, value)
        },
      })
    }
    // Dynamic-select prefs are excluded — options depend on runtime site data.
  }

  return commands
}

export function getSettingsCommands(): Command[] {
  return [...SECTION_COMMANDS, ...buildPrefCommands()]
}
