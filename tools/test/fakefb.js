// 測試用：取代 /js/vein-firebase.js 的記憶體版資料庫（只在本機測試用，不會部署）
// 種子資料放在 window.__SEED = { me, admin, names:{uid:name}, docs:{ 'path/to/doc': {...} } }
const SEED = window.__SEED || {};
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const store = new Map(Object.entries(SEED.docs || {}).map(([k, v]) => [k, clone(v)]));
const writes = window.__fwrites = [];
const listeners = new Set();
let tick = 0; const emit = () => { if (tick) return; tick = setTimeout(() => { tick = 0; for (const l of [...listeners]) l.fire(); }, 0); };
const colOf = p => p.split('/').slice(0, -1).join('/');
const getF = (o, f) => f.split('.').reduce((a, k) => a == null ? undefined : a[k], o);
const cmp = (a, b) => a === b ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : 1;
function test(d, [f, op, v]) { const x = f === '__name__' ? undefined : getF(d, f);
  switch (op) { case '==': return JSON.stringify(x) === JSON.stringify(v); case '!=': return JSON.stringify(x) !== JSON.stringify(v); case '<': return x != null && x < v; case '<=': return x != null && x <= v; case '>': return x != null && x > v; case '>=': return x != null && x >= v;
    case 'in': return v.some(y => JSON.stringify(y) === JSON.stringify(x)); case 'not-in': return !v.some(y => JSON.stringify(y) === JSON.stringify(x)); case 'array-contains': return Array.isArray(x) && x.some(y => JSON.stringify(y) === JSON.stringify(v)); case 'array-contains-any': return Array.isArray(x) && x.some(y => v.includes(y)); }
  return true; }
const wDoc = (path) => { const d = store.get(path); return { id: path.split('/').pop(), exists: d !== undefined, data: () => clone(d), metadata: { hasPendingWrites: false, fromCache: false }, ref: D(path) }; };
function run(path, cons) { let L = [...store.keys()].filter(k => colOf(k) === path).map(k => [k, store.get(k)]);
  for (const c of cons) if (c[0] === 'where') L = L.filter(([, d]) => test(d, c.slice(1)));
  const ob = cons.filter(c => c[0] === 'orderBy'); if (ob.length) L.sort((a, b) => { for (const [, f, dir] of ob) { const r = cmp(getF(a[1], f), getF(b[1], f)); if (r) return dir === 'desc' ? -r : r; } return 0; });
  const lim = cons.find(c => c[0] === 'limit'); if (lim) L = L.slice(0, lim[1]);
  const docs = L.map(([k]) => wDoc(k)); return { docs, size: docs.length, empty: !docs.length, metadata: { hasPendingWrites: false, fromCache: false } }; }
function listen(fn, cb) { let last = null; const l = { fire() { const s = fn(); const sig = JSON.stringify(s.docs ? s.docs.map(d => [d.id, d.data()]) : [s.exists, s.data()]); if (sig === last) return; last = sig; try { cb(s); } catch (e) { console.error(e); } } };
  listeners.add(l); setTimeout(() => l.fire(), 0); return () => listeners.delete(l); }
const setPath = (o, k, v) => { const ks = k.split('.'); let t = o; ks.slice(0, -1).forEach(x => { if (typeof t[x] !== 'object' || t[x] == null) t[x] = {}; t = t[x]; }); if (v === undefined) delete t[ks.at(-1)]; else t[ks.at(-1)] = v; };
function write(op, path, d) { writes.push({ op, path, data: clone(d), at: Date.now() });
  if (window.__fdeny && window.__fdeny(op, path, d)) { const e = new Error('denied'); e.code = 'invalid_argument'; throw e; }
  if (op === 'set') store.set(path, clone(d)); else if (op === 'delete') store.delete(path);
  else if (op === 'update') { if (!store.has(path)) { const e = new Error('not-found'); e.code = 'not-found'; throw e; } const o = clone(store.get(path)); for (const [k, v] of Object.entries(clone(d))) setPath(o, k, v); store.set(path, o); }
  else if (op === 'inc') { const o = clone(store.get(path) || {}); for (const [k, v] of Object.entries(d)) o[k] = typeof v === 'number' && k !== 'at' ? (+o[k] || 0) + v : v; store.set(path, o); }
  emit(); }
function Q(path, cons = []) { return { path,
  orderBy: (f, dir = 'asc') => Q(path, [...cons, ['orderBy', f, dir]]), limit: n => Q(path, [...cons, ['limit', n]]), where: (f, op, v) => Q(path, [...cons, ['where', f, op, v]]), startAfter: () => Q(path, cons),
  doc: id => D(path + '/' + (id || Math.random().toString(36).slice(2, 12))), async get() { return run(path, cons); }, async count() { return run(path, cons).size; },
  onSnapshot(next) { return listen(() => run(path, cons), next); }, async add(d) { const r = this.doc(); await r.set(d); return r; } }; }
function D(path) { return { id: path.split('/').pop(), path, async get() { return wDoc(path); }, async set(d) { write('set', path, d); }, async update(d) { write('update', path, d); }, async inc(d) { write('inc', path, d); }, async delete() { write('delete', path); },
  onSnapshot(next) { return listen(() => wDoc(path), next); }, collection: c => Q(path + '/' + c) }; }
const db = { doc: D, collection: p => Q(p), newId: () => Math.random().toString(36).slice(2, 12), async resync() {},
  batch() { const ops = []; return { set(p, d) { ops.push(['set', p, d]); return this; }, update(p, d) { ops.push(['update', p, d]); return this; }, async commit() { ops.forEach(o => write(...o)); } }; } };
const me = SEED.me || null, names = SEED.names || {};
const user = me ? { async me() { return { id: me, name: names[me] || me, handle: null, priv: false, nameSet: true, avatarUrl: '', phoneVerified: true }; }, async id() { return me; }, async isOwner() { return !!SEED.admin; }, async canEdit() { return !!SEED.admin; }, async can() { return true; },
  async profiles(ids) { const o = {}; ids.forEach(id => o[id] = { id, name: names[id] || '', avatarUrl: '', phoneVerified: true, isMe: id === me }); return o; } } : null;
const assets = me ? { async upload() { return { url: '' }; } } : null;
window.__veinAuth = { phoneVerified: () => true, async signIn() {}, async signOut() {} };
window.__veinPush = { async supported() { return false; }, async enable() { return null; } };
window.__fdb = { store, get: p => clone(store.get(p)), set: (p, d) => write('set', p, d), update: (p, d) => write('update', p, d), del: p => write('delete', p), emit };
window.__veinResolve({ use: async n => n === 'db' ? db : n === 'user' ? user : n === 'assets' ? assets : null });
