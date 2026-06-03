/**
 * Phase D — AI Agent: shared message and action types.
 *
 * These types live in core/ (no SDK imports) so they can be imported by
 * both the browser-side AgentPanel and the executor without violating
 * Constraints #283/#286 (no Anthropic SDK in src/).
 *
 * The wire format between the server and browser is NDJSON (newline-delimited
 * JSON). Each line is a `ServerStreamEvent` value, JSON-serialised.
 */

import type { AiToolOutput } from '@core/ai'

// ---------------------------------------------------------------------------
// Execution result
// ---------------------------------------------------------------------------
//
// Browser-bridged tools return the same canonical `AiToolOutput` shape the
// server-side AI runtime waits on: `{ ok, data?, error? }`.

/**
 * Conversation scope shared by every agent surface. Used in URL paths
 * (`/admin/api/ai/chat/${scope}`, `?scope=${scope}`), the conversation-create
 * body, and the per-scope default lookup. Keep it aligned with
 * `server/ai/runtime/types.ts → ToolScope`.
 */
export type AgentToolScope = 'site' | 'content' | 'data' | 'plugin'

export interface AgentRenderSnapshotPayload {
  breakpointId: string
  label: string
  width: number
  capturedAt: number
  screenshot: AgentScreenshotContext
  layout: AgentLayoutReportContext
}

// ---------------------------------------------------------------------------
// Server → Browser stream events (NDJSON wire format)
//
// The wire shape mirrors `AiStreamEvent` from `server/ai/runtime/types.ts`.
// `toolRequest` asks the browser to run one store-backed tool; `toolCall` and
// `toolResult` mirror the model-visible tool lifecycle; `usage` reports
// per-turn token counts persisted on the conversation row server-side.
// ---------------------------------------------------------------------------

/** A chunk of text from the assistant's message. */
interface TextEvent {
  type: 'text'
  text: string
}

/**
 * Bridge handshake: the server has accepted the request and assigned a bridge
 * id. The browser uses this id when POSTing tool-result responses to
 * `/admin/api/ai/tool-result` so the server can correlate the response with the
 * pending tool waiter inside the driver.
 */
interface BridgeReadyEvent {
  type: 'bridgeReady'
  bridgeId: string
}

/**
 * The server-side driver needs the browser to apply a write tool against
 * the editor store. The browser executes it, then POSTs the result to
 * `/admin/api/ai/tool-result` with `{ bridgeId, requestId, result }`.
 */
interface ToolRequestEvent {
  type: 'toolRequest'
  requestId: string
  toolName: string
  input: unknown
}

/** Stream finished normally. */
interface DoneEvent {
  type: 'done'
}

/** Stream terminated due to a server-side error. */
interface ErrorEvent {
  type: 'error'
  message: string
}

/**
 * The driver has issued a tool call. Status is always 'pending' on this
 * event — a paired `toolResult` lands once the tool completes.
 */
interface ToolCallEvent {
  type: 'toolCall'
  toolCallId: string
  toolName: string
  input: unknown
  status: 'pending'
}

/**
 * A previously-issued tool call has completed. `ok` is the success flag;
 * `error` carries the failure message when ok=false.
 */
interface ToolResultEvent {
  type: 'toolResult'
  toolCallId: string
  toolName: string
  ok: boolean
  error?: string
}

/** Provider session id (e.g. Claude Agent SDK resume token). */
interface SessionEvent {
  type: 'session'
  sessionId: string
}

/** Aggregated token usage for the entire turn — emitted just before `done`. */
interface UsageEvent {
  type: 'usage'
  promptTokens: number
  completionTokens: number
  costUsd?: number
}

export type ServerStreamEvent =
  | TextEvent
  | BridgeReadyEvent
  | ToolRequestEvent
  | ToolCallEvent
  | ToolResultEvent
  | SessionEvent
  | UsageEvent
  | DoneEvent
  | ErrorEvent

// ---------------------------------------------------------------------------
// Browser conversation model
// ---------------------------------------------------------------------------

export interface AgentToolCall {
  id: string
  /** SDK tool_use id (`toolu_…`) — correlates UI badges with stream events. */
  externalId?: string
  /** Tool name as Claude saw it (e.g. `mcp__instatic__insertHtml`). */
  actionType: string
  /** Tool input as Claude produced it. */
  params: Record<string, unknown>
  result: AiToolOutput | null
  status: 'pending' | 'success' | 'error'
}

/**
 * Chronological message blocks. Claude's response naturally interleaves text
 * and tool calls — the UI renders them in arrival order so a "text → tool →
 * text" sequence is visually three blocks, not "all text grouped above all
 * tools" (which mis-orders late text in front of earlier tool calls).
 */
export type AgentMessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; toolCall: AgentToolCall }

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant'
  blocks: AgentMessageBlock[]
  timestamp: number
}

// ---------------------------------------------------------------------------
// Browser → Server request body
// ---------------------------------------------------------------------------

export interface AgentRequestBody {
  /** Per-conversation id; the chat handler loads its credential + history. */
  conversationId: string
  /** The user's new message. */
  prompt: string
  /**
   * Scope-specific snapshot handed to the read tools via
   * `ToolContext.snapshot`. Loose `unknown` here because the body now
   * crosses every scope (site → PageContext, content → ContentSnapshot,
   * …); each scope's tool handlers cast at the boundary.
   */
  snapshot: unknown
}

