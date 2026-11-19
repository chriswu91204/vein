// 把 SlowLeaf 的母株（kind==='mother'，不含側芽/實生苗）全部設為隱藏。IMG_PATHS=dry|apply（apply 先備份原本 hidden）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const MODE = (process.env.IMG_PATHS || 'dry').trim();
(async () => {
  const shops = await db.collection('shops').get(); const sl = shops.docs.filter(d => /slow\s*leaf/i.test(String(d.data().name || '')));
  if (sl.length !== 1) { console.log('ABORT 賣場不是剛好一間', sl.length); return; } const uid = sl[0].id;
  const L = []; const own = await db.collection('shops/' + uid + '/plants').get(); own.docs.forEach(d => L.push(d));
  const ow = await db.collection('owners').where('current', '==', uid).get();
  for (const o of ow.docs) { const x = o.data(); if (!x.shop || x.shop === uid) continue; const d = await db.doc('shops/' + x.shop + '/plants/' + o.id).get(); if (d.exists) L.push(d); }
  const kinds = {}; L.forEach(d => { const k = String(d.data().kind || '(無)'); kinds[k] = (kinds[k] || 0) + 1; });
  console.log('TOTAL', L.length, 'KINDS', JSON.stringify(kinds));
  const hits = L.filter(d => d.data().kind === 'mother'), todo = hits.filter(d => !d.data().hidden);
  console.log('MOTHERS', hits.length, 'ALREADY_HIDDEN', hits.length - todo.length, 'TO_HIDE', todo.length, 'SOLD_AMONG', todo.filter(d => d.data().status === 'sold').length);
  console.log('CODES', todo.map(d => d.data().code || d.id).join(', '));
  if (MODE !== 'apply' || !todo.length) { console.log('DRY_RUN'); return; }
  const bk = db.collection('backups').doc('hidemom_' + Date.now()); await bk.set({ at: Date.now(), shop: uid, items: todo.map(d => ({ path: d.ref.path, hidden: d.data().hidden ?? null })) });
  for (let i = 0; i < todo.length; i += 400) { const b = db.batch(); todo.slice(i, i + 400).forEach(d => b.update(d.ref, { hidden: true })); await b.commit(); }
  let ok = 0; for (const d of todo) if ((await d.ref.get()).data().hidden === true) ok++;
  console.log('APPLIED', todo.length, 'VERIFY_HIDDEN', ok, '/', todo.length, 'BACKUP', bk.path);
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
