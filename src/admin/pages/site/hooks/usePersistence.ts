/**
 * usePersistence — React hook that wires the Zustand store to the CMS persistence adapter.
 *
 * Responsibilities:
 *  1. LOAD on mount  — loads the single CMS draft site document; falls back to
 *     creating a fresh blank draft when the CMS has no draft yet.
 *  2. AUTO-SAVE      — when enabled in preferences, debounced 30 s after the
 *     `hasUnsavedChanges` flag transitions to true. Timer is properly reset on
 *     each new change so that rapid edits collapse into a single save.
 *  3. MANUAL SAVE    — returned as a stable callback for toolbar Save and used
 *     by Cmd+S / Ctrl+S. Resets the unsaved-changes flag.
 *
 * Constraint #230: raw adapter data is validated via `validateSite` before
 * being passed to `store.loadSite()`.
 *
 * Mount it once at the top of EditorLayout and pass the returned save callback
 * to toolbar chrome that needs an explicit Save action.
 *
 * Guideline #239 / selector-stability note:
 *   All store reads inside effects use `useEditorStore.getState()` (point-in-time
 *   snapshots) rather than `useEditorStore(selector)` React hooks. This avoids
 *   subscribing EditorLayout to store changes from within this hook, which would
 *   cause spurious re-renders.
 *
 *   The auto-save subscription uses a primitive boolean selector
 *   `(s) => s.hasUnsavedChanges` so that `Object.is` comparisons work correctly
 *   and the listener fires ONLY when the flag actually changes — not on every
 *   single store update.  Using an inline object selector like
 *   `(s) => ({ site: s.site, dirty: s.hasUnsavedChanges })` would create
 *   a brand-new object on every evaluation, causing the listener to fire on
 *   every store mutation and leaking unbounded setTimeout instances.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditorStore } from '@site/store/store'
import type { IPersistenceAdapter } from '@core/persistence/types'
import { cmsAdapter } from '@core/persistence/cms'
import { validateSite, SiteValidationError } from '@core/persistence/validate'
import {
  readAutoSaveDelayMs,
  readAutoSavePreference,
  readEditorSelectPreference,
  subscribeToEditorPrefsChanged,
} from '@site/preferences/editorPreferences'
import { getKeybindingForCommand } from '@admin/spotlight/keybindings'

/**
 * Event dispatched by the Plugins admin page after a pack install (which
 * mutates the site document at the DB level via `saveDraftSite`). The
 * editor's in-memory store doesn't know to re-fetch — listening for this
 * event causes `usePersistence` to pull the fresh document and replay it
 * into the store so newly-imported Visual Components, pages, and CSS
 * classes appear without a hard browser reload.
 */
export const CMS_SITE_RELOAD_EVENT = 'cms-site-reload'

export interface PersistenceSaveStatus {
  state: 'loading' | 'saved' | 'unsaved' | 'saving' | 'error'
  message?: string
  lastSavedAt?: number
}

interface PersistenceController {
  saveSite: () => Promise<void>
  saveStatus: PersistenceSaveStatus
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim() ? err.message : fallback
}

/**
 * Apply the user's `defaultBreakpoint` preference if the loaded site declares
 * a matching breakpoint id. Falls back silently when the preference points to
 * a breakpoint the current site doesn't have (e.g. user previously edited a
 * site with a custom 'wide' breakpoint, then opened a site without it).
 */
function applyDefaultBreakpointPreference(
  breakpoints: ReadonlyArray<{ id: string }>,
): void {
  const preferredId = readEditorSelectPreference('defaultBreakpoint')
  if (!breakpoints.some((bp) => bp.id === preferredId)) return
  useEditorStore.getState().setActiveBreakpoint(preferredId)
}

