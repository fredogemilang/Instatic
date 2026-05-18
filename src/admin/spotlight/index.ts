/**
 * spotlight — public module exports.
 *
 * Import from '@admin/spotlight' to access the provider, hooks, and the
 * keybindings registry.
 *
 * The heavy dialog chunk (Spotlight.tsx, SpotlightResults.tsx, …) is
 * lazy-loaded on first ⌘K press via React.lazy inside SpotlightProvider.
 */

export { SpotlightProvider } from './SpotlightProvider'
export { useSpotlight } from './useSpotlight'
export { useShortcutHint } from './useShortcutHint'
export type { SpotlightControls } from './useSpotlight'
export type {
  Command,
  CommandId,
  CommandGroup,
  CommandShortcut,
  CommandArg,
  CommandContext,
  CommandRunContext,
  Scope,
  SpotlightProvider as SpotlightProviderType,
  ActiveDocument,
} from './types'
export {
  KEYBINDINGS,
  getKeybindingForCommand,
  formatShortcut,
  isPlatformMac,
} from './keybindings'
export type { KeybindingDefinition, KeyEventLike } from './keybindings'
