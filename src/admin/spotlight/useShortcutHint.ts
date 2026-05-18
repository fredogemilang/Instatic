/**
 * useShortcutHint — returns the platform-aware shortcut label for a given
 * commandId, or undefined when no keybinding is registered for that command.
 *
 * Uses the keybindings registry as the single source of truth.
 *
 * Example:
 *   const hint = useShortcutHint('editor.save')
 *   // → '⌘S' on Mac, 'Ctrl+S' on Windows
 *   <Button tooltip={hint ? `Save (${hint})` : 'Save'}>
 *
 * This is a plain function (not a React hook) because the registry is static
 * and never changes at runtime — no hook machinery is needed. The name retains
 * the hook convention so call sites can upgrade to a proper hook if the
 * registry ever becomes reactive.
 */

import type { CommandId } from './types'
import { getKeybindingForCommand, formatShortcut } from './keybindings'

/**
 * Returns the platform-aware shortcut label (e.g. "⌘S") for the given
 * commandId, or `undefined` if no keybinding is registered.
 */
export function useShortcutHint(commandId: CommandId): string | undefined {
  const kb = getKeybindingForCommand(commandId)
  return kb ? formatShortcut(kb.shortcut) : undefined
}
