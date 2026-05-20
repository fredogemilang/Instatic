/**
 * Plugin worker IPC protocol.
 *
 * Plugin server modules run inside a Bun `Worker` so:
 *  1. The host process never `import()`s plugin code, eliminating the
 *     `bun --watch` race where a plugin file in the watch graph gets
 *     deleted (during upgrade cleanup) and triggers a server reload
 *     mid-response.
 *  2. A throwing or runaway plugin can't take down the host process —
 *     the worker can be terminated and respawned without affecting
 *     in-flight HTTP requests on other plugins.
 *  3. A future hardening step can drop privileges (no fs / no env)
 *     inside the worker without affecting the host.
 *
 * Design:
 *  - Single shared worker for all plugins (per server process). One
 *    bad plugin therefore can take out its peers, but adding per-plugin
 *    workers later is purely additive — same protocol, multiple workers.
 *  - All messages carry a `correlationId` (nanoid) so request/reply
 *    pairs can be matched even when interleaved.
 *  - Two directions of RPC:
 *      MainToWorker — host invokes plugin code (lifecycle, route handler,
 *        hook listener / filter, loop fetch).
 *      WorkerToMain — plugin code calls into the host's `ServerPluginApi`
 *        (storage, hook emit, settings replace, log, register-route, …).
 *  - Responses use a uniform shape: `{ kind: '*-result', correlationId,
 *    ok, value? | error? }` with `error` carrying a serialized message
 *    string (full Error chain isn't reconstructed across the boundary —
 *    plugins log their own stacks, the host logs `[plugin:<id>]` prefix).
 */

import { Type, type Static, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { PropertySchemaSchema } from '@core/module-engine/propertySchema'
import type { PluginManifest } from '@core/plugin-sdk'

// ---------------------------------------------------------------------------
// Shared serialization helpers
// ---------------------------------------------------------------------------

/** Serialized HTTP request — only the fields plugin route handlers can read. */
export interface SerializedRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** Stringified body (typed to JSON-serializable text — large bodies aren't supported in v1). */
  body: string
}

/**
 * Serialized response from a plugin route handler. `value` is the
 * JSON-serializable return; if the plugin returned an actual `Response`
 * via `new Response(...)` the worker pre-extracts status/headers/body.
 */
export type SerializedResponse =
  | { kind: 'json'; value: unknown }
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string }

export interface SerializedUser {
  id: string
  email: string
  capabilities: string[]
}

// ---------------------------------------------------------------------------
// Main → Worker
// ---------------------------------------------------------------------------

export type MainToWorkerMessage =
  | LoadPluginRequest
  | UnloadPluginRequest
  | RunLifecycleRequest
  | RunMigrateRequest
  | RunRouteRequest
  | RunHookListenerRequest
  | RunHookFilterRequest
  | RunLoopFetchRequest
  | RunLoopPreviewRequest
  | RunScheduleRequest
  | RunMediaAdapterCallRequest
  | RunMediaUrlTransformerRequest
  | ApiReply

export interface LoadPluginRequest {
  kind: 'load-plugin'
  correlationId: string
  pluginId: string
  manifest: PluginManifest
  /** Absolute path to the plugin's server entrypoint module. */
  entryFileUrl: string
  /** Settings snapshot — populated into the worker's local cache so
   *  `settings.get` can resolve synchronously inside the plugin code. */
  settings: Record<string, string | number | boolean>
}

export interface UnloadPluginRequest {
  kind: 'unload-plugin'
  correlationId: string
  pluginId: string
}

export interface RunLifecycleRequest {
  kind: 'run-lifecycle'
  correlationId: string
  pluginId: string
  hook: 'install' | 'activate' | 'deactivate' | 'uninstall'
}

export interface RunMigrateRequest {
  kind: 'run-migrate'
  correlationId: string
  pluginId: string
  fromVersion: string
}

export interface RunRouteRequest {
  kind: 'run-route'
  correlationId: string
  pluginId: string
  routeKey: string
  request: SerializedRequest
  user: SerializedUser | null
  body: Record<string, unknown>
}

export interface RunHookListenerRequest {
  kind: 'run-hook-listener'
  correlationId: string
  pluginId: string
  listenerId: string
  event: string
  payload: unknown
}

