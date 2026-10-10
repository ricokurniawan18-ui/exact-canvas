/**
 * Halaman TV: layar pengikut tanpa React.
 *
 * Browser smart TV adalah bagian terlemah dari rantai ini, jadi halaman ini
 * hanya membawa yang perlu: dua <canvas>, satu WebSocket, dan fungsi gambar
 * yang sama persis dengan aplikasi utama — supaya yang tampil di TV adalah
 * goresan yang sama, bukan tiruannya. Ia mengikuti editor yang terakhir aktif:
 * Mac di depan kelas, atau tablet yang dibawa berkeliling.
 */

import { api as apiTanpaBatas, pinTersimpan, namaPerangkat, sesiAktif, simpanPin, simpanSesi } from '@/lib/api'
import { dengarkanLangsung, kirim, mulaiSinkron, useSinkron, type PesanLangsung } from '@/lib/sinkron'
import { bunyi } from '@/lib/kelas'
import { pilihTujuan, tulisBerkas } from '@/lib/berkas'
import { ANGGARAN_PDF, padatkanHalaman } from '@/lib/pdf'
import { JARAK_HALAMAN, kertasDari, kotakHalaman } from '@/modules/canvas/kertas'
import {
  coretanKena,
  gambarCoretan,
  gambarTeks,
  gambarTempelan,
  kotakCoretan,
  kotakGambar,
  kotakSemua,
  muatGambar,
  warnaToken,
  type BerkasKanvas,
  type Coretan,
  type Gambar,
  type Lapisan,
} from '@/modules/canvas/strokes'
import { gambarObjek, type Objek } from '@/modules/canvas/objek'
import {
  buatInstrumen,
  gambarInstrumen,
  kenaInstrumen,
  kuncianDi,
  kunciTitik,
  terapkanSeret,
  type Instrumen,
  type JenisInstrumen,
  type Kuncian,
  type Seretan,
} from '@/modules/canvas/instrumen'
import { AMBANG_DIAM, JEDA_TAHAN, kenaliBentuk } from '@/modules/canvas/bentuk'
import { newId } from '@/lib/id'

/**
 * HP murid sering di Wi-Fi lemah atau tunnel yang goyah. Tanpa batas waktu,
 * satu permintaan yang macet bisa mengunci tombol (mis. "Sending…" tidak
 * pernah kembali) walau permintaan sebelumnya sudah sukses terkirim — jadi
 * semua panggilan di halaman ini punya batas waktu bawaan, bisa ditimpa
 * lewat `timeoutMs` (seperti kirim foto, yang butuh lebih longgar).
 */
