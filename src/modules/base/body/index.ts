/**
 * base.body — page body module.
 *
 * Represents the page's `<body>` element. Emits no wrapper element at publish
 * time: the body node's children render directly into `<body>`, and any user
 * classes applied to the body land on `<body class="...">` via the publisher
 * (see `publishPage` in `src/core/publisher/render.ts`). The editor preview
 * component still wraps children in a `<div>` so the canvas has a click
 * target / drop zone for the body node — that wrapper is editor-only and
 * never reaches published HTML.
 */
import type { ModuleDefinition } from '@core/module-engine/types'
import { registry } from '@core/module-engine/registry'
import { FileTextIcon } from 'pixel-art-icons/icons/file-text'
import { BodyEditor } from './BodyEditor'

type BodyProps = Record<string, unknown>

export const BodyModule: ModuleDefinition<BodyProps> = {
  id: 'base.body',
  name: 'Body',
  category: 'Layout',
  version: '2.0.0',
  trusted: true,
  canHaveChildren: true,
  icon: FileTextIcon,

  schema: {},
  defaults: {},

  component: BodyEditor,

  // No wrapper element — children render directly into <body>. Body-level
  // user classes are applied to <body> by publishPage(), not here.
  render: (_props, renderedChildren) => ({
    html: renderedChildren.join(''),
  }),
}

registry.registerOrReplace(BodyModule)
