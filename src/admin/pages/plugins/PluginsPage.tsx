import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ChangeEvent } from "react";
import { Link } from "@admin/lib/routing";
import { Button } from "@ui/components/Button";
import { PowerIcon } from "pixel-art-icons/icons/power";
import { PowerOffIcon } from "pixel-art-icons/icons/power-off";
import { DeleteIcon } from "pixel-art-icons/icons/delete";
import { UploadIcon } from "pixel-art-icons/icons/upload";
import {
  getEditorActivationErrors,
  subscribeEditorActivationErrors,
} from "./hooks/editorPluginActivationErrors";
import { subscribePluginEvents } from "./utils/pluginEventStream";
import type {
  CmsPluginsPayload,
  InstalledPlugin,
  PluginManifest,
} from "@core/plugin-sdk";
import {
  collectEnabledAdminPages,
  parsePluginManifest,
  permissionLabel,
} from "@core/plugins/manifest";
import { permissionDescription, safeUrl } from "@core/plugin-sdk";
import { PluginRemoveDialog } from "./components/PluginRemoveDialog/PluginRemoveDialog";
import {
  inspectCmsPluginPackage,
  installCmsPluginPackage,
  installCmsPluginManifest,
  installCmsPluginPack,
  listCmsPlugins,
  removeCmsPlugin,
  restartCmsPlugin,
  setCmsPluginEnabled,
} from "@core/persistence";
import { ReloadIcon } from "pixel-art-icons/icons/reload";
import { AdminPageLayout } from "@admin/layouts";
import { notifyCmsPluginsChanged } from "./utils/pluginEvents";
import { CMS_SITE_RELOAD_EVENT } from "@site/hooks/usePersistence";
import { PluginSettingsDialog } from "./components/PluginSettingsDialog/PluginSettingsDialog";
import styles from "./PluginsPage.module.css";

function notifyCmsSiteReload(): void {
  window.dispatchEvent(new Event(CMS_SITE_RELOAD_EVENT));
}

const emptyPayload: CmsPluginsPayload = { plugins: [], adminPages: [] };

interface PendingInstall {
  manifest: PluginManifest;
  file?: File;
  /**
   * If set, this upload upgrades an already-installed plugin from the given
   * version to `manifest.version`. The dialog renders upgrade-aware copy
   * ("Update X from 1.0.0 to 1.1.0") and the confirm button reflects the
   * verb. The host detects upgrades server-side independently — this flag
   * exists purely so the UI can show the delta before the user clicks
   * confirm.
   */
  upgradeFromVersion?: string;
}

function updatePlugin(
  payload: CmsPluginsPayload,
  plugin: InstalledPlugin,
): CmsPluginsPayload {
  const existing = payload.plugins.findIndex(
    (candidate) => candidate.id === plugin.id,
  );
  const plugins =
    existing === -1
      ? [plugin, ...payload.plugins]
      : payload.plugins.map((candidate) =>
          candidate.id === plugin.id ? plugin : candidate,
        );
  const adminPages = collectEnabledAdminPages(plugins);
  return { plugins, adminPages };
}

function pluginStatus(plugin: InstalledPlugin): {
  label: string;
  status: string;
} {
  const status =
    plugin.lifecycleStatus ?? (plugin.enabled ? "active" : "disabled");
  if (status === "error") return { label: "Error", status };
  if (status === "installed") return { label: "Installed", status };
  if (status === "disabled" || !plugin.enabled)
    return { label: "Disabled", status: "disabled" };
  return { label: "Active", status: "active" };
}

