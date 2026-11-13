// 展會工作人員入口自我測試：暫時建立一個展會（只讀測試，不改價、不拍照、不轉移），打 /xapi 各個動作，最後全部清掉
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const SHOP = process.env.IMG_PATHS || 'RuAWBHRwGfWaVyRxFXtEjyOFWAz2', ID = 'diagtest' + Date.now().toString(36), PW = 'DIAGPW99';
const api = async b => { const r = await fetch('https://vein-48ec8.web.app/xapi', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ e: ID, ...b }) }); let j = {}; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
(async () => {
  await db.doc('expos/' + ID).set({ shop: SHOP, name: '測試展會', pw: PW, on: true, until: Date.now() + 3600e3, at: Date.now() });
  let r = await api({ a: 'info' }); console.log('INFO', r.s, r.j.ok, r.j.name, r.j.shop ? 'shop-ok' : 'no-shop');
  r = await api({ a: 'login', pw: 'WRONG123' }); console.log('BADPW', r.s, r.j.err);
  r = await api({ a: 'login', pw: PW, by: 'diag' }); console.log('LOGIN', r.s, r.j.ok);
  r = await api({ a: 'list', pw: PW }); const L = r.j.plants || []; console.log('LIST', r.s, 'plants', L.length, 'grp', L.filter(p => p.grp).length, 'grpName', L.filter(p => p.grpName).length, 'mom', L.filter(p => p.mom).length, 'kinds', [...new Set(L.map(p => p.kind))].join('/'), 'listed', L.filter(p => p.listed).length, 'live', L.filter(p => p.live).length, 'withImg', L.filter(p => p.img).length);
  if (L[0]) { r = await api({ a: 'qr', pw: PW, pid: L[0].id }); console.log('QR', r.s, r.j.ok, /^ex[0-9a-f]{24}$/.test(r.j.tok || '') ? 'tok-ok' : 'tok-bad');
    const tok = r.j.tok; r = await api({ a: 'poll', pw: PW, pid: L[0].id, tok }); console.log('POLL', r.s, r.j.ok, 'req', r.j.req);
    r = await api({ a: 'price', pw: PW, pid: L[0].id, price: -5 }); console.log('PRICE-BAD', r.s, r.j.err);
    r = await api({ a: 'confirm', pw: PW, pid: L[0].id, tok, rid: 'nope' }); console.log('CONFIRM-NOREQ', r.s, r.j.err);
    if (tok) await db.doc('xqr/' + tok).delete(); }
  await db.doc('expos/' + ID).update({ on: false }); r = await api({ a: 'list', pw: PW }); console.log('CLOSED', r.s, r.j.err);
  const lg = await db.collection('expos/' + ID + '/log').get(); console.log('LOGS', lg.size); await Promise.all(lg.docs.map(d => d.ref.delete())); await db.doc('expos/' + ID).delete(); console.log('CLEANED');
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
