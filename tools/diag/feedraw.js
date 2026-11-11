// 給 AI 小編用：印出公開的轉發資料（feed.json，全部都是網站上公開的內容）
// 用法：diag.yml script=feedraw.js；輸出夾在 ===FEED=== 與 ===END=== 之間
(async()=>{ const q=process.env.FEED_Q||'days=14&limit=60';
  const r=await fetch('https://vein-48ec8.web.app/feed.json?'+q); const F=await r.json();
  console.log('===FEED==='); console.log(JSON.stringify(F)); console.log('===END===');
})().catch(e=>console.log('ERR',e.message));
