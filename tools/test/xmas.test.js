// 聖誕交換禮物：限時頁按鈕、登錄、審核、配對後寄出、收件翻牌、教學、轉發（本機 Playwright + fakefb）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const OUT = process.env.OUT || path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const FAKE = fs.readFileSync(path.join(__dirname, 'fakefb.js'), 'utf8'); const now = Date.now(), iso = t => new Date(t).toISOString();
const CFG = { on: true, phase: 'reg', title: '聖誕交換禮物', min: 500, regEnd: now + 26 * 864e5, matchAt: now + 26 * 864e5 + 60e3, shipBy: now + 29 * 864e5, nOk: 12,
  feat: { by: 'SlowLeaf', name: 'Muchlis 側芽', val: 17000, img: 'm/xmas/muchlis.jpg', note: '配對完全隨機，說不定就是你收到！' } };
const base = { 'shops/S1': { name: 'SlowLeaf', owner: 'S1' }, 'site/sellers': { approved: { S1: { at: 1 } } }, 'site/verified': { uids: { S1: true } },
  'shops/U2/plants/P1': { code: 'AN-ABC-00001', species: 'Anthurium warocqueanum', kind: 'seedling', status: 'available', price: 2800, createdAt: iso(now - 1e7), photoCount: 0 },
  'shops/U2/plants/P2': { code: 'AN-ABC-00002', species: 'Anthurium crystallinum', kind: 'seedling', status: 'available', price: 300, createdAt: iso(now - 1e7), photoCount: 0 },
  'shops/U2': { name: '王小明溫室', owner: 'U2' } };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '✓' : '✗', m); };
async function page(b, me, docs, admin) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(d => { window.__SEED = d; window.__gt=[]; new MutationObserver(()=>document.querySelectorAll('.gt-ov').forEach(x=>{ window.__gt.push(x.innerText.slice(0,80)); x.remove(); })).observe(document,{childList:true,subtree:true}); }, { me, admin, names: { S1: 'SlowLeaf', U2: '王小明', U3: '林小姐' }, docs });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.includes('/js/vein-firebase.js')) return r.fulfill({ contentType: 'text/javascript', body: FAKE }); if (u.startsWith('http://localhost:8767')) return r.continue(); if (u.includes('qrcode')) return r.continue(); return r.abort(); });
  const p = await ctx.newPage(); p.errs = []; p.on('pageerror', e => p.errs.push(e.message)); p.on('dialog', d => d.accept());
  p.W = ms => p.waitForTimeout(ms); p.shot = n => p.screenshot({ path: path.join(OUT, n + '.png') }); p.clean = () => p.evaluate(() => document.querySelectorAll('.gt-ov').forEach(x => x.remove()));
  return p; }
