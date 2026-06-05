# AI Agent

The AI Agent is a model-powered assistant integrated into the visual editor. The user types a request in the Agent Panel; the agent reads the current page snapshot, plans a sequence of edits, and executes them by calling tools. Structure is written as semantic HTML (`insertHtml` / `replaceNodeHtml`); styling is written as CSS in the same call — a `<style>` block and/or `class=` attributes that the importer parses into Selectors-panel classes and ambient rules. `createClass` / `updateClassStyles` / `assignClass` remain for editing styles on existing nodes.

The agent runs on a provider-agnostic AI runtime (`server/ai/`) that can drive any supported model (Anthropic Claude, OpenAI, OpenRouter, Ollama). Every driver talks directly to its provider's REST API over HTTP/SSE — no provider SDKs. All four share one multi-turn tool loop (`drivers/http/toolLoop.ts`); each supplies only a small `ProviderAdapter` of pure mapping functions. The plain `@anthropic-ai/sdk` (and any provider SDK) is banned repo-wide. Gated by `ai-driver-isolation.test.ts`.

---

## TL;DR

- **Structure via HTML.** `insertHtml` and `replaceNodeHtml` accept semantic HTML strings; the browser executor calls `importHtml` (the same pipeline as the paste-HTML UI) to convert them into first-class, editable `PageNode`s.
- **Styling via CSS.** The agent emits CSS the same way a human pastes it: a `<style>` block and/or `class=` attributes inside the `insertHtml`/`replaceNodeHtml` payload. The importer (`cssToStyleRules`) classifies every selector — a bare `.foo {}` rule becomes a reusable Selectors-panel class bound to `class="foo"`; any other selector (`.hero a`, `a:hover`, `nav > li`) becomes an ambient rule; `style=` attributes land on the node's inline styles. There is no structured `classes` parameter — the agent never hand-builds classes node-by-node at insert time. `createClass` / `updateClassStyles` / `assignClass` exist for editing styles on **existing** nodes after insertion.
- **29 tools total.** 6 server-side read tools (resolved server-side from the posted snapshot) + 23 browser-bridged write tools.
- **Two-endpoint bridge.** `POST /admin/api/ai/chat/site` opens an NDJSON stream. When the model calls a write tool, the server emits `toolRequest`; the browser executor applies it to the editor store and POSTs the `AiToolOutput` result to `POST /admin/api/ai/tool-result`.
- **Provider-agnostic.** The runtime selects a driver (Anthropic, OpenAI, OpenRouter, Ollama) from the conversation's configured credential.
- **Tools defined with TypeBox** (`server/ai/tools/`). Gated by `ai-tools-typebox-only.test.ts`.
- **Capabilities.** `ai.chat` required to stream; `ai.tools.write` required for write tools. Gated by `ai-handlers-capability-gated.test.ts`.

---

## Where the code lives

```text
src/core/ai/
├── toolOutput.ts           — AiToolOutput type + AiToolOutputSchema + aiToolOk / aiToolError
└── index.ts                — barrel re-export (canonical @core/ai import path)

server/ai/
├── handlers/
│   ├── chat.ts             — POST /admin/api/ai/chat/:scope  (NDJSON stream)
│   ├── toolResult.ts       — POST /admin/api/ai/tool-result  (bridge POST)
│   ├── conversations.ts    — CRUD for ai_conversations rows
│   ├── credentials.ts      — CRUD for ai_credentials rows (encrypted API keys); auto-seeds defaults on create
│   ├── defaults.ts         — GET /admin/api/ai/defaults (per-scope defaults)
│   └── models.ts           — list available models per provider; enriches Anthropic/OpenAI with catalogue prices + context windows
├── pricing/
│   ├── index.ts            — resolveCostUsd / getModelCatalogue (6h in-memory cache, DB fallback)
│   ├── openrouterCatalogue.ts — fetches OpenRouter /api/v1/models; pricingKey() normaliser; ModelCatalogue type
│   └── store.ts            — durable DB cache in ai_model_pricing (prices + context_window column)
├── contextTokens.ts        — normalizeContextTokens(): provider-normalised "context used" for the meter
├── tools/
│   ├── site/
│   │   ├── writeTools.ts      — 23 browser-bridged write tools (TypeBox schemas)
│   │   ├── readTools.ts       — 6 server-side read tools
│   │   ├── render.ts          — server-side page render (`renderAgentPage`) + catalog derivations (`describeAgentModules`, `describeAgentTokens`, `filterTokenFamily`)
│   │   ├── systemPrompt.ts    — HTML-native static prefix + buildDynamicSuffix
│   │   └── snapshot.ts        — `SiteAgentSnapshot` re-export + catalog output types (ModuleInfo, SnapshotTokens, …)
│   └── content/            — content-workspace tools (separate scope)
├── drivers/
│   ├── http/
│   │   ├── sse.ts          — parseSseStream(res): reassemble SSE frames across chunks
│   │   ├── execTool.ts     — executeAiTool(): server-handler vs browser-bridge dispatch
│   │   ├── toolLoop.ts     — runToolLoop(): provider-agnostic multi-turn loop
│   │   └── errors.ts       — isAbortError / classifyHttpError
│   ├── responses-shared.ts — OpenAI-Responses mapping + SSE translator + adapter factory (openai + openrouter)
│   ├── anthropic.ts        — Anthropic driver: direct POST /v1/messages (no SDK)
│   ├── openai.ts           — OpenAI driver: direct POST /v1/responses (no SDK)
│   ├── openrouter.ts       — OpenRouter driver: direct POST /v1/responses (shared Responses path; live /models; native cost)
│   └── ollama.ts           — Ollama driver: direct POST /v1/chat/completions (no SDK)
└── runtime/
    ├── runner.ts           — runChat(): drives a driver, emits stream events
    ├── persister.ts        — ConversationsPersister: messages + usage to DB; writes contextTokens snapshot
    ├── types.ts            — canonical AiStreamEvent / AiMessage / AiTool / ToolContext
    └── transport.ts        — createBridge() / resolveBridgeToolResult()

src/admin/pages/site/agent/
├── index.ts                — public barrel (all external imports go through here)
├── agentSlice.ts           — scope-agnostic Zustand slice factory (createAgentSlice(config))
├── agentSliceConfig.site.ts— site-editor config: scope, snapshot builder, executor wiring
├── agentConfig.ts          — API path constants (AGENT_TOOL_RESULT_PATH, AI_CONVERSATIONS_PATH, …)
├── agentApi.ts             — HTTP layer: tool-result POST, conversation bootstrap, message rehydration
├── streamEvents.ts         — NDJSON schema (ServerStreamEventSchema) + processStreamEvent reducer
├── siteAgentSnapshot.ts    — `SiteAgentSnapshot` raw-tree wire shape + `buildSiteAgentSnapshot` serializer
├── pageContext.ts          — editor adapter: reads active page + store scalars, calls `buildSiteAgentSnapshot`
├── executor.ts             — browser-side dispatcher: validates + runs write tools
├── renderEvidence.ts       — captureAgentRenderSnapshot (render_snapshot tool)
├── storeRef.ts             — setAgentStoreApi / getAgentStoreApi (avoids store ↔ executor cycle)
└── types.ts                — ServerStreamEvent, AgentMessage, AgentRequestBody, …

src/admin/pages/content/agent/
├── agentSliceConfig.content.ts — content-workspace config: scope, snapshot builder, executor wiring
├── contentAgentStore.ts        — standalone per-mount Zustand store (AgentSlice only)
└── contentBridge.ts            — content workspace write-tool executor

src/admin/pages/site/panels/AgentPanel/
├── AgentPanel.tsx          — main panel; resolves active model's contextWindow from the models endpoint
├── ContextMeter.tsx        — "context used / window" progress indicator (display only)
└── ContextMeter.module.css
```

