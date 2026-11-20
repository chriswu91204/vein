// 植株「隱私與刪除」分頁：在商店展示開關（本機 Playwright + fakefb）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const OUT = process.env.OUT || path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const FAKE = fs.readFileSync(path.join(__dirname, 'fakefb.js'), 'utf8'); const now = Date.now();
const base = { species: 'Anthurium warocqueanum', kind: 'mother', status: 'available', price: 3000, createdAt: new Date(now - 1e8).toISOString(), photoCount: 0 };
const docs = { 'shops/S1': { name: 'SlowLeaf', owner: 'S1' }, 'site/sellers': { approved: { S1: { at: 1 } } }, 'site/verified': { uids: { S1: true } },
  'shops/S1/plants/M1': { ...base, code: 'AN-SWL-00297', hidden: true, mode: 'auction', endsAtMs: now + 2 * 864e5, startPrice: 1, price: 1 },
  'shops/S1/plants/M2': { ...base, code: 'AN-SWL-00201', hidden: false, mode: 'fixed' } };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '✓' : '✗', m); };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript(d => { window.__SEED = d; }, { me: 'S1', names: { S1: 'SlowLeaf' }, docs });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.includes('/js/vein-firebase.js')) return r.fulfill({ contentType: 'text/javascript', body: FAKE }); if (u.startsWith('http://localhost:8767')) return r.continue(); return r.abort(); });
  let p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); let dlgs = []; p.on('dialog', d => { dlgs.push(d.message()); d.accept(); });
  const shot = n => p.screenshot({ path: path.join(OUT, n + '.png') }); const W = ms => p.waitForTimeout(ms);
  await p.goto('http://localhost:8767/#admin/plants/M1'); await W(3500); const openEd=async code=>{ await p.evaluate(c=>{ const card=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='管理').find(b=>{ let e=b; for(let i=0;i<8&&e;i++){ e=e.parentElement; if(e&&/AN-SWL/.test(e.innerText)) return e.innerText.includes(c); } return false; }); card&&card.click(); },code); await W(1500); }; await openEd('00297'); console.log('HASH',await p.evaluate(()=>location.hash));
  const tag = await p.$('button.tag:has-text("不在商店展示")'); ok(!!tag, '隱藏的植株頂部有「🙈 不在商店展示 ›」可點'); await shot('sw0_head');
  await tag.click(); await W(600);
  ok(await p.evaluate(() => document.querySelector('.pe-tabs [aria-selected=true]')?.dataset.k === 'set'), '點標籤 → 直接跳到「隱私與刪除」分頁');
  ok(await p.evaluate(() => { const x = document.querySelector('.shw-p'); return x && !x.classList.contains('on') && /不在商店展示/.test(x.innerText) && /正在競標/.test(x.innerText); }), '開關區塊顯示「不在商店展示」＋競標中警告');
  await shot('sw1_off');
  await p.click('.shw-p .sw'); await W(800);
  ok(await p.evaluate(() => __fdb.get('shops/S1/plants/M1').hidden === false), '打開 → 資料庫 hidden=false');
  ok(await p.evaluate(() => document.querySelector('.shw-p')?.classList.contains('on') && /在商店展示中/.test(document.querySelector('.shw-p').innerText)), '畫面變成螢光「在商店展示中」');
  ok(await p.evaluate(() => document.querySelector('.pe-tabs [aria-selected=true]')?.dataset.k === 'set'), '切換後還停在同一個分頁');
  await p.evaluate(() => document.querySelectorAll('.gt-ov').forEach(x => x.remove())); await shot('sw2_on'); ok(await p.evaluate(() => { const d = document.querySelector('#chDock'); return !d || getComputedStyle(d).display === 'none'; }), '開關區塊所在分頁手機版不顯示聊天浮鈕（不會擋住開關）');
  dlgs = []; await p.evaluate(() => document.querySelectorAll('.gt-ov').forEach(x => x.remove())); await p.click('.shw-p .sw'); await W(800);
  ok(dlgs.some(m => /正在競標/.test(m)), '競標中要隱藏 → 先跳確認'); ok(await p.evaluate(() => __fdb.get('shops/S1/plants/M1').hidden === true), '確認後 hidden=true（可以自由切回來）');
  await p.close(); p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => { dlgs.push(d.message()); d.accept(); }); await p.goto('http://localhost:8767/#admin/plants'); await W(3500); await p.evaluate(() => document.querySelectorAll('.gt-ov').forEach(x => x.remove())); await openEd('00201'); await p.evaluate(() => { const b = document.querySelector('.pe-tabs [data-k=set]'); b && b.click(); }); await W(500); console.log('HASH2', await p.evaluate(() => location.hash)); await p.evaluate(() => { const b = document.querySelector('.pe-tabs [data-k=set]'); b && b.click(); }); await W(500);
  dlgs = []; await p.evaluate(() => document.querySelectorAll('.gt-ov').forEach(x => x.remove())); await p.click('.shw-p .sw'); await W(800);
  ok(!dlgs.length && await p.evaluate(() => __fdb.get('shops/S1/plants/M2').hidden === true), '一般植株隱藏不跳確認，直接寫入');
  const erg = await p.evaluate(() => { const r = document.querySelector('.shw-p .sw').getBoundingClientRect(); return { h: r.height, hs: document.documentElement.scrollWidth > innerWidth + 1 }; });
  ok(erg.h >= 24 && !erg.hs, '開關大小 OK、沒有橫向捲動 ' + JSON.stringify(erg)); await shot('sw3_m2');
  ok(!errs.length, '沒有 JS 錯誤 ' + errs.join(' | '));
  console.log('PASS', pass, 'FAIL', fail); await b.close(); process.exit(fail ? 1 : 0);
})();
