// 列出 Cloud Functions 名稱、狀態、最後更新時間（不輸出任何設定或密鑰）
const admin = require('firebase-admin');
(async () => { const t = await admin.credential.applicationDefault().getAccessToken();
  const r = await fetch('https://cloudfunctions.googleapis.com/v2/projects/vein-48ec8/locations/asia-east1/functions?pageSize=200', { headers: { Authorization: 'Bearer ' + t.access_token } });
  const j = await r.json(); if (!j.functions) { console.log('status', r.status, (j.error && j.error.status) || ''); return; }
  for (const f of j.functions) { const n = f.name.split('/').pop(); if (/^live|^lv/i.test(n)) console.log(n, f.state, f.updateTime); }
  console.log('total', j.functions.length); })();