function api<T>(path: string, init: { method?: string; body?: BodyInit; json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  return apiTanpaBatas<T>(path, { timeoutMs: 20000, ...init })
}

interface Tampilan {
  skala: number
  x: number
  y: number
}

const dasar = document.getElementById('dasar') as HTMLCanvasElement
const aktif = document.getElementById('aktif') as HTMLCanvasElement
const statusEl = document.getElementById('status') as HTMLDivElement
const pesanEl = document.getElementById('pesan') as HTMLDivElement

const params = new URLSearchParams(location.search)
const paramMode = params.get('mode')
/**
 * Tertanam di halaman latihan Exact Practice (iframe, `?embed=1`): tombol
 * 📝 Practice disembunyikan (kita sudah di dalamnya) dan halaman induk diberi
 * kabar lewat postMessage — siap, dan saat pertanyaannya mulai dibahas —
 * supaya panelnya bisa membesar sendiri tepat ketika guru mulai mencoret.
 */
const tertanam = params.get('embed') === '1'
if (tertanam) document.documentElement.classList.add('embed')
/**
 * `?sesi=<token>`: sesi akun yang diterbitkan Practice atas nama murid (lewat
 * /api/akun/sesi di Mac yang sama), jadi anak tidak perlu masuk lagi di dalam
 * iframe — localStorage iframe lintas-domain di HP terpisah dari tab Canvas
 * biasa. Token langsung dibuang dari alamat supaya tidak ikut tersalin.
 */
{
  const sesiDariTautan = params.get('sesi')
  if (sesiDariTautan) {
    simpanSesi(sesiDariTautan)
    params.delete('sesi')
    const q = params.toString()
    try {
      history.replaceState(null, '', location.pathname + (q ? `?${q}` : ''))
    } catch {
      /* abaikan */
    }
  }
}
function kabariInduk(apa: string, data: Record<string, unknown> = {}): void {
  if (!tertanam || window.parent === window) return
  try {
    window.parent.postMessage({ t: 'exact-canvas', apa, ...data }, '*')
  } catch {
    /* abaikan */
  }
}
/**
 * HP murid atau TV? TV: layar lebar tanpa sentuh, atau `?tv=1`. HP murid masuk
 * dengan nama, punya bilah tanya, dan lampunya diawasi guru.
 */
let sebagaiMurid = tertanam || (params.get('tv') !== '1' && (params.get('murid') === '1' || window.matchMedia('(pointer: coarse)').matches))
/**
 * Laptop atau Mac tanpa petunjuk di tautannya: tanyakan dulu. Perangkat sentuh
 * langsung dianggap murid; tautan dari Settings sudah membawa `tv=1` atau
 * `murid=1` jadi tidak pernah melihat pilihan ini.
 */
const perluPilih = !tertanam && params.get('tv') !== '1' && params.get('murid') !== '1' && !window.matchMedia('(pointer: coarse)').matches
/**
 * Id murid = id akunnya, bukan perangkatnya: ganti HP tetap orang yang sama,
 * kanvas "Tanya · Nama" dan antreannya ikut. Diisi setelah masuk.
 */
// Alamat Exact Practice untuk tombol 📝 Practice. Tiap Mac punya domainnya
// sendiri, jadi ditetapkan saat build: VITE_PRACTICE_URL=https://... npm run app:build
// (bawaan: Mac utama Rico).
const ALAMAT_PRACTICE = (import.meta.env.VITE_PRACTICE_URL as string | undefined) || 'https://practice2.exactprintsolution.com'

let muridId = ''
let namaSaya = ''
/** Apa yang diikuti grup ini: null = kanvas sendiri/grup (bawaan), 'editor:id' | 'sketsa:id'. */
let arah: string | null = null
let tanyaSaya: { id: string; status: string; urutan?: number } | null = null
/**
 * Menjelajah sendiri: murid boleh menggeser dan memperbesar kanvas grupnya
 * dengan jari. Layar kembali mengikuti guru bila murid menekan "Follow the
 * teacher", atau pada coretan guru pertama setelah murid diam 2 menit.
 */
let bebas = false
/** Kapan murid terakhir menggeser/memperbesar layarnya sendiri (ms). */
let terakhirBebasMs = 0
/** Jeda tanpa ikut guru setelah murid terakhir menggeser layar: sesudahnya, coretan guru berikutnya menariknya kembali. */
const JEDA_BEBAS_MS = 2 * 60 * 1000
/** ?mode=fit: selalu satu halaman penuh, apa pun zoom guru. */
const modeMuat = paramMode === 'fit'
/**
 * Layar sempit (HP) mengikuti zoom guru tapi *memenuhi* layarnya: wilayah yang
 * dilihat guru di monitor lebar dipas ke tinggi HP, sisi kiri-kanan yang tidak
 * muat dipotong. Memuat seluruh wilayah itu ke HP tegak hanya menyisakan pita
 * kecil di tengah layar. ?mode=follow memaksa cara TV (muat seluruhnya).
 */
const modePenuh = paramMode !== 'follow' && !modeMuat && window.innerWidth < 700
/**
 * Seberapa penuh layar HP diisi wilayah guru dalam mode "penuh" — 1 berarti
 * pas rapat di tepi (bisa terasa terlalu dekat di HP tegak), lebih kecil
 * menyisakan sedikit ruang di tepi. Guru bisa mengubahnya dari Settings;
 * diambil dari server tiap segarkanSaya, bawaannya 0.88 sebelum sempat dibaca.
 */
let zoomMurid = 0.88

/* ── Keadaan ───────────────────────────────────────────────────────── */

let sketsa: BerkasKanvas | null = null
let idSketsa: string | null = null
let sumber: string | null = null
let namaSumber = ''
/** Pandangan sumber: cukup untuk menurunkan wilayah dunia yang ia lihat. */
let pandanganSumber: { tampilan: Tampilan; layar: { w: number; h: number } } | null = null
let tampilan: Tampilan = { skala: 1, x: 0, y: 0 }
const goresanHidup = new Map<string, Coretan>()
let objekPratinjau: Objek | null = null
let instrumen: Instrumen | null = null
/**
 * Instrumen (penggaris/busur/jangka) milik murid sendiri — terpisah dari
 * `instrumen` milik guru, yang datang lewat siaran dan tidak boleh ia geser.
 * Satu saja pada satu waktu, sama seperti di editor guru.
 */
let instrumenKu: Instrumen | null = null
let seretInstrumenKu: Seretan | null = null
/** Kuncian tepi/lengkung instrumen untuk goresan yang sedang ditarik. */
let kuncianKu: Kuncian | null = null
/** Mode bentuk: coretan kasar dirapikan jadi garis/kotak/bulat saat diangkat. */
let bentukAktif = false
/**
 * Tahan-untuk-bentuk: aktif selalu, seperti di editor guru — tidak perlu
 * menyalakan mode apa pun dulu. Menahan pena diam sebentar di tengah goresan
 * mengunci pratinjau bentuknya; goresan yang dikuncikan ke tepi instrumen
 * dikecualikan, karena kelurusannya sudah dijamin instrumen itu.
 */
let bentukSnapKu: Objek | null = null
let timerTahanKu: number | null = null
let titikDiamKu: { x: number; y: number } | null = null
/** Lebih lama dari ini (ms) bukan ketukan lagi, melainkan jari yang menahan. */
const AMBANG_KETUK_MS = 400
/** Gestur sentuh berjalan: dipakai mengenali ketukan dua jari (undo). */
let gesturKetuk: { mulai: number; maksJari: number; bergeser: boolean } | null = null
let kursor: { x: number; y: number } | null = null
let kotorDasar = true
let kotorAktif = true
/** Siaran 'ubah' untuk sketsa yang sedang dimuat; diterapkan begitu selesai. */
const ubahTertunda = new Map<string, PesanLangsung[]>()
let sedangMemuat: string | null = null
let timerMuat: number | null = null
let timerStatus: number | null = null

function ukuran() {
  return { w: window.innerWidth, h: window.innerHeight }
}

function tampilkanStatus(teks: string, tahan = false) {
  statusEl.textContent = teks
  statusEl.classList.add('tampil')
  if (timerStatus) window.clearTimeout(timerStatus)
  if (!tahan) timerStatus = window.setTimeout(() => statusEl.classList.remove('tampil'), 3500)
}

function tampilkanPesan(html: string | null) {
  pesanEl.innerHTML = html ?? ''
  pesanEl.classList.toggle('tampil', html !== null)
}

/* ── Pandangan ─────────────────────────────────────────────────────── */

/**
 * Turunkan pandangan TV dari pandangan sumber.
 *
 * Mode ikut: wilayah dunia yang terlihat di layar sumber dimuat utuh di TV,
 * apa pun perbandingan layarnya — yang dilihat murid persis yang dilihat guru.
 * Mode muat (?mode=fit): halaman tempat guru bekerja selalu tampil penuh,
 * sementara guru boleh memperbesar sesukanya di monitornya sendiri.
 */
function hitungTampilan() {
  const { w, h } = ukuran()
  if (bebas) return
  if (!pandanganSumber) return
  const s = pandanganSumber
  let x1 = -s.tampilan.x / s.tampilan.skala
  let y1 = -s.tampilan.y / s.tampilan.skala
  let lw = s.layar.w / s.tampilan.skala
  let lh = s.layar.h / s.tampilan.skala

  const kertas = kertasDari(sketsa?.paper)
  if (modeMuat && kertas.w > 0) {
    const tengahY = y1 + lh / 2
    const i = Math.max(0, Math.min((sketsa?.pages ?? 1) - 1, Math.floor(tengahY / (kertas.h + JARAK_HALAMAN))))
    const k = kotakHalaman(kertas, i)
    const tepi = 24
    x1 = k.x1 - tepi
    y1 = k.y1 - tepi
    lw = kertas.w + tepi * 2
    lh = kertas.h + tepi * 2
  }
  const skala = modePenuh && !modeMuat ? Math.max(w / lw, h / lh) * zoomMurid : Math.min(w / lw, h / lh)
  tampilan = {
    skala,
    x: (w - lw * skala) / 2 - x1 * skala,
    y: (h - lh * skala) / 2 - y1 * skala,
  }
  kotorDasar = true
  kotorAktif = true
}

/* ── Gambar ────────────────────────────────────────────────────────── */

function siapkan(el: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const { w, h } = ukuran()
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (el.width !== pw || el.height !== ph) {
    el.width = pw
    el.height = ph
  }
  const ctx = el.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return ctx
}

const tampak = (lapisan: Lapisan[] | undefined, layer: number) => lapisan?.[layer]?.tampak ?? true

function gambarDasar() {
  const ctx = siapkan(dasar)
  if (!ctx) return
  const { w, h } = ukuran()
  ctx.fillStyle = warnaToken('bg')
  ctx.fillRect(0, 0, w, h)
  if (!sketsa) return
  const { skala, x, y } = tampilan
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(skala, skala)

  const kertas = kertasDari(sketsa.paper)
  if (kertas.w > 0) {
    ctx.lineWidth = 1 / skala
    for (let i = 0; i < (sketsa.pages ?? 1); i++) {
      const k = kotakHalaman(kertas, i)
      if (k.y2 * skala + y < -20 || k.y1 * skala + y > h + 20) continue
      ctx.fillStyle = warnaToken('paper')
      ctx.fillRect(k.x1, k.y1, kertas.w, kertas.h)
      ctx.strokeStyle = warnaToken('line-strong')
      ctx.strokeRect(k.x1, k.y1, kertas.w, kertas.h)
    }
  }

  const lapisan = sketsa.layers
  // Hanya yang terlihat di layar yang digambar. Sketsa 40 halaman PDF punya
  // 40 gambar besar; menggambar semuanya tiap perubahan menyedot CPU dan
  // baterai HP untuk piksel yang tidak pernah tampil.
  const x1 = -x / skala
  const y1 = -y / skala
  const x2 = x1 + w / skala
  const y2 = y1 + h / skala
  const terlihat = (k: { x1: number; y1: number; x2: number; y2: number }) => k.x2 >= x1 && k.x1 <= x2 && k.y2 >= y1 && k.y1 <= y2
  for (const g of sketsa.images ?? []) {
    if (!tampak(lapisan, g.layer) || !terlihat(kotakGambar(g))) continue
    gambarTempelan(ctx, g, () => {
      kotorDasar = true
    })
  }
  for (const c of sketsa.strokes) {
    if (!tampak(lapisan, c.layer)) continue
    if (c.points.length > 2 && !terlihat(kotakCoretan(c))) continue
    gambarCoretan(ctx, c)
  }
  const fontLabel = `${Math.max(13, 14 / skala)}px ui-monospace, monospace`
  for (const o of sketsa.objects ?? []) if (tampak(lapisan, o.layer)) gambarObjek(ctx, o, warnaToken(o.color), fontLabel)
  for (const t of sketsa.texts ?? []) if (tampak(lapisan, t.layer)) gambarTeks(ctx, t)
  ctx.restore()
}

function gambarAktif() {
  const ctx = siapkan(aktif)
  if (!ctx) return
  const { skala, x, y } = tampilan
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(skala, skala)
  for (const c of goresanHidup.values()) {
    if (bentukSnapKu && goresanSaya && c.id === goresanSaya.c.id) continue
    if (c.points.length > 1) gambarCoretan(ctx, c)
  }
  if (bentukSnapKu) {
    gambarObjek(ctx, bentukSnapKu, warnaToken(bentukSnapKu.color), `${Math.max(13, 14 / skala)}px ui-monospace, monospace`)
  }
  if (objekPratinjau) {
    gambarObjek(ctx, objekPratinjau, warnaToken(objekPratinjau.color), `${Math.max(13, 14 / skala)}px ui-monospace, monospace`)
  }
  if (instrumen) gambarInstrumen(ctx, instrumen, skala)
  if (instrumenKu) gambarInstrumen(ctx, instrumenKu, skala)
  if (kursor) {
    // Titik pena sebagai penunjuk: murid melihat ke mana guru menunjuk,
    // bukan hanya apa yang sudah ditulis.
    ctx.beginPath()
    ctx.arc(kursor.x, kursor.y, 5 / skala, 0, Math.PI * 2)
    ctx.fillStyle = warnaToken('accent')
    ctx.globalAlpha = 0.85
    ctx.fill()
    ctx.globalAlpha = 0.25
    ctx.beginPath()
    ctx.arc(kursor.x, kursor.y, 14 / skala, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
  ctx.restore()
}

function bingkai() {
  if (kotorDasar) {
    kotorDasar = false
    gambarDasar()
  }
  if (kotorAktif) {
    kotorAktif = false
    gambarAktif()
  }
  requestAnimationFrame(bingkai)
}

/* ── Data ──────────────────────────────────────────────────────────── */

async function muatSketsa(id: string) {
  sedangMemuat = id
  try {
    // Versi ringan: gambar tempelan diganti URL yang di-cache browser, jadi
    // yang lewat Wi-Fi tiap muat ulang hanya goresannya — bukan puluhan MB PDF.
    const teks = await api<string | object>(`/api/canvas/${encodeURIComponent(id)}/ringan`)
    const data = (typeof teks === 'string' ? JSON.parse(teks) : teks) as BerkasKanvas
    sketsa = {
      ...data,
      strokes: data.strokes ?? [],
      images: data.images ?? [],
      objects: data.objects ?? [],
      texts: data.texts ?? [],
    }
    if (idSketsa !== id) bebas = false
    idSketsa = id
    // Goresan hidup yang sudah masuk berkas tidak perlu digambar dua kali.
    const ada = new Set(sketsa.strokes.map((c) => c.id))
    for (const k of Array.from(goresanHidup.keys())) if (ada.has(k)) goresanHidup.delete(k)
    // Gambar tempelan dimuat dulu supaya bingkai pertama tidak bolong.
    for (const g of sketsa.images ?? []) muatGambar(g.src, () => (kotorDasar = true))
    hitungTampilan()
    kotorDasar = true
    kotorAktif = true
    // Siaran yang tiba selagi memuat diterapkan sekarang, urut kedatangan.
    const antre = ubahTertunda.get(id) ?? []
    ubahTertunda.delete(id)
    for (const p of antre) terima(p)
  } catch (e) {
    tampilkanStatus(`Could not load the sketch: ${e instanceof Error ? e.message : String(e)}`, true)
  } finally {
    if (sedangMemuat === id) sedangMemuat = null
  }
}

function jadwalkanMuatUlang() {
  if (timerMuat) window.clearTimeout(timerMuat)
  // Perubahan yang terlihat sudah datang lewat pesan 'ubah'; muat ulang
  // berkas penuh cukup menyusul sedikit lebih santai — pada sketsa 20 MB,
  // memuatnya tiap jeda tulis justru yang membuat TV tersendat.
  timerMuat = window.setTimeout(() => {
    timerMuat = null
    if (idSketsa) void muatSketsa(idSketsa)
  }, 1200)
}

async function sketsaTerbaru(): Promise<string | null> {
  try {
    const r = await api<{ id: string | null }>('/api/kelas/terbaru')
    return r.id ?? null
  } catch {
    return null
  }
}

/** Formulir PIN kecil di layar pesan. */
function mintaPin(salah: boolean): Promise<string> {
  return new Promise((selesai) => {
    tampilkanPesan(
      `${salah ? 'That PIN was not accepted.' : 'Enter the class PIN from the teacher.'}` +
        `<form id="form-pin" style="margin-top:14px;display:flex;gap:8px;justify-content:center">` +
        `<input id="isi-pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" placeholder="PIN" style="font:inherit;font-size:22px;letter-spacing:0.3em;text-align:center;width:150px;padding:8px;border-radius:10px;border:1px solid var(--line-strong)">` +
        `<button type="submit" style="font:inherit;font-size:16px;padding:8px 16px;border-radius:10px;border:0;background:var(--accent);color:#fff">Join</button></form>`,
    )
    pesanEl.style.pointerEvents = 'auto'
    const form = document.getElementById('form-pin') as HTMLFormElement
    const isi = document.getElementById('isi-pin') as HTMLInputElement
    isi.focus()
    form.onsubmit = (e) => {
      e.preventDefault()
      const v = isi.value.replace(/\D/g, '')
      if (v.length < 4) return
      simpanPin(v)
      tampilkanPesan(null)
      selesai(v)
    }
  })
}

/* ── Pesan langsung ────────────────────────────────────────────────── */

/**
 * Bolehkah pesan dari `src` diikuti layar ini?
 *
 * TV mengikuti editor yang sedang aktif, siapa pun itu — tidak ada lagi
 * pembagian ruangan. Grup boleh mengesampingkan lewat `arah`: mengikuti satu
 * editor tertentu, atau tidak mengikuti siapa pun karena dipaku ke satu
 * sketsa. Murid sendiri tidak lewat sini untuk urusan kanvas — mereka selalu
 * dipaku ke `kanvasSaya` (lihat pengecekan idKanvas di `terima`).
 */
/** Editor yang baru saja membuka pertanyaan saya/grup saya: diikuti apa pun kanvasnya. */
let sumberPaksa: string | null = null
/**
 * Kanvas saya (kalau sendiri) atau kanvas grup saya (kalau bergrup). Murid
 * selalu di sini — diisi dari server begitu masuk dan disegarkan berkala,
 * bukan cuma saat guru membuka pertanyaan, supaya murid selalu berada di
 * kanvasnya sendiri kapan pun, tidak pernah melihat kanvas anak lain.
 */
let kanvasSaya: string | null = null
/** Grup belajar saya sekarang, kalau ada — dipakai tombol "Group" di bilah. */
let grupSaya: { id: string; nama: string } | null = null
/** Sedang melihat kanvas grup dari hari lampau (baca saja) — bukan kanvasSaya. */
let melihatRiwayat = false

function bolehIkuti(src: string | undefined): boolean {
  if (!src) return false
  if (src === sumberPaksa) return true
  if (arah?.startsWith('sketsa:')) return false
  if (arah?.startsWith('editor:')) return src === arah.slice(7)
  return true
}

function gantiSumber(p: PesanLangsung) {
  if (p.src && p.src !== sumber) {
    sumber = p.src
    const k = useSinkron.getState().klien.find((x) => x.id === sumber)
    namaSumber = k ? k.nama : 'editor'
    tampilkanStatus(`Following ${namaSumber}`)
    goresanHidup.clear()
    objekPratinjau = null
    instrumen = null
    kursor = null
  }
}

function terima(p: PesanLangsung) {
  if (p.t === 'data') {
    if (p.kanal === 'canvas') jadwalkanMuatUlang()
    if (p.kanal === 'kelas') void segarkanSaya()
    return
  }
  if (p.t === 'bahas') {
    terimaBahas(p.tanya as { murid: string; nama: string; anggota?: string[]; grup?: string | null })
    return
  }
  if (p.t === 'tertinggal') {
    // Sambungan ini sempat tertinggal; yang terlewat sudah tersimpan di server.
    jadwalkanMuatUlang()
    return
  }
  if (p.t === 'izin') {
    if (p.murid === muridId) terapkanIzin(p.boleh === true, (p.sketsa as string | null) ?? null)
    return
  }
  if (p.dariMurid) {
    // Goresan murid berizin di kanvasnya: tampil di semua layar yang sedang
    // membuka kanvas itu, tanpa mengubah siapa yang diikuti.
    if (p.idKanvas !== idSketsa) return
    if (p.t === 'titik' || p.t === 'goresan-selesai' || p.t === 'ubah') terapkanPesan(p)
    return
  }
  if (!bolehIkuti(p.src)) return
  // Guru sedang di kanvas anak lain: layar ini tidak pernah pindah ke sana —
  // murid selalu di kanvasnya sendiri, titik.
  if (kanvasSaya && typeof p.idKanvas === 'string' && p.idKanvas !== kanvasSaya) return
  // Editor yang sedang bekerja diikuti; denyut dari editor yang diam tidak
  // merebut layar. Sumber pertama diambil dari siapa pun yang bersuara.
  const aktifDariPengirim = p.aktif !== false
  if (p.src !== sumber && !(aktifDariPengirim || sumber === null)) return
  // Menghapus dan mengubah bentuk juga aktivitas: guru yang pindah dari tablet
  // ke Mac lalu langsung menghapus harus tetap diikuti.
  if (['pandangan', 'goresan', 'titik', 'instrumen', 'objek', 'ubah'].includes(p.t) && aktifDariPengirim) gantiSumber(p)
  else if (sumber === null) gantiSumber(p)
  if (p.src !== sumber) return

  // Murid yang menggeser/memperbesar layarnya sendiri (bebas) tidak diikutkan ke kamera guru
  // selama JEDA_BEBAS_MS sejak gesernya yang terakhir. Sesudah jeda itu, coretan guru berikutnya
  // menariknya kembali (kembaliIkuti); sebelum itu hanya tombol "Follow the teacher" yang
  // mengembalikannya. Pandangan guru tetap dicatat, jadi layar langsung pindah ke posisi guru sekarang.
  if (bebas && !modeCoret && !izinCoret.boleh && (p.t === 'goresan' || p.t === 'instrumen' || p.t === 'objek') && p.src === sumber
      && Date.now() - terakhirBebasMs >= JEDA_BEBAS_MS) {
    kembaliIkuti()
  }
  // Berizin menulis (mencoret atau baru diizinkan): pandangan guru tidak
  // menggeser layar ini — layarnya penuh miliknya sendiri.
  if ((modeCoret || izinCoret.boleh) && p.t === 'pandangan') return

  terapkanPesan(p)
}

/** Terapkan satu pesan langsung ke keadaan gambar. */
function terapkanPesan(p: PesanLangsung) {
  switch (p.t) {
    case 'pandangan': {
      pandanganSumber = { tampilan: p.tampilan as Tampilan, layar: p.layar as { w: number; h: number } }
      const id = p.idKanvas as string | null
      // Lagi melihat riwayat hari lampau: jangan ditarik balik ke kanvas hari
      // ini hanya karena guru menggeser pandangannya di sana.
      if (melihatRiwayat) break
      if (id && id !== idSketsa) void muatSketsa(id)
      else hitungTampilan()
      break
    }
    case 'goresan': {
      if (p.idKanvas && p.idKanvas !== idSketsa) break
      const c = p.c as Coretan
      goresanHidup.set(c.id, { ...c, points: [...c.points] })
      kotorAktif = true
      break
    }
    case 'titik': {
      if (p.idKanvas && p.idKanvas !== idSketsa) break
      let c = goresanHidup.get(p.id as string)
      if (!c && p.meta) {
        c = { ...(p.meta as Omit<Coretan, 'points'>), points: [] }
        goresanHidup.set(c.id, c)
      }
      if (!c) break
      const titik = p.titik as [number, number, number][]
      const dari = p.dari as number
      c.points.length = Math.min(c.points.length, dari)
      c.points.push(...titik)
      kotorAktif = true
      break
    }
    case 'goresan-selesai': {
      const c = goresanHidup.get(p.id as string)
      if (c && p.batal) goresanHidup.delete(c.id)
      kotorAktif = true
      break
    }
    case 'objek':
      if (p.idKanvas && p.idKanvas !== idSketsa) break
      objekPratinjau = (p.o as Objek | null) ?? null
      kotorAktif = true
      break
    case 'instrumen':
      if (p.idKanvas && p.idKanvas !== idSketsa) break
      instrumen = (p.i as Instrumen | null) ?? null
      kotorAktif = true
      break
    case 'kursor':
      if (p.idKanvas && p.idKanvas !== idSketsa) break
      kursor = typeof p.x === 'number' ? { x: p.x as number, y: p.y as number } : null
      kotorAktif = true
      break
    case 'ubah': {
      // Hapusan dan perubahan diterapkan seketika; berkas penuh menyusul.
      // Siaran untuk sketsa lain: kalau sketsa itu sedang dimuat (guru baru
      // berpindah), tahan dan terapkan sesudahnya; kalau bukan, abaikan.
      const idUbah = p.idKanvas as string | undefined
      if (idUbah && idUbah !== idSketsa) {
        if (idUbah === sedangMemuat) {
          const antre = ubahTertunda.get(idUbah) ?? []
          antre.push(p)
          ubahTertunda.set(idUbah, antre)
        }
        break
      }
      if (!sketsa) break
      const hapus = (p.hapus ?? {}) as { coretan?: string[]; objek?: string[]; teks?: string[]; gambar?: string[] }
      const tambah = (p.tambah ?? {}) as { coretan?: Coretan[]; objek?: Objek[]; gambar?: Gambar[] }
      const hc = new Set(hapus.coretan ?? [])
      const ho = new Set(hapus.objek ?? [])
      const ht = new Set(hapus.teks ?? [])
      const hg = new Set(hapus.gambar ?? [])
      if (hg.size || tambah.gambar?.length) {
        sketsa.images = (sketsa.images ?? []).filter((g) => !hg.has(g.id))
        for (const g of tambah.gambar ?? []) {
          if (!sketsa.images.some((x) => x.id === g.id)) {
            sketsa.images.push(g)
            muatGambar(g.src, () => (kotorDasar = true))
          }
        }
      }
      for (const id of hc) goresanHidup.delete(id)
      const upsert = <T extends { id: string }>(lama: T[], buang: Set<string>, baru: T[]): T[] => {
        const petaBaru = new Map(baru.map((x) => [x.id, x]))
        const hasil = lama.filter((x) => !buang.has(x.id)).map((x) => petaBaru.get(x.id) ?? x)
        const ada = new Set(hasil.map((x) => x.id))
        for (const x of baru) if (!ada.has(x.id)) hasil.push(x)
        return hasil
      }
      sketsa.strokes = upsert(sketsa.strokes, hc, tambah.coretan ?? [])
      sketsa.objects = upsert(sketsa.objects ?? [], ho, tambah.objek ?? [])
      if (ht.size) sketsa.texts = (sketsa.texts ?? []).filter((t) => !ht.has(t.id))
      kotorDasar = true
      kotorAktif = true
      break
    }
  }
}

/* ── Mulai ─────────────────────────────────────────────────────────── */

async function mulai() {
  if (perluPilih) sebagaiMurid = (await layarPilih()) === 'murid'
  let pin = ''
  if (sebagaiMurid) {
    // Murid masuk dengan akun; PIN kelas hanya diketik sekali saat mendaftar
    // dan tidak pernah ada di alamat HP-nya.
    document.documentElement.classList.add('hp')
    await layarAkun()
    await layarMasuk()
    kabariInduk('siap', { murid: muridId, nama: namaSaya })
  } else {
    // TV tidak bisa mengetik: tautannya membawa PIN, atau diminta sekali.
    pin = pinTersimpan() ?? ''
    for (;;) {
      if (!pin) pin = await mintaPin(false)
      try {
        await api('/api/vault')
        break
      } catch {
        pin = await mintaPin(true)
      }
    }
  }

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  mulaiSinkron({
    url: wsUrl,
    pin,
    peran: 'tv',
    nama: sebagaiMurid ? namaSaya : `${namaPerangkat()} (TV)`,
    murid: muridId || undefined,
    sesi: sebagaiMurid ? sesiAktif() : undefined,
  })
  dengarkanLangsung(terima)
  if (sebagaiMurid) {
    pasangBilahMurid()
    pasangGestur()
    pasangCoret()
    pasangLayarPenuh()
    // Ditunggu, bukan dilepas: kanvas sendiri/grup harus sudah terpasang
    // sebelum jatuh ke sketsa terakhir kelas di bawah — kalau tidak, muatan
    // sketsa kelas bisa datang belakangan dan menimpa kanvas anak itu.
    await segarkanSaya()
    window.setInterval(() => void segarkanSaya(), 20_000)
  }

  let serverDikenal: string | null = null
  useSinkron.subscribe((s) => {
    // Aplikasi Mac dibuka ulang: halaman ini memuat ulang supaya selalu
    // menjalankan versi yang sama dengan Mac-nya. TV tidak punya tombol reload
    // yang gampang dijangkau, jadi ia mengurus dirinya sendiri.
    if (s.server) {
      if (serverDikenal && serverDikenal !== s.server) {
        location.reload()
        return
      }
      serverDikenal = s.server
    }
    if (s.serverMati) tampilkanPesan('Sharing was turned off on the Mac.<small>Turn it on again in Settings → Share on this network.</small>')
    else if (s.status === 'menyambung') tampilkanStatus('Reconnecting…', true)
    else if (s.status === 'tersambung') {
      tampilkanPesan(null)
      tampilkanStatus(namaSumber ? `Following ${namaSumber}` : 'Connected — waiting for the teacher')
    }
    if (sumber && (!s.klien.some((k) => k.id === sumber) || !bolehIkuti(sumber))) {
      // Editor yang diikuti pergi atau pindah ruangan; siapa pun yang bergerak
      // berikutnya di ruangan ini yang diikuti.
      sumber = null
      kursor = null
      goresanHidup.clear()
      kotorAktif = true
    }
  })

  // Murid yang sudah punya kanvasnya sendiri tidak perlu sketsa terakhir
  // kelas — itu cuma cadangan supaya layar tidak kosong (TV, atau jaringan
  // sedang putus saat masuk; siklus segarkanSaya berikutnya membetulkannya).
  const awal = sebagaiMurid && kanvasSaya ? null : await sketsaTerbaru()
  if (awal) {
    await muatSketsa(awal)
    // Belum ada sumber: muat satu halaman penuh supaya layar tidak kosong.
    const k = kertasDari(sketsa?.paper)
    const { w, h } = ukuran()
    const lw = k.w > 0 ? k.w + 48 : 1200
    const lh = k.w > 0 ? k.h + 48 : 800
    const skala = Math.min(w / lw, h / lh)
    tampilan = { skala, x: (w - (lw - 48) * skala) / 2, y: 24 * skala }
    kotorDasar = true
  }

  window.addEventListener('resize', () => {
    // Sedang mencoret: zoom yang diatur murid sendiri dipertahankan; kalau
    // tidak, membuka papan ketik atau memutar layar melempar pandangannya.
    if (!modeCoret) hitungTampilan()
    kotorDasar = true
    kotorAktif = true
  })

  // Layar tidak boleh tidur di tengah pelajaran — kecuali murid sengaja
  // memilih mode menunggu, yang melepasnya supaya HP boleh terkunci.
  await mintaWakeLock()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !modeTunggu) void mintaWakeLock()
  })

  requestAnimationFrame(bingkai)
}


