// 統計：已經轉給別人、但原賣場還在上架中的植物（只讀，不改資料）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore(); const ME = process.env.IMG_PATHS || '';
(async () => {
  const O = await db.collection('owners').get(); let n = 0, shops = new Map(), mine = [];
  for (const o of O.docs) { const x = o.data(); if (!x.shop || !x.current || x.current === x.shop) continue; const d = await db.doc('shops/' + x.shop + '/plants/' + o.id).get(); if (!d.exists) continue; const p = d.data();
    if (p.listed === false || p.status === 'sold') continue; n++; shops.set(x.shop, (shops.get(x.shop) || 0) + 1); if (x.shop === ME) mine.push((p.code || o.id) + (p.mode === 'auction' ? '(競標)' : '') + ' NT$' + (p.price ?? '-')); }
  console.log('OWNERS', O.size, 'TRANSFERRED_BUT_LISTED', n, 'SHOPS', shops.size); console.log('MINE', mine.length, mine.join(', '));
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
