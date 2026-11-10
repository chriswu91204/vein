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
// 即時推播（出價、訂單、聊天）：一台可同時處理多件，尖峰（結標前大家一起出價）不會排隊。
// 原本預設一台一次只處理一件、最多 5 台，滿了 Google 會「稍後重試」，等待時間會一路拉長到好幾分鐘。
const HOT = { cpu: 1, memory: '512MiB', concurrency: 40, maxInstances: 10 };
const SITE = 'https://vein-48ec8.web.app';

async function tokensOf(uid) {
  const snap = await db.collection(`data/users/${uid}/push/devices`).get();
  // 同一台裝置（同一個 dev 代號，或同樣的瀏覽器＋螢幕）只送最新的那個 token，避免同一支手機跳兩則
  const L = snap.docs.filter(d => d.data().token && d.data().on !== false).map(d => ({ ref: d.ref, token: d.data().token, at: +d.data().at || 0, key: d.data().dev || ((d.data().ua || '') + '|' + (d.data().scr || '')) }))
    .sort((a, b) => b.at - a.at);
  const seen = new Set(), out = [];
  for (const t of L) { const k = t.key && t.key !== '|' ? t.key : t.token; if (seen.has(k)) continue; seen.add(k); out.push(t); }
  return out;
}
async function push(uid, title, body, link, tag) {
  const T0 = await tokensOf(uid), seen = new Set(), T = T0.filter(t => !seen.has(t.token) && seen.add(t.token)); if (!T.length) return 0;
  // 只送資料、由網站的 service worker 自己顯示一則通知；同時帶 notification 欄位的話，iPhone 會自動顯示一則、service worker 再顯示一則 → 重複
  const res = await admin.messaging().sendEachForMulticast({
    tokens: T.map(t => t.token),
    data: { title, body, link: link || '/', tag: tag || '' },
    webpush: { headers: { Urgency: 'high', TTL: '86400' }, fcmOptions: { link: SITE + (link || '/') } }
  });
  // 失效的裝置 token 清掉
  await Promise.all(res.responses.map((r, i) => (!r.success && /registration-token-not-registered|invalid-argument|invalid-registration/.test(r.error?.code || '')) ? T[i].ref.delete().catch(() => {}) : null));
  logger.info('push', { uid, title, ok: res.successCount, fail: res.failureCount });
  return res.successCount;
}
// 訂單有新留言／對方更新 → 記給收的人，網站在那筆訂單上亮提示
async function ordAct(uid, shop, oid, k) { if (!uid || !shop || !oid) return; try { await db.doc('ordAct/' + uid).set({ [shop + '~' + oid]: { at: Date.now(), k } }, { merge: true }); } catch (e) { logger.warn('ordAct', e.message); } }
async function displayName(uid) {
  try { const s = await db.doc('shops/' + uid).get(); if (s.exists && s.data().name) return s.data().name; } catch (e) {}
  try { const p = await db.doc('profiles/' + uid).get(); if (p.exists && p.data().name) return p.data().name; } catch (e) {}
  return '會員';
}

