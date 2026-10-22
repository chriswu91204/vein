// VEIN service worker：手機推播通知（Firebase Cloud Messaging 送來的 web push）
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // 不快取，讓網站永遠是最新版
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
    for (const c of all) { if (new URL(c.url).origin === location.origin) { await c.focus(); try { c.navigate(new URL(link, location.origin).href); } catch (x) {} return; } }
    await self.clients.openWindow(link); })());
});
