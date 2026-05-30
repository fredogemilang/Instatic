# Spotlight (Cmd+K Palette)

The Spotlight command palette — Cmd+K from anywhere in the admin opens a fuzzy-matched action / search interface. It owns the editor's keyboard surface: every Spotlight-registered command works exactly the same way as a built-in command.

Spotlight is mounted by `<SpotlightRoot>` inside `AuthenticatedAdmin` (post-login chunk), so it's available across every workspace and across plugin admin pages.

---

## TL;DR

- Mount point: `<SpotlightRoot>` in `AuthenticatedAdmin.tsx`. Wraps the whole post-login app.
- Trigger: ⌘K / Ctrl+K (global keydown). Esc closes (or clears query if non-empty).
- Built-in commands: `src/admin/spotlight/builtinCommands.ts`. Returns the static `Command[]`.
- Async providers: `src/admin/spotlight/providers/*.ts` (pages, components, media, content, plugins, …). Run in parallel as the query changes.
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
│   ├── pages.ts                   — page search
│   ├── components.ts              — VC search
│   ├── media.ts                   — media search
│   ├── content.ts                 — post / row search
│   ├── plugins.ts                 — plugin search
│   └── ...
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
├── HelpKeybindingsList.tsx        — Cmd+? help screen
├── pendingAction.ts               — confirm-destructive flow
├── types.ts                       — Command, SpotlightProvider, Scope, CommandContext
└── index.ts                       — barrel
```

---

## The `Command` shape

```ts
interface Command {
  id:          CommandId             // 'editor.publish', 'site.add-page', 'system.toggle-density'
  label:       string                // "Publish site"
  description?:string                // shown under the label
  group:       CommandGroup          // 'editor' | 'site' | 'content' | 'system' | 'navigation' | 'plugin'
  icon?:       string                // pixel-art-icons name
  shortcut?:   CommandShortcut       // { keys: ['mod', 'shift', 'p'], when?: 'editor' }

  /** Static availability — filtered by capabilities + workspace. */
  visible?:    (ctx: CommandContext) => boolean

  /** Argument prompts — multi-step input flow. */
  args?:       CommandArg[]

  /** Dangerous commands require a second Enter to confirm (delete, sign out all). */
  confirm?:    { prompt: string }

  /** The execution function. */
  run:         (ctx: CommandRunContext) => Promise<void> | void

