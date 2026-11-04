// 測代綁手機的伺服器流程：用不存在的會員送一筆申請，確認 Cloud Function 有接到並回報「找不到」，最後刪掉
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
(async () => {
  const owner = await admin.auth().getUserByEmail('chriswu91204@gmail.com'); const ref = db.doc('phoneBind/zz_diag_test');
  await ref.set({ by: owner.uid, st: 'req', act: 'bind', phone: '0900000000', at: Date.now() });
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 2000)); const d = (await ref.get()).data(); if (d.st !== 'req') { console.log('RESULT', JSON.stringify({ st: d.st, err: d.err })); break; } if (i === 29) console.log('RESULT timeout (function not triggered)'); }
  await ref.delete();
})().catch(e => { console.error(e); process.exit(1); });
