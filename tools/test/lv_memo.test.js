// 拍賣會：植物有備註要顯示在拍賣中面板、預覽、拍賣順序（本機 Playwright + fakefb）
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const OUT = process.env.OUT || path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const FAKE = fs.readFileSync(path.join(__dirname, 'fakefb.js'), 'utf8'); const now = Date.now(), iso = t => new Date(t).toISOString();
const MEMO = '親本 Dark Phoenix × Ace of Spades，新葉剛轉色，根系很好';
const pl = (code, sp, o = {}) => ({ code, species: sp, kind: 'seedling', status: 'available', price: 1000, createdAt: iso(now - 1e7), photoCount: 1, ...o });
const lot = (pid, code, ord, st) => ({ pid, shop: 'S1', code, name: code, start: 500, ord, status: st, at: now - 1e6 });
const docs = { 'shops/S1': { name: 'SlowLeaf', owner: 'S1' }, 'site/sellers': { approved: { S1: { at: 1 } } }, 'site/verified': { uids: { S1: true } },
  'shops/S1/plants/A1': pl('AN-SWL-00501', 'Anthurium warocqueanum', { cross: MEMO }), 'shops/S1/plants/A2': pl('AN-SWL-00502', 'Anthurium crystallinum'),
  'lives/E1': { title: '測試拍賣會', phase: 'on', dur: 60, startAt: now - 6e4, now, cur: { lid: 'A1', pid: 'A1', shop: 'S1', i: 0, start: 500, top: null, n: 0, startedAt: now - 5e3, previewUntil: now - 1e3, endsAt: now + 6e4, code: 'AN-SWL-00501', name: 'AN-SWL-00501' } },
  'lives/E1/lots/A1': lot('A1', 'AN-SWL-00501', 1, 'live'), 'lives/E1/lots/A2': lot('A2', 'AN-SWL-00502', 2, 'ok'),
  'lives/E2': { title: '集合中拍賣會', phase: 'on', dur: 60, startAt: now - 2000, gatherUntil: now + 3e5 }, 'lives/E2/lots/A1': lot('A1', 'AN-SWL-00501', 1, 'ok'), 'lives/E2/lots/A2': lot('A2', 'AN-SWL-00502', 2, 'ok') };
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log(c ? '✓' : '✗', m); };
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await ctx.addInitScript(d => { window.__SEED = d; }, { me: 'U2', names: { S1: 'SlowLeaf', U2: '王小明' }, docs });
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.includes('/js/vein-firebase.js')) return r.fulfill({ contentType: 'text/javascript', body: FAKE }); if (u.startsWith('http://localhost:8767')) return r.continue(); return r.abort(); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); const W = ms => p.waitForTimeout(ms);
  const clean = () => p.evaluate(() => document.querySelectorAll('.gt-ov,.bl-ov,.coach').forEach(x => x.remove()));
  await p.goto('http://localhost:8767/#/live/E1'); await W(4500); await clean();
  const pan = await p.evaluate(() => { const e = document.querySelector('.lv-pn .memo'); if (!e) return null; const r = e.getBoundingClientRect(); return { t: e.innerText, w: r.width, vw: innerWidth, right: r.right }; });
  ok(pan && pan.t.includes('親本 Dark Phoenix'), '拍賣中面板：顯示備註 ' + JSON.stringify(pan && pan.t));
  ok(pan && pan.right <= pan.vw, '備註沒有超出畫面'); ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '沒有橫向捲動');
  await p.click('.lv-pn .memo'); await W(300); ok(await p.evaluate(() => { const m = document.querySelector('.lv-pn .memo'); return m.classList.contains('open') && m.scrollHeight <= m.clientHeight + 2; }), '點備註 → 展開看完整內容');
  await p.evaluate(() => document.querySelector('.lv-pn .memo')?.scrollIntoView({ block: 'center' })); await W(300); await p.screenshot({ path: path.join(OUT, 'lvm_on.png') });
  const btn = await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /順序|拍品/.test(x.innerText)); if (b) { b.click(); return b.innerText; } return null; }); await W(800);
  const ll = await p.evaluate(() => [...document.querySelectorAll('.lv-lt')].map(x => ({ t: x.innerText, m: !!x.querySelector('.memo') })));
  ok(ll.length === 2 && ll[0].m && ll[0].t.includes('親本') && !ll[1].m, '拍賣順序：有備註的那件顯示、沒備註的不顯示空框 (' + btn + ')');
  await p.screenshot({ path: path.join(OUT, 'lvm_list.png') });
  const nsh = await p.evaluate(() => document.querySelectorAll('.lv-lt .lv-lt-sh2').length); ok(nsh === 2, '拍賣順序：每件都有轉發鈕（' + nsh + '）');
  const shb = await p.evaluate(() => { const r = document.querySelectorAll('.lv-lt .lv-lt-sh2')[1].getBoundingClientRect(); return { w: r.width, h: r.height }; }); ok(shb.h >= 34 && shb.w >= 40, '轉發鈕好按 ' + JSON.stringify(shb));
  await p.evaluate(() => document.querySelectorAll('.lv-lt .lv-lt-sh2')[1].click()); await W(1500);
  const sh = await p.evaluate(() => ({ txt: document.querySelector('.sh-txt')?.value || '', tab: [...document.querySelectorAll('button,[role=tab]')].some(b => /拍賣會拍品/.test(b.innerText)), cv: !!document.querySelector('.sd-cv') }));
  ok(sh.cv && sh.tab, '點轉發 → 打開分享編輯器，預設「拍賣會拍品」模板');
  ok(/第 2 件/.test(sh.txt) && /起拍 NT\$ 500/.test(sh.txt) && /#\/live\/E1/.test(sh.txt) && /AN-SWL-00502/.test(sh.txt), '文案：第幾件、起拍價、拍賣會連結、編號 ' + JSON.stringify(sh.txt.slice(0, 80)));
  await p.screenshot({ path: path.join(OUT, 'lvm_share.png') });
  await p.keyboard.press('Escape'); await W(400); await p.evaluate(() => { const d = [...document.querySelectorAll('dialog[open]')]; d.forEach(x => x.close && x.close()); });
  await p.evaluate(() => document.querySelectorAll('.lv-lt .lv-lt-sh2')[0].click()); await W(1200);
  ok(await p.evaluate(() => /親本 Dark Phoenix/.test(document.querySelector('.sh-txt')?.value || '')), '有備註的拍品：文案帶備註');
  await p.goto('http://localhost:8767/#/live/E2'); await W(4000); await clean();
  const g = await p.evaluate(() => document.querySelector('.lvg-nm')?.parentElement?.innerText || '');
  ok(/親本 Dark Phoenix/.test(g) || /AN-SWL-00502/.test(g) && !/備註/.test(g), '集合中輪播拍品卡：有備註顯示、沒備註不顯示 ' + g.slice(0, 40).replace(/\n/g, ' '));
  await p.screenshot({ path: path.join(OUT, 'lvm_soon.png') });
  ok(!errs.length, '沒有 JS 錯誤 ' + errs.join('|')); console.log('PASS', pass, 'FAIL', fail); await b.close(); process.exit(fail ? 1 : 0);
})();