  /** Optional: scope id this command lives under. */
  scope?:      string
}
```

A `Command` knows everything about itself: where it's visible, what arguments it needs, whether it's destructive, what shortcut activates it. The palette is purely a UI for the registry.

---

## The `CommandContext`

```ts
interface CommandContext {
  user:            CurrentUser
  workspace:       AdminWorkspace          // 'dashboard' | 'site' | 'content' | ...
  navigate:        NavigateFn
  activeDocument?: ActiveDocument          // current page / VC if in editor
  pushToast:       (toast: ToastInput) => void
  stepUp:          () => Promise<boolean>
  // ...
}
```

Built by `SpotlightRoot` on every open. Inside the editor (`workspace === 'site'`), `SpotlightRoot` subscribes to the editor store via `subscribeWithSelector` to track the active page / selected node / mode — so commands like "Wrap selection in container" know what they're operating on.

The subscription is **dropped on close** to avoid spurious re-renders.

---

## Built-in commands

`src/admin/spotlight/builtinCommands.ts` exports the static command set. Common groups:

| Group        | Examples                                                                  |
|--------------|---------------------------------------------------------------------------|
| `editor`     | Publish, Save, Undo, Redo, Wrap in container, Toggle preview              |
| `site`       | Add page, Add VC, Open settings, Open framework scale                     |
| `content`    | New post, Edit post                                                       |
| `system`     | Toggle density, Show keyboard help, Sign out, Switch user                 |
| `navigation` | Go to dashboard, Go to site, Go to media, Go to plugins, ...              |

Each command's `visible(ctx)` predicate filters by user capability + workspace. `filterCommands(commands, ctx)` runs once per palette open.

---

## Providers (async search)

Providers run **as the user types**. Each provider produces results for one domain:

```ts
interface SpotlightProvider {
  id:       string             // 'pages', 'components', 'media', ...
  group:    CommandGroup
  /**
   * Called with the current query + context. Returns hits to merge into
   * the palette. Should be quick — debounced + cached by the runner.
   */
  search:   (query: string, ctx: CommandContext, signal: AbortSignal) => Promise<ProviderHit[]>
}
```

`ProviderRunner` in `providerRunner.ts`:

- Fires all providers in parallel on query change
- Debounces by ~80ms
- Caches results per `(provider, query)` until close
- `AbortController` cancels in-flight requests on close or query change

Built-in providers cover pages, VCs, media, content rows, plugins, and a few others. Each fetches via the matching `/admin/api/cms/...` endpoint.

### Plugin providers

Plugins with `editor.commands` permission can register Spotlight providers via the SDK. Plugin providers go through `getPluginPaletteSpotlightProviders()` and run in the same `ProviderRunner` as built-ins.

---

## Scopes

A scope narrows the palette to a single domain. The user enters a scope by typing a prefix (`scope:pages`) or via a "Find page…" command that pushes a scope frame.

```ts
interface Scope {
  id:           string          // 'pages', 'components', 'commands'
  label:        string          // "Find page"
  icon?:        string
  providers:    string[]        // which providers to include
  emptyState?:  ReactNode       // shown when there are no results
}
```

When a scope is active:

- The header shows the scope label (e.g. "Find page → ").
- Only the scope's providers fire.
- Backspace on an empty query pops back to the unscoped state.

Scopes are stacked (`ScopeFrame[]`) — a deeper scope pushed by a command knows how to pop back when its action completes.

---

## The `Spotlight` dialog

`Spotlight.tsx` is the dialog itself — search input, scope chips, result list, footer with keyboard hints. It uses the `--spotlight-*` design tokens (see [docs/reference/design-tokens.md](../reference/design-tokens.md)).

Key behaviors:

- **Lazy chunk.** `Spotlight` is `React.lazy`-loaded inside `SpotlightRoot`; first-time open downloads ~30KB of palette code.
- **Backdrop blur** (`--spotlight-backdrop-blur: 8px`).
- **Row selection** highlight via `--spotlight-row-selected-bg`.
- **Fuzzy match highlighting** — matched characters wrapped in `<mark>` with `--spotlight-mark-bg`.
- **Group headers** styled with `--spotlight-group-header-fg`.
- **Skeleton shimmer** while providers are in flight.

### Destructive confirm

Commands with `confirm: { prompt: '...' }` enter a two-press confirm flow:

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
| Enter                | Run selected (twice for `confirm` commands)           |
| Tab                  | Cycle scope                                           |
| Backspace (empty)    | Pop scope                                             |
| ⌘?                   | Show all keybindings                                  |
| Custom command shortcuts | Per-command `shortcut` field                      |

The keybindings registry is **the single source of truth** for shortcuts — gated by `keybindings-registry-single-source.test.ts`. Don't add raw `keydown` listeners in components; register a command with a `shortcut`.

---

## Recents

`recentStore.ts` persists the last N executed command ids in localStorage (`pb-spotlight-recents`). When the palette opens with an empty query, the recents float to the top.

The store is per-device, not per-user, because it sits in localStorage (the user can sign out and back in and still see their recents).

---

## Cookbook

### Add a built-in command

Append to `src/admin/spotlight/builtinCommands.ts`:

```ts
{
  id: 'site.toggle-grid-overlay',
  label: 'Toggle grid overlay',
  group: 'editor',
  icon: 'GridIcon',
  shortcut: { keys: ['mod', 'g'], when: 'editor' },
  visible: (ctx) => ctx.workspace === 'site',
  run: async (ctx) => {
    useEditorStore.getState().toggleGridOverlay()
    ctx.pushToast({ kind: 'info', title: 'Grid toggled' })
  },
}
```

### Add an async provider

Create `src/admin/spotlight/providers/myThings.ts`:

```ts
import { apiRequest, isAbortError } from '@core/http'

