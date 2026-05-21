/**
 * TypeBox schemas for `cms.routes.register` api-call arguments.
 */

import { Type } from '@sinclair/typebox'

export const RouteMethodSchema = Type.Union([
  Type.Literal('GET'),
  Type.Literal('POST'),
  Type.Literal('PATCH'),
  Type.Literal('DELETE'),
])

export const RouteRegistrationArgSchema = Type.Object(
  {
    method: RouteMethodSchema,
    path: Type.String({ minLength: 1 }),
    capability: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    routeKey: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
)