export interface RunHookFilterRequest {
  kind: 'run-hook-filter'
  correlationId: string
  pluginId: string
  filterId: string
  name: string
  value: unknown
}

export interface RunLoopFetchRequest {
  kind: 'run-loop-fetch'
  correlationId: string
  pluginId: string
  sourceId: string
  ctx: unknown
}

export interface RunLoopPreviewRequest {
  kind: 'run-loop-preview'
  correlationId: string
  pluginId: string
  sourceId: string
  ctx: unknown
}

/**
 * Fire a scheduled job inside the plugin's worker. Sent by the host
 * `scheduler.ts` tick when a schedule's `next_run_at` has passed and the
 * row has been claimed via the HA lock. The worker invokes the stored
 * handler inside the QuickJS sandbox and replies with a `schedule-result`
 * carrying the status + measured duration.
 */
export interface RunScheduleRequest {
  kind: 'run-schedule'
  correlationId: string
  pluginId: string
  scheduleId: string
  /** Wall-clock budget for this fire. Overrides the VM's default 5s deadline. */
  maxDurationMs: number
}

/**
 * Methods on a `MediaStorageAdapter` the host can invoke. Mirrors the
 * adapter contract in `src/core/plugin-sdk/types.ts` exactly. One generic
 * runner is used (vs. one runner per method) because every adapter
 * exposes the same set of named callbacks; routing in the VM is just a
 * property lookup on the handler object.
 */
export type MediaAdapterMethod =
  | 'beginWrite'
  | 'finalizeWrite'
  | 'abortWrite'
  | 'delete'
  | 'getReadUrl'
  | 'verify'

/**
 * Invoke a method on a plugin-registered media storage adapter. The host
 * builds these in `mediaStorageRegistry`-wrapping adapter shims that the
 * upload pipeline calls; the shim turns each call into one of these
 * requests and awaits the matching `media-adapter-call-result`.
 *
 * `args` is the JSON-serializable input passed to the method. Bytes are
 * NEVER part of `args` — the adapter signs upload plans; the host
 * streams bytes directly via `executeUploadPlan` outside the sandbox.
 */
export interface RunMediaAdapterCallRequest {
  kind: 'run-media-adapter-call'
  correlationId: string
  pluginId: string
  adapterId: string
  method: MediaAdapterMethod
  args: unknown
}

/**
 * Invoke a registered URL transformer. The transformer takes a media path
 * and a context, returns either a rewritten path or `null` (which the
 * caller treats as pass-through). Multiple transformers chain in
 * registration order — the host chains them via `hookBus.filter` so the
 * same pipeline as the rest of the CMS handles chaining + error fallback.
 */
export interface RunMediaUrlTransformerRequest {
  kind: 'run-media-url-transformer'
  correlationId: string
  pluginId: string
  transformerId: string
  /** Single { path, ctx } payload — kept opaque here so the schema lives in one place. */
  payload: unknown
}