The Agent Panel owns the credential list load for its header, setup empty state, and model picker. The header always contains a `ConversationHistory` popover (browse and restore past threads), a "New chat" button (`startNewAgentConversation`), a conditional "Clear conversation" button (visible when `agentMessages.length > 0`), a streaming badge, and an "AI settings" shortcut that routes to `/admin/ai`. The AI settings button is always visible in the header, independent of credential state. When no credentials exist, the message area switches from the prompt empty state to a larger setup state with an `/admin/ai` CTA.

When the panel opens, `AgentPanel` calls `loadScopeDefault()` so the model picker immediately shows the configured scope default — no "Default" placeholder, no send-time no-provider surprise. `showCredentialSetup` is gated by `hasActiveProvider` (`Boolean(activeCredentialId && activeModelId)`), meaning a stale "No AI provider configured" error string never locks out the UI once a credential + model is staged; picking a model via `setAgentProvider` clears `agentError` immediately, re-enabling the composer.

The composer area includes a `<ContextMeter>` that shows "context used / window" as a progress bar. `AgentPanel` resolves the active model's `contextWindow` from `GET /admin/api/ai/providers/:id/models?credentialId=…` (the same catalogue-enriched response the picker uses), so the meter appears as soon as a model is selected — before the first turn. The "used" half comes from `agentContextTokens` in the store (see slice state below). The meter is hidden when no context window is known (Ollama, uncatalogued models).

---

## Flow

