/**
 * `pb-plugin.config.ts` — single source of truth for the Three Kit plugin.
 *
 * The build script (`bun run scripts/build-plugin.ts examples/plugins/three-kit`)
 * reads this file, evaluates it via Bun's TypeScript loader, then emits the
 * runtime zip layout the host installer expects:
 *
 *   examples/plugins/three-kit/dist/
 *     plugin.json
 *     modules/index.js
 *     icon.svg
 *
 *   examples/plugins/three-kit.plugin.zip
 *
 * From the developer's seat: edit any TypeScript file under this folder,
 * re-run the build, re-upload the zip from the Plugins admin page.
 *
 * Modules-only plugin. No server entrypoint, no pack, no admin pages —
 * just five canvas modules that declare `three` as a site dependency.
 */
import { definePlugin, permissions } from '@core/plugin-sdk'
import scene from './modules/scene'
import particles from './modules/particles'
import text from './modules/text'
import modelViewer from './modules/modelViewer'
import heroBackground from './modules/heroBackground'

export default definePlugin({
  id: 'acme.three-kit',
  name: 'Three Kit',
  version: '1.0.0',
  description:
    'Five Three.js canvas modules — rotating scene, particle field, 3D text, glTF model viewer, and animated hero background. Inserts auto-register `three` in the Dependencies Panel.',
  author: { name: 'Acme 3D', url: 'https://acme.dev/three-kit' },
  license: 'MIT',
  homepage: 'https://acme.dev/page-builder/three-kit',
  repository: 'https://github.com/acme/page-builder-three-kit',
  keywords: ['threejs', '3d', 'webgl', 'hero', 'particles', 'gltf'],
  icon: 'icon.svg',
  // `frontend.assets` ships the single page-runtime bundle that boots all
  // module instances on a published page — exactly one `<script>` tag per
  // page, regardless of how many three-kit modules the user drops in.
  permissions: [permissions.modulesRegister, permissions.frontendAssets],
  // External hosts the model viewer module fetches glTF assets from. The
  // host aggregates `networkAllowedHosts` across enabled frontend plugins
  // and adds them to the published page's CSP `connect-src` directive —
  // without this entry, the visitor's browser would block the fetch.
  // Operators can fork this list to permit their own model CDNs.
  networkAllowedHosts: ['threejs.org'],
  // Single page-runtime bundle. Three.js imports stay as bare specifiers
  // because the build externalises packages declared as `dependencies`
  // by any module (see `dependencies: { three: '...' }` in each module
  // file). The published page's importmap resolves them at runtime.
  frontend: {
    assets: [
      {
        kind: 'script',
        src: 'frontend/index.js',
        placement: 'body-end',
        // ESM so the bare imports survive into the browser.
        strategy: 'module',
      },
    ],
  },
  modules: [scene, particles, text, modelViewer, heroBackground],
})
