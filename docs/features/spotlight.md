# Spotlight (Cmd+K Palette)

The Spotlight command palette — Cmd+K from anywhere in the admin opens a fuzzy-matched action / search interface. It owns the editor's keyboard surface: every Spotlight-registered command works exactly the same way as a built-in command.

Spotlight is mounted by `<SpotlightRoot>` inside `AuthenticatedAdmin` (post-login chunk), so it's available across every workspace and across plugin admin pages.

---

## TL;DR

- Mount point: `<SpotlightRoot>` in `AuthenticatedAdmin.tsx`. Wraps the whole post-login app.
- Trigger: ⌘K / Ctrl+K (global keydown). Esc closes (or clears query if non-empty).
- Built-in commands: `src/admin/spotlight/builtinCommands.ts`. Returns the static `Command[]`.
- Async providers: `src/admin/spotlight/providers/*.ts` (pages, media, content, data, plugin pages, site files). Run in parallel as the query changes.
- Plugin commands: register via the SDK at activation. Same shape as built-ins.
- State: `useReducer` in `SpotlightRoot`. Recent commands persisted in `localStorage` via `recentStore`.
- Scopes: a scope narrows the palette to a single domain (e.g. "Find page", "Run command on selected node").
- Lazy: the heavy `<Spotlight>` chunk is `React.lazy` — only downloads on first open.

---

## Where the code lives

```text
src/admin/spotlight/
├── SpotlightRoot.tsx              — context + ⌘K listener + state reducer
├── Spotlight.tsx                  — the dialog (lazy-loaded)
├── Spotlight.module.css           — palette chrome (panel surface + blur)
├── SpotlightRow.tsx               — single result row
├── SpotlightResults.tsx           — grouped result list
├── SpotlightFooter.tsx            — keyboard hints / status
├── SpotlightSkeleton.tsx          — loading state shimmer
├── builtinCommands.ts             — built-in commands registry
├── commandRegistry.ts             — getScope, filterCommands, getPluginPaletteSpotlightProviders
├── providerRunner.ts              — async provider scheduler (cache + abort)
├── providers/                     — per-domain providers
│   ├── serverProvider.ts          — shared factory for server-backed providers
│   ├── schemas.ts                 — TypeBox response schemas (one per endpoint)
│   ├── pagesProvider.ts           — page search (local, reads editor store)
│   ├── siteFilesProvider.ts       — site file search (local, reads editor store)
│   ├── mediaProvider.ts           — media search (server)
│   ├── contentProvider.ts         — data row search (server)
│   ├── dataProvider.ts            — data table search (server)
│   └── pluginPagesProvider.ts     — plugin admin page search (server)
├── __tests__/
│   └── serverProvider.test.ts     — unit tests for the shared server provider factory
├── commands/                      — command implementations grouped by domain
├── scopes/                        — scope definitions (find page, find component, ...)
├── matcher.ts                     — fuzzy match scoring
├── recentStore.ts                 — localStorage-backed recently-used
├── keybindings.ts                 — declarative keybinding registry
├── state.ts                       — reducer state types
├── stateHandlers.ts               — reducer action handlers
├── spotlightContext.ts            — React context (separated for fast-refresh)
├── spotlightControls.ts           — programmatic controls (open / close / set query)
├── spotlightSearch.ts             — search query parsing (scope:, action: prefixes)
├── telemetry.ts                   — usage logging
├── groupAccent.ts                 — maps CommandGroup → categorical rail-tint accent
├── HelpKeybindingsList.tsx        — Cmd+? help screen
├── pendingAction.ts               — confirm-destructive flow
├── types.ts                       — Command, SpotlightProvider, Scope, CommandContext
└── index.ts                       — barrel
```

---

## The `Command` shape

