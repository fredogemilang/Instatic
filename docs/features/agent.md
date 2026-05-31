# AI Agent

The AI Agent is a model-powered assistant integrated into the visual editor. The user types a request in the Agent Panel; the agent reads the current page snapshot, plans a sequence of edits, and executes them by calling tools. Structure is written as semantic HTML (`insertHtml` / `replaceNodeHtml`); styling is written as CSS classes (`createClass` / `updateClassStyles` / `assignClass`).

The agent runs on a provider-agnostic AI runtime (`server/ai/`) that can drive any supported model (Anthropic Claude, OpenAI, Ollama). Provider SDKs are isolated to `server/ai/drivers/`. The plain `@anthropic-ai/sdk` is banned repo-wide. Gated by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Structure via HTML.** `insertHtml` and `replaceNodeHtml` accept semantic HTML strings; the browser executor calls `importHtml` (the same pipeline as the paste-HTML UI) to convert them into first-class, editable `PageNode`s.
- **Styling via classes.** `createClass` / `updateClassStyles` / `assignClass` manage CSS classes. `<style>` blocks and `style=` attributes inside imported HTML are stripped — all styling lives on classes.
- **25 tools total.** 8 server-side read tools (resolved from the snapshot) + 17 browser-bridged write tools.
- **Two-endpoint bridge.** `POST /admin/api/ai/chat/site` opens an NDJSON stream. When the model calls a write tool, the server emits `toolRequest`; the browser executor applies it to the editor store and POSTs the result to `POST /admin/api/ai/tool-result`.
- **Provider-agnostic.** The runtime selects a driver (Anthropic, OpenAI, Ollama) from the conversation's configured credential.
- **Tools defined with TypeBox** (`server/ai/tools/`). Gated by `ai-tools-typebox-only.test.ts`.
- **Capabilities.** `ai.chat` required to stream; `ai.tools.write` required for write tools. Gated by `ai-handlers-capability-gated.test.ts`.

---

## Where the code lives

```text
server/ai/
├── handlers/
│   ├── chat.ts             — POST /admin/api/ai/chat/:scope  (NDJSON stream)
│   ├── toolResult.ts       — POST /admin/api/ai/tool-result  (bridge POST)
│   ├── conversations.ts    — CRUD for ai_conversations rows
│   ├── credentials.ts      — CRUD for ai_credentials rows (encrypted API keys)
│   ├── defaults.ts         — GET /admin/api/ai/defaults (per-scope defaults)
│   └── models.ts           — list available models per provider
├── tools/
│   ├── site/
│   │   ├── writeTools.ts   — 17 browser-bridged write tools (TypeBox schemas)
│   │   ├── readTools.ts    — 8 server-side read tools
│   │   ├── systemPrompt.ts — HTML-native static prefix + buildDynamicSuffix
│   │   └── snapshot.ts     — SiteSnapshot interface (wire shape from browser)
│   └── content/            — content-workspace tools (separate scope)
├── drivers/
│   ├── anthropic.ts        — Anthropic driver (only file allowed to import the Agent SDK + Zod)
│   ├── openai.ts           — OpenAI Agents driver
│   ├── ollama.ts           — Ollama driver
│   └── typeboxToZod.ts     — TypeBox→Zod conversion helper for the Anthropic driver
└── runtime/
    ├── runner.ts           — runChat(): drives a driver, emits stream events
    └── transport.ts        — createBridge() / resolveBridgeToolResult()

src/admin/pages/site/agent/
├── index.ts                — public barrel (all external imports go through here)
├── agentSlice.ts           — scope-agnostic Zustand slice factory (createAgentSlice(config))
├── agentSliceConfig.site.ts— site-editor config: scope, snapshot builder, executor wiring
├── agentConfig.ts          — API path constants (AGENT_TOOL_RESULT_PATH, AI_CONVERSATIONS_PATH, …)
├── agentApi.ts             — HTTP layer: tool-result POST, conversation bootstrap, message rehydration
├── streamEvents.ts         — NDJSON schema (ServerStreamEventSchema) + processStreamEvent reducer
├── pageContext.ts          — page snapshot builder (buildCurrentPageContext, buildPageContext)
├── executor.ts             — browser-side dispatcher: validates + runs write tools
├── renderEvidence.ts       — captureAgentRenderSnapshot (render_snapshot tool)
├── storeRef.ts             — setAgentStoreApi / getAgentStoreApi (avoids store ↔ executor cycle)
└── types.ts                — ServerStreamEvent, AgentMessage, AgentActionResult, PageContext, …

src/admin/pages/content/agent/
├── agentSliceConfig.content.ts — content-workspace config: scope, snapshot builder, executor wiring
├── contentAgentStore.ts        — standalone per-mount Zustand store (AgentSlice only)
└── contentBridge.ts            — content workspace write-tool executor

src/admin/pages/site/panels/AgentPanel/  — Agent Panel UI
```

