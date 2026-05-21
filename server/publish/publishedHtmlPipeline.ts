/**
 * Single post-renderer pipeline applied to every HTML-emitting public path.
 *
 * Pages, post templates, and the fallback standalone data-row document
 * all feed their rendered output into this function. Adding a new
 * HTML-emitting code path means wiring it here, not duplicating injection
 * or hook-bus logic.
 *
 * Stages (in order, single-pass):
 *
 *   1. `publish.before` event — gives plugins a chance to set up per-page
 *      state (SEO Suite records the current pageId for its filter, etc.).
 *   2. `injectFrontendAssets` — splices declarative `frontend.assets[]`
 *      tags from every enabled plugin at four placement anchors and
 *      rewrites the page CSP based on what's in the plan. Pure host
 *      substrate: no host-shipped tag content.
 *   3. `publish.html` filter — the escape hatch for non-tag mutations
 *      (link rewriting, redaction, JSON-LD enrichment). Plugins
 *      transform the document by string ops here.
 *   4. `publish.after` event — companion to `publish.before` so plugins
 *      can tear down their per-render bookkeeping.
 *
 * Architecture test `dispatcher-html-pipeline.test.ts` pins the contract:
 * every public-route handler that returns `content-type: text/html`
 * sources its body from this function (or is the admin-app shell, which
 * is gated separately).
 */

import type { DbClient } from '../db/client'
import { hookBus } from '@core/plugins/hookBus'
import {
  collectFrontendInjections,
  injectFrontendAssets,
} from './frontendInjections'
import type { RendererOutput } from './publicRenderer'

export async function applyPublishedHtmlPipeline(
  rendered: RendererOutput,
  db: DbClient,
): Promise<string> {
  await hookBus.emit('publish.before', {
    siteId: rendered.siteId,
    pageId: rendered.pageId,
  })
  const injections = await collectFrontendInjections(db)
  const withInjections = injectFrontendAssets(rendered.html, injections)
  const filtered = await hookBus.applyFilter('publish.html', withInjections, {
    siteId: rendered.siteId,
    pageId: rendered.pageId,
    slug: rendered.slug,
  })
  await hookBus.emit('publish.after', {
    siteId: rendered.siteId,
    pageId: rendered.pageId,
  })
  return filtered
}