interface AgentModulePropOptionContext {
  label: string
  value: unknown
}

export interface AgentModulePropContext {
  key: string
  type: string
  label: string
  description?: string
  defaultValue?: unknown
  options?: AgentModulePropOptionContext[]
  /**
   * When true, this prop can carry per-breakpoint overrides via
   * `updateNodeProps` with `breakpointId`. Default `false` — module props are
   * content (single value across breakpoints) unless the schema opts in.
   */
  breakpointOverridable?: boolean
}

export interface AgentModuleStyleContext {
  key: string
  type: string
  label: string
  description?: string
  defaultValue?: unknown
  cssProperties: string[]
  options?: AgentModulePropOptionContext[]
}

export interface AgentModuleContext {
  id: string
  name: string
  description?: string
  category: string
  canHaveChildren: boolean
  defaults: Record<string, unknown>
  props: AgentModulePropContext[]
  styles: AgentModuleStyleContext[]
}

export interface AgentBreakpointContext {
  id: string
  label: string
  width: number
  mediaQuery?: string
  icon: string
}

export interface AgentLayoutRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AgentLayoutNodeContext {
  nodeId: string
  moduleId?: string
  label?: string
  text: string
  rect: AgentLayoutRect
  visible: boolean
  computed: {
    display: string
    position: string
    overflow: string
    color: string
    backgroundColor: string
    fontSize: string
    lineHeight: string
  }
}

export interface AgentLayoutImageContext {
  nodeId?: string
  src: string
  alt?: string
  complete: boolean
  naturalWidth: number
  naturalHeight: number
  rect: AgentLayoutRect
}

export interface AgentLayoutWarningContext {
  type: 'horizontal-overflow' | 'vertical-overflow' | 'hidden-overflow' | 'broken-image' | 'invisible-node'
  severity: 'info' | 'warning' | 'error'
  message: string
  nodeId?: string
}

export interface AgentLayoutReportContext {
  breakpointId: string
  viewport: {
    width: number
    height: number
    scrollWidth: number
    scrollHeight: number
  }
  nodes: AgentLayoutNodeContext[]
  images: AgentLayoutImageContext[]
  warnings: AgentLayoutWarningContext[]
}

export interface AgentScreenshotContext {
  status: 'ok' | 'unavailable' | 'error'
  mimeType?: string
  data?: string
  width?: number
  height?: number
  error?: string
}

export interface AgentPageSummary {
  id: string
  title: string
  slug: string
  /** True when this is the active page in the editor. */
  active: boolean
  /** True when this page resolves at the site's homepage path (slug === 'index'). */
  isHomepage: boolean
}

export interface PageContext {
  /** ID of the active page in the editor. */
  pageId: string
  /** Active page title */
  pageTitle: string
  /** Root node ID of the active page */
  rootNodeId: string
  /** Every page in the site (for site-level admin tools). */
  pages: AgentPageSummary[]
  /** Configured breakpoint ID currently active in the editor. */
  activeBreakpointId: string
  /** Live breakpoint configuration for the site. */
  breakpoints: AgentBreakpointContext[]
  /** All nodes on the active page (flat map, serialisable subset) */
  nodes: Array<{
    id: string
    moduleId: string
    label?: string
    parentId: string | null
    children: string[]
    props: Record<string, unknown>
    breakpointOverrides: Record<string, Partial<Record<string, unknown>>>
    classIds: string[]
  }>
  /** Live module registry snapshot so Claude knows what can be inserted. */
  availableModules: AgentModuleContext[]
  /** Currently selected node ID, if any */
  selectedNodeId: string | null
  /**
   * CSS class registry — all classes defined in the site.
   * Use the `id` in assignClass/updateClassStyles for existing classes.
   * The executor also resolves classId by name as a fallback.
   */
  classes: Array<{
    id: string
    name: string
    styles?: Record<string, unknown>
    breakpointStyles?: Record<string, Record<string, unknown>>
  }>
}

// ---------------------------------------------------------------------------
// Slice runtime helpers
//
// Browser-side runtime contracts shared between the agent slice factory
// (agentSlice.ts) and the stream-event processor (streamEvents.ts). Kept here
// so neither module has to import the other just for a type.
// ---------------------------------------------------------------------------

/**
 * Bridge runtime — `bridgeId` is set on the `bridgeReady` event and read on
 * every `toolRequest` so the browser can correlate tool-result POSTs with the
 * server-side pending tool waiter.
 */
export interface AgentBridgeRuntime {
  bridgeId: string | null
}

/**
 * Sink for assistant text deltas. `append` accumulates a delta; `flush`
 * drains accumulated text into the message's blocks immediately. The slice's
 * implementation rAF-batches `append` calls; the toolCall/toolResult handlers
 * call `flush` so any pending text lands BEFORE a tool-call block is appended,
 * preserving chronological order in the UI.
 */
export interface AgentTextStreamSink {
  append(assistantId: string, text: string): void
  flush(): void
}