```text
User types prompt → Agent Panel
    │
    ▼
agentSlice.sendAgentMessage(content)
    │
    ├─→ buildSnapshot()  →  SiteAgentSnapshot  (raw active page + site tree)
    ├─→ ensure conversation row  (lazily created from AI defaults on first call)
    ├─→ POST /admin/api/ai/chat/site  { conversationId, prompt, snapshot }
    │
    ▼
Server: chat.ts
    │
    ├─→ CSRF + requireCapability('ai.chat')
    ├─→ load conversation row  (credentialId, modelId) + full message history
    ├─→ decrypt credential; resolveDriver(credential.providerId)
    ├─→ selectToolsForScope('site', capabilities)
    │     — write tools excluded unless caller has ai.tools.write
    ├─→ buildSiteSystemPrompt(snapshot)  →  [staticPrefix, BOUNDARY, dynamicSuffix]
    ├─→ createBridge(emit)  →  { bridgeId, bridge, destroy }
    ├─→ emit { type: 'bridgeReady', bridgeId }
    └─→ runChat({ driver, request, persister, emit })  — streaming begins
          │  request carries the FULL conversation history as req.messages.
          │  Direct HTTP drivers have no server-side session — every turn
          │  replays the whole log, mapped into the provider's message array.
          │
          ├─→ read tool (e.g. read_page)
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
    { type: 'usage', promptTokens, completionTokens, costUsd?, cacheReadTokens?, cacheCreationTokens? }
    { type: 'context', contextTokens }                     ← per-round meter update
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

Before each `sendAgentMessage` call, `buildCurrentPageContext(get)` (in `pageContext.ts`) builds a `SiteAgentSnapshot` from the live editor store. `pageContext.ts` reads the active page and the two editor-only scalars (`selectedNodeId`, `activeBreakpointId`) off the store and calls `buildSiteAgentSnapshot(activePage, state.site, opts)` (in `siteAgentSnapshot.ts`). The result is the raw authoritative tree — no pre-flattening.

```ts
interface SiteAgentSnapshot {
  page: Page           // active page with full nodes map
  site: SiteDocument   // breakpoints, styleRules, settings intact; non-active pages emptied
  selectedNodeId: string | null
  activeBreakpointId: string
}
```

Only the active page carries full `nodes`. Non-active pages keep metadata (`id`, `title`, `slug`) with empty `nodes`, bounding the per-turn payload on multi-page sites. The server derives everything from this raw tree — `renderAgentPage` runs `publishPage` + `buildSiteCssBundle` for `read_page`; catalog tools read `site.settings` and the server module registry. No bespoke flattened shapes cross the wire.

**Mid-turn refresh.** The snapshot is rebuilt once per `sendAgentMessage`, but a single turn runs many tool calls, and browser write tools mutate the live store *during* the turn. To keep server-side read tools (`read_page`, `list_pages`, …) from seeing stale turn-start state, the browser re-captures `buildSnapshot()` after **every** browser tool and posts it with the tool result (`postToolResult(..., snapshot)`). The server threads it through `resolveBridgeToolResult(..., snapshot)` → the bridge's `onSnapshot` → `toolContextBase.snapshot` (a mutable per-turn field). Because `executeAiTool` re-reads `toolContextBase` for each call, the next read tool sees the state the previous write produced. Without this, a read after a write (e.g. `list_pages` right after `addPage`) returned the page set from the start of the turn.

---

## Server endpoints

### `POST /admin/api/ai/chat/site`

```ts
// Request body
{
  conversationId: string   // ai_conversations row id
  prompt:         string
  snapshot:       SiteAgentSnapshot   // built by buildCurrentPageContext()
}

