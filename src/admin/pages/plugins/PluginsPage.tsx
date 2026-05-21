import { Button } from '@ui/components/Button'
import { UploadIcon } from 'pixel-art-icons/icons/upload'
import { AdminPageLayout } from '@admin/layouts/AdminPageLayout'
import { PluginCard } from './components/PluginCard/PluginCard'
import { PluginRemoveDialog } from './components/PluginRemoveDialog/PluginRemoveDialog'
import { PermissionReviewSection } from './components/PermissionReviewSection'
import { PluginSettingsDialog } from './components/PluginSettingsDialog/PluginSettingsDialog'
import { PluginSchedulesDialog } from './components/PluginSchedulesDialog/PluginSchedulesDialog'
import { isSandboxRelatedError, usePluginsWorkspace } from './hooks/usePluginsWorkspace'
import { notifyCmsPluginsChanged } from './utils/pluginEvents'
import styles from './PluginsPage.module.css'

export function PluginsPage() {
  const vm = usePluginsWorkspace()
  const {
    fileInputRef,
    payload,
    loading,
    uploading,
    busyPluginId,
    error,
    editorActivationErrors,
    pendingInstall,
    settingsPluginId,
    schedulesPluginId,
    pendingRemove,
  } = vm

  return (
    <AdminPageLayout
      workspace="plugins"
      title="Plugins"
      titleId="plugins-title"
      description="Install admin extensions and control what they add to the CMS."
      actions={(
        <>
          <Button
            variant="primary"
            size="md"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon size={15} aria-hidden="true" />
            <span>{uploading ? 'Uploading' : 'Upload Plugin'}</span>
          </Button>
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            aria-label="Plugin file"
            type="file"
            accept="application/json,.json,.plugin.json,.pbplugin,.zip,application/zip"
            onChange={(event) => void vm.handleUpload(event)}
          />
        </>
      )}
    >
      <div className={styles.pluginsBody} data-testid="plugins-admin-canvas">
        {error && (
          <div role="alert">
            <p className={styles.error}>{error}</p>
            {isSandboxRelatedError(error) && (
              <p className={styles.errorHint}>
                This looks like a plugin sandbox issue. See the{' '}
                <a
                  href="https://github.com/davidbabinec/page-builder/blob/main/docs/plugins/sandbox.md"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  sandbox documentation
                </a>
                {' '}for what's allowed inside plugin code.
              </p>
            )}
          </div>
        )}

        {pendingInstall && (
          <PermissionReviewSection
            pending={pendingInstall}
            uploading={uploading}
            onCancel={() => vm.setPendingInstall(null)}
            onConfirm={() => void vm.installPendingPlugin(pendingInstall)}
          />
        )}

        <div className={styles.pluginsList} aria-label="Installed plugins">
          {loading ? (
            <p className={styles.emptyState}>Loading plugins...</p>
          ) : payload.plugins.length === 0 ? (
            <p className={styles.emptyState}>No plugins installed yet.</p>
          ) : (
            payload.plugins.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                busy={busyPluginId === plugin.id}
                editorActivationError={editorActivationErrors[plugin.id]}
                onOpenSettings={(p) => vm.setSettingsPluginId(p.id)}
                onOpenSchedules={(p) => vm.setSchedulesPluginId(p.id)}
                onInstallPack={(p) => void vm.installPluginPack(p)}
                onRestart={(p) => void vm.restartPlugin(p)}
                onReinstall={() => fileInputRef.current?.click()}
                onToggle={(p) => void vm.togglePlugin(p)}
                onRemove={(p) => vm.setPendingRemove(p)}
              />
            ))
          )}
        </div>

        {settingsPluginId && (
          <PluginSettingsDialog
            pluginId={settingsPluginId}
            pluginName={
              payload.plugins.find((p) => p.id === settingsPluginId)?.name ??
              settingsPluginId
            }
            onClose={() => vm.setSettingsPluginId(null)}
            onSaved={() => {
              notifyCmsPluginsChanged()
              void vm.loadPlugins()
            }}
          />
        )}

        {schedulesPluginId && (
          <PluginSchedulesDialog
            pluginId={schedulesPluginId}
            pluginName={
              payload.plugins.find((p) => p.id === schedulesPluginId)?.name ??
              schedulesPluginId
            }
            onClose={() => vm.setSchedulesPluginId(null)}
          />
        )}

        {pendingRemove && (
          <PluginRemoveDialog
            plugin={pendingRemove}
            busy={busyPluginId === pendingRemove.id}
            onClose={() => vm.setPendingRemove(null)}
            onConfirm={async () => {
              const target = pendingRemove
              vm.setPendingRemove(null)
              await vm.executeRemovePlugin(target)
            }}
          />
        )}
      </div>
    </AdminPageLayout>
  )
}
