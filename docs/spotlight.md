# Command Spotlight (Cmd+K) — Master Plan

> **Status:** Implementation complete (Phases 1–6). Phase 7 stretch items remain as future work.
> **Owner:** TBD — single primary implementer, can absorb feedback async.
> **Pre-release rules apply** (see `CLAUDE.md`): no backward-compat shims, fix at source, replace the hand-written shortcut table rather than duplicating it.

---

## 1. Vision

A single keyboard-first surface, opened with `⌘K` / `Ctrl+K` from anywhere in the admin, that:

- **Navigates** to any workspace, page, content entry, media file, data table, Visual Component, plugin admin page, settings section.
- **Acts** — runs any admin/editor command (save, publish, undo, insert module, toggle panel, switch breakpoint, open AI assistant, change theme, sign out…).
- **Searches everything at once** with a single ranked list, with subtle group dividers and a context-aware first-result heuristic.
- **Chains** (subcommand mode) — e.g. "Insert module → search modules", "Switch page → search pages", "Set breakpoint → pick breakpoint", "Run plugin command → arguments".
- Is **extensible** by plugins through the existing `editor.commands` permission plus a new `palette.providers` capability for live search providers.

The bar: feels at least as good as Linear's `⌘K`, Raycast's main window, and Figma's quick actions, while staying **achromatic** and consistent with the existing editor tokens.

---

## 2. UX research — what the best ones do

Patterns synthesized from Linear, Raycast, VS Code Command Palette, Figma Quick Actions, Notion, Slack, GitHub `t`/`Ctrl+K`, Vercel dashboard, Cmdk (`pacocoursey/cmdk`), Sentry, 1Password.

### Convergent best practices we will adopt

| Pattern | Reference | Decision |
|---|---|---|
| **`⌘K` / `Ctrl+K` to open**, `Esc` to close, `Esc` again to clear query | Linear, Vercel, Notion | ✅ |
| **Centered overlay**, ~640px wide, floats over a dimmed backdrop | Linear, Raycast | ✅ — 640px, panel tokens (`--panel-bg`, `--panel-blur`) |
| **Top of viewport feels too "alert"; vertically ~30% from top** | Linear, Raycast | ✅ — 28vh top offset |
| **Single input + ranked result list**, no tabs | Linear | ✅ |
| **Soft group headers** that disappear when irrelevant to query | Linear, Raycast | ✅ |
| **Recent commands** at top when input is empty | Raycast, VS Code | ✅ — last 8, deduped, localStorage |
| **Pinned suggestions** when input is empty | Raycast, Slack | Phase 2 |
| **Fuzzy matching** with score boost on `label` prefix and word-start | All | ✅ — implement small in-house matcher; do **not** add `fuse.js` (prefer in-house) |
| **Sublabel / context line** below each result (workspace, path, type) | Linear | ✅ |
| **Trailing keyboard hint** (`⌘S`) on rows that have a registered shortcut | VS Code, Linear | ✅ |
| **Right-side icon** + leading category icon | Raycast | ✅ — use `pixel-art-icons` already in repo |
| **`↑` `↓` to navigate, `Enter` to run, `Tab` to enter subcommand, `→` enters detail, `←` exits** | Raycast | ✅ |
| **Subcommand mode** (palette stays open; query/list changes to subcommand's children) | Raycast, Linear, Cmdk | ✅ — stack-based "scopes" |
| **Action arguments** (e.g. "Add page" → text input "title") | Raycast | ✅ — declarative `arg` schema |
| **Async live results** (search pages/media/content from server) with debounced calls + cancellation | Linear, GitHub | ✅ — `AbortController`, 150 ms debounce |
| **`?` opens a key-binding cheatsheet inline** | GitHub, Linear | ✅ — `?` empty query mode |
| **Loading shimmer**, not a spinner, while async fetches resolve | Linear | ✅ |
| **Inline icons that animate on hover** | Raycast | ✅ if performant — opt-in per row |
| **Highlighted match characters** in the label using `<mark>` | All | ✅ |
| **Per-result destructive confirmation inline** (no second modal) | Linear ("Delete page" → "Confirm?") | ✅ — `confirm: true` flag on command |
| **Empty state** when no match: suggest 2–3 related commands | Raycast | ✅ |
| **Context-aware first hit**: in editor with a node selected, "Duplicate layer" outranks "Duplicate page" | Figma, Linear | ✅ — scope-weighted scoring |
| **No "magnifying glass" trap** — typing always filters, even after navigating subcommand | Cmdk | ✅ |
| **Mobile / touch** falls back to bottom-sheet | Linear | Phase 3 — admin is desktop-first |
| **No `confirm()` / `alert()`** | Codebase rule | ✅ |
| **Achromatic chrome** + the existing semantic state tokens | Codebase rule | ✅ |

### Anti-patterns we will avoid

- **Tabs across the top** (Slack-style "All / Channels / People") — slows everyone down; we'll use one ranked list with group headers instead.
- **Modal-blocking subcommands** that close the palette and reopen another one.
- **Search-only-titles** — must search description and tags too, but with much lower weight.
- **Indexing the whole site on every open** — index incrementally, cache results, refetch on staleness signals.
- **A "Run" button** — Enter is enough.
- **Custom keyboard handling outside the input** — keep focus on the input; route `↑↓` from there.

---

## 3. Architecture

### 3.1 Module location

```
src/admin/spotlight/                  # new top-level admin module
  Spotlight.tsx                       # the overlay + root
  Spotlight.module.css
  SpotlightProvider.tsx               # context + global ⌘K listener
  SpotlightResults.tsx                # virtualized list
  SpotlightRow.tsx                    # one result row
  SpotlightFooter.tsx                 # hint strip ("↵ to run · esc to close")
  SpotlightArgInput.tsx               # subcommand argument prompt
  useSpotlight.ts                     # hook for opening / pushing scope
  state.ts                            # zustand atom (or useReducer) — see below
  matcher.ts                          # fuzzy scorer (in-house, ~80 LOC)
  commandRegistry.ts                  # registry + provider plumbing
  recentStore.ts                      # localStorage of recent command IDs
  scopes/                             # built-in scope definitions
    rootScope.ts
    editorScope.ts
    pagesScope.ts
    contentScope.ts
    dataScope.ts
    mediaScope.ts
    pluginsScope.ts
    usersScope.ts
    settingsScope.ts
    helpScope.ts
  commands/                           # built-in command definitions, grouped
    navigation.ts
    editor.ts
    pages.ts
    breakpoints.ts
    content.ts
    media.ts
    data.ts
    framework.ts                      # colors / typography / spacing
    visualComponents.ts
    plugins.ts
    users.ts
    account.ts
    settings.ts
    preview.ts
    aiAssistant.ts
    help.ts
  providers/                          # async live-search providers
    pagesProvider.ts                  # local from editor store
    contentProvider.ts                # /api/cms/content/...
    mediaProvider.ts                  # /api/cms/media/...
    dataProvider.ts                   # /api/cms/data/...
    pluginPagesProvider.ts
  __tests__/                          # spotlight-specific unit tests
  index.ts                            # public exports
```

Mounting: a single `<SpotlightProvider>` at the very top of `AdminEntry`'s authenticated tree (above `<AdminSessionProvider>` so it's available to every workspace), rendering `<Spotlight />` via a portal at `document.body`.

