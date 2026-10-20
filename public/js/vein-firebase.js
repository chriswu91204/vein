// VEIN × Firebase adapter
// 把 Firebase（Firestore、Authentication、Storage）包裝成網站原本使用的資料介面：
// window.claude.use('db' | 'user' | 'assets')。網站其他程式碼不需要知道底層是 Firebase。
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, signOut, RecaptchaVerifier, linkWithPhoneNumber } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, where } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js';
import config from './firebase-config.js';

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
  const auth = getAuth(app);
  const fs = getFirestore(app);
  const st = getStorage(app);

  // 等第一次登入狀態回報
  const u = await new Promise(res => { const off = onAuthStateChanged(auth, x => { off(); res(x); }); });

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
        await setDoc(doc(fs, 'profiles/' + auth.currentUser.uid), { name: auth.currentUser.displayName || '', avatar: auth.currentUser.photoURL || '', phoneVerified: true, updatedAt: Date.now() });
      } };
    }
  };
  auth.languageCode = 'zh-TW';

  /* ---------- db ---------- */
  const mapErr = e => ({ code: e && e.code === 'permission-denied' ? 'invalid_argument' : (e && e.code) || 'unknown', message: e && e.message, original: e });
  const clean = d => JSON.parse(JSON.stringify(d));
  const wrapDoc = s => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: { hasPendingWrites: s.metadata.hasPendingWrites, fromCache: s.metadata.fromCache } });
  const wrapQuery = qs => { const docs = qs.docs.map(wrapDoc); return { docs, size: docs.length, empty: !docs.length, metadata: { hasPendingWrites: qs.metadata.hasPendingWrites } }; };
  function Q(path, cons = []) {
    const q = () => query(collection(fs, path), ...cons);
    return {
      path,
      orderBy: (f, d = 'asc') => Q(path, [...cons, orderBy(f, d)]),
      limit: n => Q(path, [...cons, limit(n)]),
      where: (f, op, v) => Q(path, [...cons, where(f, op, v)]),
      doc: id => D(id ? path + '/' + id : doc(collection(fs, path)).path),
      async get() { try { return wrapQuery(await getDocs(q())); } catch (e) { throw mapErr(e); } },
      onSnapshot(next, err) { return onSnapshot(q(), s => next(wrapQuery(s)), e => err && err(mapErr(e))); },
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
      async delete() { try { await deleteDoc(r()); } catch (e) { throw mapErr(e); } },
      onSnapshot(next, err) { return onSnapshot(r(), s => next(wrapDoc(s)), e => err && err(mapErr(e))); },
      collection: c => Q(path + '/' + c)
    };
  }
  const db = { doc: D, collection: p => Q(p) };

  /* ---------- user ---------- */
  let isAdmin = false;
  if (u) {
    try { const a = await getDoc(doc(fs, 'site/admins')); isAdmin = a.exists() && !!(a.data().uids || {})[u.uid]; } catch (e) {}
    // 公開的名字與頭像，讓別人看得到「誰出價、誰留言」
    setDoc(doc(fs, 'profiles/' + u.uid), { name: u.displayName || '', avatar: u.photoURL || '', phoneVerified: !!u.phoneNumber, updatedAt: Date.now() }).catch(() => {});
  }
  const cache = new Map();
  const user = {
    async me() { return u ? { id: u.uid, name: u.displayName || '', avatarUrl: u.photoURL || '', email: u.email || null, phoneVerified: !!auth.currentUser?.phoneNumber } : { id: null, name: '', avatarUrl: '' }; },
    async id() { return u ? u.uid : null; },
    async isOwner() { return isAdmin; },
    async canEdit() { return isAdmin; },
    async can() { return !!u; },
    async profiles(ids) {
      const out = {};
      await Promise.all(ids.map(async id => {
        if (!cache.has(id)) {
          try { const s = await getDoc(doc(fs, 'profiles/' + id)); cache.set(id, s.exists() ? { name: s.data().name || '', avatarUrl: s.data().avatar || '', phoneVerified: !!s.data().phoneVerified } : { name: '', avatarUrl: '', phoneVerified: false }); }
          catch (e) { cache.set(id, { name: '', avatarUrl: '' }); }
        }
        out[id] = { id, ...cache.get(id), isMe: !!u && id === u.uid };
      }));
      return out;
    }
  };

  /* ---------- assets（照片上傳到 Storage）---------- */
  const assets = u ? {
    async upload(blob) {
      const name = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) + '.jpg';
      const r = ref(st, `uploads/${u.uid}/${name}`);
      await uploadBytes(r, blob, { contentType: blob.type || 'image/jpeg', cacheControl: 'public,max-age=31536000' });
      const url = await getDownloadURL(r);
      return { id: url, url, sizeBytes: blob.size, contentType: blob.type || 'image/jpeg' };
    }
  } : null;

  window.__veinResolve({ use: async n => n === 'db' ? db : n === 'user' ? user : n === 'assets' ? assets : null });
}
