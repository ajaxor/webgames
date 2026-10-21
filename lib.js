// Shared helpers for the launcher pages (index.html, install.html, play.html).
//
// A game lives in a GitHub repo. We read its file tree with the GitHub API (using a token the user
// pastes in), download the files that changed into the Cache API (one cache per game), and the service
// worker (sw.js) serves them back at  g/<id>/<path>  so multi-file games (ES modules, JSON, fonts...) just work.

const TOKEN_KEY = 'wg_token';
const API = 'https://api.github.com/repos/';
const META_PATH = '__wg/meta.json';
const DEFAULT_EXCLUDE = ['.git', '.github/', 'node_modules/'];

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

/* ---------- games.json ---------- */
export async function loadGames() {
  const r = await fetch('games.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('Could not load games.json');
  const data = await r.json();
  return (data.games || []).map(g => {
    const entry = g.entry || g.path || 'index.html'; // `path` = old single-file spelling
    return { ref: 'HEAD', ...g, entry, include: g.include || (g.path ? [g.path] : null) };
  });
}

/* ---------- where a game's files live ---------- */
export const cacheName = id => 'wg-game-' + id;
const stageName = id => 'wg-stage-' + id;
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const root = () => new URL('./', location.href).href;
export const fileKey = (id, path) => new URL('g/' + encodeURIComponent(id) + '/' + encPath(path), root()).href;
export const gameStartUrl = g => 'g/' + encodeURIComponent(g.id) + '/' + encPath(g.entry);

export async function getMeta(id) {
  try {
    const c = await caches.open(cacheName(id));
    const r = await c.match(fileKey(id, META_PATH));
    return r ? await r.json() : null;
  } catch { return null; }
}
export const removeGame = async id => { await caches.delete(cacheName(id)); await caches.delete(stageName(id)); };
export async function clearAll() {
  for (const k of await caches.keys()) if (k.startsWith('wg-game-') || k.startsWith('wg-stage-')) await caches.delete(k);
}
export function persistStorage() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
}

const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', webmanifest: 'application/manifest+json', txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm', glb: 'model/gltf-binary', map: 'application/json',
};
const mimeOf = p => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

/* ---------- GitHub sync ---------- */
function ghHeaders(accept, extra) {
  const h = { Accept: accept, ...extra };
  const t = getToken();
  if (t) h.Authorization = 'Bearer ' + t;
  return h;
}
function httpError(status, res) {
  const token = !!getToken();
  let msg;
  if (status === 401) msg = 'GitHub rejected the access token (expired or mistyped).';
  else if (status === 403 || status === 429) {
    const reset = res && +res.headers.get('x-ratelimit-reset');
    if (res && res.headers.get('x-ratelimit-remaining') === '0' && reset) {
      msg = 'GitHub rate limit reached' + (token ? '' : ' (without a token GitHub allows only 60 requests an hour; a token raises that to 5,000)') +
        '. It resets at ' + new Date(reset * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.';
    } else msg = 'GitHub refused the request (rate limit, or the token lacks access).';
  } else if (status === 404) msg = token
    ? 'Not found. Check the repo in games.json and that the token can read that repo.'
    : 'Not found. Private repos need an access token.';
  else msg = 'GitHub returned HTTP ' + status + '.';
  const e = new Error(msg); e.status = status; return e;
}

const matches = (path, list) => list.some(p => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));

async function pool(items, n, fn) {
  let i = 0, stop = false;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !stop) {
      const k = i++;
      try { await fn(items[k], k); } catch (e) { stop = true; throw e; }
    }
  }));
}

