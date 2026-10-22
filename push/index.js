// VEIN 手機推播（Firebase Cloud Messaging）：聊天新訊息、議價、日常管理到期提醒
// 不需要任何密碼或金鑰（用專案本身的權限送出）；網站端的 Web Push 公開金鑰在「網站設定」填寫。
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onMessagePublished } = require('firebase-functions/v2/pubsub');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'asia-east1', maxInstances: 5 });
const SITE = 'https://vein-48ec8.web.app';

async function tokensOf(uid) {
  const snap = await db.collection(`data/users/${uid}/push`).get();
  return snap.docs.filter(d => d.data().token && d.data().on !== false).map(d => ({ ref: d.ref, token: d.data().token }));
}
async function push(uid, title, body, link, tag) {
  const T = await tokensOf(uid); if (!T.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens: T.map(t => t.token),
    notification: { title, body },
    data: { title, body, link: link || '/', tag: tag || '' },
    webpush: { fcmOptions: { link: SITE + (link || '/') }, notification: { icon: SITE + '/icon-192.png', badge: SITE + '/icon-192.png', tag: tag || undefined } }
  });
  // 失效的裝置 token 清掉
  await Promise.all(res.responses.map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument|invalid-registration/.test(r.error?.code || '')) ? T[i].ref.delete().catch(() => {}) : null));
  logger.info('push', { uid, title, ok: res.successCount, fail: res.failureCount });
  return res.successCount;
}
async function displayName(uid) {
  try { const s = await db.doc('shops/' + uid).get(); if (s.exists && s.data().name) return s.data().name; } catch (e) {}
  try { const p = await db.doc('profiles/' + uid).get(); if (p.exists && p.data().name) return p.data().name; } catch (e) {}
  return '會員';
}

// 聊天：新訊息推給對方
exports.pushChat = onDocumentCreated('chats/{cid}/messages/{mid}', async ev => {
  const m = ev.data?.data(); if (!m || m.t === 'sys') return;
  const to = String(ev.params.cid).split('~').find(u => u !== m.from); if (!to) return;
  const prev = { text: m.text, img: '📷 照片', vid: '🎬 影片', prod: '🌿 商品 ' + (m.code || ''), offer: '🤝 議價 NT$ ' + Number(m.amt || 0).toLocaleString('zh-TW'), ask: '✅ ' + (m.q || '請確認'), pay: '💳 匯款資訊', ship: '📦 已出貨' }[m.t] || m.text || '新訊息';
  await push(to, '💬 ' + await displayName(m.from), String(prev).slice(0, 120), '/#/chats/' + encodeURIComponent(ev.params.cid), 'chat-' + ev.params.cid);
});
// 議價：推給賣家
exports.pushOffer = onDocumentCreated('offers/{id}', async ev => {
  const o = ev.data?.data(); if (!o || !o.seller) return;
  await push(o.seller, '🤝 收到議價', (await displayName(o.buyer)) + ' 出價 NT$ ' + Number(o.amt || 0).toLocaleString('zh-TW') + (o.code ? '（' + o.code + '）' : ''), '/#admin/offers', 'offer-' + ev.params.id);
});
// 日常管理：每 15 分鐘檢查一次，剛到期的項目推一則
function dueAt(t) {
  const every = +t.every || 0; if (!every || !t.lastAt) return null;
  if (t.time && /^\d\d:\d\d$/.test(t.time)) {
    // 以台灣時間計算「第 N 天的幾點」
    const tz = 8 * 3600e3, d = new Date(t.lastAt + tz); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + Math.round(every));
    const [hh, mm] = t.time.split(':').map(Number); return d.getTime() + (hh * 60 + mm) * 60e3 - tz;
  }
  return t.lastAt + every * 864e5;
}
exports.pushCare = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now(), win = 15 * 60e3;
  const users = await db.doc('data/users').listCollections();
  for (const col of users) {
    try {
      const c = await col.doc('care').get(); if (!c.exists) continue; const v = c.data() || {};
      const hits = [];
      for (const z of v.zones || []) for (const t of z.tasks || []) { const at = dueAt(t); if (at && at <= now && at > now - win) hits.push(z.name + '：' + t.name); }
      if (hits.length) await push(col.id, '🌱 日常管理提醒', hits.slice(0, 4).join('、') + (hits.length > 4 ? ' 等 ' + hits.length + ' 項' : '') + ' 該做了', '/#plants/care', 'care');
    } catch (e) { logger.warn('care check failed', col.id, String(e)); }
  }
});

// 費用保護：Google Cloud 預算通知（Pub/Sub 主題 billing-alerts）→ 記錄目前花費；超過預算且「自動緊急模式」開著 → 開啟網站緊急模式
exports.budgetGuard = onMessagePublished({ topic: 'billing-alerts', maxInstances: 1 }, async (ev) => {
  const d = ev.data?.message?.json || {};
  const cost = Number(d.costAmount), budget = Number(d.budgetAmount);
  if (!isFinite(cost) || !isFinite(budget) || budget <= 0) return;
  await db.doc('abuse/_budget').set({ cost, budget, cur: d.currencyCode || '', name: d.budgetDisplayName || '', at: Date.now() });
  const info = (await db.doc('site/info').get()).data() || {};
  if (cost >= budget && info.autoLock !== false && !info.lockdown) {
    await db.doc('site/info').set({ lockdown: true, lockBy: 'budget', lockMsg: info.lockMsg || '' }, { merge: true });
    logger.warn('budget exceeded → lockdown', { cost, budget });
    const owner = await admin.auth().getUserByEmail('chriswu91204@gmail.com').catch(() => null);
    if (owner) await push(owner.uid, '🚨 VEIN 已自動開啟緊急模式', `本月費用 ${Math.round(cost)} 已超過預算 ${Math.round(budget)}`, '/#admin/guard', 'budget').catch(() => {});
  }
});