```ts
interface Command {
  id:             CommandId          // 'editor.publish', 'site.add-page'
  title:          string             // "Publish site" — primary row label
  subtitle?:      string             // shown under the label
  group:          CommandGroup       // 'editor' | 'site' | 'content' | 'media' | 'pages' | …

  iconName?:      string             // pixel-art-icons name, e.g. 'save-solid'
  keywords?:      string[]           // extra search terms (low weight)

  /** Capability gate — palette filters before display. */
  capability?:    string | readonly string[]
  /** Workspace gate — only show on these workspaces. 'any' = always. */
  workspaces?:    ReadonlyArray<AdminWorkspace | 'any'>
  /** Predicate run at query time — finer-grained gating. */
  when?:          (ctx: CommandContext) => boolean
  /** Boosts ranking when `when` returns true. Default 1.0. */
  priorityBoost?: number

  /** Argument prompts — multi-step input flow. */
  args?:          CommandArg[]

  /** Dangerous commands show danger styling + inline confirm. */
  destructive?:   boolean
  /** If true, palette stays open after run. */
  keepOpenAfterRun?: boolean

  /**
   * The execution function. May return `{ pushScope }` to start a scoped sub-flow.
   * Shortcut hints are NOT stored here — they live in `keybindings.ts`.
   */
  run: (ctx: CommandRunContext) => void | Promise<void> | { pushScope: string }
}
```

A `Command` knows everything about itself: where it's visible, what arguments it needs, whether it's destructive. The palette is purely a UI for the registry.

---

## The `CommandContext`

Two related types flow through Spotlight:

```ts
/** Snapshot built once per palette open. Passed to search / when predicates. */
interface CommandContext {
  workspace: AdminWorkspace
  pathname:  string
  user:      CmsCurrentUser
  /** Populated by SpotlightRoot when the site editor is the active workspace. */
  editor?: {
    selectedNodeIds:       ReadonlyArray<string>
    activePageId:          string | null
    activeDocument:        ActiveDocument | null
    canUndo:               boolean
    canRedo:               boolean
    activeBreakpointId:    string
  }
}

/** Extended context injected into command.run(). Adds action callbacks. */
interface CommandRunContext extends CommandContext {
  args:          Record<string, string>  // collected sub-command arguments
  navigate:      (path: string) => void
  closeSpotlight:() => void
  pushScope:     (scopeId: string, args?: Record<string, string>) => void
  popScope:      () => void
  /** Wraps an action in the step-up re-auth flow. */
  runStepUp:     <T>(action: () => Promise<T>) => Promise<T>
}
```

Built by `SpotlightRoot` on every open. Inside the editor (`workspace === 'site'`), `SpotlightRoot` subscribes to the editor store via `subscribeWithSelector` to track the active page / selected node / mode.

The subscription is **dropped on close** to avoid spurious re-renders.

---

## Built-in commands

`src/admin/spotlight/builtinCommands.ts` exports the static command set. Common groups:

| Group              | Examples                                                             |
|--------------------|----------------------------------------------------------------------|
| `editor`           | Publish, Save, Undo, Redo, Wrap in container, Toggle preview         |
| `pages`            | Add page, Open page settings                                         |
| `content`          | New post, Edit post                                                  |
| `navigation`       | Go to dashboard, Go to site, Go to media, Go to plugins, …           |
| `settings`         | Open framework scale, Open site settings                             |

Each command's `when(ctx)` / `workspaces` / `capability` fields filter by user capability + workspace context. `filterCommands(commands, ctx)` runs once per palette open.

---

## Providers (async search)

Providers run **as the user types**. Each provider produces results for one domain:

```ts
interface SpotlightProvider {
  id:          string
  /** Becomes the group header in results. */
  label:       string
  /**
   * Called with the current query + context. Returns Commands to merge into
   * the palette. Should be quick — debounced + cached by the runner.
   */
  search:      (query: string, ctx: CommandContext, signal: AbortSignal) => Promise<Command[]> | Command[]
  /** Debounce in ms — applied per provider. 0 = synchronous each keystroke. */
  debounceMs?: number
}
```

`ProviderRunner` in `providerRunner.ts`:

- Fires all providers in parallel on query change
- Debounces per provider
- Caches results per `(provider, query)` until close
- `AbortController` cancels in-flight requests on close or query change

### Provider types

There are two kinds of provider:

**Local providers** (`pagesProvider`, `siteFilesProvider`) read data from the editor store synchronously. No HTTP call, `debounceMs: 0`.

**Server providers** (`mediaProvider`, `contentProvider`, `dataProvider`, `pluginPagesProvider`) fetch via `/admin/api/cms/...`. They are built with shared scaffolding in `serverProvider.ts` (see below).

### Server provider scaffolding (`serverProvider.ts`)

`serverProvider.ts` exports two primitives that all server-backed providers use:

**`makeServerProvider(config)`** — the common case factory. Builds a `SpotlightProvider` from a TypeBox schema, an array selector, and a `Command` mapper. Handles the empty-query guard, `?query=&limit=` URL construction, `apiRequest` fetch, abort handling, and result mapping:

```ts
export const dataProvider = makeServerProvider({
  id: 'data',
  label: 'Data',
  debounceMs: 150,
  endpoint: '/admin/api/cms/data/tables',
  schema: DataTablesListResponseSchema,
  select: (body) => body.tables,
  toCommand: (table): Command => ({
    id: `data:${table.id}`,
    title: table.name,
    group: 'data',
    iconName: 'table-solid',
    run: (ctx) => { ctx.closeSpotlight(); ctx.navigate(`/admin/data?table=${table.id}`) },
  }),
})
```

**`fetchOnAbortEmpty(url, schema, signal)`** — the lower-level primitive. Fetches and validates the URL, returning `null` on abort instead of throwing. Use this directly when the provider has a genuinely different shape (e.g. no `?query=` param, custom client-side filtering) that `makeServerProvider` can't model. `pluginPagesProvider` is the canonical example.

Both helpers validate the response body against a TypeBox schema via `apiRequest` — no `as Foo` past the HTTP boundary. Response schemas live in `providers/schemas.ts`.

`MAX_RESULTS = 25` is exported from `serverProvider.ts` and used by all providers as the result cap.

### Plugin providers

Plugins with `editor.commands` permission can register Spotlight providers via the SDK. Plugin providers go through `getPluginPaletteSpotlightProviders()` and run in the same `ProviderRunner` as built-ins.

---

## Scopes

A scope narrows the palette to a single domain. Scopes are stacked (`ScopeFrame[]`) — a deeper scope pushed by a command knows how to pop back when its action completes.

```ts
interface Scope {
  id:           string          // 'root' | 'pages' | 'modules' | …
  title?:       string          // header text in argument mode
  placeholder?: string
  /** Synchronous static commands offered by this scope. */
  commands:     () => Command[]
  /** Async providers — called with debounced query + AbortSignal. */
  providers?:   SpotlightProvider[]
}
```

When a scope is active:

- The header shows the scope title.
- Only the scope's `commands()` and `providers` are queried.
- Backspace on an empty query pops back to the unscoped state.
- A command's `run` may return `{ pushScope: 'scope-id' }` to enter a scope programmatically.

---

## The `Spotlight` dialog

`Spotlight.tsx` is the dialog itself — search input, scope chips, result list, footer with keyboard hints. It uses the `--spotlight-*` design tokens (see [docs/reference/design-tokens.md](../reference/design-tokens.md)).

Key behaviors:

- **Lazy chunk.** `Spotlight` is `React.lazy`-loaded inside `SpotlightRoot`; first-time open downloads the palette code.
- **Backdrop blur** (`--spotlight-backdrop-blur: 8px`).
- **Card rows.** Result rows have a border-radius and are laid out with a 1px gap — the same tile-card language as the module inserter and dashboard.
- **Categorical group accents.** Each command group gets a stable rail-tint identity (e.g. `editor` → lilac, `navigation` → sky, `media` → peach). The accent drives the icon chip color and the group-header accent bar. Mapping lives in `groupAccent.ts`.
- **Row selection** highlight via `--spotlight-row-selected-bg`.
- **Fuzzy match highlighting** — matched characters wrapped in `<mark>` with `--spotlight-mark-bg`.
- **Skeleton shimmer** while providers are in flight.

