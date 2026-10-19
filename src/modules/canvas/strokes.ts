import getStroke from 'perfect-freehand'
import { newId } from '@/lib/id'
import type { MetaGambar } from './sisipan'

import {
  OBJEK,
  gambarObjek,
  kotakObjek,
  objekKeSvg,
  type JenisObjek,
  type Objek,
} from './objek'

/**
 * Alat gambar. Selain pena, stabilo, penghapus, dan laso, setiap jenis objek
 * geometri juga jadi alatnya sendiri — menariknya langsung membuat objek yang
 * titik sudutnya masih bisa digeser setelahnya.
 */
/** Alat yang meninggalkan goresan tangan. */
export type AlatTulis = 'pen' | 'spidol' | 'pensil' | 'kaligrafi' | 'kuas'

/** Pola garis; berlaku untuk goresan tangan maupun objek geometri. */
export type PolaGaris = 'utuh' | 'putus' | 'titik'

export type Alat = AlatTulis | 'penghapus' | 'laso' | 'lasoKotak' | 'teks' | JenisObjek

export const ALAT_TULIS: { id: AlatTulis; label: string; ikon: string }[] = [
  { id: 'pen', label: 'Pen', ikon: 'pena' },
  { id: 'pensil', label: 'Pencil', ikon: 'pensil' },
  { id: 'kaligrafi', label: 'Calligraphy', ikon: 'kaligrafi' },
  { id: 'kuas', label: 'Brush', ikon: 'kuas' },
  { id: 'spidol', label: 'Highlighter', ikon: 'spidol' },
]

export function alatTulis(a: Alat): a is AlatTulis {
  return a === 'pen' || a === 'spidol' || a === 'pensil' || a === 'kaligrafi' || a === 'kuas'
}

export function alatObjek(a: Alat): a is JenisObjek {
  return OBJEK.some((o) => o.id === a)
}

/**
 * Titik goresan dibulatkan: x, y ke 0,01 piksel dunia dan tekanan ke 0,001.
 * Tak terlihat bedanya, tetapi angka mentah 16 digit membuat berkas sketsa
 * dan pesan langsung ke HP murid dua-tiga kali lebih besar dari perlu.
 */
export function titikBulat(x: number, y: number, tekanan: number): [number, number, number] {
  return [Math.round(x * 100) / 100, Math.round(y * 100) / 100, Math.round(tekanan * 1000) / 1000]
}

export interface Coretan {
  id: string
  tool: AlatTulis
  /** Nama token tema, bukan hex — coretan ikut berubah saat tema diganti. */
  color: string
  size: number
  layer: number
  /** [x, y, tekanan] */
  points: [number, number, number][]
  /**
   * Goresan ini ditarik dengan stabiliser menyala — disimpan per-coretan,
   * bukan sebagai setelan global, supaya membuka sketsa lama tidak diam-diam
   * mengubah bentuk garis yang sudah pernah ditarik.
   */
  steady?: boolean
  /** Kepekatan 0–1. Kosong berarti pakai bawaan alatnya. */
  alpha?: number
  /** Kosong berarti garis utuh — nilai bawaan untuk semua berkas lama. */
  pola?: PolaGaris
  /**
   * Id akun murid yang menggambarnya, dibubuhkan server pada goresan dari HP.
   * Dengan ini murid masih bisa menghapus goresannya sendiri sesudah muat
   * ulang, dan tetap tidak bisa menyentuh goresan guru atau teman.
   */
  murid?: string
}

/** Satu lapisan gambar: punya nama, bisa disembunyikan, bisa dikunci. */
export interface Lapisan {
  nama: string
  tampak: boolean
  /** Terkunci = tidak bisa digambari, dihapus, diseret, atau terpilih laso. */
  kunci: boolean
}

export const JUMLAH_LAPISAN = 3

export function lapisanBawaan(): Lapisan[] {
  return Array.from({ length: JUMLAH_LAPISAN }, (_, i) => ({
    nama: `Layer ${i + 1}`,
    tampak: true,
    kunci: false,
  }))
}

/**
 * Berkas lama tidak menyimpan lapisan sama sekali, dan berkas yang disunting
 * tangan bisa menyimpan jumlah yang salah. Keduanya dinormalkan di satu tempat
 * supaya sisa kode boleh menganggap panjangnya selalu JUMLAH_LAPISAN.
 */
