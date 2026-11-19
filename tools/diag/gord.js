// 轉蛋訂單狀態統計（不輸出個資：只有狀態、張數、金額、時間）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
(async () => {
  const gs = await db.collection('gacha').get(); const G = new Map(gs.docs.map(d => [d.id, d.data()]));
  for (const [id, g] of G) console.log('MACHINE', id.slice(0, 6), g.status, 'price', g.price, 'total', g.total, 'sold', g.sold, 'opened', g.opened);
  const os = await db.collectionGroup('orders').where('src', 'in', ['gacha', 'gship']).get();
  for (const d of os.docs) { const o = d.data(), r = await db.doc('gRes/' + d.ref.parent.parent.id + '_' + d.id).get(), dl = await db.doc('deals/' + d.ref.parent.parent.id + '_' + d.id).get();
    console.log('ORDER', o.src, d.id.slice(-6), 'st', o.status, 'n', (o.gacha || {}).n, 'total', o.total, 'granted', !!o.granted, 'later', !!o.later, 'res', r.exists ? r.data().st : '-', 'paid', !!(dl.exists && dl.data().pay), 'age_h', Math.round((Date.now() - (o.at || 0)) / 36e5), 'upd_h', Math.round((Date.now() - (o.updatedAt || 0)) / 36e5)); }
  const nulls = await db.collectionGroup('orders').where('src', '==', null).get().catch(() => ({ docs: [] }));
  for (const d of nulls.docs) { const o = d.data(); if (o.gacha || o.gship) console.log('NULLSRC', d.id.slice(-6), 'st', o.status, 'gacha', !!o.gacha, 'gship', !!o.gship, 'total', o.total, 'granted', !!o.granted); }
  const bi = await db.collection('gbi').get(); const st = {}; bi.docs.forEach(d => { st[d.data().st] = (st[d.data().st] || 0) + 1; }); console.log('GBI', JSON.stringify(st));
  const tix = await db.collection('gTix').get(); console.log('GTIX', tix.size, 'unused', tix.docs.reduce((a, d) => a + (+d.data().n || 0), 0));
})().catch(e => { console.error(e); process.exit(1); });