---

## Flow

```text
User types prompt → Agent Panel
    │
    ▼
agentSlice.sendAgentMessage(content)
    │
    ├─→ buildSnapshot()  →  PageContext  (page tree, classes, modules, breakpoints)
    ├─→ ensure conversation row  (lazily created from AI defaults on first call)
    ├─→ POST /admin/api/ai/chat/site  { conversationId, prompt, snapshot }
    │
    ▼
Server: chat.ts
    │
    ├─→ CSRF + requireCapability('ai.chat')
    ├─→ load conversation row  (credentialId, modelId, message history)
    ├─→ decrypt credential; resolveDriver(credential.providerId)
    ├─→ selectToolsForScope('site', capabilities)
    │     — write tools excluded unless caller has ai.tools.write
    ├─→ buildSiteSystemPrompt(snapshot)  →  [staticPrefix, BOUNDARY, dynamicSuffix]
    ├─→ createBridge(emit)  →  { bridgeId, bridge, destroy }
    ├─→ emit { type: 'bridgeReady', bridgeId }
    └─→ runChat({ driver, request, persister, emit })  — streaming begins
          │
          ├─→ read tool (e.g. inspect_page)
          │     → resolved server-side from snapshot; result returned to model
          │
          └─→ write tool (e.g. insertHtml)
                → bridge.callBrowser(toolName, input)
                → emit { type: 'toolRequest', requestId, toolName, input }
                → driver loop pauses; awaits tool-result POST

NDJSON stream events (one JSON object + \n per line):
    { type: 'bridgeReady', bridgeId }
    { type: 'text', text: '…' }
    { type: 'toolCall', toolCallId, toolName, input, status: 'pending' }
    { type: 'toolRequest', requestId, toolName, input }    ← write tools only
    { type: 'toolResult', toolCallId, toolName, ok, error? }
    { type: 'usage', promptTokens, completionTokens, costUsd? }
    { type: 'done' }
    { type: 'error', message }                             ← on server error

Browser: processStreamEvent(event) in streamEvents.ts
    │
    ├─→ 'bridgeReady'   → store bridgeId in closure
    ├─→ 'toolRequest'   → executeAgentTool(toolName, input)  (executor.ts)
    │       – TypeBox-validates input
    │       – e.g. runInsertHtml → importHtml(html) → insertImportedNodes(parentId, …)
    │       → POST /admin/api/ai/tool-result { bridgeId, requestId, result }
    │       → server resolves pending waiter → driver sees tool_result → continues
    └─→ 'text' / 'toolCall' / 'toolResult' / 'done'  → update agentSlice.agentMessages
```

The two-endpoint design keeps the **browser as editor-store authority** (write tools mutate the live Zustand store in the browser) while the **server runs the model** (driver + tool routing live server-side).

---

## The page snapshot

Before each `sendAgentMessage` call, `buildCurrentPageContext(get)` (in `pageContext.ts`) extracts a serializable `PageContext` from the editor store:

- Page id, title, root node id
- Every node on the active page: id, moduleId, label, parentId, children, props, classIds, breakpointOverrides
- All pages in the site (id, title, slug, active, isHomepage)
- Configured breakpoints (id, label, width)
- CSS class registry (id, name, styles, breakpointStyles)
- Available modules from the registry (id, name, category, props schema, defaults)
- Currently selected node id

This snapshot travels with every prompt so server-side read tools resolve entirely from it — no browser round-trips needed for reads.

---

## Server endpoints

### `POST /admin/api/ai/chat/site`

```ts
// Request body
{
  conversationId: string   // ai_conversations row id
  prompt:         string
  snapshot:       PageContext   // built by buildCurrentPageContext()
}

// Response: NDJSON stream of ServerStreamEvent (one JSON line + '\n' each)
```

The handler (`server/ai/handlers/chat.ts`):
1. CSRF-checks and requires `ai.chat`.
2. Loads the conversation row (credentialId, modelId, persisted message history).
3. Decrypts the credential and resolves the driver.
4. Calls `selectToolsForScope('site', capabilities)` — write tools excluded without `ai.tools.write`.
5. Builds the system prompt via `buildSiteSystemPrompt(snapshot)`.
6. Creates a bridge (`createBridge(emit)`), emits `bridgeReady`.
7. Calls `runChat(...)`, pipes all stream events to the HTTP response.
8. Emits a terminal `ai.chat.completed` / `ai.chat.failed` audit event.

### `POST /admin/api/ai/tool-result`

```ts
// Request body
{
  bridgeId:  string
  requestId: string
  result:    { ok: boolean; data?: unknown; error?: string }
}
```

Requires `ai.tools.write`. Calls `resolveBridgeToolResult(bridgeId, requestId, result)` which resolves the pending tool waiter inside the driver loop so streaming continues. If the bridge is gone (stream already closed), returns 404 and the result is silently dropped.

---

## Tools

### Read tools — 8, server-side

Resolved from the snapshot. No browser round-trip. Results are returned directly to the model.

| Tool              | What it returns                                                         |
|-------------------|-------------------------------------------------------------------------|
| `list_modules`    | Module registry (id, name, category, props schema, defaults); `category` filter |
| `list_classes`    | CSS class registry (id, name, styles, breakpointStyles); substring filter |
| `list_breakpoints`| Configured breakpoints + active id                                      |
| `inspect_page`    | Full active page tree: every node id, moduleId, props, classIds, parent/children |
| `search_nodes`    | Find nodes by free-text query, moduleId, classId, or className; `limit` default 25 |
| `inspect_node`    | One node's full detail + light subtree to `maxDepth`; `breakpointId` default active |
| `inspect_class`   | One class: id, name, base styles, breakpoint styles, assigned node ids  |
| `list_pages`      | All pages in the site (id, title, slug, active, isHomepage)             |

### Write tools — 17, browser-bridged

All 17 tools carry `execution: 'browser'` in their `AiTool` definition. The server emits `toolRequest`; the browser executor validates input with TypeBox, runs the store action, and POSTs the result back.

**Structure (HTML-native)**

| Tool              | Input                              | What it does                                           |
|-------------------|------------------------------------|--------------------------------------------------------|
| `insertHtml`      | `{ parentId, index?, html, classes? }` | Parse HTML → import as `PageNode`s under `parentId` |
| `getNodeHtml`     | `{ nodeId }`                       | Render subtree to HTML via the publisher's `renderNode`|
| `replaceNodeHtml` | `{ nodeId, html, classes? }`       | Delete existing children; re-import HTML under the same parent |

