/**
 * Agent store slice — drives the AI Assistant panel.
 *
 * The browser opens a streaming NDJSON request against AGENT_API_PATH (the
 * Vite proxy forwards to the local Bun agent server, which runs the Claude
 * Agent SDK with ambient Claude Code credentials — Constraint #385).
 *
 * Wire protocol (server → browser, NDJSON, one ServerStreamEvent per line):
 *   bridgeReady   first event; carries bridgeId for tool-result POSTs
 *   text          chunk of assistant text
 *   toolStatus    SDK tool-call lifecycle (read + write tools)
 *   toolRequest   server asks the browser to apply a write tool
 *   session       Claude Agent SDK session id (for follow-up resume)
 *   error         server-side terminal error
 *   done          stream finished cleanly
 *
 * When a `toolRequest` arrives, the browser dispatches it through the
 * executor (which validates inputs and mutates the Zustand store), then
 * POSTs the result to AGENT_TOOL_RESULT_PATH so the server-side MCP tool
 * handler can return the result to Claude. There is no separate <pb:actions>
 * DSL — every page mutation is a real MCP tool call.
 *
 * Guideline #254 (Performance):
 *   Text deltas are batched via rAF buffer before committing to the store
 *   to prevent excessive React re-renders during streaming.
 */

import { nanoid } from 'nanoid'
import type { EditorStore, EditorStoreSliceCreator } from '../editor-store/types'
import { registry } from '../module-engine/registry'
import type {
  AnyModuleDefinition,
  PropertyControl,
  PropertySchema,
} from '../module-engine/types'
import { Type } from '@core/utils/typeboxHelpers'
import type { Page } from '../page-tree/schemas'
import { executeAgentTool } from './executor'
import { AGENT_API_PATH, AGENT_TOOL_RESULT_PATH } from './agentConfig'
import { safeParseJson } from '@core/utils/jsonValidate'
import type {
  AgentActionResult,
  AgentModuleContext,
  AgentModulePropContext,
  AgentModuleStyleContext,
  AgentMessage,
  AgentToolCall,
  AgentRequestBody,
  ServerStreamEvent,
  PageContext,
} from './types'

// ---------------------------------------------------------------------------
// Stream-event schema
//
// Discriminated union mirrors ServerStreamEvent from ./types. Tool-input
// payloads pass through as Unknown — the executor validates each call's input
// at the dispatch boundary. The schema here catches malformed envelopes from
// the server, which is the failure mode the streaming reader needs to defend
// against.
// ---------------------------------------------------------------------------

const ServerStreamEventSchema = Type.Union([
  Type.Object({ type: Type.Literal('text'), text: Type.String() }),
  Type.Object({
    type: Type.Literal('bridgeReady'),
    bridgeId: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('toolRequest'),
    requestId: Type.String(),
    name: Type.String(),
    input: Type.Unknown(),
  }),
  Type.Object({
    type: Type.Literal('toolStatus'),
    toolCallId: Type.String(),
    name: Type.String(),
    status: Type.Union([Type.Literal('pending'), Type.Literal('success'), Type.Literal('error')]),
    input: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('session'), sessionId: Type.String() }),
  Type.Object({ type: Type.Literal('done') }),
  Type.Object({ type: Type.Literal('error'), message: Type.String() }),
])

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface AgentSlice {
  // ── UI state ───────────────────────────────────────────────────────────────
  isAgentOpen: boolean
  isAgentStreaming: boolean
  agentMessages: AgentMessage[]
  agentError: string | null
  agentSessionId: string | null
  agentSessionSiteId: string | null

  // ── Actions ────────────────────────────────────────────────────────────────
  openAgent(): void
  closeAgent(): void
  toggleAgent(): void

  /**
   * Send a user message and stream the assistant response.
   * Routes via the Vite proxy `/api/agent` → local Bun server → Claude Agent SDK.
   * No endpoint configuration required (Constraint #385).
   */
  sendAgentMessage(content: string): Promise<void>

  /** Abort an in-progress streaming request. */
  abortAgent(): void

  /** Clear all messages and reset error state. */
  clearAgentMessages(): void
}

type EditorStoreSet = Parameters<EditorStoreSliceCreator<AgentSlice>>[0]

// Session-id is in-memory only. While the editor stays open, follow-up
// messages reuse the SDK session id (Claude has continuity across the
// thread). On page reload the message thread vanishes too, so starting
// fresh is the right behaviour — we don't want a ghost session from a
// thread the user can no longer see. A future "saved conversations" UI
// will persist threads + their session ids explicitly with a "new chat"
// button to start fresh.