// 聊天：新訊息推給對方
exports.pushChat = onDocumentCreated({ document: 'chats/{cid}/messages/{mid}', ...HOT }, async ev => {
  const m = ev.data?.data(); if (!m || m.t === 'sys') return;
  const cid = String(ev.params.cid), prev = { text: m.text, img: '📷 照片', vid: '🎬 影片', prod: '🌿 商品 ' + (m.code || ''), offer: '🤝 議價 NT$ ' + Number(m.amt || 0).toLocaleString('zh-TW'), ask: '✅ ' + (m.q || '請確認'), pay: '💳 匯款資訊', ship: '📦 已出貨', ginv: '👥 邀請你加入群組「' + (m.name || '') + '」' }[m.t] || m.text || '新訊息';
  let to = [], title = '💬 ' + await displayName(m.from);
  if (cid.startsWith('g_')) { const c = await db.doc('chats/' + cid).get(); if (!c.exists) return; to = (c.data().members || []).filter(u => u !== m.from).slice(0, 60); title = '💬 ' + (c.data().name || '群組') + ' · ' + await displayName(m.from); }
  else { const t = cid.split('~').find(u => u !== m.from); if (t) to = [t]; }
  for (const u of to) await push(u, title, String(prev).slice(0, 120), '/#/chats/' + encodeURIComponent(cid), 'chat-' + cid);
});
// 議價：推給賣家
exports.pushOffer = onDocumentCreated({ document: 'offers/{id}', ...HOT }, async ev => {
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
  let top = null; const start = +p.startPrice || 0, st0 = +p.startsAtMs || 0;
  bids.filter(b => b.at <= until && b.at >= st0).sort((a, b) => a.at - b.at).forEach(b => { if (b.amt >= start && (!top || b.amt > top.amt)) top = b; });
  return top;
}
// 新訂單一律自動成立（賣家不用按接受）：建立賣家那邊的訂單、交易資料（匯款帳號），植物標記售出／扣整盤庫存
// 商品已經被別人買走或庫存不夠時，訂單直接標記取消並通知買家
async function autoConfirm(shop, oid, o, buyer) {
  const oref = db.doc(`shops/${shop}/orders/${oid}`), now = Date.now();
  let res;
  try {
    res = await db.runTransaction(async tx => {
      const ex = await tx.get(oref); if (ex.exists) return { r: 'exists' };
      const ids = [...new Set(o.items || [])], refs = ids.map(pid => db.doc(`shops/${shop}/plants/${pid}`)), snaps = [];
      for (const r of refs) snaps.push(await tx.get(r));
      let why = null; const ups = [];
      snaps.forEach((s, i) => { if (!s.exists) { why = '商品已下架'; return; } const p = s.data(), q = Math.max(1, +((o.qty || {})[ids[i]]) || 1), lot = (p.lot === true && p.mode !== 'auction') || !!(o.qty || {})[ids[i]];
        if (lot) { const left = Math.max(0, Math.floor(+p.stock || 0)); if (left < q) { why = '庫存不夠'; return; } ups.push([refs[i], { stock: left - q, soldN: (+p.soldN || 0) + q, ...(left - q <= 0 ? { status: 'sold' } : {}) }]); }
        else { if ((p.status === 'sold' || p.status === 'reserved') && p.buyer && p.buyer !== buyer) { why = '已被別人買走'; return; } ups.push([refs[i], { status: 'sold', buyer, soldPrice: p.soldPrice || p.price || null }]); } });
      const base = { buyer, items: o.items || [], total: o.total || 0, note: o.note || '', at: o.at || now, payMethod: o.payMethod || 'transfer', src: o.src || null, ...(o.qty ? { qty: o.qty } : {}), ...(o.ship ? { ship: o.ship } : {}), updatedAt: now, auto: true };
      if (why) { tx.set(oref, { ...base, status: 'cancelled', cancelledAt: now, cancelWhy: why }); return { r: 'cancel', why }; }
      ups.forEach(([r, d]) => tx.update(r, d)); tx.set(oref, { ...base, status: 'confirmed', confirmedAt: now }); return { r: 'ok' };
    });
  } catch (e) { logger.warn('autoConfirm', oid, e.message); return; }
  if (res.r === 'ok') {
    try { const dref = db.doc(`deals/${shop}_${oid}`), dd = await dref.get(); const pm = o.payMethod || 'transfer';
      const bank = pm === 'transfer' ? await db.doc(`data/users/${shop}/bank`).get() : null;
      await dref.set({ seller: shop, buyer, orderId: oid, payMethod: pm, ...(dd.exists && dd.data().bank ? {} : { bank: bank && bank.exists ? bank.data() : null }), ...(dd.exists ? {} : { at: now }) }, { merge: true }); } catch (e) { logger.warn('autoDeal', oid, e.message); }
    await ordAct(buyer, shop, oid, 'upd');
  } else if (res.r === 'cancel') { await push(buyer, '訂單沒有成立', '商品' + res.why + '，這筆訂單已自動取消', '/#/me/orders', 'order-' + oid); await ordAct(buyer, shop, oid, 'upd'); }
  return res.r;
}
exports.pushSocial = onDocumentWritten({ document: 'social/{uid}', ...HOT }, async ev => {
  const uid = ev.params.uid, before = ev.data.before.exists ? ev.data.before.data() : {}, after = ev.data.after.exists ? ev.data.after.data() : null;
  if (!after) return;
  const me = await displayName(uid);
  // 新訂單 → 賣家
  for (const [oid, o] of Object.entries(after.orders || {})) {
    const bo = (before.orders || {})[oid];
    if (o.seller && (!bo || JSON.stringify({ c: bo.cancelled, r: bo.cancelReq, j: bo.cancelRej, s: bo.status, p: bo.paid }) !== JSON.stringify({ c: o.cancelled, r: o.cancelReq, j: o.cancelRej, s: o.status, p: o.paid }))) await ordAct(o.seller, o.seller, oid, 'upd');
    if (bo && !bo.cancelled && o.cancelled && o.seller) { await push(o.seller, o.cancelledBy === 'agree' ? '買家同意取消訂單' : '訂單已取消', me + (o.cancelledBy === 'agree' ? ' 同意取消訂單（' : ' 取消了訂單（') + nt(o.total) + '）', '/#orders/orders', 'order-' + oid); continue; }
    if (bo && o.seller && o.cancelReq && (!bo.cancelReq || bo.cancelReq.at !== o.cancelReq.at)) { await push(o.seller, '✋ 買家申請取消訂單', me + (o.cancelReq.why ? '：「' + String(o.cancelReq.why).slice(0, 40) + '」' : '') + '，請到訂單同意或不同意', '/#orders/orders', 'order-' + oid); continue; }
    if (bo && o.seller && o.cancelRej && (!bo.cancelRej || bo.cancelRej.at !== o.cancelRej.at)) { await push(o.seller, '買家不同意取消', me + ' 希望訂單繼續', '/#orders/orders', 'order-' + oid); continue; }
    if (bo || !o.seller || o.cancelled) continue;
    const n = (o.items || []).length, q = Object.values(o.qty || {}).reduce((a, b) => a + b, 0);
    const r = await autoConfirm(o.seller, oid, o, uid); if (r === 'cancel') continue;
    await push(o.seller, '📦 新訂單（已成立）', me + ' 下單 ' + (q ? q + ' 株' : n + ' 件') + '，共 ' + nt(o.total) + '，等買家付款', '/#orders/orders', 'order-' + oid);
  }
  // 新出價 → 賣家；被超標 → 原本最高的人
  for (const [pid, bid] of Object.entries(after.bids || {})) {
    const prev = (before.bids || {})[pid];
    if (!bid || typeof bid.amt !== 'number' || (prev && prev.amt >= bid.amt)) continue;
    const p = await findPlant(pid, bid.shop); if (!p || p.mode !== 'auction' || !p.endsAtMs) continue;
    const bids = await allBids(pid), end = effEnd(p, bids); if (bid.at > end) continue;
    logger.info('bidLag', { pid, lagMs: Date.now() - bid.at }); if (Date.now() > end + 6e4) continue;
    const others = bids.filter(b => b.uid !== uid), prevTop = leaderAt(p, others, bid.at - 1), nowTop = leaderAt(p, bids, bid.at);
    if (nowTop && nowTop.uid === uid) {
      await push(p.shop, '⚡ 新出價 ' + nt(bid.amt), me + ' 出價 ' + pLabel(p) + '，目前 ' + bids.length + ' 人出價', '/#/plant/' + pid, 'bid-' + pid);
      if (prevTop && prevTop.uid !== uid) await push(prevTop.uid, '😮 你的出價被超越了', pLabel(p) + ' 目前最高 ' + nt(bid.amt) + '（你出 ' + nt(prevTop.amt) + '），回來加價吧', '/#/plant/' + pid, 'outbid-' + pid);
    }
  }
  // 新提問 → 賣家
  const oldQ = new Set((before.qa || []).map(q => q.id));
  for (const q of after.qa || []) { if (oldQ.has(q.id)) continue; const p = await findPlant(q.pid, q.shop); if (p) await push(p.shop, '💬 有人提問', me + '：「' + String(q.text || '').slice(0, 60) + '」（' + p.code + '）', '/#orders/qa', 'qa-' + q.id); }
});
// 訂單狀態 → 買家
exports.pushOrder = onDocumentWritten({ document: 'shops/{shop}/orders/{oid}', ...HOT }, async ev => {
  const a = ev.data.after.exists ? ev.data.after.data() : null, b = ev.data.before.exists ? ev.data.before.data() : null;
  if (!a || !a.buyer) return;
  if (b && ((a.cancelReq && (!b.cancelReq || b.cancelReq.at !== a.cancelReq.at)) || (a.cancelRej && (!b.cancelRej || b.cancelRej.at !== a.cancelRej.at)) || (b.status !== a.status && !['paid', 'done'].includes(a.status)) || JSON.stringify(a.ship || null) !== JSON.stringify(b.ship || null))) await ordAct(a.buyer, ev.params.shop, ev.params.oid, 'upd');
  if (a.status === 'paid' && (!b || b.status !== 'paid')) await ordAct(ev.params.shop, ev.params.shop, ev.params.oid, 'upd');
  if (a.cancelReq && (!b || !b.cancelReq || b.cancelReq.at !== a.cancelReq.at)) { await push(a.buyer, '✋ 賣家申請取消訂單', '「' + (await displayName(ev.params.shop)) + '」' + (a.cancelReq.why ? '：' + String(a.cancelReq.why).slice(0, 40) : '') + '，請到訂單同意或不同意', '/#/me/orders', 'ord-' + ev.params.oid); return; }
  if (a.cancelRej && (!b || !b.cancelRej || b.cancelRej.at !== a.cancelRej.at)) { await push(a.buyer, '賣家不同意取消', '「' + (await displayName(ev.params.shop)) + '」希望訂單繼續', '/#/me/orders', 'ord-' + ev.params.oid); return; }
  if (b && b.status === a.status) return;
  if (a.status === 'cancelled' && a.src === 'enc') { try { await encStrike(a.buyer, ev.params.shop, ev.params.oid); } catch (e) { logger.warn('encStrike', e.message); } }
  const sn = await displayName(ev.params.shop), auc = String(ev.params.oid).startsWith('auc-');
  const M = { confirmed: [auc ? '🎉 得標訂單已成立' : '✅ 賣家接受了你的訂單', '「' + sn + '」已確認，訂單頁會顯示匯款資訊'], preparing: ['📦 賣家已確認收款', '「' + sn + '」正在備貨'], shipped: ['🚚 你的植物出貨了', '「' + sn + '」已寄出，收到後記得按「我已收到貨」'], cancelled: b && b.status !== 'pending' ? ['訂單已取消', '「' + sn + '」的訂單已取消'] : ['訂單未成立', '「' + sn + '」這次無法接受訂單'] }[a.status];
  if (M) await push(a.buyer, M[0], M[1], '/#/me/orders', auc ? 'won-' + String(ev.params.oid).slice(4) : 'ord-' + ev.params.oid);
  if (a.status === 'paid' && (!b || b.status !== 'paid')) await push(ev.params.shop, '💳 買家已匯款', (await displayName(a.buyer)) + ' 填了匯款資訊，請對帳', '/#orders/orders', 'paid-' + ev.params.oid);
});
// 訂單留言 → 推給另一方
exports.pushOrdMsg = onDocumentCreated({ document: 'ordmsg/{shop}/o/{oid}/m/{mid}', ...HOT }, async ev => {
  const m = ev.data?.data(); if (!m || !m.from) return;
  const { shop, oid } = ev.params, fromSeller = m.side === 's' || m.from === shop;
  let buyer = null;
  try { const so = await db.doc('shops/' + shop + '/orders/' + oid).get(); if (so.exists) buyer = so.data().buyer || null; } catch (e) {}
  if (!buyer && m.to && m.to !== shop) { try { const sd = await db.doc('social/' + m.to).get(); if (sd.exists && (((sd.data().orders || {})[oid]) || {}).seller === shop) buyer = m.to; } catch (e) {} }
  if (!buyer && !fromSeller) buyer = m.from;
  const to = fromSeller ? buyer : shop; if (!to || to === m.from) return;
  await ordAct(to, shop, oid, 'msg');
  const body = (m.text ? String(m.text) : '') || (m.img ? '📷 傳了一張照片' : '新留言');
  const link = to === shop ? '/#orders/orders/' + encodeURIComponent(shop + '~' + oid) : '/#/me/orders/' + encodeURIComponent(shop + '~' + oid);
  await push(to, '📝 訂單留言 · ' + await displayName(fromSeller ? shop : m.from), body.slice(0, 120), link, 'om-' + oid);
});
// 開獎 → 中獎者、賣家
exports.pushRaffle = onDocumentUpdated('shops/{shop}/raffles/{rid}', async ev => {
  const b = ev.data.before.data(), a = ev.data.after.data(); if (b.drawn || !a.drawn) return;
  const link = '/#/raffle/' + ev.params.shop + '~' + ev.params.rid, sn = await displayName(ev.params.shop);
  const W = new Set(a.drawn.winners || []);
  for (const w of W) await push(w, '🎉 恭喜你中獎了', '「' + sn + '」的「' + a.title + '」：' + (a.prize || ''), link, 'raf-' + ev.params.rid);
  // 沒抽中的參加者也通知：開獎結果出爐
  let all = Array.isArray(a.drawn.all) ? a.drawn.all : null;
  if (!all) { all = []; const key = ev.params.shop + '~' + ev.params.rid; try { const ss = await db.collection('social').get(); ss.forEach(d => { const at = ((d.data().raffles || {})[key]); if (at && (!a.endsAtMs || at <= a.endsAtMs)) all.push(d.id); }); } catch (e) {} }
  for (const u of new Set(all)) { if (W.has(u) || u === ev.params.shop) continue; try { await push(u, '🎁 抽獎開獎了', '「' + sn + '」的「' + a.title + '」已經開獎，看看得獎名單', link, 'raf-' + ev.params.rid); } catch (e) {} }
});
// 抽獎截止了還沒開獎：提醒主辦人去按「開獎」（每場只提醒一次）
exports.pushRaffleDue = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now(), shops = await db.collection('shops').get();
  for (const s of shops.docs) {
    try {
      const rs = await db.collection('shops/' + s.id + '/raffles').get();
      for (const r of rs.docs) { const a = r.data(); if (a.drawn || a.dueNoted || !a.endsAtMs || a.endsAtMs > now || now - a.endsAtMs > 7 * 864e5) continue;
        await push(s.id, '🎲 抽獎時間到了', '「' + (a.title || '抽獎') + '」已截止，打開按「開獎」抽出得獎者', '/#/raffle/' + encodeURIComponent(s.id + '~' + r.id), 'rafdue-' + r.id);
        await r.ref.update({ dueNoted: now }); }
    } catch (e) { logger.warn('raffleDue', s.id, e.message); }
  }
});
// 競標開始：推給追蹤這個賣場的人（和收藏這株的人）；指定起標時間的到點才推，上架即開始的上架後馬上推
exports.pushAuctionStart = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now();
  for (const sd of await db.collection('shops').listDocuments()) {
    let snap; try { snap = await sd.collection('plants').where('mode', '==', 'auction').get(); } catch (e) { continue; }
    for (const d of snap.docs) {
      const p = { id: d.id, shop: sd.id, ...d.data() };
      if (p.startNoted || p.status === 'sold' || p.listed === false || p.blocked || !p.endsAtMs || p.endsAtMs <= now) continue;
      const st = +p.startsAtMs || +p.aucStartAt || 0;
      if (!st) { await d.ref.update({ startNoted: true }).catch(() => {}); continue; } // 舊的競標：不補推
      if (st > now) continue;
      await d.ref.update({ startNoted: now }).catch(() => {});
      if (now - st > 15 * 6e4) continue; // 太久以前開始的不推
      const who = new Set(); try { (await db.collection('social').where('follows', 'array-contains', sd.id).get()).forEach(x => who.add(x.id)); } catch (e) {}
      try { for (const u of await favoredBy(d.id)) who.add(u); } catch (e) {}
      who.delete(sd.id);
      const sn = await displayName(sd.id), mins = Math.round((p.endsAtMs - st) / 6e4), len = mins < 120 ? mins + ' 分鐘' : mins < 2880 ? Math.round(mins / 60) + ' 小時' : Math.round(mins / 1440) + ' 天';
      for (const u of who) { try { await push(u, '⚡ ' + sn + ' 開始競標了', pLabel(p) + ' 起標 ' + nt(p.startPrice || 0) + '，競標 ' + len + '，快來出價', '/#/plant/' + d.id, 'aucstart-' + d.id); } catch (e) {} }
      logger.info('auction start pushed', { pid: d.id, n: who.size });
    }
  }
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
        await push(p.shop, '🔨 競標結束，訂單已自動成立', pLabel(p) + ' 由 ' + (await displayName(win.uid)) + ' 以 ' + nt(win.amt) + ' 得標', '/#orders/orders', 'end-' + d.id); }
      else await push(p.shop, '🔨 競標結束（沒人出價）', pLabel(p) + ' 可以改成直購或重新競標', '/#admin/auc', 'end-' + d.id);
      await mk.set({ at: now, pid: d.id, shop: sd.id });
    }
  }
});

