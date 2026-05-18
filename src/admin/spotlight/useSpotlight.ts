/**
 * useSpotlight — hook to open/close spotlight and push/pop scopes.
 *
 * Must be used inside <SpotlightProvider>. Provides access to:
 *   - `state` — current SpotlightState (phase, query, highlightedIndex, …)
 *   - `open()` — open the spotlight
 *   - `close()` — close the spotlight
 *   - `toggle()` — toggle open/closed
 *   - `pushScope(id, args?)` — drill into a sub-scope (Phase 2)
 *   - `popScope()` — go back to parent scope (Phase 2)
 */

import { useContext } from 'react'
import { SpotlightContext } from './spotlightContext'
import type { SpotlightState } from './state'

export interface SpotlightControls {
  state: SpotlightState
  open: () => void
  close: () => void
  toggle: () => void
  pushScope: (scopeId: string, args?: Record<string, string>) => void
  popScope: () => void
}

export function useSpotlight(): SpotlightControls {
  const ctx = useContext(SpotlightContext)
  if (!ctx) {
    throw new Error('useSpotlight must be used inside <SpotlightProvider>')
  }
  return ctx
}
