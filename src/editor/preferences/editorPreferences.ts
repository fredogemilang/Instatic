/**
 * Editor preferences — runtime read/write for the catalog of local UI prefs.
 *
 * The schema, defaults, and the live React hook are all derived from the
 * declarative `PREFERENCE_CATALOG` (see `./catalog.ts`). Adding a new
 * preference is a single catalog entry — this file does not need to change.
 *
 * Reactivity model
 * ----------------
 * Two layers:
 *   1. `subscribeToEditorPrefsChanged()` — low-level event bus used by
 *      non-React consumers (e.g. `usePersistence.ts`'s scheduler) that need to
 *      react to changes imperatively.
 *   2. `useEditorPreference(id)` — React hook that reads a value, subscribes
 *      to the bus, and re-renders when the value changes. This is the
 *      preferred path for components.
 *
 * Cross-tab updates: the `storage` event re-fires our local listeners so
 * editors open in two tabs stay in sync.
 */

import { Type, type Static } from '@sinclair/typebox'
import { useEffect, useState } from 'react'
import { parseJsonWithFallback } from '@core/utils/jsonValidate'
import {
  PREFERENCE_CATALOG,
  defaultBooleanFor,
  defaultSelectFor,
  type BooleanPreferenceId,
  type SelectPreferenceId,
} from './catalog'

export const EDITOR_PREFS_KEY = 'pb-editor-prefs'
const EDITOR_PREFS_CHANGED_EVENT = 'pb-editor-prefs-changed'

// ---------------------------------------------------------------------------
// Schema and defaults — derived from the catalog
//
// Every catalog entry contributes one optional field to the schema (we accept
// missing fields so older snapshots don't crash newer readers) and one entry
// in DEFAULT_EDITOR_PREFS. `additionalProperties: true` keeps the door open
// for fields written by future builds without rejecting them on parse.
// ---------------------------------------------------------------------------

const schemaFields: Record<string, ReturnType<typeof Type.Optional>> = {}
for (const def of PREFERENCE_CATALOG) {
  if (def.type === 'boolean') {
    schemaFields[def.id] = Type.Optional(Type.Boolean())
  } else if (def.type === 'select' || def.type === 'select-dynamic') {
    schemaFields[def.id] = Type.Optional(Type.String())
  }
}

const EditorPrefsSchema = Type.Object(schemaFields, {
  additionalProperties: true,
})

type EditorPrefs = Static<typeof EditorPrefsSchema>

const DEFAULT_EDITOR_PREFS: Required<EditorPrefs> = (() => {
  const acc: Record<string, boolean | string> = {}
  for (const def of PREFERENCE_CATALOG) {
    if (def.type === 'boolean') acc[def.id] = def.default
    else if (def.type === 'select' || def.type === 'select-dynamic') {
      acc[def.id] = def.default
    }
  }
  return acc as Required<EditorPrefs>
})()

// ---------------------------------------------------------------------------
// Storage IO
// ---------------------------------------------------------------------------

function readEditorPrefs(): EditorPrefs {
  const raw = globalThis.localStorage?.getItem(EDITOR_PREFS_KEY) ?? null
  return parseJsonWithFallback(raw, EditorPrefsSchema, DEFAULT_EDITOR_PREFS)
}

function writeEditorPrefs(next: EditorPrefs): void {
  try {
    globalThis.localStorage?.setItem(EDITOR_PREFS_KEY, JSON.stringify(next))
    notifyEditorPrefsChanged()
  } catch {
    // localStorage may be unavailable (private mode, quota, etc.). Editor
    // preferences are best-effort UI state; failing the write is benign.
  }
}

// ---------------------------------------------------------------------------
// Generic getters / setters keyed by catalog id
//
// Two flavours: boolean and string (for select / select-dynamic). Each is
// strongly typed against the catalog so calling
//   readEditorPreference('autoSaveDelay')   // string preference id
// against the boolean variant is a compile error.
// ---------------------------------------------------------------------------