export function bacaLapisan(tersimpan: Lapisan[] | undefined): Lapisan[] {
  const bawaan = lapisanBawaan()
  if (!Array.isArray(tersimpan)) return bawaan
  return bawaan.map((l, i) => ({
    nama: tersimpan[i]?.nama?.trim() || l.nama,
    tampak: tersimpan[i]?.tampak !== false,
    kunci: tersimpan[i]?.kunci === true,
  }))
}

/**
 * Gambar tempelan: tangkapan layar, foto, apa pun yang di-paste.
 *
 * Disimpan sebagai data URL di dalam berkas sketsa yang sama, bukan sebagai
 * berkas terpisah — satu sketsa tetap satu berkas yang bisa disalin, dicadangkan,
 * atau dikirim tanpa ada lampiran yang tertinggal.
 */
export interface Gambar {
  id: string
  layer: number
  x: number
  y: number
  w: number
  h: number
  src: string
  /** Radian, berporos di tengah gambar. Sama seperti pada objek geometri. */
  putar?: number
  /**
   * Definisi sisipan yang dirender jadi gambar ini (grafik fungsi, tabel).
   * Disimpan supaya sisipannya masih bisa dibuka dan disunting, lalu dirender
   * ulang — bukan sekadar gambar mati.
   */
  meta?: MetaGambar
}

export function porosGambar(g: Gambar): [number, number] {
  return [g.x + g.w / 2, g.y + g.h / 2]
}

function putarTitik(p: [number, number], poros: [number, number], sudut: number): [number, number] {
  const c = Math.cos(sudut)
  const s = Math.sin(sudut)
  const dx = p[0] - poros[0]
  const dy = p[1] - poros[1]
  return [poros[0] + dx * c - dy * s, poros[1] + dx * s + dy * c]
}

/** Keempat sudut gambar di posisi terlihatnya, searah jarum jam dari kiri atas. */
export function sudutGambar(g: Gambar): [number, number][] {
  const sudut: [number, number][] = [
    [g.x, g.y],
    [g.x + g.w, g.y],
    [g.x + g.w, g.y + g.h],
    [g.x, g.y + g.h],
  ]
  if (!g.putar) return sudut
  const poros = porosGambar(g)
  return sudut.map((p) => putarTitik(p, poros, g.putar as number))
}

export function kotakGambar(g: Gambar): Kotak {
  if (!g.putar) return { x1: g.x, y1: g.y, x2: g.x + g.w, y2: g.y + g.h }
  const s = sudutGambar(g)
  return {
    x1: Math.min(...s.map((p) => p[0])),
    y1: Math.min(...s.map((p) => p[1])),
    x2: Math.max(...s.map((p) => p[0])),
    y2: Math.max(...s.map((p) => p[1])),
  }
}

export function gambarKena(g: Gambar, x: number, y: number): boolean {
  // Titiknya diputar balik dulu, lalu diuji terhadap persegi yang lurus —
  // jauh lebih sederhana daripada menguji ke persegi yang miring.
  const [px, py] = g.putar
    ? putarTitik([x, y], porosGambar(g), -g.putar)
    : ([x, y] as [number, number])
  return px >= g.x && px <= g.x + g.w && py >= g.y && py <= g.y + g.h
}

/**
 * Cache elemen <img> per data URL.
 *
 * Tanpa ini setiap bingkai membuat Image() baru dan menyandi ulang base64-nya
 * — satu tangkapan layar sudah cukup membuat pan terasa berat.
 */
const cacheGambar = new Map<string, HTMLImageElement>()

export function muatGambar(src: string, saatSiap?: () => void): HTMLImageElement {
  const ada = cacheGambar.get(src)
  if (ada) return ada
  const img = new Image()
  img.onload = () => saatSiap?.()
  img.src = src
  cacheGambar.set(src, img)
  return img
}

export function gambarTempelan(
  ctx: CanvasRenderingContext2D,
  g: Gambar,
  saatSiap?: () => void,
): void {
  const img = muatGambar(g.src, saatSiap)
  if (!img.complete || img.naturalWidth === 0) return
  if (!g.putar) {
    ctx.drawImage(img, g.x, g.y, g.w, g.h)
    return
  }
  const [cx, cy] = porosGambar(g)
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(g.putar)
  ctx.drawImage(img, -g.w / 2, -g.h / 2, g.w, g.h)
  ctx.restore()
}

