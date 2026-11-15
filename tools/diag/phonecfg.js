// 手機驗證設定檢查：Firebase Auth 的電話登入、授權網域、簡訊地區、reCAPTCHA 防護設定；最近的簡訊次數統計（只輸出數字，不輸出號碼）
const admin = require('firebase-admin'); admin.initializeApp(); const db = admin.firestore();
const P = process.env.GCLOUD_PROJECT || 'vein-48ec8';
(async () => {
  const tok = (await admin.credential.applicationDefault().getAccessToken()).access_token;
  const get = async u => { const r = await fetch(u, { headers: { Authorization: 'Bearer ' + tok, 'x-goog-user-project': P } }); return { st: r.status, j: await r.json().catch(() => ({})) }; };
  const c = await get(`https://identitytoolkit.googleapis.com/admin/v2/projects/${P}/config`);
  const j = c.j || {};
  console.log('CONFIG_STATUS', c.st, c.st !== 200 ? JSON.stringify(j).slice(0, 300) : '');
  console.log('PHONE_ENABLED', JSON.stringify(j.signIn?.phoneNumber || null));
  console.log('AUTH_DOMAINS', JSON.stringify(j.authorizedDomains || []));
  console.log('SMS_REGION', JSON.stringify(j.smsRegionConfig || null));
  console.log('RECAPTCHA', JSON.stringify(j.recaptchaConfig || null));
  console.log('QUOTA', JSON.stringify(j.quota || null));
  console.log('BLOCKING', JSON.stringify(Object.keys(j.blockingFunctions?.triggers || {})));
  console.log('MFA', JSON.stringify(j.mfa?.state || null));
  // 最近 3 天：有手機的會員數（只看數量）、smsq 次數分布
  let withPhone = 0, recentPhone = 0, total = 0, tokn; const since = Date.now() - 3 * 864e5;
  do { const r = await admin.auth().listUsers(1000, tokn); r.users.forEach(u => { total++; if (u.phoneNumber) { withPhone++; if (Date.parse(u.metadata.lastRefreshTime || u.metadata.lastSignInTime || 0) > since) recentPhone++; } }); tokn = r.pageToken; } while (tokn);
  console.log('USERS', JSON.stringify({ total, withPhone, recentPhoneActive: recentPhone }));
  const q = await db.collection('smsq').get(); const t = new Date(Date.now() + 8 * 36e5), dk = t.getUTCFullYear() * 10000 + (t.getUTCMonth() + 1) * 100 + t.getUTCDate();
  const dist = {}; q.forEach(d => { const x = d.data(); if (x.dk === dk) dist[x.dn] = (dist[x.dn] || 0) + 1; });
  console.log('SMSQ_TODAY 今天傳過簡訊的人數（依次數）', dk, JSON.stringify(dist), 'docs', q.size);
  const pe = await db.collection('phoneErr').orderBy('at', 'desc').limit(50).get().catch(() => null);
  if (pe) { const cnt = {}; pe.forEach(d => { const x = d.data(); const k = (x.code || '-') + ' | ' + String(x.msg || '').slice(0, 80); cnt[k] = (cnt[k] || 0) + 1; }); console.log('PHONE_ERR', JSON.stringify(cnt, null, 1)); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
