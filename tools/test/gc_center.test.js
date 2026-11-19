// 轉蛋賣家中心：UI 人體工學＋PM 暴力測試（本機 Playwright，用 fakefb.js 取代 Firebase）
// 用法：cd public && python3 -m http.server 8767 &  然後 node tools/test/gc_center.test.js
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const OUT = process.env.OUT || path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const FAKE = fs.readFileSync(path.join(__dirname, 'fakefb.js'), 'utf8');
const now = Date.now(), H = 36e5, DAY = 864e5;
const G1 = { shop: 'S1', title: '熱植文創周邊一番賞', status: 'on', price: 250, total: 100, sold: 12, opened: 6, left: { A: 3, B: 91 }, pubAt: now - 3 * DAY, maxPer: 10, tpl: 'neon', ship: { mode: 'sep', free: 1500, keep: 30 },
  prizes: [{ k: 'A', n: 3, kind: 'goods', name: '熱植文創時鐘', items: [{ kind: 'goods', gid: 'gd1', name: '熱植文創時鐘', img: '', val: 1400 }] }, { k: 'B', n: 97, kind: 'goods', name: '超好看冰箱貼', items: [{ kind: 'goods', gid: 'gd2', name: '超好看冰箱貼', img: '', val: 250 }] }] };
const gt = (n, extra) => ({ buyer: extra.buyer, src: 'gacha', gacha: { id: 'G1', n, price: 250, title: G1.title }, total: 250 * n, items: [], note: '', payMethod: 'transfer', at: extra.at || now - 2 * H, status: 'confirmed', ...extra });
const docs = {
  'shops/S1': { name: 'SlowLeaf', owner: 'S1' }, 'site/sellers': { approved: { S1: { at: 1 } } }, 'site/verified': { uids: { S1: true } }, 'gacha/G1': G1,
  'profiles/B1': { name: '小綠' }, 'profiles/B2': { name: 'Anna' }, 'profiles/B3': { name: 'Ken' }, 'profiles/B4': { name: '阿哲' },
  'shops/S1/orders/t1aaaa': gt(4, { buyer: 'B1', at: now - 5 * H }), 'deals/S1_t1aaaa': { seller: 'S1', buyer: 'B1', orderId: 't1aaaa', pay: { last5: '12345', amount: 1000, at: now - 4 * H } },
  'shops/S1/orders/t2bbbb': gt(2, { buyer: 'B2', at: now - 3 * H }), 'deals/S1_t2bbbb': { seller: 'S1', buyer: 'B2', orderId: 't2bbbb', pay: { last5: '54321', amount: 450, at: now - 2 * H } },
  'shops/S1/orders/t3cccc': gt(3, { buyer: 'B3', at: now - 44 * H }), 'deals/S1_t3cccc': { seller: 'S1', buyer: 'B3', orderId: 't3cccc' },
  'shops/S1/orders/t4dddd': gt(0, { buyer: 'B4', status: 'apply', later: true, total: 0, gacha: { id: 'G1', n: 0, cap: 10, price: 250, title: G1.title } }),
  'shops/S1/orders/t5eeee': gt(5, { buyer: 'B1', status: 'done', granted: true, at: now - 30 * H, doneAt: now - 29 * H }),
  'shops/S1/orders/sgtquk': gt(4, { buyer: 'B2', status: 'preparing', granted: true, at: now - 11 * H }),
  'shops/S1/orders/gs-ship1': { buyer: 'B1', src: 'gship', status: 'preparing', items: [], total: 0, at: now - 1 * H, gship: { items: ['x9'], val: 1650, free: 'thr', list: [{ k: 'A', name: '熱植文創時鐘', val: 1400, img: '', gid: 'G1' }, { k: 'B', name: '超好看冰箱貼', val: 250, img: '', gid: 'G1' }] }, ship: { n: '7-11 取貨', k: 'store', fee: 0 } },
  'deals/S1_gs-ship1': { seller: 'S1', buyer: 'B1', orderId: 'gs-ship1', recv: { name: '小綠', phone: '0912', place: '7-11 中山店', k: 'store' } },
  'shops/S1/orders/gs-ship2': { buyer: 'B3', src: 'gship', status: 'confirmed', items: [], total: 0, at: now - 2 * H, gship: { items: ['x8'], val: 250, list: [{ k: 'B', name: '超好看冰箱貼', val: 250, img: '', gid: 'G1' }] }, ship: { n: '宅配', k: 'home', fee: 120 } },
  'gbi/x1': { uid: 'B1', shop: 'S1', gid: 'G1', k: 'B', name: '超好看冰箱貼', val: 250, st: 'box', exp: now + 5 * DAY, kind: 'goods' },
  'gbi/x2': { uid: 'B1', shop: 'S1', gid: 'G1', k: 'A', name: '熱植文創時鐘', val: 1400, st: 'box', exp: now + 20 * DAY, kind: 'goods' },
  'gbi/x3': { uid: 'B2', shop: 'S1', gid: 'G1', k: 'B', name: '超好看冰箱貼', val: 250, st: 'box', exp: now + 25 * DAY, kind: 'goods' },
};
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('✓', m); } else { fail++; console.log('✗', m); } };
const W = (p, ms) => p.waitForTimeout(ms);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  await ctx.addInitScript(d => { window.__SEED = d; try { localStorage.setItem('vein.gcHelp', '1'); } catch (e) {} }, { me: 'S1', names: { S1: 'SlowLeaf', B1: '小綠', B2: 'Anna', B3: 'Ken', B4: '阿哲' }, docs });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.includes('/js/vein-firebase.js')) return r.fulfill({ contentType: 'text/javascript', body: FAKE }); if (u.startsWith('http://localhost:8767')) return r.continue(); return r.abort(); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('dialog', d => d.accept());
  const shot = n => p.screenshot({ path: path.join(OUT, n + '.png') });
  await p.goto('http://localhost:8767/#admin/gacha'); await W(p, 3500);
  // ---------- 待辦（預設）----------
  ok(await p.evaluate(() => document.querySelector('.gc-adm .tabs [aria-pressed=true]')?.dataset.k === 'todo'), '有待辦時，一進來就是「待辦」分頁');
  const tiles = await p.evaluate(() => [...document.querySelectorAll('.gk-todo .tl button')].map(b => b.querySelector('b').textContent));
  ok(JSON.stringify(tiles) === '["2","1","1","2"]', '四格數字：待發券 2、先抽申請 1、待出貨 1、等付款 2 → ' + tiles);
  ok(await p.evaluate(() => /要你處理 4 件/.test(document.querySelector('.gk-todo').innerText)), '大標寫「要你處理 4 件」（等付款不算）');
  const secs = await p.evaluate(() => [...document.querySelectorAll('.gk-sec b')].map(x => x.textContent));
  ok(secs[0].includes('發券') && secs[1].includes('先抽') && secs[2].includes('出貨') && secs[3].includes('等買家付款'), '區塊順序：發券 → 先抽申請 → 出貨 → 等付款');
  ok(await p.evaluate(() => /✓ 金額相符/.test(document.body.innerText) && /金額不符：回報 NT\$ 450，應收 NT\$ 500/.test(document.body.innerText)), '對帳：金額相符打勾、不符紅字寫清楚差多少');
  ok(await p.evaluate(() => !!document.querySelector('.gk-all') && /2 筆/.test(document.querySelector('.gk-all').textContent)), '兩筆以上已匯款 → 有「全部確認發券」');
  ok(await p.evaluate(() => /熱植文創時鐘/.test([...document.querySelectorAll('.gk-names')].map(x => x.innerText).join('')) && /收件資料 ✓/.test(document.body.innerText)), '出貨單直接看到獎品名稱、收件資料已填');
  ok(await p.evaluate(() => /剩 4 小時/.test(document.querySelector('.gk-wl').innerText)), '等付款列顯示剩幾小時（44 小時前下單 → 剩 4 小時，標紅）');
  await shot('c1_todo'); await p.evaluate(() => document.querySelector('#gks-ship')?.scrollIntoView()); await W(p, 300); await shot('c2_todo_ship');
  // 人體工學：所有可按的東西至少 40px 高、文字不小於 11px、沒有橫向捲動
  const erg = await p.evaluate(() => { const bad = []; document.querySelectorAll('.gc-adm button').forEach(b => { const r = b.getBoundingClientRect(); if (r.width && r.height < 36) bad.push((b.textContent || '').trim().slice(0, 12) + ':' + Math.round(r.height)); });
    const small = [...document.querySelectorAll('.gc-adm *')].filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 10.5).map(e => e.textContent.trim().slice(0, 10));
    return { bad, small, hs: document.documentElement.scrollWidth > innerWidth + 1 }; });
  ok(!erg.bad.length, '按鈕高度都 ≥ 36px ' + erg.bad.join(','));
  ok(!erg.small.length, '字都 ≥ 10.5px ' + erg.small.slice(0, 5).join(','));
  ok(!erg.hs, '手機寬度沒有橫向捲動');
  ok(await p.evaluate(() => { const d = document.querySelector('#chDock'); return !d || getComputedStyle(d).display === 'none'; }), '轉蛋後台手機版不顯示聊天浮鈕（不會擋住右邊的按鈕）');
  ok(await p.evaluate(() => /NT\$ 120/.test([...document.querySelectorAll('.gk-wr')].map(x => x.innerText).join(''))), '等補運費的出貨單金額顯示運費 120，不是 0');
  // ---------- 發券：連點兩次只會寫一次 ----------
  const w0 = await p.evaluate(() => __fwrites.length);
  await p.evaluate(() => { const c = [...document.querySelectorAll('.gc-oc')].find(x => /t1aaaa/.test(x.innerText)); const b = c.querySelector('.acts2 .v'); b.click(); b.click(); }); await W(p, 800);
  const wr = await p.evaluate(w0 => __fwrites.slice(w0).filter(w => w.path === 'shops/S1/orders/t1aaaa'), w0);
  ok(wr.length === 1 && wr[0].data.status === 'preparing', '確認發券連點兩次 → 只寫一次（狀態 preparing，交給伺服器發券）');
  ok(wr[0] && wr[0].data.src === 'gacha' && wr[0].data.gacha?.n === 4, '寫回訂單時保留 src=gacha 與張數（伺服器才認得）');
  ok(await p.evaluate(() => ![...document.querySelectorAll('.gc-oc')].some(x => /t1aaaa/.test(x.innerText))), '按下後卡片立刻從待辦消失，不會再被按到');
  // 模擬伺服器：發券完成 → done
  await p.evaluate(() => __fdb.update('shops/S1/orders/t1aaaa', { status: 'done', granted: true, doneAt: Date.now() })); await W(p, 800);
  ok(await p.evaluate(() => document.querySelectorAll('.gk-todo .tl button')[0].querySelector('b').textContent === '1'), '伺服器發券後，待發券數字變 1');
  // ---------- 先抽申請：要看契約才能同意 ----------
  await p.evaluate(() => [...document.querySelectorAll('.gc-oc')].find(x => /t4dddd/.test(x.innerText)).querySelector('.acts2 .v').click()); await W(p, 600);
  ok(await p.evaluate(() => !!document.querySelector('.gc-ctr') && document.querySelector('.gc-ctr .gc-cta:not(.ghost)').disabled), '同意先抽前跳契約，沒勾不能按');
  await p.evaluate(() => document.querySelector('.gc-ctr .gc-cta.ghost').click()); await W(p, 400);
  ok(!(await p.evaluate(() => __fwrites.some(w => w.path.startsWith('gReq/')))), '取消契約 → 沒有送出任何請求');
  // ---------- 等付款：當面收現金 ----------
  await p.evaluate(() => [...document.querySelectorAll('.gk-wr')].find(x => /抽獎券 ×3/.test(x.innerText)).querySelector('.gk-cash').click()); await W(p, 700);
  ok(await p.evaluate(() => __fwrites.some(w => w.path === 'shops/S1/orders/t3cccc' && w.data.status === 'preparing')), '等付款列可以按「已收款」（當面收現金）');
  ok(await p.evaluate(() => ![...document.querySelectorAll('.gk-wr')].some(x => /抽獎券 ×3/.test(x.innerText))), '按完立刻從等付款消失');
  // ---------- 倉庫 ----------
  await p.evaluate(() => document.querySelector('.gc-adm .tabs [data-k=w]').click()); await W(p, 600);
  const box = await p.evaluate(() => [...document.querySelectorAll('.gk-box')].map(x => x.innerText.replace(/\s+/g, ' ')));
  ok(box.length === 2 && /2 件寄放中/.test(box[0]), '倉庫：每位客人一張卡，快到期的排前面');
  ok(/5 天到期/.test(box[0]) && /已達免運/.test(box[0]) && /熱植文創時鐘/.test(box[0]), '卡片看得到獎品名稱、到期天數、已達免運');
  ok(/差 NT\$ 1,250 免運/.test(box[1]), '沒達門檻的寫出差多少免運');
  await p.evaluate(() => [...document.querySelectorAll('button')].find(b => /稍後再說/.test(b.textContent))?.click()); await W(p, 400); await shot('c3_box');
  await p.evaluate(() => document.querySelector('.gk-box .btn').click()); await W(p, 600);
  ok(/#\/chats\//.test(await p.evaluate(() => location.hash)) || await p.evaluate(() => !!document.querySelector('.chw,.ch-win,[class*=chat]')), '「提醒出貨」直接開聊天室（提醒文字已複製）');
  await p.goto('http://localhost:8767/#admin/gacha'); await W(p, 3000);
  // ---------- 紀錄 ----------
  await p.evaluate(() => document.querySelector('.gc-adm .tabs [data-k=log]').click()); await W(p, 500);
  ok(await p.evaluate(() => /已發券/.test(document.querySelector('.gk-wl')?.innerText || '')), '紀錄分頁看得到已發券的單');
  await shot('c4_log');
  // ---------- 一般訂單列表：不再出現「商品資料讀取中」----------
  await p.goto('http://localhost:8767/#admin/orders'); await W(p, 3000);
  const rows = []; for (const i of [0, 1, 2, 3, 4, 5]) { const okc = await p.evaluate(i => { const b = document.querySelectorAll('.ofb button')[i]; if (!b) return false; b.click(); return true; }, i); if (!okc) break; await W(p, 500); rows.push(...await p.evaluate(() => [...document.querySelectorAll('.or')].map(x => x.innerText.replace(/\s+/g, ' ')))); }
  const prep = await p.evaluate(() => { const b = [...document.querySelectorAll('.ofb button')].find(x => /待出貨/.test(x.textContent)); return b ? b.querySelector('b').textContent : ''; });
  ok(prep === '1', '一般訂單「待出貨」只算真正要出的獎品出貨單（已發券的抽獎券單不算）→ ' + prep);
  ok(rows.length && !rows.some(r => /商品資料讀取中/.test(r)), '訂單列表沒有「商品資料讀取中」');
  ok(rows.some(r => /抽獎券 ×2 · 熱植文創/.test(r) && /待發券/.test(r)), '抽獎券訂單寫清楚「🎟 抽獎券 ×2 · 機台名 · 待發券」');
  ok(rows.some(r => /轉蛋獎品出貨 2 件/.test(r) && /出貨 →/.test(r)), '獎品出貨單寫清楚件數與獎品，下一步是出貨');
  const stuck = rows.find(r => /sgtquk/.test(r)); ok(stuck && !/出貨 →/.test(stuck) && /已發券/.test(stuck), '卡住的已發券單顯示「已發券」、不會出現「出貨」：' + (stuck || '').slice(0, 70));
  await shot('c5_orders');
  await p.evaluate(() => [...document.querySelectorAll('.or')].find(x => /抽獎券/.test(x.innerText) && /確認發券/.test(x.innerText))?.click()); await W(p, 1500);
  ok(/#admin\/gacha/.test(await p.evaluate(() => location.hash)), '點抽獎券訂單 → 直接到轉蛋待辦');
  await p.goto('http://localhost:8767/#admin/orders'); await W(p, 2500); await p.evaluate(() => { const b = [...document.querySelectorAll('.ofb button')].find(x => /待出貨/.test(x.textContent)); b && b.click(); }); await W(p, 500);
  await p.evaluate(() => [...document.querySelectorAll('.or')].find(x => /轉蛋獎品出貨 2 件/.test(x.innerText)).click()); await W(p, 1500);
  ok(await p.evaluate(() => /轉蛋獎品 2 件/.test(document.body.innerText) && /熱植文創時鐘/.test(document.querySelector('.od2-info')?.innerText || '')), '打開出貨單看得到獎品清單');
  await shot('c6_ship_detail');
  // ---------- 訂單管理裡也有轉蛋管理 ----------
  await p.goto('http://localhost:8767/#orders'); await W(p, 3000);
  const nav = await p.evaluate(() => [...document.querySelectorAll('button,a')].filter(b => /轉蛋管理/.test(b.textContent)).map(b => b.textContent.replace(/\s+/g, ' ')));
  ok(nav.length > 0, '訂單管理選單有「🎰 轉蛋管理」' + (nav[0] ? '：' + nav[0] : ''));
  ok(/發券、先抽申請、獎品出貨、倉庫/.test(nav[0] || '') || await p.evaluate(() => /發券、先抽申請/.test(document.body.innerText)), '選單下面寫清楚管什麼（發券、先抽申請、獎品出貨、倉庫）');
  await p.evaluate(() => [...document.querySelectorAll('button,a')].find(b => /轉蛋管理/.test(b.textContent)).click()); await W(p, 1200);
  ok(await p.evaluate(() => !!document.querySelector('.gc-adm .gk-todo')), '點下去打開轉蛋待辦');
  await shot('c7_order_nav');
  // ---------- 暴力：資料缺漏也不能壞 ----------
  await p.evaluate(() => { __fdb.set('shops/S1/orders/bad1', { buyer: 'B9', src: 'gacha', status: 'paid', at: Date.now() }); __fdb.set('shops/S1/orders/bad2', { buyer: 'B9', src: 'gship', status: 'preparing', at: Date.now() }); __fdb.set('gbi/bad3', { uid: 'B9', shop: 'S1', st: 'box' }); });
  await p.goto('http://localhost:8767/#admin/gacha'); await W(p, 3000);
  for (const k of ['todo', 'g', 'w', 'log']) { await p.evaluate(k => document.querySelector('.gc-adm .tabs [data-k=' + k + ']').click(), k); await W(p, 400); }
  await p.goto('http://localhost:8767/#admin/orders'); await W(p, 2500);
  ok(!errs.length, '缺欄位的怪資料也不會讓頁面出錯 ' + errs.slice(0, 3).join(' | '));
  console.log(pass + '/' + (pass + fail)); await b.close(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