// ---------------------------------------------------------------------------
// Bridge runtime — set on `bridgeReady`, read on `toolRequest`
// ---------------------------------------------------------------------------

export interface AgentBridgeRuntime {
  bridgeId: string | null
}

/**
 * Sink for assistant text deltas. `append` accumulates a delta; `flush`
 * drains accumulated text into the message's blocks immediately. The slice's
 * implementation rAF-batches `append` calls; the toolStatus handler calls
 * `flush` so any pending text lands BEFORE a tool-call block is appended,
 * preserving chronological order in the UI.
 */
export interface AgentTextStreamSink {
  append(assistantId: string, text: string): void
  flush(): void
}

async function postToolResult(
  bridgeId: string,
  requestId: string,
  result: AgentActionResult,
  signal: AbortSignal | null,
): Promise<void> {
  try {
    const res = await fetch(AGENT_TOOL_RESULT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bridgeId, requestId, result }),
      signal: signal ?? undefined,
    })
    if (!res.ok) {
      // 404 means the bridge is gone (stream closed before our POST landed) —
      // expected race during abort. Anything else is a routing/config issue
      // that would silently leave the agent loop hung server-side.
      console.error(
        `[AgentSlice] tool-result POST failed: ${res.status} ${res.statusText}`,
        { bridgeId, requestId },
      )
    }
  } catch (err) {
    // Network failure or user abort. Server cleans up pending tool resolvers
    // when its bridge is destroyed, so Claude's loop fails with a tool error
    // there.
    if (err instanceof Error && err.name === 'AbortError') return
    console.error('[AgentSlice] Failed to post tool-result:', err)
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

declare module '@core/editor-store/types' {
  interface EditorStore extends AgentSlice {}
}

export const createAgentSlice: EditorStoreSliceCreator<AgentSlice> = (set, get) => {
  // AbortController held in closure (not reactive — intentional, not needed in UI)
  let _abortController: AbortController | null = null

  // rAF-buffered text accumulation (Guideline #254). Pending deltas are
  // flushed once per animation frame, OR explicitly before any tool-call
  // block is added so chronological ordering is preserved.
  let _pendingText = ''
  let _pendingAssistantId = ''
  let _rafHandle = 0

  /**
   * Append `text` to the last text block of `msg`, or push a new text block
   * if the trailing block is a tool call. This is what keeps text/tool
   * ordering chronological — text that arrives after a tool call goes into
   * its own block AFTER the tool, not concatenated into earlier text.
   */
  function appendTextToBlocks(msg: AgentMessage, text: string): void {
    const last = msg.blocks[msg.blocks.length - 1]
    if (last && last.kind === 'text') {
      last.text += text
    } else {
      msg.blocks.push({ kind: 'text', text })
    }
  }

  function flushPendingText() {
    _rafHandle = 0
    if (!_pendingText || !_pendingAssistantId) return
    const text = _pendingText
    const id = _pendingAssistantId
    _pendingText = ''
    set((state) => {
      const msg = state.agentMessages.find((m) => m.id === id)
      if (msg) appendTextToBlocks(msg, text)
    })
  }

  function scheduleFlush() {
    if (_rafHandle === 0) {
      _rafHandle = requestAnimationFrame(flushPendingText)
    }
  }

  function appendTextDelta(assistantId: string, text: string) {
    _pendingAssistantId = assistantId
    _pendingText += text
    scheduleFlush()
  }

  // Single text-stream sink passed into processStreamEvent. The sink's
  // `flush()` is called from the toolStatus handler to drain any pending
  // text deltas BEFORE a tool-call block is added — that's what keeps the
  // visual order in the panel chronologically correct.
  const textSink: AgentTextStreamSink = {
    append: appendTextDelta,
    flush: flushPendingText,
  }

  return {
    // ── State ────────────────────────────────────────────────────────────────
    isAgentOpen: false,
    isAgentStreaming: false,
    agentMessages: [],
    agentError: null,
    agentSessionId: null,
    agentSessionSiteId: null,

    // ── UI actions ───────────────────────────────────────────────────────────
    openAgent() {
      set({ isAgentOpen: true })
    },

    closeAgent() {
      set({ isAgentOpen: false })
    },

    toggleAgent() {
      set((s) => ({ isAgentOpen: !s.isAgentOpen }))
    },

    abortAgent() {
      _abortController?.abort()
      _abortController = null
      set({ isAgentStreaming: false })
    },

    clearAgentMessages() {
      set({
        agentMessages: [],
        agentError: null,
        agentSessionId: null,
        agentSessionSiteId: null,
      })
    },

    // ── sendAgentMessage ─────────────────────────────────────────────────────
    async sendAgentMessage(content) {
      if (get().isAgentStreaming) return // one request at a time

      // Reuse the in-memory session id only when it belongs to the current
      // site. Switching sites or reloading the page resets it.
      const siteId = get().site?.id ?? null
      const resumeSessionId = get().agentSessionSiteId === siteId
        ? get().agentSessionId
        : null

      const userMsg: AgentMessage = {
        id: nanoid(),
        role: 'user',
        blocks: [{ kind: 'text', text: content }],
        timestamp: Date.now(),
      }

      const assistantId = nanoid()
      const assistantMsg: AgentMessage = {
        id: assistantId,
        role: 'assistant',
        blocks: [],
        timestamp: Date.now(),
      }

      set((state) => {
        state.agentMessages.push(userMsg)
        state.agentMessages.push(assistantMsg)
        state.agentError = null
        state.isAgentStreaming = true
      })

      _abortController = new AbortController()
      const bridge: AgentBridgeRuntime = { bridgeId: null }

      try {
        const pageContext = buildCurrentPageContext(get)
        const body: AgentRequestBody = {
          prompt: content,
          sessionId: resumeSessionId ?? undefined,
          pageContext,
        }
        const res = await fetch(AGENT_API_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: _abortController.signal,
        })

        if (!res.ok) {
          if (res.status === 502) {
            console.error('[AgentSlice] 502 — agent server unreachable')
            set({ agentError: 'Agent server is not running. Start it with: bun run dev' })
            set((state) => {
              const msg = state.agentMessages.find((m) => m.id === assistantId)
              if (msg && msg.blocks.length === 0) {
                msg.blocks.push({ kind: 'text', text: '_(agent error)_' })
              }
            })
            return
          }
          throw new Error(`Agent request failed: ${res.status} ${res.statusText}`)
        }

        if (!res.body) throw new Error('Agent response has no body')

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let lineBuffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          lineBuffer += decoder.decode(value, { stream: true })
          const lines = lineBuffer.split('\n')
          lineBuffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue
            const parsed = safeParseJson(trimmed, ServerStreamEventSchema)
            if (!parsed.ok) continue
            const event = parsed.value as ServerStreamEvent
            await processStreamEvent(
              event,
              assistantId,
              textSink,
              set,
              get,
              bridge,
              _abortController?.signal ?? null,
            )
          }
        }

        flushPendingText()
      } catch (err) {
        // Abort the fetch so any in-flight MCP tool handler on the server
        // rejects cleanly (via destroyBridge in the stream's finally block)
        // instead of waiting forever for a tool-result that won't arrive.
        _abortController?.abort()

        if (err instanceof Error && err.name === 'AbortError') {
          flushPendingText()
        } else {
          // Constraint #388 (CWE-209): never surface raw error details.
          console.error('[AgentSlice] sendAgentMessage error:', err)
          set({ agentError: 'Something went wrong. Please try again.' })
          set((state) => {
            const msg = state.agentMessages.find((m) => m.id === assistantId)
            if (msg && msg.blocks.length === 0) {
              msg.blocks.push({ kind: 'text', text: '_(agent error)_' })
            }
          })
        }
      } finally {
        _abortController = null
        set({ isAgentStreaming: false })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Stream event processor
// ---------------------------------------------------------------------------

export async function processStreamEvent(
  event: ServerStreamEvent,
  assistantId: string,
  textSink: AgentTextStreamSink,
  set: EditorStoreSet,
  get: () => EditorStore,
  bridge: AgentBridgeRuntime,
  signal: AbortSignal | null,
): Promise<void> {
  switch (event.type) {
    case 'text': {
      textSink.append(assistantId, event.text)
      break
    }

    case 'bridgeReady': {
      bridge.bridgeId = event.bridgeId
      break
    }

    case 'toolRequest': {
      // Defensive: executeAgentTool already converts caught throws into
      // `{ success: false, error }`, but if anything ever escapes (or if
      // executor evolves) we still need to ALWAYS POST a result so the
      // server's bridge resolver fires and Claude sees a tool error rather
      // than the loop hanging forever.
      let result: AgentActionResult
      try {
        result = await executeAgentTool(event.name, event.input)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[AgentSlice] tool ${event.name} threw unexpectedly:`, err)
        result = { success: false, error: `Browser exception: ${message}` }
      }
      if (!bridge.bridgeId) {
        console.error('[AgentSlice] toolRequest received before bridgeReady')
        break
      }
      await postToolResult(bridge.bridgeId, event.requestId, result, signal)
      break
    }

    case 'toolStatus': {
      // Drain any pending text deltas BEFORE adding/updating a tool-call
      // block so the chronological order text → tool → text is preserved.
      textSink.flush()

      set((state) => {
        const msg = state.agentMessages.find((m) => m.id === assistantId)
        if (!msg) return

        const inputAsRecord = event.input && typeof event.input === 'object'
          ? (event.input as Record<string, unknown>)
          : null
        const newResult = event.status === 'pending'
          ? null
          : {
              success: event.status === 'success',
              error: event.status === 'error' ? event.error ?? 'Tool call failed.' : undefined,
            }

        const existing = msg.blocks.find(
          (block): block is { kind: 'toolCall'; toolCall: AgentToolCall } =>
            block.kind === 'toolCall' && block.toolCall.externalId === event.toolCallId,
        )
        if (existing) {
          existing.toolCall.status = event.status
          if (inputAsRecord) existing.toolCall.params = inputAsRecord
          existing.toolCall.result = newResult
          return
        }

        msg.blocks.push({
          kind: 'toolCall',
          toolCall: {
            id: nanoid(),
            externalId: event.toolCallId,
            actionType: event.name,
            params: inputAsRecord ?? {},
            result: newResult,
            status: event.status,
          },
        })
      })
      break
    }

    case 'session': {
      const siteId = get().site?.id ?? null
      set({
        agentSessionId: event.sessionId,
        agentSessionSiteId: siteId,
      })
      break
    }

    case 'error': {
      // Constraint #388: server messages may carry internal detail. Log
      // server-side; show fixed copy in the UI.
      console.error('[AgentSlice] Server error event:', event.message)
      set({ agentError: 'Something went wrong. Please try again.' })
      break
    }

    case 'done':
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// Page context builder
// ---------------------------------------------------------------------------

export function buildPageContext(
  state: EditorStore,
  activePage: Page | undefined,
): PageContext {
  if (!activePage || !state.site) {
    return {
      pageId: '',
      pageTitle: 'Untitled',
      rootNodeId: '',
      pages: [],
      activeBreakpointId: state.activeBreakpointId,
      breakpoints: [],
      nodes: [],
      availableModules: [],
      selectedNodeId: null,
      classes: [],
    }
  }

  const parentMap: Record<string, string | null> = {}
  for (const node of Object.values(activePage.nodes)) {
    for (const childId of node.children) {
      parentMap[childId] = node.id
    }
    if (!parentMap[node.id]) parentMap[node.id] = null
  }

  const nodes = Object.values(activePage.nodes).map((node) => ({
    id: node.id,
    moduleId: node.moduleId,
    label: node.label,
    parentId: parentMap[node.id] ?? null,
    children: node.children,
    props: node.props,
    breakpointOverrides: toSerializableBreakpointRecords(node.breakpointOverrides ?? {}),
    classIds: node.classIds ?? [],
  }))

  const availableModules = registry
    .list()
    .filter((mod) => mod.id !== 'base.body')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(moduleDefinitionToAgentContext)

  const classes = Object.values(state.site.classes ?? {}).map((c) => ({
    id: c.id,
    name: c.name,
    styles: toSerializableRecord(c.styles ?? {}),
    breakpointStyles: toSerializableBreakpointStyles(c.breakpointStyles ?? {}),
  }))

  const pages = state.site.pages.map((page) => ({
    id: page.id,
    title: page.title,
    slug: page.slug,
    active: page.id === activePage.id,
    isHomepage: page.slug === 'index',
  }))

  return {
    pageId: activePage.id,
    pageTitle: activePage.title,
    rootNodeId: activePage.rootNodeId,
    pages,
    activeBreakpointId: state.activeBreakpointId,
    breakpoints: state.site.breakpoints.map((breakpoint) => ({
      id: breakpoint.id,
      label: breakpoint.label,
      width: breakpoint.width,
      icon: breakpoint.icon,
    })),
    nodes,
    availableModules,
    selectedNodeId: state.selectedNodeId,
    classes,
  }
}

function buildCurrentPageContext(get: () => EditorStore): PageContext {
  const storeState = get()
  const activePage = storeState.site?.pages.find(
    (p) => p.id === storeState.activePageId,
  ) ?? storeState.site?.pages[0]
  return buildPageContext(storeState, activePage)
}

function moduleDefinitionToAgentContext(mod: AnyModuleDefinition): AgentModuleContext {
  return {
    id: mod.id,
    name: mod.name,
    description: mod.description,
    category: mod.category,
    canHaveChildren: mod.canHaveChildren,
    defaults: toSerializableRecord(mod.defaults ?? {}),
    props: schemaToAgentProps(mod.schema, mod.defaults ?? {}),
    styles: genericAgentStyleHintsForModule(mod),
  }
}

function genericAgentStyleHintsForModule(mod: AnyModuleDefinition): AgentModuleStyleContext[] {
  if (mod.id === 'base.text' || mod.category.toLowerCase() === 'typography') {
    return [
      { key: 'fontFamily', type: 'text', label: 'Font family', defaultValue: 'inherit', cssProperties: ['fontFamily'] },
      { key: 'fontSize', type: 'text', label: 'Font size', defaultValue: '16px', cssProperties: ['fontSize'] },
      { key: 'fontWeight', type: 'select', label: 'Font weight', defaultValue: '400', cssProperties: ['fontWeight'], options: [
        { label: 'Regular', value: '400' },
        { label: 'Medium', value: '500' },
        { label: 'Semi bold', value: '600' },
        { label: 'Bold', value: '700' },
        { label: 'Black', value: '900' },
      ] },
      { key: 'lineHeight', type: 'text', label: 'Line height', defaultValue: '1.4', cssProperties: ['lineHeight'] },
      { key: 'letterSpacing', type: 'text', label: 'Letter spacing', defaultValue: '0px', cssProperties: ['letterSpacing'] },
      { key: 'color', type: 'color', label: 'Text color', defaultValue: 'inherit', cssProperties: ['color'] },
      { key: 'textAlign', type: 'select', label: 'Text align', defaultValue: 'left', cssProperties: ['textAlign'], options: [
        { label: 'Left', value: 'left' },
        { label: 'Center', value: 'center' },
        { label: 'Right', value: 'right' },
        { label: 'Justify', value: 'justify' },
      ] },
      { key: 'marginBottom', type: 'text', label: 'Bottom margin', defaultValue: '0px', cssProperties: ['marginBottom'] },
    ]
  }

  return []
}

function schemaToAgentProps(
  schema: PropertySchema,
  defaults: Record<string, unknown>,
): AgentModulePropContext[] {
  const props: AgentModulePropContext[] = []

  for (const [key, control] of Object.entries(schema)) {
    if (control.type === 'group') {
      props.push(...schemaToAgentProps(control.children, defaults))
      continue
    }
    props.push(controlToAgentProp(key, control, defaults[key]))
  }

  return props
}

function controlToAgentProp(
  key: string,
  control: Exclude<PropertyControl, { type: 'group' }>,
  defaultValue: unknown,
): AgentModulePropContext {
  const prop: AgentModulePropContext = {
    key,
    type: control.type,
    label: control.label,
    description: control.description,
    defaultValue: toSerializableValue(defaultValue),
  }

  if (control.breakpointOverridable === true) {
    prop.breakpointOverridable = true
  }

  if (control.type === 'select') {
    prop.options = control.options.map((option) => ({
      label: option.label,
      value: toSerializableValue(option.value),
    }))
  }

  return prop
}

function toSerializableRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    result[key] = toSerializableValue(value)
  }
  return result
}

function toSerializableBreakpointStyles(
  breakpointStyles: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return toSerializableBreakpointRecords(breakpointStyles)
}

function toSerializableBreakpointRecords(
  breakpointStyles: Record<string, Partial<Record<string, unknown>>>,
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  for (const [breakpointId, styles] of Object.entries(breakpointStyles)) {
    result[breakpointId] = toSerializableRecord(styles)
  }
  return result
}

function toSerializableValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) return value.map(toSerializableValue)

  if (typeof value === 'object' && value) {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toSerializableValue(nestedValue)
    }
    return result
  }

  return String(value)
}