// Response: NDJSON stream of ServerStreamEvent (one JSON line + '\n' each)
```

The handler (`server/ai/handlers/chat.ts`):
1. CSRF-checks and requires `ai.chat`.
2. Loads the conversation row (credentialId, modelId) and the full persisted message history (`listMessagesForConversation` → `buildMessageHistory` → `AiMessage[]`).
3. Decrypts the credential and resolves the driver.
4. Calls `selectToolsForScope('site', capabilities)` — write tools excluded without `ai.tools.write`.
5. Builds the system prompt via `buildSiteSystemPrompt(snapshot)`.
6. Creates a bridge (`createBridge(emit, req.signal)`), emits `bridgeReady`.
7. Calls `runChat(...)` with the full history as `req.messages`. Direct HTTP drivers have no server-side session, so each driver maps the whole `AiMessage[]` log into the provider's native message array every turn (the Anthropic driver pairs assistant `tool_use` blocks with their following `tool_result` turns). The runner pipes all stream events to the HTTP response. The multi-turn agentic loop lives in `drivers/http/toolLoop.ts`, not in a provider SDK.
8. Emits a terminal `ai.chat.completed` / `ai.chat.failed` audit event.

### `POST /admin/api/ai/tool-result`

```ts
// Request body
{
  bridgeId:  string
  requestId: string
  result:    AiToolOutput   // { ok: boolean; data?: unknown; error?: string; images?: { mimeType, data }[] } — from src/core/ai/
  snapshot?: unknown        // optional post-mutation scope snapshot (see "Mid-turn refresh")
}
```

Requires `ai.tools.write`. Calls `resolveBridgeToolResult(bridgeId, requestId, result, snapshot)` which (when a snapshot is present) refreshes `toolContextBase.snapshot` via the bridge's `onSnapshot`, then resolves the pending tool waiter inside the driver loop so streaming continues. If the bridge is gone (stream already closed), returns 404 and the result is silently dropped.

`AiToolOutput` is the canonical result type shared by both sides of the bridge. Constructors: `aiToolOk(data?, images?)` and `aiToolError(message)` from `@core/ai`. The optional `images` channel carries base64 attachments (e.g. a `render_snapshot` PNG) that drivers forward as native image blocks or drop with a note — see "Heavy evidence" below.

---

## Tools

### Read tools — 6, server-side

Resolved server-side from the posted `SiteAgentSnapshot` (or, for `list_post_types`, the data repositories via `ctx.db`). No browser round-trip. Results are returned directly to the model.

| Tool              | What it returns                                                         |
|-------------------|-------------------------------------------------------------------------|
| `read_page`       | The active page as annotated HTML (`<body>` where every element carries `uid="<nodeId>"`) + the page's CSS in a `<style>` block (framework tokens, utility classes, class rules with `@media` breakpoint rules). Addresses nodes by `uid` — the same id write tools accept. Replaces the old JSON page-tree tools (`inspect_page`, `inspect_node`, `search_nodes`, `list_classes`, `inspect_class`). |
| `list_modules`    | Module registry (id, name, category, props schema, defaults); `category` filter |
| `list_breakpoints`| Configured breakpoints + active id                                      |
| `list_pages`      | All pages in the site (id, title, slug, active, isHomepage, and `template`: `null` or `{ target, priority }`) |
| `list_post_types` | Routable collections eligible as a `postTypes` template target — `{ slug, label, routeBase, kind }` per entry, filtered to a non-empty `routeBase`. Queries the data repositories via `ctx.db` |
| `list_tokens`     | Design tokens: colors (with shades/tints), typography/spacing scale steps, font tokens — each with CSS variable + utility classes; optional `family` filter (`colors`\|`typography`\|`spacing`\|`fonts`) |

### Write tools — 23, browser-bridged

All 23 tools carry `execution: 'browser'` in their `AiTool` definition. The server emits `toolRequest`; the browser executor validates input with TypeBox, runs the store action, and POSTs the canonical `AiToolOutput` result back.

**Structure (HTML-native)**

| Tool              | Input                                  | Success `data`        | What it does                                           |
|-------------------|----------------------------------------|-----------------------|--------------------------------------------------------|
| `insertHtml`      | `{ parentId, index?, html }`           | `{ nodeIds }`         | Parse HTML (+ any `<style>` CSS) → import as `PageNode`s under `parentId` |
| `getNodeHtml`     | `{ nodeId }`                           | `{ html }`            | Render subtree to HTML via the publisher's `renderNode`|
| `replaceNodeHtml` | `{ nodeId, html }`                     | `{ nodeIds }`         | Delete existing children; re-import HTML under the same parent |

Styling rides on the `html` payload — there is no separate `classes` parameter. The executor runs `importHtml(html)`, which harvests any `<style>` block's CSS, then hands it to `cssToStyleRules`. That classifier routes each selector:

- a bare `.foo {}` rule → a reusable Selectors-panel **class**, bound to every `class="foo"` node in the fragment;
- any other selector (`.hero a`, `a:hover`, `nav > li`, `@media …`) → an **ambient** rule (media queries fold into the matching breakpoint's `contextStyles`);
- inline `style="…"` attributes → the node's inline styles.

`insertImportedNodes` then links every `class=` token on the imported nodes to its registry class id in the same undo step, so `class="hero-section"` renders and is styleable whether its styles came from a `<style>` rule or an automatically-created bare class. See [html-import.md → Class linking](html-import.md#class-linking-name--id).

**Node edits**

| Tool              | Input                                      | Success `data`          | What it does                                               |
|-------------------|--------------------------------------------|-------------------------|------------------------------------------------------------|
| `updateNodeProps` | `{ nodeId, breakpointId?, patch }`         | none                    | Shallow-merge props; `breakpointId` requires schema `breakpointOverridable: true` |
| `moveNode`        | `{ nodeId, newParentId, newIndex }`        | none                    | Re-parent or reorder; `newIndex` is 0-based               |
| `deleteNode`      | `{ nodeId }`                               | none                    | Remove node and all descendants                            |
| `duplicateNode`   | `{ nodeId, count? }`                       | `{ nodeId, nodeIds }`   | Clone subtree 1–50 times right after the source           |
| `renameNode`      | `{ nodeId, label }`                        | none                    | Set the node's display label in the DOM panel (editor-only)|

**Classes**

| Tool                | Input                                  | Success `data` | What it does                                          |
|---------------------|----------------------------------------|----------------|-------------------------------------------------------|
| `createClass`       | `{ name, styles?, breakpointStyles? }` | `{ classId }`  | Create a new CSS class                                |
| `updateClassStyles` | `{ classId, breakpointId?, patch }`    | none           | Shallow-merge styles; `classId` accepts id or name    |
| `assignClass`       | `{ nodeId, classId }`                  | none           | Attach a class to a node; `classId` accepts id or name|
| `removeClass`       | `{ nodeId, classId }`                  | none           | Detach a class from a node (the class itself remains) |

**Pages**

| Tool            | Input                             | Success `data` | What it does                                               |
|-----------------|-----------------------------------|----------------|------------------------------------------------------------|
| `addPage`       | `{ title, slug? }`                | `{ pageId, rootNodeId }` | Create an empty page and make it active. Slug is auto-uniqued. Build into it via `insertHtml({ parentId: rootNodeId, … })` |
| `deletePage`    | `{ pageId }`                      | none           | Delete page; fails if it would leave the site with 0 pages |
| `renamePage`    | `{ pageId, title, slug? }`        | none           | Change title/slug; `slug="index"` makes this the homepage  |
| `duplicatePage` | `{ pageId, title, slug? }`        | `{ pageId }`   | Deep-clone page (all nodes, props, class assignments)      |

**Templates (CMS layouts)**

A template is a page carrying a `target` plus a single `<instatic-outlet>` where matched content flows in. These bridge to the editor's `convertPageToTemplate` / `convertTemplateToPage` store actions. The outlet itself is placed via `insertHtml` — the importer maps the custom `<instatic-outlet>` element to a `base.outlet` node (see [html-import.md](html-import.md) and [templates.md](templates.md)). No save-time outlet guard: a template with no outlet simply doesn't apply at render time.

| Tool                | Input                                                                 | Success `data` | What it does                                              |
|---------------------|----------------------------------------------------------------------|----------------|----------------------------------------------------------|
| `setPageTemplate`   | `{ pageId, target: {kind:'everywhere'} \| {kind:'postTypes', tableSlugs:[…]}, priority? }` | none | Convert a page to a template (or update its target/priority). `priority` defaults to 100. Get post-type slugs from `list_post_types` |
| `clearPageTemplate` | `{ pageId }`                                                         | none           | Revert a template to an ordinary page (drops target + dynamic bindings); errors if the page is not a template |

**Design system (tokens)**

The agent works **design-system-first**: it establishes or reuses tokens, then references them (`var(--<slug>)`, `--text-*`, `--space-*`, `var(--<font-var>)`) instead of hardcoding hex/px/font-family. Colors and fonts are list-shaped (one entry per token); typography and spacing are scale-shaped (a group config from which the framework generates per-step values). All four are **create-or-update** — keyed by color `slug`, font `variable`, or scale group — so re-runs patch in place. The executor dispatches to the framework/font store actions (`createFrameworkColorToken`, `create/updateFrameworkTypographyGroup`, `create/updateFrameworkSpacingGroup`, `addFont`/`createFontToken`).

| Tool                | Input                                                                 | Success `data`                              | What it does                                          |
|---------------------|----------------------------------------------------------------------|---------------------------------------------|-------------------------------------------------------|
| `set_color_tokens`  | `{ tokens: [{ slug, lightValue, category?, darkValue?, darkModeEnabled? }] }` | `{ tokens: [{ slug, ref, action }] }` | Create/update color tokens → `var(--<slug>)` + utilities/variants |
| `set_font_tokens`   | `{ tokens: [{ name, variable?, fallback?, googleFamily?, variants?, subsets?, familyId? }] }` | `{ tokens: [{ name, variable, ref, installed?, action }] }` | Create/update font tokens. `googleFamily` installs a new web font via `POST /admin/api/cms/fonts/install` then binds the token; `familyId` references an already-installed family; neither = fallback-only. `googleFamily`/`familyId` are mutually exclusive |
| `set_type_scale`    | `{ groupId?, namingConvention?, steps?, baseScaleIndex?, min?: { fontSize?, scaleRatio? }, max?: {…} }` | `{ groupId, action, namingConvention, generatedVars }` | Configure the typography scale → `--text-*`. Creates the group if none exists, else updates it |
| `set_spacing_scale` | `{ groupId?, namingConvention?, steps?, baseScaleIndex?, min?: { size?, scaleRatio? }, max?: {…} }` | `{ groupId, action, namingConvention, generatedVars }` | Configure the spacing scale → `--space-*`. Same shape as `set_type_scale` but `min`/`max` carry `size` |

**Capture**

| Tool              | Input                 | Success `data` | What it does                                                     |
|-------------------|-----------------------|----------------|------------------------------------------------------------------|
| `render_snapshot` | `{ breakpointId?, nodeId? }`   | `{ breakpointId, nodeId?, label, width, capturedAt, layout, screenshot }` + optional `images[]` | Inspect the rendered canvas: always returns a layout report (viewport, per-node bounding boxes, overflow / broken-image / invisible warnings); on a vision-capable model a PNG is attached via the tool-output **image channel**. `breakpointId` picks the frame (defaults to active); `nodeId` scopes the capture to that node's subtree — image and report cover only that section, with coordinates relative to its box, and the report carries the same `nodeId`. Omit `nodeId` for the whole page; an unknown `nodeId` returns an `aiToolError` |

### Heavy evidence — image channel + vision gating + elision

`render_snapshot` (and `read_page` / `getNodeHtml`) return large payloads. Three rules keep them from exploding context (a screenshot inlined as base64 JSON text once pushed a single turn past 1M tokens):

1. **Image channel, not text.** `AiToolOutput` carries an optional `images: { mimeType, data }[]` (`src/core/ai/toolOutput.ts`). `render_snapshot` puts the PNG there — never in `data`. The Anthropic driver forwards it as a **native `image` block** inside the `tool_result` (billed at the rendered image's token cost). Text-only tool channels (Ollama / OpenAI-compatible `function_call_output`) **drop** the image and append a one-line `[N screenshot(s) omitted…]` note. The capture caps the screenshot's long edge at `MAX_IMAGE_EDGE` (1568px in `renderEvidence.ts`) — a tall landing page would otherwise exceed Anthropic's hard 8000px-per-dimension limit (400 error), and the model downsizes the long edge to ~1568px anyway.
2. **Capture is vision-gated.** The chat handler resolves `driver.capabilities(modelId)` into `AiStreamRequest.modelCapabilities`. The shared tool loop injects `captureScreenshot: visionInput` into every `render_snapshot` call, so a non-vision model never pays the html-to-image cost — it gets the layout report only. (The model never sets `captureScreenshot` itself.)
3. **Stale evidence is elided.** Within one tool loop, only the **most recent** heavy result per tool name (`render_snapshot`, `read_page`, `getNodeHtml`, or anything with an image) is replayed at full fidelity; earlier ones are rewritten to a one-line breadcrumb (`"Earlier <tool> output removed… Call <tool> again…"`). Older snapshots describe page state the model has since mutated, so they carry no value. See `applyHeavyElision` in `server/ai/drivers/http/toolLoop.ts`.

---

## System prompt

`server/ai/tools/site/systemPrompt.ts` builds a 3-element array:
```ts
[staticPrefix, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, dynamicSuffix]
```
Drivers that support prompt caching (Anthropic) apply `cache_control` to the static prefix automatically; drivers that don't concatenate the three strings. Content is intentionally static across providers — every observable behaviour comes from the tool definitions, not prompt knobs.

**Static prefix** (full text in `server/ai/tools/site/systemPrompt.ts`):
- **Design system first.** Establish or reuse tokens before/while building (`set_color_tokens`, `set_type_scale`, `set_spacing_scale`, `set_font_tokens`), then reference them in CSS (`var(--<slug>)`, `var(--text-l)`, `var(--space-m)`, `var(--<font-var>)`) instead of raw hex/px/font-family. The dynamic suffix's `Tokens —` line shows what already exists; `(none …)` means no design system yet.
- Structure as HTML (`insertHtml` / `replaceNodeHtml`); style with CSS in the same payload — a `<style>` block and/or `class=` attributes referencing the design tokens. The importer classifies selectors, so the agent never hand-builds classes at insert time.
- `<style>` blocks inside imported HTML are parsed: a bare `.foo {}` rule becomes a Selectors-panel class bound to `class="foo"`; any other selector (`.hero a`, `a:hover`, `@media …`) becomes an ambient rule. `style=` attributes land on the node's inline styles. These are applied — not stripped.
- One `insertHtml` call per logical section (nav, hero, pricing, footer = 4–6 calls); smaller chunks recover better if one fails.
- Per-breakpoint variation: `@media` queries in the `<style>` block (matched against the site breakpoints), or `breakpointStyles` on `createClass`, keyed by breakpoint ids **verbatim from the dynamic suffix** — never invent ids like `"mobile"` or `"desktop"`.
- Page ids come from the dynamic suffix; never invent them.
- Write-tool success data uses explicit keys: `classId` for `createClass`, `pageId` for `addPage`/`duplicatePage`, `nodeId`/`nodeIds` for `duplicateNode`, `nodeIds` for HTML inserts.
- Editing existing content: call `read_page` first — it returns the annotated page HTML where every element carries `uid="<nodeId>"`; pass that `uid` verbatim to write tools (`updateNodeProps`, `replaceNodeHtml`, etc.). For a single subtree, `getNodeHtml` is sufficient.
- Reply rule: 1–2 narrating sentences only. No raw HTML/CSS/JSON in the reply.

**Dynamic suffix** (built per request by `buildDynamicSuffix(snap: SiteAgentSnapshot)`):
```text
Page: "My Site" · root: <rootNodeId> · selected: <nodeId|none>
· active breakpoint: <id> · all breakpoints: [<id>@<width>px, …]
· Pages: [<id>=<slug> (active), <id>=<slug>, …]
· Tokens — colors: [primary=…, ink=…]; type --text-*: [xs, s, m, …]; spacing --space-*: […]; fonts: [--font-heading→Inter]
```
The static prefix is cache-friendly (unchanged across prompts for the same provider). The dynamic suffix carries per-request state and is never cached. The `Tokens —` digest is a compact, always-inlined summary of the site's design tokens (`describeAgentTokens(snap.site)`) so the agent sees the design system every turn without a `list_tokens` round-trip; when no tokens exist it reads `Tokens: (none — no design system yet; establish one first …)`. `list_tokens` remains the on-demand full-detail read (variants, utility classes).

---

## Why HTML-native

The previous tool surface required the model to reference internal module ids (`base.text`, `base.container`, …) and construct node trees as structured JSON. The current surface lets the model write plain HTML:

- LLMs produce correct semantic HTML far more reliably than custom JSON node-tree payloads.
- No module enumeration is needed in the system prompt — shorter context, lower token cost.
- The importer (`@core/htmlImport`) guarantees every element becomes a first-class editable `PageNode`: selectable, draggable, deletable, and re-styleable in the canvas.
- `getNodeHtml` (backed by the publisher's `renderNode`) gives the agent read-back at the same semantic level it writes.

The same importer that powers the Agent's `insertHtml` tool also powers the paste-HTML UI — see `docs/features/html-import.md`. No duplicated mapping logic.

**Reads are HTML-native.** The `read_page` tool replaced the five JSON page-tree tools (`inspect_page`, `inspect_node`, `search_nodes`, `list_classes`, `inspect_class`). A benchmark (`snapshot-tokens`) confirmed that the HTML+CSS representation costs ~0.61× the tokens of the JSON snapshot (306,033 vs 499,257 tokens over 6 real pages). `read_page` renders the active page via `publishPage(..., { annotateNodeIds: true })` + `buildSiteCssBundle`, returning an annotated `<body>` where every element carries `uid="<nodeId>"`. The agent reads `uid` values from the HTML and passes them verbatim to write tools — no separate node-lookup round-trip. Catalog tools (`list_modules`, `list_tokens`, `list_pages`, `list_breakpoints`) describe things not visible in the page HTML (what is insertable, design token CSS vars, page list) and remain as JSON tools.

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
  /** Active ai_conversations row id — created lazily on first send. */
  agentConversationId:       string | null
  /** Active (credentialId, modelId) surfaced by the model picker. */
  agentActiveCredentialId:   string | null
  agentActiveModelId:        string | null
  /** Conversation summaries for the history popover. */
  agentConversations:        ConversationView[]
  /**
   * Provider-normalised total input the model processed on the latest turn,
   * for the ContextMeter. Null for a fresh conversation (no turns yet); the
   * meter then shows 0 against the window. Hydrated from `ConversationView.contextTokens`
   * on loadAgentConversation; updated live from each turn's `usage` event.
   */
  agentContextTokens:        number | null

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
  /** Change which credential + model is active. Updates the conversation row if one exists; stages the values for the next create if not. Also clears `agentError` so a sticky "no provider" error doesn't keep the composer disabled after the user picks a model. */
  setAgentProvider(credentialId: string, modelId: string): Promise<void>
  /** Preload the per-scope default (credentialId, modelId) from GET /admin/api/ai/defaults. No-op when a conversation or explicit pick is already active. Called by AgentPanel on open. */
  loadScopeDefault():                                  Promise<void>
}
```