export const myThingsProvider: SpotlightProvider = {
  id: 'my-things',
  group: 'site',
  async search(query, ctx, signal) {
    let data: Static<typeof MyThingsSchema>
    try {
      data = await apiRequest('/admin/api/cms/things', {
        query: { q: query },
        schema: MyThingsSchema,
        signal,
      })
    } catch (err) {
      if (isAbortError(err)) return [] // superseded query — drop silently
      throw err
    }
    return data.rows.map((row) => ({
      id: `thing:${row.id}`,
      label: row.name,
      group: 'site',
      run: async () => ctx.navigate(`/admin/things/${row.id}`),
    }))
  },
}
```

Register it in `src/admin/spotlight/providers/index.ts`.

### Add a scope

```ts
const findThingScope: Scope = {
  id: 'find-thing',
  label: 'Find thing',
  icon: 'SearchIcon',
  providers: ['my-things'],
  emptyState: <EmptyState title="No things found" />,
}
```

Register in `src/admin/spotlight/scopes/`. Then a command can push the scope:

```ts
{
  id: 'site.find-thing',
  label: 'Find thing…',
  group: 'site',
  run: (ctx) => ctx.pushScope('find-thing'),
}
```

### Register a plugin command

Plugins with `editor.commands` permission register commands at activation:

```ts
// plugin server/index.js
export function activate(api) {
  api.editor.palette.registerCommand({
    id: 'acme.do-thing',
    label: 'Do the thing',
    group: 'plugin',
    run: async () => { /* … */ },
  })
}
```

See [docs/features/plugin-system.md](plugin-system.md).

### Read editor state from a command

Inside the editor workspace, the command context has `activeDocument` (the current page or VC). For deeper reads:

```ts
run: async (ctx) => {
  const state = useEditorStore.getState()
  const node = state.site.activePage.nodes[state.selection.selectedNodeId]
  // ...
}
```

The `useEditorStore` import is allowed in Spotlight — gated by `spotlight-allowed-router-import.test.ts` (technically about the router but spotlight has a similar carve-out). Spotlight is part of the admin shell, not a workspace page, so it can dip into multiple workspace stores.

### Run a step-up-gated action

```ts
run: async (ctx) => {
  const ok = await ctx.stepUp()
  if (!ok) return  // user cancelled
  // ... destructive action
}
```

`stepUp()` returns true on success, false on dismiss. The actual step-up UI is owned by `<StepUpProvider>` upstream.

---

## Forbidden patterns

| Pattern                                                              | Use instead                                              |
|----------------------------------------------------------------------|----------------------------------------------------------|
| Adding a raw `keydown` listener for a global shortcut                | Register a command with a `shortcut`. Gated.            |
| Direct store mutation inside a provider's `search`                   | Providers are read-only — mutate in commands' `run`. Gated by `spotlight-no-direct-store-mutation.test.ts`. |
| Persisting recents server-side                                       | They're per-device in localStorage. Cross-device recents need a real feature, not a Spotlight detail. |
| Lazy-importing the editor store at module-eval time                  | The store mounts only when SitePage mounts — eager import would force the chunk |
| Long-running providers without `signal` handling                     | The runner aborts on close — respect `signal.aborted`    |
| Multi-screen flow inside a single command                            | Use scopes — each step pushes a new scope frame          |
| Calling `navigate(...)` before the palette closes                    | Palette closes itself after `run` completes — let it     |

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
  - `src/admin/spotlight/providers/*.ts` — per-domain providers
  - `src/admin/spotlight/matcher.ts` — fuzzy match
  - `src/admin/spotlight/types.ts` — `Command`, `SpotlightProvider`, `Scope`
  - `src/admin/spotlight/keybindings.ts` — keybinding registry
- Gate tests:
  - `src/__tests__/architecture/spotlight-allowed-router-import.test.ts`
  - `src/__tests__/architecture/spotlight-no-direct-store-mutation.test.ts`
  - `src/__tests__/architecture/keybindings-registry-single-source.test.ts`
