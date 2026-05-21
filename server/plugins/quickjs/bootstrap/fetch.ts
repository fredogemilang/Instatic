/**
 * Gated fetch shim evaluated inside every plugin QuickJS VM.
 *
 * Plugins with 'network.outbound' permission AND a matching networkAllowedHosts
 * entry can issue outbound HTTP. The host enforces both checks; this shim
 * provides a Response-like facade for the familiar fetch API.
 *
 * AbortSignal threading: each call mints a unique abortId and, if the
 * plugin's signal aborts, fires network.abort to cancel the host-side
 * in-flight request.
 */

export const FETCH_SHIM = `// ------- gated fetch -------
// Plugins with the 'network.outbound' permission AND a matching entry in
// the manifest's networkAllowedHosts can issue outbound HTTP. The host
// enforces both checks (kernel-of-correctness); this shim provides a
// Response-like façade so plugin code can use the familiar fetch API.
//
// AbortSignal threading: each call mints a unique abortId and registers
// it on the host. If the plugin's signal aborts before the host fetch
// completes, the polyfill fires the network.abort api-call so the host's
// AbortController cancels the in-flight request instead of waiting for
// it to settle. The host fetch's pending promise is also raced against
// a local rejection so the plugin's await resolves immediately.
let __fetch_abort_seq = 0;

function __materializeResponse(result) {
  return {
    status: result.status,
    ok: result.ok,
    headers: {
      get: function (name) { return result.headers[String(name).toLowerCase()] || null; },
      has: function (name) { return Object.prototype.hasOwnProperty.call(result.headers, String(name).toLowerCase()); },
      forEach: function (cb) { for (const k of Object.keys(result.headers)) cb(result.headers[k], k); },
    },
    text: async function () { return result.body; },
    json: async function () { return JSON.parse(result.body); },
    arrayBuffer: async function () {
      const buf = new Uint8Array(result.body.length);
      for (let i = 0; i < result.body.length; i++) buf[i] = result.body.charCodeAt(i) & 0xff;
      return buf.buffer;
    },
  };
}

function __abortError(reason) {
  if (reason && typeof reason === 'object') return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  err.name = 'AbortError';
  return err;
}

globalThis.fetch = async function fetch(input, init) {
  const url = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
  const opts = init && typeof init === 'object' ? init : {};
  const serialized = {
    method: typeof opts.method === 'string' ? opts.method : 'GET',
    headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : {},
    body: typeof opts.body === 'string' ? opts.body : (opts.body == null ? undefined : String(opts.body)),
  };
  const signal = opts.signal && typeof opts.signal === 'object' ? opts.signal : null;
  if (signal && signal.aborted) throw __abortError(signal.reason);

  __fetch_abort_seq += 1;
  const abortId = 'a' + __fetch_abort_seq + '_' + Date.now().toString(36);
  serialized.abortId = abortId;

  const hostPromise = __hostCall('network.fetch', [url, serialized]);

  if (!signal) {
    const result = await hostPromise;
    return __materializeResponse(result);
  }

  // Race the host fetch against the signal — if abort wins, also tell the
  // host to cancel the in-flight request so its socket / response stream
  // is torn down instead of leaking until natural completion.
  let abortListener = null;
  const abortPromise = new Promise(function (_, reject) {
    abortListener = function () {
      reject(__abortError(signal.reason));
      // Fire-and-forget — if the host call already returned, the host's
      // map entry is gone and this is a no-op.
      try { __hostCall('network.abort', [{ abortId: abortId }]); } catch (_) {}
    };
    signal.addEventListener('abort', abortListener);
  });

  try {
    const result = await Promise.race([hostPromise, abortPromise]);
    return __materializeResponse(result);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
};

`