/** Host's reply to a worker-initiated `api-call`. */
export interface ApiReply {
  kind: 'api-reply'
  correlationId: string
  ok: boolean
  value?: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// Worker → Main
// ---------------------------------------------------------------------------

export type WorkerToMainMessage =
  | LoadPluginResult
  | UnloadPluginResult
  | LifecycleResult
  | RouteResult
  | HookListenerResult
  | HookFilterResult
  | LoopFetchResultMessage
  | LoopPreviewResult
  | ScheduleResult
  | MediaAdapterCallResult
  | MediaUrlTransformerResult
  | ApiCall
  | WorkerLogEvent

export interface LoadPluginResult {
  kind: 'load-plugin-result'
  correlationId: string
  ok: boolean
  error?: string
  /**
   * List of hook names the plugin module exports. Lets the host skip the
   * round-trip when calling a non-existent lifecycle hook.
   */
  hooks?: Array<'install' | 'activate' | 'deactivate' | 'uninstall' | 'migrate'>
}

export interface UnloadPluginResult {
  kind: 'unload-plugin-result'
  correlationId: string
  ok: boolean
}

export interface LifecycleResult {
  kind: 'lifecycle-result'
  correlationId: string
  ok: boolean
  error?: string
}

export interface RouteResult {
  kind: 'route-result'
  correlationId: string
  ok: boolean
  response?: SerializedResponse
  error?: string
}

export interface HookListenerResult {
  kind: 'hook-listener-result'
  correlationId: string
  ok: boolean
  error?: string
}

export interface HookFilterResult {
  kind: 'hook-filter-result'
  correlationId: string
  ok: boolean
  /** Plugin-transformed value (when ok). */
  value?: unknown
  error?: string
}

export interface LoopFetchResultMessage {
  kind: 'loop-fetch-result'
  correlationId: string
  ok: boolean
  /** `{ items, totalItems }` shape from the plugin's source — re-validated host-side. */
  value?: { items: unknown[]; totalItems: number }
  error?: string
}

export interface LoopPreviewResult {
  kind: 'loop-preview-result'
  correlationId: string
  ok: boolean
  value?: unknown[]
  error?: string
}

/**
 * Outcome of a scheduled fire. `durationMs` is measured inside the worker
 * (start of handler call to handler return / throw) so the host's
 * recorded latency reflects the plugin's actual work, not transport
 * overhead. `status='timeout'` is set when the VM aborted via its
 * deadline interrupt — the error message will reflect that.
 */
export interface ScheduleResult {
  kind: 'schedule-result'
  correlationId: string
  ok: boolean
  /** 'ok' on success, 'error' on a throw, 'timeout' when the deadline aborted. */
  status: 'ok' | 'error' | 'timeout'
  error?: string
  durationMs: number
}

export interface MediaAdapterCallResult {
  kind: 'media-adapter-call-result'
  correlationId: string
  ok: boolean
  value?: unknown
  error?: string
}

export interface MediaUrlTransformerResult {
  kind: 'media-url-transformer-result'
  correlationId: string
  ok: boolean
  /** Plugin-transformed path. When `null`, the caller falls back to the
   *  previous value (chain pass-through). */
  value?: string | null
  error?: string
}

/**
 * Worker-initiated call into the host's ServerPluginApi. Awaiting an
 * `ApiReply` with the same correlationId.
 *
 * `target` is a dotted path like `cms.storage.list`, `cms.hooks.emit`,
 * `cms.routes.register`, `cms.settings.replace`, `cms.loops.registerSource`,
 * `cms.hooks.on`, `cms.hooks.filter`. The host validates each target
 * against an allowlist before dispatch.
 */
export interface ApiCall {
  kind: 'api-call'
  correlationId: string
  pluginId: string
  target: string
  args: unknown[]
}

/**
 * Plugin `api.plugin.log(...)` — fire-and-forget, no correlation id.
 * Host prints with `[plugin:<id>]` prefix.
 */
export interface WorkerLogEvent {
  kind: 'log'
  pluginId: string
  args: unknown[]
}

// ---------------------------------------------------------------------------
// Allowlist of API targets the host accepts from a worker
// ---------------------------------------------------------------------------

const ALLOWED_API_TARGETS = [
  // Routes — recorded but not actually invoked from worker (worker is the
  // origin of registration; main is the consumer). Host stores route
  // handler ids per pluginId+method+path.
  'cms.routes.register',
  // Hooks
  'cms.hooks.on',
  'cms.hooks.filter',
  'cms.hooks.emit',
  // Loops
  'cms.loops.registerSource',
  // Storage
  'cms.storage.list',
  'cms.storage.create',
  'cms.storage.update',
  'cms.storage.delete',
  // Settings (read is local to worker via settings cache; replace is RPC)
  'cms.settings.replace',
  // Network — gated by `network.outbound` permission + manifest's
  // `networkAllowedHosts`. Host validates the URL host BEFORE making the
  // outbound request.
  'network.fetch',
  // Companion to network.fetch: cancels an in-flight request when the
  // plugin's AbortSignal fires. Cheap no-op if the host has already
  // returned for that abortId (e.g. the response landed first).
  'network.abort',
  // Scheduled jobs — gated by `cms.schedule`. Plugin calls register/cancel
  // during activate; the host upserts a row in `plugin_schedules` and the
  // scheduler tick (server/plugins/scheduler.ts) fires the registered
  // handler on cadence.
  'cms.schedule.register',
  'cms.schedule.cancel',
  // Media subsystem — three independent surfaces.
  //   • registerStorageAdapter — declares an exclusive storage backend the
  //     admin can elect per asset role. Bytes never cross the sandbox;
  //     the adapter only signs upload plans + handles delete/verify.
  //   • registerUrlTransformer — chained pure path → path rewriter.
  //   • registerVariantDelegate — replaces local variant ladder with a
  //     URL template (image-transform CDNs).
  'cms.media.registerStorageAdapter',
  'cms.media.registerUrlTransformer',
  'cms.media.registerVariantDelegate',
  // ── Crypto primitives ────────────────────────────────────────────────
  // SHA-256 / HMAC-SHA256 are needed for AWS Sigv4, OAuth1.0a, JWT signing,
  // S3 presigned URL generation, etc. — the kind of work storage / auth
  // plugins do routinely. Without these the plugin would have to vendor
  // a pure-JS HMAC implementation; not impossible but error-prone enough
  // that we expose a thin host bridge instead. No permission gate — these
  // are pure computation, no I/O, no privilege escalation (same shape as
  // `Math` or `JSON`).
  'crypto.digest',
  'crypto.signHmac',
] as const

type AllowedApiTarget = typeof ALLOWED_API_TARGETS[number]

function isAllowedApiTarget(target: string): target is AllowedApiTarget {
  return (ALLOWED_API_TARGETS as readonly string[]).includes(target)
}

// ---------------------------------------------------------------------------
// Runtime validation for worker-initiated api-calls
// ---------------------------------------------------------------------------

/**
 * Shared host-pattern regex — same shape as `manifest.ts`. Re-declared here
 * (instead of imported) so this file stays a single source of truth for the
 * worker IPC schemas and doesn't pull in manifest validation.
 */
const NETWORK_HOST_PATTERN = /^(?:\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

const RouteMethodSchema = Type.Union([
  Type.Literal('GET'),
  Type.Literal('POST'),
  Type.Literal('PATCH'),
  Type.Literal('DELETE'),
])

const RouteRegistrationArgSchema = Type.Object(
  {
    method: RouteMethodSchema,
    path: Type.String({ minLength: 1 }),
    capability: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    routeKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const HookListenerArgSchema = Type.Object(
  {
    event: Type.String({ minLength: 1 }),
    listenerId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const HookFilterArgSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    filterId: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)

const HookEmitArgSchema = Type.Object(
  {
    event: Type.String({ minLength: 1 }),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
)

const LoopSourceFieldSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    format: Type.Optional(Type.Union([
      Type.Literal('plain'),
      Type.Literal('html'),
      Type.Literal('url'),
      Type.Literal('media'),
    ])),
  },
  { additionalProperties: false },
)

const LoopSourceDescriptorSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    filterSchema: PropertySchemaSchema,
    orderByOptions: Type.Array(Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    )),
    fields: Type.Array(LoopSourceFieldSchema),
  },
  { additionalProperties: false },
)

const JsonRecordSchema = Type.Record(Type.String(), Type.Unknown())

const NetworkFetchInitSchema = Type.Object(
  {
    method: Type.Optional(Type.String({ maxLength: 16 })),
    headers: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.String()),
    // Plugin-minted correlation id for AbortSignal cancellation. The
    // bootstrap's fetch polyfill assigns this when the call has a signal;
    // if the signal fires, the polyfill posts `network.abort` with the
    // same id so the host can drop the in-flight request. Plain JS
    // identifier shape — the bootstrap generates `'a' + counter + '_' + ts36`.
    abortId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_]+$' })),
  },
  { additionalProperties: false },
)

