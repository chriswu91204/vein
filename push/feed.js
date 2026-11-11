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

function plantItem(p, shop, base) {
  const nm = pName(p), kind = KIND[p.kind || 'mother'] || '', cross = String(p.cross || '').trim();
  const auc = p.mode === 'auction', end = ms(p.endsAt) || +p.endsAtMs || 0;
  const priceLine = auc ? '🔨 競標中・起標 ' + money(p.startPrice || p.price) + (end ? '・' + tw(end) + ' 結標' : '') : p.mkt ? '🎪 市集特價 ' + money(p.price) + '（原價 ' + money(p.mkt.orig) + '）' : (+p.price > 0 ? '💰 ' + money(p.price) : '');
  const link = base + '/s/p/' + encodeURIComponent(p.id) + '?s=' + encodeURIComponent(shop.id);
  const head = (auc ? '🔨 競標開始｜' : '🌿 新上架｜') + nm;
  const body = [head, cross ? (/[×xX]/.test(cross) ? '🧬 ' : '📝 ') + cross : '', '🏷 ' + [kind, p.code ? '編號 ' + p.code : ''].filter(Boolean).join('・'), priceLine, (+p.photoCount || 0) > 1 ? '📸 已有 ' + p.photoCount + ' 筆成長紀錄' : '', '🏡 ' + (shop.name || 'VEIN')].filter(Boolean).join('\n');
  const T = tags(p).join(' ');
  const pi = base + '/img/p/' + encodeURIComponent(shop.id) + '/' + encodeURIComponent(p.id) + '.jpg'; const imgs = [pi, ...photos(p).slice(1, 10).map((u, i) => pi + '?raw=1&i=' + (i + 1))];
  const at = ms(p.listedAt) || ms(p.createdAt) || ms(p.updatedAt);
  return {
    id: 'p-' + p.id, type: auc ? 'auction' : 'plant', title: head, name: nm, code: p.code || '', kind, cross, price: +p.price || 0, mode: auc ? 'auction' : 'buy', endsAt: end || null,
    shop: shop.name || '', shopId: shop.id, link, story: pi + '?fmt=story', compilationKey: shop.id + ':' + p.id, plantUrl: SITE + '/#/plant/' + encodeURIComponent(p.id), image: imgs[0] || null, images: imgs, publishedAt: at ? new Date(at).toISOString() : null,
    caption: { instagram: body + '\n\n📜 植物履歷（成長紀錄、親本血統）👉 ' + link.replace(/^https:\/\//, '') + '\n\n' + T, threads: body + '\n\n📜 植物履歷 👉 ' + link + '\n\n' + T.split(' ').slice(0, 4).join(' ') },
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
      const link = base + '/s/e/' + kind + '/' + x.id, img = base + '/img/e/' + kind + '/' + x.id + '.jpg', story = img + '?fmt=story';
      const top = L.slice(0, 5).map((e, i) => (i + 1) + '. ' + (e.name || e.code || '植物') + '　' + (isM ? (e.orig ? money(e.orig) + ' → ' : '') + money(e.deal) : '起拍 ' + money(e.start)));
      const H = { reg: (isM ? '🎪 ' : '🔴 ') + name + '「' + (x.title || '') + '」認證賣家開放報名', soon: (isM ? '🎪 ' : '🔴 ') + name + '「' + (x.title || '') + '」即將開始', on: (isM ? '🎪 ' : '🔴 ') + name + '「' + (x.title || '') + '」' + (isM ? '特賣中' : '現在開拍') }[ph];
      const lines = [H, x.sub || '', '🗓 ' + tw(x.startAt) + (isM ? ' 開賣' : ' 開拍') + (isM && x.endAt ? '～' + tw(x.endAt) : ''), !isM ? '⏱ 每件 ' + (x.dur || 60) + ' 秒・最後 ' + (x.snipe || 10) + ' 秒有人出價再加 ' + (x.snipe || 10) + ' 秒' : '', L.length ? (isM ? '🌿 精選特價：' : '🌿 精選拍品：') + '\n' + top.join('\n') + (L.length > 5 ? '\n（共 ' + L.length + ' 株）' : '') : ''].filter(Boolean).join('\n');
      const T = ['#VEIN', isM ? '#植物市集' : '#植物拍賣', '#觀葉植物', '#天南星', '#rareplants'].join(' ');
      const imgs = [img, ...LP.filter(Boolean).map((u, i) => base + '/img/e/' + kind + '/' + x.id + '.jpg?lot=' + i)];
      const at = ph === 'reg' ? (ms(x.createdAt) || x.startAt - 7 * 864e5) : ph === 'soon' ? x.startAt - 24 * 3600e3 : x.startAt;
      out.push({ id: 'e-' + kind + '-' + x.id + '-' + ph, type: isM ? 'market' : 'live-auction', phase: ph, title: H, eventTitle: x.title || '', startAt: new Date(x.startAt).toISOString(), endAt: x.endAt ? new Date(x.endAt).toISOString() : null, lots: L.length, link, story, eventUrl: SITE + '/#/' + (isM ? 'mkt' : 'live') + '/' + x.id, image: img, images: imgs, publishedAt: new Date(Math.min(at, now)).toISOString(),
        caption: { instagram: lines + '\n\n👉 活動網址：' + link.replace(/^https:\/\//, '') + '\n\n' + T, threads: lines + '\n\n👉 ' + link + '\n\n' + T.split(' ').slice(0, 3).join(' ') } });
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
    ps.docs.forEach(d => { const p = { id: d.id, ...d.data() }; if (!pub(p) || !photos(p).length) return; const it = plantItem(p, shop, base); if (it.publishedAt && now - Date.parse(it.publishedAt) > days * 864e5 && q.all !== '1') return; items.push(it); });
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
async function strips({ title, items, more, foot, url, story }) {
  const f = font(), WW = 1080, HH = story ? 1920 : 1350, top = story ? 300 : 200, bot = story ? 330 : 250, n = Math.max(1, Math.min(6, items.length));
  const sh = HH - top - bot, sw = Math.floor(WW / n), V = '#D2FF00';
  const tiles = await Promise.all(items.slice(0, n).map(async (it, i) => { try { const w = i === n - 1 ? WW - sw * (n - 1) : sw; const b = await sharp()(await getImg(it.url)).rotate().resize(w - 6, sh, { fit: 'cover', position: 'attention' }).jpeg().toBuffer(); return { input: b, left: i * sw + 3, top }; } catch (e) { return null; } }));
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + WW + '" height="' + HH + '"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".85"/></linearGradient></defs>';
  svg += '<rect x="0" y="' + (top - 8) + '" width="' + WW + '" height="8" fill="' + V + '"/><rect x="0" y="' + (top + sh) + '" width="' + WW + '" height="8" fill="' + V + '"/>';
  svg += '<rect x="0" y="' + (top + sh - 170) + '" width="' + WW + '" height="170" fill="url(#g)"/>';
  // 左上 VEIN 標誌
  svg += '<rect x="56" y="' + (story ? 120 : 52) + '" width="34" height="34" rx="9" fill="#1F6B3A"/><circle cx="73" cy="' + (story ? 137 : 69) + '" r="7" fill="' + V + '"/>' + txt(f, 'VEIN', 102, (story ? 148 : 80), 30, '#fff');
  svg += txt(f, title, 56, top - (story ? 50 : 40), story ? 92 : 78, '#fff', WW - 112);
  items.slice(0, n).forEach((it, i) => { const x = i * sw + 14, mw = sw - 26, fs = n <= 3 ? 30 : n <= 4 ? 25 : 21; let a = String(it.name || ''), b = ''; if (f && f.getAdvanceWidth(a, fs) > mw) { let k = a.length; while (k > 1 && f.getAdvanceWidth(a.slice(0, k), fs) > mw) k--; const sp = a.lastIndexOf(' ', k); const c = sp > 2 ? sp : k; b = a.slice(c).trim(); a = a.slice(0, c).trim(); } const y0 = top + sh - 20; svg += (b ? txt(f, a, x, y0 - fs * 2.5, fs, '#fff', mw) + txt(f, b, x, y0 - fs * 1.25, fs, '#fff', mw) : txt(f, a, x, y0 - fs * 1.25, fs, '#fff', mw)) + txt(f, it.price, x, y0, fs, V, mw); });
  if (more > 0) { const mt = '+' + more, mw2 = f ? f.getAdvanceWidth(mt, 46) : 80; svg += '<rect x="' + (WW - mw2 - 52) + '" y="' + (top + 24) + '" width="' + (mw2 + 32) + '" height="64" rx="32" fill="rgba(0,0,0,.6)"/>' + txt(f, mt, WW - mw2 - 36, top + 72, 46, '#fff'); }
  const qr = story ? 230 : 180, fy = top + sh + 8 + (bot - 8) / 2;
  const fs2 = f ? Math.min(story ? 92 : 80, Math.floor(80 * (WW - 112 - qr - 30) / Math.max(1, f.getAdvanceWidth(foot, 80)))) : 80; svg += txt(f, foot, 56, fy + fs2 * 0.36, fs2, V);
  if (story) svg += txt(f, url.replace(/^https:\/\//, ''), 56, HH - 60, 26, 'rgba(255,255,255,.55)', WW - 112);
  svg += '</svg>';
  const comp = [...tiles.filter(Boolean), { input: Buffer.from(svg), left: 0, top: 0 }]; const q = await qrSvg(url, qr - 24);
  if (q) comp.push({ input: await sharp()({ create: { width: qr, height: qr, channels: 4, background: '#FFFFFF' } }).composite([{ input: q, left: 12, top: 12 }]).png().toBuffer(), left: WW - 56 - qr, top: Math.round(fy - qr / 2) });
  return sharp()({ create: { width: WW, height: HH, channels: 3, background: '#07080A' } }).composite(comp).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}
const hhmm = t => { const d = new Date(t + 8 * 3600e3); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };

// ---- 單株卡片：大圖＋名稱、類型編號、價格、QR（貼文 4:5／限動 9:16）----
async function plantCard(p, shop, story, i) {
  const f = font(), WW = 1080, HH = story ? 1920 : 1350, bot = story ? 420 : 300, V = '#D2FF00', L = photos(p); if (!L.length) return null;
  const ph = await sharp()(await getImg(L[Math.max(0, Math.min(L.length - 1, i || 0))])).rotate().resize(WW, HH - bot, { fit: 'cover', position: 'attention' }).jpeg().toBuffer();
  const url = SITE + '/s/p/' + encodeURIComponent(p.id) + '?s=' + encodeURIComponent(shop), qr = story ? 250 : 200, auc = p.mode === 'auction', end = ms(p.endsAt) || +p.endsAtMs || 0;
  const name = pName(p).replace(/^Anthurium\s+/i, ''), sub = [KIND[p.kind || 'mother'] || '', p.code || ''].filter(Boolean).join('・');
  const price = auc ? '起標 ' + money(p.startPrice || p.price) + (end ? '・' + hhmm(end) + ' 結標' : '') : p.mkt ? '特價 ' + money(p.price) : (+p.price > 0 ? money(p.price) : '');
  const tw0 = WW - 112 - qr - 30, y0 = HH - bot; let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + WW + '" height="' + HH + '">';
  svg += '<rect x="0" y="' + (y0 - 8) + '" width="' + WW + '" height="8" fill="' + V + '"/>';
  svg += '<rect x="40" y="' + (story ? 110 : 40) + '" width="170" height="58" rx="29" fill="rgba(0,0,0,.6)"/><circle cx="76" cy="' + (story ? 139 : 69) + '" r="9" fill="' + V + '"/>' + txt(f, 'VEIN', 96, (story ? 152 : 82), 34, '#fff');
  if (auc) svg += '<rect x="' + (WW - 250) + '" y="' + (story ? 110 : 40) + '" width="210" height="58" rx="29" fill="#FF2D55"/>' + txt(f, '競標中', WW - 214, (story ? 152 : 82), 34, '#fff');
  // 名稱最多兩行
  let a = name, b = ''; const nfs = story ? 64 : 56; if (f && f.getAdvanceWidth(a, nfs) > tw0) { let k = a.length; while (k > 1 && f.getAdvanceWidth(a.slice(0, k), nfs) > tw0) k--; const sp = a.lastIndexOf(' ', k); const c = sp > 2 ? sp : k; b = a.slice(c).trim(); a = a.slice(0, c).trim(); }
  let y = y0 + (story ? 90 : 78); svg += txt(f, a, 56, y, nfs, '#fff', tw0); if (b) { y += nfs * 1.15; svg += txt(f, b, 56, y, nfs, '#fff', tw0); }
  y += story ? 62 : 52; svg += txt(f, sub, 56, y, story ? 34 : 30, 'rgba(255,255,255,.6)', tw0);
  if (price) { y += story ? 80 : 66; svg += txt(f, price, 56, y, story ? 64 : 54, V, tw0); }
  if (story) svg += txt(f, url.replace(/^https:\/\//, '').replace(/\?.*$/, ''), 56, HH - 44, 26, 'rgba(255,255,255,.5)', WW - 112);
  svg += '</svg>';
  const comp = [{ input: ph, left: 0, top: 0 }, { input: Buffer.from(svg), left: 0, top: 0 }]; const q = await qrSvg(url, qr - 24);
  if (q) comp.push({ input: await sharp()({ create: { width: qr, height: qr, channels: 4, background: '#FFFFFF' } }).composite([{ input: q, left: 12, top: 12 }]).png().toBuffer(), left: WW - 56 - qr, top: Math.round(y0 + (bot - qr) / 2) });
  return sharp()({ create: { width: WW, height: HH, channels: 3, background: '#07080A' } }).composite(comp).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}
// 多株合輯（新上架合輯用）：/img/c.jpg?ids=shop:pid,shop:pid&t=標題&foot=底部文字
async function multiCard(ids, title, foot, story) {
  const P = []; for (const id of ids.slice(0, 12)) { const [sid, pid] = id.split(':'); try { const d = await db().doc('shops/' + sid + '/plants/' + pid).get(); const p = d.exists ? { id: pid, shop: sid, ...d.data() } : null; if (pub(p) && photos(p).length) P.push(p); } catch (e) {} }
  if (!P.length) return null; const shop = P[0].shop;
  const items = P.slice(0, 6).map(p => ({ url: photos(p)[0], name: pName(p).replace(/^Anthurium\s+/i, ''), price: p.mode === 'auction' ? '起標 ' + money(p.startPrice || p.price) : money(p.price) }));
  const url = P.length === 1 ? SITE + '/s/p/' + encodeURIComponent(P[0].id) + '?s=' + encodeURIComponent(shop) : SITE + '/s/shop/' + encodeURIComponent(shop);
  return strips({ title: title || '新上架', items, more: Math.max(0, P.length - items.length), foot: foot || 'VEIN 植物履歷', url, story });
}
async function eventCard(kind, id, story) {
  const d = await db().doc((kind === 'mkt' ? 'mkts/' : 'lives/') + id).get(); const x = d.exists ? d.data() : {}; const isM = kind === 'mkt';
  const L = await eventLots(kind, id); const U = await Promise.all(L.slice(0, 6).map(lotPhoto));
  const items = L.slice(0, 6).map((e, i) => ({ url: U[i], name: shortSp(e.name || e.code || '').replace(/^Anthurium\s+/i, ''), price: isM ? money(e.deal) : '起拍 ' + money(e.start) })).filter(i => i.url);
  if (!items.length) return null;
  return strips({ title: x.title || (isM ? 'VEIN 市集' : 'VEIN 拍賣會'), items, more: Math.max(0, L.length - items.length), foot: (x.startAt ? hhmm(x.startAt) : '') + (isM ? ' 開賣' : ' 開拍'), url: SITE + '/s/e/' + kind + '/' + id, story });
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
    if (path === '/feed.json' || path === '/feed' || path === '/') { const F = await buildFeed(req); res.set('Cache-Control', 'public, max-age=300, s-maxage=300'); res.json(F); return; }
    if (path === '/feed.xml' || path === '/rss') { const F = await buildFeed(req); res.set('Cache-Control', 'public, max-age=300, s-maxage=300'); res.type('application/rss+xml; charset=utf-8').send(rss(F)); return; }
    let m;
    if ((m = path.match(/^\/img\/p\/([^/]+)\/([^/]+?)(?:\.jpg)?$/))) {
      const d = await db().doc('shops/' + decodeURIComponent(m[1]) + '/plants/' + decodeURIComponent(m[2])).get(); const p = d.exists ? d.data() : null; if (!pub(p)) { res.status(404).send('not found'); return; }
      const L = photos(p), i = Math.max(0, Math.min(L.length - 1, +req.query.i || 0)); let out = null;
      if (req.query.raw !== '1' && font()) { try { out = await plantCard({ id: decodeURIComponent(m[2]), ...p }, decodeURIComponent(m[1]), req.query.fmt === 'story', i); } catch (e) { logger.warn('plantCard', String(e)); } }
      if (!out) out = await igJpg(await getImg(L[i]));
      res.set('Cache-Control', 'public, max-age=86400, s-maxage=86400').type('image/jpeg').send(out); return;
    }
    if ((m = path.match(/^\/img\/e\/(mkt|live)\/([^/]+?)(?:\.jpg)?$/))) {
      const L = await eventLots(m[1], decodeURIComponent(m[2])); const U = (await Promise.all(L.slice(0, 9).map(lotPhoto))).filter(Boolean);
      let out; if (req.query.lot != null) out = await igJpg(await getImg(U[Math.max(0, Math.min(U.length - 1, +req.query.lot || 0))]));
      else { try { if (font()) out = await eventCard(m[1], decodeURIComponent(m[2]), req.query.fmt === 'story'); } catch (e) { logger.warn('strips', String(e)); } if (!out) out = U.length ? await collage(U) : await igJpg(await getImg(SITE + '/og.png')); }
      res.set('Cache-Control', 'public, max-age=1800, s-maxage=1800').type('image/jpeg').send(out); return;
    }
    if (path === '/img/c.jpg' || path === '/img/c') {
      const ids = String(req.query.ids || '').split(',').filter(Boolean); const out = (font() && ids.length) ? await multiCard(ids, String(req.query.t || ''), String(req.query.foot || ''), req.query.fmt === 'story') : null;
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