// ===== 競標焦點推播：管理員打開焦點（或活動開始）的那一刻推一次，之後每經過 10% 的時間再推一次；只在 09:00–22:00 推 =====
const twHour = t => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Taipei', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
const awake = t => { const h = twHour(t); return h >= 9 && h < 22; };
const twParse = v => { if (!v) return 0; if (typeof v === 'number') return v; const s = String(v); const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + (s.length <= 16 ? ':00' : '') + '+08:00'); return isNaN(t) ? 0 : t; };
const leftTxt = ms => { const m = Math.max(0, Math.round(ms / 6e4)); const d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mm = m % 60; return d ? d + ' 天 ' + h + ' 小時' : h ? h + ' 小時 ' + mm + ' 分' : mm + ' 分鐘'; };
async function allPushUsers() { const out = []; for (const col of await db.doc('data/users').listCollections()) { try { const s = await col.doc('push').collection('devices').limit(1).get(); if (!s.empty) out.push(col.id); } catch (e) {} } return out; }
async function broadcast(title, body, link, tag) { let n = 0; for (const u of await allPushUsers()) { try { n += await push(u, title, body, link, tag); } catch (e) {} } return n; }
// 回傳這次要推的進度（0＝剛開始、1–9＝經過 10%–90%），沒有就回 null
async function spotStep(key, start, end, now) {
  if (!start || !end || end <= start || now >= end || now < start) return null;
  const step = Math.min(9, Math.floor((now - start) / (end - start) * 10)), mk = db.doc('sysnotes/' + key), d = await mk.get(), last = d.exists ? d.data().last : -1;
  if (step <= last || !awake(now)) return null;
  return { step, done: () => mk.set({ last: step, at: now }) };
}
exports.pushSpotlight = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now(), sd = await db.doc('site/spot').get(); if (!sd.exists) return; const spot = sd.data(); if (spot.push === false) return;
  // 單株焦點
  for (const [pid, cfg] of Object.entries(spot.plants || {})) {
    if (!cfg || !cfg.fx || cfg.on === false || cfg.push === false) continue;
    const p = await findPlant(pid, cfg.shop); if (!p || p.status === 'sold' || p.hidden || !p.endsAtMs) continue;
    const bids = await allBids(pid), end = effEnd(p, bids), start = cfg.at || now, top = leaderAt(p, bids, end);
    const st = await spotStep('spot-' + pid + '-' + (cfg.at || 0), start, end, now); if (!st) continue;
    const price = top ? '目前最高 ' + nt(top.amt) : '起標 ' + nt(p.startPrice), label = cfg.label || '焦點競標', name = pLabel(p);
    const title = st.step === 0 ? '👑 ' + label + '：' + name : st.step >= 9 ? '🔥 快結標了：' + name : '⚡ ' + label + '：' + name;
    const body = (st.step === 0 ? '開放出價中，' : '') + price + '，剩 ' + leftTxt(end - now);
    const n = await broadcast(title, body, '/#/plant/' + pid, 'spot-' + pid); await st.done(); logger.info('spotlight push', { pid, step: st.step, sent: n });
  }
  // 競標活動（整個活動推一則）
  for (const [id, e] of Object.entries(spot.events || {})) {
    if (!e || e.on === false || e.push === false || !(e.ids || []).length) continue;
    const ps = (await Promise.all(e.ids.map(i => findPlant(i)))).filter(p => p && !p.hidden && p.endsAtMs);
    const ends = []; for (const p of ps) { if (p.status === 'sold') continue; ends.push(effEnd(p, await allBids(p.id))); }
    const start = Math.max(twParse(e.from), e.at || 0), end = twParse(e.to) || (ends.length ? Math.max(...ends) : 0); if (!ends.length) continue;
    const st = await spotStep('spotev-' + id + '-' + (e.at || 0), start, end, now); if (!st) continue;
    const liveN = ends.filter(t => t > now).length, next = Math.min(...ends.filter(t => t > now));
    const title = st.step === 0 ? '🏆 ' + (e.name || '競標活動') + ' 開始了' : st.step >= 9 ? '🔥 ' + (e.name || '競標活動') + ' 最後衝刺' : '🏆 ' + (e.name || '競標活動') + ' 進行中';
    const body = (e.sub ? e.sub + '｜' : '') + liveN + ' 株競標中' + (isFinite(next) ? '，最快 ' + leftTxt(next - now) + ' 後結標' : '');
    const n = await broadcast(title, body, '/#/store/auction', 'spotev-' + id); await st.done(); logger.info('event push', { id, step: st.step, sent: n });
  }
});

// ===== 訂單沒人處理就一直提醒賣家：新訂單 2、6、12、24 小時；買家已匯款 6、24 小時（只在 08:00–23:00） =====
const awakeOrd = t => { const h = twHour(t); return h >= 8 && h < 23; };
exports.pushOrderNag = onSchedule({ schedule: 'every 30 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now(); if (!awakeOrd(now)) return;
  const steps = { pending: [2, 6, 12, 24], paid: [6, 24] };
  for (const sd of await db.collection('social').get().then(s => s.docs)) {
    for (const [oid, o] of Object.entries(sd.data().orders || {})) {
      if (!o || !o.seller || !o.at || now - o.at > 3 * 864e5 || o.cancelled || o.cancelledBy || o.status === 'cancelled') continue; // 已取消的訂單不再提醒
      let st = 'pending', base = o.at;
      try { const so = await db.doc(`shops/${o.seller}/orders/${oid}`).get(); if (so.exists) { st = so.data().status; base = so.data().paidAt || so.data().updatedAt || o.at; } } catch (e) { continue; }
      if (!steps[st]) continue;
      const hrs = (now - base) / 36e5, lv = steps[st].filter(x => hrs >= x).pop(); if (!lv) continue;
      const mk = db.doc(`sysnotes/nag-${oid}-${st}-${lv}`); if ((await mk.get()).exists) continue;
      const who = await displayName(sd.id);
      if (st === 'pending') await push(o.seller, '⏰ 訂單等你確認 ' + lv + ' 小時了', who + ' 下單 ' + nt(o.total) + '，買家在等你回覆，點這裡確認', '/#orders/orders', 'order-' + oid);
      else await push(o.seller, '💳 買家已匯款 ' + lv + ' 小時，還沒對帳', who + ' 的訂單 ' + nt(o.total) + '，對帳後按「確認收款」', '/#orders/orders', 'paid-' + oid);
      await mk.set({ at: now }); logger.info('order nag', { oid, st, lv });
    }
  }
});

// 現場轉讓請求 → 目前主人（5 分鐘內要確認）
exports.pushXreq = onDocumentCreated('xreq/{id}', async ev => {
  const x = ev.data?.data(); if (!x || !x.owner || x.status !== 'open') return;
  await push(x.owner, '🤝 ' + (await displayName(x.from)) + ' 請求轉讓 ' + (x.code || ''), (x.via === 'nfc' ? '對方在現場碰了 NFC，' : '對方掃了你的轉移 QR，') + '請在 5 分鐘內打開 VEIN 確認轉移', '/#/plant/' + x.pid, 'xreq-' + ev.params.id);
});

// 好友：收到邀請、對方接受
exports.pushFriend = onDocumentWritten('friends/{id}', async ev => {
  const b = ev.data?.before?.exists ? ev.data.before.data() : null, a = ev.data?.after?.exists ? ev.data.after.data() : null; if (!a) return;
  const other = (a.u || []).find(u => u !== a.from); if (!other) return;
  if (!b && a.status === 'pending') await push(other, '👥 ' + (await displayName(a.from)) + ' 想加你好友', '打開 VEIN 按「接受」就成為好友', '/#/me', 'fr-' + ev.params.id);
  else if (b && b.status !== 'ok' && a.status === 'ok') await push(a.from, '🎉 ' + (await displayName(other)) + ' 接受了你的好友邀請', '現在可以聊天、建群組、直接轉移或代管植物', '/#/me', 'fr-' + ev.params.id);
});

