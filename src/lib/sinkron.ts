/**
 * Sinkronisasi langsung antar layar lewat hub WebSocket di aplikasi Mac.
 *
 * Yang lewat sini bukan data tersimpan — itu urusan vault — melainkan yang
 * sedang terjadi *sekarang*: pandangan yang digeser, goresan yang baru
 * setengah jalan, penggaris yang dipindah, ujung pena yang melayang. TV
 * mengikutinya tanpa jeda karena yang dikirim hanya angka koordinat. Servernya
 * tidak menafsirkan apa pun; ia menyiarkan tiap pesan ke semua klien lain.
 */

import { create } from 'zustand'

export interface Klien {
  id: string
  nama: string
  peran: string
  murid: string
  fokus: boolean
  keluar: number
  tunggu: boolean
  /** Id akun guru pembantu (editor yang masuk lewat akun); kosong untuk guru utama. */
  guru?: string
}

export interface PesanLangsung {
  t: string
  src?: string
  [k: string]: unknown
}

export interface OpsiSinkron {
  /** ws://host:port/ws */
  url: string
  pin: string
  peran: 'editor' | 'tv'
  nama: string
  /** Id murid, untuk HP yang masuk dengan nama. */
  murid?: string
  /** Token/sandi admin — wajib untuk peran editor. */
  admin?: string
  /** Token sesi akun murid. */
  sesi?: string
}

/** Id jendela/browser ini; pesan yang memantul balik dari server dikenali darinya. */
export const idKlien = `k${Math.random().toString(36).slice(2, 9)}`

type Handler = (p: PesanLangsung) => void
const pendengar = new Set<Handler>()

interface StoreSinkron {
  status: 'mati' | 'menyambung' | 'tersambung'
  klien: Klien[]
  /** Server berhenti dari sisi Mac; jangan mencoba menyambung lagi. */
  serverMati: boolean
  /** Penanda proses server; berganti tiap aplikasi Mac dibuka ulang. */
  server: string | null
}

export const useSinkron = create<StoreSinkron>(() => ({ status: 'mati', klien: [], serverMati: false, server: null }))

let ws: WebSocket | null = null
let opsi: OpsiSinkron | null = null
let timerUlang: number | null = null

/**
 * Pesan yang gagal terkirim karena sedang putus (mis. Wi-Fi tablet guru
 * sebentar hilang). Disimpan di sini dan disiram begitu tersambung lagi,
 * supaya goresan yang ditulis pas putus tidak hilang tanpa jejak.
 */
let antrean: string[] = []
const BATAS_ANTREAN = 200

/**
 * Pesan sesaat — titik pratinjau, kursor, posisi layar. Tidak ada gunanya
 * dikirim belakangan, jadi tidak diantrekan saat putus. Dulu ikut diantrekan
 * dan, karena tiap goresan menghasilkan puluhan titik, membanjiri antrean
 * sampai pesan `ubah` (goresan yang sudah jadi) tergeser keluar dan hilang.
 */
const SESAAT = new Set(['titik', 'kursor', 'pandangan', 'instrumen', 'goresan', 'objek', 'ping'])

/**
 * Pesan yang harus sampai (goresan murid): disimpan sampai server mengakuinya
 * ({t:'ack', kunci}), dikirim ulang setiap tersambung lagi dan berkala kalau
 * belum diakui. Server menyimpannya berdasarkan id goresan, jadi kiriman
 * ganda aman.
 */
const belumDiakui = new Map<string, { pesan: string; dikirim: number }>()
const BATAS_BELUM_DIAKUI = 500
/** Disimpan juga di perangkat: halaman yang dimuat ulang saat putus tidak kehilangan goresannya. */
const KUNCI_SIMPAN = 'exact-goresan-belum-diakui'
try {
  const lama = JSON.parse(localStorage.getItem(KUNCI_SIMPAN) ?? '[]') as [string, string][]
  for (const [k, pesan] of lama) belumDiakui.set(k, { pesan, dikirim: 0 })
} catch {
  /* penyimpanan tidak tersedia */
}
let timerSimpanBelum: number | null = null
function simpanBelumDiakui() {
  if (timerSimpanBelum) return
  timerSimpanBelum = window.setTimeout(() => {
    timerSimpanBelum = null
    try {
      // Foto yang ditempel (data URL besar) tidak ikut disimpan — kuota terbatas.
      const isi = [...belumDiakui].filter(([, v]) => v.pesan.length < 200_000).map(([k, v]) => [k, v.pesan])
      if (isi.length) localStorage.setItem(KUNCI_SIMPAN, JSON.stringify(isi))
      else localStorage.removeItem(KUNCI_SIMPAN)
    } catch {
      /* penuh / tidak tersedia */
    }
  }, 500)
}

