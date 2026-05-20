/**
 * Resolve frontend tags injected into published pages by enabled plugins.
 *
 * Two surfaces:
 *   • `frontend.scripts` — plugin ships a JS file under `entrypoints.frontend`
 *     (path inside the package zip). The file is served from the plugin's
 *     uploads URL prefix and loaded as a deferred `<script type="module">`
 *     just before `</body>`.
 *   • `frontend.tracker` — the host injects a tiny built-in tracker runtime
 *     once if any plugin has the permission. The runtime exposes
 *     `window.__pb.tracker.send(eventName, payload)` and the plugin's
 *     `frontend` script can call it.
 *
 * Pure data assembly — no DOM, no fetch. Run from the publisher only.
 */

import type { DbClient } from '../db/client'
import { listInstalledPlugins } from '../repositories/plugins'
import { mediaStorageRegistry } from '@core/plugins/mediaStorageRegistry'
import { listElectedAdapters } from '../repositories/mediaStorageAdapters'

export interface FrontendInjections {
  headTags: string[]
  bodyTags: string[]
  /**
   * Union of `networkAllowedHosts` declared by every enabled plugin that
   * contributed a body tag. Used by `injectFrontendAssets` to extend the
   * page CSP's `connect-src` so visitor-side fetches from those plugins
   * (e.g. a glTF model viewer pulling from a CDN) aren't blocked by the
   * page's strict default of `connect-src 'self'`.
   *
   * Plain hostnames (`api.example.com`) match exactly; the leading `*.`
   * wildcard matches one subdomain segment — same semantics the manifest
   * schema enforces.
   */
  networkAllowedHosts: string[]
  /**
   * CSP origins declared by elected media storage adapters. The publisher
   * appends them to the matching CSP directive (`img-src`, `media-src`,
   * `connect-src`) so the browser is allowed to load assets from the
   * adapter's backend (e.g. `https://*.s3.amazonaws.com` for the S3
   * adapter). Origins from non-elected adapters are NOT included —
   * installed-but-inactive adapters don't pollute the CSP.
   */
  mediaCspOrigins: ReadonlyArray<{
    directive: 'img-src' | 'media-src' | 'connect-src'
    origin: string
  }>
}

/**
 * Inject `<script>` / `<link>` tags from enabled `frontend.scripts` /
 * `frontend.tracker` plugins into a publisher-rendered HTML document.
 *
 * Same shape applies to both real-publish output (`renderPublishedSnapshot`)
 * AND the editor's preview iframe (`buildRuntimePreviewDocument`) — both
 * paths must end up with identical injections + CSP so previews match
 * what visitors will see on the deployed page.
 *
 * Side effects:
 *   • Inline tracker runtime relaxes script-src to `'self' 'unsafe-inline'`
 *     (the tracker IIFE is inline and needs to execute on the page).
 *   • `networkAllowedHosts` aggregated by `collectFrontendInjections` get
 *     appended to `connect-src` and `img-src` so plugin frontend code
 *     can reach the hosts the manifest declared.
 */
export function injectFrontendAssets(
  html: string,
  injections: FrontendInjections,
): string {
  let next = html
  if (injections.headTags.length > 0) {
    const headTag = injections.headTags.join('\n')
    next = next.includes('</head>')
      ? next.replace('</head>', `${headTag}\n</head>`)
      : `${headTag}\n${next}`
  }
  if (injections.bodyTags.length > 0) {
    const bodyTag = injections.bodyTags.join('\n')
    next = next.includes('</body>')
      ? next.replace('</body>', `${bodyTag}\n</body>`)
      : `${next}\n${bodyTag}`
    next = relaxCspForFrontendPlugins(next, injections.networkAllowedHosts)
  }
  if (injections.mediaCspOrigins.length > 0) {
    next = appendMediaAdapterCspOrigins(next, injections.mediaCspOrigins)
  }
  return next
}

/**
 * Append CSP origins declared by elected media storage adapters. Runs
 * regardless of whether any frontend plugin tags were injected — a site
 * can use an external storage backend without any frontend.scripts
 * plugin being active. The directive sources extend `'self'` so the
 * host-relative defaults (`/uploads/*`, `/_pb/*`) keep working.
 */
