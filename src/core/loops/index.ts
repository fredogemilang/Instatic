/**
 * Loops — public surface.
 *
 * Re-exports the source types and the singleton registry. Built-in
 * sources live under `./sources/` and are not eagerly imported here so
 * the registry can be empty in test contexts that don't need them.
 */

export type {
  LoopEntitySource,
  LoopItem,
  LoopSourceField,
  LoopFetchResult,
  SourceFetchContext,
  SourcePreviewContext,
  ILoopSourceRegistry,
} from './types'
export { loopSourceRegistry } from './registry'
