// 展會工作人員：賣場主人在後台產生「網址＋密碼」，工作人員不用登入（也不會用到他自己的帳號）
// 就能看到這個賣場的植物，只能做三件事：面對面轉移、改價格上架直購、拍照加進履歷。
// 所有動作都經過這支函式（伺服器權限），每次都核對密碼與期限，並記錄在 expos/{id}/log。
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const crypto = require('crypto');
const db = () => admin.firestore();
const p2 = n => String(n).padStart(2, '0');
const twLocal = ms => { const d = new Date(ms + 8 * 3600e3); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + 'T' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()); };
const XR_MS = 5 * 60e3;
const bad = (res, code, msg) => res.status(code).json({ ok: false, err: msg });
const same = (a, b) => { const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || '')); return A.length === B.length && crypto.timingSafeEqual(A, B); };
const pName = p => ((String(p.species || '').replace(/^Anthurium\s+/i, '') + (p.cultivar ? ' ' + p.cultivar : '')).trim() || p.code || '');
const fails = new Map(); // 同一個展會短時間內密碼錯太多次就先擋一下

async function gate(b) {
  const id = String(b.e || ''); if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return { err: [404, '找不到這個展會'] };
  const f = fails.get(id) || { n: 0, t: 0 }; if (f.n >= 8 && Date.now() - f.t < 10 * 60e3) return { err: [429, '密碼錯太多次，請 10 分鐘後再試'] };
  const d = await db().doc('expos/' + id).get(); if (!d.exists) return { err: [404, '找不到這個展會'] };
  const x = d.data(); if (!x.on) return { err: [403, '這個展會已經關閉'] };
  if (x.until && x.until < Date.now()) return { err: [403, '這個展會的期限已經過了'] };
  if (b.a !== 'info' && !same(b.pw, x.pw)) { fails.set(id, { n: f.n + 1, t: Date.now() }); await new Promise(r => setTimeout(r, 600)); return { err: [401, '密碼不對'] }; }
  if (b.a !== 'info') fails.delete(id);
  return { id, x, ref: d.ref };
}
async function shopName(uid) { try { const s = await db().doc('shops/' + uid).get(); return (s.exists && s.data().name) || 'VEIN 賣場'; } catch (e) { return 'VEIN 賣場'; } }
async function who(uid) { try { const p = await db().doc('profiles/' + uid).get(); if (p.exists && p.data().name) return p.data().name; } catch (e) {} try { const s = await db().doc('shops/' + uid).get(); if (s.exists && s.data().name) return s.data().name; } catch (e) {} return '會員'; }
// 這株現在是不是還在賣場手上（沒轉給別人、沒賣掉）
async function heldPlant(shop, pid) {
  const [d, o] = await Promise.all([db().doc('shops/' + shop + '/plants/' + pid).get(), db().doc('owners/' + pid).get()]);
  if (!d.exists) return { err: '找不到這株' }; const p = { id: pid, ...d.data() };
  const cur = o.exists ? o.data().current : shop; if (cur !== shop) return { err: '這株已經轉給別人了' };
  if (p.blocked) return { err: '這株被管理員下架，不能操作' };
  return { p, own: o.exists ? o.data() : null };
}
const log = (ref, a, o) => ref.collection('log').add({ a, at: Date.now(), ...o }).catch(() => {});

async function list(shop) {
  const snap = await db().collection('shops/' + shop + '/plants').get();
  const P = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => !p.blocked && p.status !== 'sold');
  const refs = P.map(p => db().doc('owners/' + p.id)), cur = new Map();
  for (let i = 0; i < refs.length; i += 200) { const S = await db().getAll(...refs.slice(i, i + 200)); S.forEach(s => { if (s.exists) cur.set(s.id, s.data().current); }); }
  const now = Date.now();
  return P.filter(p => (cur.get(p.id) || shop) === shop).map(p => ({
    id: p.id, code: p.code || '', name: pName(p), kind: p.kind || 'mother', img: p.coverThumb || p.thumb || ((p.media || []).find(m => m.type !== 'video') || {}).url || '',
    price: p.price ?? null, mode: p.mode || 'fixed', listed: p.listed !== false, hidden: !!p.hidden, priv: !!p.private,
    live: (p.mode === 'auction' && (+p.endsAtMs || 0) > now) || (p.mode === 'encounter' && p.listed !== false), n: +p.photoCount || 0, grp: p.grp || '', batch: p.batch || '', at: +p.listedAt || 0
  })).sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
}

async function putImg(shop, b64) {
  const buf = Buffer.from(String(b64 || '').replace(/^data:image\/\w+;base64,/, ''), 'base64');
  if (buf.length < 500 || buf.length > 6 * 1024 * 1024) throw new Error('size');
  const tok = crypto.randomUUID(), path = 'uploads/' + shop + '/expo-' + crypto.randomUUID() + '.jpg', bk = admin.storage().bucket();
  await bk.file(path).save(buf, { contentType: 'image/jpeg', resumable: false, metadata: { cacheControl: 'public,max-age=31536000,immutable', metadata: { firebaseStorageDownloadTokens: tok } } });
  return 'https://firebasestorage.googleapis.com/v0/b/' + bk.name + '/o/' + encodeURIComponent(path) + '?alt=media&token=' + tok;
}