Conversations and their message history are persisted server-side in `ai_conversations` + `ai_messages`. `loadAgentConversation(id)` rehydrates a past thread into `agentMessages` without re-running the conversation.

---

## Context meter and live model catalogue

### Context meter

The `<ContextMeter>` shows how much of the active model's context window the current conversation has consumed. Two data sources drive it:

- **Window** (`windowTokens` prop from `AgentPanel`): the model's max total tokens, resolved once from `GET /admin/api/ai/providers/:id/models?credentialId=…`. The models endpoint enriches Anthropic and OpenAI models with `contextWindow` from the live OpenRouter catalogue (`server/ai/pricing/`); OpenRouter populates it from its own native fetch. Ollama models and uncatalogued models have no window — the meter hides.
- **Used** (`agentContextTokens` in the store): the provider-normalised "context used" — the CURRENT context size, computed by `normalizeContextTokens(providerId, buckets)` in `server/ai/contextTokens.ts`:
  - Anthropic reports `input_tokens` excluding cache buckets, so the true total is `promptTokens + cacheReadTokens + cacheCreationTokens`.
  - OpenAI / OpenRouter / Ollama report `input_tokens` as the full input; `promptTokens` alone is the total.

**Live, per-round, not summed.** A turn makes one provider round-trip per tool batch. The toolLoop emits a `context` event **each round** carrying THAT round's input buckets; the chat handler injects the normalised `contextTokens` and the browser updates the meter on every round — so it climbs *during* a long tool loop instead of only at the end. The meter is the LATEST round's input (the current window fill), never the sum across rounds (which would over-count, since each round re-sends the growing context). The terminal `usage` event is **billing only** — its `promptTokens` stays summed across rounds (you pay input per round). The persister keeps the latest `context` value in memory (`recordContext`) and writes it once to `ai_conversations.context_tokens` with the final `usage` (overwritten per turn), so `loadAgentConversation` restores the true context on reload.