/** Read a single boolean preference, falling back to the catalog default. */
function readEditorPreference(id: BooleanPreferenceId): boolean {
  const prefs = readEditorPrefs() as Record<string, unknown>
  const value = prefs[id]
  return typeof value === 'boolean' ? value : defaultBooleanFor(id)
}

/** Persist a single boolean preference and broadcast a change event. */
export function setEditorPreference(id: BooleanPreferenceId, value: boolean): void {
  const current = readEditorPrefs()
  writeEditorPrefs({ ...current, [id]: value })
}

/** Read a select / select-dynamic preference, falling back to the catalog default. */
export function readEditorSelectPreference(id: SelectPreferenceId): string {
  const prefs = readEditorPrefs() as Record<string, unknown>
  const value = prefs[id]
  return typeof value === 'string' && value.length > 0 ? value : defaultSelectFor(id)
}

/** Persist a select / select-dynamic preference and broadcast a change event. */
export function setEditorSelectPreference(id: SelectPreferenceId, value: string): void {
  const current = readEditorPrefs()
  writeEditorPrefs({ ...current, [id]: value })
}

// ---------------------------------------------------------------------------
// Named convenience getters
//
// These wrap `readEditorPreference` for callers that aren't React components
// (auto-save scheduler, etc.) and for the architecture gate test in
// selectorStability.test.ts which asserts `readAutoSavePreference` is the
// callsite the persistence hook uses.
// ---------------------------------------------------------------------------

export function readAutoSavePreference(): boolean {
  return readEditorPreference('autoSave')
}

/**
 * Read the auto-save delay preference as milliseconds. The catalog stores the
 * delay in seconds (string) for UI presentation; this function does the
 * conversion to ms so callers don't repeat the parse logic.
 */
export function readAutoSaveDelayMs(): number {
  const seconds = Number(readEditorSelectPreference('autoSaveDelay'))
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000
}

// ---------------------------------------------------------------------------
// Event bus
// ---------------------------------------------------------------------------

function notifyEditorPrefsChanged(): void {
  try {
    globalThis.window?.dispatchEvent(new Event(EDITOR_PREFS_CHANGED_EVENT))
  } catch {
    // Preferences are best-effort local UI state.
  }
}

export function subscribeToEditorPrefsChanged(listener: () => void): () => void {
  const win = globalThis.window
  if (!win) return () => {}

  const handleStorage = (event: StorageEvent) => {
    if (event.key === EDITOR_PREFS_KEY) listener()
  }

  win.addEventListener(EDITOR_PREFS_CHANGED_EVENT, listener)
  win.addEventListener('storage', handleStorage)
  return () => {
    win.removeEventListener(EDITOR_PREFS_CHANGED_EVENT, listener)
    win.removeEventListener('storage', handleStorage)
  }
}

// ---------------------------------------------------------------------------
// React hook
//
// Components subscribe to a single preference and re-render whenever it
// changes (including from another browser tab). The hook is intentionally
// scoped to one preference per call so React's dependency tracking stays
// trivial — multiple prefs in one component is just multiple hook calls.
// ---------------------------------------------------------------------------

export function useEditorPreference(id: BooleanPreferenceId): boolean {
  // useState initializer reads the freshest value from localStorage. The
  // subscription below keeps the component in sync with subsequent changes
  // (same tab via the custom event, other tabs via the `storage` event).
  const [value, setValue] = useState<boolean>(() => readEditorPreference(id))

  useEffect(() => {
    return subscribeToEditorPrefsChanged(() => {
      setValue(readEditorPreference(id))
    })
  }, [id])

  return value
}

/** React hook for a select / select-dynamic preference. */
export function useEditorSelectPreference(id: SelectPreferenceId): string {
  const [value, setValue] = useState<string>(() => readEditorSelectPreference(id))

  useEffect(() => {
    return subscribeToEditorPrefsChanged(() => {
      setValue(readEditorSelectPreference(id))
    })
  }, [id])

  return value
}
