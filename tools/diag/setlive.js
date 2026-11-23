// 改拍賣會欄位。IMG_PATHS='<id>|<json>'，只允許 title／sub／htmlFile（tpl/ 底下的卡片外觀檔）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const [id, js] = (process.env.IMG_PATHS || '').split('|'); 
(async () => { const p = JSON.parse(js || '{}'), up = {}; ['title', 'sub'].forEach(k => { if (typeof p[k] === 'string') up[k] = p[k]; }); if (/^[\w-]+\.html$/.test(p.htmlFile || '')) up.html = require('fs').readFileSync(__dirname + '/tpl/' + p.htmlFile, 'utf8');
  if (!id || !Object.keys(up).length) { console.log('ABORT'); return; } up.updatedAt = Date.now(); await db.doc('lives/' + id).update(up); const d = (await db.doc('lives/' + id).get()).data(); console.log('UPDATED', d.title, '/', d.sub, 'html', (d.html || '').length); })()
  .catch(e => console.log('ERR', e.message)).finally(() => { process.exitCode = 0; });
