// 聖誕交換禮物（限時玩法）
//  - xg/main：活動設定（phase reg → matched → done；regEnd、matchAt、shipBy、min、feat 精選禮物）
//  - xgE/{uid}：會員登錄（管理員審核 status ok/no）
//  - 配對（matchAt 到了、或管理員把 matchNow 設 true）：只配「已通過＋收件資料完整」的登錄，隨機排成一圈，每個人寄給下一個人
//    xgPair/{寄件人}＝{to, from}（誰都讀不到）；xgOut/{寄件人}＝對方收件資料（看不到是誰）；xgIn/{收件人}＝包裹狀態
//  - 寄件人按「我已寄出」→ 通知收件人；收件人按「收件完成」→ 伺服器才把「是誰、送了什麼」填進 xgIn，並告訴寄件人對方是誰
const crypto = require('crypto');
module.exports = ctx => {
  const { db, push, displayName, logger, onDocumentWritten, onSchedule } = ctx;
  const X = {};
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const shipOK = s => !!(s && s.name && s.phone && s.k && s.place);
  const md = t => { const d = new Date((+t || 0) + 8 * 3600e3); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate(); };
  async function admins() { try { const a = await db.doc('site/admins').get(); const x = a.exists ? a.data().uids : null; return Array.isArray(x) ? x : Object.keys(x || {}); } catch (e) { return []; } }
  async function avatarOf(uid) { try { const p = await db.doc('profiles/' + uid).get(); return p.exists ? String(p.data().avatarUrl || p.data().photo || '').slice(0, 500) : ''; } catch (e) { return ''; } }
  async function counts() {
    const s = await db.collection('xgE').get(); let nOk = 0, nPend = 0, nAll = 0;
    s.forEach(d => { nAll++; const st = d.data().status || 'pending'; if (st === 'ok') nOk++; else if (st === 'pending') nPend++; });
    await db.doc('xg/main').set({ nOk, nPend, nAll }, { merge: true });
  }
  async function match(why) {
    const ref = db.doc('xg/main');
    const ok = await db.runTransaction(async tx => { const c = await tx.get(ref); if (!c.exists) return false; const d = c.data(); if (d.phase !== 'reg' || d.matching) return false; tx.update(ref, { matching: Date.now() }); return true; });
    if (!ok) return;
    try {
      const cfg = (await ref.get()).data();
      const E = (await db.collection('xgE').where('status', '==', 'ok').get()).docs.map(d => ({ uid: d.id, ...d.data() })).filter(e => shipOK(e.ship));
      if (E.length < 2) { await ref.update({ matching: null, matchFail: Date.now(), matchFailWhy: '符合資格的登錄不到 2 份' }); logger.warn('xmas match: not enough', { n: E.length }); return; }
      const L = shuffle(E.slice()), n = L.length, now = Date.now();
      for (let i = 0; i < n; i += 120) {
        const b = db.batch();
        for (let k = i; k < Math.min(n, i + 120); k++) {
          const s = L[k], r = L[(k + 1) % n], f = L[(k - 1 + n) % n];
          b.set(db.doc('xgPair/' + s.uid), { to: r.uid, from: f.uid, at: now });
          b.set(db.doc('xgOut/' + s.uid), { ship: r.ship, gift: s.name, giftImg: s.img || '', shipBy: cfg.shipBy || 0, trk: '', at: now });
          b.set(db.doc('xgIn/' + r.uid), { at: now });
        }
        await b.commit();
      }
      await ref.update({ phase: 'matched', matching: null, matchedAt: now, nPair: n, nShip: 0, nRcv: 0, matchNow: false, matchWhy: why || 'auto' });
      for (const e of L) { try { await push(e.uid, '🎄 交換禮物配對完成！', '快去看要寄給誰，' + md(cfg.shipBy) + ' 前寄出', '/#/xmas', 'xmas-m'); } catch (x) {} }
      logger.info('xmas matched', { n });
    } catch (e) { logger.warn('xmas match', e.message); await ref.update({ matching: null }).catch(() => {}); }
  }
  // 登錄有變：通知、更新數量、新的登錄通知管理員
  X.xmasEntry = onDocumentWritten('xgE/{uid}', async ev => {
    const b = ev.data?.before?.data(), a = ev.data?.after?.data(), uid = ev.params.uid;
    try { await counts(); } catch (e) { logger.warn('xmas counts', e.message); }
    if (!a) return;
    if (b?.status !== a.status) {
      if (a.status === 'ok') await push(uid, '🎁 交換禮物報名成功', '管理員已確認你的「' + String(a.name || '').slice(0, 20) + '」，配對日一起期待！', '/#/xmas', 'xmas-e');
      else if (a.status === 'no') await push(uid, '交換禮物沒有通過', String(a.why || '可以修改或換一株再送出').slice(0, 80), '/#/xmas', 'xmas-e');
    }
    if (a.status === 'pending' && (!b || b.status !== 'pending' || b.upd !== a.upd && b.name !== a.name)) { for (const u of await admins()) { try { await push(u, '🎁 交換禮物有新登錄', String(a.name || '').slice(0, 30) + '・NT$ ' + (+a.val || 0).toLocaleString('zh-TW'), '/#admin/xmas', 'xmas-adm'); } catch (e) {} } }
  });
  // 管理員按「現在配對」
  X.xmasCfg = onDocumentWritten('xg/main', async ev => { const a = ev.data?.after?.data(), b = ev.data?.before?.data(); if (a && a.matchNow && !b?.matchNow && a.phase === 'reg') await match('admin'); });
  // 寄件人按「我已寄出」→ 告訴收件人
  X.xmasOut = onDocumentWritten('xgOut/{uid}', async ev => {
    const b = ev.data?.before?.data(), a = ev.data?.after?.data(); if (!a || !a.shipAt) return; if (b?.shipAt && b.trk === a.trk) return;
    const p = await db.doc('xgPair/' + ev.params.uid).get(); if (!p.exists) return; const to = p.data().to;
    await db.doc('xgIn/' + to).set({ shipAt: a.shipAt, trk: String(a.trk || '').slice(0, 40) }, { merge: true });
    if (!b?.shipAt) { await push(to, '🎁 有人寄了交換禮物給你！', '包裹在路上，收到後按「收件完成」就會揭曉是誰送的', '/#/xmas', 'xmas-i'); await db.doc('xg/main').update({ nShip: require('firebase-admin').firestore.FieldValue.increment(1) }).catch(() => {}); }
  });
  // 收件人按「收件完成」→ 翻牌資料
  X.xmasIn = onDocumentWritten('xgIn/{uid}', async ev => {
    const b = ev.data?.before?.data(), a = ev.data?.after?.data(), uid = ev.params.uid; if (!a || !a.rcvAt || a.from || b?.rcvAt) return;
    const pairs = await db.collection('xgPair').where('to', '==', uid).limit(1).get(); if (pairs.empty) return; const sender = pairs.docs[0].id;
    const e = (await db.doc('xgE/' + sender).get()).data() || {};
    const from = { uid: sender, name: await displayName(sender), av: await avatarOf(sender) };
    await db.doc('xgIn/' + uid).update({ from, gift: { name: e.name || '', img: e.img || '', val: +e.val || 0, note: e.note || '' } });
    await db.doc('xgOut/' + sender).update({ to: { uid, name: await displayName(uid), av: await avatarOf(uid) }, rcvAt: a.rcvAt });
    await db.doc('xg/main').update({ nRcv: require('firebase-admin').firestore.FieldValue.increment(1) }).catch(() => {});
    await push(sender, '🎉 你的交換禮物送達了！', '對方按了收件完成，快來看你的神秘對象是誰', '/#/xmas', 'xmas-o');
  });
  // 每 15 分鐘：時間到自動配對；寄出期限前一天提醒還沒寄的人
  X.xmasSweep = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Asia/Taipei' }, async () => {
    const c = await db.doc('xg/main').get(); if (!c.exists) return; const d = c.data(), now = Date.now();
    if (d.phase === 'reg' && d.matchAt && now >= d.matchAt) await match('auto');
    if (d.phase === 'matched' && d.shipBy && !d.remind1 && now >= d.shipBy - 864e5) {
      await db.doc('xg/main').update({ remind1: now });
      const s = await db.collection('xgOut').get();
      for (const o of s.docs) if (!o.data().shipAt) { try { await push(o.id, '⏰ 交換禮物快到寄出期限', '請在 ' + md(d.shipBy) + ' 前寄出你的禮物', '/#/xmas', 'xmas-r'); } catch (e) {} }
    }
  });
  return X;
};
