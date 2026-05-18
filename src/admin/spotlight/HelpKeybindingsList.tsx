/**
 * HelpKeybindingsList — generated keyboard shortcuts reference.
 *
 * Reads from KEYBINDINGS (keybindings.ts) and joins each entry to its
 * Command definition via getAllCommands(). Grouped by scope.
 *
 * This component replaces the hand-written SHORTCUTS table that used to live
 * in ShortcutsSection.tsx. Single source of truth: adding a new binding to
 * keybindings.ts automatically surfaces it here — no manual list maintenance.
 *
 * Used by: src/admin/modals/Settings/sections/ShortcutsSection.tsx
 */

import { useMemo, type ReactNode } from 'react'
import { KEYBINDINGS, isPlatformMac } from './keybindings'
import type { KeybindingDefinition } from './keybindings'
import { getAllCommands } from './commandRegistry'
import styles from './HelpKeybindingsList.module.css'

// ─── Scope grouping ───────────────────────────────────────────────────────────

type Scope = KeybindingDefinition['scope']

const SCOPE_ORDER: ReadonlyArray<Scope> = ['global', 'editor', 'canvas', 'panels']

const SCOPE_LABELS: Record<Scope, string> = {
  global:  'Global',
  editor:  'Editor',
  canvas:  'Canvas',
  panels:  'Panels',
}

// ─── Shortcut badge ───────────────────────────────────────────────────────────
// Splits a shortcut label on modifier symbols and "+" separators for display.

function ShortcutBadge({ label }: { label: string }): ReactNode {
  // Split on modifier symbols, or between alphanumeric and uppercase transitions.
  const parts = label
    .split(/(?=[⌘⌥⌃⇧])|(?<=[\w])(?=[A-Z+])|[+]/)
    .filter(Boolean)
  return (
    <span className={styles.shortcutHint} aria-hidden="true">
      {parts.map((part, i) => (
        <kbd key={i} className={styles.kbd}>{part}</kbd>
      ))}
    </span>
  )
}

// ─── HelpKeybindingsList ──────────────────────────────────────────────────────

export function HelpKeybindingsList(): ReactNode {
  const isMac = isPlatformMac()

  // Build commandId → title lookup once.
  const commandTitleMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const cmd of getAllCommands()) {
      map.set(cmd.id, cmd.title)
    }
    return map
  }, [])

  // Group bindings by scope in the defined order.
  const grouped = useMemo<Map<Scope, KeybindingDefinition[]>>(() => {
    const map = new Map<Scope, KeybindingDefinition[]>()
    for (const scope of SCOPE_ORDER) {
      map.set(scope, [])
    }
    for (const kb of KEYBINDINGS) {
      map.get(kb.scope)?.push(kb)
    }
    return map
  }, [])

  return (
    <div className={styles.list}>
      {SCOPE_ORDER.map((scope) => {
        const bindings = grouped.get(scope) ?? []
        if (bindings.length === 0) return null

        return (
          <section key={scope} className={styles.section}>
            <h4 className={styles.sectionTitle}>{SCOPE_LABELS[scope]}</h4>

            {bindings.map((kb) => {
              // Prefer the command title from the registry; fall back to
              // displayName (for virtual bindings like 'spotlight.open'), then
              // the raw commandId.
              const title =
                commandTitleMap.get(kb.commandId) ??
                kb.displayName ??
                kb.commandId

              const shortcutLabel = isMac ? kb.shortcut.mac : kb.shortcut.win

              return (
                <div key={kb.commandId} className={styles.row}>
                  <span className={styles.rowTitle}>{title}</span>
                  <ShortcutBadge label={shortcutLabel} />
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