### Destructive confirm

Commands with `destructive: true` enter a two-press confirm flow:

```text
First Enter:  row background turns red (--spotlight-confirm-bg), label shows the confirm prompt
Second Enter: command runs
Esc / move:   resets to the normal state
```

Used by destructive commands: delete user, sign out all devices, revoke session, delete VC.

---

## Keyboard

| Key                  | Action                                                |
|----------------------|-------------------------------------------------------|
| ⌘K / Ctrl+K          | Open / close                                          |
| Esc                  | Clear query (or close if empty)                       |
| Arrow up / down      | Move selection                                        |
| Enter                | Run selected (twice for `destructive` commands)       |
| Tab                  | Cycle scope                                           |
| Backspace (empty)    | Pop scope                                             |
| ⌘?                   | Show all keybindings                                  |
| Custom command shortcuts | Per-command entry in `keybindings.ts`             |

The keybindings registry is **the single source of truth** for shortcuts — gated by `keybindings-registry-single-source.test.ts`. Don't add raw `keydown` listeners in components; register a command with a shortcut in `keybindings.ts`.

---

## Recents

`recentStore.ts` persists the last N executed command ids in localStorage (`instatic-spotlight-recents`). When the palette opens with an empty query, the recents float to the top.

The store is per-device, not per-user, because it sits in localStorage.

---

## Cookbook

### Add a built-in command

Append to `src/admin/spotlight/builtinCommands.ts`:

```ts
{
  id: 'site.toggle-grid-overlay',
  title: 'Toggle grid overlay',
  group: 'editor',
  iconName: 'grid-solid',
  workspaces: ['site'],
  run: async (ctx) => {
    useEditorStore.getState().toggleGridOverlay()
    ctx.closeSpotlight()
  },
}
```

To add a keyboard shortcut, register the command id in `src/admin/spotlight/keybindings.ts` — shortcut hints are looked up at render time, not stored on the `Command`.

### Add a server-backed async provider

Use `makeServerProvider` from `src/admin/spotlight/providers/serverProvider.ts`. Supply the TypeBox schema for the endpoint's response, a selector that picks the array from the body, and a mapper that converts each item to a `Command`:

```ts
// src/admin/spotlight/providers/myThingsProvider.ts
import { makeServerProvider } from './serverProvider'
import { MyThingsResponseSchema } from './schemas'
import type { Command } from '../types'

export const myThingsProvider = makeServerProvider({
  id: 'myThings',
  label: 'Things',
  debounceMs: 150,
  endpoint: '/admin/api/cms/things',
  schema: MyThingsResponseSchema,
  select: (body) => body.things,
  toCommand: (thing): Command => ({
    id: `thing:${thing.id}`,
    title: thing.name,
    subtitle: thing.category,
    group: 'results',
    iconName: 'star-solid',
    run: (ctx) => {
      ctx.closeSpotlight()
      ctx.navigate(`/admin/things/${thing.id}`)
    },
  }),
})
```

Add the response schema to `providers/schemas.ts`. Register the provider in `src/admin/spotlight/providers/index.ts`.

For a provider that needs custom filtering or no `?query=` param, use `fetchOnAbortEmpty` directly (see `pluginPagesProvider.ts` as a reference).

### Add a scope

```ts
// src/admin/spotlight/scopes/myThingsScope.ts
const myThingsScope: Scope = {
  id: 'find-thing',
  title: 'Find thing',
  placeholder: 'Search things…',
  commands: () => [],
  providers: [myThingsProvider],
}
```

Register in `src/admin/spotlight/scopes/`. Then a command can enter the scope:

