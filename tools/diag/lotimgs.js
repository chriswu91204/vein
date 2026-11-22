// 給 AI 小編：某場拍賣會每件拍品的第一張照片＋名稱／編號／備註／起拍價（公開資訊）。IMG_PATHS=拍賣會 id。輸出 out/lots.json、out/lot_NN.jpg
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore(); const fs = require('fs');
const id = (process.env.IMG_PATHS || '').trim();
(async () => {
  if (!id) { console.log('ABORT'); return; } fs.mkdirSync('out', { recursive: true });
  const ev = (await db.doc('lives/' + id).get()).data() || {};
  const L = (await db.collection('lives/' + id + '/lots').get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(l => ['ok', 'wait', 'live', 'sold', 'pass', 'skip'].includes(l.status))
    .sort((a, b) => ((+a.ord || 0) - (+b.ord || 0)) || ((a.at || 0) - (b.at || 0)));
  const out = [];
  for (const [i, l] of L.entries()) {
    const p = (await db.doc('shops/' + l.shop + '/plants/' + l.pid).get()).data() || {};
    const ph = []; (p.media || []).forEach(m => { const u = m && (m.type === 'video' ? m.poster : m.url); if (u && /^https:/.test(u) && !ph.includes(u)) ph.push(u); }); [p.coverThumb, p.thumb].forEach(u => { if (u && /^https:/.test(u) && !ph.includes(u)) ph.push(u); });
    let ok = false; if (ph[0]) { try { const r = await fetch(ph[0]); if (r.ok) { fs.writeFileSync('out/lot_' + String(i + 1).padStart(2, '0') + '.jpg', Buffer.from(await r.arrayBuffer())); ok = true; } } catch (e) {} }
    out.push({ n: i + 1, pid: l.pid, status: l.status, name: [p.species, p.cultivar].filter(Boolean).join(' ') || l.name || '', code: p.code || l.code || '', memo: String(p.cross || '').trim(), kind: p.kind || '', start: +l.start || 0, img: ok });
  }
  fs.writeFileSync('out/lots.json', JSON.stringify({ title: ev.title, startAt: ev.startAt, lots: out }, null, 1));
  out.forEach(x => console.log('LOT', x.n, x.code, x.start, x.img ? 'img' : 'noimg', x.memo ? 'memo' : ''));
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
