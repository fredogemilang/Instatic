import { useEffect, useState } from 'react'

const FRAME_ID_SEPARATOR = '\u001f'
const EMPTY_READY_FRAME_IDS = new Set<string>()

type ReadyFrameState = {
  loadKey: string
  frameIdsKey: string
  readyIds: ReadonlySet<string>
}

interface ProgressiveCanvasFrameLoadingOptions {
  /**
   * Stable document identity. Use the active page/VC id, not the page object,
   * so ordinary node edits do not re-skeletonize an already-loaded canvas.
   */
  loadKey: string
  frameIds: ReadonlyArray<string>
  activeFrameId: string
  enabled: boolean
}

export function useProgressiveCanvasFrameLoading({
  loadKey,
  frameIds,
  activeFrameId,
  enabled,
}: ProgressiveCanvasFrameLoadingOptions): ReadonlySet<string> {
  const frameIdsKey = frameIds.join(FRAME_ID_SEPARATOR)
  const [state, setState] = useState<ReadyFrameState>(() => ({
    loadKey,
    frameIdsKey,
    readyIds: EMPTY_READY_FRAME_IDS,
  }))

  useEffect(() => {
    if (!enabled) return undefined

    const ids = parseFrameIds(frameIdsKey)
    const primaryId = ids.includes(activeFrameId)
      ? activeFrameId
      : ids[0] ?? null
    const pendingIds = primaryId === null ? ids : ids.filter((id) => id !== primaryId)
    let cancelled = false
    let cancelNextTask: (() => void) | null = null

    function revealFrame(frameId: string) {
      setState((current) => {
        const currentReadyIds = current.loadKey === loadKey && current.frameIdsKey === frameIdsKey
          ? current.readyIds
          : EMPTY_READY_FRAME_IDS
        if (currentReadyIds.has(frameId)) return current
        const readyIds = new Set(currentReadyIds)
        readyIds.add(frameId)
        return { loadKey, frameIdsKey, readyIds }
      })
    }

    function scheduleInactiveFrames() {
      const nextId = pendingIds.shift()
      if (!nextId) return
      cancelNextTask = scheduleIdleTask(() => {
        if (cancelled) return
        revealFrame(nextId)
        scheduleInactiveFrames()
      })
    }

    cancelNextTask = scheduleAfterPaint(() => {
      if (cancelled) return
      if (primaryId) revealFrame(primaryId)
      scheduleInactiveFrames()
    })

    return () => {
      cancelled = true
      cancelNextTask?.()
    }
  }, [activeFrameId, enabled, frameIdsKey, loadKey])

  if (!enabled) return new Set(parseFrameIds(frameIdsKey))
  return state.loadKey === loadKey && state.frameIdsKey === frameIdsKey
    ? state.readyIds
    : EMPTY_READY_FRAME_IDS
}

function parseFrameIds(frameIdsKey: string): string[] {
  return frameIdsKey ? frameIdsKey.split(FRAME_ID_SEPARATOR) : []
}

function scheduleAfterPaint(task: () => void): () => void {
  const rafId = requestAnimationFrame(task)
  return () => cancelAnimationFrame(rafId)
}

function scheduleIdleTask(task: () => void): () => void {
  const maybeWindow = typeof window === 'undefined' ? null : window
  const idleWindow = maybeWindow as (Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (handle: number) => void
  }) | null

  let idleId: number | null = null
  const timeoutId = setTimeout(() => {
    if (idleWindow?.requestIdleCallback) {
      idleId = idleWindow.requestIdleCallback(() => task(), { timeout: 160 })
      return
    }
    task()
  }, 32)

  return () => {
    clearTimeout(timeoutId)
    if (idleId !== null) idleWindow?.cancelIdleCallback?.(idleId)
  }
}
