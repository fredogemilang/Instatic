// Public API for the publisher engine.
//
// The publisher turns page trees into clean, static HTML + CSS at publish time
// (and renders dynamic fragments / previews at request time). External consumers
// import from `@core/publisher`; files inside this module import each other via
// relative paths and never through this barrel.

export { publishPage } from './render'
export type { PublishedRuntimePackageImportmap } from './render'

export { renderNode } from './renderNode'

export type {
  RenderContext,
  RenderResolvedMedia,
  ResolvedLoopRenderData,
} from './renderContext'

export { escapeProps } from './escapeProps'

export { escapeHtml, isSafeUrl, safeUrl, sanitiseCssValue } from './utils'

export {
  bagToCSS,
  compareViewportContextCascade,
  conditionPrelude,
  generateClassCSS,
  isEmittableProperty,
} from './classCss'
export type { ViewportContext } from './classCss'

export { collectClassCSS, CssCollector, sanitizeModuleCSS } from './cssCollector'

export { buildSiteFrameworkCss, generateFrameworkCss } from './frameworkCss'

export { collectUserStylesheetCss } from './userStylesheets'

export { PUBLISHER_RESET_CSS } from './reset'

export { resolveAutoSizes } from './sizesResolver'

export type { CssBundleFile, SiteCssBundle, SiteCssBundleId } from './siteCssBundle'