// 代管：交給別人代管 → 通知代管人；代管人申請上架／轉移 → 通知原主確認
exports.pushCust = onDocumentCreated('cust/{id}', async ev => {
  const x = ev.data?.data(); if (!x || !x.owner || !x.cust) return;
  if (x.k === 'set') await push(x.cust, '🧑‍🌾 ' + (await displayName(x.owner)) + ' 把植物交給你代管', (x.code || '') + ' ' + (x.name || '') + '，打開植物管理就能照顧與上架', '/#admin/reg', 'cust-' + ev.params.id);
  else if (x.status === 'pending') await push(x.owner, '📨 代管申請：' + (x.k === 'list' ? '上架' : '轉移') + ' ' + (x.code || ''), (await displayName(x.cust)) + ' 申請' + (x.k === 'list' ? '上架這株' : '把這株轉給 ' + ((x.data || {}).toName || '別人')) + '，請到植物管理按確認', '/#admin/reg', 'cust-' + ev.params.id);
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

// ================= 定期清理（每天凌晨）=================
// 聊天：超過 1 年的訊息刪除；整個對話 1 年沒動就整個刪
// 訂單留言：1 年前的刪除；競標觀戰：人數心跳 1 天、歡呼 7 天；系統標記 60 天；轉移請求／面對面 QR 7 天
// 植物頁：2 年沒有任何更新、沒上架、沒賣出、沒轉手、沒有後代的，先通知持有人並標記 30 天後刪除；持有人按「保留」就取消
const DAY = 864e5;
const tms = v => { if (!v) return 0; if (typeof v === 'number') return v; if (v.toMillis) return v.toMillis(); if (v._seconds) return v._seconds * 1000; const n = Date.parse(String(v).replace(' ', 'T')); return isNaN(n) ? 0 : n; };
async function delQuery(q, max = 2000) { let n = 0; while (n < max) { const sn = await q.limit(300).get(); if (sn.empty) break; const b = db.batch(); sn.docs.forEach(d => b.delete(d.ref)); await b.commit(); n += sn.size; if (sn.size < 300) break; } return n; }
async function delCol(col, max = 5000) { return delQuery(col, max); }
exports.retention = onSchedule({ schedule: '10 4 * * *', timeZone: 'Asia/Taipei', timeoutSeconds: 540, memory: '512MiB' }, async () => {
  const now = Date.now(), stat = { chatMsg: 0, chats: 0, ordMsg: 0, watch: 0, notes: 0, xr: 0, warned: 0, purged: 0 };
  // 聊天
  try { for (const c of (await db.collection('chats').get()).docs) { const last = tms((c.data().last || {}).at) || tms(c.data().updatedAt);
      if (last && last < now - 365 * DAY) { stat.chatMsg += await delCol(c.ref.collection('messages')); await c.ref.delete(); stat.chats++; }
      else stat.chatMsg += await delQuery(c.ref.collection('messages').where('at', '<', now - 365 * DAY), 1000); } } catch (e) { logger.warn('ret chats', e.message); }
  // 訂單留言
  try { for (const sh of await db.collection('ordmsg').listDocuments()) for (const o of await sh.collection('o').listDocuments()) stat.ordMsg += await delQuery(o.collection('m').where('at', '<', now - 365 * DAY), 1000); } catch (e) { logger.warn('ret ordmsg', e.message); }
  // 觀戰
  try { for (const w of await db.collection('watch').listDocuments()) { stat.watch += await delQuery(w.collection('v').where('at', '<', now - DAY), 2000); stat.watch += await delQuery(w.collection('c').where('at', '<', now - 7 * DAY), 2000); } } catch (e) { logger.warn('ret watch', e.message); }
  // 系統標記、暫時性的請求
  try { for (const [col, days] of [['sysnotes', 60], ['xqr', 7], ['xreq', 7]]) { const sn = await db.collection(col).get(); const b = []; sn.docs.forEach(d => { const at = tms(d.data().at) || tms(d.data().createdAt) || d.createTime.toMillis(); if (at < now - days * DAY) b.push(d.ref); });
      for (let i = 0; i < b.length; i += 300) { const bt = db.batch(); b.slice(i, i + 300).forEach(r => bt.delete(r)); await bt.commit(); } if (col === 'sysnotes') stat.notes += b.length; else stat.xr += b.length; } } catch (e) { logger.warn('ret notes', e.message); }
  // 植物頁
  try {
    const owners = new Set((await db.collection('owners').listDocuments()).map(d => d.id)), warnBy = new Map();
    for (const sd of await db.collection('shops').listDocuments()) {
      const ps = (await sd.collection('plants').get()).docs.map(d => ({ ref: d.ref, id: d.id, ...d.data() }));
      const parents = new Set(); ps.forEach(p => { [p.momId, p.parentId, p.dadId].forEach(x => x && parents.add(x)); });
      for (const p of ps) {
        const last = Math.max(tms(p.createdAt), tms(p.updatedAt), tms(p.lastPhotoAt), tms(p.listedAt), tms(p.keptAt), tms(p.endsAtMs) || 0);
        const onSale = p.listed !== false && p.status !== 'keep' && (p.mode === 'auction' || p.price || p.price === 0);
        const keep = !last || last > now - 730 * DAY || p.status === 'sold' || p.buyer || owners.has(p.id) || parents.has(p.id) || onSale || p.grp;
        if (keep) { if (p.purgeAt) await p.ref.update({ purgeAt: null }).catch(() => {}); continue; }
        if (!p.purgeAt) { const at = now + 30 * DAY; await p.ref.update({ purgeAt: at }).catch(() => {}); const L = warnBy.get(sd.id) || []; L.push(p); warnBy.set(sd.id, L); stat.warned++; continue; }
        if (p.purgeAt < now) { await delCol(p.ref.collection('photos')).catch(() => {}); await p.ref.delete(); stat.purged++; logger.info('plant purged', { shop: sd.id, pid: p.id, code: p.code }); }
      }
    }
    for (const [u, L] of warnBy) { const d = new Date(now + 30 * DAY + 8 * 36e5); const ds = (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
      await push(u, '🗂 ' + L.length + ' 株植物 2 年沒有更新', (L.slice(0, 3).map(p => p.code).join('、') + (L.length > 3 ? ' 等' : '')) + ' 將在 ' + ds + ' 清除，要保留請打開按「保留」', '/#plants/reg', 'purge-' + u).catch(() => {}); }
  } catch (e) { logger.warn('ret plants', e.message); }
  logger.info('retention', stat);
});

// ================= 精選點數：置頂精選（1 點／24 小時）、商店精選（10 點／3 天，每批 5 個）=================
const FEAT_BASE = Date.UTC(2026, 10, 1) - 8 * 36e5, FEAT_LEN = 3 * 864e5, FEAT_MAX = 5, PIN_COST = 1, FEAT_COST = 10, PIN_MS = 864e5, MONTHLY = 20;
const monthKey = (t = Date.now()) => new Date(t + 8 * 36e5).toISOString().slice(0, 7);
async function isVerifiedSeller(uid) {
  try { const v = await db.doc('site/verified').get(); const x = ((v.exists && v.data().uids) || {})[uid]; if (x && !(typeof x === 'object' && x.until && x.until < Date.now())) return true; } catch (e) {}
  try { const s = await db.doc('site/sellers').get(); if (s.exists && s.data().house === uid) return true; } catch (e) {}
  try { const a = await db.doc('site/admins').get(); if (a.exists && (a.data().uids || {})[uid]) return true; } catch (e) {}
  return false;
}
// 每月補點：交易裡先補（這個月還沒補過就補到 20）
function refill(cur, now) { const mk = monthKey(now); if (cur.mon === mk) return cur; const bal = Math.max(cur.bal || 0, MONTHLY), d = bal - (cur.bal || 0);
  return { ...cur, bal, mon: mk, log: d ? [...(cur.log || []), { d, why: mk + ' 每月補充', at: now }].slice(-50) : (cur.log || []) }; }
exports.boostProcess = onDocumentCreated('boostReq/{id}', async ev => {
  const r = ev.data?.data(), ref = ev.data.ref; if (!r || !r.uid) return; const now = Date.now();
  const done = (status, msg, extra) => ref.update({ status, msg: msg || '', doneAt: Date.now(), ...(extra || {}) }).catch(() => {});
  if (!(await isVerifiedSeller(r.uid))) return done('fail', '認證賣家才能使用');
  const pref = db.doc('pts/' + r.uid);
  try {
    if (r.kind === 'sync') { await db.runTransaction(async tx => { const d = await tx.get(pref); const cur = d.exists ? d.data() : { bal: 0, log: [] }; tx.set(pref, refill(cur, now)); }); return done('ok'); }
    const plRef = db.doc(`shops/${r.uid}/plants/${r.pid}`);
    if (r.kind === 'pin') {
      await db.runTransaction(async tx => { const [d, pl] = await Promise.all([tx.get(pref), tx.get(plRef)]);
        if (!pl.exists) throw new Error('找不到這株'); const p = pl.data(); if (p.status === 'sold' || p.listed === false || p.blocked) throw new Error('這株目前沒有在販售');
        const cur = refill(d.exists ? d.data() : { bal: 0, log: [] }, now); if ((cur.bal || 0) < PIN_COST) throw new Error('點數不夠');
        const until = Math.max(now, +p.pinUntil || 0) + PIN_MS;
        tx.set(pref, { ...cur, bal: cur.bal - PIN_COST, log: [...(cur.log || []), { d: -PIN_COST, why: '置頂 ' + (p.code || ''), at: now }].slice(-50) });
        tx.update(plRef, { pinUntil: until }); });
      return done('ok');
    }
    if (r.kind === 'feat') {
      const cur0 = Math.floor((now - FEAT_BASE) / FEAT_LEN), b = Math.round(+r.b);
      if (!(b >= cur0 && b <= cur0 + 10)) return done('fail', '這個日期不能申請');
      const fRef = db.doc('feat/' + b);
      await db.runTransaction(async tx => { const [d, pl, f] = await Promise.all([tx.get(pref), tx.get(plRef), tx.get(fRef)]);
        if (!pl.exists) throw new Error('找不到這株'); const p = pl.data(); if (p.status === 'sold' || p.listed === false || p.blocked) throw new Error('這株目前沒有在販售');
        const slots = f.exists ? (f.data().slots || []) : []; if (slots.length >= FEAT_MAX) throw new Error('這一批已經滿了'); if (slots.some(x => x.pid === r.pid)) throw new Error('這株已經在這一批了');
        const cur = refill(d.exists ? d.data() : { bal: 0, log: [] }, now); if ((cur.bal || 0) < FEAT_COST) throw new Error('點數不夠');
        tx.set(pref, { ...cur, bal: cur.bal - FEAT_COST, log: [...(cur.log || []), { d: -FEAT_COST, why: '商店精選 ' + (p.code || ''), at: now }].slice(-50) });
        tx.set(fRef, { start: FEAT_BASE + b * FEAT_LEN, end: FEAT_BASE + (b + 1) * FEAT_LEN, slots: [...slots, { uid: r.uid, pid: r.pid, at: now }] }); });
      return done('ok');
    }
    return done('fail', '未知的申請');
  } catch (e) { return done('fail', e.message || '請稍後再試'); }
});
// 每月 1 號凌晨：所有認證賣家補到 20 點
exports.ptsMonthly = onSchedule({ schedule: '3 0 1 * *', timeZone: 'Asia/Taipei' }, async () => {
  const v = await db.doc('site/verified').get(), now = Date.now(); const ids = Object.entries((v.exists && v.data().uids) || {}).filter(([, x]) => !(typeof x === 'object' && x.until && x.until < now)).map(([u]) => u);
  for (const u of ids) { try { await db.runTransaction(async tx => { const r = db.doc('pts/' + u), d = await tx.get(r); tx.set(r, refill(d.exists ? d.data() : { bal: 0, log: [] }, now)); }); } catch (e) {} }
  logger.info('pts monthly', { n: ids.length });
});

// 賣場改名：送出申請 → 通知管理員；審核結果 → 通知賣家
exports.pushShopName = onDocumentUpdated('shops/{uid}', async ev => {
  const b = ev.data.before.data() || {}, a = ev.data.after.data() || {}, uid = ev.params.uid;
  const bq = b.nameReq && b.nameReq.name, aq = a.nameReq && a.nameReq.name;
  if (aq && aq !== bq) { try { const ad = await db.doc('site/admins').get(); const L = ad.exists ? (Array.isArray(ad.data().uids) ? ad.data().uids : Object.keys(ad.data().uids || {})) : []; try { const sl = await db.doc('site/sellers').get(); if (sl.exists && sl.data().house && !L.includes(sl.data().house)) L.push(sl.data().house); } catch (e) {}
      for (const u of L) await push(u, '✏️ 賣場改名申請', (b.name || '') + ' → ' + aq, '/#admin/sellers', 'rename-' + uid); } catch (e) {} }
  if (bq && !aq) { if (a.name === bq && b.name !== a.name) await push(uid, '✅ 賣場改名通過', '現在的名稱：' + a.name, '/#/seller/' + uid, 'rename-' + uid);
    else if (a.nameRej && a.nameRej.name === bq) await push(uid, '賣場改名沒有通過', '「' + bq + '」' + (a.nameRej.why ? '：' + a.nameRej.why : ''), '/#admin/shop:basic', 'rename-' + uid); }
});

// ===================== 遭遇戰：收服判定（伺服器擲骰，避免作弊）=====================
// 價格公式和網站一致：
//  HP = 時間剩下的比例 ×（1 − 攻擊量/5000）²；回血＝時間倒回、攻擊扣回；HP 越低攻擊越沒力，但一定打得完
//  攻擊量 = 全場總攻擊次數 × 人數倍率＝人數 ÷ 10（最高 ×5）→ 一個人打要超久，人多很快
const encT0 = p => +p.startsAtMs || +p.aucStartAt || tms(p.listedAt || p.createdAt) || 0;
const encCrowd = u => Math.min(5, Math.max(0, u) / 10);
const ENC_FULL = 2500, ENC_GRACE = 45000, ENC_SHOW = 3200; // 開場 45 秒集合時間；收服動畫 3.2 秒，大家一起看完才公布；每人 6 秒可再收服一次
// 攻擊次數只記全場加總：encAgg/{植物_這場開始時間}/s/{0~7}（每個人固定寫一格），加起來就是總攻擊數與參加人數
const encRid = p => p.id + '_' + encT0(p);
async function encHitsN(p) { let N = 0, u = 0; try { (await db.collection('encAgg/' + encRid(p) + '/s').get()).forEach(d => { const v = d.data(); N += +v.n || 0; u += +v.u || 0; }); } catch (e) {} return { N, u }; }
function encCalc(p, hits, now) {
  const S0 = +p.encStart, F = Math.min(Math.max(0, +p.encFloor || 0), S0), R = Math.max(0, S0 - F), dur = Math.max(6e4, +p.encDecay || 36e5);
  const tf = Math.max(0, Math.min(1, (Math.max(0, now - encT0(p) - ENC_GRACE) - (+p.encHealMs || 0)) / dur)), A = Math.max(0, (hits.N || 0) * encCrowd(hits.u || 0) - (+p.encHealA || 0)), ha = Math.pow(Math.max(0, 1 - A / ENC_FULL), 2), base = (1 - tf) * ha;
  // 回血用「把時間倒回去、把攻擊量扣回去」的方式記，之後時間和攻擊照樣會把它扣掉，一路掉得到最低價（舊的 encHealHp 也跟著衰減）
  const hp = Math.max(0, Math.min(1, base + (+p.encHealHp || 0) * Math.sqrt(base))), step = R >= 2000 ? 10 : 1, price = Math.max(F, Math.min(S0, Math.round((F + R * hp) / step) * step));
  return { price, hp: R ? (price - F) / R : 0, floor: hp <= 0.0005, dur, raw: hp, tf, A, ha };
}
const encIdle = p => +p.encIdle || 10 * 6e4;
function encLiveAt(p, now) {
  if (p.mode !== 'encounter' || !(+p.encStart > 0) || p.encDone || p.status === 'sold' || p.status === 'reserved' || p.listed === false || p.blocked) return false;
  if (+p.startsAtMs > now) return false; let end = +p.endsAtMs || Infinity; if (p.encFloorAt) end = Math.min(end, +p.encFloorAt + encIdle(p)); return now < end;
}
const encChance = hp => 0.10 + 0.85 * Math.pow(Math.max(0, Math.min(1, hp)), 1.6);
const ENC_CD = 6000;
exports.encTry = onDocumentCreated({ document: 'encTry/{id}', ...HOT }, async ev => {
  const t = ev.data.data() || {}, ref = ev.data.ref, now = Date.now();
  const done = (o) => ref.update({ ...o, doneAt: Date.now() }).catch(() => {});
  if (!t.uid || !t.pid || !t.shop || t.res) return;
  try { const bn = await db.doc('encBan/' + t.uid).get(); if (bn.exists && (bn.data().perm || +bn.data().until > now)) return done({ res: 'ban' }); } catch (e) {}
  const cdRef = db.doc('encCd/' + t.pid + '~' + t.uid);
  try { const cd = await cdRef.get(); if (cd.exists && now - (+cd.data().at || 0) < ENC_CD) return done({ res: 'cd', cd: ENC_CD - (now - cd.data().at) }); } catch (e) {}
  const pref = db.doc(`shops/${t.shop}/plants/${t.pid}`);
  let out;
  try {
    out = await db.runTransaction(async tx => {
      const s = await tx.get(pref); if (!s.exists) return { res: 'late' };
      const p = { id: t.pid, shop: t.shop, ...s.data() }, n2 = Date.now();
      if (!encLiveAt(p, n2) || t.uid === t.shop) return { res: 'late' };
      if (n2 < encT0(p) + ENC_GRACE) return { res: 'ready' };
      if (p.encCatch && n2 < +p.encCatch.until) return { res: 'wait' };
      const hits = await encHitsN(p);
      // 丟出就一定收服（先到先得）。成交價＝伺服器現在的價格，但不會比買家按下時看到的貴；
      // 買家手機時間不準看到比較低的價格時，最多只讓 4%（避免調手機時間占便宜）
      const c = encCalc(p, hits, n2), S0 = +p.encStart, F = Math.min(Math.max(0, +p.encFloor || 0), S0), tol = Math.max(10, (S0 - F) * 0.04), want = Math.round(+t.price || 0);
      const pay = want ? Math.max(F, Math.min(c.price, Math.max(want, c.price - tol))) : c.price;
      tx.update(pref, { status: 'reserved', buyer: t.uid, soldPrice: pay, encDone: { uid: t.uid, price: pay, at: n2 }, encCatch: { id: ev.params.id, uid: t.uid, at: n2, until: n2 + ENC_SHOW, ok: true, heal: 0 }, updatedAt: n2 });
      return { res: 'ok', price: pay, chance: 100, until: n2 + ENC_SHOW, p };
    });
  } catch (e) { logger.warn('encTry', e.message); return done({ res: 'busy' }); }
  if (out.res === 'ok') {
    const oid = now.toString(36) + Math.random().toString(36).slice(2, 6);
    try { await db.doc('social/' + t.uid).set({ orders: { [oid]: { seller: t.shop, items: [t.pid], total: out.price, note: '⚔ 遭遇戰收服', payMethod: 'transfer', src: 'enc', at: now } } }, { merge: true }); } catch (e) { logger.warn('encOrder', e.message); }
    try { await push(t.uid, '🎉 收服成功', pLabel(out.p) + ' 以 ' + nt(out.price) + ' 收服，訂單已成立', '/#orders/orders', 'enc-' + t.pid); } catch (e) {}
  }
  if (out.res === 'ok' || out.res === 'fail') await cdRef.set({ at: Date.now() }).catch(() => {});
  const { p, ...rest } = out; await done(rest);
});
// 遭遇戰：開始時推給追蹤的人；價格掉到最低時記下時間（之後多久沒人收服就結束）
async function encChatClear(rid) { const col = db.collection('encChat/' + rid + '/m'); for (let i = 0; i < 40; i++) { const s = await col.limit(400).get(); if (s.empty) break; const b = db.batch(); s.docs.forEach(x => b.delete(x.ref)); await b.commit(); } }
exports.encSweep = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now();
  for (const sd of await db.collection('shops').listDocuments()) {
    let snap; try { snap = await sd.collection('plants').where('mode', '==', 'encounter').get(); } catch (e) { continue; }
    for (const d of snap.docs) {
      const p = { id: d.id, shop: sd.id, ...d.data() };
      // 遊戲結束 1 分鐘後清掉這場的即時聊天
      if (!encLiveAt(p, now)) { const t0 = encT0(p), endAt = p.encDone ? +p.encDone.at + ENC_SHOW : p.encClosed ? (+p.updatedAt || now) : Math.min(+p.endsAtMs || Infinity, p.encFloorAt ? +p.encFloorAt + encIdle(p) : Infinity);
        const rid = encRid(p); if (t0 && t0 <= now && isFinite(endAt) && now > endAt + 6e4 && p.encChatClr !== rid) { try { await encChatClear(rid); await d.ref.update({ encChatClr: rid }); } catch (e) { logger.warn('encChatClear', e.message); } }
        continue; }
      if (!p.encFloorAt) { const c = encCalc(p, await encHitsN(p), now); if (c.floor) await d.ref.update({ encFloorAt: now }).catch(() => {}); }
      if (!p.startNoted && encT0(p) <= now) {
        await d.ref.update({ startNoted: now }).catch(() => {});
        if (now - encT0(p) > 15 * 6e4) continue;
        const who = new Set(); try { (await db.collection('social').where('follows', 'array-contains', sd.id).get()).forEach(x => who.add(x.id)); } catch (e) {}
        try { for (const u of await favoredBy(d.id)) who.add(u); } catch (e) {} who.delete(sd.id);
        const sn = await displayName(sd.id);
        for (const u of who) { try { await push(u, '⚔ 野生的植物出現了！', sn + ' 的 ' + pLabel(p) + ' 從 ' + nt(p.encStart) + ' 開始降價，快來收服', '/#/plant/' + d.id, 'enc-' + d.id); } catch (e) {} }
      }
    }
  }
  // 福利組合：開搶時推給追蹤的人
  try {
    for (const d of (await db.collection('drops').where('notified', '==', false).get()).docs) {
      const x = d.data(); if (+x.at > now) continue; await d.ref.update({ notified: now }).catch(() => {}); if (now - x.at > 15 * 6e4) continue;
      const who = new Set(); try { (await db.collection('social').where('follows', 'array-contains', x.shop).get()).forEach(s => who.add(s.id)); } catch (e) {} who.delete(x.shop);
      const sn = await displayName(x.shop);
      for (const u of who) { try { await push(u, '🎁 ' + sn + ' 福利組合開搶！', (x.title || '福利組合') + ' · ' + (x.bundles || []).length + ' 組，先搶先贏', '/#/seller/' + x.shop, 'drop-' + d.id); } catch (e) {} }
    }
  } catch (e) { logger.warn('dropNotify', e.message); }
});

// ===================== 管理員推播：送給全站（或只送賣家／買家）=====================
exports.broadcast = onDocumentCreated({ document: 'broadcast/{id}', timeoutSeconds: 300, memory: '512MiB' }, async ev => {
  const x = ev.data.data() || {}, ref = ev.data.ref; if (!x.title || x.done) return;
  // 指定對象（例如：邀請勾選的認證賣家）→ 只推給這些人
  if (Array.isArray(x.uids)) { let sent = 0; for (const u of [...new Set(x.uids)].slice(0, 300)) { try { sent += await push(String(u), x.title, x.body || '', x.link || '/', 'bc-' + ev.params.id); } catch (e) {} }
    await ref.update({ done: true, sent, users: x.uids.length, doneAt: Date.now() }).catch(() => {}); return; }
  try {
    const ad = await db.doc('site/admins').get(), A = ad.exists ? (Array.isArray(ad.data().uids) ? ad.data().uids : Object.keys(ad.data().uids || {})) : [];
    const sl = await db.doc('site/sellers').get(), house = sl.exists ? sl.data().house : null, approved = sl.exists ? (sl.data().approved || {}) : {};
    // 只有管理員能建立（資料庫規則已把關）
    const per = new Map();
    (await db.collectionGroup('devices').get()).forEach(d => { const p = d.ref.path.split('/'); if (p[0] !== 'data' || p[1] !== 'users' || p[3] !== 'push') return; const v = d.data(); if (!v.token || v.on === false) return;
      const uid = p[2], key = v.dev || ((v.ua || '') + '|' + (v.scr || '')) || v.token; if (!per.has(uid)) per.set(uid, new Map()); const m = per.get(uid), o = m.get(key);
      if (!o || (+v.at || 0) > o.at) m.set(key, { token: v.token, at: +v.at || 0, ref: d.ref }); });
    const T = []; for (const [uid, m] of per) { const isS = !!approved[uid]; if (x.target === 'sellers' && !isS) continue; if (x.target === 'buyers' && isS) continue; for (const v of m.values()) T.push(v); }
    const seen = new Set(), L = T.filter(v => !seen.has(v.token) && seen.add(v.token));
    let sent = 0, fail = 0;
    for (let i = 0; i < L.length; i += 500) {
      const part = L.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({ tokens: part.map(v => v.token), data: { title: x.title, body: x.body || '', link: x.link || '/', tag: 'bc-' + ev.params.id },
        webpush: { headers: { Urgency: 'high', TTL: '86400' }, fcmOptions: { link: SITE + (x.link || '/') } } });
      sent += res.successCount; fail += res.failureCount;
      await Promise.all(res.responses.map((r, k) => (!r.success && /registration-token-not-registered|invalid-argument|invalid-registration/.test(r.error?.code || '')) ? part[k].ref.delete().catch(() => {}) : null));
    }
    await ref.update({ done: true, sent, fail, users: per.size, doneAt: Date.now() });
    logger.info('broadcast', { id: ev.params.id, sent, fail });
  } catch (e) { logger.warn('broadcast', e.message); await ref.update({ done: true, sent: 0, err: e.message }).catch(() => {}); }
});

// 遭遇戰收服後，買家申請取消（賣家同意）→ 記一次：第一次鎖 1 週、第二次 1 個月、第三次永久
async function encStrike(uid, shop, oid) {
  const so = await db.doc('social/' + uid).get(), o = so.exists ? (so.data().orders || {})[oid] : null;
  if (!o || !o.cancelReq || o.cancelledBy === 'agree') return; // 賣家提出、買家同意的不算
  const ref = db.doc('encBan/' + uid);
  const r = await db.runTransaction(async tx => { const s = await tx.get(ref), cur = s.exists ? s.data() : { n: 0, log: [] };
    if ((cur.log || []).some(x => x.oid === oid)) return null;
    const n = (cur.n || 0) + 1, now = Date.now(), until = n >= 3 ? 0 : now + (n === 1 ? 7 : 30) * 864e5;
    tx.set(ref, { n, perm: n >= 3, until, log: [...(cur.log || []), { oid, shop, at: now }].slice(-20), at: now }); return { n, until }; });
  if (!r) return;
  await push(uid, '⚠️ 遭遇戰功能已鎖定', r.n >= 3 ? '你已第 3 次取消遭遇戰訂單，遭遇戰功能永久鎖定' : '你取消了遭遇戰訂單（第 ' + r.n + ' 次），遭遇戰功能鎖定 ' + (r.n === 1 ? '1 週' : '1 個月'), '/#/raffle', 'encban');
}

/* ===== 植友社群：按讚、留言、投票的計數與通知（用戶端不能自己改數字） ===== */
const { onDocumentDeleted } = require('firebase-functions/v2/firestore');
const INC = n => admin.firestore.FieldValue.increment(n);
const pstat = (uid, k, n) => uid ? db.doc('pstat/' + uid).set({ [k]: INC(n), at: Date.now() }, { merge: true }).catch(() => {}) : null;
async function postOf(id) { try { const d = await db.doc('posts/' + id).get(); return d.exists ? d.data() : null; } catch (e) { return null; } }
exports.cmPostNew = onDocumentCreated({ document: 'posts/{id}', ...HOT }, async ev => { const p = ev.data.data() || {}; await pstat(p.uid, 'posts', 1); });
exports.cmPostDel = onDocumentDeleted({ document: 'posts/{id}', ...HOT }, async ev => { const p = ev.data.data() || {}; await pstat(p.uid, 'posts', -1); if (p.feat) await pstat(p.uid, 'feat', -1); });
exports.cmPostUpd = onDocumentUpdated({ document: 'posts/{id}', ...HOT }, async ev => { const a = ev.data.before.data() || {}, b = ev.data.after.data() || {};
  if (!a.feat && b.feat) { await pstat(b.uid, 'feat', 1); await push(b.uid, '⭐ 你的文章被選為精選', '「' + String(b.title || '').slice(0, 30) + '」出現在社群精選了', '/#/post/' + ev.params.id, 'feat-' + ev.params.id); }
  else if (a.feat && !b.feat) await pstat(b.uid, 'feat', -1); });
exports.cmLikeNew = onDocumentCreated({ document: 'posts/{id}/likes/{uid}', ...HOT }, async ev => { const id = ev.params.id, u = ev.params.uid;
  await db.doc('posts/' + id).update({ likes: INC(1) }).catch(() => {}); const p = await postOf(id); if (!p) return; await pstat(p.uid, 'likes', 1);
  if (p.uid !== u) { const lk = +p.likes || 0; if (lk <= 3 || [10, 50, 100, 500, 1000].includes(lk)) await push(p.uid, '♥ ' + (await displayName(u)) + (lk > 3 ? ' 等 ' + lk + ' 人' : '') + ' 喜歡你的文章', '「' + String(p.title || '').slice(0, 30) + '」', '/#/post/' + id, 'like-' + id); } });
exports.cmLikeDel = onDocumentDeleted({ document: 'posts/{id}/likes/{uid}', ...HOT }, async ev => { const id = ev.params.id; await db.doc('posts/' + id).update({ likes: INC(-1) }).catch(() => {}); const p = await postOf(id); if (p) await pstat(p.uid, 'likes', -1); });
exports.cmCmtNew = onDocumentCreated({ document: 'posts/{id}/cmts/{cid}', ...HOT }, async ev => { const id = ev.params.id, c = ev.data.data() || {};
  await db.doc('posts/' + id).update({ cmts: INC(1) }).catch(() => {}); await pstat(c.uid, 'cmts', 1); const p = await postOf(id); if (!p) return; const me = await displayName(c.uid), txt = String(c.text || '📷 照片').slice(0, 60);
  if (p.uid !== c.uid) await push(p.uid, '💬 ' + me + ' 留言了你的文章', txt, '/#/post/' + id, 'cmt-' + id);
  if (c.re) { try { const r = await db.doc('posts/' + id + '/cmts/' + c.re).get(); const ru = r.exists ? r.data().uid : null; if (ru && ru !== c.uid && ru !== p.uid) await push(ru, '↩️ ' + me + ' 回覆了你的留言', txt, '/#/post/' + id, 'cmt-' + id); } catch (e) {} } });
exports.cmCmtDel = onDocumentDeleted({ document: 'posts/{id}/cmts/{cid}', ...HOT }, async ev => { await db.doc('posts/' + ev.params.id).update({ cmts: INC(-1) }).catch(() => {}); });
exports.cmVote = onDocumentCreated({ document: 'posts/{id}/votes/{vid}', ...HOT }, async ev => { const v = ev.data.data() || {}; if (!v.b || typeof v.o !== 'number' || v.o < 0 || v.o > 9) return;
  await db.doc('posts/' + ev.params.id).update(new admin.firestore.FieldPath('poll', String(v.b), String(v.o)), INC(1)).catch(e => logger.warn('vote', e.message)); });

// 瀏覽紀錄只保留 7 天
exports.viewsCleanup = onSchedule({ schedule: 'every day 04:17', timeZone: 'Asia/Taipei' }, async () => {
  const cut = Date.now() - 7 * 864e5; let n = 0;
  for (let i = 0; i < 50; i++) { const sn = await db.collection('views').where('at', '<', cut).limit(400).get(); if (sn.empty) break; const b = db.batch(); sn.docs.forEach(d => b.delete(d.ref)); await b.commit(); n += sn.size; }
  logger.info('viewsCleanup', n);
});

// 管理員代綁手機：把手機號碼直接寫進會員的登入資料（等同簡訊驗證完成），一支手機只能綁一個帳號
const OWNER_EMAILS = ['chriswu91204@gmail.com'];
exports.adminPhoneBind = onDocumentWritten({ document: 'phoneBind/{uid}' }, async ev => {
  const after = ev.data.after; if (!after.exists) return; const d = after.data(); if (d.st !== 'req') return;
  const uid = ev.params.uid, ref = after.ref, fail = (msg, extra) => ref.set({ st: 'err', err: msg, at: Date.now(), by: d.by, act: d.act, ...(extra || {}) });
  try {
    const adm = (await db.doc('site/admins').get()).data() || {}; let ok = !!(adm.uids || {})[d.by];
    if (!ok) { try { const bu = await admin.auth().getUser(d.by); ok = !!bu.email && OWNER_EMAILS.includes(bu.email.toLowerCase()); } catch (e) {} }
    if (!ok) return fail('沒有權限');
    let target; try { target = await admin.auth().getUser(uid); } catch (e) { return fail('找不到這個會員的登入帳號'); }
    if (d.act === 'unbind') {
      await admin.auth().updateUser(uid, { phoneNumber: null });
      await db.doc('profiles/' + uid).set({ phoneVerified: false, updatedAt: Date.now() }, { merge: true });
      await db.collection('admlog').add({ by: d.by, u: uid, act: 'phone', detail: '解除手機綁定（原本 ' + (target.phoneNumber || '無') + '）', at: Date.now() });
      return ref.set({ st: 'ok', act: 'unbind', phone: '', at: Date.now(), by: d.by });
    }
    let n = String(d.phone || '').replace(/[\s-]/g, ''); if (/^09\d{8}$/.test(n)) n = '+886' + n.slice(1); if (/^8869\d{8}$/.test(n)) n = '+' + n;
    if (!/^\+\d{8,15}$/.test(n)) return fail('手機號碼格式不對（例如 0912345678）');
    try { const other = await admin.auth().getUserByPhoneNumber(n); if (other.uid !== uid) return fail('這支手機已經綁在別的帳號', { other: other.uid }); } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
    await admin.auth().updateUser(uid, { phoneNumber: n });
    await db.doc('profiles/' + uid).set({ phoneVerified: true, updatedAt: Date.now() }, { merge: true });
    await db.collection('admlog').add({ by: d.by, u: uid, act: 'phone', detail: '代綁手機 ' + n + (target.phoneNumber ? '（原本 ' + target.phoneNumber + '）' : ''), at: Date.now() });
    return ref.set({ st: 'ok', act: 'bind', phone: n, at: Date.now(), by: d.by });
  } catch (e) { logger.error('adminPhoneBind', e); return fail('綁定失敗：' + (e.message || e.code || '')); }
});

// ================= 市集（特賣會）＋ VEIN 拍賣會 =================
// 市集：開始時把報名通過的植物價格換成優惠價（記住原價），結束時換回來；這樣所有原本的購買流程都直接用優惠價結帳
const twNum = v => { const n = Number(v); return isFinite(n) ? n : 0; };
// 市集結束／取消報名：恢復原本的價格、上架狀態
const mktBack = p => { const k = p.mkt || {}; const o = { price: ('wasPrice' in k) ? k.wasPrice : (k.orig || p.price), mkt: null };
  if ('wasListed' in k) o.listed = k.wasListed; if ('wasHidden' in k) o.hidden = k.wasHidden; if (k.wasStatus) o.status = k.wasStatus; return o; };
async function mktApply(id, m, now) {
  const es = await db.collection('mkts/' + id + '/e').where('status', '==', 'ok').get();
  for (const d of es.docs) { const e = d.data(); const pref = db.doc(`shops/${e.shop}/plants/${e.pid}`);
    try { await db.runTransaction(async tx => { const s = await tx.get(pref); if (!s.exists) return; const p = s.data();
      if (p.status === 'sold' || p.status === 'reserved' || p.mode === 'auction' || p.lot === true || (p.mkt && p.mkt.id !== id)) { tx.update(d.ref, { status: 'skip', why: '開賣時這株已售出或在別的活動' }); return; }
      if (p.mkt && p.mkt.id === id) return;
      const orig = twNum(p.price) || twNum(e.orig); tx.update(pref, { price: e.deal, listed: true, hidden: false, status: 'available', mkt: { id, orig, deal: e.deal, end: m.endAt, title: m.title || '市集', wasPrice: p.price ?? null, wasListed: p.listed !== false, wasHidden: !!p.hidden, wasStatus: p.status || 'available' } }); tx.update(d.ref, { applied: true, orig }); }); } catch (x) { logger.warn('mktApply', e.pid, String(x)); } }
}
async function mktRestore(id) {
  const es = await db.collection('mkts/' + id + '/e').get();
  for (const d of es.docs) { const e = d.data(); const pref = db.doc(`shops/${e.shop}/plants/${e.pid}`);
    try { await db.runTransaction(async tx => { const s = await tx.get(pref); if (!s.exists) return; const p = s.data(); if (!p.mkt || p.mkt.id !== id) return;
      if (p.status === 'sold') tx.update(pref, { mkt: { ...p.mkt, done: true } }); else tx.update(pref, mktBack(p)); }); } catch (x) { logger.warn('mktRestore', e.pid, String(x)); } }
}
exports.mktSweep = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const now = Date.now(), ms = await db.collection('mkts').where('phase', 'in', ['reg', 'wait', 'on']).get();
  for (const d of ms.docs) { const m = d.data();
    try {
      if (m.phase !== 'on' && m.startAt && now >= m.startAt && (!m.endAt || now < m.endAt)) { await mktApply(d.id, m, now); await d.ref.update({ phase: 'on', appliedAt: now }); await mktPush(d.id, m, 'start'); }
      else if (m.endAt && now >= m.endAt) { await mktRestore(d.id); await d.ref.update({ phase: 'done', doneAt: now }); }
    } catch (x) { logger.error('mktSweep', d.id, String(x)); }
  }
});
async function mktPush(id, m, k) { const mk = db.doc('sysnotes/mkt-' + id + '-' + k); if ((await mk.get()).exists) return; await mk.set({ at: Date.now() });
  try { await broadcast('🎪 ' + (m.title || '市集') + ' 開賣了！', (m.sub || '限時優惠價，手刀進場'), '/#/mkt/' + id, 'mkt-' + id); } catch (e) {} }
