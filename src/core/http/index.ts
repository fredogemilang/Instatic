/**
 * Canonical client-side HTTP layer. Import the transport from here:
 *
 *   import { apiRequest, ApiError, isAbortError } from '@core/http'
 */
export {
  apiRequest,
  readEnvelope,
  assertOk,
  responseErrorMessage,
  ApiError,
  isAbortError,
  ErrorEnvelopeSchema,
  type ApiRequestOptions,
  type FetchLike,
} from './apiClient'
