// VEIN service worker：手機推播通知（Firebase Cloud Messaging 送來的 web push）
// ＋ 省流量：網站內建的影片與圖片（/m/、/guide/、圖示）每台裝置只下載一次，之後直接從手機讀，不再算網站流量
//   網頁本身（index.html）、資料庫、上傳的照片都不經過這裡，所以網站永遠是最新版
//   ⚠️ 換了 /m/ 裡的檔案（同一個檔名）時，要把 MC 的版本號 +1，大家才會重新下載
const MC = 'vein-media-v2';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('vein-media-') && k !== MC) await caches.delete(k);
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url); if (u.origin !== location.origin) return;
  if (!/^\/(m|guide)\//.test(u.pathname) && !/^\/(icon-|apple-touch-icon)/.test(u.pathname)) return;
  e.respondWith(media(r, u).catch(() => fetch(r)));
});
async function media(req, u) {
  const c = await caches.open(MC), key = u.origin + u.pathname;
  let res = await c.match(key);
  if (!res) { const full = await fetch(key, { credentials: 'same-origin' }); if (!full.ok || full.status !== 200) return full; await c.put(key, full.clone()); res = full; }
  const range = req.headers.get('range'); if (!range) return res;
  // 影片會分段要（Range）：從存好的完整檔切出那一段回給播放器
  const buf = await res.arrayBuffer(), size = buf.byteLength, m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  let start = m[1] ? +m[1] : 0, end = m[2] ? +m[2] : size - 1; if (!m[1] && m[2]) { start = Math.max(0, size - +m[2]); end = size - 1; }
  end = Math.min(end, size - 1); if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(buf.slice(start, end + 1), { status: 206, headers: { 'Content-Type': res.headers.get('Content-Type') || 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { notification: { title: 'VEIN', body: e.data ? e.data.text() : '' } }; }
  const n = d.notification || {}, data = d.data || {};
  const title = n.title || data.title || 'VEIN';
  e.waitUntil(self.registration.showNotification(title, {
    body: n.body || data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag || undefined,
    data: { link: data.link || (d.fcmOptions && d.fcmOptions.link) || '/' }, renotify: !!data.tag
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const link = (e.notification.data && e.notification.data.link) || '/';
  e.waitUntil((async () => { const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if (new URL(c.url).origin === location.origin) { await c.focus(); try { c.postMessage({ veinGo: link }); } catch (x) { try { c.navigate(new URL(link, location.origin).href); } catch (y) {} } return; } }
    await self.clients.openWindow(link); })());
});
