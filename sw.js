// Service worker for the launcher.
//  1. Caches the launcher shell so it opens offline.
//  2. Serves each downloaded game's files at  g/<id>/<path>  from the Cache API (filled by lib.js syncGame),
//     injecting a per-game localStorage namespace and the game's own PWA manifest/icon into its HTML.
//  3. Generates manifest/<id>.webmanifest from games.json, so every game installs as its own app.
const CACHE = 'webgames-shell-v7';
const SHELL = [
  './', 'index.html', 'install.html', 'play.html', 'lib.js', 'games.json',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const SCOPE = self.registration.scope;
const META_PATH = '__wg/meta.json';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('webgames-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const fileKey = (id, path) => new URL('g/' + encodeURIComponent(id) + '/' + encPath(path), SCOPE).href;
const abs = p => new URL(p, SCOPE).href;

async function gamesJson() {
  try {
    const r = await fetch('games.json', { cache: 'no-cache' });
    if (r.ok) {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(abs('games.json'), copy));
      return r.json();
    }
  } catch {}
  const hit = await caches.match(abs('games.json'));
  return hit ? hit.json() : { games: [] };
}
const findGame = async id => ((await gamesJson()).games || []).find(g => g.id === id);

/* ---- per-game manifest ---- */
async function gameManifest(id, k) {
  const g = await findGame(id);
  if (!g) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  const icon = g.icon || 'icons/icon-512.png';
  const start = abs('play.html?game=' + encodeURIComponent(id));
  // k = an access token to hand to the installed app on its first launch (see play.html); not part of the app's identity.
  const startUrl = k ? start + '&k=' + encodeURIComponent(k) : start;
  return new Response(JSON.stringify({
    id: start,
    name: g.title || id,
    short_name: g.shortName || g.title || id,
    description: g.description || '',
    start_url: startUrl,
    scope: SCOPE,
    display: 'standalone',
    orientation: g.orientation || 'any',
    background_color: g.background || '#0e0f13',
    theme_color: g.theme || g.background || '#0e0f13',
    categories: ['games'],
    icons: [
      { src: abs(icon), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: abs(g.maskableIcon || icon), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }), { headers: { 'Content-Type': 'application/manifest+json' } });
}

/* ---- HTML rewriting for game pages ---- */
// Each game gets its own localStorage namespace (wg:<id>:) so games sharing this origin can't trample each other's saves.
function storageShim(id) {
  return '<script>(function(){try{var P=' + JSON.stringify('wg:' + id + ':') + ',real=window.localStorage;' +
    'function mk(){var api={getItem:function(k){return real.getItem(P+k)},setItem:function(k,v){real.setItem(P+k,String(v))},' +
    'removeItem:function(k){real.removeItem(P+k)},clear:function(){for(var i=real.length-1;i>=0;i--){var k=real.key(i);if(k&&k.indexOf(P)===0)real.removeItem(k)}},' +
    'key:function(n){var a=[];for(var i=0;i<real.length;i++){var k=real.key(i);if(k&&k.indexOf(P)===0)a.push(k.slice(P.length))}return a[n]===undefined?null:a[n]}};' +
    'return new Proxy(api,{get:function(t,p){if(p==="length"){var n=0;for(var i=0;i<real.length;i++){var k=real.key(i);if(k&&k.indexOf(P)===0)n++}return n}' +
    'if(p in t)return t[p];if(typeof p==="string")return t.getItem(p)===null?undefined:t.getItem(p)},' +
    'set:function(t,p,v){t.setItem(p,v);return true},deleteProperty:function(t,p){t.removeItem(p);return true},' +
    'has:function(t,p){return p in t||t.getItem(p)!==null},' +
    'ownKeys:function(t){var a=[],n=t.length;for(var i=0;i<n;i++)a.push(t.key(i));return a},' +
    'getOwnPropertyDescriptor:function(t,p){if(typeof p==="string"&&t.getItem(p)!==null)return{value:t.getItem(p),writable:true,enumerable:true,configurable:true}}})}' +
    'var s=mk();Object.defineProperty(window,"localStorage",{configurable:true,get:function(){return s}})}catch(e){}})();</' + 'script>';
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function pwaTags(g) {
  const icon = abs(g.appleIcon || g.icon || 'icons/icon-512.png');
  return '<link rel="manifest" href="' + abs('manifest/' + encodeURIComponent(g.id) + '.webmanifest') + '">' +
    '<link rel="apple-touch-icon" href="' + icon + '">' +
    '<meta name="apple-mobile-web-app-title" content="' + esc(g.shortName || g.title || g.id) + '">' +
    // Opaque status bar: iOS then lays the page out below it. With black-translucent it sizes the page as if it started below the bar
    // but draws it underneath, which leaves a dead strip at the bottom of the screen and misplaced HUDs.
    '<meta name="apple-mobile-web-app-status-bar-style" content="' + esc(g.statusBar || 'black') + '">';
}

function rewriteHtml(html, id, game, isEntry) {
  if (game && isEntry) {
    // Our manifest/icon/title replace the game's own, so the installed app always matches games.json.
    html = html
      .replace(/<link\b[^>]*\brel=["']?(?:manifest|apple-touch-icon(?:-precomposed)?)["']?[^>]*>/gi, '')
      .replace(/<meta\b[^>]*\bname=["']apple-mobile-web-app-(?:title|status-bar-style)["'][^>]*>/gi, '');
  }
  const inject = storageShim(id) + (game && isEntry ? pwaTags(game) : '');
  let m;
  if ((m = /<head[^>]*>/i.exec(html)) || (m = /<html[^>]*>/i.exec(html)) || (m = /<!doctype[^>]*>/i.exec(html))) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + inject + html.slice(at);
  }
  return inject + html;
}

async function serveGame(id, rawPath) {
  const cache = await caches.open('wg-game-' + id);
  let path;
  try { path = decodeURIComponent(rawPath); } catch { path = rawPath; }
  let entry = null;
  const metaHit = await cache.match(fileKey(id, META_PATH));
  if (metaHit) entry = (await metaHit.json()).entry;
  if (path === '' ) path = entry || 'index.html';
  else if (path.endsWith('/')) path += 'index.html';
  if (path.startsWith('__wg/')) return new Response('Not found', { status: 404 });

  const hit = await cache.match(fileKey(id, path));
  if (!hit) return new Response('Not found in the downloaded game files: ' + path, { status: 404, headers: { 'Content-Type': 'text/plain' } });

  const type = hit.headers.get('Content-Type') || '';
  if (!type.startsWith('text/html')) return hit;
  const game = await findGame(id);
  const html = rewriteHtml(await hit.text(), id, game, path === entry);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

/* ---- routing ---- */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch api.github.com
  if (!url.href.startsWith(SCOPE)) return;
  const rel = url.pathname.slice(new URL(SCOPE).pathname.length);

  let m = /^manifest\/([^/]+)\.webmanifest$/.exec(rel);
  if (m) { e.respondWith(gameManifest(decodeURIComponent(m[1]), url.searchParams.get('k'))); return; }

  m = /^g\/([^/]+)\/(.*)$/.exec(rel);
  if (m) { e.respondWith(serveGame(decodeURIComponent(m[1]), m[2])); return; }

  // Stale-while-revalidate for the launcher shell.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then(r => {
      if (r.ok) cache.put(req, r.clone());
      return r;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    const r = await net;
    return r || new Response('Offline', { status: 503 });
  })());
});