### 3.2 Why not pull in `cmdk`

`pacocoursey/cmdk` is the obvious off-the-shelf. We will **not** depend on it:

1. We have a strict CSS-Modules + tokens regime; `cmdk` ships its own primitives.
2. We already own primitives (`Dialog`, `SearchBar`, `ContextMenu`) and an achromatic visual language — reinventing the ~250 lines of list + keyboard is cheap vs. mismatched styling.
3. We need scope/argument flows that go beyond what `cmdk`'s default tree offers (it's possible, but writing our own is simpler than bending it).
4. Codebase rule §6: "Output of this project must stay clean." Adding a styling shim around `cmdk` to recolor it is a band-aid.

### 3.3 Data model

```ts
// src/admin/spotlight/types.ts

export type CommandId = string  // dotted, e.g. "editor.duplicateLayer"

export type CommandGroup =
  | 'navigation'
  | 'editor'
  | 'pages'
  | 'content'
  | 'data'
  | 'media'
  | 'visualComponents'
  | 'framework'
  | 'plugins'
  | 'users'
  | 'account'
  | 'settings'
  | 'preview'
  | 'ai'
  | 'help'
  | 'recent'           // synthetic, only when query is empty
  | 'results'          // catch-all for provider-supplied jump items

export interface CommandShortcut {
  /** Mac order: ⌘ ⌥ ⌃ ⇧ + key. We auto-render Ctrl on non-Mac. */
  mac: string          // e.g. "⌘⇧K"
  win: string          // e.g. "Ctrl+Shift+K"
}

export interface CommandArg {
  id: string
  label: string
  type: 'text' | 'select' | 'pick'   // 'pick' = nested scope
  placeholder?: string
  required?: boolean
  /** For 'select' — static option list. For 'pick' — provider scope id. */
  options?: ReadonlyArray<{ value: string; label: string; sublabel?: string }>
  scope?: string                     // for type: 'pick'
}

export interface Command {
  id: CommandId
  title: string                       // shown as label
  subtitle?: string                   // shown beneath
  group: CommandGroup
  iconName?: string                   // pixel-art-icons name
  keywords?: string[]                 // extra search terms (low weight)
  shortcut?: CommandShortcut
  /** Capability gate — palette filters before display. */
  capability?: string
  /** Workspace gate — only show on these workspaces. */
  workspaces?: ReadonlyArray<AdminWorkspace | 'any'>
  /** Predicate run at query time — finer-grained gating (e.g. "selection exists"). */
  when?: (ctx: CommandContext) => boolean
  /** Boosts ranking when `when` returns true. 1.0 = no boost. */
  priorityBoost?: number
  /** Optional arguments collected via subcommand flow. */
  args?: CommandArg[]
  /** Destructive — palette shows red row + inline "Confirm". */
  destructive?: boolean
  /** If true, palette stays open after run (e.g. "Toggle X"). */
  keepOpenAfterRun?: boolean
  /** Synchronous, async, or returns next scope (for explicit drill-in). */
  run: (ctx: CommandRunContext) => void | Promise<void> | { pushScope: string }
}

export interface Scope {
  id: string                          // 'root' | 'pages' | 'modules' | …
  title?: string                      // header text in argument mode
  placeholder?: string                // input placeholder
  /** Synchronous static commands offered by this scope. */
  commands: () => Command[]
  /** Async providers — called with debounced query + AbortSignal. */
  providers?: SpotlightProvider[]
}

export interface SpotlightProvider {
  id: string
  label: string                       // becomes the group header
  /** Returns up to ~25 entries; can return [] cheaply. */
  search: (
    query: string,
    ctx: CommandContext,
    signal: AbortSignal,
  ) => Promise<Command[]> | Command[]
  /** Debounce in ms — applied per provider. 0 = synchronous each keystroke. */
  debounceMs?: number
}

export interface CommandContext {
  workspace: AdminWorkspace
  pathname: string
  user: CmsCurrentUser
  /** Live store reads — populated by the spotlight host. */
  editor?: {
    selectedNodeIds: ReadonlyArray<string>
    activePageId: string | null
    activeDocument: ActiveDocument | null
    canUndo: boolean
    canRedo: boolean
    activeBreakpointId: string
  }
}

export interface CommandRunContext extends CommandContext {
  args: Record<string, string>        // collected via subcommand flow
  navigate: (path: string) => void
  closeSpotlight: () => void
  pushScope: (scopeId: string, args?: Record<string, string>) => void
  popScope: () => void
}
```

