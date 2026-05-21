/**
 * Plugin runtime bootstrap — populates `globalThis.__pagebuilder` with the
 * host's React, ReactDOM, JSX runtime, design-system primitives, and
 * plugin SDK builders so the import-map shims in `public/runtime/*.js`
 * can re-export them.
 *
 * Why a global object instead of separate code chunks served by Vite:
 *   1. We need plugins to share the *same* React module instance the
 *      editor uses. Splitting React into its own chunk would still
 *      duplicate React if the chunk wasn't reference-equal — globalThis
 *      makes the sharing explicit.
 *   2. Vite/Rollup's chunk-deduplication is build-time; the plugin's
 *      bundle is loaded at runtime via a path Vite never sees, so we
 *      can't rely on the bundler to dedupe.
 *   3. The shim files are pure ES modules served from `public/runtime/*.js`
 *      — small, hand-auditable, no rollup magic. They re-export from
 *      the global the host populated here.
 *
 * This module is imported once from `src/admin/main.tsx` BEFORE the
 * React tree mounts so any plugin import that happens during the first
 * editor render finds the runtime ready. Subsequent calls are no-ops
 * (idempotent — the global object is replaced wholesale on each call).
 *
 * Safety: never expose host internals beyond what the plugin SDK
 * already documents. The shim files in `public/runtime/` form the
 * narrow contract — anything not re-exported there is private.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime'
import * as ReactDOM from 'react-dom'

// Host UI surface — the named React components plugins import via
// `@pagebuilder/host-ui`.
import {
  Alert,
  Bars,
  Button,
  Card,
  Checkbox,
  Code,
  Delta,
  EmptyState,
  Heading,
  Input,
  RangeTabs,
  SearchBar,
  Select,
  Separator,
  Sparkline,
  Stack,
  StackedBar,
  StatValue,
  Switch,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Text,
  Textarea,
  Widget,
  WidgetList,
  WidgetListRow,
} from '@admin/plugin-host-ui'

// Host hooks surface — useEditorStore, usePluginSettings, etc.
import {
  PluginContext,
  useCanvasNodeRect,
  useCanvasViewport,
  useEditorCommand,
  useEditorStore,
  usePluginContext,
  usePluginRoutes,
  usePluginSettings,
} from '@admin/plugin-host-hooks'

// Plugin SDK builder helpers — the runtime functions plugins call.
import {
  PLUGIN_API_VERSION,
  control,
  createNamespace,
  defineComponent,
  defineModule,
  definePack,
  definePlugin,
  definePluginAdminApp,
  definePluginCanvasOverlay,
  definePluginPanel,
  escapeHtml,
  h,
  html,
  permissions,
  raw,
  safeUrl,
  vc,
} from '@core/plugin-sdk'

declare global {
  var __pagebuilder: {
    React: typeof React
    ReactJsxRuntime: typeof ReactJsxRuntime
    ReactJsxDevRuntime: typeof ReactJsxDevRuntime
    ReactDOM: typeof ReactDOM
    hostUi: Record<string, unknown>
    hostHooks: Record<string, unknown>
    pluginSdk: Record<string, unknown>
  } | undefined
}

let installed = false

export function installPluginRuntime(): void {
  if (installed) {
    // Defensive single-React check — if the runtime was already installed
    // and the React module reference has somehow drifted, fail loudly. This
    // catches the worst class of plugin bug (a plugin author accidentally
    // bundled their own React) before it produces opaque hook crashes.
    const existing = globalThis.__pagebuilder
    if (existing && existing.React !== React) {
      throw new Error(
        '[@pagebuilder/runtime] Detected a second React instance during plugin runtime bootstrap. ' +
        `Host React: ${React.version}; existing React: ${existing.React.version}. ` +
        'Plugin authors must build with `pb-plugin build` so React is externalized.',
      )
    }
    return
  }
  installed = true

  const runtime = {
    React,
    ReactJsxRuntime,
    ReactJsxDevRuntime,
    ReactDOM,
    hostUi: Object.freeze({
      Alert,
      Bars,
      Button,
      Card,
      Checkbox,
      Code,
      Delta,
      EmptyState,
      Heading,
      Input,
      RangeTabs,
      SearchBar,
      Select,
      Separator,
      Sparkline,
      Stack,
      StackedBar,
      StatValue,
      Switch,
      Tab,
      TabList,
      TabPanel,
      Tabs,
      Text,
      Textarea,
      Widget,
      WidgetList,
      WidgetListRow,
    }),
    hostHooks: Object.freeze({
      PluginContext,
      useEditorStore,
      usePluginSettings,
      usePluginContext,
      usePluginRoutes,
      useEditorCommand,
      useCanvasNodeRect,
      useCanvasViewport,
    }),
    pluginSdk: Object.freeze({
      PLUGIN_API_VERSION,
      definePluginPanel,
      definePluginCanvasOverlay,
      definePluginAdminApp,
      definePlugin,
      defineModule,
      defineComponent,
      definePack,
      permissions,
      control,
      html,
      raw,
      escapeHtml,
      safeUrl,
      createNamespace,
      h,
      vc,
    }),
  }

  // Freeze the top-level so a plugin (or stray third-party script) cannot
  // overwrite `__pagebuilder.hostUi` etc. and substitute components.
  // The shim files in `public/runtime/*.js` rely on these references being
  // stable for the lifetime of the page.
  globalThis.__pagebuilder = Object.freeze(runtime)
}
