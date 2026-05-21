/**
 * BOOTSTRAP_SOURCE — the complete JavaScript source evaluated inside every
 * plugin QuickJS VM before any plugin code runs.
 *
 * Assembled from focused sub-modules to keep each concern independently
 * readable. The concatenation is byte-for-byte equivalent to the original
 * monolithic template literal.
 *
 * Execution order matters: polyfills must be defined before the API layer
 * references them (URL, TextEncoder, AbortController, crypto.subtle, fetch).
 * The order here mirrors the original source.
 */

import { URL_POLYFILL, TEXT_CODEC_POLYFILL, CONSOLE_POLYFILL, ABORT_CONTROLLER_POLYFILL } from './polyfills'
import { TIMERS_SOURCE } from './timers'
import { CRYPTO_SUBTLE_SHIM } from './crypto'
import { FETCH_SHIM } from './fetch'
import { API_AND_RUNNERS_SOURCE } from './api'

export const BOOTSTRAP_SOURCE =
  `\n'use strict';\n\n` +
  URL_POLYFILL +
  TEXT_CODEC_POLYFILL +
  CONSOLE_POLYFILL +
  TIMERS_SOURCE +
  ABORT_CONTROLLER_POLYFILL +
  CRYPTO_SUBTLE_SHIM +
  FETCH_SHIM +
  API_AND_RUNNERS_SOURCE