async function fetchBlob(repo, sha) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${API}${repo}/git/blobs/${sha}`, { headers: ghHeaders('application/vnd.github.raw+json'), cache: 'no-store' });
      if (!r.ok) throw httpError(r.status, r);
      return await r.arrayBuffer();
    } catch (e) {
      if (e.status) throw e; // a real HTTP answer: don't retry
      last = e;
    }
  }
  throw new Error('Network error while downloading (' + (last && last.message) + ').');
}

/**
 * Bring a game's cached files up to date with its repo.
 * Resolves { status: 'updated' | 'unchanged' | 'offline', meta }.
 *  - onProgress(done, total)  while files download
 *  - checkTimeoutMs           give up on the "has anything changed?" request after this long (treated as offline)
 * The "has anything changed?" request is conditional (ETag), so an unchanged game costs one tiny request.
 * New files are downloaded fully before the cache is touched, so a failed update leaves the old version intact.
 */
export async function syncGame(g, { force = false, onProgress, checkTimeoutMs } = {}) {
  const meta = await getMeta(g.id);
  const headers = ghHeaders('application/vnd.github+json');
  if (meta && meta.etag && !force) headers['If-None-Match'] = meta.etag;

  let r;
  try {
    const signal = checkTimeoutMs && typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(checkTimeoutMs) : undefined;
    r = await fetch(`${API}${g.repo}/git/trees/${encodeURIComponent(g.ref || 'HEAD')}?recursive=1`, { headers, cache: 'no-store', signal });
  } catch {
    if (meta) return { status: 'offline', meta };
    throw new Error('You appear to be offline and this game has not been downloaded yet.');
  }
  if (r.status === 304 && meta) return { status: 'unchanged', meta };
  if (!r.ok) throw httpError(r.status, r);

  const etag = r.headers.get('ETag') || '';
  const data = await r.json();
  if (data.truncated) throw new Error('That repo is too large to list. Narrow it with "include" in games.json.');

  const include = g.include && g.include.length ? g.include : null;
  const exclude = DEFAULT_EXCLUDE.concat(g.exclude || []);
  const want = {};
  let bytes = 0;
  for (const e of data.tree) {
    if (e.type !== 'blob') continue;
    if (include && !matches(e.path, include)) continue;
    if (matches(e.path, exclude)) continue;
    want[e.path] = e.sha; bytes += e.size || 0;
  }
  if (!want[g.entry]) throw new Error(`"${g.entry}" was not found in ${g.repo} (check "entry" / "include" in games.json).`);

  const have = (meta && meta.files) || {};
  const toFetch = Object.keys(want).filter(p => force || have[p] !== want[p]);
  const toDelete = Object.keys(have).filter(p => !(p in want));

  const cache = await caches.open(cacheName(g.id));
  const next = { id: g.id, etag, files: want, count: Object.keys(want).length, bytes, entry: g.entry, fetchedAt: Date.now() };
  const putMeta = () => cache.put(fileKey(g.id, META_PATH), new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } }));

  if (!toFetch.length && !toDelete.length) { // commit changed, but nothing this game uses
    await putMeta();
    return { status: 'unchanged', meta: next };
  }

  // Downloads are staged by git SHA first, so a failed or rate-limited attempt resumes where it stopped
  // and the game's live files are only touched once everything has arrived.
  const stage = await caches.open(stageName(g.id));
  const skey = sha => new URL('stage/' + sha, root()).href;
  const missing = [];
  for (const p of toFetch) if (!(await stage.match(skey(want[p])))) missing.push(p);

  if (!getToken() && missing.length > 40) {
    const e = new Error(`This game needs ${missing.length} downloads, but without an access token GitHub allows only 60 requests an hour. Add a token to continue.`);
    e.status = 401;
    throw e;
  }

  let done = toFetch.length - missing.length;
  let failed = false; // downloads still in flight when one fails must not redraw progress over the error
  if (onProgress) onProgress(done, toFetch.length);
  try {
    await pool(missing, 8, async path => {
      const sha = want[path];
      await stage.put(skey(sha), new Response(await fetchBlob(g.repo, sha)));
      done++;
      if (onProgress && !failed) onProgress(done, toFetch.length);
    });
  } catch (e) { failed = true; throw e; }

  for (const path of toFetch) {
    const buf = await (await stage.match(skey(want[path]))).arrayBuffer();
    await cache.put(fileKey(g.id, path), new Response(buf, { headers: { 'Content-Type': mimeOf(path) } }));
  }
  for (const path of toDelete) await cache.delete(fileKey(g.id, path));
  await putMeta();
  await caches.delete(stageName(g.id));
  persistStorage();
  return { status: 'updated', meta: next };
}

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
export const fmtBytes = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';

/* ---------- service worker ---------- */
export function registerSW() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
}

/* Make the current page installable as this game's own PWA (name, icon, manifest, colours). */
export function applyGameMeta(g) {
  document.title = g.title || g.id;
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.assign(el, attrs); document.head.appendChild(el); return el; };
  add('link', { rel: 'manifest', href: 'manifest/' + encodeURIComponent(g.id) + '.webmanifest' });
  const icon = g.icon || 'icons/icon-512.png';
  add('link', { rel: 'icon', href: icon });
  add('link', { rel: 'apple-touch-icon', href: g.appleIcon || icon });
  const t = add('meta', {}); t.name = 'apple-mobile-web-app-title'; t.content = g.shortName || g.title || g.id;
  const c = document.querySelector('meta[name=theme-color]'); if (c) c.content = g.theme || g.background || '#0e0f13';
  document.body.style.background = g.background || '#0e0f13';
}