The `classes` field in `insertHtml` / `replaceNodeHtml`:
```ts
Array<{
  name: string                  // CSS identifier; resolved or created before insertion
  styles?: Record<string, string | number>            // camelCase CSS properties
  breakpointStyles?: Record<string, Record<string, string | number>>
  //                            ↑ keyed by breakpoint id verbatim from the system prompt suffix
}>
```
Declared classes are created (or resolved by name if they already exist) **with their styles** before the HTML is imported. Binding then happens when the fragment is spliced in: `insertImportedNodes` links every `class=` name on the imported nodes to a registry class id — reusing the just-declared class, or auto-creating a bare one for any name not in the `classes` array. So `class="hero-section"` renders and is styleable whether or not it appears in `classes`. See [html-import.md → Class linking](html-import.md#class-linking-name--id).

**Node edits**

| Tool              | Input                                      | What it does                                               |
|-------------------|--------------------------------------------|------------------------------------------------------------|
| `updateNodeProps` | `{ nodeId, breakpointId?, patch }`         | Shallow-merge props; `breakpointId` requires schema `breakpointOverridable: true` |
| `moveNode`        | `{ nodeId, newParentId, newIndex }`        | Re-parent or reorder; `newIndex` is 0-based               |
| `deleteNode`      | `{ nodeId }`                               | Remove node and all descendants                            |
| `duplicateNode`   | `{ nodeId, count? }`                       | Clone subtree 1–50 times right after the source           |
| `renameNode`      | `{ nodeId, label }`                        | Set the node's display label in the DOM panel (editor-only)|

**Classes**

| Tool                | Input                                  | What it does                                          |
|---------------------|----------------------------------------|-------------------------------------------------------|
| `createClass`       | `{ name, styles?, breakpointStyles? }` | Create a new CSS class; returns the new class id      |
| `updateClassStyles` | `{ classId, breakpointId?, patch }`    | Shallow-merge styles; `classId` accepts id or name    |
| `assignClass`       | `{ nodeId, classId }`                  | Attach a class to a node; `classId` accepts id or name|
| `removeClass`       | `{ nodeId, classId }`                  | Detach a class from a node (the class itself remains) |

**Pages**

| Tool            | Input                             | What it does                                               |
|-----------------|-----------------------------------|------------------------------------------------------------|
| `addPage`       | `{ title, slug? }`                | Create an empty page; returns new page id                  |
| `deletePage`    | `{ pageId }`                      | Delete page; fails if it would leave the site with 0 pages |
| `renamePage`    | `{ pageId, title, slug? }`        | Change title/slug; `slug="index"` makes this the homepage  |
| `duplicatePage` | `{ pageId, title, slug? }`        | Deep-clone page (all nodes, props, class assignments)      |

**Capture**

| Tool              | Input                 | What it does                                                     |
|-------------------|-----------------------|------------------------------------------------------------------|
| `render_snapshot` | `{ breakpointId? }`   | Canvas screenshot + layout data (bounding boxes, overflow warnings, image load status) |

---

## System prompt

`server/ai/tools/site/systemPrompt.ts` builds a 3-element array:
```ts
[staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]
```
Drivers that support prompt caching (Anthropic) apply `cache_control` to the static prefix automatically; drivers that don't concatenate the three strings. Content is intentionally static across providers — every observable behaviour comes from the tool definitions, not prompt knobs.

**Static prefix** (full text in `server/ai/tools/site/systemPrompt.ts`):
- "Structure as HTML, styling as classes": use `insertHtml` / `replaceNodeHtml` for structure; use `createClass` + class references in HTML for styling.
- `<style>` blocks and `style=` attributes inside imported HTML are stripped and have no effect.
- One `insertHtml` call per logical section (nav, hero, pricing, footer = 4–6 calls); smaller chunks recover better if one fails.
- Per-breakpoint variation: use `breakpointStyles` on classes, keyed by breakpoint ids **verbatim from the dynamic suffix** — never invent ids like `"mobile"` or `"desktop"`.
- Page ids come from the dynamic suffix; never invent them.
- Reply rule: 1–2 narrating sentences only. No raw HTML/CSS/JSON in the reply.

**Dynamic suffix** (built per request by `buildDynamicSuffix(snap: SiteSnapshot)`):
```text
Page: "My Site" · root: <rootNodeId> · selected: <nodeId|none>
· active breakpoint: <id> · all breakpoints: [<id>@<width>px, …]
· Pages: [<id>=<slug> (active), <id>=<slug>, …]
```
The static prefix is cache-friendly (unchanged across prompts for the same provider). The dynamic suffix carries per-request state and is never cached.

---

## Why HTML-native

The previous tool surface required the model to reference internal module ids (`base.text`, `base.container`, …) and construct node trees as structured JSON. The current surface lets the model write plain HTML:

- LLMs produce correct semantic HTML far more reliably than custom JSON node-tree payloads.
- No module enumeration is needed in the system prompt — shorter context, lower token cost.
- The importer (`@core/htmlImport`) guarantees every element becomes a first-class editable `PageNode`: selectable, draggable, deletable, and re-styleable in the canvas.
- `getNodeHtml` (backed by the publisher's `renderNode`) gives the agent read-back at the same semantic level it writes.

The same importer that powers the Agent's `insertHtml` tool also powers the paste-HTML UI — see `docs/features/html-import.md`. No duplicated mapping logic.

---

## Client store (`agentSlice`)

`createAgentSlice(config)` (`src/admin/pages/site/agent/agentSlice.ts`) is a scope-agnostic Zustand slice factory. Scope-specific wiring is kept out of the factory — each surface supplies its own `AgentSliceConfig`. The site editor uses `siteAgentSliceConfig` from `agentSliceConfig.site.ts`:

```ts
// agentSliceConfig.site.ts — wired in store.ts via createAgentSlice(siteAgentSliceConfig)
export const siteAgentSliceConfig: AgentSliceConfig = {
  scope: 'site',
  buildSnapshot: () => buildCurrentPageContext(
    () => getAgentStoreApi<EditorStore>().getState(),
  ),
  dispatchTool: executeAgentTool,
  noProviderMessage: 'No AI provider configured for the site editor. …',
}
```

`getAgentStoreApi` reads the live store via `storeRef.ts`, wired in `store.ts` after store creation (`setAgentStoreApi(useEditorStore)`). This avoids a static import cycle: executor → store → agentSlice → executor.

The content workspace uses the same factory with `contentAgentSliceConfig` mounted in a standalone per-page store (`contentAgentStore.ts`).

Key slice state and actions:

```ts
interface AgentSlice {
  // ── UI state ──────────────────────────────────────────────────────────
  isAgentOpen:               boolean
  isAgentStreaming:          boolean
  agentMessages:             AgentMessage[]
  agentError:                string | null
  agentSessionId:            string | null
  /** Active ai_conversations row id — created lazily on first send. */
  agentConversationId:       string | null
  /** Active (credentialId, modelId) surfaced by the model picker. */
  agentActiveCredentialId:   string | null
  agentActiveModelId:        string | null
  /** Conversation summaries for the history popover. */
  agentConversations:        ConversationView[]

  // ── Actions ───────────────────────────────────────────────────────────
  openAgent():                                         void
  closeAgent():                                        void
  toggleAgent():                                       void
  sendAgentMessage(content: string):                   Promise<void>
  abortAgent():                                        void
  clearAgentMessages():                                void
  startNewAgentConversation():                         void
  loadAgentConversations():                            Promise<void>
  loadAgentConversation(id: string):                   Promise<void>
  deleteAgentConversation(id: string):                 Promise<void>
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
}
```

Conversations and their message history are persisted server-side in `ai_conversations` + `ai_conversation_messages`. `loadAgentConversation(id)` rehydrates a past thread into `agentMessages` without re-running the conversation.

---

## Abort + crash recovery

- **Abort.** "Stop" calls `agentSlice.abortAgent()` → `AbortController.abort()` → the fetch stream closes → the server's `destroy()` hook fires → pending tool waiters reject → the driver loop terminates.
- **Crash on server.** If `runChat` throws, the stream emits `{ type: 'error', message }`. The browser surfaces the message verbatim in the Agent Panel (admin-only surface, so info-disclosure is not a concern).
- **Tool failure.** `executeAgentTool` wraps every call in try/catch. Failures return `{ success: false, error }`. The model reads the error message in the next turn and retries with corrected input.
- **Bridge-result POST after abort.** If the browser POSTs a tool-result after the stream has closed, the server returns 404 and drops the result silently.
- **Page reload mid-stream.** The stream dies. The conversation row and its persisted messages survive. The user can reload the past thread via `loadAgentConversation` and re-send.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing `@anthropic-ai/sdk` (plain SDK) | Banned repo-wide. Gated by `ai-driver-isolation.test.ts`. |
| Importing any provider SDK outside `server/ai/drivers/` | Drivers only. Same gate. |
| Importing `zod` in `server/ai/tools/**` | TypeBox only. Gated by `ai-tools-typebox-only.test.ts`. |
| Routing a write tool as a server-side read (resolving from snapshot) | Write tools are `execution: 'browser'` — they must go through the bridge. The editor store is the write authority. |
| Putting styles inside `<style>` blocks or `style=` attributes in `insertHtml` HTML | They are stripped on import. Put styles on classes via `createClass` or the `classes` parameter. |
| Using invented breakpoint ids in `breakpointStyles` (`"mobile"`, `"desktop"`, etc.) | Use verbatim ids from the dynamic suffix. Invalid ids are rejected by the executor. |
| Editing nodes outside the active page | Agent mutations target the active page tree. Cross-page edits require the user to switch pages first. |

---

## Related

- `docs/features/html-import.md` — the `importHtml` pipeline that `insertHtml` and `replaceNodeHtml` run through
- `docs/editor.md` — agent slice composition inside the editor store
- `docs/server.md` — handler routing; `/admin/api/ai/` is matched before `/admin/api/cms/`
- `docs/features/auth-and-access.md` — capability model (`ai.chat`, `ai.tools.write`)
- Source-of-truth files:
  - `server/ai/tools/site/writeTools.ts` — 17 browser-bridged write tool definitions (TypeBox schemas)
  - `server/ai/tools/site/readTools.ts` — 8 server-side read tool definitions
  - `server/ai/tools/site/systemPrompt.ts` — HTML-native system prompt
  - `server/ai/tools/site/snapshot.ts` — `SiteSnapshot` interface
  - `server/ai/handlers/chat.ts` — `POST /admin/api/ai/chat/site` endpoint
  - `server/ai/handlers/toolResult.ts` — `POST /admin/api/ai/tool-result` endpoint
  - `server/ai/runtime/runner.ts` — `runChat()` driver loop
  - `server/ai/runtime/transport.ts` — `createBridge()` / `resolveBridgeToolResult()`
  - `src/admin/pages/site/agent/agentSlice.ts` — scope-agnostic slice factory (`createAgentSlice`)
  - `src/admin/pages/site/agent/agentSliceConfig.site.ts` — site-editor scope config
  - `src/admin/pages/site/agent/agentApi.ts` — tool-result POST, conversation bootstrap, message rehydration
  - `src/admin/pages/site/agent/streamEvents.ts` — `ServerStreamEventSchema` + `processStreamEvent`
  - `src/admin/pages/site/agent/pageContext.ts` — `buildCurrentPageContext`, `buildPageContext`
  - `src/admin/pages/site/agent/executor.ts` — write-tool browser dispatcher
  - `src/admin/pages/site/agent/agentConfig.ts` — API path constants
  - `src/admin/pages/site/agent/renderEvidence.ts` — `captureAgentRenderSnapshot`
  - `src/admin/pages/site/agent/types.ts` — `ServerStreamEvent`, `AgentMessage`, `PageContext`, …
  - `src/admin/pages/site/agent/index.ts` — public barrel
  - `src/admin/pages/content/agent/contentAgentStore.ts` — standalone content-workspace agent store
  - `src/admin/pages/site/panels/AgentPanel/` — Agent Panel UI
- Gate tests:
  - `src/__tests__/architecture/ai-driver-isolation.test.ts`
  - `src/__tests__/architecture/ai-tools-typebox-only.test.ts`
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