/** Pesan terakhir dari server — untuk mengenali sambungan yang mati diam-diam. */
let terakhirTerima = 0
/** Sudah pernah tersambung: sambungan berikutnya adalah sambungan ULANG. */
let pernahTersambung = false
/** Kapan halaman terakhir masuk ke latar (layar terkunci, pindah aplikasi). */
let tersembunyiSejak = 0

/**
 * Minta halaman menyegarkan kanvasnya dari simpanan. Pesan langsung yang
 * terlewat selama putus atau selama halaman dibekukan di latar TIDAK dikirim
 * ulang oleh server — dulu layar baru benar lagi kalau guru kebetulan menulis
 * lagi atau murid menekan refresh.
 */
function mintaSegarkan(alasan: string) {
  const p = { t: 'segarkan', alasan } as PesanLangsung
  pendengar.forEach((h) => h(p))
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      tersembunyiSejak = Date.now()
      return
    }
    const lama = tersembunyiSejak ? Date.now() - tersembunyiSejak : 0
    tersembunyiSejak = 0
    if (!opsi || lama < 3_000) return
    const s = ws
    if (!s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
      // Sedang menunggu jadwal sambung ulang: sambung sekarang juga.
      if (timerUlang) window.clearTimeout(timerUlang)
      timerUlang = null
      sambung()
      return
    }
    if (s.readyState === WebSocket.OPEN) {
      // Sambungan bisa "terbuka" padahal sudah mati selama di latar: kalau
      // lama tidak ada kabar, putus dan sambung ulang (onopen menyegarkan);
      // kalau masih hidup, cukup segarkan kanvasnya.
      if (Date.now() - terakhirTerima > 12_000) s.close()
      else {
        s.send(JSON.stringify({ t: 'ping' }))
        mintaSegarkan('kembali')
      }
    }
  })
}
let timerDenyut: number | null = null
/** Tanpa kabar selama ini (padahal kita mengirim ping tiap 10 detik): anggap putus. */
const BATAS_SENYAP_MS = 25_000

function sambung() {
  if (!opsi) return
  const u = new URL(opsi.url)
  u.searchParams.set('pin', opsi.pin)
  u.searchParams.set('id', idKlien)
  u.searchParams.set('name', opsi.nama)
  u.searchParams.set('role', opsi.peran)
  if (opsi.murid) u.searchParams.set('murid', opsi.murid)
  if (opsi.admin) u.searchParams.set('admin', opsi.admin)
  if (opsi.sesi) u.searchParams.set('sesi', opsi.sesi)
  if (!opsi.pin) u.searchParams.delete('pin')
  useSinkron.setState({ status: 'menyambung' })
  const soket = new WebSocket(u.toString())
  ws = soket
  soket.onopen = () => {
    if (ws !== soket) return
    terakhirTerima = Date.now()
    mulaiDenyut()
    useSinkron.setState({ status: 'tersambung', serverMati: false })
    if (pernahTersambung) mintaSegarkan('tersambung-ulang')
    pernahTersambung = true
    if (antrean.length) {
      const isi = antrean
      antrean = []
      for (const pesan of isi) {
        if (soket.readyState === WebSocket.OPEN) soket.send(pesan)
      }
    }
    kirimUlangBelumDiakui(soket, 0)
  }
  soket.onmessage = (e) => {
    terakhirTerima = Date.now()
    let p: PesanLangsung
    try {
      p = JSON.parse(String(e.data)) as PesanLangsung
    } catch {
      return
    }
    if (p.t === 'pong') return
    if (p.t === 'ack') {
      if (typeof p.kunci === 'string' && belumDiakui.delete(p.kunci)) simpanBelumDiakui()
      return
    }
    if (p.t === 'klien') {
      useSinkron.setState({ klien: (p.daftar as Klien[]) ?? [], server: (p.server as string | undefined) ?? null })
      return
    }
    if (p.t === 'server-mati') {
      useSinkron.setState({ serverMati: true })
      hentikanSinkron()
      return
    }
    if (p.src === idKlien) return
    pendengar.forEach((h) => h(p))
  }
  soket.onclose = () => {
    if (ws !== soket) return
    ws = null
    if (!opsi) {
      useSinkron.setState({ status: 'mati', klien: [] })
      return
    }
    // Wi-Fi putus sebentar tidak boleh mematikan layar TV sampai malam:
    // coba lagi tiap dua detik selama masih diminta tersambung.
    useSinkron.setState({ status: 'menyambung' })
    timerUlang = window.setTimeout(sambung, 2000)
  }
  soket.onerror = () => {
    // onclose menyusul dan yang menangani penyambungan ulang.
  }
}