// 報名把關：上限、種類、價格、折扣（設成 0／空＝不限）
exports.mktGuard = onDocumentCreated('mkts/{id}/e/{pid}', async ev => {
  const e = ev.data.data() || {}, ref = ev.data.ref, id = ev.params.id;
  const no = why => ref.update({ status: 'no', why, checkedAt: Date.now() }).catch(() => {});
  try {
    const ms = await db.doc('mkts/' + id).get(); if (!ms.exists) return no('活動不存在'); const m = ms.data(), now = Date.now();
    if (!m.regOpen || (m.regEnd && now > m.regEnd) || m.phase === 'done') return no('報名已截止');
    const ps = await db.doc(`shops/${e.shop}/plants/${e.pid}`).get(); if (!ps.exists) return no('找不到這株');
    const p = ps.data(); if (p.status === 'sold' || p.status === 'reserved' || p.mode === 'auction' || p.lot === true || p.blocked) return no('已售出、預訂、競標中或整盤商品不能報名');
    const orig = twNum(p.price) || twNum(e.orig), deal = twNum(e.deal); if (!(orig > 0)) return no('請填原價'); if (!(deal > 0)) return no('請填優惠價');
    if (orig && deal >= orig) return no('優惠價要低於原價');
    const R = m.rules || {};
    if (R.minOff && orig && (1 - deal / orig) * 100 < R.minOff - 0.01) return no('至少要打 ' + (100 - R.minOff) / 10 + ' 折');
    if (R.kinds && R.kinds.length && !R.kinds.includes(p.kind || 'mother')) return no('這次不收這個類型');
    const g = String(p.species || '').trim().split(/\s+/)[0].toLowerCase(); if (R.genera && R.genera.length && !R.genera.map(x => String(x).toLowerCase()).includes(g)) return no('這次不收這個屬');
    if (R.pmin && deal < R.pmin) return no('優惠價要在 NT$ ' + R.pmin + ' 以上'); if (R.pmax && deal > R.pmax) return no('優惠價要在 NT$ ' + R.pmax + ' 以下');
    const all = await db.collection('mkts/' + id + '/e').where('status', 'in', ['ok', 'pending']).get();
    const mine = all.docs.filter(x => x.data().shop === e.shop && x.id !== ev.params.pid).length, tot = all.docs.filter(x => x.id !== ev.params.pid).length;
    if (R.perShop && mine >= R.perShop) return no('每個賣場最多 ' + R.perShop + ' 株');
    if (R.total && tot >= R.total) return no('名額已滿（共 ' + R.total + ' 株）');
    if (R.bands && R.bands.length) { const b = R.bands.find(x => deal >= (+x.lo || 0) && deal <= (+x.hi || 1e12)); if (!b) return no('這個價格區間沒有開放');
      if (+b.n) { const nb = all.docs.filter(x => x.id !== ev.params.pid && x.data().deal >= (+b.lo || 0) && x.data().deal <= (+b.hi || 1e12)).length; if (nb >= +b.n) return no('NT$ ' + b.lo + '–' + b.hi + ' 這一區名額已滿'); } }
    await ref.update({ status: m.approve === 'manual' ? 'pending' : 'ok', orig, checkedAt: now, kind: p.kind || 'mother', genus: g });
    if (m.phase === 'on' && m.approve !== 'manual') await mktApply(id, m, now);
  } catch (x) { logger.error('mktGuard', String(x)); }
});