/* ── Wake lock ─────────────────────────────────────────────────────── */

type Sentinel = { release: () => Promise<void> }
let sentinel: Sentinel | null = null

async function mintaWakeLock() {
  try {
    const n = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Sentinel> } }
    sentinel = (await n.wakeLock?.request('screen')) ?? null
  } catch {
    /* tidak didukung — pengaturan hemat daya perangkat yang menentukan */
  }
}

async function lepasWakeLock() {
  try {
    await sentinel?.release()
  } catch {
    /* sudah lepas */
  }
  sentinel = null
}

/* ── Murid (HP) ────────────────────────────────────────────────────── */

/**
 * Mode menunggu: layar dihitamkan dan wake lock dilepas, jadi HP boleh
 * meredup atau terkunci sendiri sambil menunggu giliran. Guru melihatnya
 * sebagai lampu biru, bukan merah. Berakhir saat pertanyaannya dibahas,
 * saat status antreannya berubah jadi "dibahas", atau saat layar diketuk.
 */
let modeTunggu = false

const el = (id: string) => document.getElementById(id) as HTMLElement

type Akun = { id: string; nama: string; hp: string; disetujui?: boolean }

/**
 * Akun yang belum diterima guru menunggu di sini, bertanya tiap beberapa
 * detik. Tanpa langkah ini siapa pun yang tahu PIN bisa masuk kelas.
 */
async function tungguPersetujuan(a: Akun): Promise<void> {
  if (a.disetujui) return
  const kotak = el('setuju')
  el('setuju-siapa').textContent = `${a.nama} · ${a.hp}`
  el('setuju-teks').textContent = 'Your account is registered. The teacher needs to accept it in the Class panel before you can join — this screen continues by itself.'
  el('setuju-keluar').onclick = () => void keluarAkun()
  kotak.classList.add('tampil')
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000))
    try {
      const b = await api<Akun>('/api/akun/saya')
      if (b.disetujui) break
    } catch (err) {
      // Ditolak guru: akunnya hilang, mulai lagi dari layar akun.
      if ((err as { status?: number }).status === 401) {
        simpanSesi('')
        kotak.classList.remove('tampil')
        tampilkanStatus('Your registration was not accepted. Ask the teacher.', true)
        await layarAkun()
        return
      }
    }
  }
  kotak.classList.remove('tampil')
  bunyi('bahas')
}

/**
 * Layar akun: masuk dengan nomor HP + sandi, atau daftar (nama, HP, sandi,
 * konfirmasi, kode kelas). Sesi yang masih berlaku melewati layar ini.
 */