/** Kirim ulang pesan yang belum diakui dan sudah lebih lama dari `umurMs`. */
function kirimUlangBelumDiakui(soket: WebSocket, umurMs: number) {
  const kini = Date.now()
  for (const v of belumDiakui.values()) {
    if (soket.readyState !== WebSocket.OPEN) return
    if (kini - v.dikirim < umurMs) continue
    v.dikirim = kini
    soket.send(v.pesan)
  }
}

/**
 * Sambungan seluler/tunnel bisa tetap "OPEN" padahal sudah mati: pesan yang
 * dikirim masuk ke lubang tanpa galat. Ping tiap 10 detik; kalau server
 * senyap lebih dari 25 detik, sambungan ditutup dan disambung ulang — lalu
 * goresan yang belum diakui dikirim lagi.
 */
function mulaiDenyut() {
  if (timerDenyut) return
  timerDenyut = window.setInterval(() => {
    const s = ws
    if (!s || s.readyState !== WebSocket.OPEN) return
    if (Date.now() - terakhirTerima > BATAS_SENYAP_MS) {
      s.close()
      return
    }
    s.send(JSON.stringify({ t: 'ping' }))
    kirimUlangBelumDiakui(s, 8_000)
  }, 10_000)
}

export function mulaiSinkron(o: OpsiSinkron): void {
  if (opsi && opsi.url === o.url && opsi.pin === o.pin && ws && ws.readyState <= 1) return
  hentikanSinkron()
  opsi = o
  sambung()
}

export function hentikanSinkron(): void {
  opsi = null
  if (timerUlang) window.clearTimeout(timerUlang)
  timerUlang = null
  if (timerDenyut) window.clearInterval(timerDenyut)
  timerDenyut = null
  const s = ws
  ws = null
  s?.close()
  antrean = []
  useSinkron.setState({ status: 'mati', klien: [] })
}

export function tersambung(): boolean {
  return ws?.readyState === WebSocket.OPEN
}

/**
 * Kirim ke semua layar lain. Kalau sedang tidak tersambung, disimpan dulu
 * di antrean dan dikirim begitu tersambung lagi (lihat `antrean` di atas).
 */
export function kirim(p: Record<string, unknown>): void {
  const pesan = JSON.stringify({ ...p, src: idKlien })
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (SESAAT.has(String(p.t))) return
    antrean.push(pesan)
    if (antrean.length > BATAS_ANTREAN) antrean.shift()
    return
  }
  ws.send(pesan)
}

/**
 * Kirim pesan yang harus sampai (goresan murid yang sudah jadi). Disimpan
 * sampai server mengakuinya; putus, tersambung lagi, atau sambungan mati
 * diam-diam — pesannya dikirim ulang sampai diakui.
 */
export function kirimPasti(p: Record<string, unknown>): void {
  const kunci = `${idKlien}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const pesan = JSON.stringify({ ...p, src: idKlien, kunci })
  belumDiakui.set(kunci, { pesan, dikirim: Date.now() })
  if (belumDiakui.size > BATAS_BELUM_DIAKUI) {
    const tertua = belumDiakui.keys().next().value
    if (tertua) belumDiakui.delete(tertua)
  }
  simpanBelumDiakui()
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(pesan)
}

/** Jumlah goresan yang belum dipastikan tersimpan di server. */
export function jumlahBelumDiakui(): number {
  return belumDiakui.size
}

/** Dengarkan pesan dari layar lain (pesan sendiri sudah disaring). */
export function dengarkanLangsung(h: Handler): () => void {
  pendengar.add(h)
  return () => {
    pendengar.delete(h)
  }
}
