// SlowLeaf 在販售的母株全部下架（listed:false），排除正在競標（mode=auction 未結束）與報名在未結束拍賣會（lives/*/lots）的。IMG_PATHS=dry|apply
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const MODE = (process.env.IMG_PATHS || 'dry').trim(), now = Date.now();
const ms = v => v == null ? 0 : typeof v === 'number' ? v : v.toMillis ? v.toMillis() : +new Date(v) || 0;
(async () => {
  const shops = await db.collection('shops').get(); const sl = shops.docs.filter(d => /slow\s*leaf/i.test(String(d.data().name || '')));
  if (sl.length !== 1) { console.log('ABORT', sl.length); return; } const uid = sl[0].id;
  const L = []; (await db.collection('shops/' + uid + '/plants').get()).docs.forEach(d => L.push(d));
  const ow = await db.collection('owners').where('current', '==', uid).get();
  for (const o of ow.docs) { const x = o.data(); if (!x.shop || x.shop === uid) continue; const d = await db.doc('shops/' + x.shop + '/plants/' + o.id).get(); if (d.exists) L.push(d); }
  // 拍賣會：未結束場次裡的 lots
  const inEv = new Map(), lotSt = {}; const lv = await db.collection('lives').get();
  for (const e of lv.docs) { const E = e.data(); if (E.phase === 'done') continue;
    const lots = await e.ref.collection('lots').get(); lots.docs.forEach(l => { const x = l.data(); lotSt[x.status] = (lotSt[x.status] || 0) + 1; if (x.pid) inEv.set(x.pid, (E.title || e.id) + ':' + x.status); }); }
  console.log('LIVES_OPEN', lv.docs.filter(d => d.data().phase !== 'done').length, 'LOT_STATUS', JSON.stringify(lotSt));
  const mom = L.filter(d => d.data().kind === 'mother'), sell = mom.filter(d => { const p = d.data(); return p.listed !== false && p.status !== 'sold'; });
  const auc = [], ev = [], todo = [];
  for (const d of sell) { const p = d.data(); if (p.mode === 'auction' && (!ms(p.endsAt || p.endsAtMs) || ms(p.endsAt || p.endsAtMs) > now || p.endsAtMs > now)) auc.push(d); else if (inEv.has(d.id)) ev.push(d); else todo.push(d); }
  const c = d => d.data().code || d.id;
  console.log('MOTHERS', mom.length, 'ON_SALE', sell.length, 'SKIP_AUCTION', auc.length, auc.map(c).join(','), 'SKIP_EVENT', ev.length, ev.map(d => c(d) + '[' + inEv.get(d.id) + ']').join(','), 'TO_UNLIST', todo.length);
  console.log('CODES', todo.map(c).join(', '));
  if (MODE !== 'apply' || !todo.length) { console.log('DRY_RUN'); return; }
  const bk = db.collection('backups').doc('unlistmom_' + now); await bk.set({ at: now, shop: uid, items: todo.map(d => ({ path: d.ref.path, listed: d.data().listed ?? null })) });
  for (let i = 0; i < todo.length; i += 400) { const b = db.batch(); todo.slice(i, i + 400).forEach(d => b.update(d.ref, { listed: false })); await b.commit(); }
  let ok = 0; for (const d of todo) if ((await d.ref.get()).data().listed === false) ok++;
  console.log('APPLIED', todo.length, 'VERIFY_UNLISTED', ok, '/', todo.length, 'BACKUP', bk.path);
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
