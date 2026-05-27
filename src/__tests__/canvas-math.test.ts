/**
 * Canvas Math — pure function unit tests
 *
 * Tests clampZoom, nearestZoomStep, and ZOOM_STEPS from the canvas slice.
 * These are exported as pure functions for regression testing (see Performance
 * Engineer's Contribution #311 which adds timing assertions on top of these).
 *
 * All tests use bun:test. No DOM required — these are purely mathematical functions.
 */

import { describe, it, expect } from 'bun:test'
import {
  clampZoom,
  nearestZoomStep,
  ZOOM_STEPS,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
} from '@site/canvas/math'

// ---------------------------------------------------------------------------
// clampZoom
// ---------------------------------------------------------------------------

describe('clampZoom', () => {
  it('returns value unchanged when within valid range', () => {
    expect(clampZoom(0.5)).toBe(0.5)
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(1.5)).toBe(1.5)
    expect(clampZoom(2)).toBe(2)
    expect(clampZoom(3)).toBe(3)
  })

  it('clamps to MIN_ZOOM when below minimum', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(clampZoom(-1)).toBe(MIN_ZOOM)
    expect(clampZoom(-999)).toBe(MIN_ZOOM)
    expect(clampZoom(MIN_ZOOM - 0.001)).toBe(MIN_ZOOM)
  })

  it('clamps to MAX_ZOOM when above maximum', () => {
    expect(clampZoom(5)).toBe(MAX_ZOOM)
    expect(clampZoom(10)).toBe(MAX_ZOOM)
    expect(clampZoom(999)).toBe(MAX_ZOOM)
    expect(clampZoom(MAX_ZOOM + 0.001)).toBe(MAX_ZOOM)
  })

  it('returns exactly MIN_ZOOM at the lower boundary', () => {
    expect(clampZoom(MIN_ZOOM)).toBe(MIN_ZOOM)
  })

  it('returns exactly MAX_ZOOM at the upper boundary', () => {
    expect(clampZoom(MAX_ZOOM)).toBe(MAX_ZOOM)
  })

  it('DEFAULT_ZOOM is within valid range and unaffected by clamp', () => {
    expect(clampZoom(DEFAULT_ZOOM)).toBe(DEFAULT_ZOOM)
    expect(DEFAULT_ZOOM).toBeGreaterThanOrEqual(MIN_ZOOM)
    expect(DEFAULT_ZOOM).toBeLessThanOrEqual(MAX_ZOOM)
  })
})

// ---------------------------------------------------------------------------
// nearestZoomStep
// ---------------------------------------------------------------------------

describe('nearestZoomStep — zoom in (direction: 1)', () => {
  it('returns the next step above current zoom', () => {
    expect(nearestZoomStep(0.1, 1)).toBe(0.25)
    expect(nearestZoomStep(0.25, 1)).toBe(0.5)
    expect(nearestZoomStep(0.5, 1)).toBe(0.75)
    expect(nearestZoomStep(0.75, 1)).toBe(1)
    expect(nearestZoomStep(1, 1)).toBe(1.25)
    expect(nearestZoomStep(1.25, 1)).toBe(1.5)
    expect(nearestZoomStep(1.5, 1)).toBe(2)
    expect(nearestZoomStep(2, 1)).toBe(3)
    expect(nearestZoomStep(3, 1)).toBe(4)
  })

  it('returns MAX_ZOOM when already at max step', () => {
    expect(nearestZoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
  })

  it('returns MAX_ZOOM when above all steps (capped)', () => {
    expect(nearestZoomStep(3.9, 1)).toBe(MAX_ZOOM)
  })

  it('snaps correctly from a non-step value between steps', () => {
    // Between 1.0 and 1.25 — zooming in should snap to 1.25
    expect(nearestZoomStep(1.1, 1)).toBe(1.25)
    // Between 0.5 and 0.75 — zooming in should snap to 0.75
    expect(nearestZoomStep(0.6, 1)).toBe(0.75)
  })
})

describe('nearestZoomStep — zoom out (direction: -1)', () => {
  it('returns the next step below current zoom', () => {
    expect(nearestZoomStep(0.25, -1)).toBe(0.1)
    expect(nearestZoomStep(0.5, -1)).toBe(0.25)
    expect(nearestZoomStep(0.75, -1)).toBe(0.5)
    expect(nearestZoomStep(1, -1)).toBe(0.75)
    expect(nearestZoomStep(1.25, -1)).toBe(1)
    expect(nearestZoomStep(1.5, -1)).toBe(1.25)
    expect(nearestZoomStep(2, -1)).toBe(1.5)
    expect(nearestZoomStep(3, -1)).toBe(2)
    expect(nearestZoomStep(4, -1)).toBe(3)
  })

  it('returns MIN_ZOOM when already at min step', () => {
    expect(nearestZoomStep(MIN_ZOOM, -1)).toBe(MIN_ZOOM)
  })

  it('returns MIN_ZOOM when below all steps (floored)', () => {
    expect(nearestZoomStep(0.11, -1)).toBe(MIN_ZOOM)
  })

  it('snaps correctly from a non-step value between steps', () => {
    // Between 1.0 and 1.25 — zooming out should snap to 1.0
    expect(nearestZoomStep(1.1, -1)).toBe(1)
    // Between 0.5 and 0.75 — zooming out should snap to 0.5
    expect(nearestZoomStep(0.6, -1)).toBe(0.5)
  })
})

// ---------------------------------------------------------------------------
// ZOOM_STEPS array invariants
// ---------------------------------------------------------------------------

describe('ZOOM_STEPS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(ZOOM_STEPS)).toBe(true)
    expect(ZOOM_STEPS.length).toBeGreaterThan(0)
  })

  it('all values are positive numbers', () => {
    for (const step of ZOOM_STEPS) {
      expect(step).toBeGreaterThan(0)
    }
  })

  it('is monotonically increasing (no duplicate or out-of-order values)', () => {
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i]).toBeGreaterThan(ZOOM_STEPS[i - 1])
    }
  })

  it('starts at MIN_ZOOM', () => {
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM)
  })

  it('ends at MAX_ZOOM', () => {
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(MAX_ZOOM)
  })

  it('contains DEFAULT_ZOOM (1.0) as a named step', () => {
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM)
  })

  it('all values are within [MIN_ZOOM, MAX_ZOOM]', () => {
    for (const step of ZOOM_STEPS) {
      expect(step).toBeGreaterThanOrEqual(MIN_ZOOM)
      expect(step).toBeLessThanOrEqual(MAX_ZOOM)
    }
  })
})

// ---------------------------------------------------------------------------
// clampZoom + nearestZoomStep integration
// ---------------------------------------------------------------------------

describe('clampZoom + nearestZoomStep integration', () => {
  it('zooming in from every ZOOM_STEPS value never exceeds MAX_ZOOM after clamping', () => {
    for (const step of ZOOM_STEPS) {
      const next = nearestZoomStep(step, 1)
      expect(clampZoom(next)).toBe(next)
      expect(next).toBeLessThanOrEqual(MAX_ZOOM)
    }
  })

  it('zooming out from every ZOOM_STEPS value never goes below MIN_ZOOM after clamping', () => {
    for (const step of ZOOM_STEPS) {
      const prev = nearestZoomStep(step, -1)
      expect(clampZoom(prev)).toBe(prev)
      expect(prev).toBeGreaterThanOrEqual(MIN_ZOOM)
    }
  })
})

