# Plugin Authoring

Plugins are TypeScript projects that ship as zip packages. The Plugin SDK lives in this repo at `src/core/plugin-sdk/` and is invoked via the **`pb-plugin` CLI**:

```bash
bun pb-plugin init my-plugin   # scaffold a new plugin
bun pb-plugin lint              # validate manifest + sources + bundles
bun pb-plugin build             # produce dist/ + .plugin.zip
bun pb-plugin dev               # watch + sync into a running CMS
```

> 🩺 **`pb-plugin lint`** runs the same sandbox scan, manifest validator, and permission/allowlist coherence checks the host applies at install time — but in your terminal, before you upload. Run it whenever you change a manifest, a permissions list, or anything that touches `network.outbound`.

> 🔒 **Plugin code runs inside a QuickJS-WASM sandbox.** Your server entrypoint and canvas modules have no access to Node, Bun, the file system, environment variables, or the network — anything beyond pure JavaScript goes through the SDK. `pb-plugin build` catches sandbox-incompatible code (`import 'node:fs'`, `Bun.spawn`, `process.env`, etc.) and fails the build with a clear error. **Read [sandbox.md](./sandbox.md) before authoring anything that touches the network or expects host APIs.**

`pb-plugin dev` writes built files **directly** into the host's `uploads/plugins/<id>/<version>/` folder. Server entrypoints are loaded into the sandbox via the host's plugin worker; subsequent rebuilds are picked up on the next plugin re-activation cycle.

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
    "modules": "modules/index.js"
  },
  "frontend": {
    "assets": [
      { "kind": "script", "src": "frontend/tracker.js", "placement": "body-end", "strategy": "defer" }
    ]
  },
  "resources": [],
  "adminPages": [],
  "pack": { "path": "pack/site.json" }
}
```

Plugin IDs must be namespaced, such as `acme.workflow`. Versions must be semver-like, such as `1.0.0`.

`apiVersion: 1` is the only currently supported value.

### Manifest IDs

IDs in `plugin.json` follow two different rules depending on their role:

**Resource IDs and admin page IDs** become URL path segments. They must be lowercase kebab-case:
- `subscribers`, `seo-entries`, `contact-forms` ✓
- `Subscribers`, `seoEntries`, `My Posts` ✗ (uppercase, camelCase, spaces)

**Resource field IDs** are JSON object keys only — not URL segments. They accept any common JavaScript identifier convention (camelCase, snake_case, kebab-case):
- `email`, `subscribedAt`, `page_id`, `first-name` ✓
- `My Field`, `123bad`, `has space` ✗ (spaces, leading digit, spaces)

The manifest validator produces a clear error message if you violate either rule. When in doubt, run `bun pb-plugin lint` before uploading.

### Entrypoints

| Field | Required permission | Loaded by | Use it for |
| --- | --- | --- | --- |
| `server` | `cms.routes` (and any others your routes touch) | Server boot | Lifecycle hooks, CMS routes, hooks, storage |
| `editor` | `editor.commands` / `editor.toolbar` etc. | Editor mount | Toolbar buttons, commands, store transactions |
| `admin` | `admin.navigation` | Admin app pages | Custom admin app rendered into a plugin admin page |
| `modules` | `modules.register` | Editor mount + server boot | Adding new modules to the canvas library |
| `frontend/*.ts` | `frontend.assets` | Published pages | Analytics trackers, custom widgets, A/B testing, polyfills |

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

Runs inside a [QuickJS-WASM sandbox](sandbox.md). The SDK is the only way to reach host resources.

```js
export function install(api)    {} // first install only
export function activate(api)   {} // every time the plugin enters `active`
export function deactivate(api) {} // when the plugin is disabled
export function uninstall(api)  {} // before the package is removed
export function migrate(ctx, api) {} // optional — runs between old.deactivate and new.activate on upgrade
```

`activate(api)` is the right place to register routes, hooks, and loop sources.
Routes require `cms.routes`; hooks require `cms.hooks`; loop sources require `loops.register`.

```js
export function activate(api) {
  api.cms.routes.get('/status', 'plugins.manage', () => ({ ok: true }))
  api.cms.hooks.on('publish.before', (e) => api.plugin.log('publish', e))
  api.cms.hooks.filter('publish.html', (html) => html.replace('</body>', '<!-- acme -->\n</body>'))
}
```

Routes mount under `/admin/api/cms/plugins/:pluginId/runtime/*`.

### Custom responses (status, headers, body)

By default, returning any JSON-serializable value from a route handler sends it as `application/json` with status 200. To control the status code, headers, or emit a non-JSON body (CSV, plain text, HTML, …), return the **raw-response escape hatch**:

```ts
export function activate(api) {
  api.cms.routes.get('/export.csv', 'plugins.manage', async (ctx) => {
    const url = new URL(ctx.req.url)
    const format = url.searchParams.get('format') ?? 'csv'

    const { records } = await api.cms.storage.collection('events').list()
    const csv = records.map(r => [r.id, r.data.name].join(',')).join('\r\n')

    return {
      __response: true,
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="events-${format}.csv"`,
      },
      body: csv,   // body must be a string
    }
  })
}
```

The `__response` shape is:

| Field | Type | Description |
| --- | --- | --- |
| `__response` | `true` | Sentinel that opts out of automatic JSON serialization. |
| `status` | `number` | HTTP status code (e.g. `200`, `404`, `403`). |
| `headers` | `Record<string, string>` | Response headers to send. |
| `body` | `string` | Raw response body as a string. |

Returning `undefined` is equivalent to returning `{ ok: true }` (JSON 200).

### Outbound HTTP

`fetch()` is available when the plugin has the `network.outbound` permission AND the URL's host is in the manifest's `networkAllowedHosts` allowlist:

```json
{
  "permissions": ["network.outbound"],
  "networkAllowedHosts": ["api.example.com", "*.cdn.example.com"]
}
```

```js
export async function activate(api) {
  const res = await fetch('https://api.example.com/today')
  const data = await res.json()
  api.plugin.log('fetched', data)
}
```

See [sandbox.md](sandbox.md#network-access) for allowlist semantics and the `fetch` polyfill's surface.

## Plugin Storage

Declare resources in the manifest, then use `cms.storage`. `list()` always returns an envelope `{ records, totalCount }` — destructure before accessing the array:

```ts
const items = api.cms.storage.collection('items')
await items.create({ title: 'Draft', status: 'pending' })

// Bare list — simple case
const { records } = await items.list()

// With filter, pagination, and sorting
const { records, totalCount } = await api.cms.storage.collection('subscribers').list({
  filter: {
    status: 'active',                        // shorthand: equals
    createdAt: { gte: '2026-01-01' },        // ISO 8601 — strings compare lexicographically
    email: { like: '%@example.com' },        // case-insensitive LIKE
  },
  orderBy: { createdAt: 'desc' },
  limit: 25,
  offset: 0,
})
```

**Filter operators:** `eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `in` / `like`. A bare value (string, number, boolean, null) is shorthand for `eq`.

**`like`** is case-insensitive and uses SQL `LIKE` semantics (`%` = any characters, `_` = single character).

**Field names** must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/` — use camelCase or snake_case identifiers. Kebab-case (`form-id`) is not valid in `filter` / `orderBy`; use `formId` instead.

**`limit`** defaults to 100, maximum 1000. **`offset`** defaults to 0.

**`totalCount`** is the full count of matching records before pagination — useful for building paginated UIs.

**Filter is AND-only.** There is no OR combinator across fields. If you need OR across two fields, run two queries.

> **Note:** the `storage-list-envelope` architecture gate enforces the destructure pattern and will fail the build if you chain array methods directly on the `.list()` return value.

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
  // Tab compound component (ARIA-correct, keyboard-navigable)
  Tabs, TabList, Tab, TabPanel,
  // Data-visualisation + widget primitives
  Sparkline, Bars, StackedBar, StatValue, Delta, RangeTabs,
  Widget, WidgetList, WidgetListRow,
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

### Tabs

Use the `Tabs` compound component whenever your admin app needs tabbed navigation. It is ARIA-correct (`tablist` / `tab` / `tabpanel` roles), keyboard-navigable (ArrowLeft / ArrowRight / Home / End with automatic activation), and generic over the value type.

```tsx
import { useState } from 'react'
import { Tabs, TabList, Tab, TabPanel } from '@pagebuilder/host-ui'

function Dashboard() {
  const [active, setActive] = useState<'subscribers' | 'lists'>('subscribers')
  return (
    <Tabs<'subscribers' | 'lists'> value={active} onChange={setActive}>
      <TabList ariaLabel="Newsletter sections">
        <Tab value="subscribers">Subscribers</Tab>
        <Tab value="lists">Lists</Tab>
      </TabList>
      <TabPanel value="subscribers"><SubscribersTable /></TabPanel>
      <TabPanel value="lists"><ListsTable /></TabPanel>
    </Tabs>
  )
}
```

- **ARIA:** renders `role="tablist"` on `TabList`, `role="tab"` on each `Tab`, and `role="tabpanel"` on each `TabPanel` — correct labelling out of the box.
- **Keyboard:** arrow keys move focus and change the active tab simultaneously (automatic activation). Home / End jump to first / last tab.
- **Generic value type:** the `TValue extends string` type parameter propagates through `Tabs → Tab → TabPanel`, so TypeScript catches mismatched `value` props at compile time.
- **Style:** underline-indicator. Use `RangeTabs` for compact inline widget-header toggles (pill / segmented-control style).

Do **not** roll your own `role="tablist"` div — it will fail the `no-plugin-tab-shells` architecture gate.

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

## Frontend Assets (`frontend.assets`)

> **Important — frontend scripts are NOT a React surface.** Published pages don't load the editor, the host's React, or the import map. A frontend bundle that imports `react` or `@pagebuilder/host-ui` will crash the visitor's browser at runtime. Use vanilla JS and the DOM API. If you genuinely need a frontend React widget, bundle React yourself — but most use cases (analytics, click tracking, A/B testing) don't need it. `pb-plugin build` enforces this by NOT externalizing host packages for frontend bundles, so a stray `import` becomes a build-time bundling cost (your React copy ships per visitor) rather than a runtime resolution failure.

Plugins declare frontend assets in their `pb-plugin.config.ts`. The host splices them into every published page at four placement anchors (`head`, `head-end`, `body-start`, `body-end`), rewrites the CSP based on what the plan needs, and runs the `publish.html` filter — but ships **no tag content of its own**. The host is purely substrate. Plugins that want shared frontend state (`window.__pb_analytics`, `window.__pb_chat`, …) ship the IIFE that installs it as one of their own assets.

```ts
// pb-plugin.config.ts
export default definePlugin({
  // …
  permissions: [permissions.frontendAssets, permissions.cmsRoutes /* for ingestion */],
  frontend: {
    assets: [
      // External JS file shipped under `frontend/tracker.{ts,tsx}` and
      // bundled to `dist/frontend/tracker.js` by `pb-plugin build`.
      { kind: 'script', src: 'frontend/tracker.js', placement: 'body-end', strategy: 'defer' },

      // Inline <script> — short bootstrap snippets that can't wait for fetch.
      { kind: 'script-inline', content: `console.log('booted')`, placement: 'body-end' },

      // External CSS.
      { kind: 'style', href: 'frontend/widget.css', placement: 'head-end' },

      // Inline <style>.
      { kind: 'style-inline', content: `.foo { color: red }`, placement: 'head-end' },

      // <link> — preconnect, dns-prefetch, preload, alternate, etc.
      { kind: 'link', attrs: { rel: 'preconnect', href: 'https://cdn.example.com' } },

      // <meta>.
      { kind: 'meta', attrs: { name: 'theme-color', content: '#000000' } },
    ],
  },
})
```

`script` and `style` `src`/`href` paths are resolved against the plugin's `assetBasePath`. The build CLI auto-discovers every `.ts`/`.tsx` file directly under `frontend/` and bundles it to `dist/frontend/<name>.js` — reference the built `.js` path from your manifest.

### Ingesting events from the frontend

The host has no built-in tracker channel. To receive events from your frontend bundle, register a public route on the server side and POST to it directly:

```ts
// server/index.ts
api.cms.routes.postPublic('/ingest', async (ctx) => {
  const body = ctx.body as Record<string, unknown>
  await api.cms.storage.collection('events').create({
    name: String(body.eventName ?? ''),
    payload: JSON.stringify(body.payload ?? {}),
    'received-at': new Date().toISOString(),
  })
  return { ok: true }
})
```

```ts
// frontend/tracker.ts
const PLUGIN_ID = 'acme.analytics'
const ROUTE = `/admin/api/cms/plugins/${PLUGIN_ID}/runtime/ingest`

