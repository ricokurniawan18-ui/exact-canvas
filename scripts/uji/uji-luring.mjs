// Uji "buka tanpa Mac": server tiruan Mac (bisa dimatikan → 530 ala Cloudflare)
// + Chrome headless sebagai HP murid.
//   node uji-luring.mjs <folder dist>
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'

const DIST = process.argv[2]
const PORT = 4799
let mati = false
let catatan = 'A' // isi kanvas berubah antar kunjungan
const hit = []
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
const PNG = readFileSync(join(DIST, 'pwa/ikon-192.png'))

function sketsa() {
  const pts = catatan === 'A' ? [[100, 100, 0.5], [400, 300, 0.5]] : [[100, 300, 0.5], [400, 100, 0.5], [500, 500, 0.5]]
  return {
    id: 'k1', title: 'Catatan', paper: 'a4', pages: 1, updated_at: Date.now(),
    strokes: [{ id: 'c-' + catatan, tool: 'pen', color: 'ink', size: 6, layer: 0, points: pts }],
    images: [{ id: 'g1', layer: 0, x: 50, y: 500, w: 192, h: 192, src: '/api/canvas/k1/gambar/0.png?v=1&sesi=S1' }],
    objects: [], texts: [],
  }
}

const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  const p = u.pathname
  if (p === '/__mati') { mati = true; return res.end('ok') }
  if (p === '/__hidup') { mati = false; return res.end('ok') }
  if (p === '/__catatan') { catatan = u.searchParams.get('v'); return res.end('ok') }
  hit.push(`${mati ? 'MATI ' : ''}${req.method} ${p}`)
  if (mati) {
    res.writeHead(530, { 'content-type': 'text/html' })
    return res.end('<html>error code: 1033</html>')
  }
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (p === '/tv') { res.writeHead(200, { 'content-type': mime['.html'], 'cache-control': 'no-cache' }); return res.end(readFileSync(join(DIST, 'tv.html'))) }
  if (p === '/api/akun/saya') return json({ id: 'm1', nama: 'Budi', hp: '0812', disetujui: true })
  if (p === '/api/kelas/masuk') return json({})
  if (p === '/api/kelas/saya') return json({ grup: null, tanya: null, boleh: false, kanvas: 'k1', kanvasPribadi: 'k1', kanvasGrup: null })
  if (p === '/api/kelas/terbaru') return json({ id: null })
  if (p === '/api/canvas/k1/ringan') return json(sketsa())
  if (p.startsWith('/api/canvas/k1/gambar/')) { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' }); return res.end(PNG) }
  if (p === '/api/lokal') return json({ publik: null, lokal: [] })
  if (p === '/api/kelas/harian') return json({ perlu: false, jadwal: null })
  if (p.startsWith('/api/')) return json({})
  const f = join(DIST, p)
  if (existsSync(f) && !f.endsWith('/')) {
    res.writeHead(200, { 'content-type': mime[extname(f)] ?? 'application/octet-stream', 'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' })
    return res.end(readFileSync(f))
  }
  res.writeHead(200, { 'content-type': mime['.html'] }); res.end(readFileSync(join(DIST, 'index.html')))
})
// WebSocket: hidup → jabat tangan minimal & kirim daftar klien; mati → 530.
import { createHash } from 'node:crypto'
srv.on('upgrade', (req, sock) => {
  if (mati) { sock.end('HTTP/1.1 530 Origin Unreachable\r\ncontent-length: 0\r\n\r\n'); return }
  const k = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${k}\r\n\r\n`)
  const isi = Buffer.from(JSON.stringify({ t: 'klien', daftar: [], server: 'boot1' }))
  sock.write(Buffer.concat([Buffer.from([0x81, isi.length]), isi]))
  sock.on('error', () => {})
  sock.on('data', () => {})
})
await new Promise((r) => srv.listen(PORT, '127.0.0.1', r))
const B = `http://localhost:${PORT}`

const tidur = (ms) => new Promise((r) => setTimeout(r, ms))
let lulus = 0, gagal = 0
const cek = (n, ok, info = '') => { ok ? lulus++ : gagal++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${n}${info ? ' — ' + info : ''}`) }

const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const prof = `${process.env.TMPDIR}/uji-luring-chrome-${Date.now()}`
const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9334', '--window-size=420,860', `--user-data-dir=${prof}`,
  '--user-agent=Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36', 'about:blank'], { stdio: 'ignore' })
let target = null
for (let i = 0; i < 40 && !target; i++) { await tidur(250); try { const l = await (await fetch('http://127.0.0.1:9334/json')).json(); target = l.find((t) => t.type === 'page') } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r))
let seq = 0; const tunggu = new Map(); const log = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && tunggu.has(m.id)) { tunggu.get(m.id)(m); tunggu.delete(m.id) }
  if (m.method === 'Runtime.exceptionThrown') log.push('EXC ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)) }
const cdp = (method, params = {}) => new Promise((r) => { const id = ++seq; tunggu.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
await cdp('Runtime.enable'); await cdp('Page.enable')
const ev = async (x) => (await cdp('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value
const sampai = async (x, n = 60) => { for (let i = 0; i < n; i++) { if (await ev(x)) return true; await tidur(250) } return false }
const buka = async (url) => { await cdp('Page.navigate', { url }); await tidur(800) }
// Piksel gelap di kanvas dasar = goresan tergambar. Juga sidik sederhana untuk membandingkan.
const sidikKanvas = () => ev(`(() => { const c = document.getElementById('dasar'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n=0,h=0; for (let i=0;i<d.length;i+=4){ if (d[i]<90&&d[i+1]<90&&d[i+2]<90){n++; h=(h*31+i)%1000003} } return n+':'+h })()`)

try {
  // 1. Kunjungan biasa, Mac hidup. Sesi sudah ada di HP (anak pernah masuk).
  await buka(`${B}/tv?murid=1`)
  await ev(`localStorage.setItem('exact-canvas-sesi','S1')`)
  await buka(`${B}/tv?murid=1`)
  cek('Mac hidup: layar Join tampil', await sampai(`document.getElementById('masuk')?.classList.contains('tampil')`))
  await ev(`document.getElementById('form-masuk').requestSubmit()`)
  cek('Mac hidup: kanvas murid termuat', await sampai(`localStorage.getItem('exact-murid-kanvas-terakhir')?.includes('k1')`))
  cek('service worker aktif & mengendalikan', await sampai(`navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)`, 40) || (await buka(`${B}/tv?murid=1`), await sampai(`!!navigator.serviceWorker.controller`)))
  // Kunjungan kedua di bawah kendali SW: isi kanvas lewat SW → tersimpan.
  await buka(`${B}/tv?murid=1`)
  await sampai(`document.getElementById('masuk')?.classList.contains('tampil')`)
  await ev(`document.getElementById('form-masuk').requestSubmit()`)
  await tidur(1500)
  const sidikHidup = await sidikKanvas()
  cek('Mac hidup: goresan tergambar', Number(sidikHidup.split(':')[0]) > 50, sidikHidup)
  const simpanan = await ev(`(async () => { const out = []; for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) out.push(n + ' ' + new URL(r.url).pathname); return out })()`)
  cek('simpanan berisi /tv, aset, kanvas ringan, gambar', ['/tv', '/assets/tv-', '/api/canvas/k1/ringan', '/api/canvas/k1/gambar/'].every((s) => simpanan.some((x) => x.includes(s))), JSON.stringify(simpanan))

  // 2. Mac mati. Buka ulang dari nol.
  await fetch(`${B}/__mati`)
  hit.length = 0
  await buka(`${B}/tv?murid=1`)
  cek('Mac mati: halaman tetap terbuka (bukan galat 1033)', await sampai(`!!document.getElementById('form-masuk')`))
  cek('Mac mati: layar masuk menyebut Mac mati', await sampai(`document.getElementById('masuk-siapa').textContent.includes("Mac is off")`), await ev(`document.getElementById('masuk-siapa')?.textContent`))
  cek('Mac mati: sesi TIDAK dibuang', (await ev(`localStorage.getItem('exact-canvas-sesi')`)) === 'S1')
  await ev(`document.getElementById('form-masuk').requestSubmit()`)
  await tidur(2500)
  const sidikMati = await sidikKanvas()
  cek('Mac mati: catatan terakhir tergambar sama persis', sidikMati === sidikHidup, `${sidikMati} vs ${sidikHidup}`)
  cek('Mac mati: pesan offline tampil', (await ev(`document.getElementById('status').textContent`)).includes('Offline'), await ev(`document.getElementById('status').textContent`))
  cek('Mac mati: tombol coret tidak muncul', await ev(`document.getElementById('tombol-coret').hidden`))
  cek('Mac mati: permintaan sungguh dijawab 530', hit.some((h) => h.startsWith('MATI')), hit.slice(0, 5).join(', '))

  // 3. Mac hidup lagi dengan catatan baru → halaman memuat ulang sendiri ke alur biasa.
  await fetch(`${B}/__catatan?v=B`)
  await fetch(`${B}/__hidup`)
  cek('Mac hidup lagi: halaman memuat ulang ke layar Join biasa', await sampai(`document.getElementById('masuk')?.classList.contains('tampil') && document.getElementById('masuk-siapa').textContent === 'Hi, Budi'`, 60))
  await ev(`document.getElementById('form-masuk').requestSubmit()`)
  await tidur(1500)
  const sidikBaru = await sidikKanvas()
  cek('Mac hidup lagi: catatan TERBARU dari Mac (bukan simpanan lama)', sidikBaru !== sidikHidup && Number(sidikBaru.split(':')[0]) > 50, `${sidikBaru} vs lama ${sidikHidup}`)

  // 4. Mac mati lagi → yang tampil catatan terbaru (B).
  await fetch(`${B}/__mati`)
  await buka(`${B}/tv?murid=1`)
  await sampai(`document.getElementById('masuk')?.classList.contains('tampil')`)
  await ev(`document.getElementById('form-masuk').requestSubmit()`)
  await tidur(2500)
  cek('Mac mati lagi: yang tampil versi terbaru', (await sidikKanvas()) === sidikBaru)

  // 5. Keluar akun saat offline → catatan tidak terbuka untuk anak berikutnya.
  await ev(`localStorage.removeItem('exact-canvas-sesi')`)
  await buka(`${B}/tv?murid=1`)
  cek('tanpa sesi: layar akun (bukan catatan orang lain)', await sampai(`document.getElementById('akun')?.classList.contains('tampil')`))
  await ev(`(() => { document.getElementById('akun-hp').value='0812'; document.getElementById('akun-sandi').value='x'; document.getElementById('form-akun').requestSubmit() })()`)
  cek('masuk saat Mac mati: pesan ramah, bukan HTML Cloudflare', await sampai(`document.getElementById('akun-galat').textContent.includes("Mac is off")`), await ev(`document.getElementById('akun-galat').textContent`))
} finally {
  cek('tanpa exception di halaman', log.length === 0, log.join(' | '))
  console.log(`\n${lulus} lulus, ${gagal} gagal`)
  chrome.kill(); srv.close(); process.exit(gagal ? 1 : 0)
}