export interface BerkasKanvas {
  id: string
  title: string
  strokes: Coretan[]
  /** Ditambahkan belakangan; berkas lama tidak punya medan ini. */
  layers?: Lapisan[]
  images?: Gambar[]
  objects?: Objek[]
  texts?: Teks[]
  /** Id ukuran kertas; 'bebas' berarti kanvas tak terbatas. */
  paper?: string
  /** Jumlah halaman dalam mode kertas. Berkas lama selalu berarti satu. */
  pages?: number
  updated_at: number
}

/**
 * Warna yang ikut tema. Disimpan sebagai nama token, bukan hex — coretan lama
 * ikut berubah saat tema diganti, dan tetap terbaca di tema terang maupun gelap.
 */
export const WARNA_CORETAN = ['ink', 'accent', 'accent-2', 'up', 'down'] as const

/**
 * Palet tetap, untuk saat warna tertentu memang yang dimaksud.
 *
 * Disimpan sebagai hex, jadi ia tidak ikut berubah saat tema diganti — itu
 * memang gunanya: garis merah koreksi harus tetap merah di tema apa pun.
 * `warnaToken` meneruskan nilai yang bukan nama token apa adanya, jadi keduanya
 * bisa hidup berdampingan di medan `color` yang sama.
 */
export const PALET_CORETAN: { hex: string; nama: string }[] = [
  { hex: '#1c1c1e', nama: 'Black' },
  { hex: '#8b8d98', nama: 'Grey' },
  { hex: '#e5484d', nama: 'Red' },
  { hex: '#f76b15', nama: 'Orange' },
  { hex: '#f5d90a', nama: 'Yellow' },
  { hex: '#46a758', nama: 'Green' },
  { hex: '#12a594', nama: 'Teal' },
  { hex: '#0090ff', nama: 'Blue' },
  { hex: '#3e63dd', nama: 'Indigo' },
  { hex: '#8e4ec6', nama: 'Purple' },
  { hex: '#e93d82', nama: 'Pink' },
  { hex: '#ad7f58', nama: 'Brown' },
]

/**
 * Ubah nama token jadi warna nyata pada tema yang sedang aktif.
 *
 * Hasilnya disimpan, dan itu bukan penghematan kecil: fungsi ini dipanggil
 * sekali untuk *setiap* goresan di *setiap* bingkai, dan `getComputedStyle`
 * memaksa peramban menghitung ulang gaya tiap kali. Sketsa seribu goresan
 * berarti seribu paksaan per bingkai — cukup untuk membuat pena terasa
 * tertinggal di belakang tangan.
 *
 * Simpanan dibuang saat tema berganti. Tandanya dibaca dari atribut di elemen
 * akar, yang murni pembacaan atribut — jauh lebih murah daripada yang
 * digantikannya.
 */
let tandaTema = ''
const simpananWarna = new Map<string, string>()

export function warnaToken(token: string): string {
  const akar = document.documentElement
  const tanda = `${akar.dataset.theme ?? ''}|${akar.dataset.dim ?? ''}`
  if (tanda !== tandaTema) {
    tandaTema = tanda
    simpananWarna.clear()
  }
  const tersimpan = simpananWarna.get(token)
  if (tersimpan !== undefined) return tersimpan
  const nilai = getComputedStyle(akar).getPropertyValue(`--${token}`).trim() || token
  simpananWarna.set(token, nilai)
  return nilai
}

/** Buang simpanan warna — dipanggil kalau ada yang mengubah token di luar tema. */
export function lupakanWarna(): void {
  tandaTema = ''
  simpananWarna.clear()
}

/**
 * Watak tiap alat tulis.
 *
 * `thinning` menentukan seberapa jauh tekanan mengubah tebalnya, dan itulah
 * yang paling membedakan rasanya di tangan: kuas hampir seluruhnya ditentukan
 * tekanan, stabilo hampir tidak sama sekali.
 */
const OPSI: Record<AlatTulis, Record<string, unknown>> = {
  pen: { thinning: 0.62, smoothing: 0.55, streamline: 0.42, simulatePressure: false },
  // Pensil sedikit lebih kasar dan tidak terlalu dihaluskan — grafit tidak
  // meluncur semulus tinta.
  pensil: { thinning: 0.5, smoothing: 0.34, streamline: 0.28, simulatePressure: false },
  // Kuas: tekanan yang memimpin, dan ujungnya meruncing.
  kuas: { thinning: 0.86, smoothing: 0.62, streamline: 0.5, simulatePressure: true },
  kaligrafi: { thinning: 0.2, smoothing: 0.5, streamline: 0.4, simulatePressure: false },
  spidol: { thinning: 0.1, smoothing: 0.6, streamline: 0.5, simulatePressure: false },
}

