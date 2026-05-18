# Plugin Authoring

Plugins are TypeScript projects that ship as zip packages. The Plugin SDK lives in this repo at `src/core/plugin-sdk/` and is invoked via the **`pb-plugin` CLI**:

```bash
bun pb-plugin init my-plugin   # scaffold a new plugin
bun pb-plugin build             # produce dist/ + .plugin.zip
bun pb-plugin dev               # watch + sync into a running CMS
```

`pb-plugin dev` writes built files **directly** into the host's `uploads/plugins/<id>/<version>/` folder. The host's server module loader cache-busts each `import()` with `?v=Date.now()`, so server-side hooks pick up changes on the next request automatically. No login, no API tokens, no env-mode flag — the filesystem is the gate.

When running inside the page-builder monorepo the CLI auto-detects the host's `uploads/` directory by walking up the tree. When running from a separate plugin repo, point at it explicitly:

```bash
PB_UPLOADS_DIR=../page-builder/uploads bun pb-plugin dev
# or
bun pb-plugin dev --uploads ../page-builder/uploads
```

The first install still goes through the admin UI (`/admin/plugins` → Upload Plugin) so the user approves permissions. After that, every `pb-plugin dev` rebuild flows in without another upload.

## Package Shape

```text
plugin.json
server/index.js
admin/dashboard.js
editor/index.js
modules/index.js
frontend/tracker.js
pack/site.json
```

Create a package with:

```bash
cd examples/plugins/template
zip -qr ../template.plugin.zip .
```

Upload the resulting zip from the Plugins admin page.

## Manifest

`plugin.json` declares identity, permissions, resources, admin pages, and entrypoints:

```json
{
  "id": "acme.template",
  "name": "Template Plugin",
  "version": "1.0.0",
  "apiVersion": 1,
  "permissions": ["admin.navigation", "cms.storage", "cms.routes"],
  "entrypoints": {
    "server": "server/index.js",
    "editor": "editor/index.js",
    "modules": "modules/index.js",
    "frontend": "frontend/tracker.js"
  },
  "resources": [],
  "adminPages": [],
  "pack": { "path": "pack/site.json" }
}
```

Plugin IDs must be namespaced, such as `acme.workflow`. Versions must be semver-like, such as `1.0.0`.

`apiVersion: 1` is the only currently supported value.

### Entrypoints

| Field | Required permission | Loaded by | Use it for |
| --- | --- | --- | --- |
| `server` | `cms.routes` (and any others your routes touch) | Server boot | Lifecycle hooks, CMS routes, hooks, storage |
| `editor` | `editor.commands` / `editor.toolbar` etc. | Editor mount | Toolbar buttons, commands, store transactions |
| `admin` | `admin.navigation` | Admin app pages | Custom admin app rendered into a plugin admin page |
| `modules` | `modules.register` | Editor mount + server boot | Adding new modules to the canvas library |
| `frontend` | `frontend.scripts` (+ `frontend.tracker` if posting events) | Published pages | Analytics, custom widgets, A/B testing |

### Pack

If `pack.path` is set, the plugin can ship Visual Components, page templates, and CSS classes. The site owner triggers an "Install pack" action from the Plugins admin page; the host validates and merges into the active site.

```jsonc
// pack/site.json
{
  "visualComponents": [/* VisualComponent[] */],
  "pages": [/* Page[] */],
  "classes": [/* CSSClass[] */]
}
```

CSS class ids must be namespaced under the plugin id (`acme.template/hero-root`).

## Server Entrypoint

```js
export function install(api) {}
export function activate(api) {}
export function deactivate(api) {}
export function uninstall(api) {}
```

`activate(api)` is the right place to register routes, hooks, and loop sources.
Routes require `cms.routes`; loop sources require `loops.register`.

```js
export function activate(api) {
  api.cms.routes.get('/status', 'plugins.manage', () => ({ ok: true }))
  api.cms.hooks.on('publish.before', (e) => api.plugin.log('publish', e))
  api.cms.hooks.filter('publish.html', (html) => html.replace('</body>', '<!-- acme -->\n</body>'))
}
```

Routes mount under `/admin/api/cms/plugins/:pluginId/runtime/*`.

## Plugin Storage

Declare resources in the manifest, then use `cms.storage`:

```js
const items = api.cms.storage.collection('items')
await items.create({ title: 'Draft', status: 'pending' })
const records = await items.list()
```

## Admin Apps

Admin app pages use manifest content kind `app` and default-export a real React component. Plugin authors write JSX, import React directly, and pull design-system primitives from `@pagebuilder/host-ui`:

```tsx
// admin/dashboard.tsx
import { useState } from 'react'
import { Button, Card, Heading, Stack, Text } from '@pagebuilder/host-ui'
import { usePluginRoutes } from '@pagebuilder/host-hooks'
import { definePluginAdminApp } from '@pagebuilder/plugin-sdk'

function Dashboard() {
  const routes = usePluginRoutes()
  const [count, setCount] = useState(0)
  return (
    <Card>
      <Stack gap={12}>
        <Heading level={2}>Counter</Heading>
        <Text variant="muted">Total clicks: {count}</Text>
        <Button variant="primary" onClick={() => setCount(count + 1)}>
          Increment
        </Button>
      </Stack>
    </Card>
  )
}

export default definePluginAdminApp(Dashboard)
```

How this works under the hood:

- The plugin's bundle externalizes `react`, `react/jsx-runtime`, `@pagebuilder/host-ui`, `@pagebuilder/host-hooks`, and `@pagebuilder/plugin-sdk` — those names stay as bare imports in the output.
- The host's editor injects an **import map** (`<script type="importmap">` in `index.html`) at boot that resolves those bare names to small shim modules in `public/runtime/`.
- The shims re-export from `globalThis.__pagebuilder` — populated by `pluginRuntimeBootstrap.ts` with the editor's live React + design-system primitives.
- Result: plugins **share the host's React instance** (no duplicate-React crash), share the host's design-system primitives (visual consistency), and ship tiny bundles (no React vendor blob, no design-system blob).

You can `import` whatever React-compatible library you want — chart libraries, drag-and-drop, table grids — and they bundle into your plugin normally. Only the four bare names above are externalized.

### Available host packages

```ts
// React itself, plus the JSX runtime
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'

// The host's design-system primitives (the named React components)
import {
  Alert, Button, Card, Checkbox, Code, EmptyState, Heading,
  Input, SearchBar, Select, Separator, Stack, Switch, Text, Textarea,
} from '@pagebuilder/host-ui'

// Editor / settings / route helpers — real React hooks
import {
  useEditorStore,        // subscribe to the editor store (any selector)
  usePluginSettings,     // plugin's settings snapshot, typed
  usePluginContext,      // plugin id, version, surface name
  usePluginRoutes,       // .fetch(path) / .json(path, schema)
  useEditorCommand,      // run a registered command by id
} from '@pagebuilder/host-hooks'

// SDK builders
import {
  definePluginPanel,
  definePluginAdminApp,
  definePlugin,
  defineModule,
  defineComponent,
  definePack,
  permissions,
} from '@pagebuilder/plugin-sdk'
```

### What the plugin's component receives

Admin app components get a `page` prop:

```tsx
import type { PluginAdminAppProps } from '@pagebuilder/plugin-sdk'

function Dashboard({ page }: PluginAdminAppProps) {
  // page.pluginId, page.pluginSettings, page.title, ...
}
```

Editor panel components get a `panel` prop:

```tsx
import type { PluginEditorPanelProps } from '@pagebuilder/plugin-sdk'

function MyPanel({ panel }: PluginEditorPanelProps) {
  // panel.id, panel.pluginId, panel.label
}
```

### TypeScript setup

For first-party plugins inside this monorepo, drop a `tsconfig.json` next to `pb-plugin.config.ts` with path aliases pointing at the host's source — see `examples/plugins/showcase/tsconfig.json`. For external plugins (separate repos), copy the type declarations from the published `@pagebuilder/plugin-sdk` package once it ships; until then, vendoring the host's `*.d.ts` files works.

## Plugin Settings

Plugins declare configuration in `definePlugin({ settings })`. The host renders a Settings dialog automatically using the same `pluginAdminUi` primitives, so plugin authors don't ship a settings UI — they describe the schema:

```ts
import { definePlugin, permissions } from '@pagebuilder/plugin-sdk'

export default definePlugin({
  id: 'acme.analytics',
  name: 'Analytics',
  version: '1.0.0',
  permissions: [permissions.cmsHooks, permissions.cmsRoutes],
  settings: [
    {
      id: 'apiKey',
      label: 'API key',
      type: 'password',
      secret: true,
      description: 'Required for the upstream analytics service.',
    },
    {
      id: 'trackOutbound',
      label: 'Track outbound clicks',
      type: 'toggle',
      default: true,
    },
    {
      id: 'sampleRate',
      label: 'Sample rate',
      type: 'select',
      options: [
        { label: '100%', value: '100' },
        { label: '50%',  value: '50'  },
        { label: '10%',  value: '10'  },
      ],
      default: '100',
    },
  ],
  server: () => import('./server'),
})
```

Setting types:

| `type`     | Renders as                       | Value type |
| ---------- | -------------------------------- | ---------- |
| `text`     | text input                       | `string`   |
| `textarea` | multi-line input                 | `string`   |
| `number`   | numeric input (with min/max)     | `number`   |
| `toggle`   | switch                           | `boolean`  |
| `select`   | dropdown                         | `string`   |
| `color`    | text input (color string)        | `string`   |
| `url`      | url input                        | `string`   |
| `password` | masked input + secret-flag impl. | `string`   |

`secret: true` masks the value as `***` in the form re-render, strips it from frontend bundles, and tells the host to treat it carefully in audit logs.

### Reading settings

**Server (inside `activate()` / hook listeners):**

```ts
api.cms.settings.get<string>('apiKey')          // typed value
api.cms.settings.getAll()                        // full record
await api.cms.settings.replace({ trackOutbound: false }) // emits settings.changed
```

**Admin app (inside `definePluginAdminApp`):**

```ts
api.cms.settings.get('apiKey')
api.cms.settings.getAll()
await api.cms.settings.update({ sampleRate: '50' })
```

Reads are synchronous because the host snapshots settings into the admin context at render time. Updates round-trip through the host, then refresh the admin app's snapshot.

### Settings storage

Persisted per-plugin in `installed_plugins.settings_json`. On install, the host populates defaults declared in the schema. On a plugin update that adds a new setting, the host transparently fills in the default; on a setting removal, the host drops the orphan key.

### `settings.changed` event

Whenever an admin saves new values, the host emits `settings.changed` through the hook bus with `{ pluginId, settings }`. Plugin server hooks listening for this event can react in real time:

```ts
api.cms.hooks.on('settings.changed', (payload) => {
  if (payload.pluginId !== api.plugin.id) return
  api.plugin.log('settings updated', payload.settings)
})
```

## Editor Entrypoint

```js
export function activate(api) {
  api.editor.commands.register({
    id: 'plugin.action',
    label: 'Run Action',
    run: () => ({ message: 'Action complete' }),
  })

  api.editor.toolbar.addButton({
    id: 'plugin.action',
    label: 'Action',
    command: 'plugin.action',
  })
}
```

## Spotlight Commands (`editor.commands`)

The **Command Spotlight** (⌘K / Ctrl+K) surfaces plugin commands without any extra work and lets you register live-search providers for rich palette experiences.

### 1. Basic command (auto-surfaced)

Every command you register with `api.editor.commands.register` automatically appears in the palette under **"Plugin commands"** when the query matches. No extra code required — the basic shape is enough:

```js
api.editor.commands.register({
  id: 'acme.workflow.sync',
  label: 'Sync workflow',
  run: () => ({ message: 'Sync complete' }),
})
```

### 2. Richer palette command

Use `api.editor.palette.registerCommand` when you want to provide the palette with additional display hints. Functionally equivalent to `commands.register` — both store into the same runtime registry:

```js
api.editor.palette.registerCommand({
  id: 'acme.workflow.archive',
  label: 'Archive current page…',
  subtitle: 'Move the active page to the archive folder',
  iconName: 'archive-box',          // pixel-art-icon name
  keywords: ['archive', 'remove', 'move'],
  destructive: true,                // palette renders danger styling + confirm
  workspaces: ['site'],             // only shown in the site editor
  args: [
    {
      id: 'reason',
      label: 'Reason',
      type: 'text',
      placeholder: 'Why are you archiving this page?',
    },
    {
      id: 'notify',
      label: 'Notify team',
      type: 'select',
      options: [
        { value: 'yes', label: 'Yes — send a notification' },
        { value: 'no',  label: 'No'                        },
      ],
    },
  ],
  run: () => { /* perform the archive operation */ },
})
```

