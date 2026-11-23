// 聖誕交換禮物：建立活動設定＋SlowLeaf 精選禮物登錄；IMG_PATHS=dry|apply|push（push＝全站推播一次）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const MODE = (process.env.IMG_PATHS || 'dry').trim();
const T = s => Date.parse(s);
(async () => {
  const shops = await db.collection('shops').get(); const sl = shops.docs.filter(d => /slow\s*leaf/i.test(String(d.data().name || '')));
  if (sl.length !== 1) { console.log('ABORT slowleaf', sl.length); return; } const uid = sl[0].id;
  const IMG = 'https://vein-48ec8.web.app/m/xmas/muchlis.jpg';
  const cfg = { on: true, phase: 'reg', title: '聖誕交換禮物', min: 500,
    regEnd: T('2026-12-19T23:59:59+08:00'), matchAt: T('2026-12-20T00:00:00+08:00'), shipBy: T('2026-12-23T23:59:59+08:00'),
    feat: { by: 'SlowLeaf', name: 'Muchlis 側芽', val: 17000, img: IMG, note: '配對完全隨機，說不定就是你收到！快來參加' }, createdAt: Date.now() };
  const cur = await db.doc('xg/main').get();
  console.log('CUR', cur.exists ? JSON.stringify({ phase: cur.data().phase, nOk: cur.data().nOk, bcastAt: cur.data().bcastAt || null }) : 'none');
  if (MODE === 'apply') {
    if (!cur.exists) await db.doc('xg/main').set(cfg); else console.log('SKIP cfg exists');
    const e = await db.doc('xgE/' + uid).get();
    if (!e.exists) await db.doc('xgE/' + uid).set({ uid, src: 'manual', name: 'Muchlis 側芽', img: IMG, val: 17000, note: '美麗的 Muchlis 側芽', ship: {}, status: 'ok', at: Date.now(), upd: Date.now(), rvAt: Date.now() });
    else console.log('SKIP entry exists');
    const c2 = (await db.doc('xg/main').get()).data(); console.log('CFG', JSON.stringify({ ...c2, feat: undefined }), 'ENTRY', (await db.doc('xgE/' + uid).get()).exists);
  } else if (MODE === 'push') {
    const c = await db.doc('xg/main').get(); if (!c.exists) { console.log('ABORT no cfg'); return; } if (c.data().bcastAt) { console.log('ABORT already pushed', c.data().bcastAt); return; }
    await db.doc('xg/main').update({ bcastAt: Date.now() });
    const r = await db.collection('broadcast').add({ title: '🎄 聖誕交換禮物開始登錄！', body: '送一株 NT$500+ 的植物、收一份驚喜。SlowLeaf 也放了價值 NT$17,000 的 Muchlis 側芽，快來參加！', link: '/#/xmas', target: 'all', at: Date.now(), by: 'xmas' });
    for (let i = 0; i < 30; i++) { await new Promise(r2 => setTimeout(r2, 4000)); const d = (await r.get()).data(); if (d.done) { console.log('PUSHED', JSON.stringify({ sent: d.sent, fail: d.fail, users: d.users, err: d.err || null })); return; } }
    console.log('PUSH pending', r.id);
  } else if (MODE === 'touch') { await db.doc('xgE/' + uid).update({ upd: Date.now() }); await new Promise(r => setTimeout(r, 15000)); const c = (await db.doc('xg/main').get()).data(); console.log('COUNTS', c.nOk, c.nPend, c.nAll);
  } else console.log('DRY_RUN', JSON.stringify({ ...cfg, feat: cfg.feat.name }));
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