/** Kepekatan bawaan tiap alat. */
export const ALPHA_BAWAAN: Record<AlatTulis, number> = {
  pen: 1,
  pensil: 0.82,
  kaligrafi: 1,
  kuas: 0.95,
  spidol: 0.34,
}

export function alphaCoretan(c: Coretan): number {
  return c.alpha ?? ALPHA_BAWAAN[c.tool] ?? 1
}

/** Titik + tekanan → garis luar stroke (menebal saat ditekan). */
export function garisLuar(c: Coretan): number[][] {
  return getStroke(c.points, {
    size: c.size,
    easing: (t: number) => t,
    ...(OPSI[c.tool] ?? OPSI.pen),
    ...(c.steady ? { streamline: 0.82, smoothing: 0.72 } : null),
    last: true,
  })
}

/**
 * Garis luar goresan → jalur yang bisa digambar.
 *
 * Titik-titiknya disambung dengan kurva kuadratik yang melewati titik tengah
 * tiap pasangan, bukan dengan ruas lurus. Bedanya kelihatan jelas begitu
 * di-zoom: menyambung lurus membuat tepi goresan bersegi-segi seperti tangga,
 * karena garis luar dari perfect-freehand hanya berisi beberapa puluh titik —
 * kurva melewatinya dengan mulus tanpa perlu satu titik pun tambahan.
 */
export function jalurDari(titik: number[][]): Path2D {
  const p = new Path2D()
  if (titik.length === 0) return p
  if (titik.length < 3) {
    p.moveTo(titik[0][0], titik[0][1])
    for (let i = 1; i < titik.length; i++) p.lineTo(titik[i][0], titik[i][1])
    p.closePath()
    return p
  }
  p.moveTo((titik[0][0] + titik[1][0]) / 2, (titik[0][1] + titik[1][1]) / 2)
  for (let i = 1; i < titik.length; i++) {
    const a = titik[i]
    const b = titik[(i + 1) % titik.length]
    p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  }
  p.closePath()
  return p
}

/** Versi SVG dari `jalurDari`; keduanya harus menghasilkan bentuk yang sama. */
export function jalurSvg(titik: number[][]): string {
  if (titik.length === 0) return ''
  if (titik.length < 3) {
    const d = titik.map((t, i) => `${i === 0 ? 'M' : 'L'} ${t[0].toFixed(2)} ${t[1].toFixed(2)}`)
    return `${d.join(' ')} Z`
  }
  const n = (x: number) => x.toFixed(2)
  const d = [`M ${n((titik[0][0] + titik[1][0]) / 2)} ${n((titik[0][1] + titik[1][1]) / 2)}`]
  for (let i = 1; i < titik.length; i++) {
    const a = titik[i]
    const b = titik[(i + 1) % titik.length]
    d.push(`Q ${n(a[0])} ${n(a[1])} ${n((a[0] + b[0]) / 2)} ${n((a[1] + b[1]) / 2)}`)
  }
  return `${d.join(' ')} Z`
}

/** Kemiringan ujung pena kaligrafi — 45°, konvensi pena pelat lurus. */
const SUDUT_NIB = -Math.PI / 4

/**
 * Jalur pita ujung miring.
 *
 * Bukan garis luar dari perfect-freehand: pena kaligrafi tidak menebal karena
 * ditekan, melainkan karena arah tarikannya menjauhi arah ujungnya. Tiap ruas
 * jadi satu bidang selebar ujung pena, dan tumpukannya membentuk pita yang
 * menebal-menipis sendiri mengikuti lengkungan tulisan.
 */
export function jalurKaligrafi(c: Coretan): Path2D {
  const p = new Path2D()
  const h = c.size / 2
  const ox = Math.cos(SUDUT_NIB) * h
  const oy = Math.sin(SUDUT_NIB) * h
  for (let i = 1; i < c.points.length; i++) {
    const a = c.points[i - 1]
    const b = c.points[i]
    p.moveTo(a[0] + ox, a[1] + oy)
    p.lineTo(b[0] + ox, b[1] + oy)
    p.lineTo(b[0] - ox, b[1] - oy)
    p.lineTo(a[0] - ox, a[1] - oy)
    p.closePath()
  }
  return p
}