Available `workspaces` values: `'site'`, `'content'`, `'data'`, `'media'`, `'plugins'`, `'users'`, `'account'`, `'any'` (default — always visible).

Both `commands.register` and `palette.registerCommand` require the `editor.commands` permission.

### 3. Live-search provider

Register a provider to supply **dynamic results** on each debounced keystroke. Results appear as a group in the palette under your provider's `label`:

```js
api.editor.palette.registerProvider({
  // id MUST start with "<pluginId>." — namespaced to avoid collisions
  id: 'acme.workflow.tasks',
  label: 'Tasks',    // group header shown in the palette

  // Called with the current query string; return up to ~25 PluginPaletteResult items.
  // Errors are caught — a failing provider surfaces as an empty group, not a crash.
  search: async (query) => {
    const res = await fetch(
      '/admin/api/cms/plugins/acme.workflow/runtime/tasks?q=' + encodeURIComponent(query),
      { credentials: 'include' },
    )
    if (!res.ok) throw new Error('Task search failed: ' + res.status)
    const { tasks } = await res.json()

    return tasks.map((task) => ({
      id:       task.id,
      title:    task.title,
      subtitle: task.status,
      iconName: 'checkbox-square',
      run: async () => {
        // Open the task detail page, or run an action…
        window.location.href = '/admin/plugins/acme.workflow/tasks/' + task.id
      },
    }))
  },
})
```

**Rate-limiting**: the palette enforces one in-flight call per provider at a time. A new query cancels any pending debounce; results arriving after the palette is closed are discarded automatically.

### End-to-end example

```js
// editor/index.js
export function activate(api) {

  // 1. Simple command — auto-appears in palette, also wired to toolbar.
  api.editor.commands.register({
    id: 'acme.crm.refresh',
    label: 'Refresh CRM data',
    run: async () => {
      await fetch('/admin/api/cms/plugins/acme.crm/runtime/refresh', {
        method: 'POST', credentials: 'include',
      })
      return { message: 'CRM data refreshed' }
    },
  })

  api.editor.toolbar.addButton({
    id: 'acme.crm.refresh',
    label: 'Refresh CRM',
    command: 'acme.crm.refresh',
  })

  // 2. Palette-specific command with args.
  api.editor.palette.registerCommand({
    id: 'acme.crm.createContact',
    label: 'Create CRM contact…',
    subtitle: 'Add a new contact from the current page content',
    iconName: 'person-plus',
    args: [
      { id: 'name',  label: 'Name',  type: 'text'   },
      { id: 'email', label: 'Email', type: 'text', placeholder: 'user@example.com' },
    ],
    run: () => { /* args are collected by palette before run() fires */ },
  })

  // 3. Live-search provider: search contacts from the CRM backend.
  api.editor.palette.registerProvider({
    id: 'acme.crm.contacts',
    label: 'CRM contacts',
    search: async (query) => {
      const res = await fetch(
        '/admin/api/cms/plugins/acme.crm/runtime/contacts?q=' + encodeURIComponent(query),
        { credentials: 'include' },
      )
      const { contacts } = await res.json()
      return contacts.map((c) => ({
        id:       c.id,
        title:    c.name,
        subtitle: c.email,
        iconName: 'person',
        run: async () => {
          window.open('/admin/plugins/acme.crm/contacts/' + c.id)
        },
      }))
    },
  })
}
```

This requires the following in `plugin.json`:

```json
{
  "permissions": ["editor.commands", "editor.toolbar", "cms.routes"]
}
```

## Editor Panels (`editor.panels`)

Plugins can register panels that mount in the editor's **left sidebar**. The user opens them from the rail just like the built-in panels (Layers, Site, Selectors, etc.). Plugins write a real React component — same React + host-ui imports as admin apps.

**The host owns the panel chrome.** Title, close button, and the surrounding panel surface are rendered by the host using the same `PanelHeader` / docked-panel layout as every built-in panel. Your component renders only the **body content**. Don't add your own heading or close button — they'd duplicate the host's chrome.

