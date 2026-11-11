// 給 AI 小編用：印出公開的轉發資料（feed.json，全部都是網站上公開的內容）
// 用法：diag.yml script=feedraw.js；輸出是 base64（GitHub 會把大括號遮掉），夾在 ===FEED64=== 與 ===END=== 之間
(async()=>{ const q=process.env.FEED_Q||'days=14&limit=60';
  const r=await fetch('https://vein-48ec8.web.app/feed.json?'+q); const t=await r.text();
  console.log('===FEED64==='); const b=Buffer.from(t).toString('base64'); for(let i=0;i<b.length;i+=4000) console.log(b.slice(i,i+4000)); console.log('===END===');
})().catch(e=>console.log('ERR',e.message)).finally(()=>{ process.exitCode=0; });