function appendMediaAdapterCspOrigins(
  html: string,
  origins: ReadonlyArray<{ directive: 'img-src' | 'media-src' | 'connect-src'; origin: string }>,
): string {
  // Bucket by directive so a single appendOrSetCspDirective call carries
  // every source for that directive — keeps the rewrite idempotent under
  // repeated render passes.
  const byDirective = new Map<'img-src' | 'media-src' | 'connect-src', Set<string>>()
  for (const entry of origins) {
    const bucket = byDirective.get(entry.directive) ?? new Set<string>()
    bucket.add(`https://${entry.origin}`)
    byDirective.set(entry.directive, bucket)
  }
  return html.replace(CSP_META_PATTERN, (full, content: string) => {
    let nextCsp = content
    for (const [directive, sources] of byDirective) {
      nextCsp = appendOrSetCspDirective(nextCsp, directive, ["'self'", ...sources])
    }
    return full.replace(content, nextCsp)
  })
}

const CSP_META_PATTERN = /<meta http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/i

function relaxCspForFrontendPlugins(html: string, allowedHosts: string[]): string {
  return html.replace(CSP_META_PATTERN, (full, content: string) => {
    let next = content
    next = next.replace(/script-src [^;]*;/i, `script-src 'self' 'unsafe-inline';`)
    next = next.replace(/worker-src [^;]*;/i, `worker-src 'self' blob:;`)
    if (allowedHosts.length > 0) {
      next = appendOrSetCspDirective(next, 'connect-src', ["'self'", ...toCspHostSources(allowedHosts)])
      next = appendOrSetCspDirective(next, 'img-src', ["'self'", 'data:', 'https:'])
    }
    return full.replace(content, next)
  })
}

/**
 * Translate manifest-style host patterns (`api.example.com`, `*.example.com`)
 * to CSP source expressions. CSP wildcards use `*.example.com` with the
 * scheme implicit — `https://*.example.com` is the safest form because the
 * publisher already forces HTTPS at the publish layer.
 */
function toCspHostSources(hosts: string[]): string[] {
  return hosts.map((host) => `https://${host}`)
}

/**
 * Replace the named CSP directive's source list (if present) or append a
 * new directive at the end. Idempotent on identical inputs — keeps the
 * directive value sorted-and-deduped via a Set so repeated re-renders
 * produce the same string.
 */
function appendOrSetCspDirective(policy: string, directive: string, sources: string[]): string {
  const sourceSet = new Set(sources)
  const sourcesValue = [...sourceSet].join(' ')
  const pattern = new RegExp(`${directive}\\s+[^;]*;`, 'i')
  if (pattern.test(policy)) {
    return policy.replace(pattern, (existing) => {
      const existingValue = existing.replace(new RegExp(`^${directive}\\s+`, 'i'), '').replace(/;\s*$/, '')
      for (const part of existingValue.split(/\s+/).filter(Boolean)) sourceSet.add(part)
      return `${directive} ${[...sourceSet].join(' ')};`
    })
  }
  const trimmed = policy.trim().replace(/;\s*$/, '')
  return `${trimmed}; ${directive} ${sourcesValue};`
}

const TRACKER_RUNTIME = `<script>(function(){
  if(window.__pb && window.__pb.tracker)return;
  var ENDPOINT='/_pb/tracker';
  function rid(){return (Math.random().toString(36).slice(2)+Date.now().toString(36)).slice(0,16);}
  function visitorId(){
    try{
      var k='__pb_v',v=localStorage.getItem(k);
      if(!v){v=rid();localStorage.setItem(k,v);}
      return v;
    }catch(e){return rid();}
  }
  function sessionId(){
    try{
      var k='__pb_s',v=sessionStorage.getItem(k);
      if(!v){v=rid();sessionStorage.setItem(k,v);}
      return v;
    }catch(e){return rid();}
  }
  var listeners={};
  function on(evt,fn){(listeners[evt]=listeners[evt]||[]).push(fn);return function(){listeners[evt]=(listeners[evt]||[]).filter(function(x){return x!==fn});};}
  function emit(evt,detail){(listeners[evt]||[]).forEach(function(fn){try{fn(detail);}catch(e){console.error('[__pb] listener',e);}});}
  function send(pluginId,eventName,payload){
    return fetch(ENDPOINT,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},keepalive:true,body:JSON.stringify({pluginId:pluginId,eventName:eventName,payload:payload||{},visitorId:visitorId(),sessionId:sessionId(),pagePath:location.pathname,referrer:document.referrer||null,clientTime:new Date().toISOString()})}).catch(function(e){console.warn('[__pb] tracker send failed',e);});
  }
  window.__pb={
    visitorId:visitorId(),
    sessionId:sessionId(),
    hooks:{on:on,emit:emit},
    tracker:{
      send:function(name,payload){return send.apply(null,['__implicit__',name,payload]);},
      sendFor:function(pluginId,name,payload){return send(pluginId,name,payload||{});},
    }
  };
  function fire(evt,detail){emit(evt,detail);}
  // Page view
  document.addEventListener('DOMContentLoaded',function(){fire('page-view',{path:location.pathname,title:document.title});});
  // Outbound clicks
  document.addEventListener('click',function(e){
    var a=e.target&&e.target.closest&&e.target.closest('a[href]');
    if(!a)return;
    fire('link-click',{href:a.getAttribute('href'),text:(a.textContent||'').trim().slice(0,80)});
  },{capture:true});
  // Scroll depth (25/50/75/100)
  var seen={};
  window.addEventListener('scroll',function(){
    var pct=Math.round((window.scrollY+window.innerHeight)/document.documentElement.scrollHeight*100);
    [25,50,75,100].forEach(function(t){if(pct>=t&&!seen[t]){seen[t]=true;fire('scroll-depth',{depth:t});}});
  },{passive:true});
  // Visibility
  document.addEventListener('visibilitychange',function(){fire('visibility-change',{visible:!document.hidden});});
})();</script>`