```tsx
// editor/index.tsx
import { useState } from 'react'
import { Button, Card, Stack, Text } from '@pagebuilder/host-ui'
import { useEditorCommand, usePluginRoutes } from '@pagebuilder/host-hooks'
import {
  definePluginPanel,
  type EditorPluginApi,
  type EditorPluginModule,
} from '@pagebuilder/plugin-sdk'

function ReviewPanel() {
  const routes = usePluginRoutes()
  const runCommand = useEditorCommand()
  const [pending, setPending] = useState<number>(0)

  return (
    <Stack gap={12}>
      <Text variant="muted">{pending} item{pending === 1 ? '' : 's'} waiting</Text>
      <Card>
        <Button
          variant="primary"
          onClick={async () => {
            await runCommand('acme.workflow.refresh')
            const res = await routes.fetch('queue')
            const body = await res.json() as { pending: number }
            setPending(body.pending)
          }}
        >
          Refresh
        </Button>
      </Card>
    </Stack>
  )
}

const reviewPanel = definePluginPanel({
  id: 'acme.workflow.review',     // MUST start with `<pluginId>.`
  label: 'Review queue',
  iconName: 'box-stack',          // see "Available icons" below
  accent: 'mint',                 // optional: 'mint' | 'lilac' | 'sky' | 'peach'
  shortcutLabel: 'Ctrl+Shift+W',  // optional tooltip hint
  component: ReviewPanel,
})

const mod: EditorPluginModule = {
  activate(api: EditorPluginApi) {
    api.editor.panels.register(reviewPanel)
  },
}
export default mod
```

The `useEditorStore` hook lets the panel react to editor state — selection, active page, breakpoint, anything the editor store carries. Only mutating actions are gated by permissions (`editor.store.write` for `useEditorStore.setState` calls, `cms.storage` for plugin-owned record helpers).

### Available icons

Plugins pick from a curated set of icon names imported by the host:

```text
box, box-stack, circle-alert, ai-settings-solid, bulletlist-2-sharp,
colors-swatch, files-stack-2, images, paint-bucket, ruler-dimension,
text-start-t
```

Unknown names render with a generic box icon — request an icon by opening an issue and we'll add the import.

## Canvas Overlays (`editor.canvas`)

Plugins can paint React components on top of the editor canvas — annotation pins, selection adornments, measurement tools, contrast warnings, comment markers. The overlay layer sits above the rendered canvas, fills the canvas viewport, and ignores pointer events by default (children opt in via `pointer-events: auto`).

```tsx
// editor/index.tsx
import {
  definePluginCanvasOverlay,
  type EditorPluginApi,
  type EditorPluginModule,
} from '@pagebuilder/plugin-sdk'
import { useCanvasNodeRect, useEditorStore } from '@pagebuilder/host-hooks'

function SelectedNodePin() {
  const selectedId = useEditorStore((s) => s.selectedNodeId)
  const rect = useCanvasNodeRect(selectedId)
  if (!rect) return null
  return (
    <div
      style={{
        position: 'absolute',
        top: rect.top - 22,
        left: rect.left + rect.width / 2 - 6,
        width: 12,
        height: 12,
        borderRadius: 999,
        background: '#8ee6c8',
      }}
      aria-hidden="true"
    />
  )
}

const overlay = definePluginCanvasOverlay({
  id: 'acme.review.pin',     // MUST start with `<pluginId>.`
  component: SelectedNodePin,
})

const mod: EditorPluginModule = {
  activate(api: EditorPluginApi) {
    api.editor.canvas.registerOverlay(overlay)
  },
}
export default mod
```

Geometry hooks from `@pagebuilder/host-hooks`:

- **`useCanvasNodeRect(nodeId)`** — returns `{ top, left, width, height }` in coordinates relative to the overlay layer. Updates on layout / resize / pan / zoom. Returns `null` if the node isn't rendered or `nodeId` is `null`.
- **`useCanvasViewport()`** — returns `{ width, height }` of the visible canvas area. Useful for floating overlays in a fixed corner.

The overlay layer:

- Renders only in **design mode** (preview-mode canvases never load plugin overlays — published-page output stays plugin-free).
- Wraps each registered overlay in its own ErrorBoundary, so a render-time crash in one plugin's overlay leaves the canvas + other plugins running.
- Uses `pointer-events: none` by default. Plugin children that want to be clickable add `pointer-events: 'auto'` to their own elements.
- Lives **outside** the transform layer in screen coordinates. `useCanvasNodeRect` already maps node positions through any pan/zoom transform — overlays "follow" the node visually.