### Live model catalogue

`server/ai/pricing/` is the single source for per-model prices **and context windows**. It sources from OpenRouter's public `/api/v1/models` endpoint (no key required), which publishes list prices and `context_length` for Anthropic and OpenAI models. The module lifecycle:

- **Cold start**: loads the DB cache from `ai_model_pricing` (durable fallback) and kicks a background refresh. The first turn prices immediately off the last-known data.
- **No DB cache yet**: blocks once on a live fetch.
- **Thereafter**: serves from a 6-hour in-memory memo, refreshing in the background past the TTL.
- A failed refresh is logged and keeps the previous data — never fatal.

`pricingKey(modelId)` normalises a provider's native id (`claude-opus-4-8-20260514`) and the OpenRouter slug (`anthropic/claude-opus-4.8`) to the same key (`claude-opus-4-8`), stripping date suffixes, dots, and provider prefixes. Variant suffixes (`:thinking`, `-fast`) are preserved — they have different pricing.

The `getModelCatalogue(db)` export (used by the models handler for picker enrichment) and `resolveCostUsd(db, providerId, modelId, usage)` (used by the persister) share the same in-memory cache. Two callers, one memo.

### Auto-defaults on credential creation

When `POST /admin/api/ai/credentials` creates a new credential, `seedEmptyDefaults` auto-assigns it as the default for every scope (`site`, `content`, `data`, `plugin`) that has no default yet. The default model is the `tier === 'smartest'` entry from `driver.listModels()`, or the first model if no smartest tier is found. If the model list can't be resolved (offline, bad key), seeding is skipped silently — it never fails the credential creation. Scopes that already point at a credential are left untouched.

