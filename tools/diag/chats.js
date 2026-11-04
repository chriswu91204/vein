// 聊天健檢：找出「列表上的最後一則」在對話裡找不到的情況（只輸出統計，不印出訊息內容）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
(async () => {
  const sn = await db.collection('chats').get(); let n = 0, miss = 0, typeOdd = 0, ahead = []; const types = {};
  for (const c of sn.docs) {
    const v = c.data(); const last = v.last || {}; n++;
    const ms = await c.ref.collection('messages').orderBy('at', 'desc').limit(3).get();
    const top = ms.docs[0]?.data();
    ms.docs.forEach(d => { const t = typeof d.data().at; types[t] = (types[t] || 0) + 1; });
    const all = await c.ref.collection('messages').get(); let odd = 0; all.docs.forEach(d => { if (typeof d.data().at !== 'number') odd++; }); typeOdd += odd;
    const gap = (last.at || 0) - (top?.at || 0);
    const found = all.docs.some(d => { const m = d.data(); return m.from === last.from && Math.abs((m.at || 0) - (last.at || 0)) < 5000; });
    if (!found && last.at) { miss++; ahead.push({ chat: c.id.slice(0, 4) + '…', lastAt: new Date(last.at).toISOString(), topAt: top?.at ? new Date(top.at).toISOString() : null, gapSec: Math.round(gap / 1000), lastType: last.t, msgs: all.size, nonNumberAt: odd }); }
  }
  console.log(JSON.stringify({ chats: n, lastWithoutMessage: miss, nonNumberAtTotal: typeOdd, topTypes: types, samples: ahead.slice(0, 30) }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