module.exports = onRequest({ memory: '512MiB', timeoutSeconds: 60, cors: true, invoker: 'public', maxInstances: 5 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'POST') return bad(res, 405, 'POST only');
  const b = req.body || {}; let g;
  try { g = await gate(b); } catch (e) { logger.warn('expo gate', e.message); return bad(res, 500, '系統忙碌，請再試一次'); }
  if (g.err) return bad(res, g.err[0], g.err[1]);
  const { x, ref } = g, shop = x.shop, by = String(b.by || '').slice(0, 20);
  try {
    if (b.a === 'info') return res.json({ ok: true, name: x.name || '展會', shop: await shopName(shop), until: x.until || 0 });
    if (b.a === 'login') { log(ref, 'login', { by }); return res.json({ ok: true, name: x.name || '展會', shop: await shopName(shop), until: x.until || 0 }); }
    if (b.a === 'list') return res.json({ ok: true, plants: await list(shop) });

    const pid = String(b.pid || ''); if (!/^[A-Za-z0-9_-]{4,60}$/.test(pid)) return bad(res, 400, '缺少植物');
    const H = await heldPlant(shop, pid); if (H.err) return bad(res, 409, H.err); const p = H.p, pref = db().doc('shops/' + shop + '/plants/' + pid);

    if (b.a === 'price') { // 只能上架「直購」；競標、遭遇戰進行中的不能改
      const price = Math.round(Number(b.price)); if (!(price > 0 && price <= 10000000)) return bad(res, 400, '價格要是 1 以上的數字');
      if ((p.mode === 'auction' && (+p.endsAtMs || 0) > Date.now()) || (p.mode === 'encounter' && p.listed !== false && p.status !== 'sold')) return bad(res, 409, '這株正在競標／遭遇戰，不能改價');
      const upd = { price, mode: 'fixed', listed: true, status: 'available', hidden: false, listedAt: Date.now(), updatedAt: Date.now() }; if (!p.firstListedAt) upd.firstListedAt = Date.now();
      await pref.update(upd); log(ref, 'price', { by, pid, code: p.code || '', from: p.price ?? null, to: price });
      return res.json({ ok: true });
    }
    if (b.a === 'photo') { // 拍照：加一筆成長紀錄（大圖＋縮圖）
      const full = await putImg(shop, b.full), thumb = b.thumb ? await putImg(shop, b.thumb) : full, now = twLocal(Date.now());
      await pref.collection('photos').doc().set({ full: { asset: full }, thumb, poster: null, takenAt: now, takenSource: 'expo', stage: '展會現場', title: '展會現場', note: x.name || '', registeredAt: now });
      const media = [{ type: 'image', url: thumb }, ...(p.media || [])].slice(0, 12), upd = { photoCount: (+p.photoCount || 0) + 1, media, thumb, lastPhotoAt: now, lastStage: '展會現場' }; if (!p.coverThumb) upd.coverThumb = p.thumb || thumb;
      await pref.update(upd); log(ref, 'photo', { by, pid, code: p.code || '' });
      return res.json({ ok: true, thumb });
    }
    if (b.a === 'qr') { // 面對面轉移：產生 QR（代碼以 ex 開頭，賣場主人自己的手機不會跳確認視窗）
      const tok = 'ex' + crypto.randomBytes(12).toString('hex'), exp = Date.now() + XR_MS;
      await db().doc('xqr/' + tok).set({ pid, shop, owner: shop, exp, at: Date.now(), expo: g.id });
      return res.json({ ok: true, tok, exp });
    }
    if (b.a === 'poll' || b.a === 'confirm' || b.a === 'reject') {
      const tok = String(b.tok || ''); if (!/^ex[0-9a-f]{24}$/.test(tok)) return bad(res, 400, '代碼不對');
      const q = await db().doc('xqr/' + tok).get(); if (!q.exists || q.data().expo !== g.id || q.data().pid !== pid) return bad(res, 404, 'QR 已失效，請重新產生');
      const R = await db().collection('xreq').where('tok', '==', tok).get(), now = Date.now();
      const open = R.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() })).filter(r => r.status === 'open' && r.exp > now && r.pid === pid && r.owner === shop).sort((a, c) => c.at - a.at)[0];
      if (b.a === 'poll') return res.json({ ok: true, req: open ? { id: open.id, name: await who(open.from), exp: open.exp } : null, qrExp: q.data().exp });
      if (!open || open.id !== String(b.rid || '')) return bad(res, 409, '這個請求已經過期或被取消');
      if (b.a === 'reject') { await open.ref.update({ status: 'rejected' }); log(ref, 'reject', { by, pid, code: p.code || '' }); return res.json({ ok: true }); }
      // 確認：照網站的規則把所有權轉給對方（記在 owners/{pid} 的履歷裡）
      await db().runTransaction(async t => {
        const o = await t.get(db().doc('owners/' + pid)); const cur = o.exists ? o.data().current : shop; if (cur !== shop) throw new Error('moved');
        const L = [...((o.exists && o.data().log) || []), { from: shop, to: open.from, at: Date.now(), via: 'f2f', note: '展會：' + (x.name || '') + (by ? '（' + by + '）' : ''), ref: null }];
        t.set(db().doc('owners/' + pid), { shop, pid, code: p.code || '', current: open.from, log: L });
        t.update(open.ref, { status: 'done', doneAt: Date.now() });
      });
      db().doc('xqr/' + tok).delete().catch(() => {});
      log(ref, 'xfer', { by, pid, code: p.code || '', to: open.from, toName: await who(open.from) });
      return res.json({ ok: true });
    }
    return bad(res, 400, '不支援的動作');
  } catch (e) { logger.warn('expo', b.a, e.message); return bad(res, 500, e.message === 'moved' ? '這株已經轉給別人了' : e.message === 'size' ? '照片太大或讀不到' : '失敗了，請再試一次'); }
});
