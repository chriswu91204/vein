// 印出公開 feed 裡某賣家在進行中活動的拍品（純文字，避免 GitHub 遮罩）
(async()=>{ const r=await fetch('https://vein-48ec8.web.app/feed.json?days=1&limit=60'); const F=await r.json(); const S=process.env.IMG_PATHS||'';
  for(const x of F.items.filter(i=>i.lotList)){ console.log('EV',x.id,x.lots); for(const l of x.lotList) if(!S||l.shopId===S) console.log('LOT',l.pid,'|',l.name,'|',l.price); } })().catch(e=>console.log('ERR',e.message)).finally(()=>{ process.exitCode=0; });
