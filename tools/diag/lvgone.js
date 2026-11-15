// 最近 6 小時的拍賣會：每件拍品狀態，被標成 gone 的拍品對應植物目前的狀態（只輸出狀態欄位，不含個資）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
(async () => {
  const since = Date.now() - 6 * 3600e3; const ev = (await db.collection('lives').get()).docs.filter(d => (+d.data().startAt || 0) > since - 6 * 3600e3);
  for (const d of ev) { const x = d.data(); console.log('EVENT', d.id, JSON.stringify({ title: x.title, phase: x.phase, startAt: new Date(+x.startAt || 0).toISOString(), cur: x.cur ? { lid: x.cur.lid, i: x.cur.i } : null }));
    const L = (await d.ref.collection('lots').get()).docs.map(z => ({ id: z.id, ...z.data() })); const cnt = {}; L.forEach(l => cnt[l.status] = (cnt[l.status] || 0) + 1); console.log('  LOTS', JSON.stringify(cnt));
    for (const l of L.filter(l => l.status === 'gone')) { const p = await db.doc(`shops/${l.shop}/plants/${l.pid}`).get(); const q = p.exists ? p.data() : null;
      console.log('  GONE', l.id, l.ord, JSON.stringify(l.name || l.code || ''), 'why=' + (l.why || ''), 'endedAt=' + (l.endedAt ? new Date(l.endedAt).toISOString() : ''), 'plant=' + JSON.stringify(q ? { exists: true, status: q.status, listed: q.listed, hidden: !!q.hidden, private: !!q.private, mode: q.mode || '', purge: !!q.purgeAt, lv: q.lv ? q.lv.id || true : null, mkt: !!q.mkt } : { exists: false })); } }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
