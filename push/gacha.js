// 轉蛋機（一番賞）：上架鎖獎品、賣抽獎券（不超賣）、確認收款發券、撕獎單抽獎、轉蛋倉庫出貨（運費規則）、到期自動出貨
// 規則：
//  - 每台轉蛋機總抽數＝獎品總數；抽獎券在「下單」那一刻就保留名額（交易），保留＋已發的券永遠 ≤ 總抽數
//  - 券只能用在買的那一台（gTix/{買家}_{機台}）
//  - 每張獎單背後是哪個賞，開賣時由伺服器洗牌後鎖在 gSec（任何人都讀不到），公開 commit 雜湊；完抽後公開，可驗證
//  - 抽到的獎品進轉蛋倉庫（gbi），勾選後出貨：滿免運門檻、或這家還有沒寄出的訂單、或機台設定「含運」→ 免運
const crypto = require('crypto');
module.exports = ctx => {
  const { db, push, displayName, logger, ordAct, nt, onDocumentCreated, onDocumentWritten, onSchedule, HOT } = ctx;
  const hasPhone = ctx.hasPhone || (async () => false);
  const LATER_V = 1; // 先抽再付契約條款版本
  const T = {};
  const LET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const PAY_H = 48;                       // 抽獎券訂單幾小時沒付款就自動取消、名額放回去
  const SHIP_DEF = [{ n: '面交', fee: 0, k: 'meet' }, { n: '7-11 交貨便', fee: null, k: 'store' }, { n: '黑貓宅急便', fee: null, k: 'home' }];
  const rid = p => p + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const pName = p => String(p.gname || p.species || p.cultivar || p.code || '獎品').slice(0, 60);
  const pImg = p => String(p.coverThumb || p.thumb || (Array.isArray(p.imgs) && p.imgs[0] && (p.imgs[0].t || p.imgs[0].f)) || '').slice(0, 500);
  async function isVerified(u) {
    try { const v = await db.doc('site/verified').get(); if (v.exists && (v.data().uids || {})[u]) return true; } catch (e) {}
    try { const s = await db.doc('site/sellers').get(); if (s.exists && s.data().house === u) return true; } catch (e) {}
    try { const a = await db.doc('site/admins').get(); const x = a.exists ? a.data().uids : null; if (Array.isArray(x) ? x.includes(u) : x && x[u]) return true; } catch (e) {}
    return false;
  }
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const commitOf = (salt, ks) => crypto.createHash('sha256').update(salt + ':' + ks.join('')).digest('hex');

  // ---------- 上架、暫停、恢復、結束（賣家送 gReq，伺服器檢查後才改狀態） ----------
  async function publish(gid, uid) {
    const gref = db.doc('gacha/' + gid);
    return db.runTransaction(async tx => {
      const gs = await tx.get(gref); if (!gs.exists) return '找不到這台轉蛋機'; const g = gs.data();
      if (g.shop !== uid) return '不是你的轉蛋機'; if (g.status !== 'draft') return '已經上架過了';
      const title = String(g.title || '').trim(); if (!title || title.length > 40) return '名稱 1–40 字';
      if (!int(g.price, 1, 100000)) return '每抽價格要是 1–100,000 的整數';
      const P = Array.isArray(g.prizes) ? g.prizes : []; if (!P.length || P.length > 26) return '至少要有 1 個賞（最多 26 個）';
      const ship = g.ship || {}; if (!['incl', 'sep'].includes(ship.mode)) return '請選運費方式';
      if (ship.mode === 'sep' && !(Number.isFinite(+ship.free) && +ship.free >= 0 && +ship.free <= 1e6)) return '免運門檻不正確';
      const keep = Number.isInteger(+ship.keep) ? +ship.keep : 30; if (keep < 7 || keep > 90) return '倉庫保管 7–90 天';
      const maxPer = Number.isInteger(+g.maxPer) ? +g.maxPer : 10; if (maxPer < 1 || maxPer > 100) return '每次最多買幾抽 1–100';
      const plantIds = new Set(), goodsNeed = new Map(), map = [], pub = [], seenK = new Set();
      const want = [...P.map((x, i) => ({ ...x, k: LET[i] })), ...(g.last ? [{ ...g.last, k: 'LAST', n: 1 }] : [])];
      for (const x of want) {
        if (x.kind === 'plant') { const ids = Array.isArray(x.pids) ? x.pids.filter(s => typeof s === 'string') : []; if (!ids.length) return x.k + ' 賞還沒選植物'; if (ids.length > 300) return '植物太多';
          for (const id of ids) { if (plantIds.has(id)) return '同一株不能放兩次'; plantIds.add(id); } }
        else if (x.kind === 'goods') { if (typeof x.gid !== 'string' || !int(+x.n, 1, 1000)) return x.k + ' 賞的周邊數量不正確'; const key = x.gid + '|' + (x.var || ''); goodsNeed.set(key, (goodsNeed.get(key) || 0) + +x.n); }
        else return x.k + ' 賞要選植物或周邊';
      }
      const ps = new Map(); for (const id of plantIds) { const s = await tx.get(db.doc(`shops/${uid}/plants/${id}`)); if (!s.exists) return '有植物已經不在了'; ps.set(id, s.data()); }
      const gd = new Map(); for (const key of goodsNeed.keys()) { const id = key.split('|')[0]; if (gd.has(id)) continue; const s = await tx.get(db.doc(`shops/${uid}/plants/${id}`)); if (!s.exists || s.data().kind !== 'goods') return '有周邊已經不在了'; gd.set(id, s.data()); }
      for (const [id, p] of ps) { if (p.kind === 'goods') return '植物獎項不能選周邊'; if (p.status === 'sold' || p.status === 'reserved' || p.buyer) return pName(p) + ' 已經賣出'; if (p.gcLock) return pName(p) + ' 已經在別台轉蛋機'; if (p.mode === 'auction' || p.lv || p.encOn || p.listed === false && p.delistedWhy === 'xfer') return pName(p) + ' 正在競標／拍賣會／轉移中'; if (p.lot === true) return pName(p) + ' 是整盤商品，請用單株'; }
      for (const [key, need] of goodsNeed) { const [id, vk] = key.split('|'), p = gd.get(id);
        if (vk) { const v = (p.vars || []).find(v => v.k === vk); if (!v) return pName(p) + ' 沒有這個規格'; if ((+v.stock || 0) < need) return pName(p) + '（' + v.n + '）庫存只剩 ' + (+v.stock || 0); }
        else if ((+p.stock || 0) < need) return pName(p) + ' 庫存只剩 ' + (+p.stock || 0); }
      let total = 0; const left = {};
      for (const x of want) {
        const items = [];
        if (x.kind === 'plant') for (const id of x.pids) { const p = ps.get(id), it = { kind: 'plant', pid: id, name: pName(p), img: pImg(p), val: Math.max(0, Math.floor(+p.price || 0)) }; items.push(it); if (x.k !== 'LAST') map.push({ k: x.k, ...it }); }
        else { const p = gd.get(x.gid), v = x.var ? (p.vars || []).find(v => v.k === x.var) : null, it = { kind: 'goods', gid: x.gid, ...(v ? { var: v.k, vn: String(v.n || '').slice(0, 30) } : {}), name: pName(p) + (v ? '（' + v.n + '）' : ''), img: pImg(p), val: Math.max(0, Math.floor(+(v && v.price != null ? v.price : p.price) || 0)) }; items.push({ ...it, n: +x.n }); if (x.k !== 'LAST') for (let i = 0; i < +x.n; i++) map.push({ k: x.k, ...it }); }
        const n = x.kind === 'plant' ? x.pids.length : +x.n;
        if (x.k !== 'LAST') { total += n; left[x.k] = n; pub.push({ k: x.k, kind: x.kind, n, items, name: String(x.name || '').slice(0, 40) || items[0].name }); }
      }
      if (total < 2 || total > 1000) return '總抽數要在 2–1000 之間（目前 ' + total + '）';
      shuffle(map); const salt = crypto.randomBytes(16).toString('hex'), now = Date.now();
      const lastPub = g.last ? (() => { const x = want[want.length - 1]; const items = x.kind === 'plant' ? x.pids.map(id => ({ kind: 'plant', pid: id, name: pName(ps.get(id)), img: pImg(ps.get(id)), val: Math.floor(+ps.get(id).price || 0) })) : [(() => { const p = gd.get(x.gid), v = x.var ? (p.vars || []).find(v => v.k === x.var) : null; return { kind: 'goods', gid: x.gid, ...(v ? { var: v.k, vn: v.n } : {}), name: pName(p) + (v ? '（' + v.n + '）' : ''), img: pImg(p), val: Math.floor(+(v && v.price != null ? v.price : p.price) || 0) }; })()]; return { kind: x.kind, items: items.slice(0, 1), name: String(x.name || '').slice(0, 40) || items[0].name }; })() : null;
      // 鎖獎品：植物標記 gcLock（商城、競標、購物車都買不到）；周邊直接扣庫存（沒抽出的結束時還回去）
      for (const id of plantIds) tx.update(db.doc(`shops/${uid}/plants/${id}`), { gcLock: gid, updatedAt: now });
      for (const [id, p] of gd) { const up = { updatedAt: now }; let tot = 0;
        for (const [key, need] of goodsNeed) { const [gid2, vk] = key.split('|'); if (gid2 !== id) continue; tot += need; if (vk) { up.vars = (up.vars || p.vars || []).map(v => v.k === vk ? { ...v, stock: (+v.stock || 0) - need } : v); } }
        if (up.vars) up.stock = up.vars.reduce((a, v) => a + Math.max(0, +v.stock || 0), 0); else up.stock = (+p.stock || 0) - tot;
        if (up.stock <= 0) up.status = 'sold'; tx.update(db.doc(`shops/${uid}/plants/${id}`), up); }
      tx.set(db.doc('gSec/' + gid), { map, salt, shop: uid, at: now });
      tx.update(gref, { status: 'on', prizes: pub, last: lastPub, total, left, sold: 0, opened: 0, open: {}, commit: commitOf(salt, map.map(e => e.k)), pubAt: now, maxPer, ship: { mode: ship.mode, free: ship.mode === 'sep' ? Math.floor(+ship.free || 0) : 0, keep }, updatedAt: now });
      return null;
    });
  }
  async function endGacha(gid, uid, admin) {
    const gref = db.doc('gacha/' + gid);
    const held = await db.collection('gRes').where('gid', '==', gid).where('st', '==', 'held').get();
    const tix = await db.collection('gTix').where('gid', '==', gid).get();
    const out = tix.docs.reduce((a, d) => a + (+d.data().n || 0), 0);
    return db.runTransaction(async tx => {
      const gs = await tx.get(gref); if (!gs.exists) return '找不到'; const g = gs.data(); if (g.shop !== uid && !admin) return '不是你的轉蛋機';
      if (!['on', 'pause', 'done'].includes(g.status)) return '現在不能結束';
      if (g.status !== 'done' && (held.size || out)) return '還有 ' + (held.size ? held.size + ' 筆抽獎券訂單沒處理' : '') + (held.size && out ? '、' : '') + (out ? out + ' 張券還沒撕' : '') + '，處理完才能結束';
      const sec = await tx.get(db.doc('gSec/' + gid)); const S = sec.exists ? sec.data() : { map: [], salt: '' }, now = Date.now();
      if (g.status !== 'done') {
        const back = new Map(); const plants = [];
        S.map.forEach((e, i) => { if ((g.open || {})[i + 1]) return; if (e.kind === 'plant') plants.push(e.pid); else { const key = e.gid + '|' + (e.var || ''); back.set(key, (back.get(key) || 0) + 1); } });
        if (g.last && !g.lastWin) for (const it of g.last.items || []) { if (it.kind === 'plant') plants.push(it.pid); else { const key = it.gid + '|' + (it.var || ''); back.set(key, (back.get(key) || 0) + 1); } }
        const gsn = new Map(); for (const key of back.keys()) { const id = key.split('|')[0]; if (!gsn.has(id)) { const s = await tx.get(db.doc(`shops/${g.shop}/plants/${id}`)); if (s.exists) gsn.set(id, s.data()); } }
        for (const id of plants) tx.update(db.doc(`shops/${g.shop}/plants/${id}`), { gcLock: null, updatedAt: now });
        for (const [id, p] of gsn) { let vars = p.vars ? p.vars.map(v => ({ ...v })) : null, st = +p.stock || 0;
          for (const [key, n] of back) { const [gid2, vk] = key.split('|'); if (gid2 !== id) continue; if (vk && vars) vars = vars.map(v => v.k === vk ? { ...v, stock: (+v.stock || 0) + n } : v); else st += n; }
          if (vars) st = vars.reduce((a, v) => a + Math.max(0, +v.stock || 0), 0);
          tx.update(db.doc(`shops/${g.shop}/plants/${id}`), { ...(vars ? { vars } : {}), stock: st, ...(st > 0 && p.status === 'sold' ? { status: 'available' } : {}), updatedAt: now }); }
      }
      tx.update(gref, { status: 'end', endAt: now, reveal: { ks: S.map.map(e => e.k), salt: S.salt }, updatedAt: now });
      return null;
    });
  }
  T.gachaReq = onDocumentCreated({ document: 'gReq/{id}', ...HOT }, async ev => {
    const r = ev.data.data() || {}, ref = ev.data.ref; if (!r.uid || !r.gid) return;
    let err = null;
    try {
      if (r.act === 'pub') { if (!(await isVerified(r.uid))) err = '只有認證賣家可以上架轉蛋機'; else err = await publish(r.gid, r.uid); }
      else if (r.act === 'pause' || r.act === 'resume') err = await db.runTransaction(async tx => { const s = await tx.get(db.doc('gacha/' + r.gid)); if (!s.exists || s.data().shop !== r.uid) return '不是你的轉蛋機'; const st = s.data().status; if (r.act === 'pause' ? st !== 'on' : st !== 'pause') return '狀態不對'; tx.update(s.ref, { status: r.act === 'pause' ? 'pause' : 'on', updatedAt: Date.now() }); return null; });
      else if (r.act === 'end') err = await endGacha(r.gid, r.uid, false);
      else if (r.act === 'lok' || r.act === 'lno') err = await laterDecide(r);
      else err = '不支援';
    } catch (e) { logger.warn('gachaReq', e.message); err = '系統忙碌，請再試一次'; }
    await ref.set({ done: true, ok: !err, ...(err ? { err } : {}) }, { merge: true });
    // 上架成功 → 通知追蹤這家的人
    if (!err && r.act === 'pub') { try { const g = (await db.doc('gacha/' + r.gid).get()).data() || {}, nm = await displayName(r.uid), who = new Set();
        (await db.collection('social').where('follows', 'array-contains', r.uid).get()).forEach(x => who.add(x.id)); who.delete(r.uid);
        const when = g.startAt && g.startAt > Date.now() ? new Date(g.startAt + 8 * 36e5).toISOString().slice(5, 16).replace('-', '/').replace('T', ' ') + ' 開賣' : '現在就能抽';
        for (const u of who) { try { await push(u, '🎰 ' + nm + ' 開了新轉蛋機', '「' + g.title + '」每抽 ' + nt(g.price) + '，共 ' + g.total + ' 抽，' + when, '/#/gacha/' + r.gid, 'gnew-' + r.gid); } catch (e) {} }
        await ref.set({ notified: who.size }, { merge: true }); } catch (e) { logger.warn('gNotify', e.message); } }
  });

  // ---------- 買抽獎券：下單就保留名額（不超賣） ----------
  T.ticketOrder = async (shop, oid, o, buyer) => {
    const oref = db.doc(`shops/${shop}/orders/${oid}`), gid = String((o.gacha || {}).id || ''), n = +((o.gacha || {}).n), now = Date.now();
    const later = o.later === true, agreeOK = !later || (o.agree && +o.agree.v === LATER_V && o.agree.ok === true);
    const phoneOK = later ? await hasPhone(buyer) : true;
    let res;
    try {
      res = await db.runTransaction(async tx => {
        const ex = await tx.get(oref); if (ex.exists) return { r: 'exists' };
        const gs = gid ? await tx.get(db.doc('gacha/' + gid)) : null; const g = gs && gs.exists ? gs.data() : null;
        let why = null;
        if (!g || g.shop !== shop) why = '找不到這台轉蛋機';
        else if (g.status !== 'on') why = g.status === 'pause' ? '賣家暫停販售中' : '已經停止販售';
        else if (g.startAt && g.startAt > now) why = '還沒開賣';
        else if (buyer === shop) why = '不能買自己的轉蛋機';
        else if (!int(n, 1, +g.maxPer || 10)) why = '每次最多買 ' + (+g.maxPer || 10) + ' 抽';
        else if (later && !phoneOK) why = '先抽再付要先完成手機驗證';
        else if (later && !agreeOK) why = '先抽再付要先同意契約條款';
        else if ((+g.sold || 0) + n > (+g.total || 0)) why = (+g.total || 0) - (+g.sold || 0) > 0 ? '只剩 ' + ((+g.total || 0) - (+g.sold || 0)) + ' 抽可以買' : '抽獎券已經賣完';
        const base = { buyer, items: [], total: g ? g.price * (n || 0) : 0, note: String(o.note || '').slice(0, 120), at: o.at || now, payMethod: o.payMethod || 'transfer', src: 'gacha', gacha: { id: gid, n: n || 0, price: g ? g.price : 0, title: g ? String(g.title || '').slice(0, 40) : '' }, updatedAt: now, auto: true, ...(later ? { later: true, agree: { v: LATER_V, at: now, buyerAt: +(o.agree || {}).at || now } } : {}) };
        if (why) { tx.set(oref, { ...base, status: 'cancelled', cancelledAt: now, cancelWhy: why }); return { r: 'cancel', why }; }
        tx.update(gs.ref, { sold: (+g.sold || 0) + n, updatedAt: now });
        tx.set(db.doc(`gRes/${shop}_${oid}`), { uid: buyer, shop, oid, gid, n, st: 'held', at: now, ...(later ? { later: true } : {}) });
        tx.set(oref, later ? { ...base, status: 'apply', applyAt: now } : { ...base, status: 'confirmed', confirmedAt: now });
        return { r: 'ok', g };
      });
    } catch (e) { logger.warn('ticketOrder', oid, e.message); return { r: 'err' }; }
    if (res.r === 'ok' && later) {
      await ordAct(buyer, shop, oid, 'upd');
      await push(shop, '📝 先抽再付申請', (await displayName(buyer)) + ' 申請先抽 ' + n + ' 抽「' + res.g.title + '」再付 ' + nt(res.g.price * n) + '，請到後台同意或拒絕', '/#admin/gacha', 'gord-' + oid);
    } else if (res.r === 'ok') {
      try { const bank = await db.doc(`data/users/${shop}/bank`).get(); await db.doc(`deals/${shop}_${oid}`).set({ seller: shop, buyer, orderId: oid, payMethod: o.payMethod || 'transfer', bank: bank.exists ? bank.data() : null, at: now }, { merge: true }); } catch (e) { logger.warn('gDeal', e.message); }
      await ordAct(buyer, shop, oid, 'upd');
      await push(shop, '🎟 新的抽獎券訂單', (await displayName(buyer)) + ' 買了 ' + n + ' 抽「' + res.g.title + '」，共 ' + nt(res.g.price * n) + '，等買家付款', '/#admin/gacha', 'gord-' + oid);
    } else if (res.r === 'cancel') { await push(buyer, '抽獎券沒有買成', res.why, '/#/raffle', 'gord-' + oid); await ordAct(buyer, shop, oid, 'upd'); }
    return res;
  };
  // 先抽再付：賣家同意（＝契約成立，馬上發券，訂單留著等付款）或拒絕（名額放回）
  async function laterDecide(r) {
    const oid = String(r.oid || ''); if (!/^[\w-]{1,80}$/.test(oid)) return '找不到這筆申請';
    const oref = db.doc(`shops/${r.uid}/orders/${oid}`), now = Date.now();
    const o = await oref.get(); const x = o.exists ? o.data() : null;
    if (!x || x.src !== 'gacha' || !x.later || (x.gacha || {}).id !== r.gid) return '找不到這筆申請';
    if (x.status !== 'apply') return x.status === 'cancelled' ? '這筆申請已經取消' : '已經處理過了';
    if (r.act === 'lno') {
      await oref.update({ status: 'cancelled', cancelledAt: now, cancelWhy: '賣家沒有同意先抽再付', updatedAt: now });
      await release(r.uid, oid, 'reject');
      await push(x.buyer, '先抽再付沒有通過', '「' + (await displayName(r.uid)) + '」沒有同意，可以改用先付再抽', '/#/gacha/' + r.gid, 'gord-' + oid);
      await ordAct(x.buyer, r.uid, oid, 'upd'); return null;
    }
    const ok = await db.runTransaction(async tx => { const s = await tx.get(oref); if (!s.exists || s.data().status !== 'apply') return false;
      tx.update(oref, { status: 'confirmed', confirmedAt: now, agree: { ...(s.data().agree || {}), sellerAt: now }, updatedAt: now }); return true; });
    if (!ok) return '已經處理過了';
    try { const bank = await db.doc(`data/users/${r.uid}/bank`).get(); await db.doc(`deals/${r.uid}_${oid}`).set({ seller: r.uid, buyer: x.buyer, orderId: oid, payMethod: x.payMethod || 'transfer', bank: bank.exists ? bank.data() : null, at: now }, { merge: true }); } catch (e) { logger.warn('gDeal', e.message); }
    const g = await grant(r.uid, oid);
    if (g) await push(x.buyer, '🎟 先抽再付通過：獲得 ' + g.n + ' 張抽獎券', '可以馬上撕了！撕完記得付款 ' + nt(x.total) + '（契約已成立）', '/#/gacha/' + r.gid, 'gtix-' + r.gid);
    await ordAct(x.buyer, r.uid, oid, 'upd'); return null;
  }
  // 取消（買家取消、賣家取消、逾時）→ 名額放回去；已經發券的不會收回
  async function release(shop, oid, why) {
    const rref = db.doc(`gRes/${shop}_${oid}`);
    return db.runTransaction(async tx => {
      const r = await tx.get(rref); if (!r.exists || r.data().st !== 'held') return false; const x = r.data();
      const gs = await tx.get(db.doc('gacha/' + x.gid));
      if (gs.exists) tx.update(gs.ref, { sold: Math.max(0, (+gs.data().sold || 0) - x.n), updatedAt: Date.now() });
      tx.update(rref, { st: 'rel', relAt: Date.now(), why: why || '' }); return true;
    });
  }
  T.release = release;
  // 賣家確認收款（訂單變 preparing／shipped／done）→ 發券；券只屬於這台機台
  async function grant(shop, oid) {
    const rref = db.doc(`gRes/${shop}_${oid}`);
    return db.runTransaction(async tx => {
      const r = await tx.get(rref); if (!r.exists || r.data().st !== 'held') return null; const x = r.data();
      const tref = db.doc(`gTix/${x.uid}_${x.gid}`), t = await tx.get(tref), now = Date.now();
      const gs = await tx.get(db.doc('gacha/' + x.gid));
      tx.set(tref, { uid: x.uid, gid: x.gid, shop, n: (t.exists ? +t.data().n || 0 : 0) + x.n, got: (t.exists ? +t.data().got || 0 : 0) + x.n, news: { n: x.n, at: now }, title: gs.exists ? gs.data().title : '', updatedAt: now }, { merge: true });
      tx.update(rref, { st: 'granted', grantAt: now });
      tx.update(db.doc(`shops/${shop}/orders/${oid}`), x.later ? { granted: true, grantAt: now, updatedAt: now } : { status: 'done', doneAt: now, granted: true, updatedAt: now });
      if (x.later) tx.update(rref, { grantAt: now });
      return { ...x, title: gs.exists ? gs.data().title : '' };
    });
  }
  T.gachaOrder = onDocumentWritten({ document: 'shops/{shop}/orders/{oid}', ...HOT }, async ev => {
    const a = ev.data.after.exists ? ev.data.after.data() : null, b = ev.data.before.exists ? ev.data.before.data() : null; if (!a) return;
    const { shop, oid } = ev.params;
    if (a.src === 'gacha') {
      if (a.later && a.granted && ['preparing', 'shipped'].includes(a.status)) { try { await db.doc(`shops/${shop}/orders/${oid}`).update({ status: 'done', doneAt: Date.now(), updatedAt: Date.now() }); await push(a.buyer, '✅ 先抽再付已結清', '「' + (await displayName(shop)) + '」已確認收到 ' + nt(a.total), '/#/me/orders', 'gord-' + oid); } catch (e) { logger.warn('laterDone', e.message); } }
      else if (a.later && !a.granted && !['apply', 'cancelled', 'confirmed'].includes(a.status)) { /* 先抽再付只能由賣家同意發券 */ try { await db.doc(`shops/${shop}/orders/${oid}`).update({ status: 'apply', updatedAt: Date.now() }); } catch (e) {} }
      else if (a.later && !a.granted) { /* 等賣家同意 */ }
      else if (['preparing', 'shipped', 'done'].includes(a.status) && !a.granted) { try { const g = await grant(shop, oid); if (g) await push(g.uid, '🎟 獲得 ' + g.n + ' 張抽獎券', '「' + (await displayName(shop)) + '」已確認收款，快去撕「' + g.title + '」', '/#/gacha/' + g.gid, 'gtix-' + g.gid); } catch (e) { logger.warn('grant', e.message); } }
      else if (a.status === 'cancelled' && (!b || b.status !== 'cancelled')) { try { await release(shop, oid, 'cancel'); } catch (e) { logger.warn('release', e.message); } }
    }
    if (a.src === 'gship' && a.status === 'cancelled' && (!b || b.status !== 'cancelled')) {
      // 出貨單取消 → 獎品回到倉庫
      try { const ids = (a.gship || {}).items || []; const bt = db.batch(); for (const id of ids) bt.update(db.doc('gbi/' + id), { st: 'box', oid: null }); await bt.commit(); } catch (e) { logger.warn('gshipCancel', e.message); }
    }
  });

  // ---------- 撕獎單 ----------
  T.gachaDraw = onDocumentCreated({ document: 'gDraw/{id}', ...HOT }, async ev => {
    const d = ev.data.data() || {}, ref = ev.data.ref;
    const fail = async (err, extra) => ref.set({ st: 'err', err, ...(extra || {}) }, { merge: true });
    if (!d.uid || typeof d.gid !== 'string' || !Array.isArray(d.slots)) return fail('資料不完整');
    const slots = [...new Set(d.slots)]; if (!slots.length || slots.length > 20 || slots.length !== d.slots.length || !slots.every(s => Number.isInteger(s))) return fail('選的獎單不正確');
    let out;
    try {
      out = await db.runTransaction(async tx => {
        const me = await tx.get(ref); if (me.exists && me.data().st) return { skip: true };
        const gref = db.doc('gacha/' + d.gid), gs = await tx.get(gref); if (!gs.exists) return { err: '找不到這台轉蛋機' }; const g = gs.data();
        if (!['on', 'pause'].includes(g.status)) return { err: '這台已經結束了' };
        const tref = db.doc(`gTix/${d.uid}_${d.gid}`), t = await tx.get(tref); const have = t.exists ? +t.data().n || 0 : 0;
        if (have < slots.length) return { err: have ? '你只有 ' + have + ' 張券' : '你沒有這台的抽獎券' };
        const open = { ...(g.open || {}) }, taken = slots.filter(s => s < 1 || s > g.total || open[s]);
        if (taken.length) return { err: '有獎單剛被別人撕走了，請重新挑', taken };
        const sec = await tx.get(db.doc('gSec/' + d.gid)); if (!sec.exists) return { err: '系統錯誤' }; const map = sec.data().map;
        const now = Date.now(), keep = (g.ship && +g.ship.keep) || 30, left = { ...(g.left || {}) }, res = [];
        const mk = (e, slot, k) => { const id = rid('gi'); const it = { uid: d.uid, shop: g.shop, gid: d.gid, gtitle: String(g.title || '').slice(0, 40), k, slot, kind: e.kind, ...(e.kind === 'plant' ? { pid: e.pid } : { goods: e.gid, ...(e.var ? { var: e.var, vn: e.vn || '' } : {}) }), name: e.name, img: e.img, val: +e.val || 0, at: now, exp: now + keep * 864e5, st: 'box' };
          tx.set(db.doc('gbi/' + id), it); if (e.kind === 'plant') tx.update(db.doc(`shops/${g.shop}/plants/${e.pid}`), { status: 'sold', buyer: d.uid, soldPrice: +e.val || 0, gcWon: d.gid, updatedAt: now }); return { id, ...it }; };
        for (const s of slots) { const e = map[s - 1]; open[s] = e.k; left[e.k] = Math.max(0, (+left[e.k] || 0) - 1); res.push(mk(e, s, e.k)); }
        const opened = Object.keys(open).length, up = { open, left, opened, updatedAt: now };
        let last = null;
        if (opened >= g.total) { up.status = 'done'; up.doneAt = now; up.reveal = { ks: map.map(e => e.k), salt: sec.data().salt }; up.lastWin = { uid: d.uid, at: now };
          if (g.last && (g.last.items || [])[0]) { last = mk(g.last.items[0], 0, 'LAST'); } }
        tx.update(gref, up); tx.update(tref, { n: have - slots.length, updatedAt: now });
        tx.set(ref, { st: 'ok', res, ...(last ? { last } : {}), doneAt: now }, { merge: true });
        return { ok: true, g, n: res.length, last };
      });
    } catch (e) { logger.warn('gachaDraw', e.message); return fail('系統忙碌，請再試一次'); }
    if (out.skip) return; if (out.err) return fail(out.err, out.taken ? { taken: out.taken } : null);
    if (out.last) { try { await push(out.g.shop, '🏆 轉蛋機完抽！', '「' + out.g.title + '」全部抽完，最後賞送出', '/#admin/gacha', 'gdone-' + d.gid); } catch (e) {} }
  });

  // ---------- 轉蛋倉庫出貨 ----------
  async function hasUnshipped(uid, shop) {
    const q = await db.collection(`shops/${shop}/orders`).where('buyer', '==', uid).get();
    const L = q.docs.filter(x => { const o = x.data(); return ['confirmed', 'paid', 'preparing'].includes(o.status) && o.src !== 'gacha'; });
    return L.length ? L.sort((a, b) => (b.data().at || 0) - (a.data().at || 0))[0].id : null;
  }
  async function makeShip(uid, shop, ids, ship, auto) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) return { err: '一次出貨 1–50 件' };
    const sh = await db.doc('shops/' + shop).get(); const opts = (sh.exists && Array.isArray(sh.data().shipOpts) && sh.data().shipOpts.length) ? sh.data().shipOpts : SHIP_DEF;
    const opt = opts.find(x => x && ship && x.n === ship.n && (x.k || 'home') === (ship.k || 'home')); if (!opt) return { err: '請重新選寄送方式' };
    try { const ow = await db.collection(`shops/${shop}/orders`).where('buyer', '==', uid).where('later', '==', true).get(); if (ow.docs.some(d => d.data().granted && d.data().status === 'confirmed')) return { err: '先抽再付還沒結清，賣家確認收款後才能出貨' }; } catch (e) { logger.warn('oweChk', e.message); }
    const merge = await hasUnshipped(uid, shop);
    const oid = 'gs-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), now = Date.now();
    const r = await db.runTransaction(async tx => {
      const snaps = []; for (const id of ids) snaps.push(await tx.get(db.doc('gbi/' + id)));
      for (const s of snaps) { if (!s.exists) return { err: '有獎品找不到' }; const x = s.data(); if (x.uid !== uid) return { err: '不是你的獎品' }; if (x.shop !== shop) return { err: '一次只能寄同一家的獎品' }; if (x.st !== 'box') return { err: '有獎品已經在出貨中' }; }
      const items = snaps.map(s => ({ id: s.id, ...s.data() })), gids = [...new Set(items.map(x => x.gid))], gm = new Map();
      for (const g of gids) { const s = await tx.get(db.doc('gacha/' + g)); if (s.exists) gm.set(g, s.data()); }
      const val = items.reduce((a, x) => a + (+x.val || 0), 0);
      const allIncl = gids.every(g => (gm.get(g) || {}).ship && gm.get(g).ship.mode === 'incl');
      const thr = Math.max(0, ...gids.map(g => { const s = (gm.get(g) || {}).ship || {}; return s.mode === 'sep' ? +s.free || 0 : 0; }));
      const thrOK = gids.some(g => ((gm.get(g) || {}).ship || {}).mode === 'sep') && thr > 0 && val >= thr;
      const free = opt.fee === 0 ? 'zero' : allIncl ? 'incl' : thrOK ? 'thr' : merge ? 'merge' : '';
      const fee = free ? 0 : (opt.fee == null ? null : +opt.fee);
      const plants = items.filter(x => x.kind === 'plant').map(x => x.pid), qty = {};
      items.filter(x => x.kind === 'goods').forEach(x => { qty[x.goods] = (qty[x.goods] || 0) + 1; });
      const order = { buyer: uid, items: [...plants, ...Object.keys(qty)], ...(Object.keys(qty).length ? { qty } : {}), total: 0, note: '', at: now, payMethod: 'transfer', src: 'gship',
        gship: { items: ids, val, free, ...(free === 'merge' ? { merge } : {}), list: items.map(x => ({ k: x.k, name: x.name, img: x.img, val: x.val, slot: x.slot, gid: x.gid, ...(x.vn ? { vn: x.vn } : {}) })), ...(auto ? { auto: true } : {}) },
        ship: { n: opt.n, k: opt.k || 'home', fee, at: now, by: uid }, status: fee === 0 ? 'preparing' : 'confirmed', confirmedAt: now, updatedAt: now, auto: true };
      tx.set(db.doc(`shops/${shop}/orders/${oid}`), order);
      for (const id of ids) tx.update(db.doc('gbi/' + id), { st: 'ship', oid, shipAt: now });
      tx.set(db.doc('gBox/' + uid), { lastShip: { [shop]: { n: opt.n, k: opt.k || 'home' } } }, { merge: true });
      return { ok: true, oid, fee, free, val, n: ids.length };
    });
    if (r.ok) {
      try { const bank = await db.doc(`data/users/${shop}/bank`).get(); await db.doc(`deals/${shop}_${oid}`).set({ seller: shop, buyer: uid, orderId: oid, payMethod: 'transfer', bank: bank.exists ? bank.data() : null, at: now }, { merge: true }); } catch (e) {}
      await ordAct(uid, shop, oid, 'upd');
      await push(shop, '📦 轉蛋出貨單', (await displayName(uid)) + (auto ? ' 的轉蛋獎品到期，自動成立出貨單（' : ' 要寄 ') + r.n + ' 件轉蛋獎品' + (auto ? '）' : '') + (r.fee === 0 ? '，免運，可以直接出貨' : r.fee == null ? '，運費請跟買家確認' : '，等買家付運費 ' + nt(r.fee)), '/#admin/gacha', 'gship-' + oid);
    }
    return r;
  }
  T.makeShip = makeShip;
  T.gachaShip = onDocumentCreated({ document: 'gShip/{id}', ...HOT }, async ev => {
    const d = ev.data.data() || {}, ref = ev.data.ref; let r;
    try { r = await makeShip(d.uid, d.shop, d.items, d.ship, false); } catch (e) { logger.warn('gachaShip', e.message); r = { err: '系統忙碌，請再試一次' }; }
    await ref.set(r.ok ? { st: 'ok', oid: r.oid, fee: r.fee, free: r.free } : { st: 'err', err: r.err }, { merge: true });
  });

  // ---------- 定時：逾時沒付款的抽獎券訂單取消、倉庫到期提醒與自動出貨 ----------
  T.gachaSweep = onSchedule({ schedule: 'every 30 minutes', timeZone: 'Asia/Taipei', timeoutSeconds: 300 }, async () => {
    const now = Date.now();
    const held = await db.collection('gRes').where('st', '==', 'held').get();
    for (const d of held.docs) { const x = d.data(); if (now - x.at < PAY_H * 36e5) continue;
      try { const o = await db.doc(`shops/${x.shop}/orders/${x.oid}`).get(); const st = o.exists ? o.data().status : '';
        if (x.later) { if (st !== 'apply') continue;
          await db.doc(`shops/${x.shop}/orders/${x.oid}`).set({ status: 'cancelled', cancelledAt: now, cancelWhy: '賣家 ' + PAY_H + ' 小時內沒有回覆', updatedAt: now }, { merge: true });
          await release(x.shop, x.oid, 'timeout'); await push(x.uid, '先抽再付申請已失效', '賣家 ' + PAY_H + ' 小時內沒有回覆，名額已經放回去', '/#/gacha/' + x.gid, 'gord-' + x.oid); continue; }
        if (o.exists && st !== 'confirmed') continue;
        await db.doc(`shops/${x.shop}/orders/${x.oid}`).set({ status: 'cancelled', cancelledAt: now, cancelWhy: '超過 ' + PAY_H + ' 小時沒付款', updatedAt: now }, { merge: true });
        await release(x.shop, x.oid, 'timeout'); await push(x.uid, '抽獎券訂單已取消', '超過 ' + PAY_H + ' 小時沒付款，名額已經放回去', '/#/me/orders', 'gord-' + x.oid); } catch (e) { logger.warn('gTimeout', e.message); } }
    // 先抽再付：發券後沒付款 → 每 24 小時提醒買家一次（最多 3 次），第 3 次同時通知賣家
    const owe = await db.collection('gRes').where('st', '==', 'granted').where('later', '==', true).get();
    for (const d of owe.docs) { const x = d.data(), k = +x.rem || 0; if (k >= 3 || now - (x.grantAt || x.at) < (k + 1) * 864e5) continue;
      try { const o = await db.doc(`shops/${x.shop}/orders/${x.oid}`).get(); if (!o.exists || o.data().status !== 'confirmed') { await d.ref.update({ rem: 9 }); continue; }
        const dl = await db.doc(`deals/${x.shop}_${x.oid}`).get(); if (dl.exists && dl.data().pay) continue;
        await d.ref.update({ rem: k + 1 });
        await push(x.uid, '⚠️ 先抽再付還沒付款', '你已經先抽了 ' + x.n + ' 抽，請盡快付款 ' + nt(o.data().total) + '。契約已成立，未付款須自負法律責任', '/#/me/orders', 'glate-' + x.oid);
        if (k + 1 >= 3) await push(x.shop, '⚠️ 先抽再付買家尚未付款', (await displayName(x.uid)) + ' 抽了 ' + x.n + ' 抽，已 3 天沒付款', '/#admin/gacha', 'glate-' + x.oid); } catch (e) { logger.warn('gLate', e.message); } }
    const box = await db.collection('gbi').where('st', '==', 'box').get(); const due = new Map();
    for (const d of box.docs) { const x = d.data();
      if (x.exp - now < 3 * 864e5 && x.exp > now && !x.rem3) { try { await d.ref.update({ rem3: true }); await push(x.uid, '⏳ 轉蛋獎品快到期', '「' + x.name + '」3 天內到期，到期會自動寄出', '/#/me/gacha', 'gexp-' + x.uid); } catch (e) {} }
      if (x.exp <= now) { const k = x.uid + '|' + x.shop; if (!due.has(k)) due.set(k, []); due.get(k).push(d.id); } }
    for (const [k, ids] of due) { const [uid, shop] = k.split('|');
      try { const b = await db.doc('gBox/' + uid).get(); const ls = b.exists && (b.data().lastShip || {})[shop];
        const sh = await db.doc('shops/' + shop).get(); const opts = (sh.exists && Array.isArray(sh.data().shipOpts) && sh.data().shipOpts.length) ? sh.data().shipOpts : SHIP_DEF;
        const ship = ls || opts.find(o => o.k !== 'meet') || opts[0];
        for (let i = 0; i < ids.length; i += 50) await makeShip(uid, shop, ids.slice(i, i + 50), ship, true); } catch (e) { logger.warn('gAuto', e.message); } }
  });
  return T;
};