async function layarAkun(): Promise<void> {
  if (sesiAktif()) {
    try {
      const a = await api<Akun>('/api/akun/saya')
      muridId = a.id
      namaSaya = a.nama
      await tungguPersetujuan(a)
      return
    } catch {
      simpanSesi('')
    }
  }
  await new Promise<void>((selesai) => {
    const kotak = el('akun')
    const form = el('form-akun') as HTMLFormElement
    const nama = el('akun-nama') as HTMLInputElement
    const hp = el('akun-hp') as HTMLInputElement
    const sandi = el('akun-sandi') as HTMLInputElement
    const ulang = el('akun-ulang') as HTMLInputElement
    const kode = el('akun-kode') as HTMLInputElement
    const galat = el('akun-galat')
    const kirim = el('akun-kirim') as HTMLButtonElement
    const catatan = el('akun-catatan')
    let daftar = false
    const pasangTab = () => {
      el('tab-masuk').classList.toggle('aktif', !daftar)
      el('tab-daftar').classList.toggle('aktif', daftar)
      nama.hidden = !daftar
      ulang.hidden = !daftar
      kode.hidden = !daftar
      nama.required = daftar
      ulang.required = daftar
      kode.required = daftar
      sandi.autocomplete = daftar ? 'new-password' : 'current-password'
      kirim.textContent = daftar ? 'Create account' : 'Sign in'
      catatan.textContent = daftar
        ? 'The class code is the PIN the teacher shows on the board. You only need it once.'
        : 'Your phone number is your username. Forgot the password? Ask the teacher to reset it.'
      galat.textContent = ''
    }
    el('tab-masuk').onclick = () => {
      daftar = false
      pasangTab()
    }
    el('tab-daftar').onclick = () => {
      daftar = true
      pasangTab()
    }
    try {
      hp.value = localStorage.getItem('exact-murid-hp') ?? ''
    } catch {
      /* abaikan */
    }
    pasangTab()
    kotak.classList.add('tampil')
    form.onsubmit = async (e) => {
      e.preventDefault()
      galat.textContent = ''
      if (daftar && sandi.value !== ulang.value) {
        galat.textContent = 'The two passwords are different.'
        return
      }
      kirim.disabled = true
      try {
        const a = daftar
          ? await api<Akun & { token: string }>('/api/akun/daftar', {
              method: 'POST',
              json: { nama: nama.value.trim(), hp: hp.value.trim(), sandi: sandi.value, kode: kode.value.trim() },
            })
          : await api<Akun & { token: string }>('/api/akun/masuk', {
              method: 'POST',
              json: { hp: hp.value.trim(), sandi: sandi.value },
            })
        simpanSesi(a.token)
        muridId = a.id
        namaSaya = a.nama
        try {
          localStorage.setItem('exact-murid-hp', a.hp)
        } catch {
          /* abaikan */
        }
        kotak.classList.remove('tampil')
        await tungguPersetujuan(a)
        selesai()
      } catch (err) {
        galat.textContent = err instanceof Error ? err.message : String(err)
      } finally {
        kirim.disabled = false
      }
    }
  })
}

/** Keluar dari akun di HP ini dan mulai lagi dari layar masuk. */
async function keluarAkun() {
  try {
    await api('/api/akun/keluar', { method: 'POST' })
  } catch {
    /* sesi sudah tidak ada */
  }
  simpanSesi('')
  location.reload()
}

/** Tombol "Room N ▾": anak pindah ruangan tanpa memuat ulang. */
/**
 * Layar "Join the lesson": satu ketukan, tanpa pilihan ruangan lagi. Tetap
 * perlu ketukannya sendiri (bukan cuma lanjut dari layar akun) karena izin
 * audio (bunyi "dibahas") dan layar penuh hanya boleh diminta browser dari
 * ketukan pengguna — termasuk untuk murid lama yang sesinya sudah aktif dan
 * tidak melewati form akun sama sekali.
 */
function layarMasuk(): Promise<void> {
  return new Promise((selesai) => {
    const masuk = el('masuk')
    const form = el('form-masuk') as HTMLFormElement
    el('masuk-siapa').textContent = `Hi, ${namaSaya}`
    el('masuk-keluar').onclick = () => void keluarAkun()
    masuk.classList.add('tampil')
    form.onsubmit = async (e) => {
      e.preventDefault()
      bunyi('diam')
      // Layar penuh tidak lagi diminta otomatis saat masuk (sering bermasalah,
      // dan iPhone tidak mendukungnya); murid memakai tombol ⛶ bila mau.
      try {
        await api('/api/kelas/masuk', { method: 'POST', json: { murid: muridId, nama: namaSaya } })
      } catch (err) {
        tampilkanStatus(`Could not join: ${err instanceof Error ? err.message : String(err)}`, true)
        return
      }
      masuk.classList.remove('tampil')
      selesai()
    }
  })
}

/** Ambil grup/arah dan status pertanyaan sendiri dari server. */
async function segarkanSaya() {
  if (!sebagaiMurid) return
  try {
    const r = await api<{
      grup: { id: string; nama: string; target: string | null } | null
      tanya: { id: string; status: string; urutan?: number } | null
      boleh?: boolean
      sketsa?: string | null
      kanvas?: string | null
      zoom?: number
      duaJariUndo?: boolean
    }>(`/api/kelas/saya?murid=${encodeURIComponent(muridId)}`)
    terapkanIzin(r.boleh === true, r.sketsa ?? null)
    if (typeof r.duaJariUndo === 'boolean') duaJariUndoAktif = r.duaJariUndo
    if (typeof r.zoom === 'number') {
      const baru = Math.max(0.5, Math.min(1, r.zoom / 100))
      if (baru !== zoomMurid) {
        zoomMurid = baru
        hitungTampilan()
      }
    }
    grupSaya = r.grup ? { id: r.grup.id, nama: r.grup.nama } : null
    const arahBaru = r.grup?.target ?? null
    // Kanvas yang harus selalu ditampilkan: kalau grup diarahkan ke satu
    // sketsa tetap pakai itu, kalau tidak pakai kanvas grup/sendiri bawaan —
    // murid tidak pernah tanpa kanvas begitu satu sudah ada untuknya.
    const kanvasBaru = arahBaru?.startsWith('sketsa:') ? arahBaru.slice(7) : (r.kanvas ?? null)
    if (arahBaru !== arah) arah = arahBaru
    if (kanvasBaru !== kanvasSaya) {
      kanvasSaya = kanvasBaru
      // Lagi melihat riwayat: jangan pindahkan layar yang sedang dilihat —
      // kanvasSaya tetap diperbarui di latar, dipakai begitu kembali ke hari ini.
      if (!melihatRiwayat) {
        sumber = null
        goresanHidup.clear()
        kursor = null
        if (kanvasSaya) {
          await muatSketsa(kanvasSaya)
          pandanganSumber = null
          muatSatuHalaman()
        }
        kotorAktif = true
      }
    }
    tanyaSaya = r.tanya
    perbaruiStatusSaya()
    if (modeTunggu) {
      if (tanyaSaya?.status === 'dibahas') void keluarModeTunggu('Your question is being discussed — look at the board', true)
      else el('tunggu-antrean').textContent = tanyaSaya ? `Queue position #${tanyaSaya.urutan ?? '?'}` : 'No question in the queue'
    }
  } catch {
    /* jaringan sedang putus — coba lagi di siklus berikutnya */
  }
}

/** Sketsa yang dipaku: tampilkan halaman pertama penuh. */
function muatSatuHalaman() {
  const k = kertasDari(sketsa?.paper)
  const { w, h } = ukuran()
  const lw = k.w > 0 ? k.w + 48 : 1200
  const lh = k.w > 0 ? k.h + 48 : 800
  const skala = Math.min(w / lw, h / lh)
  tampilan = { skala, x: (w - (lw - 48) * skala) / 2, y: 24 * skala }
  kotorDasar = true
  kotorAktif = true
}

function perbaruiStatusSaya() {
  const st = el('status-saya')
  const paham = el('tombol-paham') as HTMLButtonElement
  if (!tanyaSaya) {
    st.innerHTML = ''
    paham.disabled = true
    return
  }
  paham.disabled = false
  st.innerHTML =
    tanyaSaya.status === 'dibahas'
      ? '<b>Your question is being discussed</b> — look at the board'
      : `Waiting · <b>#${tanyaSaya.urutan ?? '?'}</b> in the queue`
}

/** Paling banyak sekian foto sekaligus — sejalan dengan batas di server. */
const MAKS_FOTO = 8

let fotoDataList: string[] = []
let pdfData = ''

function pasangBilahMurid() {
  el('bilah').classList.add('tampil')
  const lembar = el('lembar')
  const teks = el('teks-tanya') as HTMLTextAreaElement
  const pratinjau = el('pratinjau-foto') as HTMLDivElement
  const pratinjauPdf = el('pratinjau-pdf')
  const berkasKamera = el('berkas-foto') as HTMLInputElement
  const berkasGaleri = el('berkas-galeri') as HTMLInputElement
  const berkasPdf = el('berkas-pdf') as HTMLInputElement

  // Galeri gambar dari foto yang sudah dipilih, masing-masing bisa dilepas
  // satu-satu sebelum dikirim.
  function gambarUlangPratinjau() {
    pratinjau.innerHTML = ''
    fotoDataList.forEach((src, i) => {
      const item = document.createElement('div')
      item.className = 'foto-item'
      const img = document.createElement('img')
      img.src = src
      img.alt = ''
      const hapus = document.createElement('button')
      hapus.textContent = '×'
      hapus.type = 'button'
      hapus.setAttribute('aria-label', 'Remove this photo')
      hapus.onclick = () => {
        fotoDataList.splice(i, 1)
        gambarUlangPratinjau()
      }
      item.append(img, hapus)
      pratinjau.append(item)
    })
    pratinjau.hidden = fotoDataList.length === 0
  }

  el('tombol-tangan').onclick = () => void kirimTanya('', [])
  el('tombol-tanya').onclick = () => {
    teks.value = ''
    fotoDataList = []
    pdfData = ''
    gambarUlangPratinjau()
    pratinjauPdf.hidden = true
    lembar.classList.add('tampil')
  }
  el('tombol-batal').onclick = () => lembar.classList.remove('tampil')

  // Dipakai oleh kamera (satu foto) dan galeri (boleh banyak) — sama-sama
  // berakhir di antrean foto yang sama, siap dikirim bareng.
  async function tambahFoto(berkasTerpilih: File[]) {
    if (!berkasTerpilih.length) return
    const sisaSlot = MAKS_FOTO - fotoDataList.length
    if (sisaSlot <= 0) {
      tampilkanStatus(`You can attach up to ${MAKS_FOTO} photos.`, true)
      return
    }
    const dipakai = berkasTerpilih.slice(0, sisaSlot)
    let gagal = 0
    for (const f of dipakai) {
      try {
        fotoDataList.push((await perkecilFoto(f)).src)
      } catch {
        gagal++
      }
    }
    if (berkasTerpilih.length > dipakai.length) tampilkanStatus(`Only added ${dipakai.length} — max ${MAKS_FOTO} photos.`, true)
    else if (gagal) tampilkanStatus(gagal === dipakai.length ? 'Could not read those photos — try again.' : `Could not read ${gagal} of the photos.`, true)
    pdfData = ''
    pratinjauPdf.hidden = true
    gambarUlangPratinjau()
  }

  // Kamera: "capture" di HTML membuka kamera langsung, satu foto tiap ketuk —
  // bisa diketuk berkali-kali untuk menambah lebih dari satu.
  el('tombol-foto').onclick = () => berkasKamera.click()
  berkasKamera.onchange = async () => {
    const f = berkasKamera.files?.[0]
    berkasKamera.value = ''
    if (f) await tambahFoto([f])
  }
  // Galeri: tanpa "capture", dengan "multiple" — pilih beberapa foto sekaligus.
  el('tombol-galeri').onclick = () => berkasGaleri.click()
  berkasGaleri.onchange = async () => {
    const berkasTerpilih = Array.from(berkasGaleri.files ?? [])
    berkasGaleri.value = ''
    await tambahFoto(berkasTerpilih)
  }
  // PDF dikirim apa adanya (maks 40 MB); guru membukanya halaman per halaman
  // di kanvas khusus anak ini. Satu PDF saja per pertanyaan — memilihnya
  // mengganti foto-foto yang sudah dipilih, bukan menambah.
  el('tombol-pdf').onclick = () => berkasPdf.click()
  berkasPdf.onchange = async () => {
    const f = berkasPdf.files?.[0]
    berkasPdf.value = ''
    if (!f) return
    if (f.size > 40 * 1024 * 1024) {
      tampilkanStatus('That PDF is over 40 MB — too big to send.', true)
      return
    }
    const dibaca = await new Promise<string>((res) => {
      const fr = new FileReader()
      fr.onload = () => res(String(fr.result))
      fr.onerror = () => res('')
      fr.readAsDataURL(f)
    })
    if (!dibaca) {
      tampilkanStatus('Could not read that PDF — try again.', true)
      return
    }
    pdfData = dibaca
    fotoDataList = []
    gambarUlangPratinjau()
    pratinjauPdf.textContent = `📄 ${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB`
    pratinjauPdf.hidden = false
  }
  const tombolKirim = el('tombol-kirim') as HTMLButtonElement
  const labelKirim = tombolKirim.textContent
  tombolKirim.onclick = () => {
    // Lembar (dan foto-fotonya) tetap terbuka kalau gagal — supaya murid
    // tidak perlu memfoto ulang hanya karena Wi-Fi/tunnel sempat tersendat.
    tombolKirim.disabled = true
    tombolKirim.textContent = 'Sending…'
    const lampiran = pdfData ? [pdfData] : fotoDataList
    void kirimTanya(teks.value, lampiran).then((ok) => {
      tombolKirim.disabled = false
      tombolKirim.textContent = labelKirim
      if (ok) lembar.classList.remove('tampil')
    })
  }
  el('tombol-tunggu').onclick = () => void masukModeTunggu()
  el('tunggu').onclick = () => void keluarModeTunggu('Back on the board.')
  // Izin notifikasi diminta di sini, saat masih ada ketukan pengguna di sesi ini.
  try {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
  } catch {
    /* abaikan */
  }
  el('tombol-paham').onclick = () => {
    if (!tanyaSaya) return
    void api('/api/kelas/paham', { method: 'POST', json: { murid: muridId } })
      .then(() => {
        tanyaSaya = null
        el('ikuti').hidden = true
        perbaruiStatusSaya()
        tampilkanStatus('Marked as understood.')
        // Kembali ke kanvas sendiri/grup — bukan dilepas ke ruangan, karena
        // sudah tidak ada lagi konsep ruangan.
        void segarkanSaya()
      })
      .catch(() => tampilkanStatus('Could not send that.', true))
  }

  // Lampu pengawasan: halaman disembunyikan (pindah aplikasi, layar dikunci)
  // atau kehilangan fokus dilaporkan ke guru. Hanya sinyal, bukan kunci.
  const lapor = () => kirim({ t: 'fokus', aktif: document.visibilityState === 'visible' && document.hasFocus(), tunggu: modeTunggu })
  document.addEventListener('visibilitychange', lapor)
  window.addEventListener('blur', lapor)
  window.addEventListener('focus', lapor)

  pasangGrup()
  el('tombol-ekspor').onclick = () => void eksporPdfSaya()
  /* Exact Practice menumpang akun Canvas: token sesi ini ditukar jadi sesi
   * Practice di sana, jadi murid tidak perlu masuk dua kali. */
  el('tombol-latihan').onclick = () => {
    const sesi = sesiAktif()
    const tujuan = sesi ? `${ALAMAT_PRACTICE}/api/auth/canvas?sesi=${encodeURIComponent(sesi)}` : ALAMAT_PRACTICE
    window.open(tujuan, '_blank', 'noopener')
  }
}