// ===== VEIN 拍賣會：一株接一株。出價、結標全部由伺服器用伺服器時間判定，誰的手機時間不準都不影響 =====
const LV_GAP = 5000; // 一株結標後，停 5 秒宣布得標者再換下一株
function lvStep(ev, amt) { if (+ev.step > 0) return +ev.step; return amt < 1000 ? 50 : amt < 3000 ? 100 : amt < 10000 ? 200 : amt < 30000 ? 500 : 1000; }
async function lvLots(id) { const s = await db.collection('lives/' + id + '/lots').where('status', 'in', ['ok', 'wait', 'live', 'sold', 'pass']).get();
  return s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (twNum(a.ord) - twNum(b.ord)) || (twNum(a.at) - twNum(b.at))); }
// 推進：把該結束的那一株結標（有人出價＝成交、建立訂單），再開始下一株
// 報名截止後排拍賣順序：賣家希望的前段／中段／後段先滿足，滿了或沒填的亂數補位
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
async function lvArrange(id) {
  const eref = db.doc('lives/' + id); const es = await eref.get(); if (!es.exists) return; const e = es.data(); if (e.ordered || e.phase === 'on' || e.phase === 'done') return;
  const s = await db.collection('lives/' + id + '/lots').where('status', 'in', ['ok', 'wait', 'pending']).get(); const L = s.docs.map(d => ({ id: d.id, ref: d.ref, ...d.data() }));
  const N = L.length, cap = { f: Math.ceil(N / 3), m: Math.ceil((N - Math.ceil(N / 3)) / 2) }; cap.b = N - cap.f - cap.m;
  const seg = { f: [], m: [], b: [] }, pool = [];
  for (const k of ['f', 'm', 'b']) { const want = shuffle(L.filter(l => l.pos === k)); seg[k] = want.slice(0, cap[k]); pool.push(...want.slice(cap[k])); }
  pool.push(...L.filter(l => !['f', 'm', 'b'].includes(l.pos))); shuffle(pool);
  for (const k of ['f', 'm', 'b']) { while (seg[k].length < cap[k] && pool.length) seg[k].push(pool.shift()); shuffle(seg[k]); }
  const out = [...seg.f, ...seg.m, ...seg.b, ...pool]; let b = db.batch(), n = 0;
  for (let i = 0; i < out.length; i++) { const l = out[i], got = i < cap.f ? 'f' : i < cap.f + cap.m ? 'm' : 'b'; b.update(l.ref, { ord: i + 1, slot: i + 1, posOk: !l.pos || l.pos === got }); if (++n % 400 === 0) { await b.commit(); b = db.batch(); } }
  b.update(eref, { ordered: true, orderedAt: Date.now(), nLots: N }); await b.commit();
  // 通知每位賣家他的植物排在第幾件
  const by = new Map(); out.forEach((l, i) => { if (!by.has(l.shop)) by.set(l.shop, []); by.get(l.shop).push(i + 1); });
  for (const [u, A] of by) { try { await push(u, '🔨 拍賣順序出爐：' + (e.title || 'VEIN 拍賣會'), '你的植物排在第 ' + A.sort((a, b) => a - b).join('、') + ' 件（共 ' + N + ' 件）', '/#/live/' + id, 'lvord-' + id); } catch (x) {} } }
