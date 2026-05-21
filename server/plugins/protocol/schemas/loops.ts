/**
 * TypeBox schemas for `cms.loops.registerSource` api-call arguments.
 */

import { Type } from '@sinclair/typebox'
import { PropertySchemaSchema } from '@core/module-engine/propertySchema'

export const LoopSourceFieldSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    format: Type.Optional(Type.Union([
      Type.Literal('plain'),
      Type.Literal('html'),
      Type.Literal('url'),
      Type.Literal('media'),
    ])),
  },
  { additionalProperties: false },
)

export const LoopSourceDescriptorSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String()),
    filterSchema: PropertySchemaSchema,
    orderByOptions: Type.Array(Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        label: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    )),
    fields: Type.Array(LoopSourceFieldSchema),
  },
  { additionalProperties: false },
)
