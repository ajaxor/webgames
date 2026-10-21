// Shared helpers for the launcher (index.html) and player (play.html).
// Games are fetched from GitHub with a user-supplied token, cached in IndexedDB.

const TOKEN_KEY = 'wg_token';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export async function loadGames() {
  const r = await fetch('games.json', { cache: 'no-cache' });
  if (!r.ok) throw new Error('Could not load games.json');
  const data = await r.json();
  return (data.games || []).map(g => ({ ref: '', path: 'index.html', ...g }));
}

/* ---------- IndexedDB cache ---------- */
function openDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('webgames', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('games', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction('games', mode);
    const rq = fn(t.objectStore('games'));
    t.oncomplete = () => { db.close(); res(rq && rq.result); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}
export const getRec = id => tx('readonly', s => s.get(id));
export const putRec = rec => tx('readwrite', s => s.put(rec));
export const delRec = id => tx('readwrite', s => s.delete(id));
export const clearRecs = () => tx('readwrite', s => s.clear());
export const allRecs = () => tx('readonly', s => s.getAll());

export function persistStorage() {
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}
}

/* ---------- GitHub sync ---------- */
export function apiUrl(g) {
  const path = g.path.split('/').map(encodeURIComponent).join('/');
  const ref = g.ref ? '?ref=' + encodeURIComponent(g.ref) : '';
  return `https://api.github.com/repos/${g.repo}/contents/${path}${ref}`;
}

/**
 * Download (or revalidate) a game's HTML.
 * Resolves { status: 'updated' | 'unchanged' | 'offline', rec }.
 * Uses ETag / If-None-Match so unchanged files cost one tiny request
 * (and 304s don't count against GitHub's rate limit).
 */
export async function syncGame(g, { force = false } = {}) {
  const rec = await getRec(g.id);
  const token = getToken();
  const headers = { Accept: 'application/vnd.github.raw+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (rec && rec.etag && !force) headers['If-None-Match'] = rec.etag;

  let r;
  try {
    r = await fetch(apiUrl(g), { headers, cache: 'no-store' });
  } catch (e) {
    if (rec) return { status: 'offline', rec };
    throw new Error('You appear to be offline and this game has not been downloaded yet.');
  }
  if (r.status === 304 && rec) return { status: 'unchanged', rec };
  if (!r.ok) {
    let msg;
    if (r.status === 401) msg = 'GitHub rejected the access token (expired or mistyped).';
    else if (r.status === 403) msg = 'GitHub refused the request (rate limit, or the token lacks access).';
    else if (r.status === 404) msg = token
      ? 'Not found. Check the repo/path in games.json and that the token can read that repo.'
      : 'Not found. Private repos need an access token.';
    else msg = 'GitHub returned HTTP ' + r.status + '.';
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  const html = await r.text();
  const next = { id: g.id, html, etag: r.headers.get('ETag') || '', fetchedAt: Date.now(), size: html.length };
  await putRec(next);
  persistStorage();
  return { status: 'updated', rec: next };
}

export function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

export function registerSW() {
  if ('serviceWorker' in navigator) {
    return navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* Make the current page installable as this game's own PWA (name, icon, manifest, colours). */
export function applyGameMeta(g) {
  document.title = g.title || g.id;
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.assign(el, attrs); document.head.appendChild(el); return el; };
  add('link', { rel: 'manifest', href: 'manifest/' + encodeURIComponent(g.id) + '.webmanifest' });
  const icon = g.icon || 'icons/icon-512.png';
  add('link', { rel: 'icon', href: icon });
  add('link', { rel: 'apple-touch-icon', href: icon });
  const t = add('meta', {}); t.name = 'apple-mobile-web-app-title'; t.content = g.shortName || g.title || g.id;
  const c = document.querySelector('meta[name=theme-color]'); if (c) c.content = g.theme || g.background || '#0e0f13';
  document.body.style.background = g.background || '#0e0f13';
}

export const isStandalone = () =>
  (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
