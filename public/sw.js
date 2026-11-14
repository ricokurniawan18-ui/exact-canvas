/* Exact Canvas — service worker.
 *
 * 1. Notifikasi (pengingat les, dipanggil, pertanyaan dibahas).
 * 2. Buka tanpa Mac: halaman murid (/tv) dan kanvas yang terakhir dilihat
 *    disimpan di perangkat, supaya anak tetap bisa membuka catatannya walau
 *    Mac guru sedang mati (tunnel Cloudflare lalu menjawab 530/1033).
 *
 * Selalu JARINGAN DULU untuk halaman dan isi kanvas: selama Mac menyala, versi
 * baru dari Mac tetap langsung sampai. Simpanan hanya dipakai bila Mac tidak
 * menjawab (jaringan gagal, atau 5xx dari Cloudflare). Aset berhash
 * (/assets/…) dan gambar kanvas (URL ber-sidik ?v=) tidak pernah berubah,
 * jadi boleh diambil dari simpanan dulu.
 */
const HALAMAN = 'ec-halaman-v1'
const DATA = 'ec-data-v1'
const BATAS_HALAMAN = 150
const BATAS_DATA = 300
const JEDA_HALAMAN_MS = 10000
const JEDA_DATA_MS = 15000

self.addEventListener('install', (e) => {
  self.skipWaiting()
  // Kunjungan pertama: halaman yang sedang terbuka dimuat sebelum service
  // worker ini ada, jadi asetnya tidak lewat sini — ambil sekarang.
  e.waitUntil(simpanHalaman().catch(() => undefined))
})
self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== HALAMAN && k !== DATA) await caches.delete(k)
      await self.clients.claim()
    })(),
  ),
)

/* ── Buka tanpa Mac ────────────────────────────────────────────────── */

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  const p = url.pathname
  if (req.mode === 'navigate') {
    // `/` lewat alamat publik dialihkan ke /tv?murid=1; saat Mac mati
    // pengalihan itu pun tidak ada, jadi langsung ke halaman murid tersimpan.
    if (p === '/tv' || p === '/') e.respondWith(halaman(e, req, p))
    return
  }
  if (p.startsWith('/assets/')) return e.respondWith(simpananDulu(HALAMAN, req, BATAS_HALAMAN))
  if (p.startsWith('/pwa/') || p === '/manifest-murid.json' || p === '/eksa-halo.svg') {
    return e.respondWith(jaringanDulu(HALAMAN, req, BATAS_HALAMAN, JEDA_HALAMAN_MS))
  }
  if (/^\/api\/canvas\/[^/]+\/gambar\//.test(p)) return e.respondWith(simpananDulu(DATA, req, BATAS_DATA))
  if (/^\/api\/canvas\/[^/]+\/ringan$/.test(p)) return e.respondWith(jaringanDulu(DATA, req, BATAS_DATA, JEDA_DATA_MS))
})

/** Mac tidak terjangkau: jaringan gagal, atau Cloudflare menjawab 5xx (tunnel putus). */
const macMati = (r) => !r || r.status >= 500

function denganBatas(janji, ms) {
  return new Promise((selesai, gagal) => {
    const t = setTimeout(() => gagal(new Error('batas waktu')), ms)
    janji.then(
      (r) => (clearTimeout(t), selesai(r)),
      (err) => (clearTimeout(t), gagal(err)),
    )
  })
}

/** Respons sungguhan, bukan index.html pengganti yang dijawab server untuk path tak dikenal. */
function layakDisimpan(req, r) {
  if (!r.ok || r.type === 'opaqueredirect') return false
  const jenis = r.headers.get('content-type') || ''
  return !jenis.includes('text/html') || new URL(req.url).pathname === '/tv'
}

/** Simpan lalu pangkas yang paling lama ditulis (urutan keys = urutan masuk). */
async function taruh(nama, kunci, r, batas) {
  const c = await caches.open(nama)
  await c.delete(kunci, { ignoreVary: true })
  await c.put(kunci, r)
  const semua = await c.keys()
  for (let i = 0; i < semua.length - batas; i++) await c.delete(semua[i])
}

async function halaman(e, req, p) {
  let r = null
  try {
    r = await denganBatas(fetch(req), JEDA_HALAMAN_MS)
  } catch {
    r = null
  }
  if (!macMati(r)) {
    if (p === '/tv' && r.ok) e.waitUntil(simpanHalaman(r.clone()).catch(() => undefined))
    return r
  }
  const lama = await caches.match('/tv', { cacheName: HALAMAN })
  return lama || r || Response.error()
}

/** Simpan /tv beserta skrip/gaya/ikon yang disebutnya. */
async function simpanHalaman(r) {
  if (!r) {
    r = await fetch('/tv', { cache: 'no-store' })
    if (!r.ok) return
  }
  const html = await r.clone().text()
  await taruh(HALAMAN, '/tv', r, BATAS_HALAMAN)
  const c = await caches.open(HALAMAN)
  const aset = new Set()
  for (const m of html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)) {
    const u = m[1]
    if (u.startsWith('/assets/') || u.startsWith('/pwa/') || u === '/manifest-murid.json' || u === '/eksa-halo.svg') aset.add(u)
  }
  for (const u of aset) {
    try {
      if (u.startsWith('/assets/') && (await c.match(u))) continue
      const a = await fetch(u)
      if (layakDisimpan(new Request(u), a)) await taruh(HALAMAN, u, a, BATAS_HALAMAN)
    } catch {
      /* coba lagi pada kunjungan berikutnya */
    }
  }
}

async function simpananDulu(nama, req, batas) {
  const lama = await caches.match(req, { cacheName: nama, ignoreVary: true })
  if (lama) return lama
  const r = await fetch(req)
  if (layakDisimpan(req, r)) await taruh(nama, req, r.clone(), batas).catch(() => undefined)
  return r
}

async function jaringanDulu(nama, req, batas, jeda) {
  let r = null
  try {
    r = await denganBatas(fetch(req), jeda)
  } catch {
    r = null
  }
  if (!macMati(r)) {
    if (layakDisimpan(req, r)) await taruh(nama, req, r.clone(), batas).catch(() => undefined)
    return r
  }
  const lama = await caches.match(req, { cacheName: nama, ignoreVary: true })
  if (lama) return lama
  return r || new Response('Offline', { status: 503, statusText: 'Offline' })
}

/* ── Notifikasi ────────────────────────────────────────────────────── */

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
