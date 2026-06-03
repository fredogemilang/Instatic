# Canvas Notch Favorites Design

This spec defines server-backed favorites for the Site editor's canvas notch shortcuts.

Canvas notch favorites let each admin choose which module inserter items appear as one-click shortcuts in the notch. The default remains Container, Text, and Image, but users can favorite any insertable item exposed by the full module inserter: registry modules, layout presets, and Visual Components.

---

## TL;DR

- Favorites are a per-user server preference in `user_preferences`, not localStorage.
- The stored shape is an ordered array of module inserter refs: `{ kind, id }`.
- Default favorites are `base.container`, `base.text`, and `base.image`.
- `CanvasNotch` resolves stored refs against the same item model as `ModuleInserterDialog`, so it never duplicates picker filtering or icon logic.
- The full module inserter gets a favorite toggle on each insertable item. Toggling does not insert the item.
- Missing favorites, such as a deleted Visual Component, are skipped at render time and removed only when the user next saves favorites.

## Current State

`src/admin/pages/site/canvas/CanvasNotch.tsx` hardcodes `QUICK_ACTION_MODULE_IDS` to:

```ts
base.container
base.text
base.image
```

The notch renders those module buttons through `ModuleIcon` and inserts through `useInsertModule`.

The full module inserter lives in `src/admin/pages/site/module-picker/ModuleInserterDialog.tsx`. It already builds a single item list from:

- Modules from `registry.list()`, filtered by `getInsertableModuleItems`.
- Layouts from `LAYOUT_PRESETS`.
- Visual Components from `site.visualComponents`.
- Recents from local `instatic-module-inserter-v1` preferences.

`src/admin/pages/site/module-picker/moduleInserterModel.ts` already has the right portable reference shape via `ModuleInserterRecentRef` and `recentKey(ref)`. That shape should be generalized to insertion item refs instead of creating a parallel notch-only type.

Server-side user preferences already exist:

- Schema and client helpers: `src/core/persistence/userPreferences.ts`.
- HTTP handler: `server/handlers/cms/userPreferences.ts`.
- Repository: `server/repositories/userPreferences.ts`.
- Storage table: `user_preferences (user_id, key, value_json, updated_at)`.

## Data Model

Add a new user preference key:

```ts
module-inserter
```

Add a value schema in `src/core/persistence/userPreferences.ts`:

```ts
type ModuleInserterItemRef = {
  kind: 'module' | 'layout' | 'component' | 'community'
  id: string
}

type ModuleInserterPreference = {
  favorites: ModuleInserterItemRef[]
}
```

The default value is:

```ts
{
  favorites: [
    { kind: 'module', id: 'base.container' },
    { kind: 'module', id: 'base.text' },
    { kind: 'module', id: 'base.image' },
  ],
}
```

The schema validates shape only. It does not validate that referenced modules, layouts, or components currently exist because the available item set is user/site/context dependent.

The preference is ordered. The notch renders favorites in stored order.

Use a maximum item count in the TypeBox schema to prevent unbounded rows. A limit of 12 is enough for this chrome; the UI should naturally keep the list much shorter, but the boundary should still cap it.

## Client Preference Hook

Add a site editor hook:

```text
src/admin/pages/site/module-picker/useModuleInserterPreference.ts
```

Responsibilities:

- Load `getUserPreference('module-inserter')` on mount.
- Start with `DEFAULT_MODULE_INSERTER_PREFERENCE` for immediate rendering.
- Save changes with `setUserPreference('module-inserter', next)`.
- Expose `favorites`, `isFavorite(ref)`, `toggleFavorite(ref)`, `setFavorites(refs)`, `loading`, and `error`.
- Deduplicate refs by `recentKey(ref)`.
- Preserve order when toggling existing favorites off and append newly favorited items to the end.

The hook should log API failures with:

```ts
console.error('[module-inserter] failed to load user preference:', err)
console.error('[module-inserter] failed to save user preference:', err)
```

