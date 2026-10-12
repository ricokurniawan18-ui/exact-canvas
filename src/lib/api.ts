/**
 * Jalur data saat aplikasi dibuka di browser (TV atau tablet), bukan di Tauri.
 *
 * Servernya adalah aplikasi Mac sendiri (src-tauri/src/server.rs). Semua
 * permintaan membawa PIN di header; PIN datang dari tautan/QR (`?pin=`) atau
 * dari yang pernah diketik, dan disimpan di browser itu saja.
 */

const KUNCI_PIN = 'exact-canvas-pin'

export function pinTersimpan(): string | null {
  try {
    const dariUrl = new URLSearchParams(location.search).get('pin')
    if (dariUrl && /^\d{4}$/.test(dariUrl)) {
      localStorage.setItem(KUNCI_PIN, dariUrl)
      return dariUrl
    }
    return localStorage.getItem(KUNCI_PIN)
  } catch {
    return null
  }
}

export function simpanPin(pin: string): void {
  try {
    localStorage.setItem(KUNCI_PIN, pin)
  } catch {
    /* penyimpanan browser dimatikan — PIN cukup hidup di memori */
  }
  pinMemori = pin
}

let pinMemori: string | null = null

export function pinAktif(): string {
  return pinMemori ?? pinTersimpan() ?? ''
}

/**
 * Alamat dasar server. Kosong di browser (relatif ke halaman yang dibuka);
 * di dalam aplikasi Mac diisi `http://127.0.0.1:<port>` begitu berbagi menyala,
 * supaya panel kelas di Mac bisa memanggil endpoint yang sama dengan tablet.
 */
let alamatDasar = ''

/** Hak admin: token internal (aplikasi Mac) atau kata sandi admin (tablet). */
const KUNCI_ADMIN = 'exact-canvas-admin'
let adminMemori: string | null = null

export function adminAktif(): string {
  if (adminMemori) return adminMemori
  try {
    return localStorage.getItem(KUNCI_ADMIN) ?? ''
  } catch {
    return ''
  }
}

export function simpanAdmin(sandi: string): void {
  adminMemori = sandi
  try {
    if (sandi) localStorage.setItem(KUNCI_ADMIN, sandi)
    else localStorage.removeItem(KUNCI_ADMIN)
  } catch {
    /* abaikan */
  }
}

/** Sesi akun murid: token acak dari server, pengganti PIN di HP. */
const KUNCI_SESI = 'exact-canvas-sesi'
let sesiMemori: string | null = null

export function sesiAktif(): string {
  if (sesiMemori) return sesiMemori
  try {
    return localStorage.getItem(KUNCI_SESI) ?? ''
  } catch {
    return ''
  }
}

export function simpanSesi(token: string): void {
  sesiMemori = token
  try {
    if (token) localStorage.setItem(KUNCI_SESI, token)
    else localStorage.removeItem(KUNCI_SESI)
  } catch {
    /* abaikan */
  }
}

/**
 * Peran editor di browser: guru utama (sandi admin) atau guru pembantu (akun
 * ber-peran guru, masuk dengan nomor HP + sandi). Aplikasi Mac selalu utama.
 * Guru pembantu tidak melihat urusan admin (setelan, akun, hapus kanvas) —
 * server juga menolaknya; ini hanya supaya tombolnya tidak menggoda.
 */
export interface PeranEditor {
  peran: 'admin' | 'guru'
  id?: string
  nama?: string
}
let peranEditor: PeranEditor = { peran: 'admin' }
export function setPeranEditor(p: PeranEditor | null | undefined): void {
  peranEditor = p && p.peran === 'guru' ? p : { peran: 'admin' }
}
export function peranEditorIni(): PeranEditor {
  return peranEditor
}
export function guruPembantu(): boolean {
  return peranEditor.peran === 'guru'
}

export function setAlamatServer(alamat: string, pin?: string, admin?: string): void {
  alamatDasar = alamat.replace(/\/$/, '')
  if (pin) pinMemori = pin
  if (admin) adminMemori = admin
}

export function alamatServer(): string {
  return alamatDasar
}

/** URL lengkap untuk <img>/tautan yang tidak bisa membawa header PIN. */
export function urlDenganPin(path: string): string {
  const pemisah = path.includes('?') ? '&' : '?'
  const bagian: string[] = []
  if (pinAktif()) bagian.push(`pin=${encodeURIComponent(pinAktif())}`)
  if (sesiAktif()) bagian.push(`sesi=${encodeURIComponent(sesiAktif())}`)
  if (adminAktif()) bagian.push(`admin=${encodeURIComponent(adminAktif())}`)
  return `${alamatDasar}${path}${bagian.length ? pemisah + bagian.join('&') : ''}`
}

export class GalatApi extends Error {
  constructor(
    public status: number,
    pesan: string,
  ) {
    super(pesan)
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: BodyInit; json?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  const pin = pinAktif()
  if (pin) headers['x-exact-pin'] = pin
  const sesi = sesiAktif()
  if (sesi) headers['x-exact-sesi'] = sesi
  const admin = adminAktif()
  if (admin) headers['x-exact-admin'] = admin
  let body = init.body
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  // Tanpa batas waktu, koneksi yang macet (Wi-Fi lemah/tunnel) bisa
  // menggantung tanpa kabar sama sekali — terutama untuk unggahan foto/PDF.
  const kontrol = init.timeoutMs ? new AbortController() : null
  const batas = kontrol ? window.setTimeout(() => kontrol.abort(), init.timeoutMs) : null
  let r: Response
  try {
    r = await fetch(`${alamatDasar}${path}`, { method: init.method ?? 'GET', headers, body, signal: kontrol?.signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error('Request timed out — check your connection and try again.')
    throw e
  } finally {
    if (batas) window.clearTimeout(batas)
  }
  if (!r.ok) {
    const teks = await r.text().catch(() => '')
    throw new GalatApi(r.status, teks || `${r.status} ${r.statusText}`)
  }
  if (r.status === 204) return undefined as T
  const jenis = r.headers.get('content-type') ?? ''
  return (jenis.includes('application/json') ? r.json() : r.text()) as Promise<T>
}

/** Nama perangkat ini, sebisanya dari user agent — untuk daftar klien di Mac. */
export function namaPerangkat(): string {
  const ua = navigator.userAgent
  const m = ua.match(/\((?:Linux; Android [\d.]+; )?([^;)]+)/)
  if (/Tizen|Web0S|SMART-TV|SmartTV|BRAVIA/i.test(ua)) return 'TV'
  if (/Android/.test(ua) && m) {
    const model = ua.match(/Android [\d.]+; ([^;)]+)/)?.[1]?.replace(/ Build.*/, '').trim()
    // Chrome versi baru menyamarkan modelnya jadi "K"; itu bukan nama perangkat.
    if (model && model !== 'K') return model
    return /Tablet|SM-X|SM-T/i.test(ua) || !/Mobile/.test(ua) ? 'Android tablet' : 'Android phone'
  }
  if (/iPad/.test(ua)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Macintosh/.test(ua)) return 'Mac browser'
  return 'Browser'
}
