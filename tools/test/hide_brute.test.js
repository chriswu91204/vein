// 暴力測試：商店隱藏／溫室隱藏要「徹底」——賣家本人與訪客在所有列表都看不到（本機 Playwright + fakefb）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const OUT = process.env.OUT || path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const FAKE = fs.readFileSync(path.join(__dirname, 'fakefb.js'), 'utf8'); const now = Date.now(), iso = t => new Date(t).toISOString();
const B = (o) => ({ kind: 'mother', status: 'available', price: 3000, mode: 'fixed', createdAt: iso(now - 1e7), listedAt: now - 1e7, photoCount: 1, tags: [], ...o });
const docs = { 'shops/S1': { name: 'SlowLeaf', owner: 'S1' }, 'site/sellers': { approved: { S1: { at: 1 } } }, 'site/verified': { uids: { S1: true } },
  'shops/S1/plants/V1': B({ code: 'AN-SWL-00001', species: 'Anthurium zzvisible' }),
  'shops/S1/plants/H1': B({ code: 'AN-SWL-00002', species: 'Anthurium zzhidea', hidden: true, ghHide: true, parentId: 'V1' }),
  'shops/S1/plants/H2': B({ code: 'AN-SWL-00003', species: 'Anthurium zzhideb', hidden: true, mode: 'auction', price: 1, startPrice: 1, endsAtMs: now + 864e5, parentId: 'V1' }),
  'shops/S1/plants/G1': B({ code: 'AN-SWL-00004', species: 'Anthurium zzghonly', hidden: true, ghHide: false }),
  'shops/S1/plants/H3': B({ code: 'AN-SWL-00005', species: 'Anthurium zzhidec', kind: 'pup', hidden: true, ghHide: true, grp: 'G9', parentId: 'V1' }),
};
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '✓' : '✗', m); };
const HID = /zzhide[abc]/i;
async function role(b, me, tag) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript(d => { window.__SEED = d; }, { me, names: { S1: 'SlowLeaf', U2: '路人' }, docs });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.includes('/js/vein-firebase.js')) return r.fulfill({ contentType: 'text/javascript', body: FAKE }); if (u.startsWith('http://localhost:8767')) return r.continue(); return r.abort(); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  const W = ms => p.waitForTimeout(ms); const txt = () => p.evaluate(() => { document.querySelectorAll('.gt-ov').forEach(x => x.remove()); return document.body.innerText + ' ' + [...document.querySelectorAll('img[alt],[title],[aria-label]')].map(e => e.alt || e.title || e.getAttribute('aria-label')).join(' '); });
  const check = async (name, extra) => { const t = await txt(); const m = t.match(HID); ok(!m, `[${tag}] ${name}：看不到隱藏植株` + (m ? ' ← 出現 ' + m[0] : '')); if (extra) await extra(t); };
  const visit = async (hash, ms = 2200) => { await p.goto('http://localhost:8767/' + hash); await W(ms); };
  await visit('#/', 3500); await check('首頁');
  await visit('#/store'); await check('商店主頁', t => ok(/zzvisible/i.test(t), `[${tag}] 商店主頁：一般植株有出現（對照組）`));
  for (let i = 0; i < 8; i++) { await p.mouse.wheel(0, 1500); await W(250); } await check('商店主頁滑到底（全部植物）');
  await visit('#/store/search'); await p.evaluate(() => { const i = document.querySelector('input[type=search],.sr-in input,input[placeholder*="搜尋"]'); if (i) { i.value = 'zzhid'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } }); await W(1500); await check('搜尋「zzhid」');
  await visit('#/seller/S1'); await check('賣場首頁', t => ok(/zzvisible/i.test(t), `[${tag}] 賣場首頁：一般植株有出現（對照組）`));
  const tabs = await p.evaluate(() => [...document.querySelectorAll('button,a')].map(b => b.innerText.trim()).filter(t => /^(全部商品|批量群組|家族系列|展示櫃|首頁)/.test(t)));
  for (const t of [...new Set(tabs)]) { await p.evaluate(t => { const b = [...document.querySelectorAll('button,a')].find(x => x.innerText.trim() === t); b && b.click(); }, t); await W(900); await check('賣場分頁「' + t.replace(/\s+/g, ' ') + '」'); if (/全部商品/.test(t)) await p.screenshot({ path: path.join(OUT, `hb_${tag}_all.png`) }); }
  await visit('#/gh/S1', 3000); await check('溫室', t => ok(/zzghonly/i.test(t) && /zzvisible/i.test(t), `[${tag}] 溫室：只關商店不關溫室的那株仍在溫室（獨立開關）`)); await p.screenshot({ path: path.join(OUT, `hb_${tag}_gh.png`) });
  await visit('#/history/V1'); await check('父株履歷的後代列表');
  await visit('#/verify/AN-SWL-00001'); await check('查驗頁血統樹（後代）');
  await visit('#/verify/AN-SWL-00004'); ok(/AN-SWL-00004/.test(await txt()), `[${tag}] 隱藏植株本身仍可用編號查驗（標籤 QR 不失效）`);
  await visit('#/history/G1'); await check('隱藏植株的履歷頁（兄弟姊妹不外露）');
  for (const h of ['#/feed', '#/live', '#/raffle', '#/community', '#/me', '#/group']) { await visit(h, 1800); await check(h); }
  await visit('#/store/auction'); await check('競標頁（含競標中的隱藏母株）');
  ok(!errs.length, `[${tag}] 沒有 JS 錯誤 ` + errs.slice(0, 3).join(' | '));
  await ctx.close();
}
(async () => { const b = await chromium.launch(); await role(b, 'S1', '賣家本人'); await role(b, 'U2', '訪客'); await role(b, null, '未登入');
  console.log('PASS', pass, 'FAIL', fail); await b.close(); process.exit(fail ? 1 : 0); })();
