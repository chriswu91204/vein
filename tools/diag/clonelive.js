// 複製上一場拍賣會的設定開新場（不含拍品）。IMG_PATHS=dry|apply
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const MODE = (process.env.IMG_PATHS || 'dry').trim(), SRC = 'ZehFqf6eo3F1vJcUljkJ';
const START = Date.parse('2026-11-29T21:00:00+08:00');
(async () => {
  const s = (await db.doc('lives/' + SRC).get()).data(); if (!s) { console.log('ABORT no src'); return; }
  const show = { ...s }; delete show.html; delete show.cur; console.log('SRC', JSON.stringify(show).slice(0, 1500), 'HTML', (s.html || '').length);
  const ex = await db.collection('lives').where('startAt', '==', START).get(); if (ex.size) { console.log('ABORT 已有同時間場次', ex.docs.map(d => d.id + ':' + d.data().title).join(',')); return; }
  const keep = ['sub', 'tpl', 'html', 'cover', 'rules', 'dur', 'snipe', 'step', 'approve', 'regOpen'];
  const doc = {}; keep.forEach(k => { if (s[k] !== undefined) doc[k] = s[k]; });
  doc.title = '冬休最終場｜週末拍賣會'; doc.sub = '今年最後一場，我們春天再見'; doc.startAt = START; doc.regOpen = true; doc.phase = 'reg';
  if (s.regEnd && s.startAt) doc.regEnd = START - (s.startAt - s.regEnd);
  doc.createdAt = Date.now(); doc.updatedAt = Date.now();
  const d2 = { ...doc }; delete d2.html; console.log('NEW', JSON.stringify(d2), 'regEnd', doc.regEnd ? new Date(doc.regEnd).toISOString() : '-');
  if (MODE !== 'apply') { console.log('DRY_RUN'); return; }
  const ref = db.collection('lives').doc(); await ref.set(doc); console.log('CREATED', ref.id);
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