### 3.4 State machine

A small reducer atom (not a new Zustand slice — keep concerns separate from the editor store):

```ts
type SpotlightState =
  | { phase: 'closed' }
  | {
      phase: 'open'
      query: string
      scopeStack: ScopeFrame[]        // top = active scope, ['root'] by default
      pendingArgs: Record<string, string>
      highlightedIndex: number
      asyncResults: Record<string, Command[]>  // keyed by providerId
      loadingProviders: Set<string>
    }
```

Transitions trigger via `dispatch({ type: 'OPEN' | 'CLOSE' | 'SET_QUERY' | 'PUSH_SCOPE' | 'POP_SCOPE' | 'NAVIGATE' | 'RUN' | … })`.

### 3.5 Wiring with the editor store

- Spotlight does **not** subscribe to the entire editor store; commands read `useEditorStore.getState()` lazily inside `run()` and `when()`.
- The `CommandContext.editor` snapshot is built once per open and on selection change (subscribe via `useEditorStore.subscribeWithSelector`).
- All mutations go through existing store actions — **no new mutation paths**. Spotlight is a UI layer, never a model layer. Important for keeping the architecture honest.

### 3.6 Integration with existing keyboard system

- `usePersistence.ts` already owns `⌘S` — leave it. We add a guard in spotlight's listener: when spotlight is open, swallow `⌘S` etc. so users can't double-fire.
- `PanelRail.tsx` owns `Ctrl+Shift+E`, `Ctrl+Shift+M`, `Ctrl+Shift+R`, `⌘I` — leave them; spotlight surfaces them with `shortcut` hints. **Stretch**: extract a single `keybindings.ts` registry that both PanelRail and Spotlight read; deprecation note: do this in Phase 5 — pre-release lets us refactor.
- `CanvasRoot.tsx` owns `Delete`, `⌘D`, `⌘C/X/V` — same treatment.
- `ShortcutsSection.tsx` (the static reference table) gets **deleted** and replaced with a generated list from the command registry — single source of truth. (Pre-release allows this without compat shim.)

---

## 4. Command surface — full inventory

The catalog below is the v1 target. Items marked `(p2)` are Phase 2 stretch.

### 4.1 Navigation (always available)

| Command | Action | Shortcut | Notes |
|---|---|---|---|
| Go to Site editor | navigate `/admin/site` | `g s` chord | gated by `canAccessWorkspace(user, 'site')` |
| Go to Content | navigate `/admin/content` | `g c` |  |
| Go to Data | navigate `/admin/data` | `g d` |  |
| Go to Media | navigate `/admin/media` | `g m` |  |
| Go to Plugins | navigate `/admin/plugins` | `g p` |  |
| Go to Users | navigate `/admin/users` | `g u` |  |
| Go to Account | navigate `/admin/account` |  |  |
| Open settings → General/Pages/Breakpoints/Publishing/Preferences/Shortcuts | open Settings modal at section | `,` |  |
| Open keyboard shortcuts cheatsheet | route via help scope | `?` |  |
| Sign out | clear session | `⌘⇧Q` | destructive |
| Switch site (managed mode, p2) | route to site picker | — | gated to managed install |

### 4.2 Editor — file / lifecycle (workspace: site, content)