/**
 * Grup belajar mandiri: murid boleh membuat grupnya sendiri atau bergabung
 * ke grup yang sudah ada, tanpa lewat guru. Satu murid satu grup — masuk ke
 * grup baru otomatis keluar dari yang lama (sama seperti kalau guru yang atur).
 */
function pasangGrup() {
  const kotak = el('grup')
  const sekarangDiv = el('grup-sekarang')
  const sekarangTeks = el('grup-sekarang-teks')
  const buatDiv = el('grup-buat')
  const namaInput = el('grup-nama') as HTMLInputElement
  const daftarDiv = el('grup-daftar')
  const riwayatDiv = el('grup-riwayat')
  const riwayatDaftarDiv = el('grup-riwayat-daftar')

  // Dipanggil baik untuk murid bergrup maupun sendiri — endpoint-nya sendiri
  // yang memilih riwayat grup atau riwayat pribadi (lihat api_grup_riwayat).
  async function muatRiwayat() {
    try {
      const daftar = await api<{ id: string; judul: string; diubah: number }[]>(
        `/api/kelas/grup/riwayat?murid=${encodeURIComponent(muridId)}`,
      )
      // Hari ini (kanvasSaya) sudah kelihatan di papan biasa; di sini cuma hari lampau.
      const lampau = daftar.filter((d) => d.id !== kanvasSaya)
      riwayatDaftarDiv.replaceChildren()
      riwayatDiv.hidden = lampau.length === 0
      for (const d of lampau) {
        const baris = document.createElement('div')
        baris.className = 'grup-baris'
        const judul = document.createElement('span')
        judul.className = 'nama'
        judul.textContent = d.judul
        const tombol = document.createElement('button')
        tombol.textContent = 'View'
        tombol.onclick = () => void lihatRiwayat(d.id)
        baris.append(judul, tombol)
        riwayatDaftarDiv.append(baris)
      }
    } catch {
      riwayatDiv.hidden = true
    }
  }

  async function render() {
    if (grupSaya) {
      sekarangDiv.hidden = false
      sekarangTeks.textContent = `You're in "${grupSaya.nama}".`
      buatDiv.hidden = true
      daftarDiv.hidden = true
      daftarDiv.replaceChildren()
      await muatRiwayat()
      return
    }
    sekarangDiv.hidden = true
    buatDiv.hidden = false
    await muatRiwayat()
    try {
      const daftar = await api<{ id: string; nama: string; warna: string | null; anggota: number }[]>('/api/kelas/grup/daftar')
      daftarDiv.replaceChildren()
      daftarDiv.hidden = daftar.length === 0
      for (const g of daftar) {
        const baris = document.createElement('div')
        baris.className = 'grup-baris'
        const titik = document.createElement('span')
        titik.className = 'titik'
        titik.style.background = g.warna ?? '#b4531a'
        const nama = document.createElement('span')
        nama.className = 'nama'
        nama.textContent = g.nama
        const jumlah = document.createElement('span')
        jumlah.className = 'jumlah'
        jumlah.textContent = `${g.anggota} ${g.anggota === 1 ? 'student' : 'students'}`
        const tombol = document.createElement('button')
        tombol.textContent = 'Join'
        tombol.onclick = () => void gabung(g.id, g.nama)
        baris.append(titik, nama, jumlah, tombol)
        daftarDiv.append(baris)
      }
    } catch {
      daftarDiv.hidden = true
    }
  }

  async function gabung(id: string, nama: string) {
    try {
      await api('/api/kelas/grup/gabung', { method: 'POST', json: { murid: muridId, grup: id } })
      grupSaya = { id, nama }
      tampilkanStatus(`Joined "${nama}".`)
      await render()
      void segarkanSaya()
    } catch (err) {
      tampilkanStatus(`Could not join: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }

  /** Buka satu kanvas grup dari hari lampau — baca saja, coret dimatikan. */
  async function lihatRiwayat(id: string) {
    melihatRiwayat = true
    kotak.classList.remove('tampil')
    el('tombol-coret').hidden = true
    sumber = null
    goresanHidup.clear()
    kursor = null
    await muatSketsa(id)
    pandanganSumber = null
    muatSatuHalaman()
    el('kembali-riwayat').hidden = false
    tampilkanStatus('Viewing a past day — read-only.')
  }

  el('kembali-riwayat').onclick = () => {
    void (async () => {
      melihatRiwayat = false
      el('kembali-riwayat').hidden = true
      if (izinCoret.boleh && izinCoret.sketsa === kanvasSaya) el('tombol-coret').hidden = false
      if (kanvasSaya) {
        await muatSketsa(kanvasSaya)
        pandanganSumber = null
        muatSatuHalaman()
      }
      tampilkanStatus('Back to today.')
    })()
  }

  el('tombol-grup').onclick = () => {
    kotak.classList.add('tampil')
    void render()
  }
  el('grup-tutup').onclick = () => kotak.classList.remove('tampil')
  el('grup-keluar').onclick = () => {
    void api('/api/kelas/grup/keluar', { method: 'POST', json: { murid: muridId } })
      .then(async () => {
        grupSaya = null
        tampilkanStatus('Left the group.')
        await render()
        void segarkanSaya()
      })
      .catch((err) => tampilkanStatus(`Could not leave: ${err instanceof Error ? err.message : String(err)}`, true))
  }
  el('grup-buat-kirim').onclick = () => {
    const nama = namaInput.value.trim()
    if (!nama) return
    void api<{ id: string; nama: string }>('/api/kelas/grup/buat', { method: 'POST', json: { murid: muridId, nama } })
      .then(async (r) => {
        grupSaya = { id: r.id, nama: r.nama }
        namaInput.value = ''
        tampilkanStatus(`Created "${r.nama}".`)
        await render()
        void segarkanSaya()
      })
      .catch((err) => tampilkanStatus(`Could not create: ${err instanceof Error ? err.message : String(err)}`, true))
  }
}

/* ── Ekspor PDF (murid) ───────────────────────────────────────────── */

/** Piksel dunia (96 dpi) → milimeter — sama seperti di app guru. */
const keMm = (px: number) => (px / 96) * 25.4

/** Rekam satu wilayah dunia ke kanvas lepas, sama seperti di app guru. */
async function rekamWilayahSaya(x1: number, y1: number, lebar: number, tinggi: number, skala: number): Promise<HTMLCanvasElement | null> {
  if (!sketsa) return null
  const s = sketsa
  const c = document.createElement('canvas')
  c.width = Math.round(lebar * skala)
  c.height = Math.round(tinggi * skala)
  const ctx = c.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.scale(skala, skala)
  ctx.translate(-x1, -y1)
  const lapisan = s.layers
  const dipakai = (s.images ?? []).filter((g) => tampak(lapisan, g.layer))
  await Promise.all(
    dipakai.map(
      (g) =>
        new Promise<void>((res) => {
          const img = muatGambar(g.src)
          if (img.complete && img.naturalWidth > 0) return res()
          img.addEventListener('load', () => res(), { once: true })
          img.addEventListener('error', () => res(), { once: true })
        }),
    ),
  )
  for (const g of dipakai) gambarTempelan(ctx, g)
  for (const k of s.strokes.filter((k) => tampak(lapisan, k.layer))) gambarCoretan(ctx, k)
  const fontLabel = '13px ui-monospace, monospace'
  for (const o of (s.objects ?? []).filter((o) => tampak(lapisan, o.layer))) gambarObjek(ctx, o, warnaToken(o.color), fontLabel)
  for (const t of (s.texts ?? []).filter((t) => tampak(lapisan, t.layer))) gambarTeks(ctx, t)
  return c
}

/** Ekspor kanvas saya (atau grup saya) jadi satu PDF, dibagikan lewat browser. */
async function eksporPdfSaya() {
  if (!sketsa) {
    tampilkanStatus('Nothing to export yet.', true)
    return
  }
  const kertas = kertasDari(sketsa.paper)
  const wilayah =
    kertas.w > 0
      ? Array.from({ length: Math.max(1, sketsa.pages ?? 1) }, (_, i) => {
          const k = kotakHalaman(kertas, i)
          return { x: k.x1, y: k.y1, w: kertas.w, h: kertas.h }
        })
      : (() => {
          const k = kotakSemua(sketsa!.strokes, sketsa!.images ?? [], sketsa!.objects ?? [], sketsa!.texts ?? [])
          if (!k) return null
          const margin = 24
          return [{ x: k.x1 - margin, y: k.y1 - margin, w: k.x2 - k.x1 + margin * 2, h: k.y2 - k.y1 + margin * 2 }]
        })()
  if (!wilayah) {
    tampilkanStatus('Nothing on the canvas yet.', true)
    return
  }
  tampilkanStatus('Preparing PDF…')
  try {
    const { jsPDF } = await import('jspdf')
    const mmW = kertas.mmW || keMm(wilayah[0].w)
    const mmH = kertas.mmH || keMm(wilayah[0].h)
    const arah = mmW > mmH ? 'landscape' : 'portrait'
    const pdf = new jsPDF({ unit: 'mm', format: [mmW, mmH], orientation: arah, compress: true })
    const jatah = (ANGGARAN_PDF * 0.92) / wilayah.length
    const skala = wilayah.length <= 4 ? 3 : wilayah.length <= 16 ? 2.5 : 2
    let terlampaui = false
    for (const [i, w] of wilayah.entries()) {
      const c = await rekamWilayahSaya(w.x, w.y, w.w, w.h, skala)
      if (!c) return
      const padat = padatkanHalaman(c, jatah)
      if (padat.byte > jatah) terlampaui = true
      if (i > 0) pdf.addPage([mmW, mmH], arah)
      pdf.addImage(padat.data, padat.rupa, 0, 0, mmW, mmH)
    }
    const bytes = new Uint8Array(pdf.output('arraybuffer'))
    const nama = `${sketsa.title || 'Sketch'}.pdf`
    const tujuan = await pilihTujuan(nama, 'pdf')
    if (!tujuan) return
    await tulisBerkas(tujuan, bytes, 'application/pdf', nama, { buka: true })
    const mb = (bytes.length / 1024 / 1024).toFixed(1)
    tampilkanStatus(terlampaui ? `Exported — ${mb} MB (some detail was reduced to fit).` : `Exported — ${mb} MB.`)
  } catch (e) {
    tampilkanStatus(e instanceof Error ? e.message : 'Could not export the PDF.', true)
  }
}

let timerKunci: number | null = null

/** Kunci tombol tanya selama `detik`, dengan hitung mundur di tombolnya. */
function kunciTombol(detik: number) {
  const tombol = [el('tombol-tangan'), el('tombol-tanya')] as HTMLButtonElement[]
  const label = ['✋ Raise hand', '❓ Ask']
  let sisa = detik
  if (timerKunci) window.clearInterval(timerKunci)
  const tik = () => {
    tombol.forEach((b, i) => {
      b.disabled = sisa > 0
      b.textContent = sisa > 0 ? `${label[i]} · ${sisa}s` : label[i]
    })
    if (sisa <= 0 && timerKunci) {
      window.clearInterval(timerKunci)
      timerKunci = null
    }
    sisa--
  }
  tik()
  timerKunci = window.setInterval(tik, 1000)
}

async function kirimTanya(teks: string, fotos: string[]): Promise<boolean> {
  try {
    // Foto-foto bisa beberapa ratus KB sampai beberapa MB total; lewat
    // Wi-Fi/tunnel yang lemah butuh waktu — 45 s cukup longgar tapi tetap
    // memberi kabar alih-alih menggantung diam.
    await api('/api/kelas/tanya', { method: 'POST', json: { murid: muridId, nama: namaSaya, teks, fotos }, timeoutMs: 45000 })
    tampilkanStatus(
      fotos[0]?.startsWith('data:application/pdf')
        ? 'PDF sent.'
        : fotos.length > 1
          ? `${fotos.length} photos sent.`
          : fotos.length === 1 || teks
            ? 'Question sent.'
            : 'Hand raised.',
    )
    kunciTombol(20)
    await segarkanSaya()
    return true
  } catch (e) {
    // Pesan server berkode: TUNGGU:<detik>:<pesan> | ANTRE:<pesan> | MUTED:<pesan>
    const mentah = e instanceof Error ? e.message : String(e)
    const m = mentah.match(/^TUNGGU:(\d+):(.*)$/)
    if (m) {
      kunciTombol(Number(m[1]))
      tampilkanStatus(m[2], true)
    } else if (mentah.startsWith('ANTRE:') || mentah.startsWith('MUTED:')) {
      tampilkanStatus(mentah.replace(/^[A-Z]+:/, ''), true)
      if (mentah.startsWith('MUTED:')) kunciTombol(60)
    } else {
      tampilkanStatus(`Could not send: ${mentah}`, true)
    }
    await segarkanSaya()
    return false
  }
}

/** Muat gambar lewat <img>+object URL — cadangan untuk WebView yang menolak createImageBitmap pada berkas tertentu (mis. HEIC di beberapa Android). */
function muatGambarCadangan(f: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(f)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      res(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      rej(new Error('Unreadable image'))
    }
    img.src = url
  })
}

/**
 * Foto dari kamera HP berukuran 3–8 MB; yang dibutuhkan guru cukup 1280 px.
 * Diperkecil di HP sebelum diunggah supaya Wi-Fi dan vault tetap ringan.
 * Melempar galat (bukan diam-diam gagal) kalau berkasnya tidak terbaca —
 * pemanggilnya wajib memberi tahu murid, bukan mengirim "hand raised" kosong.
 */
async function perkecilFoto(f: File): Promise<{ src: string; w: number; h: number }> {
  let sumber: CanvasImageSource
  let w: number
  let h: number
  const bitmap = await createImageBitmap(f).catch(() => null)
  if (bitmap) {
    sumber = bitmap
    w = bitmap.width
    h = bitmap.height
  } else {
    const img = await muatGambarCadangan(f)
    sumber = img
    w = img.naturalWidth
    h = img.naturalHeight
  }
  if (!w || !h) throw new Error('Unreadable image')
  const skala = Math.min(1, 1280 / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.round(w * skala)
  c.height = Math.round(h * skala)
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable')
  // Kanvas kosong itu transparan; JPEG tidak punya alpha, jadi tanpa latar
  // putih di sini, foto dengan transparansi (mis. screenshot PNG dari galeri)
  // akan keluar hitam di bagian yang tadinya transparan.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(sumber, 0, 0, c.width, c.height)
  const url = c.toDataURL('image/jpeg', 0.72)
  if (!url || url === 'data:,') throw new Error('Could not encode photo')
  return { src: url, w: c.width, h: c.height }
}

let timerKabar: number | null = null

function terimaBahas(t: { murid: string; nama: string; anggota?: string[]; grup?: string | null; editor?: string | null }) {
  if (!sebagaiMurid) return
  const punyaku = t.murid === muridId
  const segrup = !punyaku && (t.anggota ?? []).includes(muridId)
  if (!punyaku && !segrup) return
  kabariInduk('bahas', { punyaku, nama: t.nama })
  // Langsung ikuti perangkat guru yang membahas — tidak menunggu ia bergerak.
  bebas = false
  kanvasSaya = (t as { sketsa?: string | null }).sketsa ?? null
  el('ikuti').hidden = true
  const teksKabar = punyaku
    ? 'Your question is being discussed — look at the board'
    : `${t.nama}'s question is being discussed${t.grup ? ` (${t.grup})` : ''} — look at the board`
  if (modeTunggu) void keluarModeTunggu(teksKabar, true)
  // Halaman di latar belakang (HP terkunci tapi masih hidup): notifikasi sistem.
  try {
    if (document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Exact Canvas', { body: teksKabar, tag: 'bahas' })
    }
  } catch {
    /* abaikan */
  }
  if (t.editor) {
    sumberPaksa = t.editor
    if (sumber !== t.editor) {
      sumber = t.editor
      goresanHidup.clear()
      kursor = null
      kotorAktif = true
    }
    window.setTimeout(() => {
      if (sumberPaksa === t.editor) sumberPaksa = null
    }, 15 * 60_000)
  }
  bunyi('bahas')
  try {
    navigator.vibrate?.([120, 60, 120])
  } catch {
    /* tidak didukung */
  }
  const kabar = el('kabar')
  kabar.textContent = punyaku
    ? 'Your question is being discussed — look at the board'
    : `${t.nama}'s question is being discussed${t.grup ? ` (${t.grup})` : ''} — look at the board`
  kabar.classList.add('tampil')
  if (timerKabar) window.clearTimeout(timerKabar)
  timerKabar = window.setTimeout(() => kabar.classList.remove('tampil'), 6000)
  if (punyaku) void segarkanSaya()
  if (kanvasSaya && kanvasSaya !== idSketsa) void muatSketsa(kanvasSaya)
}

/* ── Menjelajah sendiri (HP) ───────────────────────────────────────── */

function kembaliIkuti() {
  bebas = false
  el('ikuti').hidden = true
  hitungTampilan()
  kotorDasar = true
  kotorAktif = true
}

/** Satu jari menggeser, dua jari mencubit; roda mouse untuk pengujian di desktop. */
function pasangGestur() {
  const jari = new Map<number, { x: number; y: number }>()
  let geser: { x: number; y: number; tx: number; ty: number } | null = null
  let cubit: { jarak: number; tengah: { x: number; y: number }; awal: Tampilan } | null = null
  const tombol = el('ikuti')
  tombol.onclick = kembaliIkuti

  const mulaiBebas = () => {
    terakhirBebasMs = Date.now()
    if (!bebas) {
      bebas = true
      tombol.hidden = false
    }
  }
  const susun = () => {
    const daftar = Array.from(jari.values())
    if (daftar.length >= 2) {
      const [a, b] = daftar
      cubit = { jarak: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), tengah: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, awal: { ...tampilan } }
      geser = null
    } else if (daftar.length === 1) {
      geser = { x: daftar[0].x, y: daftar[0].y, tx: tampilan.x, ty: tampilan.y }
      cubit = null
    } else {
      geser = null
      cubit = null
    }
  }
  aktif.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    aktif.setPointerCapture(e.pointerId)
    // Ketukan dua jari = undo (konvensi Procreate). Dicatat di sini, diputuskan
    // saat jari terakhir diangkat: yang turun-diam-naik cepat adalah ketukan,
    // yang bergeser adalah cubit/geser biasa.
    if (jari.size === 0 && !goresanSaya && !hapusanSaya) {
      gesturKetuk = { mulai: performance.now(), maksJari: 1, bergeser: false }
    } else if (gesturKetuk) {
      gesturKetuk.maksJari = Math.max(gesturKetuk.maksJari, jari.size + 1)
    }
    // Pegangan instrumen didahulukan: menyeretnya bukan menggambar.
    if (modeCoret && instrumenKu && jari.size === 0 && !goresanSaya && !hapusanSaya) {
      const p = keDunia(e.clientX, e.clientY)
      const mode = kenaInstrumen(instrumenKu, p, tampilan.skala)
      if (mode) {
        seretInstrumenKu = { mode, awal: p, asal: instrumenKu }
        gesturKetuk = null
        return
      }
    }
    // Mode coret: satu jari/pena menggambar; jari kedua membatalkan goresan
    // itu dan mengambil alih sebagai cubit/geser.
    if (modeCoret && jari.size === 0 && !goresanSaya && !hapusanSaya) {
      if (alatCoret === 'hapus') mulaiHapus(e)
      else mulaiGoresan(e)
      return
    }
    // Jari pertama sedang menggambar: goresannya dibatalkan dan jari itu ikut
    // dicatat di posisi terakhirnya — tanpa itu, dua jari hanya terhitung satu
    // dan cubit menjadi geser.
    if (goresanSaya) {
      jari.set(goresanSaya.pointer, goresanSaya.layar)
      batalGoresan()
    }
    if (hapusanSaya) {
      jari.set(hapusanSaya.pointer, hapusanSaya.layar)
      selesaiHapus()
    }
    jari.set(e.pointerId, { x: e.clientX, y: e.clientY })
    susun()
  })
  aktif.addEventListener('pointermove', (e) => {
    if (seretInstrumenKu) {
      instrumenKu = terapkanSeret(seretInstrumenKu, keDunia(e.clientX, e.clientY))
      kotorAktif = true
      return
    }
    if (goresanSaya && goresanSaya.pointer === e.pointerId) {
      lanjutGoresan(e)
      return
    }
    if (hapusanSaya && hapusanSaya.pointer === e.pointerId) {
      lanjutHapus(e)
      return
    }
    if (!jari.has(e.pointerId)) return
    if (gesturKetuk) gesturKetuk.bergeser = true
    jari.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const daftar = Array.from(jari.values())
    if (cubit && daftar.length >= 2) {
      const [a, b] = daftar
      const c = cubit
      const jarak = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
      const rasio = Math.min(6 / c.awal.skala, Math.max(0.1 / c.awal.skala, jarak / c.jarak))
      const tengah = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      mulaiBebas()
      tampilan = {
        skala: c.awal.skala * rasio,
        x: tengah.x - c.tengah.x + c.tengah.x - (c.tengah.x - c.awal.x) * rasio,
        y: tengah.y - c.tengah.y + c.tengah.y - (c.tengah.y - c.awal.y) * rasio,
      }
      kotorDasar = true
      kotorAktif = true
    } else if (geser && daftar.length === 1) {
      const dx = e.clientX - geser.x
      const dy = e.clientY - geser.y
      // Ambang kecil: ketukan biasa bukan gestur menjelajah.
      if (!bebas && Math.hypot(dx, dy) < 8) return
      mulaiBebas()
      tampilan = { ...tampilan, x: geser.tx + dx, y: geser.ty + dy }
      kotorDasar = true
      kotorAktif = true
    }
  })
  const lepas = (e: PointerEvent) => {
    if (seretInstrumenKu) {
      seretInstrumenKu = null
      return
    }
    if (goresanSaya && goresanSaya.pointer === e.pointerId) {
      if (e.type === 'pointercancel') batalGoresan()
      else selesaiGoresan()
      return
    }
    if (hapusanSaya && hapusanSaya.pointer === e.pointerId) {
      selesaiHapus()
      return
    }
    jari.delete(e.pointerId)
    // Jari terakhir diangkat: dua jari yang cuma menempel sebentar tanpa
    // bergeser adalah ketukan undo, bukan cubit yang gagal.
    if (jari.size === 0 && gesturKetuk) {
      const g = gesturKetuk
      gesturKetuk = null
      if (duaJariUndoAktif && modeCoret && !g.bergeser && g.maksJari === 2 && performance.now() - g.mulai < AMBANG_KETUK_MS) {
        urungkanKu()
      }
    }
    susun()
  }
  aktif.addEventListener('pointerup', lepas)
  aktif.addEventListener('pointercancel', lepas)
  aktif.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      mulaiBebas()
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * 0.01)
        const skala = Math.min(6, Math.max(0.1, tampilan.skala * f))
        const r = skala / tampilan.skala
        tampilan = { skala, x: e.clientX - (e.clientX - tampilan.x) * r, y: e.clientY - (e.clientY - tampilan.y) * r }
      } else {
        tampilan = { ...tampilan, x: tampilan.x - e.deltaX, y: tampilan.y - e.deltaY }
      }
      kotorDasar = true
      kotorAktif = true
    },
    { passive: false },
  )
}

