/**
 * Spotlight state machine — §3.4 of the Command Spotlight master plan.
 *
 * A useReducer atom (not a Zustand slice) so spotlight state is isolated from
 * the editor store. The reducer is pure — all side effects live in the host
 * component (SpotlightProvider).
 *
 * Phase 2 additions:
 *   - argMode: tracks argument-collection flow for commands with args
 *   - pendingConfirm: tracks first-Enter on a destructive command (5 s window)
 */

import type { Command, ScopeFrame } from './types'

// ─── Arg mode ─────────────────────────────────────────────────────────────────

/**
 * State captured while collecting arguments for a command.
 * `argIndex` is the index of the arg currently being filled.
 * `values` holds all previously completed arg values keyed by arg.id.
 */
export interface ArgModeState {
  command: Command
  argIndex: number
  values: Record<string, string>
}

// ─── State ────────────────────────────────────────────────────────────────────

export type SpotlightPhase = 'closed' | 'open'

export interface SpotlightOpenState {
  phase: 'open'
  query: string
  /** Stack of active scopes; top of stack = active scope. Default: ['root']. */
  scopeStack: ScopeFrame[]
  highlightedIndex: number
  /** Async provider results keyed by providerId (Phase 3). */
  asyncResults: Record<string, Command[]>
  /** Provider ids currently in-flight (Phase 3). */
  loadingProviders: Set<string>
  /**
   * Phase 2: Arg-collection mode. Non-null when a command with `args` has been
   * selected and we're collecting one argument at a time via the input.
   */
  argMode: ArgModeState | null
  /**
   * Phase 2: ID of the destructive command awaiting a second Enter to confirm.
   * Cleared by CLEAR_PENDING_CONFIRM (timeout or Escape or second Enter runs).
   */
  pendingConfirm: string | null
}

export type SpotlightState =
  | { phase: 'closed' }
  | SpotlightOpenState

// ─── Actions ─────────────────────────────────────────────────────────────────

export type SpotlightAction =
  | { type: 'OPEN' }
  | { type: 'CLOSE' }
  | { type: 'TOGGLE' }
  | { type: 'SET_QUERY'; query: string }
  | { type: 'SET_HIGHLIGHTED'; index: number }
  | { type: 'HIGHLIGHT_NEXT' }
  | { type: 'HIGHLIGHT_PREV' }
  | { type: 'PUSH_SCOPE'; scopeId: string; pendingArgs?: Record<string, string> }
  | { type: 'POP_SCOPE' }
  | { type: 'SET_ASYNC_RESULTS'; providerId: string; results: Command[] }
  | { type: 'SET_LOADING_PROVIDER'; providerId: string; loading: boolean }
  /** Phase 3: reset all async results and loading state (scope change / close). */
  | { type: 'ASYNC_RESET' }
  | { type: 'RESULT_COUNT_CHANGED'; count: number }
  // ── Phase 2: Arg mode ────────────────────────────────────────────────────
  | { type: 'ENTER_ARG_MODE'; command: Command }
  | { type: 'SAVE_ARG_AND_ADVANCE'; argId: string; value: string }
  | { type: 'BACK_ARG' }
  | { type: 'EXIT_ARG_MODE' }
  // ── Phase 2: Destructive confirm ─────────────────────────────────────────
  | { type: 'SET_PENDING_CONFIRM'; commandId: string }
  | { type: 'CLEAR_PENDING_CONFIRM' }

// ─── Initial state ────────────────────────────────────────────────────────────

export const initialState: SpotlightState = { phase: 'closed' }

function makeOpenState(): SpotlightOpenState {
  return {
    phase: 'open',
    query: '',
    scopeStack: [{ scopeId: 'root', pendingArgs: {} }],
    highlightedIndex: 0,
    asyncResults: {},
    loadingProviders: new Set(),
    argMode: null,
    pendingConfirm: null,
  }
}

// ─── Reducer ──────────────────────────────────────────────────────────────────