```ts
{
  id: 'site.find-thing',
  title: 'Find thing…',
  group: 'navigation',
  run: () => ({ pushScope: 'find-thing' }),
}
```

### Register a plugin command

Plugins with `editor.commands` permission register commands at activation:

```ts
// plugin server/index.js
export function activate(api) {
  api.editor.palette.registerCommand({
    id: 'acme.do-thing',
    title: 'Do the thing',
    group: 'plugin',
    run: async () => { /* … */ },
  })
}
```

See [docs/features/plugin-system.md](plugin-system.md).

### Read editor state from a command

Inside the editor workspace, `ctx.editor` carries a snapshot of active page / selection. For deeper reads call `useEditorStore.getState()` directly:

```ts
run: async (ctx) => {
  const state = useEditorStore.getState()
  const node = state.site.activePage.nodes[state.selection.selectedNodeId]
  // ...
}
```

### Run a step-up-gated action

```ts
run: async (ctx) => {
  await ctx.runStepUp(async () => {
    await apiRequest('/admin/api/cms/sensitive', { method: 'POST', schema: OkSchema })
  })
}
```

`runStepUp` wraps the action with the step-up re-auth dialog. On cancel it throws `Error('step_up_cancelled')` — Spotlight catches and ignores that automatically.

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| Adding a raw `keydown` listener for a global shortcut                | Register in `keybindings.ts`. Gated.                    |
| Direct store mutation inside a provider's `search`                   | Providers are read-only — mutate in commands' `run`. Gated by `spotlight-no-direct-store-mutation.test.ts`. |
| Persisting recents server-side                                       | They're per-device in localStorage. Cross-device recents need a real feature, not a Spotlight detail. |
| Lazy-importing the editor store at module-eval time                  | The store mounts only when SitePage mounts — eager import would force the chunk. Use `require(...)` inside `search` (see `pagesProvider.ts`). |
| Long-running providers without `signal` handling                     | The runner aborts on close — return `[]` when `signal.aborted`. |
| Multi-screen flow inside a single command                            | Use scopes — each step pushes a new scope frame.         |
| Hand-rolling `fetch` + `isAbortError` in a server provider           | Use `makeServerProvider` or `fetchOnAbortEmpty` from `serverProvider.ts`. |
| Using `as Foo` past a JSON boundary in a provider                    | Pass a TypeBox schema to `makeServerProvider` or `fetchOnAbortEmpty`. Gated by `boundary-validation.test.ts`. |

---

## Related

- [docs/architecture.md](../architecture.md) — admin shell mount points
- [docs/editor.md](../editor.md) — `SpotlightRoot` placement
- [docs/features/plugin-system.md](plugin-system.md) — plugin commands + providers
- [docs/reference/design-tokens.md](../reference/design-tokens.md) — `--spotlight-*` tokens
- Source-of-truth files:
  - `src/admin/spotlight/SpotlightRoot.tsx` — mount + state
  - `src/admin/spotlight/Spotlight.tsx` — the dialog
  - `src/admin/spotlight/builtinCommands.ts` — built-in registry
  - `src/admin/spotlight/commandRegistry.ts` — scopes + filtering
  - `src/admin/spotlight/providerRunner.ts` — async provider scheduler
  - `src/admin/spotlight/providers/serverProvider.ts` — shared server-provider factory
  - `src/admin/spotlight/providers/schemas.ts` — TypeBox response schemas
  - `src/admin/spotlight/providers/*.ts` — per-domain providers
  - `src/admin/spotlight/matcher.ts` — fuzzy match
  - `src/admin/spotlight/types.ts` — `Command`, `SpotlightProvider`, `Scope`, `CommandContext`
  - `src/admin/spotlight/keybindings.ts` — keybinding registry
  - `src/admin/spotlight/groupAccent.ts` — CommandGroup → rail-tint accent mapping
- Gate tests:
  - `src/__tests__/architecture/spotlight-no-direct-store-mutation.test.ts`
  - `src/__tests__/architecture/keybindings-registry-single-source.test.ts`