/* ── Mencoret sendiri (murid berizin) ─────────────────────────────── */

/** Izin dari guru: boleh mencoret, dan kanvas mana. */
let izinCoret: { boleh: boolean; sketsa: string | null } = { boleh: false, sketsa: null }
/** Ketukan dua jari = undo — disetel guru, dikirim lewat /api/kelas/saya. */
let duaJariUndoAktif = true
let modeCoret = false
let warnaCoret = 'ink'
let ukuranCoret = 5
/** Pena menulis; penghapus membuang goresan saya yang tersentuh, utuh. */
let alatCoret: 'pen' | 'hapus' = 'pen'
/** Goresan yang sedang ditarik jari/pena saya; `layar` posisi terakhirnya di layar. */
let goresanSaya: { c: Coretan; pointer: number; terkirim: number; layar: { x: number; y: number } } | null = null
/** Sapuan penghapus yang sedang berjalan: goresan yang sudah terbuang di sapuan ini. */
let hapusanSaya: { pointer: number; dihapus: Coretan[]; layar: { x: number; y: number } } | null = null
/** Id goresan buatan saya di sesi ini — pelengkap cap `murid` dari server. */
const milikKu = new Set<string>()
/**
 * Riwayat untuk undo: satu langkah = goresan yang ditambah dan/atau dibuang.
 * Undo menulis balik: yang ditambah dihapus, yang dibuang dikembalikan.
 */
