// Service worker: caches the launcher shell for offline use and generates
// a per-game web app manifest (manifest/<id>.webmanifest) from games.json so
// every game can be installed to the home screen on its own.
const CACHE = 'webgames-shell-v1';
const SHELL = [
  './', 'index.html', 'play.html', 'lib.js', 'games.json',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function gamesJson() {
  try {
    const r = await fetch('games.json', { cache: 'no-cache' });
    if (r.ok) {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put('games.json', copy));
      return r.json();
    }
  } catch {}
  const hit = await caches.match('games.json');
  return hit ? hit.json() : { games: [] };
}

async function gameManifest(id) {
  const { games = [] } = await gamesJson();
  const g = games.find(x => x.id === id);
  if (!g) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
  const base = self.registration.scope;
  const abs = p => new URL(p, base).href;
  const icon = g.icon || 'icons/icon-512.png';
  const icons = [
    { src: abs(icon), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: abs(g.maskableIcon || icon), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];
  const manifest = {
    id: abs('play.html?game=' + encodeURIComponent(id)),
    name: g.title || id,
    short_name: g.shortName || g.title || id,
    description: g.description || '',
    start_url: abs('play.html?game=' + encodeURIComponent(id)),
    scope: base,
    display: 'standalone',
    orientation: g.orientation || 'any',
    background_color: g.background || '#0e0f13',
    theme_color: g.theme || g.background || '#0e0f13',
    icons,
  };
  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/manifest+json' },
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch api.github.com

  const m = url.pathname.match(/\/manifest\/([^/]+)\.webmanifest$/);
  if (m) {
    e.respondWith(gameManifest(decodeURIComponent(m[1])));
    return;
  }

  // Stale-while-revalidate for everything else on our origin.
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
