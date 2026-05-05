export * from './types'
export * from './capabilities'
export * from './guards'

// ---------------------------------------------------------------------------
// Loop entity sources (Phase 8) — plugins extend `base.loop` with custom data
// backends. Re-exporting the registry singleton + types so plugin code only
// imports from `@core/plugin-sdk`, never from internal modules.
// ---------------------------------------------------------------------------
export type {
  LoopEntitySource,
  LoopItem,
  LoopSourceField,
  LoopFetchResult,
  SourceFetchContext,
  SourcePreviewContext,
  LoopSourceDb,
} from '../loops/types'
export { loopSourceRegistry as loopSources } from '../loops/registry'