/** Jalur tengah goresan, dipakai pola putus-putus dan titik. */
function jalurTengah(c: Coretan): Path2D {
  const p = new Path2D()
  const t = c.points
  if (t.length === 0) return p
  p.moveTo(t[0][0], t[0][1])
  for (let i = 1; i < t.length; i++) {
    const a = t[i]
    const b = t[i + 1] ?? a
    p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
  }
  return p
}

export function polaDash(c: Coretan): number[] {
  if (c.pola === 'titik') return [0.1, c.size * 2.2]
  if (c.pola === 'putus') return [c.size * 2.6, c.size * 1.9]
  return []
}

/**
 * Butiran pensil.
 *
 * Titik-titik kecil di sepanjang goresan, posisinya diturunkan dari indeks
 * titiknya — bukan dari angka acak sungguhan. Grafit yang letaknya berubah tiap
 * kali layar digambar ulang akan berkedip-kedip saat kanvas digeser.
 */
function butiranPensil(ctx: CanvasRenderingContext2D, c: Coretan): void {
  const t = c.points
  const r = Math.max(0.35, c.size * 0.13)
  const sebar = c.size * 0.7
  ctx.save()
  ctx.fillStyle = warnaToken(c.color)
  ctx.globalAlpha = 0.15
  ctx.beginPath()
  for (let i = 0; i < t.length; i += 4) {
    const a = Math.sin(i * 12.9898 + 4.1) * 43758.5453
    const b = Math.sin(i * 39.3468 + 7.13) * 24634.6345
    const fx = a - Math.floor(a) - 0.5
    const fy = b - Math.floor(b) - 0.5
    ctx.moveTo(t[i][0] + fx * sebar + r, t[i][1] + fy * sebar)
    ctx.arc(t[i][0] + fx * sebar, t[i][1] + fy * sebar, r, 0, Math.PI * 2)
  }
  ctx.fill()
  ctx.restore()
}

export function gambarCoretan(ctx: CanvasRenderingContext2D, c: Coretan): void {
  if (c.points.length === 0) return
  const warna = warnaToken(c.color)

  // Pola putus dan titik digambar sebagai garis, bukan bidang: pola tidak punya
  // arti pada sebuah bidang isi, dan menerapkannya di tepi bidang hanya
  // menghasilkan bentuk yang gerigi.
  if (c.pola && c.pola !== 'utuh') {
    ctx.save()
    ctx.strokeStyle = warna
    ctx.globalAlpha = alphaCoretan(c)
    ctx.lineWidth = c.size
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.setLineDash(polaDash(c))
    ctx.stroke(jalurTengah(c))
    ctx.restore()
    return
  }

  if (c.tool === 'kaligrafi') {
    ctx.save()
    ctx.fillStyle = warna
    ctx.globalAlpha = alphaCoretan(c)
    ctx.fill(jalurKaligrafi(c))
    ctx.restore()
    return
  }

  const luar = garisLuar(c)
  if (luar.length === 0) return
  ctx.save()
  ctx.fillStyle = warna
  ctx.globalAlpha = alphaCoretan(c)
  // Stabilo bertumpuk seperti tinta sungguhan: dua sapuan di tempat yang sama
  // jadi lebih pekat, dan tulisan di bawahnya tetap terbaca.
  if (c.tool === 'spidol') ctx.globalCompositeOperation = 'multiply'
  ctx.fill(jalurDari(luar))
  ctx.restore()
  if (c.tool === 'pensil') butiranPensil(ctx, c)
}

export interface Kotak {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * Kotak pembatas coretan, disimpan per objek goresannya.
 *
 * Menghitungnya berarti menyusuri seluruh titik, dan itu dilakukan berkali-kali
 * untuk goresan yang sama: penghapus mengujinya tiap gerakan, daftar halaman
 * dan pratinjau menghitungnya lagi, begitu pula ekspor. Goresan tidak pernah
 * disunting di tempat — yang berubah selalu jadi objek baru — jadi WeakMap
 * aman dan ikut terbuang sendiri bersama goresannya.
 */
const simpananKotak = new WeakMap<Coretan, Kotak>()

export function kotakCoretan(c: Coretan): Kotak {
  const tersimpan = simpananKotak.get(c)
  if (tersimpan) return tersimpan
  const hasil = hitungKotakCoretan(c)
  simpananKotak.set(c, hasil)
  return hasil
}

function hitungKotakCoretan(c: Coretan): Kotak {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const [x, y] of c.points) {
    if (x < x1) x1 = x
    if (y < y1) y1 = y
    if (x > x2) x2 = x
    if (y > y2) y2 = y
  }
  const pad = c.size
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad }
}

