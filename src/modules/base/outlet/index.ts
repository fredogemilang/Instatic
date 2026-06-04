/**
 * base.outlet — the single content outlet for templates.
 *
 * Polymorphic: the composer either splices matched content (a page tree or a
 * nested template) in place of this node, OR — for the innermost outlet on an
 * entry route — leaves it here to render the current entry's body. The
 * `data-instatic-content-region` marker is what the Content workspace's Live
 * mode mounts Tiptap against, so it is emitted unconditionally.
 */
import type { ModuleDefinition } from '@core/module-engine'
import { registry } from '@core/module-engine'
import { Type, Value, type Static } from '@core/utils/typeboxHelpers'
import { TargetSolidIcon } from 'pixel-art-icons/icons/target-solid'
import { OutletEditor } from './OutletEditor'

const OutletPropsSchema = Type.Object({
  html: Type.String({ default: '' }),
})

type OutletProps = Static<typeof OutletPropsSchema>

export const OutletModule: ModuleDefinition<OutletProps> = {
  id: 'base.outlet',
  name: 'Content Outlet',
  description: 'Where matched content (a page or the current entry body) flows in.',
  category: 'CMS',
  version: '1.0.0',
  icon: TargetSolidIcon,
  trusted: true,
  canHaveChildren: false,

  schema: {
    html: { type: 'richtext', label: 'HTML' },
  },

  propsSchema: OutletPropsSchema,
  defaults: Value.Create(OutletPropsSchema) as OutletProps,

  component: OutletEditor,

  htmlTag: 'article',

  render: (props) => {
    const html = typeof props.html === 'string' ? props.html : ''
    return { html: `<article data-instatic-content-region>${html}</article>` }
  },
}

registry.registerOrReplace(OutletModule)
