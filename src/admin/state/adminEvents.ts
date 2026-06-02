/**
 * Admin-wide DOM custom events.
 *
 * Kept in a dedicated module so importers don't transitively pull in the
 * heavy modules that *dispatch* / *listen* to these events. In particular,
 * the editor's `usePersistence` hook (~6 KB chunk, drags the full editor
 * store) used to own `CMS_SITE_RELOAD_EVENT` — any plugin-side code that
 * just wanted to dispatch the event would import usePersistence and end
 * up bundling the editor store into the non-editor admin graph.
 *
 * Adding new admin-wide event constants? Put them here, then have both
 * dispatchers and listeners import from this module.
 */

/**
 * Fired on `window` after the editor reloads the site document (manual
 * save → reload, plugin install → reload). Subscribers re-fetch any
 * site-derived data they cache (admin shell site name + favicon,
 * Plugins page list, etc.).
 */
export const CMS_SITE_RELOAD_EVENT = 'cms-site-reload'

/**
 * Fired after a CMS-exported SiteBundle has been imported successfully through
 * the global Site Import modal. Data/content views that cache table or row
 * lists should refresh when they are mounted.
 */
export const CMS_SITE_BUNDLE_IMPORTED_EVENT = 'cms-site-bundle-imported'
