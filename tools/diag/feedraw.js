// 給 AI 小編用：讀公開的轉發資料（feed.json，全是網站上公開的內容）
// 查詢參數：IMG_PATHS 欄位（diag 的第二個輸入）放 FEED_Q，例如 days=90&all=1&events=0&limit=100
// 輸出：tools/diag/out/feed.json（以 artifact「diag-out」上傳，social/getfeed.sh 會下載）；log 只印統計
(async()=>{ const q=process.env.FEED_Q||process.env.IMG_PATHS||'days=14&limit=60';
  const r=await fetch('https://vein-48ec8.web.app/feed.json?'+q); const t=await r.text();
  require('fs').mkdirSync('out',{recursive:true}); require('fs').writeFileSync('out/feed.json',t);
  try{ const F=JSON.parse(t); console.log('FEED OK', r.status, 'q='+q, 'items='+F.items.length); }catch(e){ console.log('FEED BAD', r.status, t.length); }
})().catch(e=>console.log('ERR',e.message)).finally(()=>{ process.exitCode=0; });
