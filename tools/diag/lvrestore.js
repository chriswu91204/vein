// 熱修復：把這場拍賣會被誤標成 gone 的拍品（植物還在、沒賣掉、沒刪除、沒轉走）放回排隊；拍賣會已經結束的話重新開始（從上一件之後接著拍）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const ID = '7zA7TIN8k6rmuH6zRe60';
(async () => {
  const eref = db.doc('lives/' + ID); const ev = (await eref.get()).data(); console.log('BEFORE', JSON.stringify({ phase: ev.phase, finalized: !!ev.finalized, cur: ev.cur ? { lid: ev.cur.lid, i: ev.cur.i, over: !!ev.cur.over, gap: !!ev.cur.gapUntil } : null }));
  const L = (await eref.collection('lots').get()).docs; let n = 0;
  for (const d of L) { const l = d.data(); if (l.status !== 'gone') continue; const p = await db.doc(`shops/${l.shop}/plants/${l.pid}`).get(); const q = p.exists ? p.data() : null;
    if (!q || q.status === 'sold' || q.purgeAt || (q.listed === false && q.delistedWhy === 'xfer')) { console.log('SKIP', d.id); continue; }
    await d.ref.update({ status: 'ok', why: admin.firestore.FieldValue.delete(), endedAt: admin.firestore.FieldValue.delete() }); n++; }
  console.log('RESTORED', n);
  if (n && ev.phase === 'done') { const cur = { ...(ev.cur || {}) }; delete cur.over; if (!cur.gapUntil) cur.gapUntil = Date.now() + 5000;
    await eref.update({ phase: 'on', doneAt: admin.firestore.FieldValue.delete(), finalized: false, cur, now: Date.now() }); console.log('REOPENED'); }
  const e2 = (await eref.get()).data(); const cnt = {}; (await eref.collection('lots').get()).docs.forEach(z => { const s = z.data().status; cnt[s] = (cnt[s] || 0) + 1; });
  console.log('AFTER', JSON.stringify({ phase: e2.phase, cur: e2.cur ? { lid: e2.cur.lid, i: e2.cur.i } : null, lots: cnt }));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