const NetworkAbortArgSchema = Type.Object(
  {
    abortId: Type.String({ minLength: 1, maxLength: 128, pattern: '^[a-zA-Z0-9_]+$' }),
  },
  { additionalProperties: false },
)

// Cadence shapes the plugin can pass to `cms.schedule.register`. Mirrors
// the `Cadence` union in `server/repositories/pluginSchedules.ts` — both
// must move in lockstep. The validator rejects anything that doesn't
// match one of the documented intervals.
const TimeOfDayPattern = '^([01][0-9]|2[0-3]):[0-5][0-9]$'

const CadenceSchema = Type.Union([
  Type.Object({ interval: Type.Literal('hourly') }, { additionalProperties: false }),
  Type.Object(
    {
      interval: Type.Literal('daily'),
      at: Type.String({ pattern: TimeOfDayPattern }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      interval: Type.Literal('weekly'),
      at: Type.String({ pattern: TimeOfDayPattern }),
      day: Type.Union([
        Type.Literal('mon'), Type.Literal('tue'), Type.Literal('wed'),
        Type.Literal('thu'), Type.Literal('fri'), Type.Literal('sat'),
        Type.Literal('sun'),
      ]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      interval: Type.Literal('monthly'),
      at: Type.String({ pattern: TimeOfDayPattern }),
      // Capped at 28 so February never breaks. Schedules that need
      // last-day-of-month behaviour can use 'every' with 1440-minute
      // intervals plus an in-handler check.
      dayOfMonth: Type.Integer({ minimum: 1, maximum: 28 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      interval: Type.Literal('every'),
      // Lower bound of 1 minute is deliberate — sub-minute schedules
      // collide with the 10s tick polling resolution and would surprise
      // authors who expect them to fire on the second.
      minutes: Type.Integer({ minimum: 1, maximum: 1440 }),
    },
    { additionalProperties: false },
  ),
])

const ScheduleRegisterArgSchema = Type.Object(
  {
    scheduleId: Type.String({ minLength: 1, maxLength: 120 }),
    cadence: CadenceSchema,
    overlap: Type.Union([
      Type.Literal('skip'),
      Type.Literal('queue'),
      Type.Literal('parallel'),
    ]),
    // Per-schedule wall-clock budget. Bounded so a plugin can't pin a
    // worker indefinitely; longer work should chunk and yield.
    maxDurationMs: Type.Integer({ minimum: 100, maximum: 5 * 60_000 }),
  },
  { additionalProperties: false },
)

const ScheduleCancelArgSchema = Type.Object(
  {
    scheduleId: Type.String({ minLength: 1, maxLength: 120 }),
  },
  { additionalProperties: false },
)

// ---------------------------------------------------------------------------
// Media subsystem — registration payloads (callbacks themselves live INSIDE
// the VM; only metadata crosses the host bridge).
// ---------------------------------------------------------------------------

const MEDIA_ID_PATTERN = '^[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*)+$'
const MEDIA_ROLE_VALUES = ['original', 'variant', 'avatar', 'font', 'plugin-pack'] as const

const MediaRoleSchema = Type.Union(MEDIA_ROLE_VALUES.map((v) => Type.Literal(v)))

const MediaServingModeSchema = Type.Union([
  Type.Literal('public-url'),
  Type.Literal('signed-redirect'),
  Type.Literal('proxy'),
])

const MediaCspOriginSchema = Type.Object(
  {
    directive: Type.Union([
      Type.Literal('img-src'),
      Type.Literal('media-src'),
      Type.Literal('connect-src'),
    ]),
    // Same hostname shape that gates outbound fetch — keeps the CSP surface
    // narrow (no schemes, no paths, no port suffixes; the host renders
    // `https://<origin>` itself).
    origin: Type.String({ pattern: NETWORK_HOST_PATTERN.source, maxLength: 253 }),
  },
  { additionalProperties: false },
)

const RegisterStorageAdapterArgSchema = Type.Object(
  {
    adapterId: Type.String({ pattern: MEDIA_ID_PATTERN, maxLength: 120 }),
    label: Type.String({ minLength: 1, maxLength: 80 }),
    roles: Type.Array(MediaRoleSchema, { minItems: 1, maxItems: MEDIA_ROLE_VALUES.length }),
    servingMode: MediaServingModeSchema,
    /** Whether the plugin's adapter object exposes `getReadUrl` (for read-side dispatch). */
    hasGetReadUrl: Type.Boolean(),
    /** Whether the plugin's adapter object exposes `readStream` (proxy mode). */
    hasReadStream: Type.Boolean(),
    cspOrigins: Type.Optional(Type.Array(MediaCspOriginSchema, { maxItems: 10 })),
  },
  { additionalProperties: false },
)

const RegisterUrlTransformerArgSchema = Type.Object(
  {
    transformerId: Type.String({ minLength: 1, maxLength: 120, pattern: '^[a-zA-Z0-9_-]+$' }),
  },
  { additionalProperties: false },
)

const RegisterVariantDelegateArgSchema = Type.Object(
  {
    delegateId: Type.String({ pattern: MEDIA_ID_PATTERN, maxLength: 120 }),
    variantUrlTemplate: Type.String({ minLength: 1, maxLength: 500 }),
    widths: Type.Array(Type.Integer({ minimum: 16, maximum: 8192 }), { minItems: 1, maxItems: 16 }),
    formats: Type.Array(
      Type.Union([Type.Literal('webp'), Type.Literal('jpeg'), Type.Literal('avif')]),
      { minItems: 1, maxItems: 3 },
    ),
  },
  { additionalProperties: false },
)

// ---------------------------------------------------------------------------
// Crypto — small fixed surface (SHA-256 / SHA-1 / SHA-512 digest + HMAC sign).
//
// Inputs are base64-encoded over the wire. We cap them at 8 MB so a runaway
// plugin can't OOM the host process by sending arbitrarily large hash
// requests. Real AWS Sigv4 / OAuth signing inputs are < 4 KB; this ceiling
// is generous defense-in-depth.
// ---------------------------------------------------------------------------

const HashAlgorithmSchema = Type.Union([
  Type.Literal('SHA-256'),
  Type.Literal('SHA-1'),
  Type.Literal('SHA-512'),
])

/** Max base64 payload — 8 MB after decode. (base64 inflates by 4/3 → ~10.7 MB encoded.) */
const MAX_CRYPTO_PAYLOAD_BASE64 = 12 * 1024 * 1024

const CryptoDigestArgSchema = Type.Object(
  {
    algorithm: HashAlgorithmSchema,
    data: Type.String({ minLength: 0, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
  },
  { additionalProperties: false },
)

const CryptoSignHmacArgSchema = Type.Object(
  {
    hash: HashAlgorithmSchema,
    key: Type.String({ minLength: 0, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
    data: Type.String({ minLength: 0, maxLength: MAX_CRYPTO_PAYLOAD_BASE64 }),
  },
  { additionalProperties: false },
)


function apiCallSchema<TTarget extends AllowedApiTarget, TArgs extends TSchema>(
  target: TTarget,
  args: TArgs,
) {
  return Type.Object(
    {
      kind: Type.Literal('api-call'),
      correlationId: Type.String({ minLength: 1 }),
      pluginId: Type.String({ minLength: 1 }),
      target: Type.Literal(target),
      args,
    },
    { additionalProperties: false },
  )
}

const ApiCallSchemas = {
  'cms.routes.register': apiCallSchema('cms.routes.register', Type.Tuple([RouteRegistrationArgSchema])),
  'cms.hooks.on': apiCallSchema('cms.hooks.on', Type.Tuple([HookListenerArgSchema])),
  'cms.hooks.filter': apiCallSchema('cms.hooks.filter', Type.Tuple([HookFilterArgSchema])),
  'cms.hooks.emit': apiCallSchema('cms.hooks.emit', Type.Tuple([HookEmitArgSchema])),
  'cms.loops.registerSource': apiCallSchema('cms.loops.registerSource', Type.Tuple([LoopSourceDescriptorSchema])),
  'cms.storage.list': apiCallSchema('cms.storage.list', Type.Tuple([Type.String({ minLength: 1 })])),
  'cms.storage.create': apiCallSchema('cms.storage.create', Type.Tuple([Type.String({ minLength: 1 }), JsonRecordSchema])),
  'cms.storage.update': apiCallSchema('cms.storage.update', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
    JsonRecordSchema,
  ])),
  'cms.storage.delete': apiCallSchema('cms.storage.delete', Type.Tuple([
    Type.String({ minLength: 1 }),
    Type.String({ minLength: 1 }),
  ])),
  'cms.settings.replace': apiCallSchema('cms.settings.replace', Type.Tuple([JsonRecordSchema])),
  'network.fetch': apiCallSchema('network.fetch', Type.Tuple([
    Type.String({ minLength: 1, maxLength: 2048 }),
    NetworkFetchInitSchema,
  ])),
  // The host is intentionally permissive about `network.abort` — it does
  // NOT require `network.outbound` to be granted. A plugin without the
  // permission can never have minted a live `abortId` in the first place,
  // so the worst case is a missed lookup that no-ops (see dispatchApiCall).
  'network.abort': apiCallSchema('network.abort', Type.Tuple([NetworkAbortArgSchema])),
  'cms.schedule.register': apiCallSchema('cms.schedule.register', Type.Tuple([ScheduleRegisterArgSchema])),
  'cms.schedule.cancel': apiCallSchema('cms.schedule.cancel', Type.Tuple([ScheduleCancelArgSchema])),
  'cms.media.registerStorageAdapter': apiCallSchema(
    'cms.media.registerStorageAdapter',
    Type.Tuple([RegisterStorageAdapterArgSchema]),
  ),
  'cms.media.registerUrlTransformer': apiCallSchema(
    'cms.media.registerUrlTransformer',
    Type.Tuple([RegisterUrlTransformerArgSchema]),
  ),
  'cms.media.registerVariantDelegate': apiCallSchema(
    'cms.media.registerVariantDelegate',
    Type.Tuple([RegisterVariantDelegateArgSchema]),
  ),
  'crypto.digest': apiCallSchema('crypto.digest', Type.Tuple([CryptoDigestArgSchema])),
  'crypto.signHmac': apiCallSchema('crypto.signHmac', Type.Tuple([CryptoSignHmacArgSchema])),
} satisfies Record<AllowedApiTarget, TSchema>

export type RouteRegistrationApiCall = Static<typeof ApiCallSchemas['cms.routes.register']>
export type HookOnApiCall = Static<typeof ApiCallSchemas['cms.hooks.on']>
export type HookFilterApiCall = Static<typeof ApiCallSchemas['cms.hooks.filter']>
export type HookEmitApiCall = Static<typeof ApiCallSchemas['cms.hooks.emit']>
export type LoopSourceRegisterApiCall = Static<typeof ApiCallSchemas['cms.loops.registerSource']>
export type StorageListApiCall = Static<typeof ApiCallSchemas['cms.storage.list']>
export type StorageCreateApiCall = Static<typeof ApiCallSchemas['cms.storage.create']>
export type StorageUpdateApiCall = Static<typeof ApiCallSchemas['cms.storage.update']>
export type StorageDeleteApiCall = Static<typeof ApiCallSchemas['cms.storage.delete']>
export type SettingsReplaceApiCall = Static<typeof ApiCallSchemas['cms.settings.replace']>
export type NetworkFetchApiCall = Static<typeof ApiCallSchemas['network.fetch']>
export type NetworkAbortApiCall = Static<typeof ApiCallSchemas['network.abort']>
export type ScheduleRegisterApiCall = Static<typeof ApiCallSchemas['cms.schedule.register']>
export type ScheduleCancelApiCall = Static<typeof ApiCallSchemas['cms.schedule.cancel']>
export type RegisterStorageAdapterApiCall = Static<typeof ApiCallSchemas['cms.media.registerStorageAdapter']>
export type RegisterUrlTransformerApiCall = Static<typeof ApiCallSchemas['cms.media.registerUrlTransformer']>
export type RegisterVariantDelegateApiCall = Static<typeof ApiCallSchemas['cms.media.registerVariantDelegate']>
export type CryptoDigestApiCall = Static<typeof ApiCallSchemas['crypto.digest']>
export type CryptoSignHmacApiCall = Static<typeof ApiCallSchemas['crypto.signHmac']>

export type ValidatedApiCall =
  | RouteRegistrationApiCall
  | HookOnApiCall
  | HookFilterApiCall
  | HookEmitApiCall
  | LoopSourceRegisterApiCall
  | StorageListApiCall
  | StorageCreateApiCall
  | StorageUpdateApiCall
  | StorageDeleteApiCall
  | SettingsReplaceApiCall
  | NetworkFetchApiCall
  | NetworkAbortApiCall
  | ScheduleRegisterApiCall
  | ScheduleCancelApiCall
  | RegisterStorageAdapterApiCall
  | RegisterUrlTransformerApiCall
  | RegisterVariantDelegateApiCall
  | CryptoDigestApiCall
  | CryptoSignHmacApiCall

export class ApiCallValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiCallValidationError'
  }
}

function firstSchemaError(schema: TSchema, value: unknown): string {
  const [error] = [...Value.Errors(schema, value)]
  if (!error) return 'unknown validation error'
  const path = error.path || '/'
  return `${path}: ${error.message}`
}

function normalizeRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

function validateApiCallSemantics(call: ValidatedApiCall): void {
  if (call.target !== 'cms.routes.register') return

  const [route] = call.args
  const normalizedPath = normalizeRoutePath(route.path)
  if (route.path !== normalizedPath) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: path must be normalized as "${normalizedPath}"`,
    )
  }

  const expectedRouteKey = `${route.method}:${normalizedPath}`
  if (route.routeKey !== expectedRouteKey) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: routeKey must be "${expectedRouteKey}"`,
    )
  }
}

function decodeApiCall(target: AllowedApiTarget, value: unknown): ValidatedApiCall {
  switch (target) {
    case 'cms.routes.register':
      return Value.Decode(ApiCallSchemas['cms.routes.register'], value)
    case 'cms.hooks.on':
      return Value.Decode(ApiCallSchemas['cms.hooks.on'], value)
    case 'cms.hooks.filter':
      return Value.Decode(ApiCallSchemas['cms.hooks.filter'], value)
    case 'cms.hooks.emit':
      return Value.Decode(ApiCallSchemas['cms.hooks.emit'], value)
    case 'cms.loops.registerSource':
      return Value.Decode(ApiCallSchemas['cms.loops.registerSource'], value)
    case 'cms.storage.list':
      return Value.Decode(ApiCallSchemas['cms.storage.list'], value)
    case 'cms.storage.create':
      return Value.Decode(ApiCallSchemas['cms.storage.create'], value)
    case 'cms.storage.update':
      return Value.Decode(ApiCallSchemas['cms.storage.update'], value)
    case 'cms.storage.delete':
      return Value.Decode(ApiCallSchemas['cms.storage.delete'], value)
    case 'cms.settings.replace':
      return Value.Decode(ApiCallSchemas['cms.settings.replace'], value)
    case 'network.fetch':
      return Value.Decode(ApiCallSchemas['network.fetch'], value)
    case 'network.abort':
      return Value.Decode(ApiCallSchemas['network.abort'], value)
    case 'cms.schedule.register':
      return Value.Decode(ApiCallSchemas['cms.schedule.register'], value)
    case 'cms.schedule.cancel':
      return Value.Decode(ApiCallSchemas['cms.schedule.cancel'], value)
    case 'cms.media.registerStorageAdapter':
      return Value.Decode(ApiCallSchemas['cms.media.registerStorageAdapter'], value)
    case 'cms.media.registerUrlTransformer':
      return Value.Decode(ApiCallSchemas['cms.media.registerUrlTransformer'], value)
    case 'cms.media.registerVariantDelegate':
      return Value.Decode(ApiCallSchemas['cms.media.registerVariantDelegate'], value)
    case 'crypto.digest':
      return Value.Decode(ApiCallSchemas['crypto.digest'], value)
    case 'crypto.signHmac':
      return Value.Decode(ApiCallSchemas['crypto.signHmac'], value)
  }
}

export function parseApiCall(value: unknown): ValidatedApiCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiCallValidationError('Invalid api-call payload: expected object')
  }

  const target = (value as { target?: unknown }).target
  if (typeof target !== 'string' || !isAllowedApiTarget(target)) {
    throw new ApiCallValidationError('Invalid api-call payload: unknown target')
  }

  const schema = ApiCallSchemas[target]
  if (!Value.Check(schema, value)) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for ${target}: ${firstSchemaError(schema, value)}`,
    )
  }

  const parsed = decodeApiCall(target, value)
  validateApiCallSemantics(parsed)
  return parsed
}

