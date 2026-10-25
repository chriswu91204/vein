// VEIN 手機推播（Firebase Cloud Messaging）：聊天新訊息、議價、日常管理到期提醒
// 不需要任何密碼或金鑰（用專案本身的權限送出）；網站端的 Web Push 公開金鑰在「網站設定」填寫。
const { onDocumentCreated, onDocumentWritten, onDocumentUpdated } = require('firebase-functions/v2/firestore');
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
  const snap = await db.collection(`data/users/${uid}/push/devices`).get();
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

// ---------- 交易通知：新訂單、新出價、被超標、提問、訂單狀態、開獎、結標 ----------
const nt = n => 'NT$ ' + Number(n || 0).toLocaleString('zh-TW');
async function getPlant(shop, pid) { try { const s = await db.doc(`shops/${shop}/plants/${pid}`).get(); return s.exists ? { id: pid, shop, ...s.data() } : null; } catch (e) { return null; } }
async function findPlant(pid, hintShop) {
  if (hintShop) { const p = await getPlant(hintShop, pid); if (p) return p; }
  for (const d of await db.collection('shops').listDocuments()) { const p = await getPlant(d.id, pid); if (p) return p; }
  return null;
}
const pLabel = p => (p.code || '') + (p.species ? ' ' + String(p.species).split(' ').slice(1).join(' ') : '');
// 所有人的出價（含每次出價時間），用來算防尾刀後的真正結標時間與目前最高者
async function allBids(pid) {
  const out = []; (await db.collection('social').get()).forEach(d => { const b = (d.data().bids || {})[pid]; if (b && typeof b.amt === 'number') out.push({ uid: d.id, ...b }); }); return out;
}
function effEnd(p, bids) {
  const sn = p && p.snipe && p.snipe.on !== false ? { win: 5, ext: 5, max: 120, ...p.snipe } : null;
  if (!sn || !p.endsAtMs) return p ? p.endsAtMs : 0;
  const ts = []; bids.forEach(b => (Array.isArray(b.ts) && b.ts.length ? b.ts : [b.at]).forEach(t => typeof t === 'number' && ts.push(t))); ts.sort((a, b) => a - b);
  let end = p.endsAtMs; const W = sn.win * 6e4, E = sn.ext * 6e4, cap = p.endsAtMs + sn.max * 6e4;
  for (const t of ts) { if (t > end) break; if (t > end - W) end = Math.min(cap, Math.max(end, t + E)); }
  return end;
}
// 跟網站一樣的規則：照時間排序，出價必須高於當下最高價才算數
function leaderAt(p, bids, until) {
  let top = null; const start = +p.startPrice || 0;
  bids.filter(b => b.at <= until).sort((a, b) => a.at - b.at).forEach(b => { if (b.amt >= start && (!top || b.amt > top.amt)) top = b; });
  return top;
}
exports.pushSocial = onDocumentWritten('social/{uid}', async ev => {
  const uid = ev.params.uid, before = ev.data.before.exists ? ev.data.before.data() : {}, after = ev.data.after.exists ? ev.data.after.data() : null;
  if (!after) return;
  const me = await displayName(uid);
  // 新訂單 → 賣家
  for (const [oid, o] of Object.entries(after.orders || {})) {
    if ((before.orders || {})[oid] || !o.seller) continue;
    const n = (o.items || []).length, q = Object.values(o.qty || {}).reduce((a, b) => a + b, 0);
    await push(o.seller, '📦 新訂單', me + ' 下單 ' + (q ? q + ' 株' : n + ' 件') + '，共 ' + nt(o.total) + '，請到訂單接受', '/#admin/orders', 'order-' + oid);
  }
  // 新出價 → 賣家；被超標 → 原本最高的人
  for (const [pid, bid] of Object.entries(after.bids || {})) {
    const prev = (before.bids || {})[pid];
    if (!bid || typeof bid.amt !== 'number' || (prev && prev.amt >= bid.amt)) continue;
    const p = await findPlant(pid, bid.shop); if (!p || p.mode !== 'auction' || !p.endsAtMs) continue;
    const bids = await allBids(pid), end = effEnd(p, bids); if (bid.at > end) continue;
    const others = bids.filter(b => b.uid !== uid), prevTop = leaderAt(p, others, bid.at - 1), nowTop = leaderAt(p, bids, bid.at);
    if (nowTop && nowTop.uid === uid) {
      await push(p.shop, '⚡ 新出價 ' + nt(bid.amt), me + ' 出價 ' + pLabel(p) + '，目前 ' + bids.length + ' 人出價', '/#/plant/' + pid, 'bid-' + pid);
      if (prevTop && prevTop.uid !== uid) await push(prevTop.uid, '😮 你的出價被超越了', pLabel(p) + ' 目前最高 ' + nt(bid.amt) + '（你出 ' + nt(prevTop.amt) + '），回來加價吧', '/#/plant/' + pid, 'outbid-' + pid);
    }
  }
  // 新提問 → 賣家
  const oldQ = new Set((before.qa || []).map(q => q.id));
  for (const q of after.qa || []) { if (oldQ.has(q.id)) continue; const p = await findPlant(q.pid, q.shop); if (p) await push(p.shop, '💬 有人提問', me + '：「' + String(q.text || '').slice(0, 60) + '」（' + p.code + '）', '/#admin/qa', 'qa-' + q.id); }
});
// 訂單狀態 → 買家
exports.pushOrder = onDocumentWritten('shops/{shop}/orders/{oid}', async ev => {
  const a = ev.data.after.exists ? ev.data.after.data() : null, b = ev.data.before.exists ? ev.data.before.data() : null;
  if (!a || !a.buyer || (b && b.status === a.status)) return;
  const sn = await displayName(ev.params.shop), auc = String(ev.params.oid).startsWith('auc-');
  const M = { confirmed: [auc ? '🎉 得標訂單已成立' : '✅ 賣家接受了你的訂單', '「' + sn + '」已確認，訂單頁會顯示匯款資訊'], preparing: ['📦 賣家已確認收款', '「' + sn + '」正在備貨'], shipped: ['🚚 你的植物出貨了', '「' + sn + '」已寄出，收到後記得按「我已收到貨」'], cancelled: ['訂單未成立', '「' + sn + '」這次無法接受訂單'] }[a.status];
  if (M) await push(a.buyer, M[0], M[1], '/#/me/orders', auc ? 'won-' + String(ev.params.oid).slice(4) : 'ord-' + ev.params.oid);
  if (a.status === 'paid' && (!b || b.status !== 'paid')) await push(ev.params.shop, '💳 買家已匯款', (await displayName(a.buyer)) + ' 填了匯款資訊，請對帳', '/#admin/orders', 'paid-' + ev.params.oid);
});
// 開獎 → 中獎者、賣家
exports.pushRaffle = onDocumentUpdated('shops/{shop}/raffles/{rid}', async ev => {
  const b = ev.data.before.data(), a = ev.data.after.data(); if (b.drawn || !a.drawn) return;
  const link = '/#/raffle/' + ev.params.shop + '~' + ev.params.rid, sn = await displayName(ev.params.shop);
  for (const w of a.drawn.winners || []) await push(w, '🎉 恭喜你中獎了', '「' + sn + '」的「' + a.title + '」：' + (a.prize || ''), link, 'raf-' + ev.params.rid);
});
// 收藏了這株的人（快結標提醒用）
async function favoredBy(pid) { const out = [];
  for (const col of await db.doc('data/users').listCollections()) { try { const d = await col.doc('prefs').get(); if (d.exists && (d.data().favs || []).includes(pid)) out.push(col.id); } catch (e) {} }
  return out; }