export function usePersistence(
  requestedSiteId = 'default',
  adapter: IPersistenceAdapter = cmsAdapter,
  options: { markNewSiteUnsaved?: boolean; enabled?: boolean } = {},
): PersistenceController {
  const markNewSiteUnsaved = options.markNewSiteUnsaved ?? false
  const enabled = options.enabled ?? true
  const [saveStatus, setSaveStatus] = useState<PersistenceSaveStatus>(
    enabled ? { state: 'loading' } : { state: 'saved' },
  )
  /** Whether the initial load has completed — prevents auto-save before load */
  const loadedRef = useRef(false)
  /** Stable reference to the adapter so it doesn't trigger re-renders */
  const adapterRef = useRef(adapter)
  useEffect(() => {
    adapterRef.current = adapter
  }, [adapter])

  const saveCurrentSite = useCallback(async () => {
    const { site, setHasUnsavedChanges } = useEditorStore.getState()
    if (!site) return

    setSaveStatus({ state: 'saving', message: 'Saving draft' })
    try {
      await adapterRef.current.saveSite(site)
      setHasUnsavedChanges(false)
      setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
    } catch (err) {
      setSaveStatus({ state: 'error', message: errorMessage(err, 'Save failed') })
      throw err
    }
  }, [])

  // ─── 1. Load site document on mount ────────────────────────────────────────
  useEffect(() => {
    if (!enabled) {
      loadedRef.current = true
      return
    }

    let cancelled = false

    async function load() {
      // Read actions point-in-time — no React subscription needed
      const {
        site: existingSite,
        hasUnsavedChanges,
        loadSite,
        createSite,
        setHasUnsavedChanges,
      } = useEditorStore.getState()

      if (existingSite) {
        loadedRef.current = true
        setSaveStatus(
          hasUnsavedChanges
            ? { state: 'unsaved', message: 'Unsaved changes' }
            : { state: 'saved', lastSavedAt: Date.now() },
        )
        return
      }

      const idToTry = requestedSiteId || 'default'

      if (idToTry) {
        try {
          const raw = await adapterRef.current.loadSite(idToTry)
          if (raw && !cancelled) {
            // Constraint #230 — validate before hydrating the store
            const validated = validateSite(raw)
            loadSite(validated)
            applyDefaultBreakpointPreference(validated.breakpoints)
            loadedRef.current = true
            setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
            return
          }
        } catch (err) {
          if (err instanceof SiteValidationError) {
            console.warn('[persistence] Corrupt CMS site data:', err.message)
          } else {
            console.warn('[persistence] Failed to load CMS site:', err)
          }
          if (!cancelled) {
            setSaveStatus({ state: 'error', message: errorMessage(err, 'Failed to load CMS site') })
          }
          return
        }
      }

      // Bootstrap a fresh draft once for new installs that have an admin/site row
      // but no page-builder document yet.
      if (!cancelled) {
        const created = createSite('My Site')
        applyDefaultBreakpointPreference(created.breakpoints)
        loadedRef.current = true
        try {
          await adapterRef.current.saveSite(created)
          setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
        } catch (err) {
          setHasUnsavedChanges(true)
          setSaveStatus({
            state: markNewSiteUnsaved ? 'unsaved' : 'error',
            message: errorMessage(err, 'Draft not saved yet'),
          })
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [enabled, markNewSiteUnsaved, requestedSiteId])

  // External "site changed at the server" hook — the Plugins admin page fires
  // `CMS_SITE_RELOAD_EVENT` after installing a plugin pack so the editor pulls
  // the fresh draft document and the new VCs / pages / classes show up
  // without a browser reload.
  useEffect(() => {
    if (!enabled) return undefined

    async function reload() {
      const idToTry = requestedSiteId || 'default'
      try {
        const raw = await adapterRef.current.loadSite(idToTry)
        if (!raw) return
        const validated = validateSite(raw)
        const { loadSite, setHasUnsavedChanges } = useEditorStore.getState()
        loadSite(validated)
        applyDefaultBreakpointPreference(validated.breakpoints)
        // The site doc on disk is now authoritative; clear the unsaved flag so
        // the auto-save loop doesn't immediately overwrite it back.
        setHasUnsavedChanges(false)
        setSaveStatus({ state: 'saved', lastSavedAt: Date.now() })
      } catch (err) {
        console.error('[persistence] Reload after pack install failed:', err)
      }
    }

    function handleReload() {
      void reload()
    }

    window.addEventListener(CMS_SITE_RELOAD_EVENT, handleReload)
    return () => window.removeEventListener(CMS_SITE_RELOAD_EVENT, handleReload)
  }, [enabled, requestedSiteId])

  // ─── 2. Auto-save (debounced) ──────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return undefined

    // Primitive boolean selector — Object.is works correctly, listener fires
    // ONLY when hasUnsavedChanges actually changes (false→true or true→false).
    // This avoids creating a new object on every selector evaluation (which
    // would cause the listener to run on every store mutation — timer leak).
    let timer: ReturnType<typeof setTimeout> | undefined

    function scheduleAutoSave() {
      clearTimeout(timer)
      if (!loadedRef.current) return
      if (!useEditorStore.getState().hasUnsavedChanges) return
      if (!readAutoSavePreference()) return

      // Read the delay each time auto-save is scheduled — toggling the
      // preference re-fires `subscribeToEditorPrefsChanged` which calls back
      // into this scheduler, so the next scheduled tick uses the fresh value.
      timer = setTimeout(() => {
        void saveCurrentSite().catch((err) => {
          console.error('[persistence] Auto-save failed:', err)
        })
      }, readAutoSaveDelayMs())
    }

    const unsub = useEditorStore.subscribe(
      (s) => s.hasUnsavedChanges,
      (dirty) => {
        if (!dirty) {
          clearTimeout(timer)
          setSaveStatus((status) =>
            status.state === 'saving' ? status : { state: 'saved', lastSavedAt: status.lastSavedAt }
          )
          return
        }
        setSaveStatus({ state: 'unsaved', message: 'Unsaved changes' })
        scheduleAutoSave()
      },
    )
    const prefsUnsub = subscribeToEditorPrefsChanged(scheduleAutoSave)

    // beforeunload flush — prevent data loss on tab close.
    // The 30s debounce means the last unsaved edit would be dropped without this.
    // Fire-and-forget: beforeunload can't await async work.
    function flushOnUnload() {
      const { site, hasUnsavedChanges } = useEditorStore.getState()
      if (!site || !loadedRef.current || !hasUnsavedChanges) return
      clearTimeout(timer)
      void adapterRef.current.saveSite(site).catch((err) => {
        console.error('[persistence] beforeunload save failed:', err)
      })
    }

    window.addEventListener('beforeunload', flushOnUnload)

    return () => {
      unsub()
      prefsUnsub()
      clearTimeout(timer)
      window.removeEventListener('beforeunload', flushOnUnload)
    }
  }, [enabled, saveCurrentSite])

  // ─── 3. Cmd/Ctrl+S — immediate save ───────────────────────────────────────
  // Match predicate comes from the keybindings registry — single source of truth.
  useEffect(() => {
    if (!enabled) return undefined

    const kbSave = getKeybindingForCommand('editor.save')

    async function handleKeyDown(e: KeyboardEvent) {
      if (!kbSave?.match(e)) return
      e.preventDefault()

      try {
        await saveCurrentSite()
      } catch (err) {
        console.error('[persistence] Manual save failed:', err)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, saveCurrentSite])

  return { saveSite: saveCurrentSite, saveStatus }
}
