// 移除 SlowLeaf「植物管理」裡所有植物的「國外進口」標籤。IMG_PATHS=dry 只統計；IMG_PATHS=apply 才寫入（先把原本的 tags 備份到 backups/）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const MODE = (process.env.IMG_PATHS || 'dry').trim(), TAG = '國外進口';
(async () => {
  const shops = await db.collection('shops').get(); const sl = shops.docs.filter(d => /slow\s*leaf/i.test(String(d.data().name || '')));
  console.log('SHOPS_MATCH', sl.map(d => d.id.slice(0, 6) + ':' + d.data().name).join(', '));
  if (sl.length !== 1) { console.log('ABORT 找到的賣場不是剛好一間'); return; }
  const uid = sl[0].id, hits = [];
  // 1) 自己賣場的植物
  const own = await db.collection('shops/' + uid + '/plants').get();
  own.docs.forEach(d => { const t = d.data().tags; if (Array.isArray(t) && t.includes(TAG)) hits.push({ ref: d.ref, code: d.data().code || d.id, tags: t, where: 'own' }); });
  // 2) 別的賣場轉給 SlowLeaf、現在由 SlowLeaf 持有的植物（植物管理裡也看得到）
  const ow = await db.collection('owners').where('current', '==', uid).get();
  for (const o of ow.docs) { const x = o.data(); if (!x.shop || x.shop === uid) continue; const d = await db.doc('shops/' + x.shop + '/plants/' + o.id).get(); if (!d.exists) continue; const t = d.data().tags; if (Array.isArray(t) && t.includes(TAG)) hits.push({ ref: d.ref, code: d.data().code || d.id, tags: t, where: 'held' }); }
  console.log('PLANTS_OWN', own.size, 'HELD_FROM_OTHERS', ow.size, 'WITH_TAG', hits.length, 'own', hits.filter(h => h.where === 'own').length, 'held', hits.filter(h => h.where === 'held').length);
  console.log('CODES', hits.map(h => h.code + (h.where === 'held' ? '(轉入)' : '')).join(', '));
  if (MODE !== 'apply' || !hits.length) { console.log('DRY_RUN 沒有寫入'); return; }
  const bk = db.collection('backups').doc('rmtag_' + Date.now()); await bk.set({ at: Date.now(), shop: uid, tag: TAG, items: hits.map(h => ({ path: h.ref.path, tags: h.tags })) });
  let n = 0; for (let i = 0; i < hits.length; i += 400) { const b = db.batch(); hits.slice(i, i + 400).forEach(h => { b.update(h.ref, { tags: h.tags.filter(t => t !== TAG) }); n++; }); await b.commit(); }
  console.log('APPLIED', n, 'BACKUP', bk.path);
  let left = 0; for (const h of hits) { const d = await h.ref.get(); if ((d.data().tags || []).includes(TAG)) left++; } console.log('VERIFY_LEFT', left);
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