(async () => {
  const b = await chromium.launch();
  // 1) 報名流程
  let p = await page(b, 'U2', { ...base, 'xg/main': CFG });
  await p.goto('http://localhost:8767/#/raffle'); await p.W(3500); await p.clean();
  const tiles = await p.evaluate(() => [...document.querySelectorAll('#playTabs .ptb')].map(b => b.className + '|' + b.innerText.replace(/\n/g, ' ')));
  ok(/ptb-xmas/.test(tiles[0] || ''), '限時頁玩法按鈕：交換禮物排第一 ' + (tiles[0] || ''));
  ok(await p.evaluate(() => document.querySelector('#playTabs .ptb-xmas')?.getAttribute('aria-pressed') === 'true'), '預設打開交換禮物');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.ptb-xmas'), '::before').animationName.includes('xmRing')), '按鈕有旋轉光環特效');
  ok(await p.evaluate(() => !!document.querySelector('.xm-hero') && /Muchlis 側芽/.test(document.querySelector('.xm-feat')?.innerText || '') && /17,000/.test(document.querySelector('.xm-feat').innerText)), '活動頁：主視覺＋SlowLeaf 精選禮物 NT$17,000');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '沒有橫向捲動');
  await p.shot('xm1_home'); await p.evaluate(() => scrollTo(0, 600)); await p.W(300); await p.shot('xm1_home2');
  // 教學
  await p.click('.xm-hb .h'); await p.W(700); ok(await p.evaluate(() => document.querySelectorAll('.xm-ts').length === 5 && document.querySelector('.xm-ts.on h3').innerText === '登錄一株植物'), '教學：5 步，從第 1 步開始');
  await p.shot('xm2_tut1'); await p.click('.xm-nav .btn.lime'); await p.W(600); await p.click('.xm-nav .btn.lime'); await p.W(800);
  ok(await p.evaluate(() => /神秘配對/.test(document.querySelector('.xm-ts.on h3').innerText)), '教學：下一步切到第 3 步'); await p.shot('xm2_tut3');
  await p.click('.xm-tut-x'); await p.W(400); ok(await p.evaluate(() => !document.querySelector('.xm-tut')), '教學可關閉');
  // 轉發
  await p.click('.xm-hb .s'); await p.W(2500); ok(await p.evaluate(() => /#\/xmas/.test(document.querySelector('.sh-txt')?.value || '') && !!document.querySelector('.sh-prev img')), '轉發：有活動圖＋文字含活動連結'); await p.shot('xm3_share');
  await p.evaluate(() => { const d = document.querySelector('dialog[open]'); d && d.close(); }); await p.W(300);
  // 登錄
  await p.evaluate(() => document.querySelector('.xm-go')?.scrollIntoView({ block: 'center' })); await p.W(300); await p.click('.xm-go'); await p.W(800);
  const cards = await p.evaluate(() => document.querySelectorAll('.xm-pc').length); ok(cards === 2, '登錄：列出我的 VEIN 植物（' + cards + '）');
  await p.click('.xm-pc'); await p.W(300);
  ok(await p.evaluate(() => { const f = [...document.querySelectorAll('.xm-f input')]; return f[0].value.length > 3 && f[1].value === '2800'; }), '選植物 → 自動帶入名稱與價值');
  await p.evaluate(() => { const v = [...document.querySelectorAll('.xm-f .two input')][0]; v.value = '300'; v.dispatchEvent(new Event('input')); });
  await p.evaluate(() => { const i = [...document.querySelectorAll('.xm-f input')]; const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input')); }; const ship = document.querySelectorAll('.xm-f .xm-f input'); set(ship[0], '王小明'); set(ship[1], '0912345678'); set(ship[2], '7-11 鑫忠孝門市 / 123456'); });
  await p.click('.xm-ag input'); await p.click('.xm-f > .btn.pri'); await p.W(500);
  ok(await p.evaluate(() => [...document.querySelectorAll('dialog[open] p.hint')].some(x => x.innerText === '價值至少 NT$500') && !__fdb.get('xgE/U2')), '價值低於 500 → 擋下並提示');
  await p.evaluate(() => { const v = [...document.querySelectorAll('.xm-f .two input')][0]; v.value = '2800'; }); await p.shot('xm4_reg');
  await p.click('.xm-f > .btn.pri'); await p.W(1500);
  const e = await p.evaluate(() => __fdb.get('xgE/U2')); ok(e && e.status === 'pending' && e.val === 2800 && e.src === 'vein' && e.pid === 'P1' && e.ship.k === 'store' && e.ship.place.includes('123456'), '送出 → 寫入登錄（審核中、價值、收件資料）');
  ok(await p.evaluate(() => /登錄成功/.test(document.querySelector('.xm-rv')?.innerText || '')), '送出後跳出登錄成功動畫'); await p.shot('xm5_done');
  await p.click('.xm-rv .xm-go'); await p.W(800);
  ok(await p.evaluate(() => /等管理員確認/.test(document.querySelector('.xm')?.innerText || '')), '狀態：等管理員確認'); await p.evaluate(() => document.querySelector('.xm-tl')?.scrollIntoView({ block: 'center' })); await p.W(300); await p.shot('xm6_status');
  console.log('GATES', JSON.stringify(await p.evaluate(()=>window.__gt))); ok(!p.errs.length, '報名流程沒有 JS 錯誤 ' + p.errs.join('|')); await p.context().close();
  // 2) 管理員審核
  p = await page(b, 'S1', { ...base, 'xg/main': CFG, 'xgE/U2': { uid: 'U2', src: 'manual', name: 'Red Queen F2', img: 'm/xmas/muchlis.jpg', val: 2800, status: 'pending', at: now, ship: { name: '王小明', phone: '0912', k: 'store', place: '7-11' } } }, true);
  await p.goto('http://localhost:8767/#admin/xmas'); await p.W(3500); await p.clean();
  ok(await p.evaluate(() => /Red Queen F2/.test(document.body.innerText) && /待確認 1/.test(document.body.innerText)), '後台：看到待確認的登錄'); await p.shot('xm7_admin');
  await p.evaluate(() => [...document.querySelectorAll('button')].find(x => x.innerText.includes('✓ 通過')).click()); await p.W(800);
  ok(await p.evaluate(() => __fdb.get('xgE/U2').status === 'ok'), '後台：按通過 → status=ok'); ok(!p.errs.length, '後台沒有 JS 錯誤 ' + p.errs.join('|')); await p.context().close();
  // 3) 配對後：寄出、收件翻牌
  p = await page(b, 'U2', { ...base, 'xg/main': { ...CFG, phase: 'matched' }, 'xgE/U2': { uid: 'U2', src: 'vein', name: 'Red Queen F2', img: 'm/xmas/muchlis.jpg', val: 2800, status: 'ok', at: now, ship: { name: '王小明', phone: '0912', k: 'store', place: '7-11' } },
    'xgOut/U2': { ship: { name: '林小姐', phone: '0912-345-678', k: 'store', place: '台中文心門市（153242）' }, gift: 'Red Queen F2', shipBy: now + 3 * 864e5, trk: '' }, 'xgIn/U2': { at: now } });
  await p.goto('http://localhost:8767/#/xmas'); await p.W(3500); await p.clean();
  console.log('DBG', await p.evaluate(() => location.hash + ' | ' + (document.querySelector('#playTabs')?.innerText||'').replace(/\n/g,' ') + ' | ' + (document.querySelector('#playBody')?.innerText||'').slice(0,200).replace(/\n/g,' ')));
  ok(await p.evaluate(() => location.hash === '#/raffle' && /林小姐/.test(document.querySelector('.xm-ship')?.innerText || '') && !/U3/.test(document.querySelector('.xm')?.innerText)), '#/xmas 連結 → 配對結果只顯示收件資料');
  await p.evaluate(() => document.querySelector('.xm-ship')?.scrollIntoView({ block: 'start' })); await p.W(300); await p.shot('xm8_ship');
  await p.fill('.xm-card .xm-f input', 'F12 3456 7890'); await p.click('.xm-card .xm-f .xm-go'); await p.W(800);
  const o = await p.evaluate(() => __fdb.get('xgOut/U2')); ok(o.trk === 'F12 3456 7890' && o.shipAt > 0, '我已寄出 → 寫入單號與寄出時間');
  await p.evaluate(() => __fdb.update('xgIn/U2', { shipAt: Date.now(), trk: 'X99' })); await p.W(600);
  ok(await p.evaluate(() => /有人寄了禮物給你/.test(document.querySelector('.xm-in')?.innerText || '')), '對方寄出 → 顯示包裹在路上'); await p.evaluate(() => document.querySelector('.xm-in')?.scrollIntoView({ block: 'center' })); await p.W(300); await p.shot('xm9_in');
  await p.click('.xm-in .xm-go'); await p.W(600);
  ok(await p.evaluate(() => __fdb.get('xgIn/U2').rcvAt > 0 && !!document.querySelector('.xm-rv .xm-big')), '收件完成 → 寫入 rcvAt、開始翻牌');
  await p.evaluate(() => __fdb.update('xgIn/U2', { from: { uid: 'U3', name: '林小姐', av: '' }, gift: { name: 'SKG Silver × Pink Lemonade', img: 'm/xmas/muchlis.jpg', val: 650 } })); await p.W(2600);
  ok(await p.evaluate(() => document.querySelector('.xm-big')?.classList.contains('flip') && /林小姐/.test(document.querySelector('.xm-big .bb').innerText)), '伺服器填入 → 翻牌揭曉神秘對象與禮物'); await p.shot('xm10_reveal');
  await p.click('.xm-rvb .btn'); await p.W(600); ok(await p.evaluate(() => /你收到的禮物/.test(document.querySelector('.xm')?.innerText || '')), '翻牌後頁面顯示收到的禮物');
  ok(!p.errs.length, '配對後流程沒有 JS 錯誤 ' + p.errs.join('|')); await p.context().close();
  // 4) 未登入
  p = await page(b, null, { ...base, 'xg/main': CFG }); await p.goto('http://localhost:8767/#/raffle'); await p.W(3500); await p.clean();
  ok(await p.evaluate(() => /登入參加/.test(document.querySelector('.xm')?.innerText || '')), '未登入：顯示登入參加'); ok(!p.errs.length, '未登入沒有 JS 錯誤 ' + p.errs.join('|')); await p.context().close();
  // 5) 活動沒開：不顯示按鈕
  p = await page(b, 'U2', { ...base }); await p.goto('http://localhost:8767/#/raffle'); await p.W(3000);
  ok(await p.evaluate(() => !document.querySelector('#playTabs .ptb-xmas')), '沒有活動設定時不顯示交換禮物按鈕'); await p.context().close();
  console.log('PASS', pass, 'FAIL', fail); await b.close(); process.exit(fail ? 1 : 0);
})();
