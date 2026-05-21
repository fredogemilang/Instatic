/**
 * SiteDocument lifecycle actions: createSite, loadSite, clearSite, updateSiteName.
 */

import { renderCache } from '@site/canvas/renderCache'
import {
  clonePackageJson,
  DEFAULT_SITE_PACKAGE_JSON,
} from '@core/site-dependencies/manifest'
import {
  cloneSiteRuntimeConfig,
  DEFAULT_SITE_RUNTIME,
} from '@core/site-runtime'
import { clearCanvasSelectionDraft } from '../selectionSlice'
import { createDefaultSiteDocument } from './defaults'
import { reconcileFrameworkClasses } from './framework/reconcile'
import type { SiteSlice, SiteSliceHelpers } from './types'

export type LifecycleActions = Pick<
  SiteSlice,
  'createSite' | 'loadSite' | 'clearSite' | 'updateSiteName'
>

export function createLifecycleActions({
  set,
  mutateSite,
}: SiteSliceHelpers): LifecycleActions {
  return {
    createSite: (name) => {
      const site = createDefaultSiteDocument(name)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      set((state) => {
        state.site = { ...site, runtime: siteRuntime }
        state.packageJson = clonePackageJson(site.packageJson)
        state.siteRuntime = siteRuntime
        state.activePageId = site.pages[0].id
        // Reset activeDocument — any previously-open VC reference belongs to
        // the prior site and would cause `mutateActiveTree` to silently no-op
        // (early-return) when the VC id is not present in the new site.
        state.activeDocument = null
        state._historyPast = []
        state._historyFuture = []
        state.canUndo = false
        state.canRedo = false
        state.hasUnsavedChanges = false
      })
      return site
    },

    loadSite: (site) => {
      // Clear the render cache BEFORE store hydration so stale HTML from a previous
      // site cannot bleed into the canvas after switching projects.
      // (Guideline #307 / Architect message #1216 — critical integration note)
      renderCache.clear()
      reconcileFrameworkClasses(site)
      const packageJson = clonePackageJson(site.packageJson)
      const siteRuntime = cloneSiteRuntimeConfig(site.runtime)
      set((state) => {
        state.site = { ...site, packageJson, runtime: siteRuntime }
        state.packageJson = packageJson
        state.siteRuntime = siteRuntime
        state.activePageId = site.pages[0]?.id ?? null
        // Reset activeDocument — see createSite for rationale.
        state.activeDocument = null
        state._historyPast = []
        state._historyFuture = []
        state.canUndo = false
        state.canRedo = false
        state.hasUnsavedChanges = false
      })
    },

    clearSite: () => {
      set((state) => {
        state.site = null
        state.packageJson = clonePackageJson(DEFAULT_SITE_PACKAGE_JSON)
        state.siteRuntime = cloneSiteRuntimeConfig(DEFAULT_SITE_RUNTIME)
        state.activePageId = null
        // Reset activeDocument — without a site there can be no active doc.
        state.activeDocument = null
        clearCanvasSelectionDraft(state)
        state._historyPast = []
        state._historyFuture = []
        state.canUndo = false
        state.canRedo = false
      })
    },

    updateSiteName: (name) => {
      mutateSite((p) => {
        if (p.name === name) return false
        p.name = name
        return true
      })
    },
  }
}
