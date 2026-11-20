// SlowLeaf 名下（目前所有者是 SlowLeaf）的母株全部設為溫室隱藏 ghHide:true。IMG_PATHS=dry|apply
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const MODE = (process.env.IMG_PATHS || 'dry').trim();
(async () => {
  const shops = await db.collection('shops').get(); const sl = shops.docs.filter(d => /slow\s*leaf/i.test(String(d.data().name || '')));
  if (sl.length !== 1) { console.log('ABORT', sl.length); return; } const uid = sl[0].id;
  const L = []; (await db.collection('shops/' + uid + '/plants').get()).docs.forEach(d => L.push(d));
  const ow = await db.collection('owners').where('current', '==', uid).get(); const owned = new Set(ow.docs.map(d => d.id));
  for (const o of ow.docs) { const x = o.data(); if (!x.shop || x.shop === uid) continue; const d = await db.doc('shops/' + x.shop + '/plants/' + o.id).get(); if (d.exists) L.push(d); }
  const own = async d => { if (owned.has(d.id)) return true; const o = await db.doc('owners/' + d.id).get(); return !o.exists || !o.data().current || o.data().current === uid; };
  const mom = L.filter(d => d.data().kind === 'mother'); const mine = []; for (const d of mom) if (await own(d)) mine.push(d);
  const todo = mine.filter(d => d.data().ghHide !== true);
  console.log('MOTHERS', mom.length, 'OWNED_BY_SLOWLEAF', mine.length, 'SOLD_AWAY', mom.length - mine.length, 'ALREADY', mine.length - todo.length, 'TO_GHHIDE', todo.length);
  if (MODE !== 'apply' || !todo.length) { console.log('DRY_RUN'); return; }
  const bk = db.collection('backups').doc('ghhidemom_' + Date.now()); await bk.set({ at: Date.now(), shop: uid, items: todo.map(d => ({ path: d.ref.path, ghHide: d.data().ghHide ?? null })) });
  for (let i = 0; i < todo.length; i += 400) { const b = db.batch(); todo.slice(i, i + 400).forEach(d => b.update(d.ref, { ghHide: true })); await b.commit(); }
  let ok = 0; for (const d of todo) if ((await d.ref.get()).data().ghHide === true) ok++;
  const allHid = (await Promise.all(mom.map(d => d.ref.get()))).filter(x => x.data().hidden === true).length;
  console.log('APPLIED', todo.length, 'VERIFY_GHHIDE', ok, '/', todo.length, 'STORE_HIDDEN_ALL', allHid, '/', mom.length, 'BACKUP', bk.path);
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
