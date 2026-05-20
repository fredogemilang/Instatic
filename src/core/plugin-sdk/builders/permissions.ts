/**
 * Typed permission constants — gives plugin authors autocomplete instead of
 * having to remember the exact string literal.
 *
 *   import { permissions } from '@pagebuilder/plugin-sdk'
 *   permissions: [permissions.modulesRegister, permissions.cmsHooks]
 *
 * Keys are camelCased; values are the canonical permission identifiers used
 * throughout the host runtime. Adding a new permission here means it's
 * autocomplete-discoverable in IDEs.
 */
import type { PluginPermission } from '../types'

export const permissions = {
  adminNavigation: 'admin.navigation',
  cmsStorage: 'cms.storage',
  cmsRoutes: 'cms.routes',
  cmsHooks: 'cms.hooks',
  editorToolbar: 'editor.toolbar',
  editorCommands: 'editor.commands',
  editorStoreRead: 'editor.store.read',
  editorStoreWrite: 'editor.store.write',
  editorCanvas: 'editor.canvas',
  editorPanels: 'editor.panels',
  modulesRegister: 'modules.register',
  loopsRegister: 'loops.register',
  visualComponentsRegister: 'visualComponents.register',
  frontendScripts: 'frontend.scripts',
  frontendTracker: 'frontend.tracker',
  networkOutbound: 'network.outbound',
  cmsSchedule: 'cms.schedule',
  mediaStorageAdapter: 'media.storage.adapter',
  mediaUrlTransform: 'media.url.transform',
  mediaVariantDelegate: 'media.variant.delegate',
  unstableInternals: 'unstable.internals',
} as const satisfies Record<string, PluginPermission>

export type PermissionAlias = keyof typeof permissions
