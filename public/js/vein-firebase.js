// VEIN × Firebase adapter
// 把 Firebase（Firestore、Authentication、Storage）包裝成網站原本使用的資料介面：
// window.claude.use('db' | 'user' | 'assets')。網站其他程式碼不需要知道底層是 Firebase。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, RecaptchaVerifier, linkWithPhoneNumber } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getFirestore, enableNetwork, disableNetwork, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, where, startAfter , increment, writeBatch, getCountFromServer } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getStorage, ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import config from './firebase-config.js';
import { OWNER_EMAILS, APPCHECK_SITE_KEY } from './site-config.js';

const notReady = !config || !config.apiKey || String(config.apiKey).startsWith('PASTE');
if (notReady) {
  window.__veinNoConfig = true;
  console.warn('[VEIN] 尚未設定 public/js/firebase-config.js');
  window.__veinResolve({ use: async () => null });
} else {
  start().catch(e => { console.error('[VEIN] Firebase 初始化失敗', e); window.__veinResolve({ use: async () => null }); });
}

async function start() {
  const app = initializeApp(config);
  // App Check：證明請求真的來自 VEIN 網站，擋掉直接打資料庫的程式（要在 site-config.js 填金鑰才會啟用）
  if (APPCHECK_SITE_KEY) {
    try {
      const AC = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check.js');
      AC.initializeAppCheck(app, { provider: new AC.ReCaptchaV3Provider(APPCHECK_SITE_KEY), isTokenAutoRefreshEnabled: true });
    } catch (e) { console.warn('[VEIN] App Check 啟用失敗', e); }
  }
  const auth = getAuth(app);
  // 本機快取：重複造訪與換頁時直接用快取，減少資料庫讀取與流量
  let fs;
  // iPhone / iPad 與 LINE、FB、IG 內建瀏覽器在行動網路下，即時連線（串流）常常卡住：寫入要等好幾分鐘、聊天收不到新訊息
  // 這些環境改用長輪詢，比較慢一點點但穩定；其他環境讓 SDK 自動判斷
  const ua = navigator.userAgent || '', LP = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) || /Line\/|FBAN|FBAV|Instagram/.test(ua);
  const net = LP ? { experimentalForceLongPolling: true } : { experimentalAutoDetectLongPolling: true };
  try { fs = initializeFirestore(app, { ...net, localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { try { fs = initializeFirestore(app, net); } catch (e2) { fs = getFirestore(app); } }
  const st = getStorage(app);

  // 等第一次登入狀態回報
  let u = await new Promise(res => { const off = onAuthStateChanged(auth, x => { off(); res(x); }); });
  // 只能用 Google 登入：如果不是 Google 帳號（例如有人繞過網站直接用手機號碼登入），直接登出
  if (u && Array.isArray(u.providerData) && u.providerData.length && !u.providerData.some(p => p.providerId === 'google.com')) { try { await signOut(auth); } catch (e) {} u = null; }

  // 管理員可能在後台幫這個帳號綁了手機：重新讀一次登入資料，必要時換新的登入憑證（規則才認得到手機）
  if (u) { try { await Promise.race([(async () => { await u.reload(); const t = await u.getIdTokenResult(); if (!!u.phoneNumber !== !!t.claims.phone_number) await u.getIdToken(true); })(), new Promise(r => setTimeout(r, 3000))]); } catch (e) {} }
  window.__veinAuth = {
    async signIn() {
      const p = new GoogleAuthProvider();
      try { await signInWithPopup(auth, p); location.reload(); }
      catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) return signInWithRedirect(auth, p);
        throw e;
      }
    },
    async signOut() { await signOut(auth); location.reload(); },
    // 手機驗證：把手機號碼綁到目前的 Google 帳號（一支手機只能綁一個帳號）
    phoneVerified: () => !!(auth.currentUser && auth.currentUser.phoneNumber),
    async sendCode(raw, buttonId) {
      let n = String(raw || '').replace(/[\s-]/g, '');
      if (/^09\d{8}$/.test(n)) n = '+886' + n.slice(1);
      if (!/^\+\d{8,15}$/.test(n)) { const e = new Error('bad'); e.code = 'vein/bad-number'; throw e; }
      if (window.__veinRecaptcha) { try { window.__veinRecaptcha.clear(); } catch (e) {} }
      window.__veinRecaptcha = new RecaptchaVerifier(auth, buttonId, { size: 'invisible' });
      const c = await linkWithPhoneNumber(auth.currentUser, n, window.__veinRecaptcha);
      return { async confirm(code) {
        await c.confirm(String(code).trim());
        await auth.currentUser.reload(); await auth.currentUser.getIdToken(true);
        await setDoc(doc(fs, 'profiles/' + auth.currentUser.uid), { phoneVerified: true, updatedAt: Date.now() }, { merge: true });
      } };
    }
  };
  auth.languageCode = 'zh-TW';
  // 手機推播：註冊 service worker、要通知權限、拿 FCM token
  window.__veinPush = {
    async supported() { try { if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) return false; const M = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js'); return await M.isSupported(); } catch (e) { return false; } },
    async enable(vapidKey) {
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' }); await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission(); if (perm !== 'granted') { const e = new Error('denied'); e.code = 'denied'; throw e; }
      const M = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js');
      return await M.getToken(M.getMessaging(app), { vapidKey, serviceWorkerRegistration: reg });
    }
  };

  /* ---------- db ---------- */
  const mapErr = e => ({ code: e && e.code === 'permission-denied' ? 'invalid_argument' : (e && e.code) || 'unknown', message: e && e.message, original: e });
  const clean = d => JSON.parse(JSON.stringify(d));
  const wrapDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: { hasPendingWrites: s.metadata.hasPendingWrites, fromCache: s.metadata.fromCache } });
  const wrapQuery = qs => { const docs = qs.docs.map(wrapDoc); return { docs, size: docs.length, empty: !docs.length, metadata: { hasPendingWrites: qs.metadata.hasPendingWrites, fromCache: qs.metadata.fromCache } }; };
  function Q(path, cons = []) {
    const q = () => query(collection(fs, path), ...cons);
    return {
      path,
      orderBy: (f, d = 'asc') => Q(path, [...cons, orderBy(f, d)]),
      limit: n => Q(path, [...cons, limit(n)]),
      where: (f, op, v) => Q(path, [...cons, where(f, op, v)]),
      startAfter: v => Q(path, [...cons, startAfter(v)]),
      doc: id => D(id ? path + '/' + id : doc(collection(fs, path)).path),
      async get() { try { return wrapQuery(await getDocs(q())); } catch (e) { throw mapErr(e); } },
      async count() { try { return (await getCountFromServer(q())).data().count; } catch (e) { throw mapErr(e); } },
      onSnapshot(next, err, o) { return o && o.meta ? onSnapshot(q(), { includeMetadataChanges: true }, s => next(wrapQuery(s)), e => err && err(mapErr(e))) : onSnapshot(q(), s => next(wrapQuery(s)), e => err && err(mapErr(e))); },
      async add(d) { const r = this.doc(); await r.set(d); return r; }
    };
  }
  function D(path) {
    const r = () => doc(fs, path);
    return {
      id: path.split('/').pop(), path,
      async get() { try { return wrapDoc(await getDoc(r())); } catch (e) { throw mapErr(e); } },
      async set(d) { try { await setDoc(r(), clean(d)); } catch (e) { throw mapErr(e); } },
      async update(d) { try { await updateDoc(r(), clean(d)); } catch (e) { throw mapErr(e); } },
      // 數字欄位用伺服器端加總（多人同時寫也不會互相蓋掉），其他欄位直接覆寫；文件不存在會自動建立
      async inc(d) { try { const o = {}; for (const [k, v] of Object.entries(d || {})) o[k] = typeof v === 'number' && k !== 'at' ? increment(v) : v; await setDoc(r(), o, { merge: true }); } catch (e) { throw mapErr(e); } },
      async delete() { try { await deleteDoc(r()); } catch (e) { throw mapErr(e); } },
      onSnapshot(next, err, o) { return o && o.meta ? onSnapshot(r(), { includeMetadataChanges: true }, s => next(wrapDoc(s)), e => err && err(mapErr(e))) : onSnapshot(r(), s => next(wrapDoc(s)), e => err && err(mapErr(e))); },
      collection: c => Q(path + '/' + c)
    };
  }
  // 一次寫入多筆（全部成功或全部失敗），例如聊天：訊息本身＋列表上的最後一則一起寫，不會出現列表有、對話裡沒有
  const batch = () => { const b = writeBatch(fs); return { set(p, d) { b.set(doc(fs, p), clean(d)); return this; }, update(p, d) { b.update(doc(fs, p), clean(d)); return this; }, async commit() { try { await b.commit(); } catch (e) { throw mapErr(e); } } }; };
  const db = { doc: D, batch, newId: p => doc(collection(fs, p)).path.split('/').pop(), collection: p => Q(p), async resync() { try { await disableNetwork(fs); } finally { await enableNetwork(fs); } } };

  /* ---------- user ---------- */
  let isAdmin = false, isOwner = false;
  let myProf = {};
  if (u) {
    isOwner = !!u.email && u.emailVerified !== false && OWNER_EMAILS.map(e => e.toLowerCase()).includes(u.email.toLowerCase());
    isAdmin = isOwner;
    try { const a = await getDoc(doc(fs, 'site/admins')); if (a.exists() && (a.data().uids || {})[u.uid]) isAdmin = true; } catch (e) {}
    // 公開的名字與頭像，讓別人看得到「誰出價、誰留言」
    // 自訂過顯示名稱（nameSet）就不再用登入帳號的名字蓋掉；會員 ID、隱私設定都保留（merge）
    try { const pr = await getDoc(doc(fs, 'profiles/' + u.uid)); myProf = pr.exists() ? pr.data() : {}; } catch (e) {}
    setDoc(doc(fs, 'profiles/' + u.uid), { ...(myProf.nameSet ? {} : { name: u.displayName || '' }), avatar: u.photoURL || '', phoneVerified: !!u.phoneNumber, updatedAt: Date.now() }, { merge: true }).catch(() => {});
  }
  const cache = new Map();
  const user = {
    async me() { return u ? { id: u.uid, name: (myProf.nameSet && myProf.name) || u.displayName || '', handle: myProf.handle || null, priv: !!myProf.priv, nameSet: !!myProf.nameSet, avatarUrl: u.photoURL || '', email: u.email || null, phoneVerified: !!auth.currentUser?.phoneNumber, phone: auth.currentUser?.phoneNumber || null } : { id: null, name: '', avatarUrl: '' }; },
    async id() { return u ? u.uid : null; },
    async isOwner() { return isOwner; },
    async canEdit() { return isAdmin; },
    async can() { return !!u; },
    async profiles(ids) {
      const out = {};
      await Promise.all(ids.map(async id => {
        if (!cache.has(id)) {
          try { const s = await getDoc(doc(fs, 'profiles/' + id)); cache.set(id, s.exists() ? { name: s.data().name || '', avatarUrl: s.data().avatar || '', phoneVerified: !!s.data().phoneVerified, priv: !!s.data().priv, handle: s.data().handle || null } : { name: '', avatarUrl: '', phoneVerified: false }); }
          catch (e) { cache.set(id, { name: '', avatarUrl: '' }); }
        }
        out[id] = { id, ...cache.get(id), isMe: !!u && id === u.uid };
      }));
      return out;
    }
  };

  /* ---------- assets（照片上傳到 Storage）---------- */
  const assets = u ? {
    async upload(blob, opts = {}) {
      const EXT = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg', 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
      const ext = EXT[blob.type] || '.jpg';
      const name = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) + ext;
      // dir:'site' = 主頁素材（只有擁有者帳號能寫，見 storage.rules）
      const r = ref(st, opts.dir === 'site' ? `site/${name}` : `uploads/${u.uid}/${name}`);
      // 一年瀏覽器快取：同一張圖只下載一次
      await new Promise((res, rej) => {
        const t = uploadBytesResumable(r, blob, { contentType: blob.type || 'image/jpeg', cacheControl: 'public,max-age=31536000,immutable' });
        t.on('state_changed', s => opts.onProgress && opts.onProgress(s.bytesTransferred), rej, res);
      });
      const url = await getDownloadURL(r);
      return { id: url, url, sizeBytes: blob.size, contentType: blob.type || 'image/jpeg' };
    },
    // 刪掉 Storage 裡的檔案（用下載網址）；只有本人或擁有者帳號有權限（見 storage.rules）
    async removeUrl(url) { if (!/firebasestorage/.test(String(url || ''))) return false; await deleteObject(ref(st, url)); return true; }
  } : null;

  window.__veinResolve({ use: async n => n === 'db' ? db : n === 'user' ? user : n === 'assets' ? assets : null });
}