| Command | Action |
|---|---|
| Save | `usePersistence().save()` (or fire `⌘S`) |
| Publish | `publish()` from PublishButton handler |
| Undo / Redo | `useEditorStore.getState().undo() / redo()` (only when `canUndo` / `canRedo`) |
| Toggle auto-save | flip `autoSave` preference |
| Toggle preview overlay | `openPreview / closePreview` |
| Switch canvas mode → Design / Preview | `setCanvasView('design' \| 'preview')` |
| Toggle pan / select / insert | `setCanvasMode(...)` |
| Reset zoom | `setZoom(1)` |
| Zoom in / Zoom out | `setZoom(±step)` |
| Fit to screen | `computeFitTransform` helper |

### 4.3 Editor — pages (workspace: site)

| Command | Action |
|---|---|
| Switch to page… | subcommand → live page list (provider) |
| Add page… | arg: title → `addPage(title)` → switch active page |
| Rename current page… | arg: title → `renamePage(pageId, title)` |
| Duplicate current page… | arg: title → `duplicatePage(pageId, title)` |
| Delete current page | destructive, inline confirm → `deletePage(pageId)` |
| Convert page to template | `convertPageToTemplate(pageId, {...})` |
| Convert template to page | `convertTemplateToPage(pageId)` |
| Reorder pages (p2) | subcommand → drag handles |

### 4.4 Editor — layers (workspace: site, requires selection)

| Command | Action | `when` |
|---|---|---|
| Duplicate selected layer(s) | `duplicateNode(s)` | selection exists |
| Delete selected layer(s) | `deleteNode(s)` | selection exists, destructive |
| Copy / Cut / Paste | clipboard slice actions | selection exists |
| Rename layer… | arg: label → `renameNode(id, label)` | single selection |
| Lock / Unlock layer | `toggleNodeLocked` | selection exists |
| Hide / Show layer | `toggleNodeHidden` | selection exists |
| Wrap in container… | subcommand → container module list | selection exists |
| Insert module… | subcommand → searchable module + VC picker (reuses module-engine registry) | always |
| Insert Visual Component… | subcommand → VC list | always |
| Convert selection to Visual Component… | `convertToComponentButton` flow | selection exists |
| Select parent / first child / next sibling / prev sibling | uses `useTreeWalkOrder` helpers | selection exists |
| Move up / down in tree | `moveNode` | selection exists |
| Set breakpoint override → … | subcommand → breakpoint picker | selection exists |
| Clear breakpoint override | `clearBreakpointOverride` | selection exists + override active |
| Set dynamic binding → … | subcommand | selection exists, p2 |
| Clear dynamic binding | | selection has binding, p2 |
| Edit in code editor | `openInEditor(fileId)` for the selected node's SiteFile, p2 | — |

### 4.5 Editor — breakpoints / canvas / panels

| Command | Action |
|---|---|
| Switch breakpoint → … | subcommand → breakpoint list → `setActiveBreakpoint(id)` |
| Add breakpoint… | args: name, minWidth, maxWidth → `addBreakpoint` |
| Edit breakpoint… | subcommand |
| Toggle Layers panel | `toggleLeftSidebarPanel('layers')` |
| Toggle Site explorer | `toggleLeftSidebarPanel('site')` |
| Toggle Selectors / Colors / Typography / Spacing / Media / Dependencies / AI panel | corresponding toggles |
| Toggle Properties panel | `togglePropertiesPanel` |
| Cycle panel focus (F6) | `cycleFocusedPanel` |
| Open code editor… | subcommand → SiteFile list |
| Toggle code editor panel | `setCodeEditorPanelOpen(!)` |
| Show full keyboard cheatsheet | open help scope |

### 4.6 Editor — Framework (colors / typography / spacing / fonts)

For each, a "Manage…" command that deep-links to the panel + a "Create …" command with args.

| Command | Action |
|---|---|
| Create color token… | args: slug, light, dark, category → `createFrameworkColorToken` |
| Edit color token… | subcommand → token list |
| Delete color token… | subcommand → token list, destructive |
| Create typography group / spacing group | `createFrameworkTypographyGroup` / `createFrameworkSpacingGroup` |
| Open Colors / Typography / Spacing panel | `setLeftSidebarPanel(...)` |
| Open framework preferences | open Settings → Preferences → Framework |
| Install font… | open MediaPicker font flow (p2 — needs UX) |
| Remove font… | subcommand → installed font list |

### 4.7 Editor — Visual Components

| Command | Action |
|---|---|
| Open Visual Component… | subcommand → VC list → `setActiveDocument({ kind: 'visualComponent', vcId })` |
| Create Visual Component… | args: name |
| Rename / delete Visual Component | subcommand |
| Exit Visual Component mode | `exitVisualComponentMode()` |

### 4.8 Content workspace

| Command | Action |
|---|---|
| Open content document… | subcommand → live content provider |
| New content document… | args: title → POST `/api/cms/content` |
| Rename / Duplicate / Delete content document | subcommand |
| Create collection… | open `ContentCollectionCreateDialog` |
| Collection settings… | open `ContentCollectionSettingsDialog` |
| Open Media picker (for inserting media) | open `MediaPickerDialog` |

