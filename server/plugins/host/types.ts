/**
 * Per-plugin host-side bookkeeping types. These are the runtime records the
 * main process maintains for each active plugin — distinct from the SDK types
 * (plugin manifests, SDK API shapes) which live in src/core/plugin-sdk/.
 */

import type { CoreCapability } from '../../auth/capabilities'
import type { PluginManifest } from '@core/plugin-sdk'

export interface HostRouteEntry {
  pluginId: string
  method: string
  path: string
  capability: CoreCapability | null
  routeKey: string
}

export interface HostHookListenerEntry {
  pluginId: string
  listenerId: string
}

export interface HostHookFilterEntry {
  pluginId: string
  filterId: string
}

export interface HostLoopSourceEntry {
  pluginId: string
  sourceId: string
}

export interface HostMediaAdapterEntry {
  pluginId: string
  adapterId: string
}

export interface HostMediaTransformerEntry {
  pluginId: string
  transformerId: string
}

export interface HostPluginRecord {
  manifest: PluginManifest
  routes: Map<string, HostRouteEntry>
  hookListeners: HostHookListenerEntry[]
  hookFilters: HostHookFilterEntry[]
  loopSources: HostLoopSourceEntry[]
  /** Media storage adapter ids registered by this plugin. */
  mediaAdapters: HostMediaAdapterEntry[]
  /** Media URL transformer registrations — actually live as hookBus filters. */
  mediaUrlTransformers: HostMediaTransformerEntry[]
  /**
   * In-flight outbound fetches keyed by the plugin's `abortId`. Populated
   * by `performGatedFetch` (which registers a fresh AbortController before
   * issuing the upstream `fetch`) and dropped in its `finally` block.
   * `network.abort` dispatch looks up the controller here and aborts it,
   * tearing down the underlying socket / response stream instead of
   * waiting for natural completion.
   */
  inflightFetches: Map<string, AbortController>
}

export interface PendingRequest {
  pluginId: string
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

/**
 * Outcome the runtime layer should take after a worker crash. Returned by
 * `recordCrashAndDecide` so the runtime can both persist the event and
 * branch on whether to respawn or park in error state.
 */
export type CrashRecoveryDecision =
  | { kind: 'respawn'; recentCrashCount: number }
  | { kind: 'give-up'; recentCrashCount: number }

/**
 * Callback the runtime registers so the worker host can ask it to re-load +
 * re-activate a plugin after an auto-respawn (or a manual restart). The
 * runtime owns the on-disk asset path resolution and lifecycle ordering;
 * the host just signals when to re-bind.
 */
export type CrashRecoveryHandler = (args: {
  pluginId: string
  reason: string
  decision: CrashRecoveryDecision
}) => Promise<void>