fetch(ROUTE, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  keepalive: true,
  body: JSON.stringify({ eventName: 'page-view', payload: { path: location.pathname } }),
}).catch(() => { /* fire-and-forget */ })
```

Plugins that want cross-plugin coordination can additionally emit on the hook bus (`api.cms.hooks.emit('acme.analytics.page-view', payload)`) and other plugins listen with `api.cms.hooks.on('acme.analytics.page-view', ...)`.

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
| `content.entry.created/updated/deleted` | `{ collectionId, entryId }` |

Built-in filters:

| Filter | Type | Context |
| --- | --- | --- |
| `publish.html` | `string` (full HTML before sending to browser) | `{ siteId, pageId, slug }` |
| `publish.headers` | `Record<string, string>` | `{ siteId, pageId, slug }` |

Filter handlers receive the current value as the first argument and a context object as the second. The context always includes `pluginId`; named filters like `publish.html` add extra fields:

```js
api.cms.hooks.filter('publish.html', (html, { siteId, pageId, slug }) => {
  return html.replace('</body>', `<!-- page:${slug} siteId:${siteId} -->\n</body>`)
})
```

Plugins can `emit` and `on` any event. If you publish a documented event under your namespace, prefix it with `plugin.<your-id>.`.

## Page Enumeration and Republish (`cms.pages.*`)

Plugins can list published pages and trigger a republish via `api.cms.pages`. This is useful when a plugin's filter or hook needs to be applied to pages that were already published before the plugin was activated.

### Listing pages

Requires `cms.pages.read`:

```js
export async function activate(api) {
  const pages = await api.cms.pages.list()
  // pages: [{ id, slug, title, lastPublishedAt }]
  for (const page of pages) {
    api.plugin.log(`Page: ${page.slug} (published: ${page.lastPublishedAt})`)
  }
}
```

### Republishing a single page

Requires `cms.pages.publish`. Re-runs the full publish pipeline (publish.before → publish.html filter → publish.after) for the page:

```js
export async function activate(api) {
  // Re-apply this plugin's publish.html filter to an existing page
  await api.cms.pages.republish('some-page-id')
}
```

Throws if the page is not currently published.

### Republishing all pages

Requires `cms.pages.publish`. Iterates all published pages and runs the pipeline for each. Returns the total count:

```js
export async function activate(api) {
  const { count } = await api.cms.pages.republishAll()
  api.plugin.log(`Republished ${count} pages`)
}
```

## Type Declarations

The SDK types ship inline with the repo at `src/core/plugin-sdk/`. When developing a plugin inside the monorepo, `pb-plugin.config.ts` imports `definePlugin` directly from there:

```ts
import { definePlugin } from '@pagebuilder/plugin-sdk'
```

The starter package and end-to-end showcase live at:

```text
examples/plugins/template/
examples/plugins/showcase/
examples/plugins/ui-kit/
```