const riwayatKu: { tambah: Coretan[]; hapus: Coretan[]; objek?: Objek[] }[] = []
let bingkaiKirim: number | null = null

/** Goresan ini milik saya? Dari sesi ini, atau bercap id akun saya di berkas. */
function milikSaya(c: Coretan): boolean {
  return milikKu.has(c.id) || (!!muridId && c.murid === muridId)
}

function catatRiwayat(langkah: { tambah: Coretan[]; hapus: Coretan[]; objek?: Objek[] }) {
  riwayatKu.push(langkah)
  if (riwayatKu.length > 200) riwayatKu.shift()
}

/** Urungkan satu langkah saya — dari tombol, atau dari ketukan dua jari. */
function urungkanKu() {
  const langkah = riwayatKu.pop()
  if (!langkah || !sketsa || !idSketsa) return
  const buang = new Set(langkah.tambah.map((c) => c.id))
  sketsa.strokes = [...sketsa.strokes.filter((c) => !buang.has(c.id)), ...langkah.hapus]
  const buangObjek = new Set((langkah.objek ?? []).map((o) => o.id))
  if (buangObjek.size) sketsa.objects = (sketsa.objects ?? []).filter((o) => !buangObjek.has(o.id))
  kotorDasar = true
  kotorAktif = true
  kirim({
    t: 'ubah',
    idKanvas: idSketsa,
    hapus: { coretan: langkah.tambah.map((c) => c.id), objek: Array.from(buangObjek) },
    tambah: { coretan: langkah.hapus, objek: [] },
  })
}

function setBentuk(nyala: boolean) {
  bentukAktif = nyala
  el('coret-bentuk').classList.toggle('aktif', nyala)
  if (nyala) setAlatCoret('pen')
}

/**
 * Instrumen murid: ditaruh di tengah layarnya sendiri, bukan mengikuti guru.
 * Satu saja pada satu waktu — memasang yang lain melepas yang lama. Menggambar
 * di tepi/lengkungnya mengunci goresan ke situ; pegangannya untuk menggeser,
 * memutar, atau mengubah ukurannya.
 */
function setInstrumenKu(jenis: JenisInstrumen | null) {
  if (!jenis) {
    instrumenKu = null
    seretInstrumenKu = null
  } else {
    const r = aktif.getBoundingClientRect()
    const tengah = keDunia(r.width / 2, r.height / 2)
    instrumenKu = buatInstrumen(jenis, tengah, r.width / tampilan.skala, r.height / tampilan.skala)
  }
  el('coret-penggaris').classList.toggle('aktif', jenis === 'penggaris')
  el('coret-busur').classList.toggle('aktif', jenis === 'busur')
  el('coret-jangka').classList.toggle('aktif', jenis === 'jangka')
  kotorAktif = true
}

function setAlatCoret(alat: 'pen' | 'hapus') {
  alatCoret = alat
  el('coret-hapus').classList.toggle('aktif', alat === 'hapus')
  document.documentElement.classList.toggle('menghapus', alat === 'hapus')
}

function terapkanIzin(boleh: boolean, sketsaId: string | null) {
  const berubah = izinCoret.boleh !== boleh || izinCoret.sketsa !== sketsaId
  izinCoret = { boleh, sketsa: sketsaId }
  const tombol = el('tombol-coret') as HTMLButtonElement
  tombol.hidden = !boleh
  el('tombol-sisip-foto').hidden = !boleh
  // Berizin menulis: layar penuh miliknya, tombol "ikuti" (kembali ke guru)
  // tidak relevan lagi — lihat pengecekan izinCoret.boleh di `terima`.
  if (boleh) el('ikuti').hidden = true
  if (!boleh && modeCoret) {
    selesaiCoret()
    tampilkanStatus('The teacher turned off drawing.', true)
  } else if (boleh && berubah && !modeCoret) {
    tampilkanStatus('You may draw on your canvas — tap ✏️', true)
    bunyi('bahas')
  }
}

/** Buka kanvas saya dan nyalakan mode coret. */
async function mulaiCoret() {
  if (!izinCoret.boleh || !izinCoret.sketsa) return
  kanvasSaya = izinCoret.sketsa
  bebas = false
  el('ikuti').hidden = true
  if (idSketsa !== izinCoret.sketsa) {
    await muatSketsa(izinCoret.sketsa)
    pandanganSumber = null
    muatSatuHalaman()
  }
  modeCoret = true
  document.documentElement.classList.add('mencoret')
  el('tombol-coret').classList.add('aktif')
  el('alat-coret').classList.add('tampil')
  tampilkanStatus('Drawing on your canvas · two fingers to move')
}

function selesaiCoret() {
  if (goresanSaya) selesaiGoresan()
  if (hapusanSaya) selesaiHapus()
  setAlatCoret('pen')
  // Perkakas murid ikut dibereskan: instrumen yang tertinggal akan tetap
  // tergambar di layar padahal ia sudah tidak bisa memakainya.
  setBentuk(false)
  setInstrumenKu(null)
  gesturKetuk = null
  kuncianKu = null
  modeCoret = false
  document.documentElement.classList.remove('mencoret')
  el('tombol-coret').classList.remove('aktif')
  el('alat-coret').classList.remove('tampil')
}

/**
 * Susun beberapa foto sebagai kisi di halaman baru — sama seperti guru
 * menempel pertanyaan berfoto, hanya di sini murid menempelnya sendiri ke
 * kanvasnya, jadi tidak tergantung server meneruskan/mendekode ulang fotonya.
 */
function susunGambarKanvas(daftar: { src: string; w: number; h: number }[]): Gambar[] {
  if (!sketsa || daftar.length === 0) return []
  const kertas = kertasDari(sketsa.paper)
  const isiAda = kotakSemua(sketsa.strokes, sketsa.images ?? [], sketsa.objects ?? [], sketsa.texts ?? [])
  const kolom = daftar.length <= 1 ? 1 : daftar.length <= 4 ? 2 : 3
  const gap = 16
  let lebarBlok: number
  let x0: number
  let y0: number
  if (kertas.w > 0) {
    const slot = kertas.h + JARAK_HALAMAN
    const indeks = isiAda ? Math.floor(isiAda.y2 / slot) + 1 : 0
    const k = kotakHalaman(kertas, indeks)
    lebarBlok = kertas.w * 0.9
    x0 = k.x1 + (kertas.w - lebarBlok) / 2
    y0 = k.y1 + 24
  } else {
    lebarBlok = 900
    x0 = 0
    y0 = isiAda ? isiAda.y2 + 40 : 0
  }
  const lebarSel = (lebarBlok - gap * (kolom - 1)) / kolom
  const baris = Math.ceil(daftar.length / kolom)
  const tinggiSelTarget = kertas.w > 0 ? (kertas.h * 0.9 - gap * (baris - 1)) / baris : 260

  const baru: Gambar[] = []
  let y = y0
  for (let i = 0; i < daftar.length; i += kolom) {
    const potong = daftar.slice(i, i + kolom)
    const ditempatkan = potong.map((g) => {
      const skala = Math.min(lebarSel / g.w, tinggiSelTarget / g.h, 1)
      return { src: g.src, w: g.w * skala, h: g.h * skala }
    })
    const tinggiBaris = Math.max(...ditempatkan.map((g) => g.h))
    let x = x0
    for (const g of ditempatkan) {
      baru.push({ id: newId('img'), layer: 0, x: x + (lebarSel - g.w) / 2, y: y + (tinggiBaris - g.h) / 2, w: g.w, h: g.h, src: g.src })
      x += lebarSel + gap
    }
    y += tinggiBaris + gap
  }
  return baru
}

/**
 * Foto dipilih di HP ini langsung ditempel ke kanvas sendiri — tidak lewat
 * antrian guru sama sekali, jadi tidak ada server lain yang perlu mengambil
 * dan mendekode ulang fotonya (itu yang beberapa kali gagal di tablet).
 */
async function sisipFotoKanvas(berkasTerpilih: File[]) {
  if (!izinCoret.boleh || !izinCoret.sketsa || !berkasTerpilih.length) return
  if (idSketsa !== izinCoret.sketsa) {
    await muatSketsa(izinCoret.sketsa)
    pandanganSumber = null
    muatSatuHalaman()
  }
  if (!sketsa || !idSketsa) return
  const dipakai = berkasTerpilih.slice(0, MAKS_FOTO)
  const diproses: { src: string; w: number; h: number }[] = []
  let gagal = 0
  for (const f of dipakai) {
    try {
      diproses.push(await perkecilFoto(f))
    } catch {
      gagal++
    }
  }
  if (berkasTerpilih.length > dipakai.length) tampilkanStatus(`You can insert up to ${MAKS_FOTO} photos at a time.`, true)
  else if (gagal) tampilkanStatus(gagal === dipakai.length ? 'Could not read those photos — try again.' : `Could not read ${gagal} of the photos.`, true)
  if (!diproses.length) return
  const baru = susunGambarKanvas(diproses)
  sketsa.images = [...(sketsa.images ?? []), ...baru]
  for (const g of baru) muatGambar(g.src, () => (kotorDasar = true))
  kotorDasar = true
  kotorAktif = true
  kirim({ t: 'ubah', idKanvas: idSketsa, hapus: { coretan: [], objek: [] }, tambah: { coretan: [], objek: [], gambar: baru } })
  tampilkanStatus(baru.length > 1 ? `${baru.length} photos added to your canvas.` : 'Photo added to your canvas.')
}

/** Tombol ⛶ sukarela: hanya tampil di perangkat yang mendukung layar penuh. */
function pasangLayarPenuh() {
  const tombol = el('tombol-layar-penuh') as HTMLButtonElement
  if (!document.fullscreenEnabled) return
  tombol.hidden = false
  tombol.onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen().catch(() => {})
  }
}

