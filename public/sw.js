/* Exact Canvas — service worker untuk notifikasi (pengingat les, dipanggil,
 * pertanyaan dibahas). Sengaja TANPA penangan fetch: tidak ada yang di-cache,
 * jadi versi baru dari Mac selalu langsung sampai. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { isi: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(d.judul || 'Exact Canvas', {
      body: d.isi || '',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: '/pwa/ikon-192.png',
      badge: '/pwa/ikon-192.png',
      vibrate: [120, 60, 120],
      data: { url: d.url || '/tv?murid=1' },
    }),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const tujuan = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin)
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((jendela) => {
      for (const w of jendela) {
        if (new URL(w.url).pathname === tujuan.pathname && 'focus' in w) return w.focus()
      }
      return self.clients.openWindow(tujuan.href)
    }),
  )
})