Loading or saving failure should not block insertion. The UI continues with the current in-memory favorites and default favorites when no server value is available.

## Shared Item Resolution

Extract the item-building logic currently embedded in `ModuleInserterDialog` into `buildModuleInserterItems(...)` in `src/admin/pages/site/module-picker/moduleInserterModel.ts`.

The helper should accept:

- registry modules,
- Visual Components,
- active document mode,
- layout presets.

It returns:

- module items,
- layout items,
- component items,
- all insertable items,
- recent/favorite resolver helpers.

This keeps `CanvasNotch` and `ModuleInserterDialog` on the same source of truth.

Do not make `CanvasNotch` import the full dialog. It should consume the lightweight model and preference hook, then render icon-only buttons.

## Module Inserter UI

Add a favorite toggle to `ModuleInserterItemButton`.

Behavior:

- The toggle uses a pixel-art icon button inside each tile/list row.
- Clicking it stops propagation and does not call `onPick`.
- It has `aria-pressed` and an accessible label such as `Add Text to notch favorites` or `Remove Text from notch favorites`.
- The selected/favorited visual state uses existing rail-tint accent variables and editor surface tokens.
- It appears for modules, layouts, and components. Community rows are not active until the community catalog exists.

The full dialog remains the management surface. No separate settings modal is needed for the first version.

## Canvas Notch

Replace the hardcoded default actions with resolved favorites.

For each resolved favorite:

- `kind: 'module'` inserts through `useInsertModule`.
- `kind: 'layout'` inserts through `useInsertPreset`.
- `kind: 'component'` inserts through `insertComponentRef` with the same `resolveInsertLocation` behavior as `ModulePickerDropdown`.
- `kind: 'community'` is ignored until community insertion exists.

Icons:

- Modules continue to use `ModuleIcon`.
- Layouts use the same layout icon as `ModuleInserterItemButton`.
- Components use the same component icon as `ModuleInserterItemButton`.

Test ids should remain stable where possible:

- Default Text should still be reachable as `canvas-notch-text-btn`.
- Other labels follow the existing label-derived pattern.
- The add button remains `canvas-notch-add-btn`.

If all stored favorites are missing, the notch falls back to the default favorites so users are never left with an empty shortcut strip.

## Error Handling

Boundaries use TypeBox:

- Preference schema in `src/core/persistence/userPreferences.ts`.
- Server handler reuses the existing whitelist and per-key validation.
- Client reads use `getUserPreference('module-inserter')`; writes use `setUserPreference('module-inserter', next)`.

Runtime missing references are not errors. They can happen when:

- A Visual Component was deleted.
- A plugin/community module is unavailable.
- A layout preset was renamed before release.

The resolver skips those refs in the rendered notch and picker favorite state.

## Documentation

Update:

- `docs/editor.md` — document that the notch shortcuts are user favorites backed by `user_preferences`.
- `docs/reference/persistence-keys.md` — add the `module-inserter` server-side preference key.

No database migration is needed because the `user_preferences` table stores flexible per-key `value_json`; the whitelist and schema define the new key.

## Testing

Use TDD for implementation.

Unit tests:

- `src/__tests__/toolbar/moduleInserterModel.test.ts` covers favorite ref deduping and resolution.
- Add `src/__tests__/persistence/userPreferences.test.ts` to cover `module-inserter` schema validation and HTTP helper behavior.

Component tests:

- Add `src/__tests__/toolbar/moduleInserterFavorites.test.tsx` to verify favorite toggle behavior does not insert.
- `src/__tests__/canvas/canvasNotch.integration.test.tsx` verifies default favorites still insert and a changed favorite list changes notch actions.

Architecture/source tests:

- Update `src/__tests__/canvas/canvasNotch.test.ts` so it no longer expects hardcoded quick insert IDs in `CanvasNotch.tsx`; it should assert the default preference source instead.

End-of-task verification:

```sh
bun test
bun run build
bun run lint
```