export function kotakSemua(
  coretan: Coretan[],
  gambar: Gambar[] = [],
  objek: Objek[] = [],
  teks: Teks[] = [],
): Kotak | null {
  if (coretan.length === 0 && gambar.length === 0 && objek.length === 0 && teks.length === 0) {
    return null
  }
  const kotak = [
    ...coretan.map(kotakCoretan),
    ...gambar.map(kotakGambar),
    ...objek.map(kotakObjek),
    ...teks.map(kotakTeks),
  ]
  return {
    x1: Math.min(...kotak.map((k) => k.x1)),
    y1: Math.min(...kotak.map((k) => k.y1)),
    x2: Math.max(...kotak.map((k) => k.x2)),
    y2: Math.max(...kotak.map((k) => k.y2)),
  }
}

/** Penghapus bekerja per-coretan: sekali sentuh, satu goresan hilang. */
export function coretanKena(c: Coretan, x: number, y: number, radius: number): boolean {
  const k = kotakCoretan(c)
  if (x < k.x1 - radius || x > k.x2 + radius || y < k.y1 - radius || y > k.y2 + radius) return false
  const r = radius + c.size / 2
  const r2 = r * r
  for (const [px, py] of c.points) {
    if ((px - x) ** 2 + (py - y) ** 2 <= r2) return true
  }
  // Ruas di antara titik juga diuji: goresan cepat, atau goresan yang dikunci
  // ke penggaris, bisa punya titik yang berjauhan — dan sentuhan di antara
  // dua titik tetaplah sentuhan pada goresan itu.
  for (let i = 1; i < c.points.length; i++) {
    const [ax, ay] = c.points[i - 1]
    const [bx, by] = c.points[i]
    const dx = bx - ax
    const dy = by - ay
    const pj = dx * dx + dy * dy
    if (pj === 0) continue
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / pj))
    const qx = ax + t * dx
    const qy = ay + t * dy
    if ((qx - x) ** 2 + (qy - y) ** 2 <= r2) return true
  }
  return false
}

/**
 * Hapus sebagian: buang titik yang tersentuh, sisanya berdiri sebagai potongan.
 *
 * Kanvas ini vektor, jadi "menghapus piksel" sebenarnya berarti memotong
 * goresan jadi beberapa goresan yang lebih pendek. Hasilnya tetap bisa
 * diperbesar tanpa pecah, tetap bisa diekspor jadi SVG, dan tetap bisa dihapus
 * lagi — tidak seperti melubangi gambar, yang begitu dilakukan tidak
 * meninggalkan apa pun untuk disunting.
 */
export function potongCoretan(c: Coretan, x: number, y: number, radius: number): Coretan[] {
  const k = kotakCoretan(c)
  if (x < k.x1 - radius || x > k.x2 + radius || y < k.y1 - radius || y > k.y2 + radius) return [c]

  const r2 = (radius + c.size / 2) ** 2
  const potongan: Coretan[] = []
  let jalan: [number, number, number][] = []
  let adaYangKena = false

  for (const p of c.points) {
    if ((p[0] - x) ** 2 + (p[1] - y) ** 2 <= r2) {
      adaYangKena = true
      if (jalan.length >= 2) potongan.push({ ...c, id: newId('sk'), points: jalan })
      jalan = []
    } else {
      jalan.push(p)
    }
  }
  if (!adaYangKena) return [c]
  if (jalan.length >= 2) potongan.push({ ...c, id: newId('sk'), points: jalan })
  return potongan
}

export function titikDalamPoligon(x: number, y: number, poligon: [number, number][]): boolean {
  let dalam = false
  for (let i = 0, j = poligon.length - 1; i < poligon.length; j = i++) {
    const [xi, yi] = poligon[i]
    const [xj, yj] = poligon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dalam = !dalam
  }
  return dalam
}

