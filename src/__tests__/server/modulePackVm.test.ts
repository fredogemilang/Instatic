/**
 * Regression tests for the QuickJS module-pack source shim.
 *
 * The shim converts the ESM-shaped bundle Bun emits into a
 * `globalThis.__module_pack = …` assignment that the bootstrap can read
 * inside QuickJS. Both export forms below have been seen in real plugin
 * bundles (module-pack plugins such as `acme.forms`) and must work.
 */
import { describe, expect, it } from 'bun:test'
import { createModulePackVm } from '../../../server/plugins/modulePackVm'

const PACK_BODY = `
function defineModule(def) { return def; }
const counter = defineModule({
  id: 'acme.canvas.counter',
  name: 'Counter',
  category: 'Acme',
  version: '1.0.0',
  defaults: { count: 0 },
  schema: {},
  render: (props) => ({ html: '<div>' + String(props.count) + '</div>' }),
});
var __modules_facade_default = [counter];
`

describe('modulePackVm — source shim', () => {
  it('accepts `export default <expr>` bundles', async () => {
    const source = `${PACK_BODY}\nexport default __modules_facade_default;\n`
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(vm.modules.map((m) => m.id)).toEqual(['acme.canvas.counter'])
    } finally {
      vm.dispose()
    }
  })

  it('accepts `export { X as default }` bundles (single-line)', async () => {
    const source = `${PACK_BODY}\nexport { __modules_facade_default as default };\n`
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(vm.modules.map((m) => m.id)).toEqual(['acme.canvas.counter'])
    } finally {
      vm.dispose()
    }
  })

  it('accepts `export { X as default }` bundles (multi-line block)', async () => {
    // The exact shape Bun's bundler produces for a re-export facade.
    const source = `${PACK_BODY}\nexport {\n  __modules_facade_default as default\n};\n`
    const vm = await createModulePackVm({ pluginId: 'acme.canvas', packSource: source })
    try {
      expect(vm.modules.map((m) => m.id)).toEqual(['acme.canvas.counter'])
    } finally {
      vm.dispose()
    }
  })
})
