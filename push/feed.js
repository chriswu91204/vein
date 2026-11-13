// 公開的轉發資料：給社群小編 AI／Metricool 用
//   /feed.json        新上架植物＋活動，附可直接發的文案、IG 用圖片、連結
//   /feed.xml         同樣內容的 RSS（Metricool「RSS 自動發文」可直接吃）
//   /img/p/{shop}/{pid}.jpg        植物照片轉成 IG 規格（1080×1350 JPG）
//   /img/e/{mkt|live}/{id}.jpg     活動拼圖（最貴的植物排前面）
//   /s/p/{pid}、/s/e/{kind}/{id}   分享頁：社群預覽圖＋自動轉到網站
// 只輸出已公開上架的內容（不含隱藏、私藏、未上架、已售出），不含任何會員個資。
const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const SITE = 'https://vein-48ec8.web.app';
const OWNER_EMAILS = ['chriswu91204@gmail.com'];
const KIND = { mother: '母株', pup: '側芽', seedling: '實生苗' };
const db = () => admin.firestore();
const ms = v => (v && typeof v.toMillis === 'function') ? v.toMillis() : (+v || 0);
const money = n => 'NT$ ' + Math.round(+n || 0).toLocaleString('en-US');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normSp = s => String(s || '').replace(/（雜交）|\(雜交\)/g, ' hybrid').trim().replace(/\s+/g, ' ').replace(/^([A-Za-z]+) \1\b/i, '$1');
const shortSp = s => { const n = normSp(s); return n.startsWith('Anthurium ') ? n.slice(10) : n; };
const pName = p => (normSp(p.species) + (p.cultivar ? ' ' + (/['‘’"]/.test(p.cultivar) ? p.cultivar : "'" + p.cultivar + "'") : '')).replace(/^./, c => c.toUpperCase()) || p.code || '植物';
const genus = p => normSp(p.species).split(' ')[0] || '';
const tw = t => { const d = new Date(t + 8 * 3600e3); const w = '日一二三四五六'[d.getUTCDay()]; return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '（' + w + '）' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
const photos = p => { const L = []; (p.media || []).forEach(m => { if (!m || !m.url) return; const u = m.type === 'video' ? (m.poster || '') : m.url; if (u && !L.includes(u)) L.push(u); }); [p.coverThumb, p.thumb].forEach(u => { if (u && !L.includes(u)) L.push(u); }); return L.filter(u => /^https:\/\//.test(u)); };
const pub = p => p && p.listed !== false && !p.hidden && !p.private && !p.blocked && !p.purgeAt && (p.status || 'available') === 'available';
const tags = p => { const g = genus(p).toLowerCase(); return ['#VEIN', '#植物履歷', g ? '#' + g : '', '#觀葉植物', '#天南星', '#rareplants', '#plantsofinstagram'].filter(Boolean); };

let ownerCache = null;
async function ownerShops() {
  if (ownerCache && Date.now() - ownerCache.at < 3600e3) return ownerCache.L;
  const L = []; for (const e of OWNER_EMAILS) { try { const u = await admin.auth().getUserByEmail(e); L.push(u.uid); } catch (x) {} }
  ownerCache = { at: Date.now(), L }; return L;
}
async function resolveShop(q) {
  if (!q) return ownerShops();
  if (q === 'all') return null;
  const s = String(q).trim(); const d = await db().doc('shops/' + s).get(); if (d.exists) return [s];
  const h = await db().doc('handles/' + s.toLowerCase()).get(); if (h.exists && h.data().uid) return [h.data().uid];
  const n = await db().collection('shops').where('name', '==', s).limit(1).get(); if (!n.empty) return [n.docs[0].id];
  return [];
}

// 親本：先在同一個賣場找（大部分親本都是自己的植株），找不到就用登錄時填的編號
async function parentsOf(p, sid) {
  const one = async (id, code) => { if (!id && !code) return null; let nm = '', cd = code || ''; if (id) { try { const d = await db().doc('shops/' + sid + '/plants/' + id).get(); if (d.exists) { const q = d.data(); nm = pName(q); cd = cd || q.code || ''; } } catch (e) {} } return (nm || cd) ? { name: nm, code: cd } : null; };
  const mom = await one(p.momId || p.parentId || null, p.momCode || p.parentCode || ''), dad = await one(p.dadId || null, p.dadCode || '');
  return { mom, dad };
}
const parLabel = x => x ? (x.name ? x.name.replace(/^Anthurium\s+/i, '') + (x.code ? '（' + x.code + '）' : '') : x.code) : '';
function plantItem(p, shop, base) {
  const nm = pName(p), kind = KIND[p.kind || 'mother'] || '', memo = String(p.cross || '').trim(), par = p._par || {}, lineage = par.mom || par.dad ? '♀ ' + (parLabel(par.mom) || '未知') + ' × ♂ ' + (parLabel(par.dad) || '未知') : (/[×xX]/.test(memo) ? memo : ''), cross = lineage;
  const auc = p.mode === 'auction', end = ms(p.endsAt) || +p.endsAtMs || 0;
  const priceLine = auc ? '🔨 競標中・起標 ' + money(p.startPrice || p.price) + (end ? '・' + tw(end) + ' 結標' : '') : p.mkt ? '🎪 市集特價 ' + money(p.price) + '（原價 ' + money(p.mkt.orig) + '）' : (+p.price > 0 ? '💰 ' + money(p.price) : '');
  const link = base + '/s/p/' + encodeURIComponent(p.id) + '?s=' + encodeURIComponent(shop.id);
  const head = (auc ? '🔨 競標開始｜' : '🌿 新上架｜') + nm;
  const body = [head, lineage ? '🧬 ' + lineage : '', '🏷 ' + [kind, p.code ? '編號 ' + p.code : ''].filter(Boolean).join('・'), priceLine, (+p.photoCount || 0) > 1 ? '📸 已有 ' + p.photoCount + ' 筆成長紀錄' : '', '🏡 ' + (shop.name || 'VEIN')].filter(Boolean).join('\n');
  const T = tags(p).join(' ');
  const pi = base + '/img/p/' + encodeURIComponent(shop.id) + '/' + encodeURIComponent(p.id) + '.jpg'; const T7 = 'tpl=' + tplToday(); const imgs = [pi + '?' + T7, ...photos(p).slice(1, 10).map((u, i) => pi + '?raw=1&i=' + (i + 1))];
  const at = ms(p.listedAt) || ms(p.createdAt) || ms(p.updatedAt);
  return {
    id: 'p-' + p.id, type: auc ? 'auction' : 'plant', title: head, name: nm, code: p.code || '', kind, cross: lineage, lineage, mother: par.mom || null, father: par.dad || null, memo, photoCount: photos(p).length, price: +p.price || 0, mode: auc ? 'auction' : 'buy', endsAt: end || null,
    shop: shop.name || '', shopId: shop.id, link, story: pi + '?fmt=story&' + T7, compilationKey: shop.id + ':' + p.id, plantUrl: SITE + '/#/plant/' + encodeURIComponent(p.id), image: imgs[0] || null, images: imgs, publishedAt: at ? new Date(at).toISOString() : null,
    caption: { instagram: body + '\n\n📜 植物履歷（成長紀錄、親本血統）👉 ' + link.replace(/^https:\/\//, '') + '\n\n' + T, threads: body + '\n\n📜 植物履歷 👉 ' + link + '\n\n#觀葉植物' },
  };
}

async function eventLots(kind, id) {
  const col = kind === 'mkt' ? 'mkts/' + id + '/e' : 'lives/' + id + '/lots';
  const s = await db().collection(col).get();
  const L = s.docs.map(d => ({ pid: d.id, ...d.data() })).filter(e => (kind === 'mkt' ? ['ok'] : ['ok', 'wait', 'live', 'sold']).includes(e.status));
  const val = e => +(kind === 'mkt' ? e.deal : (e.final || e.start)) || 0;
  L.sort((a, b) => val(b) - val(a));
  return L;
}
async function lotPhoto(e) {
  if (e.thumb && /^https:/.test(e.thumb) && e.name) return e.thumb;
  try { const d = await db().doc('shops/' + e.shop + '/plants/' + e.pid).get(); if (d.exists) { const p = d.data(); if (!e.name) e.name = pName(p); return photos(p)[0] || e.thumb || null; } } catch (x) {}
  return e.thumb || null;
}
function evPhase(x, now) { if (x.phase === 'done' || (x.kind === 'mkt' && x.endAt && now > x.endAt)) return 'done'; if (x.phase === 'on' || (x.startAt && now >= x.startAt)) return 'on'; if (x.startAt && x.startAt - now < 24 * 3600e3) return 'soon'; return x.regOpen ? 'reg' : 'later'; }
async function eventItems(base, now) {
  const out = [];
  for (const kind of ['mkt', 'live']) {
    const s = await db().collection(kind === 'mkt' ? 'mkts' : 'lives').orderBy('startAt', 'desc').limit(12).get();
    for (const d of s.docs) {
      const x = { id: d.id, kind, ...d.data() }; if (x.draft || x.hidden) continue; const ph = evPhase(x, now); if (ph === 'done' || ph === 'later') continue;
      const L = await eventLots(kind, x.id), isM = kind === 'mkt', name = isM ? 'VEIN 市集' : 'VEIN 拍賣會'; const LP = await Promise.all(L.slice(0, 9).map(lotPhoto));
      const link = base + '/s/e/' + kind + '/' + x.id, img0 = base + '/img/e/' + kind + '/' + x.id + '.jpg', img = img0 + '?tpl=' + tplToday(), story = img + '&fmt=story';
      const top = L.slice(0, 5).map((e, i) => (i + 1) + '. ' + (e.name || e.code || '植物') + '　' + (isM ? (e.orig ? money(e.orig) + ' → ' : '') + money(e.deal) : '起拍 ' + money(e.start)));
      const H = { reg: (isM ? '🎪 ' : '🔴 ') + name + '「' + (x.title || '') + '」認證賣家開放報名', soon: (isM ? '🎪 ' : '🔴 ') + name + '「' + (x.title || '') + '」即將開始', on: (isM ? '🎪 ' : '🔴 ') + name + '「' + (x.title || '') + '」' + (isM ? '特賣中' : '現在開拍') }[ph];
      const lines = [H, x.sub || '', '🗓 ' + tw(x.startAt) + (isM ? ' 開賣' : ' 開拍') + (isM && x.endAt ? '～' + tw(x.endAt) : ''), !isM ? '⏱ 每件 ' + (x.dur || 60) + ' 秒・最後 ' + (x.snipe || 10) + ' 秒有人出價再加 ' + (x.snipe || 10) + ' 秒' : '', L.length ? (isM ? '🌿 精選特價：' : '🌿 精選拍品：') + '\n' + top.join('\n') + (L.length > 5 ? '\n（共 ' + L.length + ' 株）' : '') : ''].filter(Boolean).join('\n');
      const T = ['#VEIN', isM ? '#植物市集' : '#植物拍賣', '#觀葉植物', '#天南星', '#rareplants'].join(' ');
      const imgs = [img, ...LP.filter(Boolean).map((u, i) => base + '/img/e/' + kind + '/' + x.id + '.jpg?lot=' + i)];
      const at = ph === 'reg' ? (ms(x.createdAt) || x.startAt - 7 * 864e5) : ph === 'soon' ? x.startAt - 24 * 3600e3 : x.startAt;
      out.push({ id: 'e-' + kind + '-' + x.id + '-' + ph, type: isM ? 'market' : 'live-auction', phase: ph, title: H, eventTitle: x.title || '', startAt: new Date(x.startAt).toISOString(), endAt: x.endAt ? new Date(x.endAt).toISOString() : null, lots: L.length, lotList: L.map(e => ({ pid: e.pid, shopId: e.shop, name: e.name || e.code || '', price: +(isM ? e.deal : e.start) || 0, orig: isM ? (+e.orig || 0) : undefined })), link, story, eventUrl: SITE + '/#/' + (isM ? 'mkt' : 'live') + '/' + x.id, image: img, images: imgs, publishedAt: new Date(Math.min(at, now)).toISOString(),
        caption: { instagram: lines + '\n\n👉 活動網址：' + link.replace(/^https:\/\//, '') + '\n\n' + T, threads: lines + '\n\n👉 ' + link + '\n\n#觀葉植物' } });
    }
  }
  return out;
}

async function buildFeed(req) {
  const base = SITE, now = Date.now(), q = req.query || {};
  const shops = await resolveShop(q.shop), days = Math.min(90, +q.days || 30), lim = Math.min(100, +q.limit || 40);
  const items = [];
  const shopIds = shops || (await db().collection('shops').limit(50).get()).docs.map(d => d.id);
  for (const sid of shopIds) {
    const sd = await db().doc('shops/' + sid).get(); const shop = { id: sid, ...(sd.exists ? sd.data() : {}) };
    const ps = await db().collection('shops/' + sid + '/plants').where('status', '==', 'available').get();
    for (const d of ps.docs) { const p = { id: d.id, ...d.data() }; if (!pub(p) || !photos(p).length) continue; const it0 = plantItem(p, shop, base); if (it0.publishedAt && now - Date.parse(it0.publishedAt) > days * 864e5 && q.all !== '1') continue; try { p._par = await parentsOf(p, sid); } catch (e) {} items.push(plantItem(p, shop, base)); }
  }
  if (q.events !== '0') { try { items.push(...await eventItems(base, now)); } catch (x) { logger.warn('feed events', String(x)); } }
  items.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
  return { updatedAt: new Date(now).toISOString(), site: SITE, shop: shops && shops.length === 1 ? shops[0] : (shops ? shops : 'all'), count: Math.min(lim, items.length), items: items.slice(0, lim),
    howToUse: {
      zh: '每一筆 items 都是一則可以直接發的貼文：caption.instagram / caption.threads 是文案，images 是 IG 規格的 JPG（1080×1350，第一張當封面，最多 10 張可做輪播），link 是分享連結（點了會開植物履歷或活動頁，社群會顯示預覽圖）。用 id 判斷有沒有發過；publishedAt 是上架或活動階段開始時間。活動同一場會依階段（reg 開放報名 → soon 24 小時內開始 → on 進行中）各出現一次，id 不同。',
      compilation: SITE + '/img/c.jpg?ids={compilationKey},{compilationKey}&t=新上架&foot=11/11 新上架（多株合輯圖，加 &fmt=story 是限動版；QR 連到賣場）', params: '?shop=SlowLeaf（賣場名、會員 ID 或 uid；預設是站長賣場；all = 全站） &days=30 &limit=40 &events=0（不要活動） &all=1（不限天數）',
      rss: SITE + '/feed.xml', json: SITE + '/feed.json',
    } };
}

function rss(F) {
  const it = F.items.map(x => '<item><title>' + esc(x.title) + '</title><link>' + esc(x.link) + '</link><guid isPermaLink="false">' + esc(x.id) + '</guid>' + (x.publishedAt ? '<pubDate>' + new Date(x.publishedAt).toUTCString() + '</pubDate>' : '') +
    '<description>' + esc(x.caption.threads) + '</description>' + (x.image ? '<enclosure url="' + esc(x.image) + '" type="image/jpeg" length="0"/><media:content url="' + esc(x.image) + '" medium="image" type="image/jpeg"/>' : '') + '</item>').join('');
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>VEIN 植物新上架與活動</title><link>' + SITE + '</link><description>VEIN 新上架植物、市集與拍賣會</description><language>zh-TW</language><lastBuildDate>' + new Date(F.updatedAt).toUTCString() + '</lastBuildDate>' + it + '</channel></rss>';
}

let sharpMod = null; const sharp = () => (sharpMod = sharpMod || require('sharp'));
async function getImg(u) { const r = await fetch(u); if (!r.ok) throw new Error('img ' + r.status); return Buffer.from(await r.arrayBuffer()); }
const W = 1080, H = 1350;
async function igJpg(buf) { return sharp()(buf).rotate().resize(W, H, { fit: 'cover', position: 'attention' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer(); }
// ---- 多圖直條模板（和網站「多株拼圖」同風格）：標題 → 直條照片（名稱＋價格）→ 日期＋QR ----
let FONT = null; function font() { if (FONT !== null) return FONT; try { const ot = require('opentype.js'); FONT = ot.loadSync(require('path').join(__dirname, 'fonts', 'NotoSansTC-Black.otf')); } catch (e) { logger.warn('font', String(e)); FONT = false; } return FONT; }
function fit(f, t, size, maxW) { t = String(t || ''); if (f.getAdvanceWidth(t, size) <= maxW) return t; while (t.length > 1 && f.getAdvanceWidth(t + '…', size) > maxW) t = t.slice(0, -1); return t + '…'; }
function txt(f, t, x, y, size, fill, maxW) { if (!f || !t) return ''; const s = maxW ? fit(f, t, size, maxW) : String(t); const p = f.getPath(s, x, y, size); return '<path d="' + p.toPathData(1) + '" fill="' + fill + '"/>'; }
async function qrSvg(url, px) { try { const QR = require('qrcode'); const svg = await QR.toString(url, { type: 'svg', margin: 1, color: { dark: '#07080A', light: '#FFFFFF' } }); return sharp()(Buffer.from(svg)).resize(px, px).png().toBuffer(); } catch (e) { return null; } }
// ---- 轉發圖模板（黑＋螢光綠，照片一律整張顯示不裁切）----
// 7 種版型，依台灣時間星期幾輪替（週日 0 … 週六 6），一週不重複；網址可加 ?tpl=0~6 指定
const TPL_NAMES = ['格狀', '主圖', '雜誌', '螢光海報', '底片', '拍立得', '清單'];
const tplToday = () => new Date(Date.now() + 8 * 3600e3).getUTCDay();
const tplOf = q => { const n = parseInt(q && q.tpl, 10); return n >= 0 && n <= 6 ? n : tplToday(); };
const V = '#D2FF00', BG = '#07080A';
async function loadPhotos(items, n) {
  const bufs = await Promise.all(items.slice(0, n).map(async it => { try { const b = await sharp()(await getImg(it.url)).rotate().toBuffer(); const m = await sharp()(b).metadata(); return { b, w: m.width || 3, h: m.height || 4, it }; } catch (e) { return null; } }));
  return bufs.filter(Boolean);
}
async function tileBuf(o, pw, ph, rr) {
  const mask = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + pw + '" height="' + ph + '"><rect width="' + pw + '" height="' + ph + '" rx="' + rr + '"/></svg>');
  return sharp()(o.b).resize(pw, ph, { fit: 'fill' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}
// 照片等比縮進格子裡（整張可見）
function contain(o, c, ax = .5, ay = .5) { const sc = Math.min(c.w / o.w, c.h / o.h), pw = Math.max(1, Math.floor(o.w * sc)), ph = Math.max(1, Math.floor(o.h * sc)); return { o, pw, ph, px: Math.round(c.x + (c.w - pw) * ax), py: Math.round(c.y + (c.h - ph) * ay) }; }
// 在一塊區域內挑最好的幾欄幾列，每列緊貼置中
function gridIn(ok, A, G) {
  const m = Math.max(1, ok.length); let best = null;
  for (let cols = 1; cols <= m; cols++) { const rows = Math.ceil(m / cols), cw = (A.w - G * (cols - 1)) / cols, ch = (A.h - G * (rows - 1)) / rows; if (cw < 60 || ch < 60) continue; let area = 0; ok.forEach(o => { const sc = Math.min(cw / o.w, ch / o.h); area += o.w * sc * o.h * sc; }); const sm = Math.min(...ok.map(o => Math.min(cw / o.w, ch / o.h) * o.h)); const score = area * (0.6 + 0.4 * sm / ch); if (!best || score > best.score) best = { cols, rows, cw, ch, score }; }
  const { cols, rows, cw, ch } = best || { cols: 1, rows: 1, cw: A.w, ch: A.h };
  const SZ = ok.map(o => { const sc = Math.min(cw / o.w, ch / o.h); return { pw: Math.max(1, Math.floor(o.w * sc)), ph: Math.max(1, Math.floor(o.h * sc)) }; });
  const rowH = r => Math.max(...SZ.slice(r * cols, r * cols + cols).map(z => z.ph)), totH = [...Array(rows)].reduce((n, _, r) => n + rowH(r), 0) + G * (rows - 1);
  const out = []; for (let k = 0; k < ok.length; k++) { const r = Math.floor(k / cols), RS = SZ.slice(r * cols, r * cols + cols), rowW = RS.reduce((n, z) => n + z.pw, 0) + G * (RS.length - 1);
    let yr = A.y + (A.h - totH) / 2; for (let q = 0; q < r; q++) yr += rowH(q) + G;
    const { pw, ph } = SZ[k]; out.push({ o: ok[k], pw, ph, px: Math.round(A.x + (A.w - rowW) / 2 + RS.slice(0, k % cols).reduce((n, z) => n + z.pw + G, 0)), py: Math.round(yr + (rowH(r) - ph) / 2) }); }
  return out;
}
// 文字換行（英文以空白斷、中文逐字）
function wrap(f, t, size, maxW, maxLines) {
  t = String(t || '').trim(); if (!f || !t) return t ? [t] : []; const lines = []; let cur = '';
  const toks = t.match(/[A-Za-z0-9'’\-.$×,():/]+\s*|\s+|./g) || [t];
  for (const tk of toks) { if (f.getAdvanceWidth((cur + tk).trimEnd(), size) <= maxW) { cur += tk; continue; } if (cur.trim()) lines.push(cur.trim()); cur = tk.trimStart(); while (f.getAdvanceWidth(cur, size) > maxW && cur.length > 1) { let k = cur.length; while (k > 1 && f.getAdvanceWidth(cur.slice(0, k), size) > maxW) k--; lines.push(cur.slice(0, k)); cur = cur.slice(k); } }
  if (cur.trim()) lines.push(cur.trim());
  if (maxLines && lines.length > maxLines) { const L = lines.slice(0, maxLines); L[maxLines - 1] = fit(f, L[maxLines - 1] + ' ' + lines.slice(maxLines).join(' '), size, maxW); return L; }
  return lines;
}
// 名稱一律完整顯示：放不下先縮字，再不行就多換幾行（不出現 …）
function wrapFit(f, t, size, maxW, want, min) { let sz = size, L = wrap(f, t, sz, maxW); while (L.length > want && sz > min) { sz = Math.max(min, Math.floor(sz * .92)); L = wrap(f, t, sz, maxW); } return { L, sz }; }
const tSize = (f, t, ts, maxW) => f ? Math.max(40, Math.min(ts, Math.floor(ts * maxW / Math.max(1, f.getAdvanceWidth(String(t || ''), ts))))) : ts;
// 照片底部名稱＋價格（漸層上）
function onPhotoLabel(f, bx, small) {
  const it = bx.o.it; if (!it.name && !it.price) return '';
  const fs0 = Math.max(18, Math.min(small ? 26 : 32, Math.round(bx.pw / 11))), mw = bx.pw - 28, W2 = wrapFit(f, it.name, fs0, mw, 3, 14), nl = W2.L, fs = W2.sz, gh = Math.min(bx.ph * .62, fs * (1.6 + 1.25 * (nl.length + 1)));
  let s = '<rect x="' + bx.px + '" y="' + (bx.py + bx.ph - gh) + '" width="' + bx.pw + '" height="' + gh + '" fill="url(#g)"/>';
  const y0 = bx.py + bx.ph - 16; nl.forEach((l, i) => { s += txt(f, l, bx.px + 14, y0 - fs * 1.25 * (nl.length - i), fs, '#fff', mw); });
  return s + txt(f, it.price, bx.px + 14, y0, fs, V, mw);
}
const DEFS = '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".88"/></linearGradient></defs>';
function logo(f, x, y, sub, dark, maxW) { return '<rect x="' + x + '" y="' + (y - 28) + '" width="34" height="34" rx="9" fill="' + (dark ? BG : '#1F6B3A') + '"/><circle cx="' + (x + 17) + '" cy="' + (y - 11) + '" r="7" fill="' + V + '"/>' + txt(f, 'VEIN', x + 46, y, 30, dark ? BG : '#fff') + (sub ? txt(f, '・' + sub, x + 126, y, 30, dark ? 'rgba(7,8,10,.65)' : 'rgba(255,255,255,.65)', (maxW || 1000) - 126) : ''); }
function autoFs(f, t, maxFs, maxW) { return f ? Math.max(30, Math.min(maxFs, Math.floor(maxFs * maxW / Math.max(1, f.getAdvanceWidth(t, maxFs))))) : maxFs; }
async function qrTile(url, size, frame) { const q = await qrSvg(url, size - 24); if (!q) return null; return sharp()({ create: { width: size, height: size, channels: 4, background: '#FFFFFF' } }).composite([{ input: q, left: 12, top: 12 }]).png().toBuffer().then(b => frame ? sharp()(b).extend({ top: 6, bottom: 6, left: 6, right: 6, background: frame }).png().toBuffer() : b); }
const shortUrl = u => u.replace(/^https:\/\//, '').replace(/\?.*$/, '');

// 只有一張照片：無邊框滿版（比例接近就直接鋪滿，差太多就用同張照片模糊當底、整張照片置中，不切到植物）
async function fullBleed({ o, title, more, foot, url, story, sub, f, WW, HH, PAD }) {
  const r0 = o.w / o.h, rC = WW / HH, cut = 1 - Math.min(r0, rC) / Math.max(r0, rC), comp = [];
  if (cut <= .1) comp.push({ input: await sharp()(o.b).resize(WW, HH, { fit: 'cover', position: 'centre' }).toBuffer(), left: 0, top: 0 });
  else { comp.push({ input: await sharp()(o.b).resize(Math.round(WW / 4), Math.round(HH / 4), { fit: 'cover' }).blur(6).modulate({ brightness: .45 }).resize(WW, HH).toBuffer(), left: 0, top: 0 });
    const b = await sharp()(o.b).resize(WW, HH, { fit: 'inside' }).toBuffer({ resolveWithObject: true }); comp.push({ input: b.data, left: Math.round((WW - b.info.width) / 2), top: Math.round((HH - b.info.height) / 2) }); }
  const th = story ? 420 : 290, bh = story ? 560 : 430, it = o.it, ts = tSize(f, title, story ? 92 : 80, WW - PAD * 2 - 20), tl = fit(f, title, ts, WW - PAD * 2 - 20);
  let s = '<svg xmlns="http://www.w3.org/2000/svg" width="' + WW + '" height="' + HH + '"><defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".85"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".45" stop-color="#000" stop-opacity=".75"/><stop offset="1" stop-color="#000" stop-opacity=".92"/></linearGradient></defs>';
  s += '<rect width="' + WW + '" height="' + th + '" fill="url(#t)"/><rect y="' + (HH - bh) + '" width="' + WW + '" height="' + bh + '" fill="url(#b)"/>';
  const ly = story ? 150 : 72; s += logo(f, PAD + 16, ly, sub, false, WW - PAD * 2) + txt(f, tl, PAD + 16, ly + ts + 22, ts, '#fff') + '<rect x="' + (PAD + 16) + '" y="' + (ly + ts + 46) + '" width="120" height="8" rx="4" fill="' + V + '"/>';
  const qr = story ? 220 : 170, qy = HH - (story ? 160 : 52) - qr, mw = WW - PAD * 2 - 32 - qr - 30, lab = !!(it.name || it.price);
  const fs = autoFs(f, foot, lab ? (story ? 72 : 64) : (story ? 92 : 80), mw), fyB = lab ? qy + qr - 6 : qy + qr / 2 + fs * .36; s += txt(f, foot, PAD + 16, fyB, fs, V);
  if (lab) { const W2 = wrapFit(f, it.name, 38, mw, 3, 24), nl = W2.L, ns = W2.sz; let y = fyB - fs - 20; if (it.price) { s += txt(f, it.price, PAD + 16, y, 38, V, mw); y -= 48; } for (let i = nl.length - 1; i >= 0; i--) { s += txt(f, nl[i], PAD + 16, y, ns, '#fff'); y -= ns * 1.25; } }
  if (story) s += txt(f, shortUrl(url), PAD + 16, HH - 92, 26, 'rgba(255,255,255,.6)', WW - PAD * 2);
  if (more > 0) { const mt = '+' + more, mw2 = f ? f.getAdvanceWidth(mt, 42) : 80; s += '<rect x="' + (WW - PAD - mw2 - 32) + '" y="' + (ly - 40) + '" width="' + (mw2 + 32) + '" height="60" rx="30" fill="rgba(0,0,0,.65)" stroke="' + V + '" stroke-width="2"/>' + txt(f, mt, WW - PAD - mw2 - 16, ly + 5, 42, '#fff'); }
  comp.push({ input: Buffer.from(s + '</svg>'), left: 0, top: 0 });
  const q = await qrTile(url, qr); if (q) comp.push({ input: q, left: WW - PAD - 16 - qr, top: qy });
  return sharp()({ create: { width: WW, height: HH, channels: 3, background: BG } }).composite(comp).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}
async function strips({ title, items, more, foot, url, story, sub, tpl }) {
  tpl = tpl == null ? tplToday() : tpl;
  const f = font(), WW = 1080, HH = story ? 1920 : 1350, PAD = 40;
  const ok = await loadPhotos(items, tpl === 6 && items.some(i => i.name) ? 5 : 6);
  const labeled = ok.some(o => o.it.name || o.it.price);
  const TOP = story ? 280 : 165, BOT = story ? 300 : 195;
  if (ok.length === 1) return fullBleed({ o: ok[0], title, more, foot, url, story, sub, f, WW, HH, PAD });
  const comp = [], P = []; let bg = BG, svg = '', svgTop = '';
  const put = (bx, rr) => P.push({ bx, rr: rr == null ? Math.round(Math.min(bx.pw, bx.ph) * .04) : rr });
  const moreBadge = (x, y) => { if (!(more > 0)) return ''; const mt = '+' + more, mw2 = f ? f.getAdvanceWidth(mt, 42) : 80; return '<rect x="' + (x - mw2 - 32) + '" y="' + y + '" width="' + (mw2 + 32) + '" height="60" rx="30" fill="rgba(0,0,0,.65)" stroke="' + V + '" stroke-width="2"/>' + txt(f, mt, x - mw2 - 16, y + 45, 42, '#fff'); };
  // 標準頁首、頁尾（多數版型共用）
  const head = (top, center) => { const ty = top - (story ? 50 : 30), ts = tSize(f, title, story ? 92 : 76, WW - PAD * 2); const tl = fit(f, title, ts, WW - PAD * 2); const tw2 = f ? f.getAdvanceWidth(tl, ts) : 0;
    return logo(f, center ? Math.round((WW - 126 - (sub && f ? f.getAdvanceWidth('・' + sub, 30) : 0)) / 2) : PAD + 16, story ? 150 : 56, sub, false, WW - PAD * 2) + txt(f, tl, center ? Math.round((WW - tw2) / 2) : PAD + 16, ty, ts, '#fff'); };
  const footer = async (y0, h, opt = {}) => { const qr = Math.min(story ? 220 : 160, h - 24), fy = y0 + h / 2, mw = WW - PAD * 2 - 32 - qr - 30, fs = autoFs(f, foot, story ? 92 : 80, mw);
    let s = txt(f, foot, PAD + 16, fy + fs * .36 - (story ? 18 : 0), fs, opt.color || V); if (story) s += txt(f, shortUrl(url), PAD + 16, fy + fs * .36 + 46, 26, opt.dim || 'rgba(255,255,255,.55)', mw);
    const q = await qrTile(url, qr, opt.qrFrame); if (q) comp.push({ input: q, left: WW - PAD - 16 - qr - (opt.qrFrame ? 6 : 0), top: Math.round(fy - qr / 2) }); return s; };

  if (tpl === 1) { // 主圖：第一張大圖，其餘小圖排一列
    const top = TOP, bot = BOT, A = { x: 28, y: top + 6, w: WW - 56, h: HH - top - bot - 12 };
    if (ok.length <= 1) { ok.forEach(o => put(contain(o, A))); }
    else { const hh = Math.round(A.h * (ok.length > 3 ? .64 : .7)); put(contain(ok[0], { x: A.x, y: A.y, w: A.w, h: hh })); gridIn(ok.slice(1), { x: A.x, y: A.y + hh + 16, w: A.w, h: A.h - hh - 16 }, 12).forEach(b => put(b)); }
    svg += head(top) + '<rect x="' + PAD + '" y="' + (top - 6) + '" width="160" height="8" rx="4" fill="' + V + '"/>' + await footer(HH - bot, bot);
    svgTop += moreBadge(WW - PAD - 12, top + 26);
  } else if (tpl === 2) { // 雜誌：左側大字標題欄，右側照片
    const LW = 400, A = { x: LW + 20, y: PAD, w: WW - LW - 20 - PAD, h: HH - PAD * 2 };
    gridIn(ok, A, 12).forEach(b => put(b));
    svg += '<rect x="0" y="0" width="' + (LW - 10) + '" height="' + HH + '" fill="#0F1114"/><rect x="' + (LW - 10) + '" y="0" width="6" height="' + HH + '" fill="' + V + '"/>';
    svg += logo(f, PAD, PAD + 50, '', false);
    const ts = story ? 74 : 64, tl = wrap(f, title, ts, LW - PAD * 2 - 10); let y = PAD + 150 + ts; tl.forEach(l => { svg += txt(f, l, PAD, y, ts, '#fff'); y += ts * 1.18; });
    if (sub) { y += 10; wrap(f, sub, 28, LW - PAD * 2 - 10, 3).forEach(l => { svg += txt(f, l, PAD, y, 28, 'rgba(255,255,255,.6)'); y += 38; }); }
    const qr = 200, qy = HH - PAD - qr - (story ? 50 : 0); const fl = wrap(f, foot, 56, LW - PAD * 2 - 10, 3); let fy = qy - 40 - (fl.length - 1) * 66;
    svg += '<rect x="' + PAD + '" y="' + (fy - 86) + '" width="70" height="6" fill="' + V + '"/>'; fl.forEach(l => { svg += txt(f, l, PAD, fy, 56, V); fy += 66; });
    if (story) svg += txt(f, shortUrl(url), PAD, HH - PAD - 10, 20, 'rgba(255,255,255,.5)', LW - PAD * 2);
    const q = await qrTile(url, qr); if (q) comp.push({ input: q, left: PAD, top: qy });
    svgTop += moreBadge(WW - PAD - 12, PAD + 16);
  } else if (tpl === 3) { // 螢光海報：螢光綠底、黑字、黑框照片
    bg = V; const top = TOP + 20, bot = BOT + 10, A = { x: PAD + 6, y: top + 6, w: WW - PAD * 2 - 12, h: HH - top - bot - 12 };
    gridIn(ok, A, 18).forEach(b => put(b, 6));
    const ts = tSize(f, title, story ? 104 : 92, WW - PAD * 2 - 20), tl = fit(f, title, ts, WW - PAD * 2 - 20);
    svg += logo(f, PAD + 8, story ? 150 : 62, sub, true, WW - PAD * 2) + txt(f, tl, PAD + 8, top - (story ? 52 : 32), ts, BG);
    P.forEach(({ bx }) => { svg += '<rect x="' + (bx.px - 6) + '" y="' + (bx.py - 6) + '" width="' + (bx.pw + 12) + '" height="' + (bx.ph + 12) + '" rx="10" fill="' + BG + '"/>'; });
    svg += '<rect x="0" y="' + (HH - bot + 20) + '" width="' + WW + '" height="' + (bot - 20) + '" fill="' + BG + '"/>' + await footer(HH - bot + 20, bot - 20);
    svgTop += moreBadge(WW - PAD - 12, top + 20);
  } else if (tpl === 4) { // 底片：照片排在帶齒孔的底片條上（自動挑 1~3 條，照片盡量撐滿）
    const top = TOP, bot = BOT, A = { x: 0, y: top, w: WW, h: HH - top - bot }, n = ok.length, HB = 24, IP = 6, G = 10, BG2 = 14, SW = WW - 32;
    let best = null; for (let nr = 1; nr <= Math.min(3, n); nr++) { const per = Math.ceil(n / nr), R = []; for (let i = 0; i < n; i += per) R.push(ok.slice(i, i + per));
      const bandMax = (A.h - BG2 * (R.length - 1)) / R.length - HB * 2 - IP * 2; if (bandMax < 80) continue;
      const hs = R.map(r => Math.min(bandMax, (SW - G * (r.length - 1)) / r.reduce((q, o) => q + o.w / o.h, 0))), area = R.reduce((q, r, i) => q + r.reduce((z, o) => z + o.w / o.h * hs[i] * hs[i], 0), 0);
      if (!best || area > best.area) best = { R, hs, area }; }
    const { R, hs } = best; let y = A.y + (A.h - (hs.reduce((a, b) => a + Math.floor(b), 0) + (HB * 2 + IP * 2) * R.length + BG2 * (R.length - 1))) / 2;
    R.forEach((r, ri) => { const h = Math.floor(hs[ri]), bh = h + HB * 2 + IP * 2; svg += '<rect x="0" y="' + y + '" width="' + WW + '" height="' + bh + '" fill="#16181C"/>';
      for (let x = 12; x < WW; x += 38) svg += '<rect x="' + x + '" y="' + (y + 6) + '" width="20" height="12" rx="3" fill="' + V + '" opacity=".9"/><rect x="' + x + '" y="' + (y + bh - 18) + '" width="20" height="12" rx="3" fill="' + V + '" opacity=".9"/>';
      const ws = r.map(o => Math.floor(o.w / o.h * h)), tw = ws.reduce((a, b) => a + b, 0) + G * (r.length - 1); let x = Math.round((WW - tw) / 2);
      r.forEach((o, i) => { put({ o, pw: ws[i], ph: h, px: x, py: Math.round(y + HB + IP) }, 4); x += ws[i] + G; }); y += bh + BG2; });
    svg += head(top, true) + await footer(HH - bot, bot);
    svgTop += moreBadge(WW - PAD, top + HB + 14);
  } else if (tpl === 5) { // 拍立得：深色相框、微微傾斜散放
    const top = TOP, bot = BOT, A = { x: 24, y: top + 14, w: WW - 48, h: HH - top - bot - 28 };
    const capR = labeled ? .26 : .12, cells = gridIn(ok.map(o => ({ ...o, w: o.w * 1.08, h: o.h + o.w * (.04 + capR) })), A, 22), ang = [-3.5, 2.5, -2, 3, -2.5, 2];
    for (let k = 0; k < cells.length; k++) { const c = cells[k], o = ok[k], s = .93, fw = Math.round(c.pw * s), fh = Math.round(c.ph * s), m = Math.round(fw * .04), cap = Math.round(fw * capR), pw = fw - m * 2, ph = fh - m - cap;
      try { const fs0 = Math.max(15, Math.min(30, Math.round(cap / 2.7))), W1 = wrapFit(f, o.it.name, fs0, fw - m * 2 - 8, 2, 11), z2 = Math.min(W1.sz, Math.floor((cap - 8) / ((W1.L.length + (o.it.price ? 1 : 0)) * 1.18 || 1))), W2 = z2 < W1.sz ? { L: wrap(f, o.it.name, z2, fw - m * 2 - 8), sz: z2 } : W1, NL = W2.L, fs = W2.sz, nl = NL.length, pr = o.it.price || '';
        let fr = '<svg xmlns="http://www.w3.org/2000/svg" width="' + fw + '" height="' + fh + '"><rect width="' + fw + '" height="' + fh + '" rx="6" fill="#1B1D21" stroke="' + V + '" stroke-opacity=".7" stroke-width="3"/>';
        if (nl || pr) { const y0 = ph + m + (cap - (nl + (pr ? 1 : 0)) * fs * 1.18) / 2 + fs * .95; NL.forEach((l, i) => { fr += txt(f, l, m + 4, y0 + i * fs * 1.18, fs, '#fff'); }); fr += txt(f, pr, m + 4, y0 + nl * fs * 1.18, Math.max(fs, 14), V); } else fr += '<circle cx="' + (fw / 2) + '" cy="' + (ph + m + cap / 2) + '" r="' + Math.max(5, cap * .12) + '" fill="' + V + '"/>';
        fr += '</svg>'; const ph2 = await sharp()(o.b).resize(pw, ph, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
        const card = await sharp()(Buffer.from(fr)).composite([{ input: ph2.data, left: m + Math.round((pw - ph2.info.width) / 2), top: m + Math.round((ph - ph2.info.height) / 2) }]).png().toBuffer();
        const rot = await sharp()(card).rotate(ang[k % 6], { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
        comp.push({ input: rot.data, left: Math.max(0, Math.round(c.px + c.pw / 2 - rot.info.width / 2)), top: Math.max(0, Math.round(c.py + c.ph / 2 - rot.info.height / 2)) }); } catch (e) {} }
    svg += head(top) + '<rect x="0" y="' + (HH - bot) + '" width="' + WW + '" height="3" fill="' + V + '" opacity=".6"/>' + await footer(HH - bot, bot);
    svgTop += moreBadge(WW - PAD - 12, top + 10);
  } else if (tpl === 6 && labeled) { // 清單：每株一列，縮圖＋大字名稱價格
    const top = TOP, bot = BOT, A = { x: PAD, y: top + 14, w: WW - PAD * 2, h: HH - top - bot - 28 }, n = ok.length, G = 16, rh = Math.min(story ? 320 : 270, (A.h - G * (n - 1)) / n), y0 = A.y + (A.h - (rh * n + G * (n - 1))) / 2, tw = Math.round(rh * 1.05);
    ok.forEach((o, k) => { const y = y0 + k * (rh + G); put(contain(o, { x: A.x, y, w: tw, h: rh }, 0, .5), 10);
      if (k) svg += '<rect x="' + A.x + '" y="' + (y - G / 2 - 1) + '" width="' + A.w + '" height="2" fill="rgba(210,255,0,.25)"/>';
      const tx = A.x + tw + 30, mw = A.w - tw - 30, W2 = wrapFit(f, o.it.name, Math.min(48, Math.max(28, Math.round(rh / 5))), mw, 3, 22), fs = W2.sz, nl = W2.L, ty = y + rh / 2 - (nl.length * fs * 1.2 + fs * 1.3) / 2 + fs;
      svg += txt(f, String(k + 1).padStart(2, '0'), tx, ty - fs * 1.05, 22, V); nl.forEach((l, i) => { svg += txt(f, l, tx, ty + i * fs * 1.2, fs, '#fff'); }); svg += txt(f, o.it.price, tx, ty + nl.length * fs * 1.2 + fs * .15, Math.round(fs * 1.05), V, mw); });
    svg += head(top) + '<rect x="0" y="' + (top - 4) + '" width="' + WW + '" height="6" fill="' + V + '"/><rect x="0" y="' + (HH - bot) + '" width="' + WW + '" height="6" fill="' + V + '"/>' + await footer(HH - bot, bot);
    svgTop += moreBadge(WW - PAD, HH - bot - 70);
  } else if (tpl === 6) { // 拼貼（植物單株用）：左邊大圖、右邊直排小圖
    const top = TOP, bot = BOT, A = { x: 28, y: top + 12, w: WW - 56, h: HH - top - bot - 24 };
    if (ok.length <= 1) ok.forEach(o => put(contain(o, A))); else { const lw = Math.round(A.w * .6); put(contain(ok[0], { x: A.x, y: A.y, w: lw, h: A.h }, 1, .5)); gridIn(ok.slice(1, 5), { x: A.x + lw + 14, y: A.y, w: A.w - lw - 14, h: A.h }, 12).forEach(b => put(b)); }
    svg += head(top) + '<rect x="' + PAD + '" y="' + (top) + '" width="' + (WW - PAD * 2) + '" height="2" fill="' + V + '"/><rect x="' + PAD + '" y="' + (HH - bot - 2) + '" width="' + (WW - PAD * 2) + '" height="2" fill="' + V + '"/>' + await footer(HH - bot, bot);
    svgTop += moreBadge(WW - PAD - 12, top + 30);
  } else { // 0 格狀（原本的多圖模板）
    const top = TOP, bot = BOT + 10, A = { x: 20, y: top, w: WW - 40, h: HH - top - bot };
    gridIn(ok, A, 14).forEach(b => put(b));
    svg += '<rect x="0" y="' + (top - 8) + '" width="' + WW + '" height="8" fill="' + V + '"/><rect x="0" y="' + (top + A.h + 8) + '" width="' + WW + '" height="8" fill="' + V + '"/>' + head(top) + await footer(top + A.h + 16, bot - 16);
    svgTop += moreBadge(WW - 40, top + 16);
  }
  // 照片（圓角）＋螢光細框＋名稱價格
  const tiles = [];
  for (const { bx, rr } of P) { try { tiles.push({ input: await tileBuf(bx.o, bx.pw, bx.ph, rr), left: bx.px, top: bx.py }); } catch (e) {}
    if (tpl !== 3) svgTop += '<rect x="' + (bx.px - 1.5) + '" y="' + (bx.py - 1.5) + '" width="' + (bx.pw + 3) + '" height="' + (bx.ph + 3) + '" rx="' + (rr + 1.5) + '" fill="none" stroke="rgba(210,255,0,.55)" stroke-width="3"/>';
    if (!(tpl === 6 && labeled)) svgTop += onPhotoLabel(f, bx, tpl === 4); }
  const W0 = '<svg xmlns="http://www.w3.org/2000/svg" width="' + WW + '" height="' + HH + '">' + DEFS;
  const layers = [{ input: Buffer.from(W0 + svg + '</svg>'), left: 0, top: 0 }, ...tiles, ...comp, { input: Buffer.from(W0 + svgTop + '</svg>'), left: 0, top: 0 }];
  return sharp()({ create: { width: WW, height: HH, channels: 3, background: bg } }).composite(layers).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

const hhmm = t => { const d = new Date(t + 8 * 3600e3); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };

// ---- 單株卡片：大圖＋名稱、類型編號、價格、QR（貼文 4:5／限動 9:16）----
async function plantCard(p, shop, story, i, tpl) {
  // 站長預設模板：和活動同一個多圖直條模板（標題＝植物名、各張照片直條、底部價格＋QR）
  const L = photos(p); if (!L.length) return null; const auc = p.mode === 'auction', end = ms(p.endsAt) || +p.endsAtMs || 0;
  const sub = [KIND[p.kind || 'mother'] || '', p.code || ''].filter(Boolean).join('・');
  const items = L.slice(0, 6).map(u => ({ url: u, name: '', price: '' })); const sub2 = [sub, auc && end ? hhmm(end) + ' 結標' : ''].filter(Boolean).join('・');
  const price = auc ? '起標 ' + money(p.startPrice || p.price) : p.mkt ? '特價 ' + money(p.price) : (+p.price > 0 ? money(p.price) : 'VEIN 植物履歷');
  return strips({ title: pName(p).replace(/^Anthurium\s+/i, ''), items, more: Math.max(0, L.length - items.length), foot: price, url: SITE + '/s/p/' + encodeURIComponent(p.id) + '?s=' + encodeURIComponent(shop), story, sub: sub2, tpl });
}
// 多株合輯（新上架合輯用）：/img/c.jpg?ids=shop:pid,shop:pid&t=標題&foot=底部文字
async function multiCard(ids, title, foot, story, tpl) {
  const P = []; for (const id of ids.slice(0, 12)) { const [sid, pid] = id.split(':'); try { const d = await db().doc('shops/' + sid + '/plants/' + pid).get(); const p = d.exists ? { id: pid, shop: sid, ...d.data() } : null; if (pub(p) && photos(p).length) P.push(p); } catch (e) {} }
  if (!P.length) return null; const shop = P[0].shop;
  const items = P.slice(0, 6).map(p => ({ url: photos(p)[0], name: pName(p).replace(/^Anthurium\s+/i, ''), price: p.mode === 'auction' ? '起標 ' + money(p.startPrice || p.price) : money(p.price) }));
  const url = P.length === 1 ? SITE + '/s/p/' + encodeURIComponent(P[0].id) + '?s=' + encodeURIComponent(shop) : SITE + '/s/shop/' + encodeURIComponent(shop);
  return strips({ title: title || '新上架', items, more: Math.max(0, P.length - items.length), foot: foot || 'VEIN 植物履歷', url, story, tpl });
}
async function eventCard(kind, id, story, shop, tpl) {
  const d = await db().doc((kind === 'mkt' ? 'mkts/' : 'lives/') + id).get(); const x = d.exists ? d.data() : {}; const isM = kind === 'mkt';
  let L = await eventLots(kind, id); if (shop) L = L.filter(e => e.shop === shop); const U = await Promise.all(L.slice(0, 6).map(lotPhoto));
  const items = L.slice(0, 6).map((e, i) => ({ url: U[i], name: shortSp(e.name || e.code || '').replace(/^Anthurium\s+/i, ''), price: isM ? money(e.deal) : '起拍 ' + money(e.start) })).filter(i => i.url);
  if (!items.length) return null;
  return strips({ title: x.title || (isM ? 'VEIN 市集' : 'VEIN 拍賣會'), items, more: Math.max(0, L.length - items.length), foot: (x.startAt ? hhmm(x.startAt) : '') + (isM ? ' 開賣' : ' 開拍'), url: SITE + '/s/e/' + kind + '/' + id, story, tpl });
}
async function collage(urls) {
  const U = urls.slice(0, 6), n = U.length; if (!n) throw new Error('no photos');
  if (n === 1) return igJpg(await getImg(U[0]));
  // 第一張（最貴）放大，其餘排右邊／下面
  const cells = n === 2 ? [[0, 0, W, 675], [0, 675, W, 675]] : n === 3 ? [[0, 0, W, 810], [0, 810, 540, 540], [540, 810, 540, 540]] : n === 4 ? [[0, 0, W, 810], [0, 810, 360, 540], [360, 810, 360, 540], [720, 810, 360, 540]]
    : n === 5 ? [[0, 0, 720, 900], [720, 0, 360, 450], [720, 450, 360, 450], [0, 900, 540, 450], [540, 900, 540, 450]] : [[0, 0, 720, 900], [720, 0, 360, 450], [720, 450, 360, 450], [0, 900, 360, 450], [360, 900, 360, 450], [720, 900, 360, 450]];
  const G = 6, parts = await Promise.all(U.map(async (u, i) => { const [x, y, w, h] = cells[i]; try { const b = await sharp()(await getImg(u)).rotate().resize(w - G, h - G, { fit: 'cover', position: 'attention' }).jpeg().toBuffer(); return { input: b, left: x + G / 2, top: y + G / 2 }; } catch (e) { return null; } }));
  const frame = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><rect x="6" y="6" width="' + (W - 12) + '" height="' + (H - 12) + '" fill="none" stroke="#D2FF00" stroke-width="12" rx="10"/><circle cx="60" cy="60" r="16" fill="#D2FF00"/><circle cx="60" cy="60" r="7" fill="#07080A"/></svg>');
  return sharp()({ create: { width: W, height: H, channels: 3, background: '#07080A' } }).composite([...parts.filter(Boolean), { input: frame, left: 0, top: 0 }]).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}

function sharePage(o) {
  return '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(o.title) + '</title>' +
    '<meta property="og:type" content="website"><meta property="og:site_name" content="VEIN"><meta property="og:title" content="' + esc(o.title) + '"><meta property="og:description" content="' + esc(o.desc) + '"><meta property="og:url" content="' + esc(o.url) + '">' + (o.img ? '<meta property="og:image" content="' + esc(o.img) + '"><meta property="og:image:width" content="1080"><meta property="og:image:height" content="1350"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="' + esc(o.img) + '">' : '') +
    '<meta name="description" content="' + esc(o.desc) + '"><link rel="canonical" href="' + esc(o.to) + '"><script>location.replace(' + JSON.stringify(o.to) + ')</script></head><body style="background:#07080A;color:#fff;font-family:system-ui;padding:24px"><p><a style="color:#D2FF00" href="' + esc(o.to) + '">' + esc(o.title) + '</a></p><p>' + esc(o.desc).replace(/\n/g, '<br>') + '</p></body></html>';
}

module.exports = onRequest({ memory: '512MiB', timeoutSeconds: 60, cors: true, invoker: 'public' }, async (req, res) => {
  const path = (req.path || '/').replace(/\/+$/, '') || '/';
  try {
    // 校時：回傳伺服器現在時間（毫秒），拍賣會頁面每 10 秒校正一次倒數
    if (path === '/time') { res.set('Cache-Control', 'no-store, max-age=0'); res.json({ now: Date.now() }); return; }
    if (path === '/feed.json' || path === '/feed' || path === '/') { const F = await buildFeed(req); res.set('Cache-Control', 'public, max-age=300, s-maxage=300'); res.json(F); return; }
    if (path === '/feed.xml' || path === '/rss') { const F = await buildFeed(req); res.set('Cache-Control', 'public, max-age=300, s-maxage=300'); res.type('application/rss+xml; charset=utf-8').send(rss(F)); return; }
    let m;
    if ((m = path.match(/^\/img\/p\/([^/]+)\/([^/]+?)(?:\.jpg)?$/))) {
      const d = await db().doc('shops/' + decodeURIComponent(m[1]) + '/plants/' + decodeURIComponent(m[2])).get(); const p = d.exists ? d.data() : null; if (!pub(p)) { res.status(404).send('not found'); return; }
      const L = photos(p), i = Math.max(0, Math.min(L.length - 1, +req.query.i || 0)); let out = null;
      if (req.query.raw !== '1' && font()) { try { out = await plantCard({ id: decodeURIComponent(m[2]), ...p }, decodeURIComponent(m[1]), req.query.fmt === 'story', i, tplOf(req.query)); } catch (e) { logger.warn('plantCard', String(e)); } }
      if (!out) out = await igJpg(await getImg(L[i]));
      res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400').type('image/jpeg').send(out); return;
    }
    if ((m = path.match(/^\/img\/e\/(mkt|live)\/([^/]+?)(?:\.jpg)?$/))) {
      const L = await eventLots(m[1], decodeURIComponent(m[2])); const U = (await Promise.all(L.slice(0, 9).map(lotPhoto))).filter(Boolean);
      let out; if (req.query.lot != null) out = await igJpg(await getImg(U[Math.max(0, Math.min(U.length - 1, +req.query.lot || 0))]));
      else { try { if (font()) out = await eventCard(m[1], decodeURIComponent(m[2]), req.query.fmt === 'story', req.query.shop ? String(req.query.shop) : null, tplOf(req.query)); } catch (e) { logger.warn('strips', String(e)); } if (!out) out = U.length ? await collage(U) : await igJpg(await getImg(SITE + '/og.png')); }
      res.set('Cache-Control', 'public, max-age=1800, s-maxage=1800').type('image/jpeg').send(out); return;
    }
    if (path === '/img/c.jpg' || path === '/img/c') {
      const ids = String(req.query.ids || '').split(',').filter(Boolean); const out = (font() && ids.length) ? await multiCard(ids, String(req.query.t || ''), String(req.query.foot || ''), req.query.fmt === 'story', tplOf(req.query)) : null;
      if (!out) { res.status(404).send('not found'); return; } res.set('Cache-Control', 'public, max-age=1800, s-maxage=1800').type('image/jpeg').send(out); return;
    }
    if ((m = path.match(/^\/s\/shop\/([^/]+)$/))) {
      const sid = decodeURIComponent(m[1]); const d = await db().doc('shops/' + sid).get(); const sh = d.exists ? d.data() : {};
      res.set('Cache-Control', 'public, max-age=600'); res.type('html').send(sharePage({ title: (sh.name || 'VEIN 賣場') + '｜VEIN', desc: '看 ' + (sh.name || '這個賣場') + ' 的植物與植物履歷', img: SITE + '/og.png', url: SITE + req.originalUrl, to: SITE + '/#/seller/' + encodeURIComponent(sid) })); return;
    }
    if ((m = path.match(/^\/s\/p\/([^/]+)$/))) {
      const pid = decodeURIComponent(m[1]), sid = String(req.query.s || ''); let p = null;
      if (sid) { const d = await db().doc('shops/' + sid + '/plants/' + pid).get(); p = d.exists ? d.data() : null; }
      const to = SITE + '/#/plant/' + encodeURIComponent(pid);
      res.set('Cache-Control', 'public, max-age=600'); res.type('html').send(sharePage(pub(p) ? { title: pName(p) + (p.code ? '｜' + p.code : '') + '｜VEIN 植物履歷', desc: [String(p.cross || ''), KIND[p.kind || 'mother'] || '', +p.price > 0 ? money(p.price) : ''].filter(Boolean).join('・'), img: SITE + '/img/p/' + encodeURIComponent(sid) + '/' + encodeURIComponent(pid) + '.jpg', url: SITE + req.originalUrl, to } : { title: 'VEIN 植物履歷', desc: '看這株植物的成長紀錄與血統', img: SITE + '/og.png', url: SITE + req.originalUrl, to })); return;
    }
    if ((m = path.match(/^\/s\/e\/(mkt|live)\/([^/]+)$/))) {
      const kind = m[1], id = decodeURIComponent(m[2]); const d = await db().doc((kind === 'mkt' ? 'mkts/' : 'lives/') + id).get(); const x = d.exists ? d.data() : {};
      const to = SITE + '/#/' + kind + '/' + encodeURIComponent(id);
      res.set('Cache-Control', 'public, max-age=600'); res.type('html').send(sharePage({ title: (kind === 'mkt' ? 'VEIN 市集｜' : 'VEIN 拍賣會｜') + (x.title || ''), desc: (x.startAt ? tw(x.startAt) + (kind === 'mkt' ? ' 開賣' : ' 開拍') : '') + (x.sub ? '・' + x.sub : ''), img: SITE + '/img/e/' + kind + '/' + encodeURIComponent(id) + '.jpg', url: SITE + req.originalUrl, to })); return;
    }
    res.status(404).send('not found');
  } catch (e) { logger.error('feed', String(e && e.stack || e)); res.status(500).json({ error: 'feed error' }); }
});