export function coretanDalamLaso(c: Coretan, poligon: [number, number][]): boolean {
  return c.points.some(([x, y]) => titikDalamPoligon(x, y, poligon))
}

export function geserCoretan(c: Coretan, dx: number, dy: number): Coretan {
  return { ...c, points: c.points.map(([x, y, p]) => [x + dx, y + dy, p]) }
}

/**
 * Skala seragam terhadap titik jangkar. Tebal garis ikut diskala supaya
 * tulisan yang diperbesar tetap terlihat sama, hanya lebih besar.
 */
export function skalaCoretan(c: Coretan, jangkar: [number, number], s: number): Coretan {
  const [jx, jy] = jangkar
  return {
    ...c,
    size: Math.max(0.5, c.size * s),
    points: c.points.map(([x, y, p]) => [jx + (x - jx) * s, jy + (y - jy) * s, p]),
  }
}

/* ── Ekspor ────────────────────────────────────────────────────────── */

export function keSvg(
  coretan: Coretan[],
  gambar: Gambar[] = [],
  objek: Objek[] = [],
  teks: Teks[] = [],
): string {
  const kotak = kotakSemua(coretan, gambar, objek, teks)
  if (!kotak) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
  const w = Math.ceil(kotak.x2 - kotak.x1)
  const h = Math.ceil(kotak.y2 - kotak.y1)
  // Gambar ditulis lebih dulu supaya coretan mendarat di atasnya, sama seperti
  // di layar: yang ditempel jadi alas, yang digambar jadi anotasi.
  const alas = gambar
    .map(
      (g) =>
        `<image href="${g.src}" x="${g.x.toFixed(2)}" y="${g.y.toFixed(2)}" width="${g.w.toFixed(2)}" height="${g.h.toFixed(2)}" />`,
    )
    .join('\n  ')
  const isi = coretan
    .map((c) => {
      const warna = warnaToken(c.color)
      const alpha = alphaCoretan(c)
      const op = alpha < 1 ? ` opacity="${alpha.toFixed(2)}"` : ''
      if (c.pola && c.pola !== 'utuh') {
        const d = c.points
          .map((t, i) => `${i === 0 ? 'M' : 'L'} ${t[0].toFixed(2)} ${t[1].toFixed(2)}`)
          .join(' ')
        return (
          `<path d="${d}" fill="none" stroke="${warna}" stroke-width="${c.size}"` +
          ` stroke-linecap="round" stroke-dasharray="${polaDash(c).join(' ')}"${op} />`
        )
      }
      if (c.tool === 'kaligrafi') {
        const h = c.size / 2
        const ox = Math.cos(SUDUT_NIB) * h
        const oy = Math.sin(SUDUT_NIB) * h
        const d = c.points
          .slice(1)
          .map((b, i) => {
            const a = c.points[i]
            return (
              `M ${(a[0] + ox).toFixed(2)} ${(a[1] + oy).toFixed(2)}` +
              ` L ${(b[0] + ox).toFixed(2)} ${(b[1] + oy).toFixed(2)}` +
              ` L ${(b[0] - ox).toFixed(2)} ${(b[1] - oy).toFixed(2)}` +
              ` L ${(a[0] - ox).toFixed(2)} ${(a[1] - oy).toFixed(2)} Z`
            )
          })
          .join(' ')
        return `<path d="${d}" fill="${warna}"${op} />`
      }
      return `<path d="${jalurSvg(garisLuar(c))}" fill="${warna}"${op} />`
    })
    .join('\n  ')
  const geometri = objek.map((o) => objekKeSvg(o, warnaToken(o.color))).join('\n  ')
  const tulisan = teks.map((t) => teksKeSvg(t, warnaToken(t.color))).join('\n  ')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${kotak.x1} ${kotak.y1} ${w} ${h}">`,
    alas ? `  ${alas}` : '',
    `  ${isi}`,
    geometri ? `  ${geometri}` : '',
    tulisan ? `  ${tulisan}` : '',
    '</svg>',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function kePng(
  coretan: Coretan[],
  gambar: Gambar[] = [],
  objek: Objek[] = [],
  teks: Teks[] = [],
  skala = 2,
): Promise<Uint8Array | null> {
  const kotak = kotakSemua(coretan, gambar, objek, teks)
  if (!kotak) return null
  const w = Math.ceil((kotak.x2 - kotak.x1) * skala)
  const h = Math.ceil((kotak.y2 - kotak.y1) * skala)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = warnaToken('bg')
  ctx.fillRect(0, 0, w, h)
  ctx.scale(skala, skala)
  ctx.translate(-kotak.x1, -kotak.y1)
  // Gambar tempelan harus benar-benar sudah termuat sebelum digambar; kalau
  // tidak, ekspor menghasilkan lubang kosong di tempat tangkapan layar.
  await Promise.all(
    gambar.map(
      (g) =>
        new Promise<void>((res) => {
          const img = muatGambar(g.src)
          if (img.complete && img.naturalWidth > 0) return res()
          img.addEventListener('load', () => res(), { once: true })
          img.addEventListener('error', () => res(), { once: true })
        }),
    ),
  )
  for (const g of gambar) gambarTempelan(ctx, g)
  for (const s of coretan) gambarCoretan(ctx, s)
  for (const o of objek) gambarObjek(ctx, o, warnaToken(o.color), `${Math.max(13, o.size * 3)}px ui-monospace, monospace`)
  for (const t of teks) gambarTeks(ctx, t)

  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
}

/* ── Teks ──────────────────────────────────────────────────────────── */

/**
 * Tulisan yang diketik, bukan digambar.
 *
 * Disimpan sebagai teks sungguhan, bukan gambar dari teks: judul yang salah
 * ketik masih bisa diperbaiki, dan hasil ekspor SVG-nya masih bisa dicari dan
 * dipilih seperti tulisan biasa.
 */
export interface Teks {
  id: string
  layer: number
  x: number
  y: number
  /** Tinggi huruf dalam satuan dunia. */
  size: number
  /** Nama token tema, sama seperti coretan. */
  color: string
  isi: string
}

export const KELUARGA_HURUF =
  'ui-sans-serif, -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif'

/** Jarak antar baris, kelipatan tinggi huruf. */
export const JARAK_BARIS = 1.32

export function fontTeks(t: Teks): string {
  return `${t.size}px ${KELUARGA_HURUF}`
}

/**
 * Konteks 2D sekali pakai untuk mengukur lebar teks.
 *
 * Kotak pembatas teks dibutuhkan di banyak tempat — laso, penghapus, "muat
 * semua", ekspor — dan tidak semuanya punya konteks gambar di tangan. Satu
 * konteks bersama jauh lebih murah daripada membuat kanvas baru tiap ukur.
 */
let ctxUkur: CanvasRenderingContext2D | null = null
function pengukur(): CanvasRenderingContext2D | null {
  if (ctxUkur) return ctxUkur
  ctxUkur = document.createElement('canvas').getContext('2d')
  return ctxUkur
}

export function kotakTeks(t: Teks): Kotak {
  const baris = t.isi.split('\n')
  const ctx = pengukur()
  let lebar = t.size
  if (ctx) {
    ctx.font = fontTeks(t)
    lebar = Math.max(t.size * 0.6, ...baris.map((b) => ctx.measureText(b).width))
  }
  return {
    x1: t.x,
    y1: t.y,
    x2: t.x + lebar,
    y2: t.y + baris.length * t.size * JARAK_BARIS,
  }
}

export function gambarTeks(ctx: CanvasRenderingContext2D, t: Teks): void {
  if (!t.isi) return
  ctx.save()
  ctx.fillStyle = warnaToken(t.color)
  ctx.font = fontTeks(t)
  ctx.textBaseline = 'top'
  t.isi.split('\n').forEach((b, i) => ctx.fillText(b, t.x, t.y + i * t.size * JARAK_BARIS))
  ctx.restore()
}

export function teksKena(t: Teks, x: number, y: number): boolean {
  const k = kotakTeks(t)
  return x >= k.x1 && x <= k.x2 && y >= k.y1 && y <= k.y2
}

export function geserTeks(t: Teks, dx: number, dy: number): Teks {
  return { ...t, x: t.x + dx, y: t.y + dy }
}

function lolosXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function teksKeSvg(t: Teks, warna: string): string {
  return t.isi
    .split('\n')
    .map(
      (b, i) =>
        `<text x="${t.x.toFixed(2)}" y="${(t.y + i * t.size * JARAK_BARIS + t.size * 0.82).toFixed(2)}" ` +
        `fill="${warna}" font-size="${t.size}" font-family="${KELUARGA_HURUF.replace(/"/g, "'")}">${lolosXml(b)}</text>`,
    )
    .join('\n  ')
}
