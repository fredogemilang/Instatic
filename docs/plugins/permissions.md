# Plugin Permissions

Plugins declare requested permissions in `plugin.json`. The CMS shows those permissions before installation and stores the owner-approved grants with the installed plugin. Runtime APIs must check granted permissions before exposing host capabilities.

## Permission Model

- `permissions` in `plugin.json` is the plugin request.
- `grantedPermissions` is the site owner approval stored by the CMS.
- Runtime APIs check `grantedPermissions`, not only the manifest request.
- No SDK surface should exist without a matching permission.
- Reserved permissions can exist before their APIs are implemented, but using them should not unlock private internals.

## Risk Levels

- `low`: visible UI additions with limited data access.
- `medium`: reads or writes plugin-owned data, or changes editor UI.
- `high`: mutates editor state, registers backend behavior, or runs plugin code on visitor browsers.
- `dangerous`: internal APIs reserved for trusted first-party plugins.

## Capability Matrix

| Permission | Surface | Risk | Meaning |
| --- | --- | --- | --- |
| `admin.navigation` | Admin | Low | Add pages to the CMS admin navigation and plugin router. |
| `cms.storage` | Admin, editor, server | Medium | Read and write records for resources declared by the plugin. |
| `cms.routes` | Server | High | Register authenticated backend routes under the plugin runtime URL. |
| `cms.hooks` | Server | High | Listen to CMS lifecycle events and register filters that transform values before they leave the CMS. |
| `editor.toolbar` | Editor | Medium | Add toolbar buttons to the editor UI. |
| `editor.commands` | Editor | Medium | Register commands callable from editor UI. **Also grants** Command Spotlight palette command registration (`api.editor.palette.registerCommand`) and live-search provider registration (`api.editor.palette.registerProvider`). No separate permission is needed for palette integration. |
| `editor.store.read` | Editor | Medium | Read current editor store state. |
| `editor.store.write` | Editor | High | Mutate editor store state through a host transaction. |
| `editor.canvas` | Editor | High | Register canvas overlay React components (annotation pins, custom selection adornments, measurement tools) via `api.editor.canvas.registerOverlay`. |
| `editor.panels` | Editor | Medium | Register left-sidebar panels (custom inspectors, plugin dashboards) via `api.editor.panels.register`. |
| `modules.register` | Editor, manifest | High | Ship new modules that show up in the canvas module library. |
| `loops.register` | Editor, server, manifest | Medium | Register new entity sources for the `base.loop` module. |
| `visualComponents.register` | Admin, manifest | Medium | Ship Visual Components, page templates, and class packs that get imported into the user's site on activation. |
| `frontend.assets` | Frontend, manifest | High | Inject declarative tags (external/inline scripts, external/inline styles, `<link>`, `<meta>`) into every published page via the manifest's `frontend.assets[]` array. The host is purely the substrate: it splices tags at four placement anchors (`head`, `head-end`, `body-start`, `body-end`), rewrites the CSP based on what the plan contains, and runs the `publish.html` filter — but ships no tag content of its own. Plugins that want shared frontend state (`window.__pb_analytics`, etc.) ship the IIFE that installs it as one of their own assets. |
| `network.outbound` | Server | High | Make outbound HTTP requests from the plugin's sandboxed server entrypoint. Requires a `networkAllowedHosts` allowlist in the manifest; calls to hosts outside the list are rejected at the host bridge even when the permission is granted. See [`sandbox.md`](sandbox.md#network-access). |
| `cms.pages.read` | Server, CMS | Low | Enumerate all published pages on the site via `api.cms.pages.list()`. Read-only — does not grant republish capability. |
| `cms.pages.publish` | Server, CMS | Medium | Trigger a republish of one or all published pages via `api.cms.pages.republish(id)` / `api.cms.pages.republishAll()`. The full publish pipeline fires (publish.before → publish.html → publish.after), so hook listeners and filters registered by other plugins run as part of the chain. |
| `cms.schedule` | Server | High | Register handlers that fire on a cadence (`hourly`, `daily`, `weekly`, `monthly`, `every-N-minutes`). Each handler runs inside the QuickJS sandbox with a per-fire wall-clock budget; the host's scheduler tick drives dispatch and records run history. See [`scheduled-jobs.md`](scheduled-jobs.md). |
| `unstable.internals` | Admin, editor, server | Dangerous | Reserved for trusted first-party plugins that need unstable host internals. |

The source of truth for labels, descriptions, risks, and surfaces is `src/core/plugin-sdk/capabilities.ts`.