export function PluginsPage() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [payload, setPayload] = useState<CmsPluginsPayload>(emptyPayload);
  const [loading, setLoading] = useState(true);
  const [busyPluginId, setBusyPluginId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<PendingInstall | null>(
    null,
  );
  const [settingsPluginId, setSettingsPluginId] = useState<string | null>(null);
  const [pendingRemove, setPendingRemove] = useState<InstalledPlugin | null>(null);

  // Editor-side activation failures (per pluginId → error message). Populated
  // by `useInstalledEditorPlugins` after each refresh; surfaced on the plugin
  // card alongside the server-side `lastError`.
  const editorActivationErrors = useSyncExternalStore(
    subscribeEditorActivationErrors,
    getEditorActivationErrors,
    getEditorActivationErrors,
  );

  async function loadPlugins() {
    setLoading(true);
    setError(null);
    try {
      setPayload(await listCmsPlugins());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load plugins");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadPlugins();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // Live refresh — when ANY plugin event arrives (crash, recovered, parked,
  // restarted, installed, updated, uninstalled, enabled, disabled), re-fetch
  // the list so the user sees the latest state without leaving the page. The
  // EventSource is shared across consumers (PluginsNavBadge, toast bridge)
  // so we don't open one socket per subscriber.
  useEffect(() => {
    const unsubscribe = subscribePluginEvents(() => {
      void loadPlugins();
    });
    return unsubscribe;
  }, []);

  async function handleUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setUploading(true);
    setError(null);
    try {
      const manifest = file.name.toLowerCase().endsWith(".zip")
        ? await inspectCmsPluginPackage(file)
        : parsePluginManifest(JSON.parse(await file.text()));

      // Detect upgrade vs. fresh install client-side so we can render the
      // right copy in the confirmation dialog. The server detects upgrades
      // independently — this is purely a UX hint (and a way to force the
      // dialog to show even when no new permissions are being requested).
      const existing = payload.plugins.find((p) => p.id === manifest.id);
      const upgradeFromVersion =
        existing && existing.version !== manifest.version
          ? existing.version
          : undefined;

      // Always show the dialog for upgrades, even with zero new permissions.
      // The site owner deserves to see a "yes, upgrade 1.0.0 → 1.1.0"
      // confirmation before we replace a working plugin.
      if (manifest.permissions.length > 0 || upgradeFromVersion) {
        setPendingInstall({
          manifest,
          file: file.name.toLowerCase().endsWith(".zip") ? file : undefined,
          upgradeFromVersion,
        });
      } else {
        await installPendingPlugin(
          {
            manifest,
            file: file.name.toLowerCase().endsWith(".zip") ? file : undefined,
          },
          [],
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install plugin");
    } finally {
      setUploading(false);
    }
  }

  async function installPendingPlugin(
    pending: PendingInstall,
    grantedPermissions = pending.manifest.permissions,
  ) {
    setUploading(true);
    setError(null);
    try {
      const result = pending.file
        ? await installCmsPluginPackage(pending.file, grantedPermissions)
        : await installCmsPluginManifest(pending.manifest, grantedPermissions);
      if (result.plugins.length > 0) {
        setPayload({ plugins: result.plugins, adminPages: result.adminPages });
      } else if (result.plugin) {
        setPayload((current) =>
          updatePlugin(current, result.plugin as InstalledPlugin),
        );
      } else {
        await loadPlugins();
      }
      notifyCmsPluginsChanged();
      // Auto-install path on the server may have also imported the bundled
      // pack — refresh the editor's site state so any newly imported VCs /
      // pages / classes appear immediately.
      if (
        pending.manifest.pack &&
        grantedPermissions.includes("visualComponents.register")
      ) {
        notifyCmsSiteReload();
      }
      setPendingInstall(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install plugin");
    } finally {
      setUploading(false);
    }
  }

  async function togglePlugin(plugin: InstalledPlugin) {
    setBusyPluginId(plugin.id);
    setError(null);
    try {
      const result = await setCmsPluginEnabled(plugin.id, !plugin.enabled);
      if (result.plugins.length > 0) {
        setPayload({ plugins: result.plugins, adminPages: result.adminPages });
      } else if (result.plugin) {
        setPayload((current) =>
          updatePlugin(current, result.plugin as InstalledPlugin),
        );
      }
      notifyCmsPluginsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update plugin");
    } finally {
      setBusyPluginId(null);
    }
  }

  /**
   * Manually restart a plugin parked in `error` state. Resets the host's
   * crash budget for this plugin, clears its historical crash events, then
   * re-loads + re-activates. Used from the "Restart" button on the plugin
   * card.
   */
  async function restartPlugin(plugin: InstalledPlugin) {
    setBusyPluginId(plugin.id);
    setError(null);
    try {
      const result = await restartCmsPlugin(plugin.id);
      if (result.plugins.length > 0) {
        setPayload({ plugins: result.plugins, adminPages: result.adminPages });
      } else if (result.plugin) {
        setPayload((current) =>
          updatePlugin(current, result.plugin as InstalledPlugin),
        );
      }
      notifyCmsPluginsChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restart plugin");
    } finally {
      setBusyPluginId(null);
    }
  }

  async function installPluginPack(plugin: InstalledPlugin) {
    setBusyPluginId(plugin.id);
    setError(null);
    try {
      const summary = await installCmsPluginPack(plugin.id);
      const installedCount =
        summary.installed.visualComponents.length +
        summary.installed.pages.length +
        summary.installed.classes.length;
      const replacedCount =
        summary.replaced.visualComponents.length +
        summary.replaced.pages.length +
        summary.replaced.classes.length;
      setError(
        `Installed pack from ${plugin.name}: ${installedCount} item(s), ${replacedCount} replaced.`,
      );
      notifyCmsPluginsChanged();
      // The pack writes Visual Components, pages, and classes directly to the
      // draft site at the DB level. Tell the editor's persistence layer to
      // re-pull so the new content shows up in the Site Explorer / canvas
      // without a full browser reload.
      notifyCmsSiteReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install plugin pack");
    } finally {
      setBusyPluginId(null);
    }
  }

  async function executeRemovePlugin(plugin: InstalledPlugin) {
    setBusyPluginId(plugin.id);
    setError(null);
    try {
      await removeCmsPlugin(plugin.id);
      setPayload((current) => ({
        plugins: current.plugins.filter(
          (candidate) => candidate.id !== plugin.id,
        ),
        adminPages: current.adminPages.filter(
          (page) => page.pluginId !== plugin.id,
        ),
      }));
      notifyCmsPluginsChanged();
    } catch (err) {
      // The host's DELETE handler runs the plugin's `uninstall` lifecycle
      // hook, removes runtime registrations, drops the DB row, and deletes
      // the on-disk asset folder. If that flow returns an error we'd land
      // in a confusing state where the plugin row may have been deleted
      // server-side but the UI still shows it. Re-fetch the canonical list
      // so the card reflects reality regardless of the failure mode.
      setError(err instanceof Error ? err.message : "Could not remove plugin");
      await loadPlugins();
    } finally {
      setBusyPluginId(null);
    }
  }

  const toolbarRightSlot = (
    <Button
      variant="primary"
      size="sm"
      disabled={uploading}
      onClick={() => fileInputRef.current?.click()}
    >
      <UploadIcon size={14} aria-hidden="true" />
      <span>{uploading ? "Uploading" : "Upload Plugin"}</span>
    </Button>
  );

  return (
    <AdminPageLayout
      workspace="plugins"
      title="Plugins"
      titleId="plugins-title"
      description="Install admin extensions and control what they add to the CMS."
      toolbarRightSlot={toolbarRightSlot}
      actions={(
        <>
          <Button
            variant="primary"
            size="md"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            <UploadIcon size={15} aria-hidden="true" />
            <span>{uploading ? "Uploading" : "Upload Plugin"}</span>
          </Button>
          <input
            ref={fileInputRef}
            className={styles.fileInput}
            aria-label="Plugin file"
            type="file"
            accept="application/json,.json,.plugin.json,.pbplugin,.zip,application/zip"
            onChange={(event) => void handleUpload(event)}
          />
        </>
      )}
    >
      <div className={styles.pluginsBody} data-testid="plugins-admin-canvas">
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}

            {pendingInstall && (
              <section
                className={styles.permissionReview}
                aria-labelledby="plugin-permissions-title"
              >
                <div>
                  <h2 id="plugin-permissions-title">
                    {pendingInstall.upgradeFromVersion
                      ? `Update ${pendingInstall.manifest.name}`
                      : "Approve Plugin Permissions"}
                  </h2>
                  <p>
                    {pendingInstall.upgradeFromVersion
                      ? `Updating from ${pendingInstall.upgradeFromVersion} to ${pendingInstall.manifest.version}. Existing settings and stored data are preserved; the plugin runs its migrate hook before re-activating.`
                      : `${pendingInstall.manifest.name} requests access before activation.`}
                  </p>
                </div>
                {pendingInstall.manifest.permissions.length > 0 && (
                  <ul>
                    {pendingInstall.manifest.permissions.map((permission) => (
                      <li key={permission}>
                        <strong>{permissionLabel(permission)}</strong>
                        <span>{permissionDescription(permission)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className={styles.permissionActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPendingInstall(null)}
                  >
                    <span>Cancel</span>
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={uploading}
                    onClick={() => void installPendingPlugin(pendingInstall)}
                  >
                    <span>
                      {uploading
                        ? pendingInstall.upgradeFromVersion
                          ? "Updating"
                          : "Installing"
                        : pendingInstall.upgradeFromVersion
                          ? `Update to ${pendingInstall.manifest.version}`
                          : "Approve and Install"}
                    </span>
                  </Button>
                </div>
              </section>
            )}

            <div className={styles.pluginsList} aria-label="Installed plugins">
              {loading ? (
                <p className={styles.emptyState}>Loading plugins...</p>
              ) : payload.plugins.length === 0 ? (
                <p className={styles.emptyState}>No plugins installed yet.</p>
              ) : (
                payload.plugins.map((plugin) => {
                  const status = pluginStatus(plugin);
                  const iconSrc =
                    plugin.manifest.icon && plugin.manifest.assetBasePath
                      ? `${plugin.manifest.assetBasePath.replace(/\/+$/, "")}/${plugin.manifest.icon}`
                      : null;
                  const author = plugin.manifest.author;
                  const homepage = plugin.manifest.homepage;
                  const repository = plugin.manifest.repository;
                  const license = plugin.manifest.license;
                  const keywords = plugin.manifest.keywords ?? [];
                  return (
                    <article key={plugin.id} className={styles.pluginCard}>
                      <div className={styles.pluginMeta}>
                        <div className={styles.pluginNameRow}>
                          {iconSrc && (
                            <img
                              src={iconSrc}
                              alt=""
                              className={styles.pluginIcon}
                              width={36}
                              height={36}
                              loading="lazy"
                            />
                          )}
                          <h2>{plugin.name}</h2>
                          <span
                            className={styles.pluginVersionPill}
                            aria-label={`Version ${plugin.version}`}
                          >
                            v{plugin.version}
                          </span>
                          <span data-status={status.status}>
                            {status.label}
                          </span>
                        </div>
                        <p>
                          {plugin.manifest.description ??
                            `${plugin.id} v${plugin.version}`}
                        </p>
                        {(author || homepage || repository || license) && (
                          <p className={styles.pluginAttribution}>
                            {author && (
                              <span className={styles.pluginAttributionItem}>
                                by{" "}
                                {author.url ? (
                                  <a
                                    href={safeUrl(author.url)}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                  >
                                    {author.name}
                                  </a>
                                ) : (
                                  author.name
                                )}
                              </span>
                            )}
                            {license && (
                              <span className={styles.pluginAttributionItem}>
                                <span className={styles.pluginLicenseBadge}>
                                  {license}
                                </span>
                              </span>
                            )}
                            {homepage && (
                              <a
                                className={styles.pluginAttributionItem}
                                href={safeUrl(homepage)}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                Homepage
                              </a>
                            )}
                            {repository && (
                              <a
                                className={styles.pluginAttributionItem}
                                href={safeUrl(repository)}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                Source
                              </a>
                            )}
                          </p>
                        )}
                        {keywords.length > 0 && (
                          <ul className={styles.pluginKeywords} aria-label="Keywords">
                            {keywords.map((keyword) => (
                              <li key={keyword}>{keyword}</li>
                            ))}
                          </ul>
                        )}
                        {plugin.lastError && (
                          <p className={styles.pluginError}>
                            {plugin.lastError}
                          </p>
                        )}
                        {editorActivationErrors[plugin.id] && (
                          <p className={styles.pluginError}>
                            Editor: {editorActivationErrors[plugin.id]}
                          </p>
                        )}
                        {plugin.recentCrashes && plugin.recentCrashes.length > 0 && (
                          <details className={styles.pluginCrashLog}>
                            <summary>
                              Recent issues ({plugin.recentCrashes.length})
                            </summary>
                            <ul>
                              {plugin.recentCrashes.map((crash) => (
                                <li key={crash.id}>
                                  <time dateTime={crash.occurredAt}>
                                    {new Date(crash.occurredAt).toLocaleString()}
                                  </time>
                                  <span> — {crash.reason}</span>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                        {plugin.manifest.pack &&
                          plugin.grantedPermissions.includes("visualComponents.register") && (
                            <p className={styles.pluginPackHint}>
                              Bundled Visual Components, templates, and CSS
                              classes are imported into your site on upload.
                              &ldquo;Re-sync pack&rdquo; replaces them with the
                              plugin&rsquo;s latest version &mdash; useful
                              after upgrading the plugin.
                            </p>
                          )}
                        {plugin.manifest.adminPages.length > 0 && (
                          <div className={styles.pageLinks}>
                            {plugin.manifest.adminPages.map((page) => (
                              <Link
                                key={page.id}
                                to={page.route ?? `/admin/plugins/${plugin.id}/${page.id}`}
                              >
                                {page.navLabel ?? page.title}
                              </Link>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className={styles.pluginActions}>
                        {plugin.manifest.settings && plugin.manifest.settings.length > 0 && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={busyPluginId === plugin.id}
                            onClick={() => setSettingsPluginId(plugin.id)}
                            aria-label={`Edit settings for ${plugin.name}`}
                          >
                            <span>Settings</span>
                          </Button>
                        )}
                        {plugin.manifest.pack &&
                          plugin.grantedPermissions.includes("visualComponents.register") && (
                            <Button
                              variant="secondary"
                              size="sm"
                              disabled={busyPluginId === plugin.id}
                              onClick={() => void installPluginPack(plugin)}
                              aria-label={`Re-sync ${plugin.name} pack from the plugin's latest version`}
                            >
                              <span>Re-sync pack</span>
                            </Button>
                          )}
                        {plugin.enabled && plugin.lifecycleStatus === "error" && (
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={busyPluginId === plugin.id}
                            onClick={() => void restartPlugin(plugin)}
                            aria-label={`Restart ${plugin.name}`}
                          >
                            <ReloadIcon size={14} aria-hidden="true" />
                            <span>Restart</span>
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busyPluginId === plugin.id}
                          onClick={() => void togglePlugin(plugin)}
                          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                        >
                          {plugin.enabled ? (
                            <PowerOffIcon size={14} aria-hidden="true" />
                          ) : (
                            <PowerIcon size={14} aria-hidden="true" />
                          )}
                          <span>{plugin.enabled ? "Disable" : "Enable"}</span>
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busyPluginId === plugin.id}
                          onClick={() => setPendingRemove(plugin)}
                          aria-label={`Remove ${plugin.name}`}
                        >
                          <DeleteIcon size={14} aria-hidden="true" />
                          <span>Remove</span>
                        </Button>
                      </div>
                    </article>
                  );
                })
              )}
            </div>

            {settingsPluginId && (
              <PluginSettingsDialog
                pluginId={settingsPluginId}
                pluginName={
                  payload.plugins.find((p) => p.id === settingsPluginId)?.name ??
                  settingsPluginId
                }
                onClose={() => setSettingsPluginId(null)}
                onSaved={() => {
                  notifyCmsPluginsChanged();
                  void loadPlugins();
                }}
              />
            )}

            {pendingRemove && (
              <PluginRemoveDialog
                plugin={pendingRemove}
                busy={busyPluginId === pendingRemove.id}
                onClose={() => setPendingRemove(null)}
                onConfirm={async () => {
                  const target = pendingRemove;
                  setPendingRemove(null);
                  await executeRemovePlugin(target);
                }}
              />
            )}
      </div>
    </AdminPageLayout>
  );
}
