// 依 rmtag 的備份，把那些植物重新加上「海外品種」（放回原本「國外進口」的位置）。IMG_PATHS=dry|apply
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const MODE = (process.env.IMG_PATHS || 'dry').trim(), OLD = '國外進口', NEW = '海外品種';
(async () => {
  const bs = await db.collection('backups').orderBy('at', 'desc').limit(10).get(); const bk = bs.docs.find(d => d.id.startsWith('rmtag_'));
  if (!bk) { console.log('ABORT 找不到備份'); return; } const B = bk.data(); console.log('BACKUP', bk.id, 'ITEMS', B.items.length);
  const todo = []; for (const it of B.items) { const ref = db.doc(it.path), d = await ref.get(); if (!d.exists) continue; const cur = d.data().tags || [];
    if (cur.includes(NEW)) continue; const i = it.tags.indexOf(OLD), next = cur.filter(t => t !== OLD); next.splice(Math.min(Math.max(0, i), next.length), 0, NEW); todo.push({ ref, next, code: d.data().code || d.id }); }
  console.log('TO_TAG', todo.length, 'SAMPLE', todo.slice(0, 3).map(x => x.code + ':' + x.next.join('/')).join(' | '));
  if (MODE !== 'apply') { console.log('DRY_RUN'); return; }
  for (let i = 0; i < todo.length; i += 400) { const b = db.batch(); todo.slice(i, i + 400).forEach(x => b.update(x.ref, { tags: x.next })); await b.commit(); }
  let ok = 0; for (const it of B.items) { const d = await db.doc(it.path).get(); if ((d.data().tags || []).includes(NEW)) ok++; } console.log('APPLIED', todo.length, 'VERIFY_HAS_NEW', ok, '/', B.items.length);
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