---

## Abort + crash recovery

- **Abort.** "Stop" calls `agentSlice.abortAgent()` → `AbortController.abort()` → the fetch stream closes. When the abort signal fires on the server:
  - `req.signal` is passed straight to every `fetch()` call in the driver loop (`fetch(endpoint, { signal })`). The in-flight HTTP request to the provider is cancelled immediately — no further tokens are generated or billed. On `AbortError` the loop returns cleanly with no `error` event.
  - Any `callBrowser` promise still waiting for a browser tool-result rejects via the `onAbort` listener registered per pending call (in `server/ai/runtime/transport.ts`). The listener fires, clears the timeout, and removes the pending entry.
  - The stream's `destroy()` hook fires, rejects any remaining pending entries, and removes the bridge from the registry.
- **Browser tool timeout.** If the browser never POSTs a tool-result, `callBrowser` rejects after 90 seconds (`BROWSER_TOOL_TIMEOUT_MS` in `server/ai/runtime/transport.ts`). The driver sees a rejection, emits an error, and the stream closes. This prevents a closed or unresponsive tab from hanging the tool loop indefinitely.
- **Crash on server.** If `runChat` throws, the stream emits `{ type: 'error', message }`. The browser surfaces the message verbatim in the Agent Panel (admin-only surface, so info-disclosure is not a concern).
- **Tool failure.** Browser executors wrap every call in try/catch. Failures return `{ ok: false, error }`. The model reads the error message in the next turn and retries with corrected input.
- **Bridge-result POST after abort.** If the browser POSTs a tool-result after the stream has closed, the server returns 404 and drops the result silently.
- **Page reload mid-stream.** The stream dies. The conversation row and its persisted messages survive. The user can reload the past thread via `loadAgentConversation` and re-send.