async function lvAdvance(id) {
  const eref = db.doc('lives/' + id); let result = null, started = null;
  try { const e0 = (await eref.get()).data(); if (e0 && !e0.ordered && e0.startAt && Date.now() >= e0.startAt) await lvArrange(id); } catch (x) { logger.warn('lvArrange', String(x)); }
  const lots = await lvLots(id);
  await db.runTransaction(async tx => {
    const es = await tx.get(eref); if (!es.exists) return; const ev = es.data(), now = Date.now(), cur = ev.cur || null;
    if (ev.phase === 'done') return;
    if (!cur) { if (!ev.startAt || now < ev.startAt) return; const nx = lots.find(l => l.status === 'ok' || l.status === 'wait'); if (!nx) { tx.update(eref, { phase: 'done', doneAt: now }); return; }
      tx.update(eref, { phase: 'on', cur: lvCur(ev, nx, now, 0), now }); tx.update(eref.collection('lots').doc(nx.id), { status: 'live', startedAt: now }); started = { ev, lot: nx }; return; }
    if (cur.gapUntil) { if (now < cur.gapUntil) return; const done = new Set(lots.filter(l => l.status === 'sold' || l.status === 'pass').map(l => l.id)); done.add(cur.lid);
      const nx = lots.find(l => !done.has(l.id) && (l.status === 'ok' || l.status === 'wait'));
      if (!nx) { tx.update(eref, { phase: 'done', doneAt: now, cur: { ...cur, over: true }, now }); return; }
      tx.update(eref, { cur: lvCur(ev, nx, now, (cur.i || 0) + 1), now }); tx.update(eref.collection('lots').doc(nx.id), { status: 'live', startedAt: now }); started = { ev, lot: nx }; return; }
    if (now < cur.endsAt) return;
    // 結標：伺服器時間已超過結束時間，之後的出價都不會被接受
    const lref = eref.collection('lots').doc(cur.lid);
    if (cur.top) { tx.update(lref, { status: 'sold', final: cur.top.amt, winner: cur.top.uid, n: cur.n || 0, endedAt: now }); result = { sold: true, lot: cur }; }
    else { tx.update(lref, { status: 'pass', n: 0, endedAt: now }); result = { sold: false, lot: cur }; }
    tx.update(eref, { cur: { ...cur, gapUntil: now + LV_GAP, result: cur.top ? 'sold' : 'pass' }, now, [cur.top ? 'nSold' : 'nPass']: admin.firestore.FieldValue.increment(1), ...(cur.top ? { gmv: admin.firestore.FieldValue.increment(cur.top.amt) } : {}) });
  });
  if (started) { try { const ws = await db.collection('liveWatch').where('eid', '==', id).where('pid', '==', started.lot.pid).get();
    for (const w of ws.docs) { await push(w.data().uid, '🔔 輪到你關注的植物了！', (started.lot.name || started.lot.code || '植物') + ' 15 秒後開拍，起拍 NT$ ' + Number(started.lot.start || 0).toLocaleString('zh-TW'), '/#/live/' + id, 'lvw-' + id + started.lot.pid); await w.ref.delete().catch(() => {}); } } catch (e) { logger.warn('liveWatch', String(e)); } }
  if (result && result.sold) { try { await db.doc(`shops/${result.lot.shop}/plants/${result.lot.pid}`).update({ status: 'sold', buyer: result.lot.top.uid, soldPrice: result.lot.top.amt }); } catch (e) {} }
  return result;
}
const LV_PREVIEW = 15000; // 每一件開拍前先給大家看 15 秒照片與資訊
function lvCur(ev, l, now, i) { const dur = Math.max(10, twNum(ev.dur) || 60) * 1000, pv = now + LV_PREVIEW; return { lid: l.id, pid: l.pid, shop: l.shop, i, start: twNum(l.start) || 0, top: null, n: 0, startedAt: now, previewUntil: pv, endsAt: pv + dur, code: l.code || '', name: l.name || '' }; }
// 整場結束後才成立訂單：同一位買家、同一個賣家的得標品合併成一筆訂單（不同賣家就各一筆）
async function lvFinalize(id) {
  const eref = db.doc('lives/' + id), es = await eref.get(); if (!es.exists) return; const ev = es.data(); if (ev.finalized) return;
  const sold = (await db.collection('lives/' + id + '/lots').where('status', '==', 'sold').get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(l => l.winner && l.final);
  const groups = new Map(); for (const l of sold) { const k = l.winner + '|' + l.shop; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(l); }
  const now = Date.now(), byBuyer = new Map();
  for (const [k, L] of groups) { const [buyer, shop] = k.split('|'), oid = 'lv-' + id.slice(0, 8) + '-' + buyer.slice(0, 10), oref = db.doc(`shops/${shop}/orders/${oid}`), total = L.reduce((n, l) => n + twNum(l.final), 0);
    try { if (!(await oref.get()).exists) { const bank = await db.doc(`data/users/${shop}/bank`).get();
        await oref.set({ buyer, items: L.map(l => l.pid), prices: Object.fromEntries(L.map(l => [l.pid, twNum(l.final)])), total, note: (ev.title || 'VEIN 拍賣會') + ' 得標 ' + L.length + ' 件（自動成立）', status: 'confirmed', payMethod: 'transfer', src: 'live', liveId: id, at: now });
        await db.doc(`deals/${shop}_${oid}`).set({ seller: shop, buyer, orderId: oid, payMethod: 'transfer', bank: bank.exists ? bank.data() : null, at: now }, { merge: true });
        for (const l of L) await db.doc(`shops/${shop}/plants/${l.pid}`).update({ status: 'sold', buyer, soldPrice: twNum(l.final) }).catch(() => {});
        await push(shop, '🔨 拍賣會成交 ' + L.length + ' 件', (await displayName(buyer)) + ' 得標，合計 NT$ ' + total.toLocaleString('zh-TW') + '，訂單已成立', '/#orders/orders', 'lvo-' + oid); }
    } catch (e) { logger.error('lvFinalize', oid, String(e)); }
    const b = byBuyer.get(buyer) || { n: 0, t: 0, s: 0 }; b.n += L.length; b.t += total; b.s++; byBuyer.set(buyer, b); }
  for (const [buyer, b] of byBuyer) { try { await push(buyer, '🏆 ' + (ev.title || '拍賣會') + ' 得標 ' + b.n + ' 件', '合計 NT$ ' + b.t.toLocaleString('zh-TW') + (b.s > 1 ? '，共 ' + b.s + ' 個賣家各一筆訂單' : '，訂單已成立') + '，請到我的訂單付款', '/#/me/orders', 'lvb-' + id + buyer); } catch (e) {} }
  await eref.update({ finalized: true, finalizedAt: now });
}
exports.liveDone = onDocumentUpdated('lives/{id}', async ev => {
  const a = ev.data.after.data() || {}, b = ev.data.before.data() || {}; if (a.phase === 'done' && b.phase !== 'done' && !a.finalized) { try { await lvFinalize(ev.params.id); } catch (x) { logger.error('liveDone', String(x)); } }
});
// 出價：只接受「目前價＋一口」（第一口＝起拍價），而且伺服器時間還沒結束；最後 N 秒有人出價就延長到 N 秒
exports.liveBid = onDocumentCreated({ document: 'liveBid/{id}', ...HOT }, async ev => {
  const b = ev.data.data() || {}, ref = ev.data.ref; if (!b.uid || !b.eid || !b.lid || b.res) return;
  const done = o => ref.update({ ...o, srv: Date.now() }).catch(() => {});
  try { const bn = await db.doc('site/bans').get(); if (bn.exists && (bn.data().uids || {})[b.uid]) return done({ res: 'ban' }); } catch (e) {}
  const eref = db.doc('lives/' + b.eid);
  try {
    const out = await db.runTransaction(async tx => {
      const es = await tx.get(eref); if (!es.exists) return { res: 'gone' }; const e = es.data(), cur = e.cur, now = Date.now();
      if (!cur || cur.lid !== b.lid || cur.gapUntil) return { res: 'late' };
      if (cur.previewUntil && now < cur.previewUntil) return { res: 'soon' };
      if (now >= cur.endsAt) return { res: 'late' };
      if (cur.shop === b.uid) return { res: 'own' };
      const need = cur.top ? cur.top.amt + lvStep(e, cur.top.amt) : (cur.start || lvStep(e, 0));
      if (twNum(b.amt) !== need) return { res: 'outbid', need };
      if (cur.top && cur.top.uid === b.uid) return { res: 'lead' };
      const sn = Math.max(0, twNum(e.snipe) || 10) * 1000, endsAt = cur.endsAt - now < sn ? cur.endsAt + sn : cur.endsAt; // 防尾刀：最後 N 秒內有人出價 → 結束時間「加」N 秒
      const top = { uid: b.uid, amt: need, at: now };
      tx.update(eref, { cur: { ...cur, top, n: (cur.n || 0) + 1, endsAt, ext: endsAt !== cur.endsAt ? (cur.ext || 0) + 1 : (cur.ext || 0) }, now, bids: admin.firestore.FieldValue.increment(1) });
      tx.set(eref.collection('lots').doc(cur.lid).collection('bids').doc(), { uid: b.uid, amt: need, at: now });
      return { res: 'ok', amt: need, endsAt };
    });
    await done(out);
  } catch (x) { logger.warn('liveBid', String(x)); await done({ res: 'err' }); }
});
// 結標／下一株：在競標頁的人倒數到 0 時會丟一個 tick；伺服器確認時間真的到了才處理（重複的 tick 不會重複結標）
exports.liveTick = onDocumentCreated({ document: 'liveTick/{id}', ...HOT }, async ev => {
  const t = ev.data.data() || {}; if (!t.eid) return; try { await lvAdvance(t.eid); } catch (x) { logger.warn('liveTick', String(x)); } try { await ev.data.ref.delete(); } catch (e) {}
});
// 保險：沒有人在看的時候，每分鐘也會推進一次
exports.liveSweep = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Asia/Taipei' }, async () => {
  const ls = await db.collection('lives').where('phase', 'in', ['reg', 'wait', 'on']).get();
  for (const d of ls.docs) { const e = d.data();
    if (!e.ordered && ((e.regEnd && Date.now() > e.regEnd) || (e.startAt && Date.now() >= e.startAt - 5 * 60000))) { try { await lvArrange(d.id); } catch (x) { logger.warn('lvArrange', String(x)); } }
    if (!e.startAt || Date.now() < e.startAt) continue; for (let k = 0; k < 3; k++) { try { const r = await lvAdvance(d.id); if (!r) break; } catch (x) { break; } }
    if (e.phase !== 'on') { try { await broadcast('🔴 ' + (e.title || 'VEIN 拍賣會') + ' 開拍了！', '一株接一株，手刀進場', '/#/live/' + d.id, 'live-' + d.id); } catch (x) {} } }
});
// 市集進行中賣家退出（或管理員移除）→ 價格立刻換回原價
exports.mktUnreg = onDocumentDeleted('mkts/{id}/e/{pid}', async ev => {
  const e = ev.data.data() || {}; if (!e.shop) return; const pref = db.doc(`shops/${e.shop}/plants/${ev.params.pid}`);
  try { await db.runTransaction(async tx => { const s = await tx.get(pref); if (!s.exists) return; const p = s.data(); if (!p.mkt || p.mkt.id !== ev.params.id || p.status === 'sold') return; tx.update(pref, mktBack(p)); }); } catch (x) { logger.warn('mktUnreg', String(x)); }
});
// 管理員把報名改成「不通過」也要換回原價
exports.mktEntryUpd = onDocumentUpdated('mkts/{id}/e/{pid}', async ev => {
  const a = ev.data.after.data() || {}, b = ev.data.before.data() || {}; if (a.status === b.status) return;
  const ms = await db.doc('mkts/' + ev.params.id).get(); if (!ms.exists) return; const m = ms.data();
  if (a.status === 'ok' && m.phase === 'on') await mktApply(ev.params.id, m, Date.now());
  if (b.status === 'ok' && a.status !== 'ok') { const pref = db.doc(`shops/${a.shop}/plants/${ev.params.pid}`);
    try { await db.runTransaction(async tx => { const s = await tx.get(pref); if (!s.exists) return; const p = s.data(); if (!p.mkt || p.mkt.id !== ev.params.id || p.status === 'sold') return; tx.update(pref, mktBack(p)); }); } catch (x) {} }
});
// 拍賣會報名把關
exports.liveGuard = onDocumentCreated('lives/{id}/lots/{pid}', async ev => {
  const l = ev.data.data() || {}, ref = ev.data.ref, id = ev.params.id;
  const no = why => ref.update({ status: 'no', why, checkedAt: Date.now() }).catch(() => {});
  try {
    const es = await db.doc('lives/' + id).get(); if (!es.exists) return no('活動不存在'); const e = es.data(), now = Date.now();
    if (!e.regOpen || (e.regEnd && now > e.regEnd) || e.phase === 'done') return no('報名已截止');
    const ps = await db.doc(`shops/${l.shop}/plants/${l.pid}`).get(); if (!ps.exists) return no('找不到這株'); const p = ps.data();
    if (p.status === 'sold' || p.mode === 'auction' || (p.lot === true)) return no('已售出、競標中或整盤商品不能報名');
    const st = twNum(l.start); if (!(st > 0)) return no('請填起拍價'); const R = e.rules || {};
    if (R.kinds && R.kinds.length && !R.kinds.includes(p.kind || 'mother')) return no('這次不收這個類型');
    const g = String(p.species || '').trim().split(/\s+/)[0].toLowerCase(); if (R.genera && R.genera.length && !R.genera.map(x => String(x).toLowerCase()).includes(g)) return no('這次不收這個屬');
    if (R.smin && st < R.smin) return no('起拍價要在 NT$ ' + R.smin + ' 以上'); if (R.smax && st > R.smax) return no('起拍價要在 NT$ ' + R.smax + ' 以下');
    const all = await db.collection('lives/' + id + '/lots').where('status', 'in', ['ok', 'pending', 'live', 'sold', 'pass']).get();
    const mine = all.docs.filter(x => x.data().shop === l.shop && x.id !== ev.params.pid).length, tot = all.docs.filter(x => x.id !== ev.params.pid).length;
    if (R.perShop && mine >= R.perShop) return no('每個賣場最多 ' + R.perShop + ' 株'); if (R.total && tot >= R.total) return no('名額已滿（共 ' + R.total + ' 株）');
    await ref.update({ status: e.approve === 'manual' ? 'pending' : 'ok', checkedAt: now, kind: p.kind || 'mother', genus: g, ord: twNum(l.ord) || now, pos: ['f', 'm', 'b'].includes(l.pos) ? l.pos : '' });
  } catch (x) { logger.error('liveGuard', String(x)); }
});
