// 轉蛋訂單狀態統計（不輸出個資：只有狀態、張數、金額、時間）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
(async () => {
  const gs = await db.collection('gacha').get(); const G = new Map(gs.docs.map(d => [d.id, d.data()]));
  for (const [id, g] of G) console.log('MACHINE', id.slice(0, 6), g.status, 'price', g.price, 'total', g.total, 'sold', g.sold, 'opened', g.opened);
  const shops = [...new Set([...G.values()].map(g => g.shop))];
  for (const sh of shops) { const os = await db.collection('shops/' + sh + '/orders').orderBy('at', 'desc').limit(40).get();
    for (const d of os.docs) { const o = d.data(); const its = o.items || []; const locked = []; for (const i of its.slice(0, 5)) { const pd = await db.doc('shops/' + sh + '/plants/' + String(i).split('#')[0]).get().catch(() => null); locked.push(pd && pd.exists ? (pd.data().kind || 'plant') + (pd.data().gcLock ? ':GC' : '') : 'missing'); }
      const r = await db.doc('gRes/' + sh + '_' + d.id).get(), dl = await db.doc('deals/' + sh + '_' + d.id).get();
      console.log('ORDER', String(o.src), d.id.slice(-6), 'st', o.status, 'n', (o.gacha || {}).n, 'total', o.total, 'fee', (o.ship || {}).fee, 'granted', !!o.granted, 'later', !!o.later, 'res', r.exists ? r.data().st : '-', 'paid', !!(dl.exists && dl.data().pay), 'items', its.length, locked.join(','), 'gship', !!o.gship, 'age_h', Math.round((Date.now() - (o.at || 0)) / 36e5), 'upd_h', Math.round((Date.now() - (o.updatedAt || 0)) / 36e5)); } }
  const bi = await db.collection('gbi').get(); const st = {}; bi.docs.forEach(d => { st[d.data().st] = (st[d.data().st] || 0) + 1; }); console.log('GBI', JSON.stringify(st));
  const tix = await db.collection('gTix').get(); console.log('GTIX', tix.size, 'unused', tix.docs.reduce((a, d) => a + (+d.data().n || 0), 0));
})().catch(e => { console.error(e); process.exit(1); });
