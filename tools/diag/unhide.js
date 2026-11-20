// 依編號把 SlowLeaf 的植物取消隱藏。IMG_PATHS=CODE1,CODE2
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const codes = (process.env.IMG_PATHS || '').split(',').map(s => s.trim()).filter(Boolean);
(async () => {
  const shops = await db.collection('shops').get(); const sl = shops.docs.filter(d => /slow\s*leaf/i.test(String(d.data().name || '')));
  if (sl.length !== 1 || !codes.length) { console.log('ABORT'); return; } const uid = sl[0].id;
  for (const c of codes) { const q = await db.collection('shops/' + uid + '/plants').where('code', '==', c).get();
    for (const d of q.docs) { const p = d.data(); await d.ref.update({ hidden: false }); const n = (await d.ref.get()).data();
      console.log('UNHID', c, 'hidden', n.hidden, 'listed', n.listed, 'mode', p.mode, 'ends', p.endsAtMs ? new Date(p.endsAtMs).toISOString() : '-', 'status', p.status); } if (!q.size) console.log('NOTFOUND', c); }
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