---

## Forbidden patterns

| Pattern | Use instead |
|---|---|
| Importing any provider SDK (`@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, `@openai/agents`, `@openrouter/agent`, `@modelcontextprotocol/sdk`) | Banned repo-wide — no exceptions, including inside `server/ai/drivers/`. Drivers talk directly to the REST API. Gated by `ai-driver-isolation.test.ts`. |
| Importing `zod` anywhere | Banned repo-wide — TypeBox schemas pass directly as JSON Schema to every provider. Gated by `ai-driver-isolation.test.ts`. |
| Routing a write tool as a server-side read (resolving from snapshot) | Write tools are `execution: 'browser'` — they must go through the bridge. The editor store is the write authority. |
| Using invented breakpoint ids in `breakpointStyles` (`"mobile"`, `"desktop"`, etc.) | Use verbatim ids from the dynamic suffix. Invalid ids are rejected by the executor. |
| Editing nodes outside the active page | Agent mutations target the active page tree. Cross-page edits require the user to switch pages first. |

---

## Related

- `docs/features/html-import.md` — the `importHtml` pipeline that `insertHtml` and `replaceNodeHtml` run through
- `docs/editor.md` — agent slice composition inside the editor store
- `docs/server.md` — handler routing; `/admin/api/ai/` is matched before `/admin/api/cms/`
- `docs/features/auth-and-access.md` — capability model (`ai.chat`, `ai.tools.write`)
- Source-of-truth files:
  - `src/core/ai/toolOutput.ts` — `AiToolOutput` type, `AiToolOutputSchema`, `aiToolOk`, `aiToolError` (canonical bridge result)
  - `src/core/ai/index.ts` — barrel re-exporting the above
  - `server/ai/tools/site/writeTools.ts` — 23 browser-bridged write tool definitions (TypeBox schemas)
  - `server/ai/tools/site/readTools.ts` — 6 server-side read tool definitions
  - `server/ai/tools/site/render.ts` — `renderAgentPage`, `describeAgentModules`, `describeAgentTokens`, `filterTokenFamily`
  - `server/ai/tools/site/systemPrompt.ts` — HTML-native system prompt
  - `server/ai/tools/site/snapshot.ts` — `SiteAgentSnapshot` re-export + catalog output types (`ModuleInfo`, `SnapshotTokens`, …)
  - `src/admin/pages/site/agent/siteAgentSnapshot.ts` — `SiteAgentSnapshot` raw-tree wire type + `buildSiteAgentSnapshot`
  - `server/ai/handlers/chat.ts` — `POST /admin/api/ai/chat/site` endpoint
  - `server/ai/handlers/toolResult.ts` — `POST /admin/api/ai/tool-result` endpoint
  - `server/ai/runtime/runner.ts` — `runChat()` driver loop
  - `server/ai/contextTokens.ts` — `normalizeContextTokens()` — provider-normalised "context used" for the meter
  - `server/ai/pricing/index.ts` — `resolveCostUsd`, `getModelCatalogue`, `computeCostUsd`
  - `server/ai/pricing/openrouterCatalogue.ts` — `fetchOpenRouterCatalogue`, `pricingKey`, `ModelCatalogue`
  - `server/ai/pricing/store.ts` — durable `ai_model_pricing` DB cache
  - `server/ai/runtime/persister.ts` — `ConversationsPersister` interface + `createConversationsPersister()`
  - `server/ai/runtime/types.ts` — canonical `AiStreamEvent`, `AiMessage`, `AiTool`, `ToolContext` types
  - `server/ai/runtime/transport.ts` — `createBridge()` / `resolveBridgeToolResult()`
  - `src/admin/pages/site/agent/agentSlice.ts` — scope-agnostic slice factory (`createAgentSlice`)
  - `src/admin/pages/site/agent/agentSliceConfig.site.ts` — site-editor scope config
  - `src/admin/pages/site/agent/agentApi.ts` — tool-result POST, conversation bootstrap, message rehydration
  - `src/admin/pages/site/agent/streamEvents.ts` — `ServerStreamEventSchema` + `processStreamEvent`
  - `src/admin/pages/site/agent/pageContext.ts` — `buildCurrentPageContext`
  - `src/admin/pages/site/agent/executor.ts` — write-tool browser dispatcher
  - `src/admin/pages/site/agent/agentConfig.ts` — API path constants
  - `src/admin/pages/site/agent/renderEvidence.ts` — `captureAgentRenderSnapshot`
  - `src/admin/pages/site/agent/types.ts` — `ServerStreamEvent`, `AgentMessage`, `AgentRequestBody`, …
  - `src/admin/pages/site/agent/index.ts` — public barrel
  - `src/admin/pages/content/agent/contentAgentStore.ts` — standalone content-workspace agent store
  - `src/admin/pages/site/panels/AgentPanel/AgentPanel.tsx` — Agent Panel; resolves `contextWindow` for the meter
  - `src/admin/pages/site/panels/AgentPanel/ContextMeter.tsx` — context used / window progress bar
- Gate tests:
  - `src/__tests__/architecture/ai-driver-isolation.test.ts`
  - `src/__tests__/architecture/ai-tools-typebox-only.test.ts`
  - `src/__tests__/architecture/ai-handlers-capability-gated.test.ts`