// 快結標提醒：剩 30 分鐘通知所有出過價和收藏的人；剩 5 分鐘再提醒「沒有領先」的出價者
async function endingSoon(p, now) {
  const bids = await allBids(p.id), end = effEnd(p, bids), left = end - now; if (left <= 0 || left > 31 * 6e4) return;
  const top = leaderAt(p, bids, end), price = top ? top.amt : (+p.startPrice || 0), link = '/#/plant/' + p.id;
  const mk30 = db.doc('sysnotes/soon30-' + p.id + '-' + p.endsAtMs);
  if (!(await mk30.get()).exists) {
    const who = new Set([...bids.map(b => b.uid), ...(await favoredBy(p.id))]); who.delete(p.shop);
    for (const u of who) {
      const lead = top && top.uid === u;
      await push(u, lead ? '⏰ 剩 30 分鐘，你目前領先' : '⏰ 競標剩 30 分鐘', pLabel(p) + (top ? ' 目前最高 ' + nt(price) : ' 起標 ' + nt(price)) + (lead ? '，守住它！' : '，要出價把握時間'), link, 'soon-' + p.id);
    }
    await mk30.set({ at: now });
  }
  if (left <= 7 * 6e4) { const mk5 = db.doc('sysnotes/soon5-' + p.id + '-' + p.endsAtMs);
    if (!(await mk5.get()).exists) { for (const b of bids) if (b.uid !== p.shop && (!top || top.uid !== b.uid)) await push(b.uid, '🔥 最後 5 分鐘！', pLabel(p) + ' 目前最高 ' + nt(price) + '，你被超越了，最後機會', link, 'soon-' + p.id); await mk5.set({ at: now }); } }
}
// 每 5 分鐘：快結標提醒＋剛結標的競標 → 得標者、賣家（記錄在 sysnotes，不重複推）
exports.pushAuctionEnd = onSchedule({ schedule: 'every 5 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now();
  for (const sd of await db.collection('shops').listDocuments()) {
    let snap; try { snap = await sd.collection('plants').where('mode', '==', 'auction').get(); } catch (e) { continue; }
    for (const d of snap.docs) {
      const p = { id: d.id, shop: sd.id, ...d.data() };
      if (p.endsAtMs && p.status !== 'sold' && p.endsAtMs + 120 * 6e4 > now) { try { await endingSoon(p, now); } catch (e) { logger.warn('ending soon failed', d.id, String(e)); } }
      if (!p.endsAtMs || p.endsAtMs > now || p.endsAtMs < now - 2 * 864e5) continue;
      const bids = await allBids(d.id), end = effEnd(p, bids); if (end > now) continue;
      const win = leaderAt(p, bids, end);
      // 有得標者：自動成立訂單（跟賣家按「成立訂單給得標者」一樣），附上賣家的匯款帳號，植株標記售出
      let made = false;
      if (win && p.status !== 'sold') { const oref = db.doc(`shops/${sd.id}/orders/auc-${d.id}`);
        try { if (!(await oref.get()).exists) {
          const bank = await db.doc(`data/users/${sd.id}/bank`).get();
          await oref.set({ buyer: win.uid, items: [d.id], total: win.amt, note: '競標得標（自動成立）', status: 'confirmed', payMethod: 'transfer', src: 'auction', at: now });
          await db.doc(`deals/${sd.id}_auc-${d.id}`).set({ seller: sd.id, buyer: win.uid, orderId: 'auc-' + d.id, payMethod: 'transfer', bank: bank.exists ? bank.data() : null, at: now }, { merge: true });
          await d.ref.update({ status: 'sold', buyer: win.uid, soldPrice: win.amt });
          made = true; logger.info('auction order created', { pid: d.id, winner: win.uid, amt: win.amt }); } } catch (e) { logger.error('auction order failed', d.id, String(e)); } }
      const mk = db.doc('sysnotes/auc-' + d.id + '-' + p.endsAtMs); if ((await mk.get()).exists) continue;
      if (win) { await push(win.uid, '🏆 恭喜得標！', pLabel(p) + ' 以 ' + nt(win.amt) + ' 得標，訂單已成立，到訂單頁看匯款資訊', '/#/me/orders', 'won-' + d.id);
        await push(p.shop, '🔨 競標結束，訂單已自動成立', pLabel(p) + ' 由 ' + (await displayName(win.uid)) + ' 以 ' + nt(win.amt) + ' 得標', '/#admin/orders', 'end-' + d.id); }
      else await push(p.shop, '🔨 競標結束（沒人出價）', pLabel(p) + ' 可以改成直購或重新競標', '/#admin/auc', 'end-' + d.id);
      await mk.set({ at: now, pid: d.id, shop: sd.id });
    }
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
