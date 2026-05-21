/**
 * Handler registries, __buildApi factory, and all __run* VM-side runners
 * evaluated inside every plugin QuickJS VM.
 *
 * This is the largest portion of the bootstrap: it wires the global
 * __plugin_handlers registry, exposes the api object plugins receive via
 * __buildApi(), and provides __runLifecycle / __runRoute / __runHookListener
 * / __runHookFilter / __runLoopFetch / __runLoopPreview / __runSchedule /
 * __runMediaAdapterCall / __runMediaUrlTransformer / __updateSettings /
 * __detectExportedHooks runners the host invokes to drive plugin code.
 */

export const API_AND_RUNNERS_SOURCE = `// ------- handler registries (live inside the VM, host has metadata) -------
globalThis.__plugin_handlers = {
  routes: {},
  listeners: {},
  filters: {},
  loopSources: {},
  schedules: {},
  // Media subsystem — each adapter is keyed by its namespaced id; each
  // entry is the { beginWrite, finalizeWrite, abortWrite, delete,
  // getReadUrl?, verify, readStream? } record the plugin handed to
  // api.cms.media.registerStorageAdapter. URL transformers are keyed by
  // a host-minted transformer id (mirroring the hook-filter pattern).
  mediaAdapters: {},
  mediaUrlTransformers: {},
};

// ------- the api object plugins receive -------
globalThis.__buildApi = function buildApi() {
  const meta = globalThis.__plugin_meta;

  function assertPermission(perm) {
    // Sync defense-in-depth check INSIDE the VM. The host-side dispatcher
    // also enforces permissions (kernel-of-correctness), but the host check
    // surfaces as a rejected Promise — plugin code that doesn't await
    // would otherwise silently succeed. Throwing synchronously here matches
    // the pre-sandbox 'assertPluginPermission' behavior plugin authors
    // already rely on.
    if (meta.permissions.indexOf(perm) < 0) {
      throw new Error('Plugin "' + meta.id + '" requires permission "' + perm + '"');
    }
  }

  function call(target, args) {
    return __hostCall(target, args);
  }

  function normalizePath(p) {
    const t = String(p).trim();
    if (!t || t === '/') return '/';
    return '/' + t.replace(/^\\/+|\\/+$/g, '');
  }

  function makeRoute(method) {
    return function (path, capability, handler) {
      assertPermission('cms.routes');
      if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
      const routeKey = method + ':' + normalizePath(path);
      globalThis.__plugin_handlers.routes[routeKey] = handler;
      return call('cms.routes.register', [{ method: method, path: normalizePath(path), capability: capability, routeKey: routeKey }]);
    };
  }
  function registerPublic(method) {
    return function (path, handler) {
      assertPermission('cms.routes');
      if (typeof handler !== 'function') throw new TypeError('Route handler must be a function');
      const routeKey = method + ':' + normalizePath(path);
      globalThis.__plugin_handlers.routes[routeKey] = handler;
      return call('cms.routes.register', [{ method: method, path: normalizePath(path), capability: null, routeKey: routeKey }]);
    };
  }

  function on(event, listener) {
    assertPermission('cms.hooks');
    if (typeof listener !== 'function') throw new TypeError('Hook listener must be a function');
    const listenerId = __nextId('listener');
    globalThis.__plugin_handlers.listeners[listenerId] = listener;
    return call('cms.hooks.on', [{ event: String(event), listenerId: listenerId }]);
  }
  function filter(name, handler) {
    assertPermission('cms.hooks');
    if (typeof handler !== 'function') throw new TypeError('Hook filter must be a function');
    const filterId = __nextId('filter');
    globalThis.__plugin_handlers.filters[filterId] = handler;
    return call('cms.hooks.filter', [{ name: String(name), filterId: filterId }]);
  }
  function emit(event, payload) {
    assertPermission('cms.hooks');
    return call('cms.hooks.emit', [{ event: String(event), payload: payload === undefined ? null : payload }]);
  }

  function registerSource(source) {
    assertPermission('loops.register');
    if (!source || typeof source !== 'object') throw new TypeError('Loop source must be an object');
    if (typeof source.fetch !== 'function') throw new TypeError('Loop source.fetch must be a function');
    const sourceId = String(source.id);
    globalThis.__plugin_handlers.loopSources[sourceId] = {
      fetch: source.fetch,
      preview: typeof source.preview === 'function' ? source.preview : function () { return []; },
    };
    const descriptor = {
      id: sourceId,
      label: source.label,
      description: source.description,
      filterSchema: source.filterSchema || {},
      orderByOptions: source.orderByOptions || [],
      fields: source.fields || [],
    };
    return call('cms.loops.registerSource', [descriptor]);
  }

  function collection(resourceId) {
    assertPermission('cms.storage');
    return {
      list: function (options) { return call('cms.storage.list', [String(resourceId), options ?? {}]); },
      create: function (data) { return call('cms.storage.create', [String(resourceId), data]); },
      update: function (recordId, data) { return call('cms.storage.update', [String(resourceId), String(recordId), data]); },
      delete: function (recordId) { return call('cms.storage.delete', [String(resourceId), String(recordId)]); },
    };
  }

  // ---- scheduled jobs --------------------------------------------------
  // Plugin declares cadence + handler at activate-time. The host upserts
  // a row; the scheduler tick fires the handler via __runSchedule(id).
  // Handler is stored INSIDE the VM (not serialised) — the host carries
  // only the schedule metadata in plugin_schedules.

  // The host namespaces schedule ids as <pluginId>.<localId> before
  // storing them (see pluginScheduleRegistration.ts:registerPluginSchedule)
  // and dispatches firings using the namespaced id. The VM's handler map
  // must use the SAME key so __runSchedule can resolve a registered handler.
  function namespaceScheduleId(localId) {
    const prefix = meta.id + '.';
    return localId.indexOf(prefix) === 0 ? localId : prefix + localId;
  }

  function scheduleRegister(def) {
    assertPermission('cms.schedule');
    if (!def || typeof def !== 'object') throw new TypeError('schedule.register: argument must be an object');
    if (typeof def.id !== 'string' || def.id.length === 0) throw new TypeError("schedule.register: 'id' is required");
    if (typeof def.handler !== 'function') throw new TypeError("schedule.register: 'handler' must be a function");
    if (!def.cadence || typeof def.cadence !== 'object') throw new TypeError("schedule.register: 'cadence' is required");
    const scheduleId = String(def.id);
    globalThis.__plugin_handlers.schedules[namespaceScheduleId(scheduleId)] = def.handler;
    const overlap = def.overlap === 'queue' || def.overlap === 'parallel' ? def.overlap : 'skip';
    // Cap at the host-side maximum (5 minutes); a stricter cap can be
    // negotiated later via a per-plugin manifest field. Default 5_000ms
    // matches the VM's default eval deadline so behaviour is consistent
    // with route / hook / loop calls.
    let maxDurationMs = typeof def.maxDurationMs === 'number' ? def.maxDurationMs : 5000;
    if (maxDurationMs < 100) maxDurationMs = 100;
    if (maxDurationMs > 5 * 60 * 1000) maxDurationMs = 5 * 60 * 1000;
    return call('cms.schedule.register', [{
      scheduleId: scheduleId,
      cadence: def.cadence,
      overlap: overlap,
      maxDurationMs: maxDurationMs,
    }]);
  }

  function scheduleCancel(id) {
    assertPermission('cms.schedule');
    const scheduleId = String(id);
    delete globalThis.__plugin_handlers.schedules[namespaceScheduleId(scheduleId)];
    return call('cms.schedule.cancel', [{ scheduleId: scheduleId }]);
  }

  const scheduleApi = {
    register: scheduleRegister,
    cancel: scheduleCancel,
    daily: function (id, at, handler) {
      return scheduleRegister({ id: id, cadence: { interval: 'daily', at: at }, handler: handler });
    },
    hourly: function (id, handler) {
      return scheduleRegister({ id: id, cadence: { interval: 'hourly' }, handler: handler });
    },
    every: function (minutes, id, handler) {
      return scheduleRegister({ id: id, cadence: { interval: 'every', minutes: minutes }, handler: handler });
    },
  };

  const settingsApi = {
    get: function (key) { return globalThis.__plugin_settings[key]; },
    getAll: function () { return Object.assign({}, globalThis.__plugin_settings); },
    replace: async function (next) {
      const updated = await call('cms.settings.replace', [next]);
      for (const k of Object.keys(globalThis.__plugin_settings)) delete globalThis.__plugin_settings[k];
      if (updated && typeof updated === 'object') Object.assign(globalThis.__plugin_settings, updated);
    },
  };

  // ---- media subsystem -----------------------------------------------------
  // Three independent surfaces under api.cms.media. The callbacks live INSIDE
  // the VM (stored under __plugin_handlers.mediaAdapters / mediaUrlTransformers);
  // the host only knows the adapter id + metadata. The host calls back into
  // the VM via __runMediaAdapterCall / __runMediaUrlTransformer when it
  // actually needs to upload/delete/transform a path.

  function registerStorageAdapter(adapter) {
    assertPermission('media.storage.adapter');
    if (!adapter || typeof adapter !== 'object') throw new TypeError('registerStorageAdapter: adapter must be an object');
    if (typeof adapter.id !== 'string' || !adapter.id) throw new TypeError("registerStorageAdapter: 'id' is required");
    if (adapter.id.indexOf(meta.id + '.') !== 0) {
      throw new Error('registerStorageAdapter: adapter id "' + adapter.id + '" must start with the plugin id "' + meta.id + '."');
    }
    if (typeof adapter.label !== 'string' || !adapter.label) throw new TypeError("registerStorageAdapter: 'label' is required");
    if (!Array.isArray(adapter.roles) || adapter.roles.length === 0) {
      throw new TypeError("registerStorageAdapter: 'roles' must be a non-empty array");
    }
    if (typeof adapter.servingMode !== 'string') throw new TypeError("registerStorageAdapter: 'servingMode' is required");
    if (typeof adapter.beginWrite !== 'function') throw new TypeError("registerStorageAdapter: 'beginWrite' must be a function");
    if (typeof adapter.finalizeWrite !== 'function') throw new TypeError("registerStorageAdapter: 'finalizeWrite' must be a function");
    if (typeof adapter.abortWrite !== 'function') throw new TypeError("registerStorageAdapter: 'abortWrite' must be a function");
    if (typeof adapter['delete'] !== 'function') throw new TypeError("registerStorageAdapter: 'delete' must be a function");
    if (typeof adapter.verify !== 'function') throw new TypeError("registerStorageAdapter: 'verify' must be a function");
    // Mode-specific constraints — the host re-validates but throwing here
    // surfaces the bug at activation time instead of first-use.
    if (adapter.servingMode === 'proxy' && typeof adapter.readStream !== 'function') {
      throw new TypeError("registerStorageAdapter: servingMode 'proxy' requires a 'readStream' function");
    }
    if (adapter.servingMode !== 'proxy' && typeof adapter.getReadUrl !== 'function') {
      throw new TypeError("registerStorageAdapter: servingMode '" + adapter.servingMode + "' requires a 'getReadUrl' function");
    }
    // Stash the live callback bag — keyed by id so the host's call-into-VM
    // round-trip can find it without iterating.
    globalThis.__plugin_handlers.mediaAdapters[adapter.id] = {
      beginWrite: adapter.beginWrite,
      finalizeWrite: adapter.finalizeWrite,
      abortWrite: adapter.abortWrite,
      delete: adapter['delete'],
      getReadUrl: typeof adapter.getReadUrl === 'function' ? adapter.getReadUrl : null,
      verify: adapter.verify,
      readStream: typeof adapter.readStream === 'function' ? adapter.readStream : null,
    };
    // Normalise CSP origins — accept either array of objects or undefined.
    const cspOrigins = Array.isArray(adapter.cspOrigins)
      ? adapter.cspOrigins.map(function (entry) {
        return { directive: String(entry.directive), origin: String(entry.origin) };
      })
      : undefined;
    return call('cms.media.registerStorageAdapter', [{
      adapterId: adapter.id,
      label: String(adapter.label),
      roles: adapter.roles.slice(),
      servingMode: String(adapter.servingMode),
      hasGetReadUrl: typeof adapter.getReadUrl === 'function',
      hasReadStream: typeof adapter.readStream === 'function',
      cspOrigins: cspOrigins,
    }]);
  }

  function registerUrlTransformer(fn) {
    assertPermission('media.url.transform');
    if (typeof fn !== 'function') throw new TypeError('registerUrlTransformer: argument must be a function');
    const transformerId = __nextId('mediaUrlT');
    globalThis.__plugin_handlers.mediaUrlTransformers[transformerId] = fn;
    return call('cms.media.registerUrlTransformer', [{ transformerId: transformerId }]);
  }

  function registerVariantDelegate(delegate) {
    assertPermission('media.variant.delegate');
    if (!delegate || typeof delegate !== 'object') throw new TypeError('registerVariantDelegate: argument must be an object');
    if (typeof delegate.id !== 'string' || !delegate.id) throw new TypeError("registerVariantDelegate: 'id' is required");
    if (delegate.id.indexOf(meta.id + '.') !== 0) {
      throw new Error('registerVariantDelegate: id "' + delegate.id + '" must start with the plugin id "' + meta.id + '."');
    }
    if (typeof delegate.variantUrlTemplate !== 'string') {
      throw new TypeError("registerVariantDelegate: 'variantUrlTemplate' must be a string");
    }
    if (!Array.isArray(delegate.widths) || delegate.widths.length === 0) {
      throw new TypeError("registerVariantDelegate: 'widths' must be a non-empty array");
    }
    if (!Array.isArray(delegate.formats) || delegate.formats.length === 0) {
      throw new TypeError("registerVariantDelegate: 'formats' must be a non-empty array");
    }
    return call('cms.media.registerVariantDelegate', [{
      delegateId: delegate.id,
      variantUrlTemplate: delegate.variantUrlTemplate,
      widths: delegate.widths.slice(),
      formats: delegate.formats.slice(),
    }]);
  }

  return {
    plugin: {
      id: meta.id,
      version: meta.version,
      permissions: meta.permissions.slice(),
      log: function () {
        const parts = [];
        for (let i = 0; i < arguments.length; i++) {
          const a = arguments[i];
          if (typeof a === 'string') parts.push(a);
          else {
            try { parts.push(JSON.stringify(a)); }
            catch (_) { parts.push(String(a)); }
          }
        }
        __log('info', parts.join(' '));
      },
      // Build a URL for a static file the plugin shipped in its zip.
      // assetBasePath looks like '/uploads/plugins/<id>/<version>'; we
      // join it with the package-relative path and normalize the slashes.
      assetUrl: function (path) {
        if (typeof path !== 'string' || path.length === 0) {
          throw new TypeError('assetUrl: path must be a non-empty string');
        }
        const base = (meta.assetBasePath || '').replace(/\\/+$/g, '');
        const rel = String(path).replace(/^\\/+/g, '');
        return base + '/' + rel;
      },
    },
    cms: {
      routes: {
        get: makeRoute('GET'),
        post: makeRoute('POST'),
        patch: makeRoute('PATCH'),
        delete: makeRoute('DELETE'),
        getPublic:    registerPublic('GET'),
        postPublic:   registerPublic('POST'),
        patchPublic:  registerPublic('PATCH'),
        deletePublic: registerPublic('DELETE'),
      },
      storage: { collection: collection },
      hooks: { on: on, filter: filter, emit: emit },
      loops: { registerSource: registerSource },
      settings: settingsApi,
      schedule: scheduleApi,
      pages: {
        list: function () {
          assertPermission('cms.pages.read');
          return call('cms.pages.list', []);
        },
        republish: function (pageId) {
          assertPermission('cms.pages.publish');
          return call('cms.pages.republish', [String(pageId)]);
        },
        republishAll: function () {
          assertPermission('cms.pages.publish');
          return call('cms.pages.republishAll', []);
        },
      },
      media: {
        registerStorageAdapter: registerStorageAdapter,
        registerUrlTransformer: registerUrlTransformer,
        registerVariantDelegate: registerVariantDelegate,
      },
    },
  };
};

let __idCounter = 0;
function __nextId(prefix) { __idCounter += 1; return prefix + '_' + __idCounter + '_' + Date.now().toString(36); }

// ------- runners — host calls these to dispatch into plugin code -------

/**
 * Resolve the actual plugin module from __plugin_exports. Plugin authors
 * write one of two shapes:
 *   - named lifecycle exports: \`export function activate(api) { ... }\`
 *   - a default-export module: \`export default { install, activate, ... }\`
 *
 * Both code paths land on __plugin_exports — but with named exports the
 * hooks are direct properties, while with default-export the hooks live
 * one level deeper (under .default). We unwrap the latter so the runners
 * find the hooks either way. The SDK build's facade ALSO unwraps, but
 * keeping this here as belt-and-suspenders means raw-ESM single-file
 * plugins (test fixtures, hand-authored modules going through the
 * worker's \`ensureIifeForm\` shim) work too.
 */
function __resolvePluginModule() {
  const root = globalThis.__plugin_exports;
  if (!root || typeof root !== 'object') return null;
  const def = root.default;
  const isPluginModule = function (v) {
    return v && typeof v === 'object' && (
      typeof v.install === 'function' ||
      typeof v.activate === 'function' ||
      typeof v.deactivate === 'function' ||
      typeof v.uninstall === 'function' ||
      typeof v.migrate === 'function'
    );
  };
  return isPluginModule(def) ? def : root;
}

globalThis.__runLifecycle = async function runLifecycle(hook) {
  const mod = __resolvePluginModule();
  const fn = mod && mod[hook];
  if (typeof fn !== 'function') return;
  await fn(globalThis.__buildApi());
};

globalThis.__runMigrate = async function runMigrate(fromVersion) {
  const mod = __resolvePluginModule();
  const fn = mod && mod.migrate;
  if (typeof fn !== 'function') return;
  await fn({ fromVersion: fromVersion }, globalThis.__buildApi());
};

globalThis.__runRoute = async function runRoute(routeKey, ctxJson) {
  const handler = globalThis.__plugin_handlers.routes[routeKey];
  if (!handler) throw new Error('Route handler not registered: ' + routeKey);
  const ctx = JSON.parse(ctxJson);
  // Build a case-insensitive Headers-like facade from the plain
  // Record<string, string> the host passes. Normalising to lowercase once
  // here matches the WHATWG Headers.get() semantics plugins expect.
  var _hdrs = ctx.request.headers || {};
  var _hdrsLc = {};
  for (var _k in _hdrs) {
    if (Object.prototype.hasOwnProperty.call(_hdrs, _k))
      _hdrsLc[String(_k).toLowerCase()] = _hdrs[_k];
  }
  var headersFacade = {
    get: function (name) {
      var k = String(name).toLowerCase();
      return Object.prototype.hasOwnProperty.call(_hdrsLc, k) ? _hdrsLc[k] : null;
    },
    has: function (name) {
      return Object.prototype.hasOwnProperty.call(_hdrsLc, String(name).toLowerCase());
    },
    entries: function () { return Object.entries(_hdrsLc); },
    keys:    function () { return Object.keys(_hdrsLc); },
    values:  function () { return Object.values(_hdrsLc); },
    forEach: function (cb) {
      Object.keys(_hdrsLc).forEach(function (k) { cb(_hdrsLc[k], k); });
    },
  };
  const req = {
    url: ctx.request.url,
    method: ctx.request.method,
    headers: headersFacade,
    json: async function () { return JSON.parse(ctx.request.body || '{}'); },
    text: async function () { return ctx.request.body; },
  };
  const result = await handler({ req: req, body: ctx.body, user: ctx.user });
  return JSON.stringify(result === undefined ? { ok: true } : result);
};

globalThis.__runHookListener = async function runHookListener(listenerId, payloadJson) {
  const fn = globalThis.__plugin_handlers.listeners[listenerId];
  if (!fn) return;
  await fn(JSON.parse(payloadJson));
};

globalThis.__runHookFilter = async function runHookFilter(filterId, valueJson, contextJson) {
  const fn = globalThis.__plugin_handlers.filters[filterId];
  if (!fn) return valueJson;
  const value = JSON.parse(valueJson);
  // Merge host-supplied context extras (siteId, pageId, slug, …) with the
  // always-present pluginId. The contextJson argument is optional — older
  // callers that don't pass it get a clean { pluginId } context.
  const contextExtras = contextJson ? JSON.parse(contextJson) : {};
  const context = Object.assign({ pluginId: globalThis.__plugin_meta.id }, contextExtras);
  const next = await fn(value, context);
  return JSON.stringify(next === undefined ? value : next);
};

globalThis.__runLoopFetch = async function runLoopFetch(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId];
  if (!source) throw new Error('Loop source not registered: ' + sourceId);
  const result = await source.fetch(JSON.parse(ctxJson));
  return JSON.stringify(result);
};

globalThis.__runLoopPreview = function runLoopPreview(sourceId, ctxJson) {
  const source = globalThis.__plugin_handlers.loopSources[sourceId];
  if (!source) throw new Error('Loop source not registered: ' + sourceId);
  return JSON.stringify(source.preview(JSON.parse(ctxJson)));
};

/**
 * Fire a scheduled job. Resolves with no value on success; throws on
 * handler error. The host wraps this call in its eval deadline (set per
 * schedule to maxDurationMs) so a runaway handler is interrupted cleanly.
 *
 * Lookup uses the namespaced id (e.g. 'acme.uptime.check-urls') because
 * scheduleRegister stores handlers under that key — mirroring the host's
 * pluginScheduleRegistration namespacing so both sides agree.
 *
 * If the handler isn't registered (e.g. plugin upgraded between tick and
 * dispatch, or the schedule row outlived a deactivate), we log and no-op
 * rather than throw — the schedule row will eventually be GC'd by the
 * host once the boot-claim grace window expires. We log so the silent
 * no-op surfaces during development if the handler-key ever drifts again.
 */
globalThis.__runSchedule = async function runSchedule(scheduleId) {
  const handler = globalThis.__plugin_handlers.schedules[scheduleId];
  if (typeof handler !== 'function') {
    __log('warn', 'no handler registered for schedule "' + String(scheduleId) + '"');
    return;
  }
  await handler();
};

/**
 * Generic adapter dispatch. The host calls this when it needs to invoke a
 * method on a plugin-registered MediaStorageAdapter (beginWrite, finalizeWrite,
 * abortWrite, delete, getReadUrl, verify). One runner instead of six so the
 * dispatcher's surface stays narrow and the per-method routing happens
 * inside the VM via a property lookup on the handler bag.
 *
 * argsJson is the JSON-encoded argument array for the method (so
 * beginWrite receives one object, delete receives one string, etc.). The
 * runner returns JSON-stringified value so the host's evalString helper
 * can carry the result back.
 */
globalThis.__runMediaAdapterCall = async function runMediaAdapterCall(adapterId, method, argsJson) {
  const adapter = globalThis.__plugin_handlers.mediaAdapters[adapterId];
  if (!adapter) throw new Error('Media adapter not registered: ' + adapterId);
  const fn = adapter[method];
  if (typeof fn !== 'function') throw new Error('Media adapter "' + adapterId + '" does not implement "' + method + '"');
  const argsArray = JSON.parse(argsJson);
  // .apply doesn't work cleanly through QuickJS' function wrapping; spread
  // into a regular call. Adapter methods accept 0..2 arguments in v1.
  const result = await fn(argsArray[0], argsArray[1]);
  return JSON.stringify(result === undefined ? null : result);
};

globalThis.__runMediaUrlTransformer = async function runMediaUrlTransformer(transformerId, payloadJson) {
  const fn = globalThis.__plugin_handlers.mediaUrlTransformers[transformerId];
  if (typeof fn !== 'function') {
    // Pass-through fallback. The host treats a null return as "no rewrite,
    // chain through to the next transformer's input value".
    return JSON.stringify(null);
  }
  const payload = JSON.parse(payloadJson);
  const next = await fn(payload.path, payload.ctx);
  return JSON.stringify(typeof next === 'string' ? next : null);
};

globalThis.__updateSettings = function updateSettings(nextJson) {
  const next = JSON.parse(nextJson);
  for (const k of Object.keys(globalThis.__plugin_settings)) delete globalThis.__plugin_settings[k];
  Object.assign(globalThis.__plugin_settings, next);
};

globalThis.__detectExportedHooks = function detectExportedHooks() {
  // Returns an Array (not a JSON string) because the host invokes this via
  // evalJson, which already wraps the result in JSON.stringify. Returning
  // a string would double-encode and the host would receive a string like
  // [["activate"]]. The runner-style helpers (__runRoute / __runLoopFetch
  // / ...) DO return JSON strings because their callers use evalString.
  const known = ['install', 'activate', 'deactivate', 'uninstall', 'migrate'];
  const mod = __resolvePluginModule() || {};
  const out = [];
  for (const name of known) {
    if (typeof mod[name] === 'function') out.push(name);
  }
  return out;
};
`