export function spotlightReducer(
  state: SpotlightState,
  action: SpotlightAction,
): SpotlightState {
  switch (action.type) {
    case 'OPEN':
      if (state.phase === 'open') return state
      return makeOpenState()

    case 'CLOSE':
      return { phase: 'closed' }

    case 'TOGGLE':
      return state.phase === 'closed' ? makeOpenState() : { phase: 'closed' }

    case 'SET_QUERY': {
      if (state.phase !== 'open') return state
      return { ...state, query: action.query, highlightedIndex: 0 }
    }

    case 'SET_HIGHLIGHTED': {
      if (state.phase !== 'open') return state
      return { ...state, highlightedIndex: action.index }
    }

    case 'HIGHLIGHT_NEXT': {
      if (state.phase !== 'open') return state
      return { ...state, highlightedIndex: state.highlightedIndex + 1 }
    }

    case 'HIGHLIGHT_PREV': {
      if (state.phase !== 'open') return state
      return {
        ...state,
        highlightedIndex: Math.max(0, state.highlightedIndex - 1),
      }
    }

    case 'PUSH_SCOPE': {
      if (state.phase !== 'open') return state
      const frame: ScopeFrame = {
        scopeId: action.scopeId,
        pendingArgs: action.pendingArgs ?? {},
      }
      return {
        ...state,
        query: '',
        highlightedIndex: 0,
        scopeStack: [...state.scopeStack, frame],
        argMode: null,
        pendingConfirm: null,
        // Phase 3: clear async state on scope change so stale results from the
        // previous scope don't bleed into the new one.
        asyncResults: {},
        loadingProviders: new Set(),
      }
    }

    case 'POP_SCOPE': {
      if (state.phase !== 'open') return state
      if (state.scopeStack.length <= 1) return state
      return {
        ...state,
        query: '',
        highlightedIndex: 0,
        scopeStack: state.scopeStack.slice(0, -1),
        argMode: null,
        pendingConfirm: null,
        // Phase 3: clear async state on scope change.
        asyncResults: {},
        loadingProviders: new Set(),
      }
    }

    case 'SET_ASYNC_RESULTS': {
      if (state.phase !== 'open') return state
      const newLoading = new Set(state.loadingProviders)
      newLoading.delete(action.providerId)
      return {
        ...state,
        asyncResults: { ...state.asyncResults, [action.providerId]: action.results },
        loadingProviders: newLoading,
      }
    }

    case 'SET_LOADING_PROVIDER': {
      if (state.phase !== 'open') return state
      const newLoading = new Set(state.loadingProviders)
      if (action.loading) {
        newLoading.add(action.providerId)
      } else {
        newLoading.delete(action.providerId)
      }
      return { ...state, loadingProviders: newLoading }
    }

    case 'ASYNC_RESET': {
      if (state.phase !== 'open') return state
      return { ...state, asyncResults: {}, loadingProviders: new Set() }
    }

    case 'RESULT_COUNT_CHANGED': {
      if (state.phase !== 'open') return state
      // Clamp highlighted index when result count shrinks. Critical: return
      // the SAME state reference when nothing changes — otherwise consumers
      // that re-dispatch on every render (e.g. SpotlightResults' count-sync
      // effect) cause an infinite re-render loop. The reducer is the single
      // place we can guarantee referential stability here.
      const next = Math.min(
        state.highlightedIndex,
        Math.max(0, action.count - 1),
      )
      if (next === state.highlightedIndex) return state
      return { ...state, highlightedIndex: next }
    }

    // ── Phase 2: Arg mode ────────────────────────────────────────────────────

    case 'ENTER_ARG_MODE': {
      if (state.phase !== 'open') return state
      if (!action.command.args || action.command.args.length === 0) return state
      return {
        ...state,
        query: '',
        highlightedIndex: 0,
        argMode: { command: action.command, argIndex: 0, values: {} },
        pendingConfirm: null,
      }
    }

    case 'SAVE_ARG_AND_ADVANCE': {
      if (state.phase !== 'open' || !state.argMode) return state
      const { command, argIndex, values } = state.argMode
      const args = command.args ?? []
      const newValues = { ...values, [action.argId]: action.value }
      const nextIndex = argIndex + 1

      if (nextIndex >= args.length) {
        // All args collected — caller is responsible for running the command.
        // We keep argMode alive with values so the caller can read them.
        // The caller dispatches EXIT_ARG_MODE after running.
        return {
          ...state,
          query: '',
          highlightedIndex: 0,
          argMode: { command, argIndex: nextIndex, values: newValues },
        }
      }

      return {
        ...state,
        query: '',
        highlightedIndex: 0,
        argMode: { command, argIndex: nextIndex, values: newValues },
      }
    }

    case 'BACK_ARG': {
      if (state.phase !== 'open' || !state.argMode) return state
      const { argIndex } = state.argMode
      if (argIndex <= 0) {
        // Back past the first arg — exit arg mode, back to command list
        return { ...state, query: '', highlightedIndex: 0, argMode: null }
      }
      // Step back one arg
      return {
        ...state,
        query: '',
        highlightedIndex: 0,
        argMode: { ...state.argMode, argIndex: argIndex - 1 },
      }
    }

    case 'EXIT_ARG_MODE': {
      if (state.phase !== 'open') return state
      return { ...state, query: '', highlightedIndex: 0, argMode: null }
    }

    // ── Phase 2: Destructive confirm ─────────────────────────────────────────

    case 'SET_PENDING_CONFIRM': {
      if (state.phase !== 'open') return state
      return { ...state, pendingConfirm: action.commandId }
    }

    case 'CLEAR_PENDING_CONFIRM': {
      if (state.phase !== 'open') return state
      return { ...state, pendingConfirm: null }
    }
  }
}