### 4.9 Data workspace

| Command | Action |
|---|---|
| Open table… | subcommand → live data tables |
| New table… | open `NewTableDialog` with prefilled name |
| New field in current table… | open `NewFieldDialog` |
| Rename / Delete table / field | subcommand |
| Toggle Data sidebar | `setDataSidebarCollapsed(!)` |
| Insert relation… | open `RelationPickerDialog` |
| Run table query (p2) |  |

### 4.10 Media workspace

| Command | Action |
|---|---|
| Upload file… | trigger upload picker |
| Open file… | subcommand → live media provider |
| Open folder… | subcommand → folders |
| New folder… | arg: name |
| Bulk edit selected files | open `BulkEditWindow` |
| Show smart folder… | subcommand |
| Replace file… | subcommand |

### 4.11 Plugins

| Command | Action |
|---|---|
| Install plugin… | open install dialog |
| Open plugin… | subcommand → plugin list (active first) |
| Open plugin page… | subcommand → registered plugin admin pages |
| Configure plugin… | subcommand → settings dialog per plugin |
| Enable / Disable plugin | direct toggle (destructive label when disabling actively used) |
| Uninstall plugin | destructive |
| Run plugin command → … | **subcommand into all registered `PluginCommand`s** — first real consumer of `editor.commands.register` |
| View plugin permissions | subcommand → plugin → permissions view |

### 4.12 Users / Roles / Audit

| Command | Action | Capability gate |
|---|---|---|
| Invite user… | args: email, role | `users.write` |
| Open user… | subcommand | `users.read` |
| Reset user password (sends magic link) | destructive | `users.write` |
| Suspend / Activate user | destructive | `users.write` |
| Create role… | args: name | `roles.write` |
| Edit role | subcommand | `roles.write` |
| View audit log | navigate to Users → Audit | `audit.read` |

### 4.13 Account

| Command | Action |
|---|---|
| Edit profile | navigate to Account → Profile |
| Change password… | route to Security tab + open the change dialog |
| Manage two-factor authentication | Security tab |
| Manage active devices | Active devices tab |
| View sign-in history | Sign-in history tab |
| Sign out everywhere else | destructive |
| Sign out | destructive |

### 4.14 AI assistant

| Command | Action |
|---|---|
| Open AI assistant | `setLeftSidebarPanel('agent')` (or focus if already open) |
| Ask AI assistant… | arg: prompt → push the prompt into agentSlice + open panel |
| Clear AI conversation | `agentSlice.reset()` |

### 4.15 Help

| Command | Action |
|---|---|
| Show keyboard shortcuts | open help scope (list of all commands with their shortcuts) |
| Open documentation | `window.open(...)` for docs |
| Report an issue | `window.open(...)` GitHub issues |
| About Page Builder CMS | open about dialog with version info |
| Copy environment info | clipboard the version, db engine, browser |

### 4.16 Editor preferences (the entire `PREFERENCE_CATALOG`)

Every boolean and select preference in `preferences/catalog.ts` becomes a command derived at registration time. **No hand-mirroring** — derive once, stay in sync forever.

---

## 5. UI / visual design spec

### 5.1 Layout

```
                                ⌫
┌────────────────────────────────────────────────────────┐
│  🔍  Type a command or search…                  ⌘K     │  ← input row, 56px, sticky
├────────────────────────────────────────────────────────┤
│ Recent                                                 │  ← group header
│ ▸ ⏎  Duplicate layer                          ⌘D   ↩  │  ← row, 44px, highlighted = blue ring
│   ⏎  Add page…                                         │
│                                                        │
│ Pages                                                  │
│   📄  Home              /home               page       │
│   📄  About us          /about              page       │
│                                                        │
│ Commands                                               │
│   ⚙   Open settings → Pages              ⌘,           │
│   🎨  Switch breakpoint →                              │
│                                                        │
├────────────────────────────────────────────────────────┤
│  ↑↓ Navigate · ⏎ Run · → Enter · ⌫ Back · esc Close   │  ← footer hint strip, 36px
└────────────────────────────────────────────────────────┘
```

### 5.2 Tokens & sizing

- **Overlay**: `position: fixed; inset: 0;`, backdrop `rgba(0,0,0,0.45)` + 8px backdrop blur (token-driven).
- **Panel**: `--panel-bg`, `--panel-border`, `--panel-radius` (12px), `--panel-blur`, `--panel-shadow`. Width 640px, max-height `min(60vh, 560px)`. Top offset 28vh, centered horizontally.
- **Input**: 56px tall, font-size 16px, no border, full-width inside panel, top-rounded corners.
- **Row**: 44px tall (matches existing 44×44 minimum touch target rule), 16px horizontal padding.
  - Leading icon 16px (`pixel-art-icons`).
  - Label `var(--editor-fg)`, 14px.
  - Sublabel `var(--editor-fg-muted)`, 12px, single-line truncated.
  - Trailing shortcut hint: `<kbd>` styled like Settings → Shortcuts (already shipping in `SettingsModal.module.css`).
  - Highlighted state: `--canvas-selection-ring`-style 1px inset ring + faint bg from `--editor-bg-elevated`.
  - Match characters: `<mark>` with `--editor-success-bg`, no underline.
