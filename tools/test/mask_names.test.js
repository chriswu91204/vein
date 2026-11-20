// 交易相關的會員名字：只有管理員看得到完整，其他人（含賣家）看到「首*尾」（本機 Playwright + fakefb）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const OUT = process.env.OUT || path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const FAKE = fs.readFileSync(path.join(__dirname, 'fakefb.js'), 'utf8'); const now = Date.now(), iso = t => new Date(t).toISOString();
const names = { S1: 'SlowLeaf', U2: '王小明', U3: 'Chris Wu', U4: '林', AD: '站長' };
const docs = { 'shops/S1': { name: 'SlowLeaf', owner: 'S1' }, 'site/sellers': { approved: { S1: { at: 1 } } }, 'site/verified': { uids: { S1: true } },
  'shops/S1/plants/P1': { code: 'AN-SWL-00297', species: 'Anthurium warocqueanum', kind: 'mother', status: 'available', mode: 'auction', price: 1, startPrice: 1, endsAtMs: now + 864e5, createdAt: iso(now - 1e7), listedAt: now - 1e7, photoCount: 1 },
  'social/U2': { bids: { P1: { amt: 800, at: now - 5e4 } } }, 'social/U3': { bids: { P1: { amt: 500, at: now - 9e4 } } }, 'social/U4': { bids: { P1: { amt: 300, at: now - 1e5 } } } };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '✓' : '✗', m); };
async function role(b, me, admin, tag) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(d => { window.__SEED = d; }, { me, admin, names, docs });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.includes('/js/vein-firebase.js')) return r.fulfill({ contentType: 'text/javascript', body: FAKE }); if (u.startsWith('http://localhost:8767')) return r.continue(); return r.abort(); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8767/#/plant/P1'); await p.waitForTimeout(3500);
  await p.evaluate(() => document.querySelectorAll('.gt-ov').forEach(x => x.remove()));
  const t = await p.evaluate(() => document.body.innerText);
  const full = /王小明|Chris Wu/.test(t), masked = /王\*明/.test(t) && /C\*{6}u/.test(t) && /林\*/.test(t);
  if (admin) ok(full, `[${tag}] 管理員看得到完整名字`); else { ok(!full, `[${tag}] 看不到完整名字（王小明／Chris Wu）`); if (me) ok(masked, `[${tag}] 名字變成 王*明／C******u／林*`); }
  await p.screenshot({ path: path.join(OUT, `mask_${tag}.png`), fullPage: false });
  await p.evaluate(() => { const e = [...document.querySelectorAll('.bids')][0]; e && e.scrollIntoView({ block: 'center' }); }); await p.waitForTimeout(400); await p.screenshot({ path: path.join(OUT, `mask_${tag}_bids.png`) });
  ok(!errs.length, `[${tag}] 沒有 JS 錯誤 ` + errs.join('|')); await ctx.close();
}
(async () => { const b = await chromium.launch(); await role(b, 'S1', false, '賣家'); await role(b, 'U9', false, '其他會員'); await role(b, null, false, '未登入'); await role(b, 'AD', true, '管理員');
  console.log('PASS', pass, 'FAIL', fail); await b.close(); process.exit(fail ? 1 : 0); })();
