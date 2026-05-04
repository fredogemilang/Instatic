/**
 * ToastProvider — mounts once at the admin shell and renders bus-published
 * toasts in a fixed-position stack at the bottom-right of the viewport.
 *
 * Render path:
 *   1. Subscribes to `subscribeToasts`; React state mirrors the bus snapshot.
 *   2. Each toast renders with role="alert" (errors / warnings) or "status"
 *      (info / success).
 *   3. Toasts auto-dismiss based on their `durationMs` (8s for errors, 4s for
 *      others, or `null` to keep until manually closed).
 *
 * Pause-on-hover: the auto-dismiss timer pauses while the user hovers the
 * stack, so multi-toast bursts stay readable. Resumes on mouseleave.
 *
 * Constraints:
 *   - CSS Modules only, achromatic + semantic state tokens
 *   - No Tailwind, no inline styles except dynamic CSS custom properties
 *   - role="alert" / role="status" per toast kind
 *   - Close affordance + optional action use the Button primitive
 *   - Pixel-art icons only (close, circle-alert, warning-diamond)
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@ui/components/Button'
import { cn } from '@ui/cn'
import { CloseIcon } from 'pixel-art-icons/icons/close'
import { CircleAlertIcon } from 'pixel-art-icons/icons/circle-alert'
import { WarningDiamondIcon } from 'pixel-art-icons/icons/warning-diamond'
import {
  dismissToast,
  subscribeToasts,
  type Toast,
  type ToastKind,
} from './toastBus'
import styles from './Toast.module.css'

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  error: 8000,
  warning: 6000,
  success: 4000,
  info: 4000,
}

const TOAST_ROOT_ID = 'toast-root'

function getToastRoot(): HTMLElement {
  let root = document.getElementById(TOAST_ROOT_ID)
  if (!root) {
    root = document.createElement('div')
    root.id = TOAST_ROOT_ID
    document.body.appendChild(root)
  }
  return root
}

/**
 * Resolve the role attribute from the kind. Errors / warnings interrupt
 * assistive tech; info / success are non-blocking status announcements.
 */
function ariaRoleForKind(kind: ToastKind): 'alert' | 'status' {
  return kind === 'error' || kind === 'warning' ? 'alert' : 'status'
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'error') return <CircleAlertIcon size={14} aria-hidden="true" />
  if (kind === 'warning') return <WarningDiamondIcon size={14} aria-hidden="true" />
  // success / info share the circle-alert glyph at lower visual weight
  return <CircleAlertIcon size={14} aria-hidden="true" />
}

export function ToastProvider() {
  const [items, setItems] = useState<ReadonlyArray<Toast>>([])
  const [paused, setPaused] = useState(false)
  // Per-toast timer handles, keyed by toast id. Refs because timers are
  // imperative — putting them in state would cause re-render loops.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const portalRoot = useMemo(
    () => (typeof document !== 'undefined' ? getToastRoot() : null),
    [],
  )

  useEffect(() => {
    return subscribeToasts((next) => setItems(next))
  }, [])

  useEffect(() => {
    const timers = timersRef.current

    if (paused) {
      // Pause: cancel pending timers; we'll re-arm on resume.
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      return
    }

    // Resume / fresh subscribe: arm a timer for each toast that doesn't have
    // one and hasn't opted out of auto-dismiss.
    for (const toast of items) {
      if (timers.has(toast.id)) continue
      if (toast.durationMs === null) continue
      const duration = toast.durationMs ?? DEFAULT_DURATION_MS[toast.kind]
      const timer = setTimeout(() => {
        timers.delete(toast.id)
        dismissToast(toast.id)
      }, duration)
      timers.set(toast.id, timer)
    }

    // Drop timers for toasts that have been removed externally.
    for (const id of Array.from(timers.keys())) {
      if (!items.some((t) => t.id === id)) {
        clearTimeout(timers.get(id)!)
        timers.delete(id)
      }
    }
  }, [items, paused])

  useEffect(() => {
    // Capture the Map identity at effect setup so the cleanup never reads
    // a possibly-rotated ref. timersRef itself never changes, but the lint
    // rule treats `.current` as mutable and we want to honour it cleanly.
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  if (!portalRoot || items.length === 0) return null

  return createPortal(
    <div
      className={styles.stack}
      data-testid="toast-stack"
      aria-label="Notifications"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {items.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>,
    portalRoot,
  )
}

function ToastItem({ toast }: { toast: Toast }) {
  const [actionPending, setActionPending] = useState(false)

  async function handleAction() {
    if (!toast.action) return
    try {
      setActionPending(true)
      await Promise.resolve(toast.action.onSelect())
    } catch (err) {
      console.error(`[toast] action "${toast.action.label}" failed:`, err)
    } finally {
      setActionPending(false)
    }
  }

  return (
    <div
      role={ariaRoleForKind(toast.kind)}
      aria-live={toast.kind === 'error' || toast.kind === 'warning' ? 'assertive' : 'polite'}
      className={cn(styles.toast, styles[`kind-${toast.kind}`])}
      data-toast-kind={toast.kind}
      data-toast-location={toast.location}
    >
      <span className={styles.icon} aria-hidden="true">
        <ToastIcon kind={toast.kind} />
      </span>
      <div className={styles.content}>
        <p className={styles.title}>{toast.title}</p>
        {toast.body && <p className={styles.body}>{toast.body}</p>}
        {toast.location && (
          <p className={styles.location}>{toast.location}</p>
        )}
      </div>
      <div className={styles.actions}>
        {toast.action && (
          <Button
            variant="secondary"
            size="micro"
            onClick={() => void handleAction()}
            disabled={actionPending}
          >
            <span>{toast.action.label}</span>
          </Button>
        )}
        <Button
          variant="ghost"
          size="micro"
          iconOnly
          aria-label="Dismiss notification"
          onClick={() => dismissToast(toast.id)}
        >
          <CloseIcon size={12} aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