- **Group header**: 28px tall, uppercase 11px, `var(--editor-fg-faint)`, transparent bg.
- **Empty state**: centered 48px icon (`magnifier-x`) + "No results for `<query>`" + 2 suggestion rows.
- **Destructive row**: leading icon and label in `--editor-danger`. Inline confirm: row swaps to "Press ↵ again to confirm" + a 5 s timeout.
- **Argument input row**: identical chrome to the main input but indented under the parent command, with a leading `↳` glyph.

If a needed token does not yet exist in `src/styles/globals.css`, **add it** — do not inline hex/rgb (achromatic-color-policy + noTailwindUtilities tests both gate this).

### 5.3 Motion

- Open: 120 ms ease-out fade + 8px translateY rise; backdrop fades parallel.
- Close: 80 ms fade.
- Row hover/highlight: 60 ms ease-out bg.
- Subcommand push: 120 ms slide-left of list + slide-in of new list (respect `prefers-reduced-motion` → cross-fade only).
- No spinner: 240 ms after a provider starts, render a 6-row shimmer placeholder under its group; replace on resolve.

### 5.4 Accessibility

- `role="dialog"` + `aria-modal="true"` on the panel.
- Input has `aria-controls="spotlight-results"`, `aria-activedescendant` updated to the highlighted row's id.
- Result list is `role="listbox"`; rows are `role="option"` with `aria-selected`.
- `aria-label`s on rows include the trailing shortcut if any (`"Save · ⌘S"`).
- `prefers-reduced-motion` honored.
- Focus trap inside the panel; focus restored to the previously focused element on close (Dialog primitive already does this — we'll borrow its trap helper).
- High-contrast (1.6:1 trough, 4.5:1 text) verified against design tokens.

---

## 6. Plugin extensibility

### 6.1 What plugins already have

`editor.commands` permission + `api.editor.commands.register({ id, label, run })`. Currently those commands are invisible unless wired to a toolbar button. The palette flips the equation:

- **All registered `PluginCommand`s automatically appear** under the **"Plugin commands"** group when matching the query. No new API to be a basic palette citizen.

### 6.2 What we add

Three small additions, all gated behind the existing `editor.commands` permission:

```ts
// SDK addition — src/core/plugin-sdk/types.ts
export interface PluginPaletteCommand extends PluginCommand {
  /** Shown beneath the label. */
  subtitle?: string
  /** Pixel-art-icon name; falls back to a plug icon. */
  iconName?: string
  /** Extra search terms. */
  keywords?: string[]
  /** Optional shortcut hint — NOT auto-bound; informational only in v1. */
  shortcutLabel?: string
  /** Mark destructive — palette renders danger styling + inline confirm. */
  destructive?: boolean
  /** Declarative arguments collected in subcommand mode. */
  args?: PluginPaletteArg[]
  /** Show only on these workspaces. */
  workspaces?: ReadonlyArray<'site' | 'content' | 'data' | 'media' | 'plugins' | 'users' | 'account' | 'any'>
}

export interface PluginPaletteArg {
  id: string
  label: string
  type: 'text' | 'select'
  placeholder?: string
  options?: ReadonlyArray<{ value: string; label: string }>
}

export interface PluginPaletteProvider {
  id: string                              // namespaced: "<pluginId>.<name>"
  label: string                           // group header in results
  search: (query: string) => Promise<PluginPaletteResult[]>
}

export interface PluginPaletteResult {
  id: string
  title: string
  subtitle?: string
  iconName?: string
  run: () => void | Promise<void>
}

// SDK addition — EditorPluginApi
api.editor.palette = {
  registerCommand: (cmd: PluginPaletteCommand) => void
  registerProvider: (p: PluginPaletteProvider) => void
}
```

**Backward compat**: existing `PluginCommand` (id/label/run) keeps working — palette auto-coerces to `PluginPaletteCommand` with sensible defaults. No legacy shim, no breaking change required because the project is pre-release.

**Permission gating**:
- `editor.commands` is required for `registerCommand` and `registerProvider`.
- `admin.navigation` is **not** required — the palette is a runner, not a route registrant.
- Provider results are run inside `try/catch` and rate-limited (one in-flight provider call per provider id at a time).

**Plugin docs**: extend `docs/plugins/authoring.md` with a "Spotlight commands" section. Update the template plugin in `examples/plugins/template`.

### 6.3 Removing the static shortcuts table

`src/admin/modals/Settings/sections/ShortcutsSection.tsx` is rewritten to **render the registered command list grouped by category, showing only commands that have a `shortcut`**. Single source of truth. Hand-written list is deleted.

---

## 7. Performance

- **Index size**: ~150 host commands at full build-out. Searching that synchronously per keystroke is free; debouncing is only needed for *async providers*.
- **Async providers**: 150 ms debounce, per-provider `AbortController`, max one in-flight per provider.
- **Result caching**: query → result cache keyed `${providerId}:${query}` with a 30 s TTL; cleared when the spotlight is closed.
- **Render cost**: results virtualize after 30 rows using `IntersectionObserver`-based windowing (avoid pulling in `react-window` if our shapes are simple; otherwise allowlist `react-window` — decision deferred to implementation).
- **Bundle**: the spotlight chunk is lazy-loaded the first time `⌘K` is pressed; the global listener lives in a 1 KB stub that triggers the dynamic import. Lazy import means non-power-users pay zero on initial admin load.

---

## 8. Search & ranking algorithm

In-house, ~80 LOC, deterministic:

1. **Tokenize query** on whitespace.
2. For each candidate `Command`, compute a score:
   - **+1000** if query is a prefix of `title.toLowerCase()`.
   - **+500** per word-start match.
   - **+200** per token found as substring in `title`.
   - **+80** per token found as substring in `subtitle`.
   - **+40** per token in any `keywords[]`.
   - **+25** if the workspace matches `workspaces`.
   - **× priorityBoost** (default 1.0).
   - **+150** if in recent list (decayed by position).
   - **+250** if `when(ctx)` returns true.
   - **0** baseline (excluded from results).
3. Sort by score desc; break ties by `group` order then alphabetical.
4. Group adjacent same-group results under their group header.
5. Cap at 50 results.

Match-character highlighting is computed once per render using the same tokenization.

---

## 9. Implementation phases

### Phase 1 — Foundation

- `src/admin/spotlight/` skeleton.
- `SpotlightProvider`, global `⌘K`/`Ctrl+K` listener, `Spotlight` overlay, `SpotlightResults`, `SpotlightRow`.
- Matcher + recent store + footer hints.
- Mount in `AdminEntry.AuthenticatedAdmin` above `AdminSessionProvider`.
- Architecture test: spotlight may import `@admin/lib/routing` (it lives in `admin/`), banned in `editor/`/`core/`/`modules/`.
- Achromatic-color audit test for the new CSS module.

**Commands shipped:** navigation (workspace jumps), save, publish, undo, redo, sign out, open settings, open shortcuts. ~12 host commands.

### Phase 2 — Editor depth

- All editor commands: pages, layers, breakpoints, panels, framework, VCs, AI assistant.
- Subcommand / scope stack.
- Argument-input flow with `text` and `select`.
- Context-aware ranking (selection-dependent commands).
- Destructive inline-confirm.

### Phase 3 — Async providers

- Page / Content / Media / Data / Plugin admin page providers (server-side endpoints already exist for each — wire them).
- Debounce + `AbortController` + provider cache.
- Skeleton loading state.
- "Open file in code editor" via SiteFile list.

### Phase 4 — Plugin SDK

- Add `PluginPaletteCommand`, `PluginPaletteProvider`, `api.editor.palette.*` to the SDK.
- Surface all existing `PluginCommand`s under "Plugin commands" group.
- Update template plugin + `docs/plugins/authoring.md` + `docs/plugins/permissions.md`.
- Tests: plugin command runs from palette; provider results pass through.

### Phase 5 — Keybindings registry consolidation

- New `src/admin/spotlight/keybindings.ts` registry consumed by `PanelRail`, `CanvasRoot`, `usePersistence`, and the help scope.
- Delete `ShortcutsSection.tsx`'s hand-written list; replace with `<HelpKeybindingsList />` rendered from registry.
- Architecture test: `Cmd*` literals outside the registry are gated (best-effort grep test).

### Phase 6 — Polish

- Motion + `prefers-reduced-motion`.
- High-contrast review pass.
- E2E tests in `docs/e2e/` style using existing patterns.
- Telemetry (opt-in): which commands are used (anonymous, local-only) so we can promote pinned suggestions in a later phase.

### Phase 7 — Stretch (post-v1)

- **Pinned suggestions** (Phase 2 of empty-state).
- **Mobile bottom-sheet**.
- **Quick switch** (`⌘P` for pages, `⌘⇧P` for commands only) — separate but registry-shared.
- **AI fallback** — when no static match, offer "Ask AI: <query>" row that pipes into agentSlice.
- **Cross-workspace deep-link** — Cmd+K from Content can jump straight to "open this page in the editor".
- **Command result types beyond run** — e.g., return a preview panel for a media file.

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Keyboard collisions with editor shortcuts | Centralized registry + per-handler guards; palette swallows global keys while open |
| Performance regressions on async providers | Debounce, cache, cancel; provider budget capped at 25 results |
| Plugin commands throwing | Existing `pluginRuntime.runCommand` already wraps in try/catch; toast on error |
| Accidental destructive runs | `destructive: true` enforces inline confirm + 5 s timeout |
| Scope creep | Phases enforce ordering — Phase 1 ships independently |
| Visual drift from achromatic policy | New CSS module lives under the architecture test set — `noTailwindUtilities.test.ts` + `achromatic-color-policy.test.ts` cover it automatically |
| Bundle bloat | Lazy-loaded chunk; ~10 KB gzipped target |

---

## 11. Architecture test additions

- `spotlight-no-direct-store-mutation.test.ts` — assert `src/admin/spotlight/commands/*` only call existing store actions, never `set(...)` directly.
- `spotlight-allowed-router-import.test.ts` — extends `no-router-in-editor.test.ts` to whitelist `admin/spotlight/`.
- `keybindings-registry-single-source.test.ts` (Phase 5) — assert every `kbd` rendered in the help screen flows from the registry.

---

## 12. Deliverables checklist

- [x] Spotlight overlay + matcher + recent store
- [x] Global `⌘K` listener, lazy-loaded chunk
- [x] All host commands above (Section 4)
- [x] Async providers for pages/content/media/data/plugin pages
- [x] Subcommand scopes + argument flow
- [x] Destructive confirm
- [x] Plugin SDK extension + docs + example
- [x] Help scope replacing static shortcuts list
- [x] CSS module + a11y pass + reduced-motion
- [x] Architecture tests
- [x] E2E test coverage in `docs/e2e/` style
- [x] `bun test` / `bun run build` / `bun run lint` green

## 12.1 What landed (per phase)

- **Phase 1 — Foundation:** `src/admin/spotlight/` scaffold (47 files), in-house matcher, recent store, global ⌘K listener with lazy import, mount in `AdminEntry`, 2 new architecture tests.
- **Phase 2 — Editor depth:** 11 command catalogs (pages, layers, panels, breakpoints, framework, VCs, AI, preview, settings, help, account), 3 dynamic scopes, full arg-input flow, destructive inline confirm with 5 s timeout, `PREFERENCE_CATALOG`-derived toggles (no hand-mirroring), 24 new state reducer tests.
- **Phase 3 — Async providers:** 6 providers (pages local, content/media/data/plugin pages async, siteFiles local for code editor scope), `ProviderRunner` with debounce/abort/30 s cache, TypeBox response schemas, server-side `?query=` params added to media + data endpoints (+ a new `/admin/api/cms/data/search` route), 240 ms skeleton shimmer with `prefers-reduced-motion` awareness. `react-window` NOT added (per-provider 25-cap kept rendering cheap).
- **Phase 4 — Plugin SDK:** Extended `PluginCommand` directly with optional palette fields (`PluginPaletteCommand` is a type alias, not a parallel hierarchy), `api.editor.palette.{registerCommand,registerProvider}` gated on existing `editor.commands` permission, auto-surfacing of every registered command, template plugin demonstrates all three levels, docs updated, 16 new tests.
- **Phase 5 — Keybindings registry consolidation:** New `keybindings.ts` registry (17 bindings) is the single source of truth. `Command.shortcut` field dropped entirely (option b). `ShortcutsSection` hand-written table DELETED and replaced with `HelpKeybindingsList` reading from the registry. `PanelRail`, `CanvasRoot`, `usePersistence`, `SpotlightProvider` all match via registry predicates. `useShortcutHint` hook applied to existing tooltips/aria-labels. New `keybindings-registry-single-source.test.ts` gates both inline matchers and hand-written symbol renderers.
- **Phase 6 — Polish:** Motion (120 ms open / 80 ms close / 60 ms row / 120 ms scope slide), full `prefers-reduced-motion` gating, `prefers-contrast: more` outline fallback, stable listbox id for `aria-activedescendant`, `role=alert` live region for destructive confirm announcement, opt-in local-only telemetry (default off, key `spotlight:telemetry:v1`, top 200 cap), "Clear command history" button in Preferences, 13-scenario E2E test plan in `docs/e2e/spotlight.md`, 15-test a11y unit file. Pre-release sweep clean.

---

## 13. Pre-release reminders for the implementer

These come from `CLAUDE.md` and override defaults:

1. **No backward-compat shims.** If renaming `PluginCommand` to absorb palette fields is cleaner, do it everywhere in one change.
2. **Fix at source.** If `ShortcutsSection.tsx`'s shape is wrong, delete it and regenerate; don't paper over it.
3. **TypeBox at every boundary.** Provider results coming from `/api/cms/*` must be parsed through `parseJsonResponse` with explicit schemas.
4. **No zod, no clsx, no tailwind, no inline SVG, no `cmdk`, no lucide-react.** Architecture tests will fail otherwise.
5. **`bun run build` runs `tsc -b && vite build`.** Both must pass for the implementer's own changes.
6. **Run `bun test`, `bun run build`, `bun run lint` once at the end** — pre-existing parallel-session failures unrelated to spotlight are not the implementer's problem; note them and move on.
7. **Achromatic CSS only** in new modules; add design tokens in `src/styles/globals.css` if missing.
8. **CSS Modules + tokens**, file naming `Component.module.css`, camelCase classnames, no `!important`.
9. **`Button` and other UI primitives must be used** — no bare `<button>`.
10. **Icons from `pixel-art-icons/icons/<name>`** — deep import, never barrel.