export async function collectFrontendInjections(db: DbClient): Promise<FrontendInjections> {
  const plugins = await listInstalledPlugins(db)
  const headTags: string[] = []
  const bodyTags: string[] = []
  const networkAllowedHostsSet = new Set<string>()

  let anyTracker = false
  for (const plugin of plugins) {
    if (!plugin.enabled || plugin.lifecycleStatus === 'error') continue
    const grants = new Set(plugin.grantedPermissions)
    if (grants.has('frontend.tracker')) anyTracker = true

    if (grants.has('frontend.scripts')
      && plugin.manifest.entrypoints?.frontend
      && plugin.manifest.assetBasePath
    ) {
      const url = `${plugin.manifest.assetBasePath.replace(/\/+$/g, '')}/${plugin.manifest.entrypoints.frontend.replace(/^\/+/g, '')}`
      bodyTags.push(`<script type="module" defer src="${escapeHtmlAttribute(url)}" data-plugin-id="${escapeHtmlAttribute(plugin.id)}"></script>`)
      // Frontend plugins declare external fetch targets through the same
      // `networkAllowedHosts` field as the server-side QuickJS bridge.
      // Each enabled frontend plugin contributes its hosts to the page's
      // CSP `connect-src` so visitor-side `fetch()` / `XMLHttpRequest` /
      // `import()` calls to those hosts aren't blocked.
      for (const host of plugin.manifest.networkAllowedHosts ?? []) {
        if (host) networkAllowedHostsSet.add(host)
      }
    }
  }

  if (anyTracker || bodyTags.length > 0) {
    // Always inject the runtime when any frontend plugin is active so the
    // plugin script can rely on `window.__pb`.
    bodyTags.unshift(TRACKER_RUNTIME)
  }

  return {
    headTags,
    bodyTags,
    networkAllowedHosts: [...networkAllowedHostsSet].sort(),
    mediaCspOrigins: await collectMediaAdapterCspOrigins(db),
  }
}

/**
 * Look up every per-role elected storage adapter and aggregate the CSP
 * origins they declared at registration time. Dedup by directive+origin
 * so multi-role elections of the same adapter don't repeat entries.
 *
 * Only ELECTED adapters contribute — an installed-but-inactive S3
 * plugin doesn't pollute the page CSP with `*.s3.amazonaws.com`.
 */
async function collectMediaAdapterCspOrigins(
  db: DbClient,
): Promise<FrontendInjections['mediaCspOrigins']> {
  const elections = await listElectedAdapters(db)
  const seen = new Set<string>()
  const out: Array<{ directive: 'img-src' | 'media-src' | 'connect-src'; origin: string }> = []
  for (const election of elections) {
    if (!election.adapterId) continue // local-disk has no remote origin
    const adapter = mediaStorageRegistry.resolveForRead(election.adapterId)
    if (!adapter || !adapter.cspOrigins) continue
    for (const entry of adapter.cspOrigins) {
      const key = `${entry.directive}|${entry.origin}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out
}

function escapeHtmlAttribute(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
