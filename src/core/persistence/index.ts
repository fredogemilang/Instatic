export { cmsAdapter } from './cms'
export { getCmsPublishStatus, publishCmsDraft } from './cmsPublish'
export { listCmsMediaAssets } from './cmsMedia'
export type { CmsMediaAsset } from './cmsMedia'
export {
  createCmsContentCollection,
  createCmsContentEntry,
  deleteCmsContentCollection,
  deleteCmsContentEntry,
  listCmsContentAuthors,
  listCmsContentCollections,
  listCmsContentEntries,
  publishCmsContentEntry,
  saveCmsContentEntryDraft,
  updateCmsContentEntryAuthor,
  updateCmsContentCollection,
  updateCmsContentEntryCollection,
  updateCmsContentEntryStatus,
} from './cmsContent'
export {
  inspectCmsPluginPackage,
  installCmsPluginPackage,
  installCmsPluginManifest,
  listCmsPlugins,
  removeCmsPlugin,
  setCmsPluginEnabled,
} from './cmsPlugins'
export {
  createCmsPluginResourceRecord,
  deleteCmsPluginResourceRecord,
  loadCmsPluginResource,
} from './cmsPluginRecords'
export {
  createCmsRole,
  createCmsUser,
  deleteCmsRole,
  deleteCmsUser,
  listCmsAuditEvents,
  listCmsRoles,
  listCmsUsers,
  updateCmsRole,
  updateCmsUser,
} from './cmsUsers'
export type { CmsAuditEvent, CmsRole } from './cmsUsers'
export { getCmsSetupStatus, getCurrentCmsUser, loginCms, setupCms } from './cmsAuth'
export type { CmsCurrentUser } from './cmsAuth'
// usePersistence moved to src/editor/hooks/usePersistence.ts (Constraint #179 — no React in core)
