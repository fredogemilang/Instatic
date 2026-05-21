/**
 * Api-call parser — validates and decodes a raw worker message into a typed
 * `ValidatedApiCall`. The host calls `parseApiCall(msg)` on every inbound
 * `api-call` message before dispatch; the result is fully typed and semantics-
 * checked.
 */

import { Value } from '@sinclair/typebox/value'
import type { TSchema } from '@sinclair/typebox'
import { ALLOWED_API_TARGETS, isAllowedApiTarget, type AllowedApiTarget } from './targets'
import { ApiCallSchemas, type ValidatedApiCall } from './apiCallSchema'

export class ApiCallValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiCallValidationError'
  }
}

function firstSchemaError(schema: TSchema, value: unknown): string {
  const [error] = [...Value.Errors(schema, value)]
  if (!error) return 'unknown validation error'
  const path = error.path || '/'
  return `${path}: ${error.message}`
}

export function normalizeRoutePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return '/'
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`
}

function validateApiCallSemantics(call: ValidatedApiCall): void {
  if (call.target !== 'cms.routes.register') return

  const [route] = call.args
  const normalizedPath = normalizeRoutePath(route.path)
  if (route.path !== normalizedPath) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: path must be normalized as "${normalizedPath}"`,
    )
  }

  const expectedRouteKey = `${route.method}:${normalizedPath}`
  if (route.routeKey !== expectedRouteKey) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for cms.routes.register: routeKey must be "${expectedRouteKey}"`,
    )
  }
}

function decodeApiCall(target: AllowedApiTarget, value: unknown): ValidatedApiCall {
  switch (target) {
    case 'cms.routes.register':
      return Value.Decode(ApiCallSchemas['cms.routes.register'], value)
    case 'cms.hooks.on':
      return Value.Decode(ApiCallSchemas['cms.hooks.on'], value)
    case 'cms.hooks.filter':
      return Value.Decode(ApiCallSchemas['cms.hooks.filter'], value)
    case 'cms.hooks.emit':
      return Value.Decode(ApiCallSchemas['cms.hooks.emit'], value)
    case 'cms.loops.registerSource':
      return Value.Decode(ApiCallSchemas['cms.loops.registerSource'], value)
    case 'cms.storage.list':
      return Value.Decode(ApiCallSchemas['cms.storage.list'], value)
    case 'cms.storage.create':
      return Value.Decode(ApiCallSchemas['cms.storage.create'], value)
    case 'cms.storage.update':
      return Value.Decode(ApiCallSchemas['cms.storage.update'], value)
    case 'cms.storage.delete':
      return Value.Decode(ApiCallSchemas['cms.storage.delete'], value)
    case 'cms.settings.replace':
      return Value.Decode(ApiCallSchemas['cms.settings.replace'], value)
    case 'network.fetch':
      return Value.Decode(ApiCallSchemas['network.fetch'], value)
    case 'network.abort':
      return Value.Decode(ApiCallSchemas['network.abort'], value)
    case 'cms.schedule.register':
      return Value.Decode(ApiCallSchemas['cms.schedule.register'], value)
    case 'cms.schedule.cancel':
      return Value.Decode(ApiCallSchemas['cms.schedule.cancel'], value)
    case 'cms.media.registerStorageAdapter':
      return Value.Decode(ApiCallSchemas['cms.media.registerStorageAdapter'], value)
    case 'cms.media.registerUrlTransformer':
      return Value.Decode(ApiCallSchemas['cms.media.registerUrlTransformer'], value)
    case 'cms.media.registerVariantDelegate':
      return Value.Decode(ApiCallSchemas['cms.media.registerVariantDelegate'], value)
    case 'crypto.digest':
      return Value.Decode(ApiCallSchemas['crypto.digest'], value)
    case 'crypto.signHmac':
      return Value.Decode(ApiCallSchemas['crypto.signHmac'], value)
    case 'cms.pages.list':
      return Value.Decode(ApiCallSchemas['cms.pages.list'], value)
    case 'cms.pages.republish':
      return Value.Decode(ApiCallSchemas['cms.pages.republish'], value)
    case 'cms.pages.republishAll':
      return Value.Decode(ApiCallSchemas['cms.pages.republishAll'], value)
  }
}

export function parseApiCall(value: unknown): ValidatedApiCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiCallValidationError('Invalid api-call payload: expected object')
  }

  const target = (value as { target?: unknown }).target
  if (typeof target !== 'string' || !isAllowedApiTarget(target)) {
    throw new ApiCallValidationError('Invalid api-call payload: unknown target')
  }

  const schema = ApiCallSchemas[target]
  if (!Value.Check(schema, value)) {
    throw new ApiCallValidationError(
      `Invalid api-call payload for ${target}: ${firstSchemaError(schema, value)}`,
    )
  }

  const parsed = decodeApiCall(target, value)
  validateApiCallSemantics(parsed)
  return parsed
}

// Re-export so callers can import the full allowlist if needed.
export { ALLOWED_API_TARGETS }