## Canvas Modules (`modules.register`)

`modules/index.js` default-exports an array of plugin module definitions. The host wraps each into a host `ModuleDefinition` and registers it with the canvas registry. Module ids must start with `<pluginId>.`.

```js
export default ({ pluginId }) => [
  {
    id: `${pluginId}.callout`,
    name: 'Callout',
    category: 'Acme',
    version: '1.0.0',
    canHaveChildren: false,
    defaults: { heading: 'Heads up', body: '...', tone: 'info' },
    schema: {
      heading: { type: 'text', label: 'Heading' },
      body: { type: 'textarea', label: 'Body', rows: 4 },
      tone: { type: 'select', label: 'Tone', options: [
        { label: 'Info', value: 'info' },
      ] },
    },
    htmlTag: 'aside',
    render: (props) => ({
      html: `<aside class="cb">${props.heading}\n${props.body}</aside>`,
      css: `.cb{padding:14px 18px;}`,
    }),
  },
]
```

Same `render(props, children)` runs on the publisher (server) and inside the editor canvas preview, so the markup you ship is exactly what visitors see.

## Frontend Tracker (`frontend.scripts` + `frontend.tracker`)

> **Important — frontend scripts are NOT a React surface.** Published pages don't load the editor, the host's React, or the import map. A `frontend.scripts` bundle that imports `react` or `@pagebuilder/host-ui` will crash the visitor's browser at runtime. Use vanilla JS, the DOM API, and `window.__pb` for analytics or widget code. If you genuinely need a frontend React widget, bundle React yourself — but most use cases (analytics, click tracking, A/B testing) don't need it. `pb-plugin build` enforces this by NOT externalizing host packages for frontend bundles, so a stray `import` becomes a build-time bundling cost (your React copy ships per visitor) rather than a runtime resolution failure.

The host injects a tiny tracker runtime into every published page when any installed plugin has `frontend.scripts` or `frontend.tracker` granted. The runtime exposes `window.__pb`:

```ts
window.__pb.visitorId    // stable per-browser id
window.__pb.sessionId    // stable per-session id
window.__pb.tracker.send(name, payload)              // implicit pluginId
window.__pb.tracker.sendFor(pluginId, name, payload) // explicit
window.__pb.hooks.on(name, listener)                 // page-view, link-click, scroll-depth, ...
window.__pb.hooks.emit(name, detail)
```

Server-side, plugins listen with `api.cms.hooks.on('tracker.event', ...)` and persist into their own resource via `api.cms.storage.collection(...)`.

```js
// frontend/tracker.js
window.__pb.hooks.on('page-view', (detail) => {
  window.__pb.tracker.sendFor('acme.showcase', 'page-view', detail)
})
```

## Loop Sources (`loops.register`)

```js
export function activate(api) {
  api.cms.loops.registerSource({
    id: 'acme.products',
    label: 'Acme Products',
    filterSchema: {},
    orderByOptions: [{ id: 'name', label: 'Name' }],
    fields: [
      { id: 'title', label: 'Title' },
      { id: 'price', label: 'Price' },
    ],
    fetch: async (ctx) => ({ items: [], totalItems: 0 }),
    preview: () => [{ id: 'sample', fields: { title: 'Sample', price: '$10' } }],
  })
}
```

## Hooks Reference

Built-in events:

| Event | Payload |
| --- | --- |
| `publish.before` | `{ siteId, pageId? }` |
| `publish.after` | `{ siteId, pageId? }` |
| `tracker.event` | `{ pluginId, eventName, payload, visitorId, sessionId, pagePath, referrer, receivedAt }` |
| `content.entry.created/updated/deleted` | `{ collectionId, entryId }` |

Built-in filters:

| Filter | Type |
| --- | --- |
| `publish.html` | `string` (full HTML before sending to browser) |
| `publish.headers` | `Record<string, string>` |

Plugins can `emit` and `on` any event. If you publish a documented event under your namespace, prefix it with `plugin.<your-id>.`.

## Type Declarations

Until the SDK is published, copy:

```text
examples/plugins/plugin-sdk.d.ts
```

The starter package and end-to-end showcase live at:

```text
examples/plugins/template/
examples/plugins/showcase/
```
