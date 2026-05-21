import { Type, type Static } from '@core/utils/typeboxHelpers'

// ---------------------------------------------------------------------------
// Admin pages — registered by the manifest, rendered inside the admin shell
// ---------------------------------------------------------------------------

export interface PluginPin {
  label: string
  detail?: string
  x: number
  y: number
}

export type PluginPageContent =
  | {
    kind: 'markdown'
    heading?: string
    body: string
  }
  | {
    kind: 'map'
    heading: string
    body?: string
    centerLabel?: string
    pins: PluginPin[]
  }
  | {
    kind: 'resource'
    heading: string
    resource: string
  }
  | {
    kind: 'app'
    heading: string
    entry: string
    assetPath?: string
  }

export interface PluginAdminPage {
  id: string
  title: string
  navLabel?: string
  icon?: string
  /**
   * Optional admin route override. The host derives the final route from
   * the plugin id + page id at install time (`/admin/plugins/:pluginId/:pageId`),
   * so plugin authors never need to set it. Kept on the type for forward
   * compatibility (e.g. nested plugin pages).
   */
  route?: string
  content: PluginPageContent
}

// ---------------------------------------------------------------------------
// Page summary — returned by api.cms.pages.list()
// ---------------------------------------------------------------------------

export const PluginPageSummarySchema = Type.Object({
  id: Type.String({ description: 'Page row id (data_rows.id, a nanoid)' }),
  slug: Type.String({ description: 'URL slug' }),
  title: Type.String({ description: 'Page title' }),
  lastPublishedAt: Type.String({ description: 'ISO 8601 timestamp of when this snapshot was created' }),
})

export type PluginPageSummary = Static<typeof PluginPageSummarySchema>
