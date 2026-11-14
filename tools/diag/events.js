// 給 AI 小編用：直接讀 Firestore 的拍賣會（lives）與市集（mkts），含還沒進 feed 的（phase=later、尚未開放報名）
// 只輸出公開活動資訊與拍品名稱／起標價（不含會員個資）。輸出 tools/diag/out/events.json
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (+v || 0);
(async () => {
  const out = []; const now = Date.now();
  for (const kind of ['live', 'mkt']) {
    const s = await db.collection(kind === 'mkt' ? 'mkts' : 'lives').orderBy('startAt', 'desc').limit(8).get();
    for (const d of s.docs) {
      const x = d.data(); const startAt = ms(x.startAt), endAt = ms(x.endAt);
      if (endAt && endAt < now - 864e5) continue; if (!endAt && startAt && startAt < now - 3 * 864e5) continue;
      const col = kind === 'mkt' ? 'mkts/' + d.id + '/e' : 'lives/' + d.id + '/lots';
      const L = (await db.collection(col).get()).docs.map(e => ({ pid: e.id, ...e.data() }));
      const lots = [];
      for (const e of L) {
        let name = e.name || '', code = e.code || '', thumb = e.thumb || '';
        if ((!name || !thumb) && e.shop) { try { const p = (await db.doc('shops/' + e.shop + '/plants/' + e.pid).get()).data() || {}; name = name || [p.species, p.cultivar].filter(Boolean).join(' '); code = code || p.code || ''; thumb = thumb || p.coverThumb || p.thumb || ''; } catch (_) {} }
        lots.push({ pid: e.pid, shop: e.shop || '', name, code, status: e.status || '', start: +e.start || 0, deal: +e.deal || 0, orig: +e.orig || 0, order: e.order ?? e.idx ?? null, thumb: /^https:/.test(thumb) ? thumb : '' });
      }
      out.push({ kind, id: d.id, title: x.title || '', sub: x.sub || '', phase: x.phase || '', regOpen: !!x.regOpen, draft: !!x.draft, hidden: !!x.hidden, startAt: startAt ? new Date(startAt).toISOString() : null, endAt: endAt ? new Date(endAt).toISOString() : null, dur: x.dur || null, snipe: x.snipe || null, lots });
    }
  }
  require('fs').mkdirSync('out', { recursive: true }); require('fs').writeFileSync('out/events.json', JSON.stringify(out, null, 1));
  out.forEach(e => console.log('EV', e.kind, e.id, e.phase, e.startAt, 'lots=' + e.lots.length));
})().catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