function pasangCoret() {
  el('tombol-coret').onclick = () => {
    if (modeCoret) selesaiCoret()
    else void mulaiCoret()
  }
  const berkasSisip = el('berkas-sisip-foto') as HTMLInputElement
  el('tombol-sisip-foto').onclick = () => berkasSisip.click()
  berkasSisip.onchange = async () => {
    const berkasTerpilih = Array.from(berkasSisip.files ?? [])
    berkasSisip.value = ''
    await sisipFotoKanvas(berkasTerpilih)
  }
  el('coret-selesai').onclick = selesaiCoret
  el('coret-undo').onclick = urungkanKu
  el('coret-bentuk').onclick = () => setBentuk(!bentukAktif)
  el('coret-penggaris').onclick = () => setInstrumenKu(instrumenKu?.jenis === 'penggaris' ? null : 'penggaris')
  el('coret-busur').onclick = () => setInstrumenKu(instrumenKu?.jenis === 'busur' ? null : 'busur')
  el('coret-jangka').onclick = () => setInstrumenKu(instrumenKu?.jenis === 'jangka' ? null : 'jangka')
  el('coret-hapus').onclick = () => setAlatCoret(alatCoret === 'hapus' ? 'pen' : 'hapus')
  const alat = el('alat-coret')
  alat.querySelectorAll<HTMLButtonElement>('button.warna').forEach((b) => {
    b.onclick = () => {
      warnaCoret = b.dataset.warna ?? 'ink'
      setAlatCoret('pen')
      alat.querySelectorAll('button.warna').forEach((x) => x.classList.toggle('aktif', x === b))
    }
  })
  alat.querySelectorAll<HTMLButtonElement>('button.ukuran').forEach((b) => {
    b.onclick = () => {
      ukuranCoret = Number(b.dataset.ukuran) || 5
      setAlatCoret('pen')
      alat.querySelectorAll('button.ukuran').forEach((x) => x.classList.toggle('aktif', x === b))
    }
  })
}

function keDunia(x: number, y: number): [number, number] {
  return [(x - tampilan.x) / tampilan.skala, (y - tampilan.y) / tampilan.skala]
}

function mulaiGoresan(e: PointerEvent) {
  if (!sketsa || !idSketsa) return
  const mentah = keDunia(e.clientX, e.clientY)
  // Dimulai di tepi/lengkung instrumen? Seluruh goresan ini ikut kuncian itu.
  kuncianKu = instrumenKu ? kuncianDi(instrumenKu, mentah, tampilan.skala) : null
  const [x, y] = kuncianKu ? kunciTitik(kuncianKu, mentah).q : mentah
  const tekanan = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5
  const c: Coretan = {
    id: `sk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    tool: 'pen',
    color: warnaCoret,
    size: ukuranCoret,
    layer: 0,
    alpha: 1,
    pola: 'utuh',
    steady: false,
    points: [[x, y, tekanan]],
  }
  goresanSaya = { c, pointer: e.pointerId, terkirim: 0, layar: { x: e.clientX, y: e.clientY } }
  goresanHidup.set(c.id, c)
  titikDiamKu = { x: e.clientX, y: e.clientY }
  // Tahan-untuk-bentuk tidak berlaku di tepi/lengkung instrumen: bentuknya
  // sudah dijamin instrumen itu.
  if (!kuncianKu) jadwalkanTahanKu()
  kotorAktif = true
  jadwalkanKirimGoresan()
}

/** Mulai hitung mundur diam; dipanggil ulang tiap kali tangan bergerak. */
function jadwalkanTahanKu() {
  batalTahanKu()
  timerTahanKu = window.setTimeout(kunciBentukKu, JEDA_TAHAN)
}

function batalTahanKu() {
  if (timerTahanKu !== null) window.clearTimeout(timerTahanKu)
  timerTahanKu = null
}

/** Pena murid sudah diam cukup lama — coba baca goresannya sebagai bentuk. */
function kunciBentukKu() {
  timerTahanKu = null
  const g = goresanSaya
  if (!g) return
  const tebak = kenaliBentuk(g.c.points, 24 / tampilan.skala)
  if (!tebak) return
  bentukSnapKu = {
    id: newId('obj'),
    jenis: tebak.jenis,
    layer: g.c.layer,
    color: g.c.color,
    size: Math.max(1.5, g.c.size * 0.55),
    titik: tebak.titik,
    putar: tebak.putar,
  }
  kotorAktif = true
}

function lanjutGoresan(e: PointerEvent) {
  if (!goresanSaya) return
  // Bentuk yang sudah terkunci bertahan: tangan yang bergeser sedikit
  // sesudahnya bukan pembatalan, cuma tangan yang bergeser.
  if (bentukSnapKu) return
  goresanSaya.layar = { x: e.clientX, y: e.clientY }
  const c = goresanSaya.c
  const daftar = 'getCoalescedEvents' in e ? e.getCoalescedEvents() : [e]
  for (const ev of daftar.length ? daftar : [e]) {
    const mentah = keDunia(ev.clientX, ev.clientY)
    const [x, y] = kuncianKu ? kunciTitik(kuncianKu, mentah).q : mentah
    const akhir = c.points[c.points.length - 1]
    if (akhir && Math.hypot(akhir[0] - x, akhir[1] - y) * tampilan.skala < 1.2) continue
    c.points.push([x, y, ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5])
  }
  // Diukur di piksel layar, bukan dunia: yang dinilai adalah tangan yang
  // berhenti, dan itu tidak berubah artinya saat kanvas di-zoom.
  const diam = titikDiamKu
  const bergeser = !diam || Math.hypot(e.clientX - diam.x, e.clientY - diam.y) > AMBANG_DIAM
  if (bergeser && !kuncianKu) {
    titikDiamKu = { x: e.clientX, y: e.clientY }
    jadwalkanTahanKu()
  }
  kotorAktif = true
  jadwalkanKirimGoresan()
}

/** Titik yang belum terkirim dikirim sekali per bingkai, seperti editor. */
function jadwalkanKirimGoresan() {
  if (bingkaiKirim !== null) return
  bingkaiKirim = window.requestAnimationFrame(() => {
    bingkaiKirim = null
    const g = goresanSaya
    if (!g || !idSketsa || g.c.points.length <= g.terkirim) return
    const { points: _abaikan, ...meta } = g.c
    void _abaikan
    kirim({ t: 'titik', idKanvas: idSketsa, id: g.c.id, dari: g.terkirim, titik: g.c.points.slice(g.terkirim), meta })
    g.terkirim = g.c.points.length
  })
}

/** Goresan kasar `c` diganti objek `o` yang sudah rapi: coretan dibuang total. */
function komitBentukKu(c: Coretan, o: Objek) {
  if (!sketsa || !idSketsa) return
  sketsa.objects = [...(sketsa.objects ?? []), o]
  milikKu.add(o.id)
  catatRiwayat({ tambah: [], hapus: [], objek: [o] })
  kotorDasar = true
  kotorAktif = true
  kirim({ t: 'goresan-selesai', idKanvas: idSketsa, id: c.id, batal: true })
  kirim({ t: 'ubah', idKanvas: idSketsa, hapus: { coretan: [], objek: [] }, tambah: { coretan: [], objek: [o] } })
}

function selesaiGoresan() {
  const g = goresanSaya
  goresanSaya = null
  batalTahanKu()
  titikDiamKu = null
  const snap = bentukSnapKu
  bentukSnapKu = null
  // Kuncian penggaris berlaku per goresan; dibaca dulu, baru dilepas.
  const terkunci = kuncianKu !== null
  kuncianKu = null
  if (!g || !sketsa || !idSketsa) return
  goresanHidup.delete(g.c.id)
  // Tahan-untuk-bentuk sudah mengunci pratinjaunya sebelum pena terangkat.
  if (snap) {
    komitBentukKu(g.c, snap)
    return
  }
  if (g.c.points.length < 2) {
    kotorAktif = true
    return
  }
  // Mode bentuk: coretan kasar jadi objek rapi. Yang ditarik di tepi penggaris
  // dibiarkan tinta — kelurusannya sudah dijamin penggarisnya, dan memaksanya
  // jadi bentuk justru membuang maksud si penggaris.
  if (bentukAktif && !terkunci && g.c.points.length >= 8) {
    const tebak = kenaliBentuk(g.c.points, 24 / tampilan.skala)
    if (tebak) {
      const o: Objek = {
        id: newId('obj'),
        jenis: tebak.jenis,
        layer: g.c.layer,
        color: g.c.color,
        size: Math.max(1.5, g.c.size * 0.55),
        titik: tebak.titik,
        putar: tebak.putar,
      }
      komitBentukKu(g.c, o)
      return
    }
  }
  sketsa.strokes.push(g.c)
  milikKu.add(g.c.id)
  catatRiwayat({ tambah: [g.c], hapus: [] })
  kotorDasar = true
  kotorAktif = true
  kirim({ t: 'goresan-selesai', idKanvas: idSketsa, id: g.c.id })
  kirim({ t: 'ubah', idKanvas: idSketsa, hapus: { coretan: [], objek: [] }, tambah: { coretan: [g.c], objek: [] } })
}

/* Penghapus: menyapu membuang goresan saya yang tersentuh, seutuhnya.
   Goresan guru dan teman tidak tersentuh — server pun menolaknya. */

function mulaiHapus(e: PointerEvent) {
  if (!sketsa || !idSketsa) return
  hapusanSaya = { pointer: e.pointerId, dihapus: [], layar: { x: e.clientX, y: e.clientY } }
  hapusDi(e.clientX, e.clientY)
}

function lanjutHapus(e: PointerEvent) {
  if (!hapusanSaya) return
  hapusanSaya.layar = { x: e.clientX, y: e.clientY }
  const daftar = 'getCoalescedEvents' in e ? e.getCoalescedEvents() : [e]
  for (const ev of daftar.length ? daftar : [e]) hapusDi(ev.clientX, ev.clientY)
}

function hapusDi(lx: number, ly: number) {
  if (!hapusanSaya || !sketsa || !idSketsa) return
  const [x, y] = keDunia(lx, ly)
  // Bidang hapus selebar ujung jari di layar, apa pun zoom-nya.
  const radius = 14 / tampilan.skala
  const kena = sketsa.strokes.filter((c) => milikSaya(c) && coretanKena(c, x, y, radius))
  if (kena.length === 0) return
  const ids = new Set(kena.map((c) => c.id))
  sketsa.strokes = sketsa.strokes.filter((c) => !ids.has(c.id))
  hapusanSaya.dihapus.push(...kena)
  kotorDasar = true
  kirim({ t: 'ubah', idKanvas: idSketsa, hapus: { coretan: Array.from(ids), objek: [] }, tambah: { coretan: [], objek: [] } })
}

function selesaiHapus() {
  const h = hapusanSaya
  hapusanSaya = null
  if (h && h.dihapus.length > 0) catatRiwayat({ tambah: [], hapus: h.dihapus })
}

function batalGoresan() {
  kuncianKu = null
  batalTahanKu()
  titikDiamKu = null
  bentukSnapKu = null
  const g = goresanSaya
  goresanSaya = null
  if (!g) return
  goresanHidup.delete(g.c.id)
  kotorAktif = true
  if (idSketsa) kirim({ t: 'goresan-selesai', idKanvas: idSketsa, id: g.c.id, batal: true })
}

async function masukModeTunggu() {
  if (modeTunggu) return
  modeTunggu = true
  el('tunggu').classList.add('tampil')
  el('tunggu-antrean').textContent = tanyaSaya ? `Queue position #${tanyaSaya.urutan ?? '?'}` : 'No question in the queue'
  kirim({ t: 'fokus', aktif: true, tunggu: true })
  await lepasWakeLock()
}

async function keluarModeTunggu(pesan: string, bunyikan = false) {
  if (!modeTunggu) return
  modeTunggu = false
  el('tunggu').classList.remove('tampil')
  kirim({ t: 'fokus', aktif: document.visibilityState === 'visible', tunggu: false })
  await mintaWakeLock()
  if (bunyikan) {
    bunyi('bahas')
    try {
      navigator.vibrate?.([120, 60, 120, 60, 200])
    } catch {
      /* tidak didukung */
    }
  }
  tampilkanStatus(pesan)
  kotorDasar = true
  kotorAktif = true
}

/** Pilihan awal di layar tanpa sentuh: murid, atau TV. */
function layarPilih(): Promise<'murid' | 'tv'> {
  return new Promise((selesai) => {
    const kotak = el('pilih')
    kotak.classList.add('tampil')
    el('pilih-murid').onclick = () => {
      kotak.classList.remove('tampil')
      selesai('murid')
    }
    el('pilih-tv').onclick = () => {
      kotak.classList.remove('tampil')
      selesai('tv')
    }
  })
}

// Dipanggil paling akhir: semua const/let modul di atas sudah terisi saat
// layar akun (yang berjalan sinkron sebelum await pertama) memakainya.
void mulai()
