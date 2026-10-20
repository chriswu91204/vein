// VEIN 伺服器端：Email 通知
// 資料庫有變動時自動寄信（訂單、出價、提問、抽獎、賣家審核），每 10 分鐘檢查一次結束的競標。
// 寄件信箱用 Gmail：在 Google Cloud Secret Manager 建立 SMTP_USER（Gmail 地址）與 SMTP_PASS（應用程式密碼）。
const { onDocumentWritten, onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ region: 'asia-east1', maxInstances: 5 });

const SMTP_USER = defineSecret('SMTP_USER');
const SMTP_PASS = defineSecret('SMTP_PASS');
const secrets = [SMTP_USER, SMTP_PASS];
const SITE = 'https://vein-48ec8.web.app';

/* ---------- helpers ---------- */
let transport = null;
const mailer = () => transport || (transport = nodemailer.createTransport({ service: 'gmail', auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() } }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => 'NT$ ' + Number(n || 0).toLocaleString('zh-TW');
const short = sp => String(sp || '').replace(/^Anthurium /, '').replace('（雜交）', '');
const when = ms => new Date(ms).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const plantLine = p => `${p.code}（${short(p.species)}${p.cultivar ? ' · ' + p.cultivar : ''}）${p.price ? ' ' + money(p.price) : ''}`;

async function emailOf(uid) { try { return (await admin.auth().getUser(uid)).email || null; } catch (e) { return null; } }
async function nameOf(uid) { try { const s = await db.doc('profiles/' + uid).get(); return (s.exists && s.data().name) || '一位會員'; } catch (e) { return '一位會員'; } }
async function shopName(uid) { try { const s = await db.doc('shops/' + uid).get(); return (s.exists && s.data().name) || '賣家'; } catch (e) { return '賣家'; } }
async function getPlant(shop, pid) { const s = await db.doc(`shops/${shop}/plants/${pid}`).get(); return s.exists ? { id: pid, shop, ...s.data() } : null; }
async function findPlant(pid, hintShop) {
  if (hintShop) { const p = await getPlant(hintShop, pid); if (p) return p; }
  for (const d of await db.collection('shops').listDocuments()) { const p = await getPlant(d.id, pid); if (p) return p; }
  return null;
}
async function adminUids() { const s = await db.doc('site/admins').get(); return s.exists ? Object.keys(s.data().uids || {}).filter(k => s.data().uids[k]) : []; }
const OWNER_EMAILS = ['chriswu91204@gmail.com'];
async function ownerUids() { const out = []; for (const e of OWNER_EMAILS) { try { out.push((await admin.auth().getUserByEmail(e)).uid); } catch (x) {} } return out; }

function page(title, lines, link) {
  const body = lines.filter(Boolean).map(l => `<p style="margin:6px 0;color:#333;line-height:1.7">${esc(l)}</p>`).join('');
  return `<div style="font-family:-apple-system,'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif;max-width:540px;margin:0 auto;padding:28px 22px;color:#111">
  <div style="font-weight:700;letter-spacing:.32em;font-size:15px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#D4F25A;box-shadow:0 0 0 3px #1F5C42;margin-right:8px"></span>VEIN</div>
  <h2 style="font-size:22px;margin:22px 0 10px">${esc(title)}</h2>${body}
  <p style="margin-top:24px"><a href="${SITE}${link || '/'}" style="display:inline-block;background:#1F5C42;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:600">前往 VEIN</a></p>
  <p style="color:#999;font-size:12px;margin-top:34px">這封信由 VEIN 自動寄出，請勿直接回覆。</p></div>`;
}
async function send(uid, title, lines, link) {
  const to = await emailOf(uid);
  if (!to) { logger.warn('no email for', uid); return; }
  try {
    await mailer().sendMail({ from: `VEIN <${SMTP_USER.value()}>`, to, subject: `[VEIN] ${title}`, html: page(title, lines, link), text: [title, ...lines.filter(Boolean), SITE + (link || '/')].join('\n') });
    logger.info('mail sent', { uid, title });
  } catch (e) { logger.error('mail failed', { uid, title, err: String(e) }); }
}
async function topBidder(pid, endsAtMs, excludeUid) {
  let best = null;
  (await db.collection('social').get()).forEach(d => {
    if (d.id === excludeUid) return;
    const b = (d.data().bids || {})[pid];
    if (b && typeof b.amt === 'number' && b.at <= endsAtMs && (!best || b.amt > best.amt || (b.amt === best.amt && b.at < best.at))) best = { uid: d.id, ...b };
  });
  return best;
}

/* ---------- 會員互動：新訂單、出價被超越、新提問 ---------- */
exports.onSocial = onDocumentWritten({ document: 'social/{uid}', secrets }, async ev => {
  const uid = ev.params.uid;
  const before = ev.data.before.exists ? ev.data.before.data() : {};
  const after = ev.data.after.exists ? ev.data.after.data() : null;
  if (!after) return;
  const buyer = await nameOf(uid);

  for (const [oid, o] of Object.entries(after.orders || {})) {
    if ((before.orders || {})[oid]) continue;
    const items = (await Promise.all((o.items || []).map(pid => getPlant(o.seller, pid)))).filter(Boolean).map(plantLine);
    const sn = await shopName(o.seller);
    await send(o.seller, '你有一筆新訂單', [`${buyer} 向你下單：`, ...items, `合計 ${money(o.total)}`, o.note ? `備註：${o.note}` : '', '請到賣家後台「訂單」接受或婉拒，並私訊買家付款與寄送方式。'], '/#admin');
    await send(uid, '已收到你的訂單', [`你向「${sn}」送出了訂單：`, ...items, `合計 ${money(o.total)}`, '賣家確認後會再寄信通知你。'], '/');
  }

  for (const [pid, bid] of Object.entries(after.bids || {})) {
    const prev = (before.bids || {})[pid];
    if (prev && prev.amt >= bid.amt) continue;
    const p = await findPlant(pid, bid.shop);
    if (!p || !p.endsAtMs || bid.at > p.endsAtMs) continue;
    const other = await topBidder(pid, p.endsAtMs, uid);
    if (other && other.amt < bid.amt && other.at < bid.at) {
      await send(other.uid, '你的出價被超越了', [`${plantLine(p)} 目前最高出價 ${money(bid.amt)}，超過你的 ${money(other.amt)}。`, `結標時間：${when(p.endsAtMs)}`, '想拿下它，記得回來加價。'], '/#/shop');
    }
  }

  const oldQ = new Set((before.qa || []).map(q => q.id));
  for (const q of after.qa || []) {
    if (oldQ.has(q.id)) continue;
    const p = await findPlant(q.pid, q.shop);
    if (p) await send(p.shop, '有買家提問', [`${buyer} 在 ${p.code} 問：「${q.text}」`, '到賣家後台「顧客提問」回覆，回覆會公開在商品頁。'], '/#admin');
  }
});

/* ---------- 訂單狀態：接受、出貨、完成、未成立 ---------- */
exports.onSellerOrder = onDocumentWritten({ document: 'shops/{shop}/orders/{oid}', secrets }, async ev => {
  const a = ev.data.after.exists ? ev.data.after.data() : null;
  const b = ev.data.before.exists ? ev.data.before.data() : null;
  if (!a || !a.buyer || (b && b.status === a.status)) return;
  const shop = ev.params.shop, sn = await shopName(shop);
  const items = (await Promise.all((a.items || []).map(pid => getPlant(shop, pid)))).filter(Boolean).map(plantLine);
  const auc = ev.params.oid.startsWith('auc-');
  const M = {
    confirmed: [auc ? '恭喜得標，訂單已成立' : '賣家已接受你的訂單', [`「${sn}」已確認你的訂單：`, ...items, `合計 ${money(a.total)}`, '賣家會私訊你付款與寄送方式，請留意 LINE 或訊息。']],
    shipped: ['你的植物已出貨', [`「${sn}」已經把你的植物寄出：`, ...items, '收到後記得到「查驗」輸入標籤上的編號，確認成長紀錄。']],
    done: ['訂單完成，留個評價吧', [`與「${sn}」的訂單已完成：`, ...items, '到「我的 → 訂單」給賣家評價，幫助其他買家。']],
    cancelled: ['訂單未成立', [`「${sn}」這次無法接受你的訂單：`, ...items, '可以逛逛其他賣家，或在商品頁問與答詢問。']]
  }[a.status];
  if (M) await send(a.buyer, M[0], M[1], '/');
});

/* ---------- 抽獎開獎 ---------- */
exports.onRaffle = onDocumentUpdated({ document: 'shops/{shop}/raffles/{rid}', secrets }, async ev => {
  const b = ev.data.before.data(), a = ev.data.after.data();
  if (b.drawn || !a.drawn) return;
  const shop = ev.params.shop, sn = await shopName(shop), winners = a.drawn.winners || [];
  const link = `/#/raffle/${shop}~${ev.params.rid}`;
  for (const w of winners) await send(w, '🎉 恭喜你中獎了', [`你在「${sn}」的抽獎「${a.title}」中獎了！`, `獎品：${a.prize}`, '賣家會私訊你確認寄送方式。'], link);
  const names = await Promise.all(winners.map(nameOf));
  await send(shop, '抽獎已開獎', [`「${a.title}」已開獎。`, winners.length ? `得獎者：${names.join('、')}` : '沒有符合資格的參加者。', winners.length ? '請私訊得獎者確認寄送方式。' : ''], '/#admin');
});

/* ---------- 賣家申請與核准 ---------- */
exports.onShopCreated = onDocumentCreated({ document: 'shops/{uid}', secrets }, async ev => {
  const s = ev.data.data(), uid = ev.params.uid;
  const admins = [...new Set([...(await ownerUids()), ...(await adminUids())])];
  if (admins.includes(uid)) return;
  for (const a of admins) await send(a, '有新的賣家申請', [`賣場名稱：${s.name}`, s.location ? `地區：${s.location}` : '', s.line ? `LINE：${s.line}` : '', s.bio ? `介紹：${s.bio}` : '', '到管理後台「賣家審核」核准或婉拒。'], '/#admin');
});
exports.onSellersChanged = onDocumentWritten({ document: 'site/sellers', secrets }, async ev => {
  const b = ev.data.before.exists ? (ev.data.before.data().approved || {}) : {};
  const a = ev.data.after.exists ? (ev.data.after.data().approved || {}) : {};
  for (const [uid, on] of Object.entries(a)) {
    if (on && !b[uid]) await send(uid, '你的賣場已通過審核', [`「${await shopName(uid)}」已經在 VEIN 上架公開了。`, '現在上架的商品與抽獎都會出現在選購頁。'], '/#admin');
  }
});

/* ---------- 每 10 分鐘：結束的競標 ---------- */
exports.auctionsEnded = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Asia/Taipei', secrets }, async () => {
  const now = Date.now();
  const snap = await db.collectionGroup('plants').where('endsAtMs', '<=', now).where('endsAtMs', '>', now - 3 * 864e5).get();
  for (const d of snap.docs) {
    const p = { id: d.id, ...d.data() };
    if (p.mode !== 'auction' || p.endNotified) continue;
    const shop = d.ref.parent.parent.id;
    const win = await topBidder(p.id, p.endsAtMs, null);
    if (win) {
      await send(win.uid, '恭喜你得標', [`你以 ${money(win.amt)} 得標 ${plantLine(p)}。`, `賣家「${await shopName(shop)}」會成立訂單並私訊你付款與寄送方式。`], '/');
      await send(shop, '競標結束：有得標者', [`${plantLine(p)} 由 ${await nameOf(win.uid)} 以 ${money(win.amt)} 得標。`, '到賣家後台打開這株植物，按「成立訂單給得標者」。'], '/#admin');
    } else {
      await send(shop, '競標結束：沒有人出價', [`${plantLine(p)} 的競標已結束，沒有人出價。`, '可以在賣家後台改成直購，或重新設定競標時間。'], '/#admin');
    }
    await d.ref.update({ endNotified: true });
  }
});
