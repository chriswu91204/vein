// 列出所有溫室（公開資料）：名稱、植物數、最後更新時間
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
(async () => { const sn = await db.collection('gh').get(); sn.docs.forEach(d => { const x = d.data(); console.log('GH', d.id.slice(0, 5), JSON.stringify(x.name || ''), 'n=' + x.n, 'keys=' + Object.keys(x).length, 'upd=' + (x.updatedAt ? new Date(x.updatedAt + 8 * 36e5).toISOString().slice(5, 16) : '-')); }); })().catch(e => { console.error(e); process.exit(1); });
