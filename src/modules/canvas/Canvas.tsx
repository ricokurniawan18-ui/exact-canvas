import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, type TempelanTertunda } from '@/lib/appStore'
import { htmlRumus, muatPenggambar } from '@/components/TeksRumus'
import { api, urlDenganPin } from '@/lib/api'
import { inTauri, sentuh as layarSentuh } from '@/lib/runtime'
import { bukaJendelaBaru } from '@/lib/layar'
import { useViewport } from '@/lib/useViewport'
import { jam, kunciTanggal, tanggalPendek } from '@/lib/tanggal'
import { newId } from '@/lib/id'
import { ANGGARAN_PDF, padatkanHalaman } from '@/lib/pdf'
import { IconButton } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { KERTAS_BAWAAN, berkasBaru, bacaKanvas, simpanKanvas } from './data'
import { JARAK_HALAMAN, KERTAS, kotakHalaman } from './kertas'
import {
  JUMLAH_LAPISAN,
  alatObjek,
  alatTulis,
  potongCoretan,
  type AlatTulis,
  coretanDalamLaso,
  coretanKena,
  gambarCoretan,
  geserCoretan,
  garisLuar,
  jalurDari,
  kePng,
  keSvg,
  kotakSemua,
  gambarKena,
  gambarTempelan,
  kotakCoretan,
  kotakGambar,
  porosGambar,
  sudutGambar,
  kotakTeks,
  gambarTeks,
  geserTeks,
  teksKena,
  lapisanBawaan,
  muatGambar,
  warnaToken,
  JARAK_BARIS,
  KELUARGA_HURUF,
  WARNA_CORETAN,
  PALET_CORETAN,
  type Alat,
  type BerkasKanvas,
  type Coretan,
  type Gambar,
  type Lapisan,
  type Teks,
} from './strokes'
import {
  OBJEK,
  gambarObjek,
  geserObjek,
  kotakObjek,
  kunciTitik,
  keLurus,
  objekKena,
  porosObjek,
  putarSekitar,
  titikTampak,
  titikAwal,
  type Objek,
} from './objek'
import { AMBANG_DIAM, JEDA_TAHAN, kenaliBentuk } from './bentuk'
import { DaftarHalaman, PetaBebas } from './PetaKanvas'
import { kursorAlat } from './kursor'
import { dengarkanLangsung, idKlien, kirim } from '@/lib/sinkron'
import { dengarkan } from '@/lib/events'
import { gabungkan } from './gabung'
import { pilihTujuan, tulisBerkas } from '@/lib/berkas'
import {
  INSTRUMEN,
  buatInstrumen,
  gambarInstrumen,
  kenaInstrumen,
  kunciTitik as kunciKeInstrumen,
  kuncianDi,
  terapkanSeret,
  type Instrumen,
  type JenisInstrumen,
  type Kuncian,
  type Seretan,
} from './instrumen'
import { PanelGrafik } from './PanelGrafik'
import { PanelTabel } from './PanelTabel'
import { PanelKelas } from './PanelKelas'
import { bunyiTanya, daftarTanya, ubahTanya, type Tanya } from '@/lib/kelas'
import { buatKanvas } from './data'
import { q1, x } from '@/lib/db'
import { useData } from '@/lib/useData'
import { ukuranTabel, type DefinisiGrafik, type DefinisiTabel, type MetaGambar } from './sisipan'
import {
  MODE_PENGHAPUS_BAWAAN,
  muatAutoBentuk,
  muatDuaJariUndo,
  muatKunciGambar,
  muatModePenghapus,
  muatSetelanAlat,
  setelanBawaan,
  simpanAutoBentuk,
  simpanDuaJariUndo,
  simpanKunciGambar,
  simpanModePenghapus,
  simpanSetelanAlat,
  type KunciAlat,
  type PetaSetelan,
  type ModePenghapus,
  type SetelanAlat,
} from './setelanAlat'
import {
  SLOT_ALAT,
  URUTAN_BAWAAN,
  infoAlat,
  muatUrutanAlat,
  simpanUrutanAlat,
  taruhAlat,
} from './urutanAlat'

/** Di atas ambang ini coretan lama dipanggang jadi bitmap; hanya yang baru digambar ulang. */
const AMBANG_PANGGANG = 2000
const SISA_HIDUP = 400
const JEDA_SIMPAN = 800

/** Latar kertas. Bukan coretan — tidak ikut terhapus, tidak ikut terekspor. */
type Latar = 'polos' | 'titik' | 'kotak' | 'garis'

const LATAR: { id: Latar; label: string }[] = [
  { id: 'polos', label: 'Plain' },
  { id: 'titik', label: 'Dots' },
  { id: 'kotak', label: 'Grid' },
  { id: 'garis', label: 'Ruled' },
]

/** Jarak antar garis latar dalam satuan dunia. */
const PETAK = 32

/** Sisi pegangan ubah-ukuran gambar, dalam piksel layar. */
const PEGANGAN = 14

/** Ketukan jari untuk undo/redo: geser lebih dari ini batal jadi cubit/pan. */
const AMBANG_GESER_KETUK = 20
/** Lebih lama dari ini (ms) dianggap tahan, bukan ketuk. */
const AMBANG_DURASI_KETUK = 400

/** Sisi terpanjang tangkapan layar yang ditempel; lebih dari ini diperkecil. */
const SISI_MAKS = 2200

/** Radius pegangan titik sudut objek, dalam piksel layar. */
const TITIK_KENDALI = 7

/** Jarak pegangan putar dari tepi atas bentuk, dalam piksel layar. */
const LENGAN_PUTAR = 26

/**
 * Tempat pegangan putar berada, dalam koordinat dunia.
 *
 * Dihitung dari bentuk lurusnya lalu ikut diputar, jadi pegangannya tetap
 * menempel di sisi yang sama seberapa pun bentuknya sudah diputar — bukan
 * melompat ke atas layar tiap kali sudutnya melewati suatu titik.
 */
function peganganPutarGambar(g: Gambar, skala: number): [number, number] {
  const poros = porosGambar(g)
  return putarSekitar([poros[0], g.y - LENGAN_PUTAR / skala], poros, g.putar ?? 0)
}

function peganganPutar(o: Objek, skala: number): [number, number] {
  const poros = porosObjek(o)
  let atas = Infinity
  for (const [, y] of o.titik) if (y < atas) atas = y
  return putarSekitar([poros[0], atas - LENGAN_PUTAR / skala], poros, o.putar ?? 0)
}

const HALAMAN_MAKS = 60

type KelompokAlat = 'alat' | 'warna' | 'goresan' | 'kertas' | 'lapisan' | 'instrumen' | 'sisip' | 'kelas' | 'ekspor'

const JUDUL_PANEL: Record<KelompokAlat, string> = {
  alat: 'Tools',
  warna: 'Colour',
  goresan: 'Stroke',
  kertas: 'Paper',
  lapisan: 'Layers',
  instrumen: 'Instruments',
  sisip: 'Insert',
  kelas: 'Class',
  ekspor: 'Export',
}

/**
 * Anggaran ukuran berkas PDF.
 *
 * PNG 288 dpi seukuran A4 sendiri sudah beberapa megabita, dan sketsa sepuluh
 * halaman menghasilkan berkas yang tidak bisa dilampirkan ke mana-mana. Angka
 * ini yang menentukan seberapa jauh tiap halaman boleh dipadatkan.
 */
/** Berkas kantor yang bisa diseret ke kanvas; sisanya ditolak dengan jelas. */
const EKSTENSI_KANTOR = ['doc', 'docx', 'rtf', 'odt', 'wordml', 'ppt', 'pptx', 'odp', 'key', 'pages']


interface Props {
  idKanvas: string
  judul?: string
}

export function Canvas({ idKanvas, judul = 'Sketch' }: Props) {
  const v = useViewport()
  const dasarRef = useRef<HTMLCanvasElement | null>(null)
  const aktifRef = useRef<HTMLCanvasElement | null>(null)
  const wadahRef = useRef<HTMLDivElement | null>(null)
  const berkasRef = useRef<HTMLInputElement | null>(null)

  const [coretan, setCoretan] = useState<Coretan[]>([])
  const [gambar, setGambar] = useState<Gambar[]>([])
  const [gambarTerpilih, setGambarTerpilih] = useState<string | null>(null)
  /** Gambar yang baru saja ditempel — lihat `bisaDipilihGambar`. */
  const [gambarBaruDitempel, setGambarBaruDitempel] = useState<string | null>(null)
  const [objek, setObjek] = useState<Objek[]>([])
  const [objekTerpilih, setObjekTerpilih] = useState<string | null>(null)
  const [teks, setTeks] = useState<Teks[]>([])
  const [teksTerpilih, setTeksTerpilih] = useState<string | null>(null)
  /** Id tulisan yang kotak ketiknya sedang terbuka. */
  const [teksDiubah, setTeksDiubah] = useState<string | null>(null)
  const [alat, setAlat] = useState<Alat>('pen')
  /** Alat tulis yang terakhir dipakai — tempat Escape mengembalikan tangan. */
  const alatTulisTerakhir = useRef<Alat>('pen')
  useEffect(() => {
    if (alatTulis(alat)) alatTulisTerakhir.current = alat
  }, [alat])
  const [warna, setWarna] = useState<string>('ink')
  /**
   * Setelan per alat, bukan satu slider bersama.
   *
   * Stabilo mau tebal, pena mau tipis, dan keduanya dipakai bergantian di
   * halaman yang sama — satu nilai bersama memaksa menyetel ulang tiap kali
   * berpindah alat.
   */
  const [setelan, setSetelan] = useState<PetaSetelan>({})
  const [modePenghapus, setModePenghapus] = useState<ModePenghapus>(MODE_PENGHAPUS_BAWAAN)

  function ubahModePenghapus(m: ModePenghapus) {
    setModePenghapus(m)
    void simpanModePenghapus(m)
  }
  /** Kelompok yang panelnya sedang terbuka di sebelah rel; null = tertutup. */
  const [panelAlat, setPanelAlat] = useState<KelompokAlat | null>('alat')

  function bukaPanel(k: KelompokAlat) {
    setPanelAlat((lama) => (lama === k ? null : k))
  }

  useEffect(() => {
    void muatSetelanAlat().then(setSetelan)
    void muatModePenghapus().then(setModePenghapus)
    void muatAutoBentuk().then(setAutoBentuk)
    void muatKunciGambar().then(setKunciGambar)
    void muatDuaJariUndo().then(setDuaJariUndo)
  }, [])

  /** Antrian pertanyaan murid — untuk lencana di rel dan bunyi saat ada yang baru. */
  const { data: antrianKelas } = useData('kelas', daftarTanya, [])
  const jumlahMenunggu = antrianKelas.filter((t) => t.status === 'menunggu').length
  useEffect(
    () =>
      dengarkan('kelas', (payload) => {
        const p = payload as { apa?: string; isi?: { nama?: string; foto?: boolean; teks?: string } } | null
        if (p?.apa !== 'tanya' || !p.isi) return
        bunyiTanya()
        beriTahu(`${p.isi.nama ?? 'A student'} ${p.isi.foto || p.isi.teks ? 'sent a question' : 'raised a hand'}.`)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  /**
   * Guru membuka pertanyaan: pindah ke ruangan murid itu, dan fotonya (kalau
   * ada) ditempel ke kanvas ini supaya bisa langsung dicoret.
   */
  /**
   * Guru membuka pertanyaan.
   *
   * Tiap murid punya kanvas khususnya sendiri, "Tanya · Nama · 16 Sep" — satu
   * per hari, seperti kanvas grup — dibuat saat pertanyaan pertamanya hari itu
   * dibahas dan dipakai lagi untuk pertanyaan berikutnya: foto atau PDF-nya
   * masuk di halaman baru kanvas itu, jadi riwayat satu anak dalam sehari
   * tinggal berurutan di satu tempat, dan anak lain tidak bercampur.
   */
  async function bahasTanya(t: Tanya, lampiran: string[] | null, paksaTempel = false) {
    // Anggota grup berbagi satu kanvas grup; murid tanpa grup punya kanvasnya
    // sendiri. Keduanya dibuat saat pertama dibutuhkan dan dipakai lagi seterusnya.
    let idTujuan: string | null = null
    const hari = kunciTanggal()
    let judulTujuan = `Tanya · ${t.name} · ${tanggalPendek(new Date())}`
    try {
      const grup = await q1<{ id: string; name: string; sketch_id: string | null; sketch_day: string | null }>(
        'SELECT g.id, g.name, g.sketch_id, g.sketch_day FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.student_id = ? ORDER BY g.sort_order LIMIT 1',
        [t.student_id],
      )
      const adaSketsa = async (id: string | null) => (id ? !!(await q1('SELECT id FROM canvases WHERE id = ?', [id])) : false)
      if (grup) {
        // Satu kanvas per grup per hari: "Grup · Mat 1 · 6 Sep". Besok grup
        // yang sama mulai bersih; materi hari ini tetap ada di daftar sketsa.
        judulTujuan = `Grup · ${grup.name} · ${tanggalPendek(new Date())}`
        idTujuan = grup.sketch_day === hari && (await adaSketsa(grup.sketch_id)) ? grup.sketch_id : null
        if (!idTujuan) {
          idTujuan = await buatKanvas(judulTujuan, grup.id)
          await x('UPDATE groups SET sketch_id = ?, sketch_day = ? WHERE id = ?', [idTujuan, hari, grup.id])
        }
      } else {
        const baris = await q1<{ sketch_id: string | null; sketch_day: string | null }>(
          'SELECT sketch_id, sketch_day FROM students WHERE id = ?',
          [t.student_id],
        )
        idTujuan = baris?.sketch_day === hari && (await adaSketsa(baris.sketch_id)) ? baris.sketch_id : null
        if (!idTujuan) {
          idTujuan = await buatKanvas(judulTujuan)
          await x('UPDATE students SET sketch_id = ?, sketch_day = ? WHERE id = ?', [idTujuan, hari, t.student_id])
        }
      }
    } catch (e) {
      beriTahu(e instanceof Error ? e.message : String(e))
      return
    }
    // Kabar dikirim sesudah kanvasnya pasti: HP murid (dan grupnya) dipaku ke
    // kanvas itu, mengikuti coretan selama guru di sana, dan tinggal di sana
    // saat guru pindah ke anak lain.
    try {
      await ubahTanya(t.id, 'dibahas', idKlien, idTujuan)
    } catch (e) {
      beriTahu(e instanceof Error ? e.message : String(e))
      return
    }
    // Pertanyaan yang sudah dibahas: lampirannya sudah ada di kanvas itu.
    // Membuka lagi hanya kembali ke kanvasnya, tidak menempel halaman baru —
    // tapi penanda ini tetap dikirim (tanpa url) supaya layar tetap dibawa ke
    // halaman terakhir begitu kanvasnya termuat, bukan cuma saat ada lampiran.
    // `paksaTempel` (tombol "sisip ulang" di panel) melewati penjagaan ini —
    // jalan keluar kalau penempelan pertama gagal dan pertanyaannya sudah
    // kadung tercatat "dibahas".
    const sudahDitempel = t.status === 'dibahas' && !paksaTempel
    // Pertanyaan tanpa foto/PDF (mis. soal dari Exact Practice) membawa
    // teksnya: ditempel sebagai gambar supaya soalnya ada di papan, bukan
    // cuma di kartu panel. Teks yang menyertai foto tidak ikut — biasanya
    // hanya keterangan pendek ("nomor 3"), fotonya yang jadi bahan.
    const teksSoal = (t.text ?? '').trim()
    const tempelan: TempelanTertunda =
      lampiran && lampiran.length > 0 && !sudahDitempel
        ? { idKanvas: idTujuan, lampiran, nama: t.name }
        : teksSoal && !sudahDitempel
          ? { idKanvas: idTujuan, teks: teksSoal, nama: t.name }
          : { idKanvas: idTujuan, nama: t.name }
    if (idTujuan === idKanvas) {
      // Kanvas ini sudah terbuka: jumlahHalaman di sini sudah pasti segar,
      // beda dari kanvas yang baru saja termuat lewat cabang di bawah.
      if (!tempelan.lampiran && !tempelan.teks) keHalaman(jumlahHalaman - 1)
      await kerjakanTempelan(tempelan)
      return
    }
    // Kanvas lain: pindah dulu; tempelannya dikerjakan begitu kanvas itu termuat.
    useApp.getState().setTempelanTertunda(tempelan)
    useApp.getState().mintaBukaSketsa(idTujuan, judulTujuan)
  }

  /**
   * Tempel foto-foto/PDF pertanyaan (kalau ada) ke halaman baru, lalu siap menulis.
   *
   * Foto dibaca dan dikodekan di server (`/api/kelas/foto-data`), bukan
   * diambil lewat jaringan lalu didekode di sini — supaya guru pun kalau
   * membuka dari tablet/browser tidak lagi bergantung pada createImageBitmap
   * perangkat itu, yang berkali-kali terbukti gagal diam-diam. PDF tetap
   * lewat fetch biasa (butuh byte utuh untuk pdf.js, bukan bagian yang bermasalah).
   */
  async function kerjakanTempelan(tempelan: { lampiran?: string[]; teks?: string; nama: string } | null) {
    if (tempelan?.teks) {
      try {
        await tempelTeksSoal(tempelan.teks)
      } catch (e) {
        beriTahu(`Could not render the question: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (tempelan?.lampiran?.length) {
      let gagal = 0
      const namaPdf = tempelan.lampiran.filter((n) => n.endsWith('.pdf'))
      const namaFoto = tempelan.lampiran.filter((n) => !n.endsWith('.pdf'))

      for (const n of namaPdf) {
        try {
          const r = await fetch(urlDenganPin(`/api/kelas/foto/${encodeURIComponent(n)}`))
          const blob = await r.blob()
          await terimaRef.current(new File([blob], `${tempelan.nama}.pdf`, { type: 'application/pdf' }))
        } catch {
          gagal++
        }
      }

      if (namaFoto.length) {
        try {
          const hasil = await api<({ src: string; w: number; h: number } | null)[]>('/api/kelas/foto-data', {
            method: 'POST',
            json: { nama: namaFoto },
            timeoutMs: 30000,
          })
          const gambarBaru = hasil.filter((g): g is { src: string; w: number; h: number } => g !== null)
          gagal += hasil.length - gambarBaru.length
          if (gambarBaru.length) tempelBeberapaKeHalamanBaru(gambarBaru)
        } catch {
          gagal += namaFoto.length
        }
      }

      if (gagal) beriTahu(gagal === tempelan.lampiran.length ? 'Could not fetch the attachment.' : `Could not fetch ${gagal} of the attachments.`)
    }
    // Langsung pena dan panel dilipat: yang ditunggu murid adalah coretan,
    // bukan pemilihan gambar atau bilah alat. Esc atau ⌘. membukanya lagi.
    // Di tablet rel alatnya sudah kecil dan menetap di bawah — dilipat di
    // sana cuma berarti mengejar tombol "tampilkan" tiap kali membahas soal,
    // jadi di situ dibiarkan tetap terbuka.
    setGambarTerpilih(null)
    setAlat(alatTulisTerakhir.current)
    setPanelAlat(null)
    if (!layarSentuh) setMenuTampil(false)
    // Umumkan diri sebagai editor aktif supaya layar di ruangan ini berpindah ke sini.
    kirim({ t: 'pandangan', idKanvas, tampilan: tampilanRef.current, layar: ukuranLayarRef.current })
    beriTahu(tempelan ? `${tempelan.nama}'s question is on the canvas — draw away.` : 'Discussing — draw away.')
  }

  /**
   * Soal teks (rumus $…$ lewat KaTeX, diagram [[…]] lewat penggambar
   * Worksheet) digambar jadi satu gambar lalu ditempel ke halaman baru —
   * jalur yang sama dengan foto, jadi murid melihat soalnya di papan dan guru
   * langsung mencoret di atasnya.
   *
   * Dirender di DOM aplikasi sendiri, bukan iframe seperti tempelHtml: teks
   * biasa dilolos-escape dan rumusnya keluaran KaTeX (throwOnError mati),
   * persis seperti kartu panel yang sudah menampilkannya. Stylesheet KaTeX
   * dimuat global, jadi di iframe rumusnya justru tak bergaya.
   */
  async function tempelTeksSoal(teks: string) {
    setSibuk('Rendering question…')
    const wadah = document.createElement('div')
    wadah.style.cssText =
      'position:fixed;left:-10000px;top:0;width:760px;box-sizing:border-box;padding:28px 32px;' +
      'background:#fff;color:#111;font:20px/1.6 -apple-system,system-ui,sans-serif;white-space:pre-wrap;word-break:break-word'
    // Diagram diberi ruang lebih lebar daripada di kartu panel: di papan ia
    // justru yang mau dicoret-coret guru.
    wadah.style.setProperty('--ws-diagram-width', '520px')
    const gambar = teks.includes('[[') ? await muatPenggambar() : undefined
    wadah.innerHTML = htmlRumus(teks, gambar)
    document.body.appendChild(wadah)
    try {
      // KaTeX memakai web font; tunggu sampai siap supaya rumus tidak
      // tergambar dengan font pengganti.
      try {
        await document.fonts.ready
      } catch {
        /* peramban tanpa Font Loading API: lanjut saja */
      }
      const html2canvas = (await import('html2canvas')).default
      const c = await html2canvas(wadah, { backgroundColor: '#ffffff', scale: 2, width: 760, height: wadah.scrollHeight })
      tempelKeHalamanBaru(c.toDataURL('image/png'), c.width / 2, c.height / 2)
    } finally {
      wadah.remove()
      setSibuk(null)
    }
  }

  /**
   * Foto ditaruh di halaman kosong pertama sesudah isi (mode kertas) atau di
   * bawah isi (kanvas bebas), dimuat selebar 90% halaman, lalu layar dibawa ke
   * sana. Pertanyaan kedua dari anak yang sama jadi halaman berikutnya.
   */
  function tempelKeHalamanBaru(src: string, lebarAsli: number, tinggiAsli: number) {
    const isiAda = kotakSemua(coretanRef.current, gambarRef.current, objekRef.current, teksRef.current)
    let x0 = 0
    let y0 = 0
    let w = lebarAsli
    let h = tinggiAsli
    if (halaman.w > 0) {
      const slot = halaman.h + JARAK_HALAMAN
      const indeks = isiAda ? Math.floor(isiAda.y2 / slot) + 1 : 0
      const k = kotakHalaman(halaman, indeks)
      const skalaMuat = Math.min((halaman.w * 0.9) / lebarAsli, (halaman.h * 0.9) / tinggiAsli, 1)
      w = lebarAsli * skalaMuat
      h = tinggiAsli * skalaMuat
      x0 = k.x1 + (halaman.w - w) / 2
      y0 = k.y1 + 24
    } else {
      y0 = isiAda ? isiAda.y2 + 40 : 0
      const skalaMuat = Math.min(1, 900 / lebarAsli)
      w = lebarAsli * skalaMuat
      h = tinggiAsli * skalaMuat
    }
    const baru: Gambar = { id: newId('img'), layer: lapisan, x: x0, y: y0, w, h, src }
    setGambar((g) => [...g, baru])
    gambarRef.current = [...gambarRef.current, baru]
    if (src.length < 700_000) kirim({ t: 'ubah', idKanvas, tambah: { gambar: [baru] } })
    v.setTampilan((t) => ({ ...t, y: -(y0 - 24) * t.skala + 24 }))
    jadwalkanSimpan(coretanRef.current)
  }

  /**
   * Beberapa foto sekaligus (mis. dari galeri) ditempel ke satu halaman baru,
   * disusun sebagai kisi — bukan satu per halaman — supaya langsung terlihat
   * berdampingan dan siap dicoret bareng. Satu foto memakai jalur lama di atas.
   */
  function tempelBeberapaKeHalamanBaru(daftar: { src: string; w: number; h: number }[]) {
    if (daftar.length === 0) return
    if (daftar.length === 1) {
      tempelKeHalamanBaru(daftar[0].src, daftar[0].w, daftar[0].h)
      return
    }
    const isiAda = kotakSemua(coretanRef.current, gambarRef.current, objekRef.current, teksRef.current)
    const kolom = daftar.length <= 4 ? 2 : 3
    const gap = 16
    let lebarBlok: number
    let x0: number
    let y0: number
    if (halaman.w > 0) {
      const slot = halaman.h + JARAK_HALAMAN
      const indeks = isiAda ? Math.floor(isiAda.y2 / slot) + 1 : 0
      const k = kotakHalaman(halaman, indeks)
      lebarBlok = halaman.w * 0.9
      x0 = k.x1 + (halaman.w - lebarBlok) / 2
      y0 = k.y1 + 24
    } else {
      lebarBlok = 900
      x0 = 0
      y0 = isiAda ? isiAda.y2 + 40 : 0
    }
    const lebarSel = (lebarBlok - gap * (kolom - 1)) / kolom
    const baris = Math.ceil(daftar.length / kolom)
    const tinggiSelTarget = halaman.w > 0 ? (halaman.h * 0.9 - gap * (baris - 1)) / baris : 260

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
        baru.push({ id: newId('img'), layer: lapisan, x: x + (lebarSel - g.w) / 2, y: y + (tinggiBaris - g.h) / 2, w: g.w, h: g.h, src: g.src })
        x += lebarSel + gap
      }
      y += tinggiBaris + gap
    }
    setGambar((g) => [...g, ...baru])
    gambarRef.current = [...gambarRef.current, ...baru]
    const kecil = baru.filter((g) => g.src.length < 700_000)
    if (kecil.length) kirim({ t: 'ubah', idKanvas, tambah: { gambar: kecil } })
    v.setTampilan((t) => ({ ...t, y: -(y0 - 24) * t.skala + 24 }))
    jadwalkanSimpan(coretanRef.current)
  }

  /** Pasang instrumen di tengah pandangan, atau lepas kalau yang sama ditekan lagi. */
  function pasangInstrumen(jenis: JenisInstrumen) {
    if (instrumen?.jenis === jenis) {
      setInstrumen(null)
      return
    }
    const el = wadahRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const tengah = v.keDunia(r.left + r.width / 2, r.top + r.height / 2)
    setInstrumen(buatInstrumen(jenis, [tengah.x, tengah.y], r.width / v.tampilan.skala, r.height / v.tampilan.skala))
    beriTahu(
      jenis === 'penggaris'
        ? 'Ruler placed. Start a stroke on its top edge to draw straight.'
        : jenis === 'busur'
          ? 'Protractor placed. Draw along the arc, or from the centre to read an angle.'
          : 'Compass placed. Start a stroke at the pencil tip to draw an arc.',
    )
  }
  const [lapisan, setLapisan] = useState(0)
  const [lapisanInfo, setLapisanInfo] = useState<Lapisan[]>(lapisanBawaan)
  const [pilihan, setPilihan] = useState<Set<string>>(new Set())
  const [tekananTersedia, setTekananTersedia] = useState<boolean | null>(null)
  const [latar, setLatar] = useState<Latar>('polos')
  const [steady, setSteady] = useState(false)
  const [tahanBentuk, setTahanBentuk] = useState(true)
  const [disimpan, setDisimpan] = useState<number | null>(null)
  const [petunjuk, setPetunjuk] = useState<string | null>(null)
  const [kertas, setKertas] = useState<string>(KERTAS_BAWAAN)
  /** Sedang ada berkas yang diseret di atas jendela — tampilkan sasaran jatuhnya. */
  const [seretMasuk, setSeretMasuk] = useState(false)
  /** Penggaris / busur / jangka yang sedang terpasang; satu saja pada satu waktu. */
  const [instrumen, setInstrumen] = useState<Instrumen | null>(null)
  const seretInstrumen = useRef<Seretan | null>(null)
  /**
   * Gestur jari di tablet. Jari tidak pernah menggambar: satu jari menggeser,
   * dua jari mencubit. Menggambar adalah pekerjaan pena.
   */
  const sentuh = useRef(new Map<number, { x: number; y: number }>())
  const geserSentuh = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null)
  const cubit = useRef<{ jarak: number; tengah: { x: number; y: number }; awal: { skala: number; x: number; y: number } } | null>(null)
  /**
   * Ketukan dua jari untuk undo (konvensi Procreate) — tanpa menyentuh apa
   * pun yang sudah ada di atas: jari yang turun-diam-naik dengan cepat dan
   * tanpa geser dianggap ketukan, bukan cubit/geser.
   */
  const posisiTurunJari = useRef(new Map<number, { x: number; y: number }>())
  const gesturKetuk = useRef<{ mulai: number; maksJari: number; bergeser: boolean } | null>(null)
  /** Kapan pena terakhir menyentuh — telapak yang mendarat sesudahnya diabaikan. */
  const terakhirPena = useRef(0)
  const tampilanRef = useRef(v.tampilan)
  tampilanRef.current = v.tampilan
  /** Penyiaran langsung ke TV/tablet: sampai indeks berapa titik goresan sudah terkirim. */
  const terkirim = useRef(0)
  const objekTerkirim = useRef('')
  const kursorTerakhir = useRef(0)
  /** Kuncian goresan yang sedang ditarik di tepi instrumen. */
  const kuncianAktif = useRef<Kuncian | null>(null)
  /** Bacaan hidup (panjang / sudut) yang digambar di dekat ujung pena. */
  const bacaanRef = useRef<{ teks: string; x: number; y: number } | null>(null)
  /** Kenali bentuk saat pena diangkat, tanpa menahan. */
  const [autoBentuk, setAutoBentuk] = useState(false)
  /** Gambar tempelan (PDF, foto) kebal laso; grafik/tabel tetap bisa dipilih. */
  const [kunciGambar, setKunciGambar] = useState(true)
  /** Ketukan dua jari = undo (lihat setelanAlat.ts). Bisa dimatikan dari panel Goresan. */
  const [duaJariUndo, setDuaJariUndo] = useState(true)
  /**
   * Yang baru saja ditempel dikecualikan selama masih terpilih. Tanpa ini,
   * pesan "Pasted. Drag to move" berbohong: gambarnya digambar lengkap dengan
   * garis pilihan dan pegangan sudut, tapi laso melewatinya, jadi tak bergeser
   * sedikit pun. Sekali diklik di luar, ia ikut terkunci seperti tempelan lain.
   *
   * Syaratnya dua-duanya, bukan `g.id === gambarTerpilih` saja: pemanggil yang
   * sudah memegang gambar terpilih (mis. pegangan putar) selalu memenuhi paruh
   * itu, jadi pengecualiannya akan menelan penjaganya sendiri dan tempelan
   * terkunci ikut bisa diputar.
   */
  const bisaDipilihGambar = (g: Gambar) =>
    !kunciGambar || !!g.meta || (g.id === gambarBaruDitempel && g.id === gambarTerpilih)
  /** Editor sisipan yang sedang terbuka; `id` terisi saat menyunting yang sudah ada. */
  const [editorGrafik, setEditorGrafik] = useState<{ awal: DefinisiGrafik | null; id: string | null } | null>(null)
  const [editorTabel, setEditorTabel] = useState<{ awal: DefinisiTabel | null; id: string | null } | null>(null)
  const [jumlahHalaman, setJumlahHalaman] = useState(1)
  const [ukuranLayar, setUkuranLayar] = useState({ w: 0, h: 0 })
  const [urutanAlat, setUrutanAlat] = useState(URUTAN_BAWAAN)
  const [seretAlat, setSeretAlat] = useState<Alat | null>(null)
  const bilahRef = useRef<HTMLDivElement | null>(null)
  /**
   * Seretan bilah alat ditangani sendiri lewat pointer, bukan drag-and-drop
   * HTML5: Tauri menyalakan penanganan drop berkas asli, dan itu mematikan DnD
   * web di dalam webview macOS. Kanban di aplikasi ini memakai pustaka berbasis
   * pointer karena alasan yang sama.
   */
  const seretBilah = useRef<{ alat: Alat; x: number; y: number; geser: boolean } | null>(null)

  useEffect(() => {
    void muatUrutanAlat().then(setUrutanAlat)
  }, [])

  // Penangan tombol dipasang sekali; urutannya dibaca lewat ref supaya
  // menyusun ulang bilah alat tidak memasang ulang seluruh pendengar papan tik
  // di tengah orang menggambar.
  const urutanRef = useRef(urutanAlat)
  urutanRef.current = urutanAlat

  /** Slot bilah alat yang berada tepat di bawah titik layar ini. */
  function slotDiTitik(x: number, y: number): number | null {
    const wadah = bilahRef.current
    if (!wadah) return null
    const anak = Array.from(wadah.children) as HTMLElement[]
    for (let i = 0; i < anak.length; i++) {
      const r = anak[i].getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return i
    }
    return null
  }

  /** Penangan bersama untuk tombol di bilah maupun bentuk di katalog. */
  function pegangAlat(a: Alat) {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        seretBilah.current = { alat: a, x: e.clientX, y: e.clientY, geser: false }
      },
      onPointerMove: (e: React.PointerEvent) => {
        const s = seretBilah.current
        if (!s) return
        // Ambang kecil supaya ketukan biasa tidak pernah terbaca sebagai seretan.
        if (!s.geser && Math.hypot(e.clientX - s.x, e.clientY - s.y) < 6) return
        if (!s.geser) {
          s.geser = true
          setSeretAlat(s.alat)
        }
        const ke = slotDiTitik(e.clientX, e.clientY)
        if (ke !== null && urutanAlat[ke] !== s.alat) pindahAlat(s.alat, ke)
      },
      onPointerUp: (e: React.PointerEvent) => {
        const s = seretBilah.current
        seretBilah.current = null
        setSeretAlat(null)
        if (!s) return
        // Tanpa geser, ini ketukan biasa: pilih alatnya.
        if (!s.geser) setAlat(s.alat)
        else if (slotDiTitik(e.clientX, e.clientY) === null) beriTahu('Drop it on the bar to keep it there.')
      },
      onPointerCancel: () => {
        seretBilah.current = null
        setSeretAlat(null)
      },
    }
  }

  const pindahAlat = useCallback((alat: Alat, ke: number) => {
    setUrutanAlat((lama) => {
      const baru = taruhAlat(lama, alat, ke)
      void simpanUrutanAlat(baru)
      return baru
    })
  }, [])

  /**
   * ⌘P dipegang butir menu asli, bukan penangan tombol di halaman ini —
   * WKWebView tidak selalu meneruskan pintasan ber-Command ke web. Yang sampai
   * ke sini cuma penghitung permintaannya.
   */
  const mintaCetak = useApp((s) => s.cetakSketsa)
  const cetakTerlayani = useRef(mintaCetak)
  const [menuTampil, setMenuTampil] = useState(true)
  /** Daftar halaman di pojok kanan bawah bisa dilipat sendiri, terpisah dari rel alat. */
  const [daftarTampil, setDaftarTampil] = useState(true)
  const [sibuk, setSibuk] = useState<string | null>(null)

  const halaman = KERTAS.find((k) => k.id === kertas) ?? KERTAS[0]

  const shiftDitekan = useRef(false)

  /** Objek yang sedang ditarik, dan pegangan yang sedang diseret. */
  const objekBaru = useRef<Objek | null>(null)
  /* Tahan-untuk-bentuk. `bentukSnap` adalah pratinjau: ia baru jadi objek
     sungguhan saat pena diangkat, jadi menggerakkan tangan lagi cukup untuk
     membatalkannya tanpa menyentuh riwayat undo. */
  const bentukSnap = useRef<Objek | null>(null)
  const timerTahan = useRef<number | null>(null)
  const titikDiam = useRef<{ x: number; y: number } | null>(null)
  const kunciAlat: KunciAlat = alatTulis(alat) ? alat : alat === 'penghapus' ? 'penghapus' : 'pen'
  const setelanAktif = setelan[kunciAlat] ?? setelanBawaan(kunciAlat)
  const ukuran = setelanAktif.size

  function ubahSetelan(ubah: Partial<SetelanAlat>) {
    setSetelan((lama) => {
      const baru = { ...lama, [kunciAlat]: { ...setelanBawaan(kunciAlat), ...lama[kunciAlat], ...ubah } }
      void simpanSetelanAlat(baru)
      return baru
    })
  }

  const seretPutar = useRef<{ id: string; awal: number; sudutAwal: number } | null>(null)
  const seretPutarGambar = useRef<{ id: string; awal: number; sudutAwal: number } | null>(null)
  const seretObjek = useRef<{
    id: string
    /** -1 = menggeser seluruh objek; selain itu indeks titik kendali. */
    titik: number
    x: number
    y: number
  } | null>(null)

  /** Riwayat menyimpan coretan dan objek bersamaan — urung-langkah yang hanya
   *  mengembalikan separuh keadaan lebih membingungkan daripada tidak ada. */
  const riwayat = useRef<{ coretan: Coretan[]; objek: Objek[] }[]>([])
  const riwayatMaju = useRef<{ coretan: Coretan[]; objek: Objek[] }[]>([])
  const aktifCoretan = useRef<Coretan | null>(null)
  const jalurLaso = useRef<[number, number][]>([])
  /** Sudut pertama seretan laso kotak; laso bebas tidak memerlukannya. */
  const awalLaso = useRef<{ x: number; y: number } | null>(null)
  const geser = useRef<{ x: number; y: number } | null>(null)
  const seretTeks = useRef<{ id: string; x: number; y: number } | null>(null)
  const ketikRef = useRef<HTMLTextAreaElement | null>(null)
  /**
   * Penangan berkas terbaru, dipegang lewat ref.
   *
   * Pendengar drop dipasang sekali seumur komponen, tapi penempatan gambar
   * bergantung pada alat, lapisan, dan posisi layar saat itu — bukan saat
   * pendengarnya dipasang.
   */
  const terimaRef = useRef<(b: Blob | null) => Promise<void>>(async () => {})
  const seretGambar = useRef<{
    id: string
    mode: 'geser' | 'ukur'
    x: number
    y: number
    w: number
    h: number
  } | null>(null)
  const simpanTimer = useRef<number | null>(null)
  const panggang = useRef<{ bitmap: HTMLCanvasElement; kunci: string; sampai: number } | null>(null)
  /**
   * Sketsa ini sudah berhasil dibaca dari vault.
   *
   * Sebelum itu, TIDAK ADA yang boleh ditulis: keadaan awal komponen adalah
   * sketsa kosong, dan sekali saja kekosongan itu tersimpan, isi aslinya
   * hilang. Pembacaan yang gagal — jaringan putus, berkas rusak — membuat
   * sketsa terbuka hanya untuk dilihat, bukan untuk ditimpa.
   */
  const dimuat = useRef(false)
  /**
   * Data persis yang terakhir dimuat/diterapkan ke keadaan.
   *
   * Efek penyimpanan membandingkan referensinya: kalau lapisan, gambar, dan
   * objek masih array yang sama dengan yang dimuat, tidak ada yang berubah dan
   * tidak ada yang perlu disimpan. Ini menggantikan bendera sekali-pakai yang
   * bisa tertelan oleh pembaruan lain yang kebetulan terbatch bersamanya.
   */
  const snapshotDimuat = useRef<{ l: Lapisan[]; g: Gambar[]; o: Objek[] } | null>(null)
  /** Salinan terakhir yang dimuat/disimpan sisi ini — dasar penggabungan tiga arah. */
  const basisRef = useRef<BerkasKanvas | null>(null)
  /** Tepi bawah PDF yang baru diimpor, supaya PDF berikutnya dalam jatuhan yang sama tidak menumpuk. */
  const tepiBawahImpor = useRef(-Infinity)
  const coretanRef = useRef<Coretan[]>([])
  /** Goresan yang sedang ditarik editor lain di sketsa ini, dan ujung penanya. */
  const goresanJauh = useRef(new Map<string, Coretan>())
  const kursorJauh = useRef<{ x: number; y: number } | null>(null)

  /* ── Muat & simpan ─────────────────────────────────────────────── */

  useEffect(() => {
    let batal = false
    dimuat.current = false
    void bacaKanvas(idKanvas).then((b) => {
      if (batal) return
      if (!b) {
        beriTahu('This sketch could not be read. It is opened read-only so nothing gets overwritten.')
      }
      dimuat.current = b !== null
      basisRef.current = b
      tepiBawahImpor.current = -Infinity
      goresanJauh.current.clear()
      kursorJauh.current = null
      const gDimuat = b?.images ?? []
      const oDimuat = b?.objects ?? []
      const lDimuat = b?.layers ?? lapisanBawaan()
      snapshotDimuat.current = { l: lDimuat, g: gDimuat, o: oDimuat }
      setCoretan(b?.strokes ?? [])
      setGambar(gDimuat)
      setGambarTerpilih(null)
      setObjek(oDimuat)
      setObjekTerpilih(null)
      setTeks(b?.texts ?? [])
      setTeksTerpilih(null)
      setTeksDiubah(null)
      setLapisanInfo(lDimuat)
      setLapisan(0)
      setPilihan(new Set())
      const kertasIni = b?.paper ?? KERTAS_BAWAAN
      setKertas(kertasIni)
      // Pertanyaan murid yang menunggu kanvas ini terbuka: dikerjakan sesudah
      // render pertama, saat ref-ref isi sudah menunjuk ke data yang dimuat.
      // Jeda tetap (mis. 50ms) pernah dipakai di sini, tapi di tablet yang
      // memuat kanvas lewat Wi-Fi (bukan disk lokal seperti Mac) itu kadang
      // tidak cukup — foto sempat tertempel ke state yang belum sinkron dan
      // hilang tanpa galat saat tertimpa data yang baru selesai dimuat. Dua
      // requestAnimationFrame menjamin commit render sudah lewat, seberapa
      // pun lambat perangkatnya, bukan menebak angka yang "biasanya" cukup.
      const tertunda = useApp.getState().tempelanTertunda
      const bukaUntukBahas = !!(b && tertunda && tertunda.idKanvas === idKanvas)
      if (bukaUntukBahas) {
        useApp.getState().setTempelanTertunda(null)
        requestAnimationFrame(() => requestAnimationFrame(() => void kerjakanTempelan(tertunda)))
      }
      const jumlahHalamanBaru = Math.max(1, Math.round(b?.pages ?? 1))
      setJumlahHalaman(jumlahHalamanBaru)
      setDisimpan(b?.updated_at ?? null)
      panggang.current = null
      const k = KERTAS.find((x2) => x2.id === kertasIni)
      const el = wadahRef.current
      // Sedang membuka kanvas ini untuk membahas pertanyaan yang sudah pernah
      // dibahas (tanpa lampiran baru): langsung ke halaman terakhir, tempat
      // pembahasan terakhir kali berhenti — pakai jumlah halaman yang baru
      // saja dibaca di atas, bukan state React yang belum tentu segar di sini.
      if (bukaUntukBahas && !tertunda?.lampiran?.length && k && k.w > 0 && jumlahHalamanBaru > 1) {
        const kh = kotakHalaman(k, jumlahHalamanBaru - 1)
        v.setTampilan((t) => ({ ...t, y: -kh.y1 * t.skala + 24 }))
      } else if (k && k.w > 0 && el) {
        // Halaman pertama dibawa ke tengah layar dan dimuat penuh tingginya:
        // membuka sketsa seharusnya memperlihatkan kertasnya, bukan sudut kirinya.
        const r = el.getBoundingClientRect()
        const skala = Math.min(1.5, Math.max(0.3, (r.height - 56) / k.h))
        v.setTampilan({ skala, x: (r.width - k.w * skala) / 2, y: 24 })
      } else {
        v.setTampilan({ skala: 1, x: 0, y: 0 })
      }
    })
    return () => {
      batal = true
    }
  }, [idKanvas])

  /**
   * Lapisan disimpan lewat ref, bukan lewat dependency.
   *
   * `jadwalkanSimpan` dipanggil dari dalam handler pointer; kalau ia ikut
   * berubah setiap kali sebuah lapisan disembunyikan, seluruh rantai callback
   * menggambar ikut dibuat ulang di tengah goresan.
   */
  coretanRef.current = coretan
  const lapisanRef = useRef(lapisanInfo)
  lapisanRef.current = lapisanInfo
  const gambarRef = useRef(gambar)
  gambarRef.current = gambar
  const kertasRef = useRef(kertas)
  kertasRef.current = kertas
  const jumlahHalamanRef = useRef(jumlahHalaman)
  jumlahHalamanRef.current = jumlahHalaman
  const teksRef = useRef(teks)
  teksRef.current = teks
  const objekRef = useRef(objek)
  objekRef.current = objek

  const simpanSekarang = useCallback(
    async (isi: Coretan[]) => {
      if (simpanTimer.current) window.clearTimeout(simpanTimer.current)
      simpanTimer.current = null
      if (!dimuat.current) return
      const saat = Date.now()
      const saya = berkasBaru(
        idKanvas,
        judul,
        isi,
        lapisanRef.current,
        gambarRef.current,
        objekRef.current,
        teksRef.current,
        kertasRef.current,
        jumlahHalamanRef.current,
      )
      let tulis = saya
      // Kalau sisi lain sempat menyimpan sejak salinan ini dimuat, hasilnya
      // digabung dulu — bukan ditimpa. Ini yang membuat goresan dari tablet dan
      // dari Mac sama-sama bertahan.
      //
      // Dicek lewat SATU angka di SQLite dulu (sama seperti jaring pengaman
      // lima detik di bawah), bukan langsung bacaKanvas — sketsa puluhan
      // halaman bisa belasan MB, dan mem-parse seluruhnya cuma untuk
      // membandingkan satu stempel waktu (kasus paling umum: tidak ada sisi
      // lain yang menulis) berarti menahan thread utama tiap kali jeda
      // menulis berakhir. bacaKanvas yang mahal itu baru dipanggil kalau
      // angkanya memang berbeda.
      const basis = basisRef.current
      const baris = basis ? await q1<{ updated_at: number }>('SELECT updated_at FROM canvases WHERE id = ?', [idKanvas]).catch(() => null) : null
      if (baris && basis && baris.updated_at !== basis.updated_at) {
        const diVault = await bacaKanvas(idKanvas).catch(() => null)
        if (diVault && diVault.updated_at !== basis.updated_at) {
          tulis = { ...gabungkan(basis, saya, diVault), updated_at: saat }
          terapkanBerkas(tulis)
        }
      }
      await simpanKanvas(tulis)
      basisRef.current = tulis
      setDisimpan(saat)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idKanvas, judul],
  )

  /** Ganti seluruh keadaan dengan isi berkas — tanpa memicu penyimpanan ulang. */
  function terapkanBerkas(b: BerkasKanvas) {
    const gambarBaru = b.images ?? []
    const objekBaruSemua = b.objects ?? []
    const teksBaru = b.texts ?? []
    const lapisanBaru = b.layers ?? lapisanBawaan()
    snapshotDimuat.current = { l: lapisanBaru, g: gambarBaru, o: objekBaruSemua }
    setCoretan(b.strokes)
    setGambar(gambarBaru)
    setObjek(objekBaruSemua)
    setTeks(teksBaru)
    setLapisanInfo(lapisanBaru)
    setKertas(b.paper ?? KERTAS_BAWAAN)
    setJumlahHalaman(Math.max(1, Math.round(b.pages ?? 1)))
    coretanRef.current = b.strokes
    gambarRef.current = gambarBaru
    objekRef.current = objekBaruSemua
    teksRef.current = teksBaru
    lapisanRef.current = lapisanBaru
    kertasRef.current = b.paper ?? KERTAS_BAWAAN
    jumlahHalamanRef.current = Math.max(1, Math.round(b.pages ?? 1))
    panggang.current = null
    for (const c of b.strokes) goresanJauh.current.delete(c.id)
  }

  /**
   * Sisi lain baru saja menyimpan sketsa ini: ambil versinya dan gabungkan
   * dengan apa yang ada di layar. Kalau di sini ada simpanan yang tertunda,
   * simpanan itu dijalankan sekarang — ia sudah menggabungkan sendiri.
   */
  const muatUlangGabung = useCallback(async () => {
    if (!dimuat.current) return
    if (simpanTimer.current) {
      void simpanSekarang(coretanRef.current)
      return
    }
    const mereka = await bacaKanvas(idKanvas).catch(() => null)
    const basis = basisRef.current
    if (!mereka || !basis || mereka.updated_at === basis.updated_at) return
    const saya = berkasBaru(
      idKanvas,
      judul,
      coretanRef.current,
      lapisanRef.current,
      gambarRef.current,
      objekRef.current,
      teksRef.current,
      kertasRef.current,
      jumlahHalamanRef.current,
    )
    const hasil = gabungkan(basis, saya, mereka)
    basisRef.current = mereka
    terapkanBerkas(hasil)
    setDisimpan(mereka.updated_at)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idKanvas, judul, simpanSekarang])

  useEffect(
    () =>
      dengarkan('canvas', (payload) => {
        const p = payload as { id?: string; src?: string; hapus?: boolean } | null | undefined
        if (!p || p.id !== idKanvas || p.src === idKlien || p.hapus) return
        void muatUlangGabung()
      }),
    [idKanvas, muatUlangGabung],
  )

  const jadwalkanSimpan = useCallback(
    (isi: Coretan[]) => {
      if (!dimuat.current) return
      if (simpanTimer.current) window.clearTimeout(simpanTimer.current)
      simpanTimer.current = window.setTimeout(() => {
        simpanTimer.current = null
        void simpanSekarang(isi)
      }, JEDA_SIMPAN)
    },
    [simpanSekarang],
  )

  // Perubahan lapisan (nama, sembunyi, kunci) juga perlu ikut tersimpan.
  const pertamaLapisan = useRef(true)
  useEffect(() => {
    if (pertamaLapisan.current) {
      pertamaLapisan.current = false
      return
    }
    // Perubahan yang datang dari pemuatan sketsa bukan perubahan yang perlu
    // disimpan — dan dulu inilah jalur yang menimpa sketsa dengan salinan kosong.
    const d = snapshotDimuat.current
    if (d && d.l === lapisanInfo && d.g === gambar && d.o === objek) return
    jadwalkanSimpan(coretan)
    // Sengaja hanya bergantung pada tiga ini: reaksi terhadap perubahan
    // lapisan, gambar, dan objek — bukan terhadap setiap goresan baru.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lapisanInfo, gambar, objek])

  // Sketsa yang belum sempat tersimpan tidak boleh hilang saat berpindah
  // sketsa, berpindah modul, atau menutup window.
  useEffect(() => {
    return () => {
      if (simpanTimer.current) {
        window.clearTimeout(simpanTimer.current)
        simpanTimer.current = null
      }
    }
  }, [idKanvas])

  /**
   * Siarkan selisih dua keadaan ke layar lain sebagai operasi kecil.
   *
   * Menunggu simpanan lalu memuat ulang seluruh berkas berarti TV tertinggal
   * sedetik untuk tiap hapusan — dan pada sketsa berisi puluhan halaman PDF,
   * "sedetik" itu jadi beberapa detik. Id yang hilang dan butir yang berubah
   * cukup untuk TV dan tablet memperbarui gambarnya seketika; berkas menyusul.
   */
  const siarkanPerubahan = useCallback(
    (lamaC: Coretan[], baruC: Coretan[], lamaO: Objek[], baruO: Objek[]) => {
      const petaLamaC = new Map(lamaC.map((c) => [c.id, c]))
      const petaBaruC = new Map(baruC.map((c) => [c.id, c]))
      const petaLamaO = new Map(lamaO.map((o) => [o.id, o]))
      const petaBaruO = new Map(baruO.map((o) => [o.id, o]))
      const hapusC = lamaC.filter((c) => !petaBaruC.has(c.id)).map((c) => c.id)
      const hapusO = lamaO.filter((o) => !petaBaruO.has(o.id)).map((o) => o.id)
      const tambahC = baruC.filter((c) => petaLamaC.get(c.id) !== c)
      const tambahO = baruO.filter((o) => petaLamaO.get(o.id) !== o)
      if (hapusC.length + hapusO.length + tambahC.length + tambahO.length === 0) return
      // Perubahan raksasa (mis. mengosongkan lapisan berisi ribuan goresan)
      // dibiarkan lewat berkas saja; pesan langsung dijaga tetap kecil.
      if (tambahC.length > 300) return
      kirim({
        t: 'ubah',
        idKanvas,
        hapus: { coretan: hapusC, objek: hapusO },
        tambah: { coretan: tambahC, objek: tambahO },
      })
    },
    [idKanvas],
  )

  const terapkan = useCallback(
    (berikut: Coretan[], berikutObjek?: Objek[]) => {
      riwayat.current.push({ coretan, objek })
      if (riwayat.current.length > 60) riwayat.current.shift()
      riwayatMaju.current = []
      setCoretan(berikut)
      if (berikutObjek) setObjek(berikutObjek)
      siarkanPerubahan(coretan, berikut, objek, berikutObjek ?? objek)
      jadwalkanSimpan(berikut)
    },
    [coretan, objek, jadwalkanSimpan, siarkanPerubahan],
  )

  const urungkan = useCallback(() => {
    const lalu = riwayat.current.pop()
    if (!lalu) return
    riwayatMaju.current.push({ coretan, objek })
    setCoretan(lalu.coretan)
    setObjek(lalu.objek)
    objekRef.current = lalu.objek
    panggang.current = null
    siarkanPerubahan(coretan, lalu.coretan, objek, lalu.objek)
    jadwalkanSimpan(lalu.coretan)
  }, [coretan, objek, jadwalkanSimpan, siarkanPerubahan])

  const ulangi = useCallback(() => {
    const maju = riwayatMaju.current.pop()
    if (!maju) return
    riwayat.current.push({ coretan, objek })
    setCoretan(maju.coretan)
    setObjek(maju.objek)
    objekRef.current = maju.objek
    panggang.current = null
    siarkanPerubahan(coretan, maju.coretan, objek, maju.objek)
    jadwalkanSimpan(maju.coretan)
  }, [coretan, objek, jadwalkanSimpan, siarkanPerubahan])

  const gambarDasarRef = useRef<(() => void) | null>(null)
  const timerPetunjuk = useRef<number | null>(null)

  /** Pesan sekilas di sudut kanvas — tidak memakai toast global karena ini
   *  hanya relevan selama mata masih di kanvas. */
  const beriTahu = useCallback((teks: string) => {
    setPetunjuk(teks)
    if (timerPetunjuk.current) window.clearTimeout(timerPetunjuk.current)
    timerPetunjuk.current = window.setTimeout(() => setPetunjuk(null), 2600)
  }, [])

  /* ── Menggambar ────────────────────────────────────────────────── */

  const siapkanKanvas = useCallback((el: HTMLCanvasElement | null) => {
    if (!el) return null
    const dpr = window.devicePixelRatio || 1
    const kotak = el.getBoundingClientRect()
    const w = Math.max(1, Math.round(kotak.width * dpr))
    const h = Math.max(1, Math.round(kotak.height * dpr))
    if (el.width !== w || el.height !== h) {
      el.width = w
      el.height = h
    }
    const ctx = el.getContext('2d')
    if (!ctx) return null
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return ctx
  }, [])

  const terlihat = useCallback(
    (c: Coretan) => lapisanInfo[c.layer]?.tampak ?? true,
    [lapisanInfo],
  )

  /**
   * Boleh disentuh penghapus, laso, dan seret.
   *
   * Lapisan terkunci sengaja tetap terlihat tapi kebal: itu seluruh gunanya —
   * menjadikan satu lapisan sebagai jiplakan yang tidak bisa tergores tanpa
   * sengaja saat menggambar di atasnya.
   */
  const bisaDiubah = useCallback(
    (c: Coretan) => {
      const l = lapisanInfo[c.layer]
      return (l?.tampak ?? true) && !(l?.kunci ?? false)
    },
    [lapisanInfo],
  )

  /**
   * Latar kertas digambar tiap bingkai, bukan dipanggang bersama coretan —
   * jumlah garisnya selalu sebanyak layar, tidak pernah sebanyak sketsa, jadi
   * menggambarnya ulang jauh lebih murah daripada menyimpannya.
   */
  const gambarLatar = useCallback(
    (ctx: CanvasRenderingContext2D, lebar: number, tinggi: number) => {
      const { skala, x, y } = v.tampilan

      // Halaman digambar lebih dulu: ia jadi alas putih tempat petak dan
      // coretan berdiri, bukan bingkai yang ditumpuk di atasnya.
      if (halaman.w > 0) {
        ctx.save()
        ctx.translate(x, y)
        ctx.scale(skala, skala)
        ctx.lineWidth = 1 / skala
        ctx.textAlign = 'right'
        ctx.font = `${11 / skala}px ui-monospace, monospace`
        for (let i = 0; i < jumlahHalaman; i++) {
          const k = kotakHalaman(halaman, i)
          // Halaman di luar layar dilewati: satu sketsa boleh punya puluhan
          // halaman, dan yang tidak terlihat tidak perlu digambar tiap bingkai.
          if (k.y2 * skala + y < -20 || k.y1 * skala + y > tinggi + 20) continue
          ctx.fillStyle = warnaToken('paper')
          ctx.fillRect(k.x1, k.y1, halaman.w, halaman.h)
          ctx.strokeStyle = warnaToken('line-strong')
          ctx.strokeRect(k.x1, k.y1, halaman.w, halaman.h)
          if (jumlahHalaman > 1 && skala > 0.22) {
            ctx.fillStyle = warnaToken('ink-faint')
            ctx.fillText(`${i + 1}/${jumlahHalaman}`, k.x2, k.y2 + 26 / skala)
          }
        }
        ctx.restore()
      }

      if (latar === 'polos') return
      // Di bawah 45% zoom, petaknya rapat jadi bubur — dilipatgandakan.
      const jarak = PETAK * skala < 14 ? PETAK * 4 : PETAK * skala < 26 ? PETAK * 2 : PETAK
      const x1 = Math.floor(-x / skala / jarak) * jarak
      const y1 = Math.floor(-y / skala / jarak) * jarak
      const x2 = x1 + lebar / skala + jarak
      const y2 = y1 + tinggi / skala + jarak

      ctx.save()
      ctx.translate(x, y)
      ctx.scale(skala, skala)
      // Di mode kertas, petaknya berhenti di tepi halaman. Petak yang meluber
      // ke luar kertas membuat halaman berhenti terbaca sebagai halaman.
      if (halaman.w > 0) {
        ctx.beginPath()
        for (let i = 0; i < jumlahHalaman; i++) {
          const k = kotakHalaman(halaman, i)
          ctx.rect(k.x1, k.y1, halaman.w, halaman.h)
        }
        ctx.clip()
      }
      ctx.strokeStyle = warnaToken('line')
      ctx.fillStyle = warnaToken('line-strong')
      ctx.lineWidth = 1 / skala

      if (latar === 'titik') {
        const r = 1.2 / skala
        for (let gx = x1; gx < x2; gx += jarak) {
          for (let gy = y1; gy < y2; gy += jarak) {
            ctx.beginPath()
            ctx.arc(gx, gy, r, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      } else {
        ctx.beginPath()
        for (let gy = y1; gy < y2; gy += jarak) {
          ctx.moveTo(x1, gy)
          ctx.lineTo(x2, gy)
        }
        if (latar === 'kotak') {
          for (let gx = x1; gx < x2; gx += jarak) {
            ctx.moveTo(gx, y1)
            ctx.lineTo(gx, y2)
          }
        }
        ctx.stroke()
      }
      ctx.restore()
    },
    [latar, v.tampilan, halaman, jumlahHalaman],
  )

  const gambarDasar = useCallback(() => {
    const ctx = siapkanKanvas(dasarRef.current)
    const el = dasarRef.current
    if (!ctx || !el) return
    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, el.width / dpr, el.height / dpr)
    gambarLatar(ctx, el.width / dpr, el.height / dpr)

    // Tempelan selalu di bawah coretan, apa pun urutan pembuatannya: yang
    // ditempel adalah alas, yang digambar adalah anotasi di atasnya.
    ctx.save()
    ctx.translate(v.tampilan.x, v.tampilan.y)
    ctx.scale(v.tampilan.skala, v.tampilan.skala)
    for (const g of gambar) {
      if (!(lapisanInfo[g.layer]?.tampak ?? true)) continue
      gambarTempelan(ctx, g, () => gambarDasarRef.current?.())
      if (g.id === gambarTerpilih) {
        const sudut = sudutGambar(g)
        ctx.save()
        ctx.strokeStyle = warnaToken('accent')
        ctx.lineWidth = 1.5 / v.tampilan.skala
        ctx.setLineDash([6 / v.tampilan.skala, 4 / v.tampilan.skala])
        ctx.beginPath()
        ctx.moveTo(sudut[0][0], sudut[0][1])
        for (const [px, py] of sudut.slice(1)) ctx.lineTo(px, py)
        ctx.closePath()
        ctx.stroke()
        ctx.setLineDash([])

        // Pegangan ubah-ukuran menempel di sudut kanan bawah gambar, jadi ia
        // ikut berpindah saat gambarnya diputar — bukan tetap di kanan bawah layar.
        const p = PEGANGAN / v.tampilan.skala
        ctx.fillStyle = warnaToken('accent')
        ctx.save()
        ctx.translate(sudut[2][0], sudut[2][1])
        ctx.rotate(g.putar ?? 0)
        ctx.fillRect(-p, -p, p, p)
        ctx.restore()

        const [rx, ry] = peganganPutarGambar(g, v.tampilan.skala)
        const tengahAtas: [number, number] = [
          (sudut[0][0] + sudut[1][0]) / 2,
          (sudut[0][1] + sudut[1][1]) / 2,
        ]
        ctx.globalAlpha = 0.55
        ctx.strokeStyle = warnaToken('accent')
        ctx.lineWidth = 1.3 / v.tampilan.skala
        ctx.beginPath()
        ctx.moveTo(tengahAtas[0], tengahAtas[1])
        ctx.lineTo(rx, ry)
        ctx.stroke()
        ctx.globalAlpha = 1
        ctx.beginPath()
        ctx.arc(rx, ry, (TITIK_KENDALI * 0.8) / v.tampilan.skala, 0, Math.PI * 2)
        ctx.fillStyle = warnaToken('accent')
        ctx.fill()
        ctx.lineWidth = 1.6 / v.tampilan.skala
        ctx.strokeStyle = warnaToken('bg')
        ctx.stroke()
        ctx.restore()
      }
    }
    ctx.restore()

    const kunci = `${v.tampilan.skala.toFixed(4)}:${Math.round(v.tampilan.x)}:${Math.round(v.tampilan.y)}:${lapisanInfo.map((l) => (l.tampak ? '1' : '0')).join('')}`

    // Kotak dunia yang benar-benar terlihat di layar saat ini, dengan sedikit
    // marjin. Sketsa dengan puluhan halaman gampang punya ribuan goresan di
    // halaman yang sedang tidak dilihat — baik saat dipanggang (tiap pan/zoom
    // mengubah "kunci" di atas dan memaksa panggang ulang) maupun saat
    // digambar langsung di bawah ambang panggang — jadi goresan yang kotaknya
    // tidak menyentuh layar dilewati sama seperti halaman di gambarLatar.
    const margin = 40 / v.tampilan.skala
    const layarX1 = (0 - v.tampilan.x) / v.tampilan.skala - margin
    const layarY1 = (0 - v.tampilan.y) / v.tampilan.skala - margin
    const layarX2 = (el.width / dpr - v.tampilan.x) / v.tampilan.skala + margin
    const layarY2 = (el.height / dpr - v.tampilan.y) / v.tampilan.skala + margin
    const terlihatLayar = (c: Coretan) => {
      const k = kotakCoretan(c)
      return k.x2 >= layarX1 && k.x1 <= layarX2 && k.y2 >= layarY1 && k.y1 <= layarY2
    }

    // Coretan lama dipanggang sekali jadi bitmap seukuran layar; selama pan/zoom
    // tidak berubah, menambah goresan baru tidak menggambar ulang semuanya.
    if (coretan.length > AMBANG_PANGGANG) {
      const batas = coretan.length - SISA_HIDUP
      const perluPanggang =
        !panggang.current || panggang.current.kunci !== kunci || panggang.current.sampai !== batas

      if (perluPanggang) {
        const bitmap = document.createElement('canvas')
        bitmap.width = el.width
        bitmap.height = el.height
        const bctx = bitmap.getContext('2d')
        if (bctx) {
          bctx.setTransform(dpr, 0, 0, dpr, 0, 0)
          bctx.translate(v.tampilan.x, v.tampilan.y)
          bctx.scale(v.tampilan.skala, v.tampilan.skala)
          for (let i = 0; i < batas; i++) {
            if (terlihat(coretan[i]) && terlihatLayar(coretan[i])) gambarCoretan(bctx, coretan[i])
          }
        }
        panggang.current = { bitmap, kunci, sampai: batas }
      }

      const dipanggang = panggang.current
      if (dipanggang) {
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.drawImage(dipanggang.bitmap, 0, 0)
        ctx.restore()
      }

      ctx.save()
      ctx.translate(v.tampilan.x, v.tampilan.y)
      ctx.scale(v.tampilan.skala, v.tampilan.skala)
      for (let i = batas; i < coretan.length; i++) {
        if (terlihat(coretan[i]) && terlihatLayar(coretan[i])) gambarCoretan(ctx, coretan[i])
      }
      ctx.restore()
      gambarSemuaObjek(ctx)
      return
    }

    panggang.current = null
    ctx.save()
    ctx.translate(v.tampilan.x, v.tampilan.y)
    ctx.scale(v.tampilan.skala, v.tampilan.skala)
    for (const c of coretan) {
      if (!terlihat(c) || !terlihatLayar(c)) continue
      gambarCoretan(ctx, c)
      if (pilihan.has(c.id)) {
        ctx.save()
        ctx.strokeStyle = warnaToken('accent')
        ctx.globalAlpha = 0.5
        ctx.lineWidth = 1 / v.tampilan.skala
        ctx.stroke(jalurDari(garisLuar(c)))
        ctx.restore()
      }
    }
    {
      // Bingkai putus-putus mengelilingi pilihan: pegangan untuk menyeretnya.
      const k = kotakPilihan()
      if (k) {
        ctx.save()
        ctx.strokeStyle = warnaToken('accent')
        ctx.lineWidth = 1.5 / v.tampilan.skala
        ctx.setLineDash([6 / v.tampilan.skala, 4 / v.tampilan.skala])
        ctx.strokeRect(k.x1, k.y1, k.x2 - k.x1, k.y2 - k.y1)
        ctx.fillStyle = warnaToken('accent')
        ctx.globalAlpha = 0.05
        ctx.fillRect(k.x1, k.y1, k.x2 - k.x1, k.y2 - k.y1)
        ctx.restore()
      }
    }
    ctx.restore()
    gambarSemuaObjek(ctx)
    gambarSemuaTeks(ctx)

    /** Tulisan yang diketik, digambar di atas segalanya seperti anotasi. */
    function gambarSemuaTeks(c2: CanvasRenderingContext2D) {
      c2.save()
      c2.translate(v.tampilan.x, v.tampilan.y)
      c2.scale(v.tampilan.skala, v.tampilan.skala)
      for (const t of teks) {
        if (!(lapisanInfo[t.layer]?.tampak ?? true)) continue
        // Yang sedang diketik tidak digambar di kanvas: kotak ketiknya sendiri
        // sudah menampilkan hurufnya, dan dua salinan yang bertumpuk membuat
        // tulisannya terlihat tebal sebelah.
        if (t.id === teksDiubah) continue
        gambarTeks(c2, t)
        if (t.id !== teksTerpilih) continue
        const k = kotakTeks(t)
        c2.save()
        c2.strokeStyle = warnaToken('accent')
        c2.globalAlpha = 0.5
        c2.lineWidth = 1 / v.tampilan.skala
        c2.setLineDash([5 / v.tampilan.skala, 4 / v.tampilan.skala])
        c2.strokeRect(k.x1 - 3, k.y1 - 2, k.x2 - k.x1 + 6, k.y2 - k.y1 + 4)
        c2.restore()
      }
      c2.restore()
    }

    /** Objek geometri + pegangan titik sudut milik yang sedang terpilih. */
    function gambarSemuaObjek(c2: CanvasRenderingContext2D) {
      c2.save()
      c2.translate(v.tampilan.x, v.tampilan.y)
      c2.scale(v.tampilan.skala, v.tampilan.skala)
      const fontLabel = `${Math.max(13, 14 / v.tampilan.skala)}px ui-monospace, monospace`
      for (const o of objek) {
        if (!(lapisanInfo[o.layer]?.tampak ?? true)) continue
        gambarObjek(c2, o, warnaToken(o.color), fontLabel)
        if (o.id !== objekTerpilih) continue

        const k = kotakObjek(o)
        c2.save()
        c2.strokeStyle = warnaToken('accent')
        c2.globalAlpha = 0.4
        c2.lineWidth = 1 / v.tampilan.skala
        c2.setLineDash([5 / v.tampilan.skala, 4 / v.tampilan.skala])
        c2.strokeRect(k.x1, k.y1, k.x2 - k.x1, k.y2 - k.y1)
        c2.setLineDash([])
        c2.restore()

        // Pegangan: lingkaran isi warna aksen dengan tepi warna latar, supaya
        // tetap terlihat di atas garis segelap apa pun.
        const r = TITIK_KENDALI / v.tampilan.skala
        const bulat = (px: number, py: number, jari: number) => {
          c2.beginPath()
          c2.arc(px, py, jari, 0, Math.PI * 2)
          c2.fillStyle = warnaToken('accent')
          c2.fill()
          c2.lineWidth = 1.6 / v.tampilan.skala
          c2.strokeStyle = warnaToken('bg')
          c2.stroke()
        }
        for (const [px, py] of titikTampak(o)) bulat(px, py, r)

        // Pegangan putar: batangnya digambar supaya jelas ia milik bentuk ini,
        // bukan titik kendali yang kebetulan melayang di dekatnya.
        const [gx, gy] = peganganPutar(o, v.tampilan.skala)
        const poros = porosObjek(o)
        const pangkal = putarSekitar(
          [poros[0], Math.min(...o.titik.map((t) => t[1]))],
          poros,
          o.putar ?? 0,
        )
        c2.save()
        c2.strokeStyle = warnaToken('accent')
        c2.globalAlpha = 0.55
        c2.lineWidth = 1.3 / v.tampilan.skala
        c2.beginPath()
        c2.moveTo(pangkal[0], pangkal[1])
        c2.lineTo(gx, gy)
        c2.stroke()
        c2.restore()
        bulat(gx, gy, r * 0.8)
      }
      c2.restore()
    }
  }, [
    coretan,
    gambar,
    gambarTerpilih,
    objek,
    objekTerpilih,
    teks,
    teksTerpilih,
    teksDiubah,
    v.tampilan,
    siapkanKanvas,
    terlihat,
    lapisanInfo,
    pilihan,
    gambarLatar,
  ])

  const gambarAktif = useCallback(() => {
    const ctx = siapkanKanvas(aktifRef.current)
    const el = aktifRef.current
    if (!ctx || !el) return
    const dpr = window.devicePixelRatio || 1
    ctx.clearRect(0, 0, el.width / dpr, el.height / dpr)
    ctx.save()
    ctx.translate(v.tampilan.x, v.tampilan.y)
    ctx.scale(v.tampilan.skala, v.tampilan.skala)

    // Begitu bentuk terkunci, coretan mentahnya berhenti digambar — melihat
    // keduanya bertumpuk membuat hasilnya terasa belum tentu.
    if (bentukSnap.current) {
      gambarObjek(
        ctx,
        bentukSnap.current,
        warnaToken(bentukSnap.current.color),
        `${Math.max(13, 14 / v.tampilan.skala)}px ui-monospace, monospace`,
      )
    } else if (aktifCoretan.current) {
      gambarCoretan(ctx, aktifCoretan.current)
    }
    if (objekBaru.current) {
      gambarObjek(
        ctx,
        objekBaru.current,
        warnaToken(objekBaru.current.color),
        `${Math.max(13, 14 / v.tampilan.skala)}px ui-monospace, monospace`,
      )
    }

    if (jalurLaso.current.length > 1) {
      ctx.strokeStyle = warnaToken('accent')
      ctx.setLineDash([6 / v.tampilan.skala, 5 / v.tampilan.skala])
      ctx.lineWidth = 1.4 / v.tampilan.skala
      ctx.beginPath()
      ctx.moveTo(jalurLaso.current[0][0], jalurLaso.current[0][1])
      for (const [x, y] of jalurLaso.current.slice(1)) ctx.lineTo(x, y)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Yang sedang ditarik editor lain (tablet ↔ Mac) tampil seketika, jauh
    // sebelum tersimpan; kursornya jadi penunjuk kecil berwarna aksen.
    for (const c of goresanJauh.current.values()) if (c.points.length > 1) gambarCoretan(ctx, c)
    const kj = kursorJauh.current
    if (kj) {
      ctx.beginPath()
      ctx.arc(kj.x, kj.y, 4 / v.tampilan.skala, 0, Math.PI * 2)
      ctx.fillStyle = warnaToken('accent')
      ctx.globalAlpha = 0.8
      ctx.fill()
      ctx.globalAlpha = 1
    }

    if (instrumen) gambarInstrumen(ctx, instrumen, v.tampilan.skala)

    // Bacaan hidup: panjang di penggaris, sudut di busur, jari-jari di jangka.
    const b = bacaanRef.current
    if (b) {
      const s = v.tampilan.skala
      ctx.font = `${12 / s}px ui-monospace, monospace`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const lebar = ctx.measureText(b.teks).width + 12 / s
      ctx.fillStyle = warnaToken('accent')
      ctx.beginPath()
      // roundRect belum ada di WebKit macOS 11; kotak biasa cukup di sana.
      if (typeof ctx.roundRect === 'function') ctx.roundRect(b.x + 14 / s, b.y - 22 / s, lebar, 20 / s, 5 / s)
      else ctx.rect(b.x + 14 / s, b.y - 22 / s, lebar, 20 / s)
      ctx.fill()
      ctx.fillStyle = warnaToken('bg')
      ctx.fillText(b.teks, b.x + 20 / s, b.y - 12 / s)
    }
    ctx.restore()
    kirimLangsung()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siapkanKanvas, v.tampilan, instrumen])

  /* ── Penyiaran ke layar lain (TV, tablet) ───────────────────────── */

  // Pandangan: tiap kali bergeser, plus denyut pelan supaya TV yang baru
  // menyala langsung tahu harus menampilkan apa. Denyutnya ditandai tidak
  // aktif, jadi Mac yang diam tidak merebut layar dari tablet yang sedang dipakai.
  useEffect(() => {
    kirim({ t: 'pandangan', idKanvas, tampilan: v.tampilan, layar: ukuranLayar })
  }, [v.tampilan, ukuranLayar, idKanvas])
  const ukuranLayarRef = useRef(ukuranLayar)
  ukuranLayarRef.current = ukuranLayar
  useEffect(() => {
    const t = window.setInterval(
      () => kirim({ t: 'pandangan', aktif: false, idKanvas, tampilan: tampilanRef.current, layar: ukuranLayarRef.current }),
      4000,
    )
    return () => window.clearInterval(t)
  }, [idKanvas])
  useEffect(() => {
    kirim({ t: 'instrumen', idKanvas, i: instrumen })
  }, [instrumen, idKanvas])


  // Instrumen digambar di lapisan aktif, jadi ia harus ikut digambar ulang saat
  // dipasang, digeser, atau saat kanvas di-pan — bukan hanya di tengah goresan.
  useEffect(() => {
    gambarAktif()
  }, [gambarAktif])

  useEffect(() => {
    gambarDasarRef.current = gambarDasar
    gambarDasar()
  }, [gambarDasar])

  useEffect(() => {
    const onResize = () => {
      panggang.current = null
      gambarDasar()
      gambarAktif()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [gambarDasar, gambarAktif])

  /* ── Input pen ─────────────────────────────────────────────────── */

  /**
   * Penghapus di pena: ujung belakang Wacom (button 5 / buttons 32), dan
   * tombol samping S Pen yang ditahan (barrel: button 2 / buttons & 2) —
   * Chrome Android melaporkannya sebagai tombol sekunder, bukan penghapus.
   */
  function alatEfektif(e: React.PointerEvent): Alat {
    if (e.pointerType !== 'pen') return alat
    if (e.button === 5 || (e.buttons & 32) !== 0) return 'penghapus'
    if (e.button === 2 || (e.buttons & 2) !== 0) return 'penghapus'
    return alat
  }

  function tekananDari(e: PointerEvent | React.PointerEvent): number {
    if (e.pointerType === 'pen') {
      // Driver Wacom yang belum terpasang membuat pressure selalu 0.5.
      return e.pressure > 0 ? e.pressure : 0.5
    }
    return 0.5
  }

  /* ── Tahan untuk bentuk ────────────────────────────────────────── */

  function batalTahan() {
    if (timerTahan.current) window.clearTimeout(timerTahan.current)
    timerTahan.current = null
  }

  /** Mulai hitung mundur diam; dipanggil ulang tiap kali tangan bergerak. */
  function jadwalkanTahan() {
    batalTahan()
    if (!tahanBentuk) return
    timerTahan.current = window.setTimeout(kunciBentuk, JEDA_TAHAN)
  }

  /** Pena sudah diam cukup lama — coba baca coretannya sebagai bentuk. */
  function kunciBentuk() {
    timerTahan.current = null
    const c = aktifCoretan.current
    // Setelan bisa dimatikan setelah hitung mundur ini dijadwalkan.
    if (!c || !tahanBentuk) return
    // Ambang ukuran dihitung di satuan dunia: yang menentukan "terlalu kecil"
    // adalah seberapa kecil di mata, bukan angka koordinatnya.
    const tebak = kenaliBentuk(c.points, 24 / v.tampilan.skala)
    if (!tebak) return
    bentukSnap.current = {
      id: newId('obj'),
      jenis: tebak.jenis,
      layer: c.layer,
      color: c.color,
      size: Math.max(1.5, ukuran * 0.55),
      titik: tebak.titik,
      putar: tebak.putar,
    }
    const nama = OBJEK.find((o) => o.id === tebak.jenis)?.label.toLowerCase() ?? 'shape'
    beriTahu(`Snapped to a ${nama}. Lift the pen to keep it — ⌘Z undoes it.`)
    gambarAktif()
    kirimLangsung()
  }

  /** Mulai (atau susun ulang) gestur dari jari-jari yang sedang menyentuh. */
  function mulaiGestur() {
    const jari = Array.from(sentuh.current.values())
    const t = tampilanRef.current
    if (jari.length >= 2) {
      const [a, b] = jari
      cubit.current = {
        jarak: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        tengah: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        awal: { skala: t.skala, x: t.x, y: t.y },
      }
      geserSentuh.current = null
    } else if (jari.length === 1) {
      geserSentuh.current = { x: jari[0].x, y: jari[0].y, tx: t.x, ty: t.y }
      cubit.current = null
    } else {
      geserSentuh.current = null
      cubit.current = null
    }
  }

  /**
   * Siarkan yang sedang terjadi ke layar lain: titik goresan yang belum
   * terkirim, dan bentuk yang sedang ditarik. Dipanggil tiap bingkai gambar;
   * kalau tidak ada yang berubah, tidak ada yang dikirim.
   */
  function kirimLangsung() {
    const c = aktifCoretan.current
    if (c && c.points.length > terkirim.current) {
      // Meta goresan ikut tiap kiriman: TV yang menyambung di tengah goresan
      // tetap bisa menggambarnya tanpa menunggu goresan berikutnya.
      const { points: _abaikan, ...meta } = c
      void _abaikan
      kirim({ t: 'titik', idKanvas, id: c.id, dari: terkirim.current, titik: c.points.slice(terkirim.current), meta })
      terkirim.current = c.points.length
    }
    const o = objekBaru.current ?? bentukSnap.current
    const kunci = o ? JSON.stringify(o) : ''
    if (kunci !== objekTerkirim.current) {
      objekTerkirim.current = kunci
      kirim({ t: 'objek', idKanvas, o })
    }
  }

  const turun = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'pen') terakhirPena.current = performance.now()
    if (e.pointerType === 'touch') {
      if (performance.now() - terakhirPena.current < 700 || aktifCoretan.current) return
      e.currentTarget.setPointerCapture(e.pointerId)
      if (sentuh.current.size === 0) {
        gesturKetuk.current = { mulai: performance.now(), maksJari: 1, bergeser: false }
      } else if (gesturKetuk.current) {
        gesturKetuk.current.maksJari = Math.max(gesturKetuk.current.maksJari, sentuh.current.size + 1)
      }
      posisiTurunJari.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      sentuh.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      mulaiGestur()
      return
    }
    if (v.spasiDitekan || e.button === 1) {
      v.mulaiGeser(e)
      return
    }
    // Tombol 2 hanya diterima dari pena (tombol samping S Pen); klik kanan
    // mouse tetap tidak menggambar apa pun.
    if (e.button !== 0 && e.button !== 5 && !(e.button === 2 && e.pointerType === 'pen')) return

    // Kotak ketik yang terbuka ditutup oleh ketukan berikutnya di kanvas.
    // Dulu ini bersandar pada peristiwa blur, dan itu justru sumber
    // masalahnya: pointer-up di kanvas mencuri fokus tepat sesudah kotaknya
    // dibuat, jadi tulisan yang belum sempat diketik langsung terhapus karena
    // dianggap kosong.
    if (teksDiubah) selesaiKetik()

    e.currentTarget.setPointerCapture(e.pointerId)
    const d = v.keDunia(e.clientX, e.clientY)
    const efektif = alatEfektif(e)

    if (e.pointerType === 'pen' && tekananTersedia === null) {
      setTekananTersedia(e.pressure > 0 && e.pressure !== 0.5)
    }

    // Pegangan dan badan instrumen menang atas alat apa pun: penggaris yang
    // tidak bisa digeser karena pena sedang aktif bukan penggaris.
    if (instrumen) {
      const mode = kenaInstrumen(instrumen, [d.x, d.y], v.tampilan.skala)
      if (mode) {
        seretInstrumen.current = { mode, awal: [d.x, d.y], asal: instrumen }
        return
      }
    }

    if (efektif === 'penghapus') {
      hapusDi(d.x, d.y)
      aktifCoretan.current = null
      return
    }

    // Titik kendali objek terpilih ditangkap lebih dulu, apa pun alat yang
    // sedang aktif. Sesudah sebuah bentuk terkunci lewat "hold to shape",
    // tangan masih memegang pena; menuntut ganti alat dulu hanya untuk menggeser
    // satu sudut akan memutus alurnya. Sasarannya kecil dan hanya milik objek
    // yang memang sudah terpilih, jadi menggambar biasa tidak terganggu.
    const terpilihKini = objek.find((o) => o.id === objekTerpilih)
    if (
      terpilihKini &&
      (lapisanInfo[terpilihKini.layer]?.tampak ?? true) &&
      !(lapisanInfo[terpilihKini.layer]?.kunci ?? false)
    ) {
      const r = (TITIK_KENDALI + 4) / v.tampilan.skala
      const [gx, gy] = peganganPutar(terpilihKini, v.tampilan.skala)
      if (Math.hypot(gx - d.x, gy - d.y) <= r) {
        const poros = porosObjek(terpilihKini)
        seretPutar.current = {
          id: terpilihKini.id,
          awal: Math.atan2(d.y - poros[1], d.x - poros[0]),
          sudutAwal: terpilihKini.putar ?? 0,
        }
        return
      }
      const idx = titikTampak(terpilihKini).findIndex(
        ([px, py]) => Math.hypot(px - d.x, py - d.y) <= r,
      )
      if (idx !== -1) {
        seretObjek.current = { id: terpilihKini.id, titik: idx, x: d.x, y: d.y }
        return
      }
    }

    // Pegangan gambar terpilih (foto pertanyaan, halaman PDF) — sama seperti
    // objek di atas, ditangkap lebih dulu apa pun alat yang aktif. Memutar
    // foto yang salah orientasi atau membetulkan ukuran halaman PDF tidak
    // seharusnya memutus alur menulis dengan pena hanya untuk ganti ke Laso.
    const gambarKini = gambar.find((g) => g.id === gambarTerpilih)
    if (
      gambarKini &&
      bisaDipilihGambar(gambarKini) &&
      (lapisanInfo[gambarKini.layer]?.tampak ?? true) &&
      !(lapisanInfo[gambarKini.layer]?.kunci ?? false)
    ) {
      const [rx, ry] = peganganPutarGambar(gambarKini, v.tampilan.skala)
      if (Math.hypot(rx - d.x, ry - d.y) <= (TITIK_KENDALI + 4) / v.tampilan.skala) {
        const poros = porosGambar(gambarKini)
        seretPutarGambar.current = {
          id: gambarKini.id,
          awal: Math.atan2(d.y - poros[1], d.x - poros[0]),
          sudutAwal: gambarKini.putar ?? 0,
        }
        return
      }
      const pg = PEGANGAN / v.tampilan.skala
      const [pgx, pgy] = sudutGambar(gambarKini)[2]
      if (Math.hypot(pgx - d.x, pgy - d.y) <= pg) {
        seretGambar.current = { id: gambarKini.id, mode: 'ukur', x: d.x, y: d.y, w: gambarKini.w, h: gambarKini.h }
        return
      }
    }

    // Lapisan terkunci menolak goresan baru; yang tersembunyi dimunculkan
    // kembali, karena menggambar ke tempat yang tak terlihat selalu tidak
    // disengaja.
    const sasaran = lapisanInfo[lapisan]
    if (sasaran?.kunci) {
      beriTahu(`${sasaran.nama} is locked.`)
      return
    }
    if (sasaran && !sasaran.tampak) {
      setLapisanInfo((l) => l.map((x2, i) => (i === lapisan ? { ...x2, tampak: true } : x2)))
      beriTahu(`${sasaran.nama} shown again — you were drawing on it.`)
    }

    if (efektif === 'teks') {
      const baru: Teks = {
        id: newId('txt'),
        layer: lapisan,
        x: d.x,
        y: d.y,
        size: Math.max(13, ukuran * 3.2),
        color: warna,
        isi: '',
      }
      setTeks((lama) => [...lama, baru])
      setTeksTerpilih(baru.id)
      setTeksDiubah(baru.id)
      setPilihan(new Set())
      setObjekTerpilih(null)
      setGambarTerpilih(null)
      return
    }

    if (alatObjek(efektif)) {
      objekBaru.current = {
        id: newId('obj'),
        jenis: efektif,
        layer: lapisan,
        color: warna,
        size: Math.max(1.5, ukuran * 0.55),
        titik: titikAwal(efektif, d, d),
      }
      gambarAktif()
      return
    }

    if (efektif === 'laso' || efektif === 'lasoKotak') {
      // Tulisan diuji lebih dulu: ia digambar paling atas, jadi ia juga yang
      // pantas tersentuh lebih dulu.
      const teksKenaIni = [...teks]
        .reverse()
        .find(
          (t) =>
            (lapisanInfo[t.layer]?.tampak ?? true) &&
            !(lapisanInfo[t.layer]?.kunci ?? false) &&
            teksKena(t, d.x, d.y),
        )
      if (teksKenaIni) {
        // Ketukan pertama memilih, ketukan berikutnya membuka kotak ketik —
        // menggeser tulisan jauh lebih sering daripada menyuntingnya.
        if (teksTerpilih === teksKenaIni.id) {
          setTeksDiubah(teksKenaIni.id)
          return
        }
        setTeksTerpilih(teksKenaIni.id)
        setObjekTerpilih(null)
        setGambarTerpilih(null)
        setPilihan(new Set())
        seretTeks.current = { id: teksKenaIni.id, x: d.x, y: d.y }
        return
      }
      setTeksTerpilih(null)

      const objKena = [...objek]
        .reverse()
        .find(
          (o) =>
            (lapisanInfo[o.layer]?.tampak ?? true) &&
            !(lapisanInfo[o.layer]?.kunci ?? false) &&
            objekKena(o, d.x, d.y, 8 / v.tampilan.skala),
        )
      if (objKena) {
        setObjekTerpilih(objKena.id)
        setGambarTerpilih(null)
        setPilihan(new Set())
        seretObjek.current = { id: objKena.id, titik: -1, x: d.x, y: d.y }
        return
      }
      setObjekTerpilih(null)

      // Pegangan gambar (putar/ukur) sudah ditangkap lebih dulu di atas, apa
      // pun alat yang aktif — di sini tinggal urusan pemilihan gambar baru.

      // Gambar teratas yang kena, pada lapisan yang terlihat dan tidak terkunci.
      // Saat gambar dikunci, halaman PDF dan foto dilewati: laso jatuh ke
      // coretan di atasnya, jadi halamannya tidak ikut tergeser.
      const kena = [...gambar]
        .reverse()
        .find(
          (g) =>
            bisaDipilihGambar(g) &&
            (lapisanInfo[g.layer]?.tampak ?? true) &&
            !(lapisanInfo[g.layer]?.kunci ?? false) &&
            gambarKena(g, d.x, d.y),
        )
      if (kena) {
        // Ketukan kedua pada grafik atau tabel yang sudah terpilih membuka
        // penyusunnya lagi — sama seperti tulisan yang diketik.
        if (kena.meta && gambarTerpilih === kena.id) {
          bukaEditorGambar(kena)
          return
        }
        setGambarTerpilih(kena.id)
        setPilihan(new Set())
        seretGambar.current = { id: kena.id, mode: 'geser', x: d.x, y: d.y, w: kena.w, h: kena.h }
        return
      }
      setGambarTerpilih(null)

      if (pilihan.size > 0 && adaPilihanDiTitik(d.x, d.y)) {
        geser.current = { x: d.x, y: d.y }
        return
      }
      awalLaso.current = { x: d.x, y: d.y }
      jalurLaso.current = [[d.x, d.y]]
      setPilihan(new Set())
      gambarAktif()
      return
    }

    // Goresan yang dimulai di tepi instrumen dikunci ke tepi itu sepanjang
    // tarikannya — seperti pena yang ditempelkan ke penggaris sungguhan.
    const kuncian = instrumen ? kuncianDi(instrumen, [d.x, d.y], v.tampilan.skala) : null
    kuncianAktif.current = kuncian
    let awal: [number, number] = [d.x, d.y]
    if (kuncian) {
      const { q, bacaan } = kunciKeInstrumen(kuncian, awal)
      awal = q
      bacaanRef.current = { teks: bacaan, x: q[0], y: q[1] }
    }

    aktifCoretan.current = {
      id: newId('sk'),
      tool: efektif as AlatTulis,
      color: warna,
      size: efektif === 'spidol' ? ukuran * 2.6 : ukuran,
      layer: lapisan,
      alpha: setelanAktif.alpha,
      pola: setelanAktif.pola,
      // Goresan terkunci sudah lurus atau bulat sempurna; perataan tangan
      // hanya akan menariknya menjauh dari tepi yang dikuncinya.
      steady: kuncian ? false : steady,
      points: [[awal[0], awal[1], tekananDari(e)]],
    }
    terkirim.current = 0
    kirim({ t: 'goresan', idKanvas, c: { ...aktifCoretan.current, points: [] } })
    // Mulai menggambar lagi berarti sudah selesai dengan bentuk sebelumnya —
    // titik-titiknya ikut hilang, bukan menggantung di atas coretan baru.
    if (objekTerpilih) setObjekTerpilih(null)
    // Begitu anotasi dimulai, tempelan yang baru ditaruh kembali jadi alas:
    // pilihannya dilepas, jadi kuncinya berlaku lagi dan gambarnya tidak
    // ikut tergeser oleh sentuhan berikutnya.
    if (gambarTerpilih) setGambarTerpilih(null)
    titikDiam.current = { x: e.clientX, y: e.clientY }
    // Tahan-untuk-bentuk tidak berlaku di tepi instrumen: garisnya sudah garis.
    if (!kuncian) jadwalkanTahan()
    gambarAktif()
  }

  /**
   * Satu penggambaran per bingkai layar, bukan per peristiwa pointer.
   *
   * Wacom mengirim sampel jauh lebih rapat daripada layar bisa menampilkannya;
   * menggambar ulang pada tiap peristiwa berarti sebagian besar hasilnya
   * ditimpa sebelum sempat terlihat. Menyerahkan waktunya ke `requestAnimationFrame`
   * membuat kerjanya sepadan dengan yang benar-benar tampak.
   */
  const bingkaiAktif = useRef<number | null>(null)

  const mintaGambarAktif = useCallback(() => {
    if (bingkaiAktif.current !== null) return
    bingkaiAktif.current = window.requestAnimationFrame(() => {
      bingkaiAktif.current = null
      gambarAktif()
    })
  }, [gambarAktif])

  useEffect(
    () => () => {
      if (bingkaiAktif.current !== null) cancelAnimationFrame(bingkaiAktif.current)
    },
    [],
  )

  useEffect(
    () =>
      dengarkanLangsung((p) => {
        // Server memberi tahu sambungan ini sempat tertinggal: goresan murid
        // yang terlewat sudah ada di simpanan, ambil dari sana.
        if (p.t === 'tertinggal') {
          void muatUlangGabung()
          return
        }
        if (p.idKanvas !== idKanvas) return
        const peta = goresanJauh.current
        switch (p.t) {
          case 'goresan': {
            const c = p.c as Coretan
            peta.set(c.id, { ...c, points: [...c.points] })
            break
          }
          case 'titik': {
            let c = peta.get(p.id as string)
            if (!c && p.meta) {
              c = { ...(p.meta as Omit<Coretan, 'points'>), points: [] }
              peta.set(c.id, c)
            }
            if (!c) return
            const dari = p.dari as number
            c.points.length = Math.min(c.points.length, dari)
            c.points.push(...(p.titik as [number, number, number][]))
            break
          }
          case 'goresan-selesai':
            if (p.batal) peta.delete(p.id as string)
            break
          case 'kursor':
            kursorJauh.current = typeof p.x === 'number' ? { x: p.x as number, y: p.y as number } : null
            break
          case 'ubah': {
            // Terapkan langsung ke keadaan lokal; berkasnya menyusul lewat
            // penggabungan saat sisi lain selesai menyimpan.
            const hapus = (p.hapus ?? {}) as { coretan?: string[]; objek?: string[]; teks?: string[]; gambar?: string[] }
            const tambah = (p.tambah ?? {}) as { coretan?: Coretan[]; objek?: Objek[]; gambar?: Gambar[] }
            const hc = new Set(hapus.coretan ?? [])
            const ho = new Set(hapus.objek ?? [])
            const ht = new Set(hapus.teks ?? [])
            const hg = new Set(hapus.gambar ?? [])
            if (hg.size || tambah.gambar?.length) {
              setGambar((lama) => {
                const hasil = lama.filter((g) => !hg.has(g.id))
                const ada = new Set(hasil.map((g) => g.id))
                for (const g of tambah.gambar ?? []) if (!ada.has(g.id)) hasil.push(g)
                return hasil
              })
            }
            for (const id of hc) peta.delete(id)
            if (hc.size || tambah.coretan?.length) {
              setCoretan((lama) => {
                const petaBaru = new Map((tambah.coretan ?? []).map((c) => [c.id, c]))
                const hasil = lama.filter((c) => !hc.has(c.id)).map((c) => petaBaru.get(c.id) ?? c)
                const ada = new Set(hasil.map((c) => c.id))
                for (const c of tambah.coretan ?? []) if (!ada.has(c.id)) hasil.push(c)
                return hasil
              })
              panggang.current = null
            }
            if (ho.size || tambah.objek?.length) {
              setObjek((lama) => {
                const petaBaru = new Map((tambah.objek ?? []).map((o) => [o.id, o]))
                const hasil = lama.filter((o) => !ho.has(o.id)).map((o) => petaBaru.get(o.id) ?? o)
                const ada = new Set(hasil.map((o) => o.id))
                for (const o of tambah.objek ?? []) if (!ada.has(o.id)) hasil.push(o)
                return hasil
              })
            }
            if (ht.size) setTeks((lama) => lama.filter((t) => !ht.has(t.id)))
            break
          }
          default:
            return
        }
        mintaGambarAktif()
      }),
    [idKanvas, mintaGambarAktif, muatUlangGabung],
  )

  // Jaring pengaman: tiap lima detik cocokkan stempel waktu di database. Kalau
  // sisi lain menyimpan dan pesannya sempat terlewat (Wi-Fi putus sebentar),
  // sketsa tetap menyusul. Yang dibaca hanya satu angka, bukan berkasnya.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!dimuat.current || simpanTimer.current || aktifCoretan.current) return
      void q1<{ updated_at: number }>('SELECT updated_at FROM canvases WHERE id = ?', [idKanvas])
        .then((baris) => {
          if (baris && basisRef.current && baris.updated_at !== basisRef.current.updated_at) void muatUlangGabung()
        })
        .catch(() => {})
    }, 5000)
    return () => window.clearInterval(t)
  }, [idKanvas, muatUlangGabung])

  const bergerak = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'pen') terakhirPena.current = performance.now()
    if (e.pointerType === 'touch') {
      if (!sentuh.current.has(e.pointerId)) return
      sentuh.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (gesturKetuk.current && !gesturKetuk.current.bergeser) {
        const td = posisiTurunJari.current.get(e.pointerId)
        if (td && Math.hypot(e.clientX - td.x, e.clientY - td.y) > AMBANG_GESER_KETUK) {
          gesturKetuk.current.bergeser = true
        }
      }
      const jari = Array.from(sentuh.current.values())
      if (cubit.current && jari.length >= 2) {
        const [a, b] = jari
        const c = cubit.current
        const jarak = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
        const rasio = Math.min(4 / c.awal.skala, Math.max(0.12 / c.awal.skala, jarak / c.jarak))
        const tengah = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const kotak = wadahRef.current?.getBoundingClientRect()
        const ox = c.tengah.x - (kotak?.left ?? 0)
        const oy = c.tengah.y - (kotak?.top ?? 0)
        // Titik dunia yang tadinya di bawah tengah dua jari tetap di bawahnya.
        v.setTampilan({
          skala: c.awal.skala * rasio,
          x: tengah.x - c.tengah.x + ox - (ox - c.awal.x) * rasio,
          y: tengah.y - c.tengah.y + oy - (oy - c.awal.y) * rasio,
        })
      } else if (geserSentuh.current && jari.length === 1) {
        const g = geserSentuh.current
        v.setTampilan((t) => ({ ...t, x: g.tx + (e.clientX - g.x), y: g.ty + (e.clientY - g.y) }))
      }
      return
    }

    // Ujung pena sebagai penunjuk di TV — juga saat melayang tanpa menggores.
    const kini = performance.now()
    if (kini - kursorTerakhir.current > 40) {
      kursorTerakhir.current = kini
      const d = v.keDunia(e.clientX, e.clientY)
      kirim({ t: 'kursor', idKanvas, x: d.x, y: d.y })
    }

    if (v.sedangGeser) {
      v.lanjutGeser(e)
      return
    }

    if (seretInstrumen.current) {
      const d = v.keDunia(e.clientX, e.clientY)
      setInstrumen(terapkanSeret(seretInstrumen.current, [d.x, d.y]))
      return
    }

    if (objekBaru.current) {
      const d = v.keDunia(e.clientX, e.clientY)
      const o = objekBaru.current
      const awal = { x: o.titik[0][0], y: o.titik[0][1] }
      o.titik = titikAwal(o.jenis, awal, d)
      if (e.shiftKey || shiftDitekan.current) o.titik = kunciTitik(o.jenis, o.titik, 1)
      mintaGambarAktif()
      return
    }

    if (seretPutar.current) {
      const sp = seretPutar.current
      const d = v.keDunia(e.clientX, e.clientY)
      setObjek((lama) =>
        lama.map((o) => {
          if (o.id !== sp.id) return o
          const poros = porosObjek(o)
          const sekarang = Math.atan2(d.y - poros[1], d.x - poros[0])
          let sudut = sp.sudutAwal + (sekarang - sp.awal)
          // Shift mengunci ke kelipatan 15°, sama seperti saat menarik garis.
          if (e.shiftKey || shiftDitekan.current) {
            const langkah = Math.PI / 12
            sudut = Math.round(sudut / langkah) * langkah
          }
          return { ...o, putar: sudut }
        }),
      )
      return
    }

    if (seretObjek.current) {
      const so = seretObjek.current
      const d = v.keDunia(e.clientX, e.clientY)
      const dx = d.x - so.x
      const dy = d.y - so.y
      so.x = d.x
      so.y = d.y
      setObjek((lama) =>
        lama.map((o) => {
          if (o.id !== so.id) return o
          if (so.titik === -1) return geserObjek(o, dx, dy)
          // Titik kendali disimpan tanpa putaran, jadi posisi pointer harus
          // dikembalikan dulu ke ruang bentuk lurusnya.
          const lurus = keLurus(o, [d.x, d.y])
          const titik = o.titik.map((t, i) => (i === so.titik ? lurus : t)) as [number, number][]
          return {
            ...o,
            titik: e.shiftKey || shiftDitekan.current ? kunciTitik(o.jenis, titik, so.titik) : titik,
          }
        }),
      )
      return
    }

    if (seretTeks.current) {
      const st = seretTeks.current
      const d = v.keDunia(e.clientX, e.clientY)
      const dx = d.x - st.x
      const dy = d.y - st.y
      st.x = d.x
      st.y = d.y
      setTeks((lama) => lama.map((t) => (t.id === st.id ? geserTeks(t, dx, dy) : t)))
      return
    }

    if (seretPutarGambar.current) {
      const sp = seretPutarGambar.current
      const d = v.keDunia(e.clientX, e.clientY)
      setGambar((lama) =>
        lama.map((g) => {
          if (g.id !== sp.id) return g
          const poros = porosGambar(g)
          const sekarang = Math.atan2(d.y - poros[1], d.x - poros[0])
          let sudut = sp.sudutAwal + (sekarang - sp.awal)
          if (e.shiftKey || shiftDitekan.current) {
            const langkah = Math.PI / 12
            sudut = Math.round(sudut / langkah) * langkah
          }
          return { ...g, putar: sudut }
        }),
      )
      return
    }

    if (seretGambar.current) {
      const sg = seretGambar.current
      const d = v.keDunia(e.clientX, e.clientY)
      const dx = d.x - sg.x
      const dy = d.y - sg.y
      setGambar((lama) =>
        lama.map((g) => {
          if (g.id !== sg.id) return g
          if (sg.mode === 'geser') return { ...g, x: g.x + dx, y: g.y + dy }
          // Ubah ukuran menjaga rasio: tangkapan layar yang gepeng selalu salah.
          // Geseran pointer diproyeksikan ke sumbu gambar dulu, supaya menarik
          // pegangan pada gambar yang diputar terasa searah dengan tepinya.
          const th = g.putar ?? 0
          const dxLokal = dx * Math.cos(-th) - dy * Math.sin(-th)
          const rasio = sg.h / sg.w
          const w = Math.max(24, sg.w + dxLokal)
          return { ...g, w, h: w * rasio }
        }),
      )
      if (sg.mode === 'geser') {
        sg.x = d.x
        sg.y = d.y
      }
      return
    }

    if (geser.current) {
      const d = v.keDunia(e.clientX, e.clientY)
      const dx = d.x - geser.current.x
      const dy = d.y - geser.current.y
      geser.current = { x: d.x, y: d.y }
      setCoretan((lama) =>
        lama.map((c) => (pilihan.has(c.id) ? geserCoretan(c, dx, dy) : c)),
      )
      panggang.current = null
      return
    }

    if (jalurLaso.current.length > 0) {
      const d = v.keDunia(e.clientX, e.clientY)
      const awal = awalLaso.current
      if (alat === 'lasoKotak' && awal) {
        // Persegi panjangnya disimpan sebagai poligon empat sudut, bukan sebagai
        // jenis pilihan tersendiri: seluruh jalur sesudah ini — menggambar
        // pratinjau, menguji coretan mana yang masuk, membereskan saat pena
        // diangkat — jadi tetap satu dan tidak perlu bercabang.
        jalurLaso.current = [
          [awal.x, awal.y],
          [d.x, awal.y],
          [d.x, d.y],
          [awal.x, d.y],
          [awal.x, awal.y],
        ]
      } else {
        jalurLaso.current.push([d.x, d.y])
      }
      mintaGambarAktif()
      return
    }

    if (alatEfektif(e) === 'penghapus' && e.buttons !== 0) {
      const d = v.keDunia(e.clientX, e.clientY)
      hapusDi(d.x, d.y)
      return
    }

    const c = aktifCoretan.current
    if (!c) return

    // Bentuk yang sudah terkunci bertahan. Dulu gerakan berikutnya
    // membatalkannya kembali jadi coretan tangan, dan itu salah: menahan pena
    // sampai bentuknya muncul adalah keputusan yang sudah diambil — tangan yang
    // bergeser sedikit setelahnya bukan pembatalan, cuma tangan yang bergeser.
    if (bentukSnap.current) return

    // Wacom mengirim jauh lebih banyak sampel daripada frame rate layar.
    // Tanpa getCoalescedEvents, garis cepat akan patah-patah.
    const native = e.nativeEvent
    const sampel =
      typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [native]

    const kuncian = kuncianAktif.current
    for (const s of sampel) {
      const d = v.keDunia(s.clientX, s.clientY)
      if (kuncian) {
        const { q, bacaan } = kunciKeInstrumen(kuncian, [d.x, d.y])
        // Titiknya tetap rapat seperti goresan biasa, walau semuanya segaris:
        // penghapus, laso, dan pemotong bekerja per titik, dan garis yang
        // cuma punya dua ujung tidak bisa disentuh di tengahnya.
        c.points.push([q[0], q[1], tekananDari(s)])
        bacaanRef.current = { teks: bacaan, x: q[0], y: q[1] }
        continue
      }
      c.points.push([d.x, d.y, tekananDari(s)])
    }

    // Diukur di piksel layar, bukan dunia: yang dinilai adalah tangan yang
    // berhenti, dan itu tidak berubah artinya saat kanvas di-zoom.
    const diam = titikDiam.current
    const bergeser = !diam || Math.hypot(e.clientX - diam.x, e.clientY - diam.y) > AMBANG_DIAM
    if (bergeser) {
      titikDiam.current = { x: e.clientX, y: e.clientY }
      jadwalkanTahan()
    }
    mintaGambarAktif()
  }

  const naik = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') {
      sentuh.current.delete(e.pointerId)
      posisiTurunJari.current.delete(e.pointerId)
      mulaiGestur()
      // Jari terakhir baru saja terangkat: nilai apakah gesturnya tadi
      // ketukan dua jari yang cepat dan tanpa geser (ala Procreate) — bukan
      // cubit atau geser pandangan.
      if (sentuh.current.size === 0 && gesturKetuk.current) {
        const g = gesturKetuk.current
        gesturKetuk.current = null
        if (duaJariUndo && !g.bergeser && g.maksJari === 2 && performance.now() - g.mulai < AMBANG_DURASI_KETUK) {
          urungkan()
          beriTahu('Undo')
        }
      }
      return
    }
    if (bingkaiAktif.current !== null) {
      cancelAnimationFrame(bingkaiAktif.current)
      bingkaiAktif.current = null
    }
    if (v.sedangGeser) {
      v.selesaiGeser()
      return
    }

    if (seretInstrumen.current) {
      seretInstrumen.current = null
      return
    }

    if (objekBaru.current) {
      const o = objekBaru.current
      objekBaru.current = null
      const k = kotakObjek(o)
      // Sekali ketuk tanpa menarik tidak meninggalkan bentuk sebesar nol.
      if (k.x2 - k.x1 < 6 && k.y2 - k.y1 < 6) {
        gambarAktif()
        return
      }
      terapkan(coretan, [...objek, o])
      setObjekTerpilih(o.id)
      setAlat('laso')
      beriTahu('Drag the dots to reshape it. It stays editable.')
      gambarAktif()
      return
    }

    if (seretPutar.current) {
      seretPutar.current = null
      jadwalkanSimpan(coretan)
      return
    }

    if (seretObjek.current) {
      seretObjek.current = null
      jadwalkanSimpan(coretan)
      return
    }

    if (seretTeks.current) {
      seretTeks.current = null
      jadwalkanSimpan(coretan)
      return
    }

    if (seretPutarGambar.current) {
      seretPutarGambar.current = null
      jadwalkanSimpan(coretan)
      return
    }

    if (seretGambar.current) {
      seretGambar.current = null
      jadwalkanSimpan(coretan)
      return
    }

    if (geser.current) {
      geser.current = null
      jadwalkanSimpan(coretan)
      return
    }

    awalLaso.current = null
    if (jalurLaso.current.length > 2) {
      const poligon = jalurLaso.current
      const terpilih = new Set(
        coretan.filter((c) => bisaDiubah(c) && coretanDalamLaso(c, poligon)).map((c) => c.id),
      )
      setPilihan(terpilih)
      jalurLaso.current = []
      gambarAktif()
      return
    }
    jalurLaso.current = []

    batalTahan()
    titikDiam.current = null
    const bentuk = bentukSnap.current
    bentukSnap.current = null

    const c = aktifCoretan.current
    aktifCoretan.current = null
    if (!c || c.points.length < 2) {
      if (c) kirim({ t: 'goresan-selesai', idKanvas, id: c.id, batal: true })
      gambarAktif()
      return
    }
    // Sisa titik yang belum sempat terkirim menyusul sebelum penutupnya.
    kirimLangsung()
    const terkunci = kuncianAktif.current !== null
    kuncianAktif.current = null
    bacaanRef.current = null
    if (bentuk) {
      // Coretan aslinya dibuang, bukan disimpan di bawah bentuk: yang diminta
      // adalah bentuknya, dan satu ⌘Z mengembalikan kanvas ke sebelum goresan.
      terapkan(coretan, [...objek, bentuk])
      setObjekTerpilih(bentuk.id)
      kirim({ t: 'goresan-selesai', idKanvas, id: c.id, batal: true })
      beriTahu('Drag the dots to resize it · ⌫ deletes it · draw again to move on.')
      gambarAktif()
      return
    }
    // Bentuk otomatis: sama seperti tahan-untuk-bentuk, tapi tanpa menunggu.
    // Goresan di tepi instrumen dibiarkan sebagai tinta — itu memang tinta yang
    // diminta, dan bentuknya sudah dijamin instrumennya.
    if (autoBentuk && !terkunci && c.points.length >= 8) {
      const tebak = kenaliBentuk(c.points, 24 / v.tampilan.skala)
      if (tebak) {
        const obj: Objek = {
          id: newId('obj'),
          jenis: tebak.jenis,
          layer: c.layer,
          color: c.color,
          size: Math.max(1.5, ukuran * 0.55),
          titik: tebak.titik,
          putar: tebak.putar,
        }
        terapkan(coretan, [...objek, obj])
        setObjekTerpilih(obj.id)
        kirim({ t: 'goresan-selesai', idKanvas, id: c.id, batal: true })
        gambarAktif()
        return
      }
    }
    terapkan([...coretan, c])
    kirim({ t: 'goresan-selesai', idKanvas, id: c.id })
    gambarAktif()
  }

  function hapusDi(x: number, y: number) {
    const sisaTeks = teks.filter(
      (t) =>
        !(
          (lapisanInfo[t.layer]?.tampak ?? true) &&
          !(lapisanInfo[t.layer]?.kunci ?? false) &&
          teksKena(t, x, y)
        ),
    )
    if (sisaTeks.length !== teks.length) {
      const sisaId = new Set(sisaTeks.map((t) => t.id))
      kirim({ t: 'ubah', idKanvas, hapus: { teks: teks.filter((t) => !sisaId.has(t.id)).map((t) => t.id) } })
      setTeks(sisaTeks)
      setTeksTerpilih(null)
      jadwalkanSimpan(coretan)
    }
    const radius = setelanAktif.size / 2
    // Sebagian: goresan dipotong di tempat yang tersentuh dan sisanya tetap
    // hidup. Goresan: satu sentuhan membuang goresan utuh — masih yang tercepat
    // untuk membereskan coretan yang memang salah seluruhnya.
    const sisa =
      modePenghapus === 'sebagian'
        ? coretan.flatMap((c) => (bisaDiubah(c) ? potongCoretan(c, x, y, radius) : [c]))
        : coretan.filter((c) => !(bisaDiubah(c) && coretanKena(c, x, y, radius)))
    const sisaObjek = objek.filter(
      (o) =>
        !(
          (lapisanInfo[o.layer]?.tampak ?? true) &&
          !(lapisanInfo[o.layer]?.kunci ?? false) &&
          objekKena(o, x, y, radius)
        ),
    )
    if (sisa.length !== coretan.length || sisaObjek.length !== objek.length) {
      panggang.current = null
      terapkan(sisa, sisaObjek)
    }
  }

  /**
   * Salinan dari yang sedang terpilih, digeser sedikit dan langsung jadi
   * pilihan baru — jadi ⌘D berkali-kali menghasilkan deretan, bukan tumpukan
   * di satu tempat.
   */
  const duplikat = useCallback(() => {
    if (objekTerpilih) {
      const asal = objek.find((o) => o.id === objekTerpilih)
      if (asal) {
        const salinan = { ...geserObjek(asal, 18, 18), id: newId('obj') }
        terapkan(coretan, [...objek, salinan])
        setObjekTerpilih(salinan.id)
      }
      return
    }
    if (pilihan.size === 0) return
    const salinan = coretan
      .filter((c) => pilihan.has(c.id))
      .map((c) => ({ ...geserCoretan(c, 18, 18), id: newId('sk') }))
    terapkan([...coretan, ...salinan])
    setPilihan(new Set(salinan.map((c) => c.id)))
    panggang.current = null
  }, [coretan, objek, objekTerpilih, pilihan, terapkan])

  /** Pindahkan yang terpilih ke lapisan yang sedang aktif. */
  const pindahKeLapisan = useCallback(
    (tujuan: number) => {
      if (pilihan.size === 0) return
      terapkan(coretan.map((c) => (pilihan.has(c.id) ? { ...c, layer: tujuan } : c)))
      panggang.current = null
      beriTahu(`Moved ${pilihan.size} stroke${pilihan.size === 1 ? '' : 's'} to ${lapisanInfo[tujuan]?.nama}.`)
    },
    [coretan, pilihan, terapkan, lapisanInfo, beriTahu],
  )

  /** Kosongkan satu lapisan tanpa menyentuh lapisan lain. */
  const kosongkanLapisan = useCallback(
    (i: number) => {
      const sisa = coretan.filter((c) => c.layer !== i)
      const sisaObjek = objek.filter((o) => o.layer !== i)
      if (sisa.length === coretan.length && sisaObjek.length === objek.length) return
      terapkan(sisa, sisaObjek)
      setPilihan(new Set())
      setObjekTerpilih(null)
      panggang.current = null
      beriTahu(`${lapisanInfo[i]?.nama} cleared.`)
    },
    [coretan, objek, terapkan, lapisanInfo, beriTahu],
  )

  /** Perbesar/perkecil sampai seluruh sketsa muat di layar, dengan sedikit margin. */
  const muatSemua = useCallback(() => {
    const dasar = kotakSemua(
      coretan.filter(terlihat),
      gambar.filter((g) => lapisanInfo[g.layer]?.tampak ?? true),
      [],
      teks.filter((t) => lapisanInfo[t.layer]?.tampak ?? true),
    )
    // Kalau halaman dipilih, ia yang jadi acuan — "muat" berarti melihat satu
    // halaman penuh, bukan sekadar isi yang kebetulan sudah tergambar.
    const kotakKertas =
      halaman.w > 0
        ? { x1: 0, y1: 0, x2: halaman.w, y2: kotakHalaman(halaman, jumlahHalaman - 1).y2 }
        : null
    const objekTampak = objek.filter((o) => lapisanInfo[o.layer]?.tampak ?? true)
    const kotakObj = objekTampak.map(kotakObjek)
    const semua = [dasar, kotakKertas, ...kotakObj].filter(Boolean) as {
      x1: number
      y1: number
      x2: number
      y2: number
    }[]
    const kotak =
      semua.length === 0
        ? null
        : {
            x1: Math.min(...semua.map((k) => k.x1)),
            y1: Math.min(...semua.map((k) => k.y1)),
            x2: Math.max(...semua.map((k) => k.x2)),
            y2: Math.max(...semua.map((k) => k.y2)),
          }
    const el = wadahRef.current
    if (!kotak || !el) return
    const kotakEl = el.getBoundingClientRect()
    const margin = 48
    const lebar = Math.max(1, kotak.x2 - kotak.x1)
    const tinggi = Math.max(1, kotak.y2 - kotak.y1)
    const skala = Math.min(
      4,
      Math.max(0.12, Math.min((kotakEl.width - margin * 2) / lebar, (kotakEl.height - margin * 2) / tinggi)),
    )
    v.setTampilan({
      skala,
      x: kotakEl.width / 2 - ((kotak.x1 + kotak.x2) / 2) * skala,
      y: kotakEl.height / 2 - ((kotak.y1 + kotak.y2) / 2) * skala,
    })
    panggang.current = null
  }, [coretan, gambar, objek, halaman, jumlahHalaman, lapisanInfo, terlihat, v])

  /**
   * Selalu ada satu halaman kosong menunggu di bawah.
   *
   * Begitu halaman terakhir mulai terisi, halaman berikutnya sudah disiapkan —
   * jadi menggulung ke bawah dan terus menulis tidak pernah membentur ujung,
   * dan tidak ada tombol yang harus ditekan di tengah menulis. Buku tulis tidak
   * meminta izin sebelum halaman berikutnya boleh dipakai.
   *
   * Hanya bertambah, tidak pernah berkurang: halaman tidak boleh lenyap di
   * bawah tangan yang sedang menghapus. Sketsa yang benar-benar kosong tetap
   * satu halaman — lembar kosong kedua baru muncul setelah ada coretan pertama.
   */
  useEffect(() => {
    if (halaman.w <= 0) return
    const k = kotakSemua(coretan, gambar, objek, teks)
    if (!k) return
    const slot = halaman.h + JARAK_HALAMAN
    // Halaman tempat coretan terbawah berada, lalu satu lembar kosong sesudahnya.
    const terisi = Math.floor(k.y2 / slot)
    const perlu = Math.max(1, terisi + 2)
    setJumlahHalaman((lama) => (perlu > lama ? Math.min(HALAMAN_MAKS, perlu) : lama))
  }, [coretan, gambar, objek, halaman])

  useEffect(() => {
    const el = wadahRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) =>
      setUkuranLayar({ w: e.contentRect.width, h: e.contentRect.height }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * Berkas yang dijatuhkan ke jendela.
   *
   * Penangkap drop asli Tauri sengaja dimatikan (lihat windows.rs): ia hanya
   * mengenali jalur berkas, sedangkan seretan dari WhatsApp, Foto, atau Safari
   * sering datang sebagai *file promise* atau data gambar mentah tanpa jalur.
   * WebKit menerima ketiganya lewat drop HTML5 biasa, jadi satu penangan di
   * elemen kanvas cukup — di dalam aplikasi maupun di browser.
   */
  async function terimaJatuhan(dt: DataTransfer) {
    const berkas: (File | Blob)[] = []
    const items = Array.from(dt.items ?? [])
    for (const it of items) {
      if (it.kind !== 'file') continue
      const f = it.getAsFile()
      if (f) berkas.push(f)
    }
    // Sebagian aplikasi hanya mengisi `files`, bukan `items`.
    if (berkas.length === 0) berkas.push(...Array.from(dt.files ?? []))

    // Jalur berkas (file://) tanpa isi — dibaca lewat sisi Rust.
    if (berkas.length === 0 && inTauri) {
      const uri = dt.getData('text/uri-list') || dt.getData('text/plain')
      const jalur = uri
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith('file://'))
        .map((s) => decodeURIComponent(s.replace(/^file:\/\//, '')))
      if (jalur.length > 0) {
        const { invoke } = await import('@tauri-apps/api/core')
        for (const j of jalur) {
          try {
            const isi = await invoke<number[]>('dropped_bytes', { path: j })
            const nama = j.split('/').pop() ?? 'file'
            berkas.push(new File([new Uint8Array(isi)], nama))
          } catch (err) {
            beriTahu(err instanceof Error ? err.message : String(err))
          }
        }
      }
    }

    if (berkas.length === 0) {
      beriTahu('Nothing droppable there — try an image or a PDF.')
      return
    }
    // Beberapa berkas sekaligus diproses berurutan menurut namanya — "bab 1",
    // "bab 2" — bukan menurut urutan Finder memilihnya. PDF disusun halaman
    // demi halaman ke bawah; gambar biasa ditempel di tengah pandangan.
    berkas.sort((a, b) =>
      ((a as File).name ?? '').localeCompare((b as File).name ?? '', undefined, { numeric: true, sensitivity: 'base' }),
    )
    for (const b of berkas) await terimaRef.current(b)
  }

  /** Bawa layar ke halaman ke-`i`, tepinya sedikit di bawah tepi atas. */
  const keHalaman = useCallback(
    (i: number) => {
      if (halaman.w <= 0) return
      const atas = kotakHalaman(halaman, i).y1
      v.setTampilan((t) => ({ ...t, y: -atas * t.skala + 24 }))
    },
    [halaman, v],
  )

  /**
   * Sisipkan atau hapus satu halaman, dengan isinya ikut bergeser.
   *
   * Halaman yang hanya bertambah di daftar tanpa menggeser apa pun akan
   * memotong tulisan di tengah: yang sudah tertulis di halaman 3 harus pindah
   * ke halaman 4 kalau sebuah halaman disisipkan sebelumnya. Yang menentukan
   * sebuah coretan "milik" halaman mana adalah titik tengahnya — bukan tepinya,
   * supaya goresan yang sedikit melewati batas tidak ikut terbawa.
   */
  const ubahHalaman = useCallback(
    (indeks: number, mode: 'sisip' | 'hapus') => {
      if (halaman.w <= 0) return
      if (mode === 'sisip' && jumlahHalaman >= HALAMAN_MAKS) {
        beriTahu(`A sketch tops out at ${HALAMAN_MAKS} pages.`)
        return
      }
      if (mode === 'hapus' && jumlahHalaman <= 1) {
        beriTahu('A sketch keeps at least one page.')
        return
      }
      const slot = halaman.h + JARAK_HALAMAN
      const awal = indeks * slot
      const dy = mode === 'sisip' ? slot : -slot
      const dibuang = (y: number) => mode === 'hapus' && y >= awal && y < awal + slot
      const digeser = (y: number) => y >= (mode === 'hapus' ? awal + slot : awal)
      const tengah = (k: { y1: number; y2: number }) => (k.y1 + k.y2) / 2

      terapkan(
        coretan
          .filter((c) => !dibuang(tengah(kotakCoretan(c))))
          .map((c) => (digeser(tengah(kotakCoretan(c))) ? geserCoretan(c, 0, dy) : c)),
        objek
          .filter((o) => !dibuang(tengah(kotakObjek(o))))
          .map((o) => (digeser(tengah(kotakObjek(o))) ? geserObjek(o, 0, dy) : o)),
      )
      setGambar((lama) =>
        lama
          .filter((g) => !dibuang(g.y + g.h / 2))
          .map((g) => (digeser(g.y + g.h / 2) ? { ...g, y: g.y + dy } : g)),
      )
      setJumlahHalaman(jumlahHalaman + (mode === 'sisip' ? 1 : -1))
      setPilihan(new Set())
      setObjekTerpilih(null)
      setGambarTerpilih(null)
      panggang.current = null
      beriTahu(
        mode === 'sisip' ? `Page inserted before ${indeks + 1}.` : `Page ${indeks + 1} deleted.`,
      )
    },
    [halaman, jumlahHalaman, coretan, objek, terapkan, beriTahu],
  )

  /**
   * Pratinjau kecil tiap halaman untuk daftar di pojok.
   *
   * Dibuat setelah tangan berhenti sejenak, bukan tiap goresan: menggambar
   * ulang delapan belas pratinjau di tengah coretan akan terasa di ujung pena.
   * Isinya dikelompokkan per halaman sekali di awal — menyaring seluruh coretan
   * berulang kali untuk tiap halaman membuat biayanya berlipat dengan jumlah
   * halaman, dan sketsa panjang justru yang paling butuh daftar ini.
   */
  const [pratinjau, setPratinjau] = useState<string[]>([])

  useEffect(() => {
    if (halaman.w <= 0) {
      setPratinjau([])
      return
    }
    let batal = false
    const timer = window.setTimeout(() => {
      const slot = halaman.h + JARAK_HALAMAN
      const kelompok = Array.from({ length: jumlahHalaman }, () => ({
        g: [] as Gambar[],
        c: [] as Coretan[],
        o: [] as Objek[],
      }))
      const rentang = (k: { y1: number; y2: number }) => [
        Math.max(0, Math.floor(k.y1 / slot)),
        Math.min(jumlahHalaman - 1, Math.floor(k.y2 / slot)),
      ]
      for (const g of gambar) {
        if (!(lapisanInfo[g.layer]?.tampak ?? true)) continue
        const [a, b] = rentang(kotakGambar(g))
        for (let i = a; i <= b; i++) kelompok[i]?.g.push(g)
      }
      for (const c of coretan) {
        if (!terlihat(c)) continue
        const [a, b] = rentang(kotakCoretan(c))
        for (let i = a; i <= b; i++) kelompok[i]?.c.push(c)
      }
      for (const o of objek) {
        if (!(lapisanInfo[o.layer]?.tampak ?? true)) continue
        const [a, b] = rentang(kotakObjek(o))
        for (let i = a; i <= b; i++) kelompok[i]?.o.push(o)
      }

      const LEBAR = 96
      const skala = LEBAR / halaman.w
      const keluar: string[] = []
      for (let i = 0; i < jumlahHalaman; i++) {
        const c = document.createElement('canvas')
        c.width = LEBAR
        c.height = Math.max(1, Math.round(halaman.h * skala))
        const ctx = c.getContext('2d')
        if (!ctx) continue
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.scale(skala, skala)
        ctx.translate(0, -i * slot)
        for (const g of kelompok[i].g) gambarTempelan(ctx, g)
        for (const k of kelompok[i].c) gambarCoretan(ctx, k)
        for (const o of kelompok[i].o) {
          gambarObjek(ctx, o, warnaToken(o.color), `${Math.max(9, o.size * 3)}px ui-monospace, monospace`)
        }
        keluar.push(c.toDataURL('image/png'))
      }
      if (!batal) setPratinjau(keluar)
    }, 500)
    return () => {
      batal = true
      window.clearTimeout(timer)
    }
  }, [halaman, jumlahHalaman, coretan, objek, gambar, lapisanInfo, terlihat])

  /** Halaman mana yang sudah ada isinya, untuk titik penanda di daftar. */
  const halamanBerisi = useMemo(() => {
    if (halaman.w <= 0) return []
    const slot = halaman.h + JARAK_HALAMAN
    const ada = Array.from({ length: jumlahHalaman }, () => false)
    const tandai = (y: number) => {
      const i = Math.floor(y / slot)
      if (i >= 0 && i < ada.length) ada[i] = true
    }
    for (const c of coretan) tandai((kotakCoretan(c).y1 + kotakCoretan(c).y2) / 2)
    for (const o of objek) tandai((kotakObjek(o).y1 + kotakObjek(o).y2) / 2)
    for (const g of gambar) tandai(g.y + g.h / 2)
    return ada
  }, [halaman, jumlahHalaman, coretan, objek, gambar])

  /**
   * Kotak isi untuk mini-peta.
   *
   * Sketsa padat bisa berisi ribuan goresan, dan peta selebar 176px tidak bisa
   * menunjukkan bedanya — jadi di atas ambang ini isinya dicuplik. Yang dicari
   * orang di mini-peta adalah gumpalan tempat ia pernah menggambar, bukan tiap
   * goresan satu per satu.
   */
  const kotakIsi = useMemo(() => {
    if (halaman.w > 0) return []
    const semua = [
      ...coretan.filter(terlihat).map(kotakCoretan),
      ...objek.filter((o) => lapisanInfo[o.layer]?.tampak ?? true).map(kotakObjek),
      ...gambar.filter((g) => lapisanInfo[g.layer]?.tampak ?? true).map(kotakGambar),
    ]
    const BATAS = 600
    if (semua.length <= BATAS) return semua
    const langkah = Math.ceil(semua.length / BATAS)
    return semua.filter((_, i) => i % langkah === 0)
  }, [halaman, coretan, objek, gambar, lapisanInfo, terlihat])

  const lompatKeDunia = useCallback(
    (x: number, y: number) => {
      v.setTampilan((t) => ({
        ...t,
        x: -x * t.skala + ukuranLayar.w / 2,
        y: -y * t.skala + ukuranLayar.h / 2,
      }))
    },
    [v, ukuranLayar],
  )

  const tambahHalaman = useCallback(() => {
    if (halaman.w <= 0) return
    if (jumlahHalaman >= HALAMAN_MAKS) {
      beriTahu(`A sketch tops out at ${HALAMAN_MAKS} pages.`)
      return
    }
    // Menggeser layar dan menjadwalkan simpan dilakukan di luar pembaruan
    // keadaan, bukan di dalamnya: fungsi pembaru harus bersih, dan React boleh
    // memanggilnya lebih dari sekali.
    setJumlahHalaman(jumlahHalaman + 1)
    keHalaman(jumlahHalaman)
    jadwalkanSimpan(coretan)
  }, [halaman, jumlahHalaman, keHalaman, beriTahu, jadwalkanSimpan, coretan])

  /**
   * Bingkai pilihan: kotak pembatas semua coretan terpilih, dengan tepi
   * longgar. Menyeret di mana pun di dalamnya memindahkan pilihan — tidak
   * harus tepat mengenai garisnya.
   */
  function kotakPilihan(): { x1: number; y1: number; x2: number; y2: number } | null {
    if (pilihan.size === 0) return null
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (const c of coretan) {
      if (!pilihan.has(c.id)) continue
      const k = kotakCoretan(c)
      x1 = Math.min(x1, k.x1)
      y1 = Math.min(y1, k.y1)
      x2 = Math.max(x2, k.x2)
      y2 = Math.max(y2, k.y2)
    }
    if (!Number.isFinite(x1)) return null
    const tepi = 10 / v.tampilan.skala
    return { x1: x1 - tepi, y1: y1 - tepi, x2: x2 + tepi, y2: y2 + tepi }
  }

  function adaPilihanDiTitik(x: number, y: number): boolean {
    const k = kotakPilihan()
    if (k && x >= k.x1 && x <= k.x2 && y >= k.y1 && y <= k.y2) return true
    return coretan.some((c) => pilihan.has(c.id) && coretanKena(c, x, y, 12 / v.tampilan.skala))
  }

  /* ── Pintasan ──────────────────────────────────────────────────── */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.shiftKey ? ulangi() : urungkan()
        return
      }

      // Escape melipat semua panel — rel alat, panelnya, dan daftar halaman —
      // dan menekannya lagi mengembalikan semuanya. Cara tercepat mendapat
      // kanvas bersih saat layar sedang dibagikan ke murid.
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        // Escape mundur selangkah. Kalau ada bentuk, gambar, tulisan, atau
        // pilihan laso yang sedang disunting, ia dilepas dan tangan kembali ke
        // pena terakhir — panelnya dibiarkan. Kalau tidak ada apa-apa yang
        // sedang disunting, barulah semua panel dilipat (atau dibuka lagi).
        const adaYangDisunting =
          pilihan.size > 0 || objekTerpilih !== null || gambarTerpilih !== null || teksTerpilih !== null || teksDiubah !== null
        if (adaYangDisunting) {
          if (teksDiubah) selesaiKetik()
          setPilihan(new Set())
          setObjekTerpilih(null)
          setGambarTerpilih(null)
          setTeksTerpilih(null)
          setAlat(alatTulisTerakhir.current)
          return
        }
        if (!alatTulis(alat)) {
          setAlat(alatTulisTerakhir.current)
          return
        }
        setMenuTampil((tampil) => !tampil)
        return
      }

      // ⌘2/⌘3/⌘4 memilih alat. Angka-angka ini dulu dipakai untuk berpindah
      // modul; dilepas dari menu supaya sampai ke sini.
      if (e.metaKey || e.ctrlKey) {
        // ⌘1–⌘9 menunjuk posisi di bilah alat, bukan alat tertentu — jadi
        // menyusun ulang bilahnya sekaligus menyusun ulang pintasannya.
        const slot = Number(e.key)
        if (Number.isInteger(slot) && slot >= 1 && slot <= SLOT_ALAT) {
          const pilihan = urutanRef.current[slot - 1]
          if (pilihan) {
            e.preventDefault()
            setAlat(pilihan)
            return
          }
        }
        if (e.key === '.') {
          e.preventDefault()
          setMenuTampil((tampil) => !tampil)
          return
        }
        if (e.key.toLowerCase() === 'd') {
          e.preventDefault()
          duplikat()
          return
        }
        if (e.key === '0') {
          e.preventDefault()
          muatSemua()
          return
        }
        if (e.key.toLowerCase() === 's') {
          e.preventDefault()
          void simpanSekarang(coretan)
          beriTahu('Saved.')
          return
        }
        return
      }

      // Huruf tunggal tetap bekerja untuk yang terbiasa.
      if (e.key === 'p') setAlat('pen')
      if (e.key === 'm') setAlat('spidol')
      if (e.key === 'e') setAlat('penghapus')
      if (e.key === 'l') setAlat('laso')
      if (e.key === 'k') setAlat('lasoKotak')
      if (e.key === 'g') setAlat('garis')
      if (e.key === 'r') setAlat('kotak')
      if (e.key === 'o') setAlat('elips')
      if (e.key === 'a') setAlat('panah')
      if (e.key === 'c') setAlat('lingkaran')
      if (e.key === 't') setAlat('segitiga')
      if (e.key === 'k') setAlat('kubus')
      if (e.key === 'b') setAlat('balok')
      if (e.key === 'x') setAlat('sumbu2d')
      if ((e.key === 'Backspace' || e.key === 'Delete') && teksTerpilih && !teksDiubah) {
        e.preventDefault()
        setTeks((lama) => lama.filter((t) => t.id !== teksTerpilih))
        setTeksTerpilih(null)
        jadwalkanSimpan(coretan)
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && objekTerpilih) {
        e.preventDefault()
        terapkan(
          coretan,
          objek.filter((o) => o.id !== objekTerpilih),
        )
        setObjekTerpilih(null)
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && gambarTerpilih) {
        e.preventDefault()
        setGambar((g) => g.filter((x2) => x2.id !== gambarTerpilih))
        kirim({ t: 'ubah', idKanvas, hapus: { gambar: [gambarTerpilih] } })
        setGambarTerpilih(null)
        return
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && pilihan.size > 0) {
        terapkan(coretan.filter((c) => !pilihan.has(c.id)))
        setPilihan(new Set())
        panggang.current = null
      }
    }
    // Shift ditahan saat menarik bentuk = kunci sudut / bujur sangkar.
    const shiftTurun = (e: KeyboardEvent) => {
      shiftDitekan.current = e.shiftKey
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', shiftTurun)
    window.addEventListener('keyup', shiftTurun)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', shiftTurun)
      window.removeEventListener('keyup', shiftTurun)
    }
  }, [
    urungkan,
    ulangi,
    pilihan,
    coretan,
    objek,
    objekTerpilih,
    terapkan,
    duplikat,
    muatSemua,
    simpanSekarang,
    beriTahu,
    gambarTerpilih,
    teksTerpilih,
    teksDiubah,
    alat,
  ])

  /* ── Gambar tempelan ───────────────────────────────────────────── */

  /**
   * Taruh satu gambar di tengah pandangan, seukuran wajar terhadap layar.
   *
   * Tangkapan layar Retina berukuran 5120 piksel akan menutupi seluruh kanvas
   * kalau ditempel apa adanya, jadi ukurannya disesuaikan supaya muat di sekitar
   * dua pertiga lebar layar — masih bisa diperbesar sendiri setelahnya.
   */
  const tempelGambar = useCallback(
    (src: string, lebarAsli: number, tinggiAsli: number, meta?: MetaGambar) => {
      const el = wadahRef.current
      if (!el || lebarAsli === 0) return
      const kotak = el.getBoundingClientRect()
      const maksimum = ((kotak.width * 0.66) / v.tampilan.skala) || lebarAsli
      const rasio = Math.min(1, maksimum / lebarAsli)
      const w = lebarAsli * rasio
      const h = tinggiAsli * rasio
      const tengah = v.keDunia(kotak.left + kotak.width / 2, kotak.top + kotak.height / 2)

      const baru: Gambar = {
        id: newId('img'),
        layer: lapisan,
        x: tengah.x - w / 2,
        y: tengah.y - h / 2,
        w,
        h,
        src,
        ...(meta ? { meta } : {}),
      }
      setGambar((g) => [...g, baru])
      setGambarTerpilih(baru.id)
      setGambarBaruDitempel(baru.id)
      setAlat('laso')
      // Layar lain melihat tempelannya sekarang juga; yang sangat besar
      // menyusul lewat berkas supaya tidak menyumbat Wi-Fi 40 HP sekaligus.
      if (src.length < 700_000) kirim({ t: 'ubah', idKanvas, tambah: { gambar: [baru] } })
      beriTahu(
        meta
          ? 'Inserted. Drag to move, corner to resize · tap it again to edit.'
          : 'Pasted. Drag to move, corner to resize, Backspace to remove.',
      )
    },
    [v, lapisan, beriTahu],
  )

  /** Buka penyusun grafik/tabel untuk gambar bersisipan yang sudah ada. */
  function bukaEditorGambar(g: Gambar) {
    if (!g.meta) return
    if (g.meta.jenis === 'grafik') setEditorGrafik({ awal: g.meta.data, id: g.id })
    else setEditorTabel({ awal: g.meta.data, id: g.id })
  }

  /**
   * Hasil render sisipan masuk ke kanvas — sebagai gambar baru di tengah
   * pandangan, atau menggantikan gambar lama di tempat dan lebar yang sama.
   */
  function terimaSisipan(meta: MetaGambar, hasil: { src: string; w: number; h: number }, id: string | null) {
    if (!id) {
      tempelGambar(hasil.src, hasil.w, hasil.h, meta)
      return
    }
    setGambar((lama) =>
      lama.map((g) => {
        if (g.id !== id) return g
        // Skala di kanvas dipertahankan: tabel yang bertambah kolom ikut melebar,
        // bukan selnya yang menyempit demi lebar yang sama.
        const lebarAsli = !g.meta ? hasil.w : g.meta.jenis === 'grafik' ? g.meta.data.w : ukuranTabel(g.meta.data).w
        const skalaLama = g.w / lebarAsli
        const w = Number.isFinite(skalaLama) && skalaLama > 0 ? hasil.w * skalaLama : g.w
        return { ...g, src: hasil.src, w, h: (hasil.h / hasil.w) * w, meta }
      }),
    )
    setGambarTerpilih(id)
    beriTahu('Updated.')
  }

  /** Muat gambar lewat <img>+object URL — cadangan untuk browser yang menolak createImageBitmap pada berkas tertentu. */
  function muatGambarDariBlob(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob)
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
   * Blob gambar → data URL, diperkecil kalau sisinya keterlaluan.
   *
   * Berkas sketsa memuat gambarnya sendiri, jadi tangkapan layar 8 MB akan
   * ikut dibaca ulang setiap kali sketsa dibuka. Batas sisi menjaga berkasnya
   * tetap ringan tanpa terlihat kehilangan ketajaman di layar.
   */
  async function keDataUrl(blob: Blob): Promise<{ src: string; w: number; h: number } | null> {
    let sumber: CanvasImageSource
    let wAsli: number
    let hAsli: number
    let bitmapAsli: ImageBitmap | null = await createImageBitmap(blob).catch(() => null)
    if (bitmapAsli) {
      sumber = bitmapAsli
      wAsli = bitmapAsli.width
      hAsli = bitmapAsli.height
    } else {
      // createImageBitmap menolak sebagian berkas di sebagian browser (mis.
      // Safari di tablet/iPad) — <img> lewat object URL biasanya masih bisa.
      const img = await muatGambarDariBlob(blob).catch(() => null)
      if (!img || !img.naturalWidth) return null
      sumber = img
      wAsli = img.naturalWidth
      hAsli = img.naturalHeight
    }
    const rasio = Math.min(1, SISI_MAKS / Math.max(wAsli, hAsli))
    if (rasio === 1 && blob.type === 'image/png' && bitmapAsli) {
      const src = await new Promise<string>((res) => {
        const fr = new FileReader()
        fr.onload = () => res(String(fr.result))
        fr.readAsDataURL(blob)
      })
      return { src, w: wAsli, h: hAsli }
    }
    const w = Math.round(wAsli * rasio)
    const h = Math.round(hAsli * rasio)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(sumber, 0, 0, w, h)
    return { src: c.toDataURL('image/png'), w, h }
  }

  terimaRef.current = (b) => terimaBerkas(b)

  async function terimaBerkas(berkas: Blob | null) {
    if (!berkas) return
    const nama = (berkas as File).name ?? ''
    const ext = nama.toLowerCase().split('.').pop() ?? ''
    if (berkas.type === 'application/pdf' || ext === 'pdf') {
      await imporPdf(berkas)
      return
    }
    if (EKSTENSI_KANTOR.includes(ext)) {
      await imporKantor(berkas, nama)
      return
    }
    if (!berkas.type.startsWith('image/')) {
      if (nama) beriTahu(`Not something the canvas can take: ${nama}`)
      return
    }
    const hasil = await keDataUrl(berkas)
    if (!hasil) {
      beriTahu('That image could not be read.')
      return
    }
    tempelGambar(hasil.src, hasil.w, hasil.h)
  }

  // ⌘V di mana pun selama kanvas terbuka. Dipasang di window, bukan di elemen
  // kanvas: canvas tidak bisa menerima fokus papan tik, jadi listener yang
  // menempel padanya tidak akan pernah menerima event paste.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName))) return
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/'),
      )
      if (!item) return
      e.preventDefault()
      void terimaBerkas(item.getAsFile())
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  })

  /* ── PDF ───────────────────────────────────────────────────────── */

  /**
   * Gambar satu wilayah dunia ke kanvas luar layar.
   *
   * Dipakai ekspor PDF, yang butuh wilayah pasti seukuran halaman — bukan
   * kotak pembatas isi seperti pada ekspor PNG.
   */
  async function rekamWilayah(
    x1: number,
    y1: number,
    lebar: number,
    tinggi: number,
    skala: number,
  ): Promise<HTMLCanvasElement | null> {
    const c = document.createElement('canvas')
    c.width = Math.round(lebar * skala)
    c.height = Math.round(tinggi * skala)
    const ctx = c.getContext('2d')
    if (!ctx) return null

    // Latar putih, bukan warna tema: hasil cetak tidak ikut bertema gelap.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.scale(skala, skala)
    ctx.translate(-x1, -y1)

    const tampak = <T extends { layer: number }>(x: T) => lapisanInfo[x.layer]?.tampak ?? true
    const dipakai = gambar.filter(tampak)
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
    for (const k of coretan.filter(tampak)) gambarCoretan(ctx, k)
    for (const o of objek.filter(tampak)) {
      gambarObjek(ctx, o, warnaToken(o.color), `${Math.max(13, o.size * 3)}px ui-monospace, monospace`)
    }
    for (const t of teks.filter(tampak)) gambarTeks(ctx, t)
    return c
  }

  /** Piksel dunia (96 dpi) → milimeter. */
  const keMm = (px: number) => (px / 96) * 25.4

  /**
   * Wilayah yang akan dicetak atau diekspor, satu kotak per halaman.
   *
   * Dipakai bersama oleh ekspor PDF dan cetak supaya keduanya tidak pernah
   * memotong di tempat yang berbeda.
   */
  function wilayahCetak(): { x: number; y: number; w: number; h: number }[] | null {
    if (halaman.w > 0) {
      return Array.from({ length: jumlahHalaman }, (_, i) => {
        const k = kotakHalaman(halaman, i)
        return { x: k.x1, y: k.y1, w: halaman.w, h: halaman.h }
      })
    }
    const k = kotakSemua(coretan, gambar, objek, teks)
    if (!k) return null
    const margin = 24
    return [
      { x: k.x1 - margin, y: k.y1 - margin, w: k.x2 - k.x1 + margin * 2, h: k.y2 - k.y1 + margin * 2 },
    ]
  }

  /**
   * Rakit seluruh halaman jadi satu PDF di memori.
   *
   * Dipakai bersama oleh ekspor dan cetak: keduanya harus menghasilkan berkas
   * yang sama persis, dan satu-satunya bedanya cuma ke mana byte-nya pergi.
   */
  async function bangunPdf(): Promise<{ bytes: Uint8Array; terlampaui: boolean } | null> {
    const wilayah = wilayahCetak()
    if (!wilayah) {
      beriTahu('Nothing on a page yet.')
      return null
    }
    const { jsPDF } = await import('jspdf')
    const mmW = halaman.mmW || keMm(wilayah[0].w)
    const mmH = halaman.mmH || keMm(wilayah[0].h)
    const arah = mmW > mmH ? 'landscape' : 'portrait'
    const pdf = new jsPDF({ unit: 'mm', format: [mmW, mmH], orientation: arah, compress: true })

    // Anggaran dibagi rata per halaman, dengan sisa untuk kerangka PDF-nya
    // sendiri. Sketsa 20 halaman berarti tiap halaman dapat jatah kecil — itu
    // memang konsekuensi yang benar dari satu batas untuk satu berkas.
    const jatah = (ANGGARAN_PDF * 0.92) / wilayah.length
    // Merender 40 halaman sekaligus pada 288 dpi memakan memori lebih banyak
    // daripada yang pantas dipakai satu ekspor; halaman banyak mulai dari
    // resolusi lebih rendah, dan pemadat menurunkannya lagi bila perlu.
    const skala = wilayah.length <= 4 ? 3 : wilayah.length <= 16 ? 2.5 : 2
    let terlampaui = false

    for (const [i, w] of wilayah.entries()) {
      if (wilayah.length > 1) setSibuk(`Rendering page ${i + 1}/${wilayah.length}…`)
      const c = await rekamWilayah(w.x, w.y, w.w, w.h, skala)
      if (!c) return null
      const padat = padatkanHalaman(c, jatah)
      if (padat.byte > jatah) terlampaui = true
      if (i > 0) pdf.addPage([mmW, mmH], arah)
      pdf.addImage(padat.data, padat.rupa, 0, 0, mmW, mmH)
    }
    return { bytes: new Uint8Array(pdf.output('arraybuffer')), terlampaui }
  }

  function pesanUkuran(awalan: string, bytes: Uint8Array, terlampaui: boolean): string {
    const mb = (bytes.length / 1024 / 1024).toFixed(1)
    const batas = (ANGGARAN_PDF / 1024 / 1024).toFixed(0)
    return terlampaui
      ? `${awalan} — ${mb} MB. Too much detail to fit the ${batas} MB budget.`
      : `${awalan} — ${mb} MB.`
  }

  /**
   * Cetak lewat dialog sistem.
   *
   * `window.print()` tidak berbuat apa-apa di dalam WKWebView, jadi mencetak
   * harus lewat sisi asli: PDF yang sama dengan hasil ekspor dikirim ke
   * penampil bawaan, tempat dialog cetak macOS yang sesungguhnya berada —
   * lengkap dengan pilihan printer, rentang halaman, dan pratinjaunya.
   */
  async function cetak() {
    setSibuk('Preparing to print…')
    try {
      // Namanya ditanyakan lebih dulu: PDF cetakan ini juga berkas yang akan
      // dikirim lewat surel atau disimpan, dan "sketch-1756276800.pdf" bukan
      // nama yang mau dilihat siapa pun di lampiran. Di browser tidak ada
      // dialog: PDF-nya dibuka di tab baru, tempat tablet bisa mencetak atau
      // membagikannya.
      const path = await pilihTujuan(`${judul}.pdf`, 'pdf')
      if (!path) return
      const hasil = await bangunPdf()
      if (!hasil) return
      await tulisBerkas(path, hasil.bytes, 'application/pdf', `${judul}.pdf`, { buka: true })
      beriTahu(
        pesanUkuran(inTauri ? 'Saved and opened for printing' : 'PDF opened in a new tab', hasil.bytes, hasil.terlampaui),
      )
    } catch (e) {
      beriTahu(e instanceof Error ? e.message : 'Printing failed.')
    } finally {
      setSibuk(null)
    }
  }

  async function eksporPdf() {
    setSibuk('Building PDF…')
    try {
      const path = await pilihTujuan(`${judul}.pdf`, 'pdf')
      if (!path) return
      const hasil = await bangunPdf()
      if (!hasil) return
      await tulisBerkas(path, hasil.bytes, 'application/pdf', `${judul}.pdf`)
      beriTahu(pesanUkuran('PDF exported', hasil.bytes, hasil.terlampaui))
    } catch (e) {
      beriTahu(e instanceof Error ? e.message : 'PDF export failed.')
    } finally {
      setSibuk(null)
    }
  }

  /**
   * Impor PDF: tiap halaman jadi satu gambar tempelan, ditumpuk ke bawah.
   *
   * Sengaja jadi gambar biasa, bukan jenis objek tersendiri — begitu masuk,
   * halaman PDF bisa digeser, diperbesar, dikunci di lapisannya sendiri, dan
   * dicoret-coret persis seperti tangkapan layar mana pun.
   */
  /**
   * Word / PowerPoint yang diseret ke kanvas.
   *
   * Konversinya dikerjakan di sisi Rust — di sanalah LibreOffice dan `textutil`
   * bisa dijalankan. Yang kembali cuma dua kemungkinan, dan keduanya sudah punya
   * jalur menggambar di sini: PDF masuk lewat pengimpor PDF yang sudah ada, HTML
   * dirender jadi satu gambar halaman.
   */
  async function imporKantor(berkas: Blob, nama: string) {
    if (!inTauri) {
      beriTahu('Word and PowerPoint need the Mac app — export it to PDF and drop that instead.')
      return
    }
    setSibuk('Converting…')
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const hasil = await invoke<{ kind: string; pdf: number[] | null; html: string | null }>(
        'office_convert',
        { name: nama, bytes: Array.from(new Uint8Array(await berkas.arrayBuffer())) },
      )
      if (hasil.kind === 'pdf' && hasil.pdf) {
        await imporPdf(new Blob([new Uint8Array(hasil.pdf)], { type: 'application/pdf' }))
        return
      }
      if (hasil.kind === 'html' && hasil.html) {
        await tempelHtml(hasil.html)
        return
      }
      beriTahu('That file came back empty.')
    } catch (e) {
      beriTahu(e instanceof Error ? e.message : String(e))
    } finally {
      setSibuk(null)
    }
  }

  /**
   * HTML hasil konversi jadi satu gambar selebar A4.
   *
   * Dirender di dalam iframe ber-sandbox tanpa izin skrip, bukan langsung di
   * dalam DOM aplikasi: isinya berasal dari berkas yang baru saja diseret orang
   * dari luar, dan itu tidak pernah boleh ikut hidup di halaman yang sama
   * dengan datanya.
   */
  async function tempelHtml(html: string) {
    setSibuk('Rendering document…')
    const bingkai = document.createElement('iframe')
    bingkai.setAttribute('sandbox', 'allow-same-origin')
    bingkai.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:400px;border:0;'
    document.body.appendChild(bingkai)
    try {
      const dok = bingkai.contentDocument
      if (!dok) throw new Error('Could not prepare the page.')
      dok.open()
      dok.write(
        `<!doctype html><meta charset="utf-8"><style>` +
          `html,body{margin:0;background:#fff;color:#111;` +
          `font:14px/1.65 -apple-system,system-ui,sans-serif}` +
          `body{padding:48px;width:698px}img{max-width:100%}` +
          `table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 6px}` +
          `</style>${html}`,
      )
      dok.close()
      await new Promise((r) => window.setTimeout(r, 60))
      const tinggi = Math.max(200, dok.body.scrollHeight)
      bingkai.style.height = `${tinggi}px`

      const html2canvas = (await import('html2canvas')).default
      const c = await html2canvas(dok.body, { backgroundColor: '#ffffff', scale: 2, width: 794, height: tinggi })
      tempelGambar(c.toDataURL('image/png'), c.width / 2, c.height / 2)
    } finally {
      bingkai.remove()
      setSibuk(null)
    }
  }

  async function imporPdf(berkas: Blob) {
    setSibuk('Reading PDF…')
    try {
      // Build "legacy": pdf.js sendiri menyediakannya untuk lingkungan tanpa
      // fitur JavaScript terbaru (lihat README-nya) — WKWebView aplikasi ini
      // ternyata belum punya Promise.withResolvers maupun Iterator global,
      // dan build biasa gagal diam-diam dengan galat WebKit yang membingungkan.
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      const pekerja = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default
      pdfjs.GlobalWorkerOptions.workerSrc = pekerja

      const data = new Uint8Array(await berkas.arrayBuffer())
      const dok = await pdfjs.getDocument({ data }).promise
      const jumlah = Math.min(dok.numPages, 60)
      const baru: Gambar[] = []

      // Mulai di bawah semua yang sudah ada — juga di bawah PDF yang baru saja
      // masuk dalam jatuhan yang sama — bukan di pojok kiri atas lagi.
      const isiAda = kotakSemua(coretanRef.current, gambarRef.current, objekRef.current, teksRef.current)
      const bawahIsi = Math.max(isiAda ? isiAda.y2 : -Infinity, tepiBawahImpor.current)
      const slot = halaman.w > 0 ? halaman.h + JARAK_HALAMAN : 0
      // Mode kertas: halaman PDF pertama jatuh di halaman kertas kosong pertama
      // sesudah isi; tiap halaman PDF berikutnya menempati satu halaman kertas.
      let indeksHalaman = halaman.w > 0 ? (Number.isFinite(bawahIsi) ? Math.floor(bawahIsi / slot) + 1 : 0) : 0
      let y = halaman.w > 0 ? 0 : Number.isFinite(bawahIsi) ? bawahIsi + 32 : 0

      for (let i = 1; i <= jumlah; i++) {
        setSibuk(`Rendering page ${i} of ${jumlah}…`)
        const hal = await dok.getPage(i)
        // PDF memakai 72 dpi; 96/72 membuat satu poin PDF jadi satu satuan
        // dunia, lalu 2× lagi supaya tetap tajam saat diperbesar.
        const vp = hal.getViewport({ scale: (96 / 72) * 2 })
        const c = document.createElement('canvas')
        c.width = Math.round(vp.width)
        c.height = Math.round(vp.height)
        const ctx = c.getContext('2d')
        if (!ctx) continue
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, c.width, c.height)
        await hal.render({ canvas: c, canvasContext: ctx, viewport: vp }).promise

        let w = vp.width / 2
        let h = vp.height / 2
        let x = 0
        if (halaman.w > 0) {
          // Muat ke halaman kertas, dipusatkan; PDF A4 pas persis, yang lain diskalakan.
          const skalaMuat = Math.min(1, halaman.w / w, halaman.h / h)
          w *= skalaMuat
          h *= skalaMuat
          const k = kotakHalaman(halaman, indeksHalaman)
          x = k.x1 + (halaman.w - w) / 2
          y = k.y1
          indeksHalaman++
        }
        baru.push({
          id: newId('img'),
          layer: lapisan,
          x,
          y,
          w,
          h,
          src: c.toDataURL('image/jpeg', 0.86),
        })
        if (halaman.w > 0) tepiBawahImpor.current = Math.max(tepiBawahImpor.current, y + h)
        else {
          y += h + 32
          tepiBawahImpor.current = Math.max(tepiBawahImpor.current, y)
        }
      }

      if (baru.length === 0) {
        beriTahu('That PDF had no pages to render.')
        return
      }
      setGambar((g) => [...g, ...baru])
      gambarRef.current = [...gambarRef.current, ...baru]
      jadwalkanSimpan(coretanRef.current)
      setAlat('pen')
      // Bawa layar ke halaman pertama PDF ini supaya hasilnya langsung terlihat.
      const pertama = baru[0]
      v.setTampilan((t) => ({ ...t, y: -pertama.y * t.skala + 24 }))
      beriTahu(
        dok.numPages > jumlah
          ? `Imported the first ${jumlah} of ${dok.numPages} pages. Draw straight on them.`
          : `Imported ${baru.length} page${baru.length === 1 ? '' : 's'}. Draw straight on them.`,
      )
    } catch (e) {
      beriTahu(e instanceof Error ? e.message : 'That PDF could not be read.')
    } finally {
      setSibuk(null)
    }
  }

  /* ── Ekspor ────────────────────────────────────────────────────── */

  async function ekspor(format: 'png' | 'svg') {
    const path = await pilihTujuan(`${judul}.${format}`, format)
    if (!path) return
    const bytes =
      format === 'svg'
        ? new TextEncoder().encode(keSvg(coretan, gambar, objek, teks))
        : await kePng(coretan, gambar, objek, teks)
    if (!bytes) return
    await tulisBerkas(path, bytes, format === 'svg' ? 'image/svg+xml' : 'image/png', `${judul}.${format}`)
  }

  const kursor = v.spasiDitekan
    ? 'grab'
    : kursorAlat(alat, alat === 'penghapus' ? setelanAktif.size * v.tampilan.skala : 0)

  /** Halaman yang tepi atasnya paling dekat dengan tepi atas layar. */
  const halamanTerlihat =
    halaman.w > 0
      ? Math.max(
          0,
          Math.min(
            jumlahHalaman - 1,
            Math.round(-v.tampilan.y / v.tampilan.skala / (halaman.h + JARAK_HALAMAN)),
          ),
        )
      : 0

  useEffect(() => {
    if (mintaCetak === cetakTerlayani.current) return
    cetakTerlayani.current = mintaCetak
    void cetak()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintaCetak])

  const teksSedangDiubah = teksDiubah ? (teks.find((t) => t.id === teksDiubah) ?? null) : null

  /**
   * Fokus dipaksa setelah kotaknya benar-benar ada di halaman.
   *
   * `autoFocus` berlomba dengan penangkapan pointer milik kanvas, dan di
   * WKWebView kanvas kadang menang — kotaknya muncul tapi ketikan tidak masuk
   * ke mana-mana. Satu bingkai jeda membuat urutannya pasti.
   */
  useEffect(() => {
    if (!teksDiubah) return
    const id = requestAnimationFrame(() => {
      const el = ketikRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [teksDiubah])

  /**
   * Tutup kotak ketik.
   *
   * Tulisan kosong dibuang, bukan disimpan: satu ketukan yang tidak jadi apa-apa
   * tidak boleh meninggalkan titik tak terlihat yang masih bisa tersentuh laso
   * dan penghapus.
   */
  function selesaiKetik() {
    const id = teksDiubah
    setTeksDiubah(null)
    if (!id) return
    setTeks((lama) => lama.filter((t) => t.id !== id || t.isi.trim() !== ''))
    jadwalkanSimpan(coretan)
  }

  const jumlahTampak = useMemo(() => coretan.filter(terlihat).length, [coretan, terlihat])

  return (
    <div
      ref={wadahRef}
      className="relative h-full w-full overflow-hidden"
      onDragEnter={(e) => {
        e.preventDefault()
        setSeretMasuk(true)
      }}
      onDragOver={(e) => {
        // Selalu diterima: jenis pasteboard dari aplikasi lain tidak selalu
        // mengumumkan 'Files' sebelum dijatuhkan, dan menolaknya di sini
        // berarti kursor "dilarang" untuk seretan yang sebenarnya sah.
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!seretMasuk) setSeretMasuk(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setSeretMasuk(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setSeretMasuk(false)
        void terimaJatuhan(e.dataTransfer)
      }}
    >
      {seretMasuk && (
        <div
          className="pointer-events-none absolute inset-3 z-20 grid place-items-center"
          style={{
            border: '2px dashed var(--accent)',
            borderRadius: 'var(--radius)',
            background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
          }}
        >
          <p className="ex-card px-4 py-2" style={{ color: 'var(--accent)' }}>
            Drop to place it on the canvas
          </p>
        </div>
      )}
      <input
        ref={berkasRef}
        type="file"
        accept="application/pdf,image/*,.doc,.docx,.rtf,.odt,.ppt,.pptx,.odp,.key,.pages"
        multiple
        className="hidden"
        onChange={(e) => {
          const daftar = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (daftar.length === 0) return
          daftar.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
          void (async () => {
            for (const f of daftar) await terimaBerkas(f)
          })()
        }}
      />

      <div ref={v.ref} className="absolute inset-0">
        <canvas ref={dasarRef} className="absolute inset-0 h-full w-full" />
        <canvas
          ref={aktifRef}
          className="absolute inset-0 h-full w-full"
          // Gestur sistem tidak boleh mencuri input pen.
          style={{ touchAction: 'none', cursor: kursor }}
          onPointerDown={turun}
          onPointerMove={bergerak}
          onPointerUp={naik}
          onPointerCancel={naik}
          // Tombol samping S Pen memicu menu konteks di Android; di kanvas ia
          // adalah penghapus, bukan menu.
          onContextMenu={(e) => e.preventDefault()}
          onPointerLeave={(e) => {
            kirim({ t: 'kursor', idKanvas, x: null })
            if (aktifCoretan.current && e.buttons === 0) naik(e)
          }}
        />

        {/* Kotak ketik melayang tepat di atas tempat tulisannya akan berada,
            dengan huruf seukuran hasil akhirnya — jadi yang terlihat saat
            mengetik sudah sama dengan yang tergambar setelah selesai. */}
        {teksSedangDiubah && (
          <textarea
            key={teksSedangDiubah.id}
            ref={ketikRef}
            className="ex-input"
            aria-label="Text"
            defaultValue={teksSedangDiubah.isi}
            spellCheck={false}
            onChange={(e) => {
              const isi = e.target.value
              setTeks((lama) =>
                lama.map((t) => (t.id === teksSedangDiubah.id ? { ...t, isi } : t)),
              )
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
                e.preventDefault()
                selesaiKetik()
              }
            }}
            style={{
              position: 'absolute',
              left: teksSedangDiubah.x * v.tampilan.skala + v.tampilan.x - 4,
              top: teksSedangDiubah.y * v.tampilan.skala + v.tampilan.y - 3,
              minWidth: 140,
              width: `${Math.max(140, (kotakTeks(teksSedangDiubah).x2 - teksSedangDiubah.x) * v.tampilan.skala + 40)}px`,
              height: `${Math.max(1, teksSedangDiubah.isi.split('\n').length) * teksSedangDiubah.size * JARAK_BARIS * v.tampilan.skala + 10}px`,
              padding: '2px 4px',
              lineHeight: JARAK_BARIS,
              fontSize: teksSedangDiubah.size * v.tampilan.skala,
              fontFamily: KELUARGA_HURUF,
              color: warnaToken(teksSedangDiubah.color),
              resize: 'none',
              overflow: 'hidden',
            }}
          />
        )}
      </div>

      {!menuTampil ? null : halaman.w > 0 ? (
        daftarTampil ? (
          <DaftarHalaman
            jumlah={jumlahHalaman}
            aktif={halamanTerlihat}
            berisi={halamanBerisi}
            pratinjau={pratinjau}
            bolehTambah={jumlahHalaman < HALAMAN_MAKS}
            onLompat={keHalaman}
            onSisip={(i) => ubahHalaman(i, 'sisip')}
            onHapus={(i) => ubahHalaman(i, 'hapus')}
            onTambah={tambahHalaman}
            onSembunyi={() => setDaftarTampil(false)}
          />
        ) : (
          <button
            type="button"
            className="ex-card ex-btn ex-halaman absolute bottom-3 right-3"
            data-variant="ghost"
            title="Show the page thumbnails"
            style={{ padding: '5px 9px' }}
            onClick={() => setDaftarTampil(true)}
          >
            <Icon nama="halaman" ukuran={14} />
            <span className="ex-num" style={{ fontSize: 'var(--fs-label)' }}>
              {halamanTerlihat + 1}/{jumlahHalaman}
            </span>
            <Icon nama="atas" ukuran={12} />
          </button>
        )
      ) : (
        <PetaBebas
          kotak={kotakIsi}
          tampilan={v.tampilan}
          ukuranLayar={ukuranLayar}
          onLompat={lompatKeDunia}
        />
      )}

      {/* Saat panelnya disembunyikan, tombol ini satu-satunya jalan kembali —
          jadi ia berdiri sendiri di luar kartu, bukan di dalamnya. Sengaja
          tetap terlihat: kanvas tanpa jalan pulang bukan tampilan bersih,
          melainkan tampilan yang macet. */}
      {!menuTampil && (
        <IconButton
          nama="tampilkan"
          label="Show the panels (Esc or ⌘.)"
          className="ex-card ex-bilah ex-tampilkan absolute left-4 top-4 z-10"
          onClick={() => setMenuTampil(true)}
        />
      )}

      {/*
        Rel alat: satu kolom sempit, isinya muncul saat ditekan.

        Sebelumnya seluruh isi bilah tergelar sekaligus dan memakan hampir
        seluruh tinggi layar — padahal saat menggambar, yang benar-benar dipakai
        cuma satu atau dua kelompok. Yang tetap terlihat di sini hanyalah yang
        menjawab "sedang pakai alat apa, warna apa": sisanya menunggu diminta.
      */}
      <div
        className="ex-card ex-bilah ex-rel absolute left-3 top-3 z-10 flex flex-col gap-1 p-1"
        style={{ display: menuTampil ? undefined : 'none' }}
      >
        <IconButton
          nama={infoAlat(alat).ikon}
          label={`${infoAlat(alat).label} — tools and shapes`}
          aktif={panelAlat === 'alat'}
          onClick={() => bukaPanel('alat')}
        />
        {/* Penghapus punya tombolnya sendiri tepat di bawah alat: berganti
            pena ↔ penghapus adalah gerakan yang paling sering dilakukan, dan
            di tablet membuka panel dulu terasa dua ketukan kelebihan. */}
        <IconButton
          nama="penghapus"
          label={alat === 'penghapus' ? 'Back to the pen' : 'Eraser'}
          aktif={alat === 'penghapus'}
          onClick={() => setAlat(alat === 'penghapus' ? alatTulisTerakhir.current : 'penghapus')}
        />
        <button
          type="button"
          className="ex-btn grid place-items-center"
          data-variant={panelAlat === 'warna' ? 'accent' : 'ghost'}
          title="Colour"
          aria-label="Colour"
          style={{ padding: 7 }}
          onClick={() => bukaPanel('warna')}
        >
          <span
            aria-hidden
            style={{
              width: 16,
              height: 16,
              borderRadius: 999,
              background: warna.startsWith('#') ? warna : `var(--${warna})`,
              border: '1px solid var(--line-strong)',
            }}
          />
        </button>
        <IconButton
          nama="garis"
          label="Thickness, ink, and line pattern"
          aktif={panelAlat === 'goresan'}
          onClick={() => bukaPanel('goresan')}
        />
        <IconButton
          nama="halaman"
          label="Paper and pages"
          aktif={panelAlat === 'kertas'}
          onClick={() => bukaPanel('kertas')}
        />
        <IconButton
          nama="lapisan"
          label="Layers"
          aktif={panelAlat === 'lapisan'}
          onClick={() => bukaPanel('lapisan')}
        />
        <IconButton
          nama={instrumen?.jenis ?? 'penggaris'}
          label="Ruler, protractor, compass"
          aktif={panelAlat === 'instrumen'}
          onClick={() => bukaPanel('instrumen')}
        />
        <IconButton
          nama="sisip"
          label="Insert a function graph, table, PDF or image"
          aktif={panelAlat === 'sisip'}
          onClick={() => bukaPanel('sisip')}
        />
        <div className="relative">
          <IconButton
            nama="grup"
            label="Class: queue, students, groups"
            aktif={panelAlat === 'kelas'}
            onClick={() => bukaPanel('kelas')}
          />
          {jumlahMenunggu > 0 && (
            <span
              className="ex-num absolute"
              style={{
                top: 0,
                right: 0,
                minWidth: 16,
                height: 16,
                padding: '0 4px',
                borderRadius: 999,
                background: 'var(--down)',
                color: '#fff',
                fontSize: 10,
                lineHeight: '16px',
                textAlign: 'center',
                pointerEvents: 'none',
              }}
            >
              {jumlahMenunggu}
            </span>
          )}
        </div>

        <div className="ex-divider ex-pemisah" style={{ margin: '2px 0' }} />

        <IconButton nama="urungkan" label="Undo (⌘Z)" onClick={urungkan} />
        <IconButton nama="ulangi" label="Redo (⇧⌘Z)" onClick={ulangi} />
        <IconButton
          nama="arsip"
          label="Export, print, import"
          aktif={panelAlat === 'ekspor'}
          onClick={() => bukaPanel('ekspor')}
        />
        {inTauri && (
          <IconButton
            nama="jendela"
            label="Open the canvas in another window"
            onClick={() => {
              void bukaJendelaBaru('kanvas').then((label) => {
                beriTahu(label ? 'Opened in another window.' : 'All windows are already open.')
              })
            }}
          />
        )}
        {/* Di tablet, rel ini menetap di bawah dan selalu terbuka — tidak ada
            tombol untuk melipatnya sendiri, supaya tidak perlu mengejar
            tombol "tampilkan" tiap kali mau memakai alat. */}
        {!layarSentuh && (
          <IconButton
            nama="sembunyi"
            label="Hide all panels for a clean canvas (Esc or ⌘.)"
            onClick={() => setMenuTampil(false)}
          />
        )}
      </div>

      {/* Panel isi, muncul di sebelah rel. Tingginya dibatasi tinggi kanvas —
          daftar lapisan pada layar pendek tetap bisa digulung, bukan terpotong. */}
      {menuTampil && panelAlat && (
        <div
          className={`ex-card ex-bilah ex-panel absolute z-10 flex flex-col gap-2 p-2${panelAlat === 'kelas' ? ' ex-panel-kelas' : ''}`}
          style={{
            left: 62,
            top: 12,
            width: panelAlat === 'alat' ? 214 : panelAlat === 'kelas' ? 300 : 232,
            maxHeight: 'calc(100% - 24px)',
            overflowY: 'auto',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              {JUDUL_PANEL[panelAlat]}
            </span>
            <IconButton nama="silang" label="Close" ukuran={14} onClick={() => setPanelAlat(null)} />
          </div>

          {panelAlat === 'alat' && (
            <>
        {/* Bilah cepat: seret tombolnya untuk menyusun ulang, atau seret bentuk
            dari katalog di bawah ke salah satu slot. ⌘1–⌘9 mengikuti urutannya. */}
        <div ref={bilahRef} className="grid grid-cols-5 gap-1">
          {urutanAlat.map((a, i) => {
            const info = infoAlat(a)
            return (
              <div
                key={a}
                {...pegangAlat(a)}
                style={{
                  opacity: seretAlat === a ? 0.45 : 1,
                  cursor: seretAlat ? 'grabbing' : 'grab',
                  touchAction: 'none',
                }}
              >
                <IconButton
                  nama={info.ikon}
                  label={`${info.label} (⌘${i + 1}) — drag to rearrange`}
                  aktif={alat === a}
                />
              </div>
            )
          })}
        </div>

        {/* Bentuk geometri. Tahan Shift saat menarik untuk mengunci sudut 15°
            atau memaksa bujur sangkar; sesudah dilepas, titik sudutnya masih
            bisa digeser dengan alat laso. */}
        <div className="grid grid-cols-4 gap-1">
          {OBJEK.map((o) => (
            <div
              key={o.id}
              {...pegangAlat(o.id)}
              style={{ cursor: 'grab', touchAction: 'none' }}
            >
              <IconButton
                nama={o.ikon}
                label={`${o.label} — editable afterwards, drag onto the bar above for a ⌘ shortcut`}
                aktif={alat === o.id}
              />
            </div>
          ))}
        </div>
            </>
          )}

          {panelAlat === 'warna' && (
            <>
        <div className="flex gap-1.5">
          {WARNA_CORETAN.map((w) => (
            <button
              key={w}
              title={`Theme colour — follows the active theme`}
              aria-label={`Theme colour ${w}`}
              onClick={() => setWarna(w)}
              style={{
                width: 20,
                height: 20,
                borderRadius: 999,
                background: `var(--${w})`,
                border: warna === w ? '2px solid var(--ink)' : '1px solid var(--line-strong)',
              }}
            />
          ))}
        </div>

        {/* Palet tetap, di barisnya sendiri: warna yang ikut tema dan warna yang
            tidak adalah dua hal berbeda, dan mencampurnya dalam satu baris
            membuat orang mengira semuanya berperilaku sama. */}
        <div className="grid grid-cols-6 gap-1">
          {PALET_CORETAN.map((p) => (
            <button
              key={p.hex}
              title={p.nama}
              aria-label={p.nama}
              onClick={() => setWarna(p.hex)}
              style={{
                width: 20,
                height: 20,
                borderRadius: 999,
                background: p.hex,
                border: warna === p.hex ? '2px solid var(--ink)' : '1px solid var(--line-strong)',
              }}
            />
          ))}
        </div>
            </>
          )}

          {panelAlat === 'goresan' && (
            <>
        <label
          className="ex-label flex items-center gap-2"
          style={{ color: 'var(--ink-soft)' }}
          title="Kept per tool — the pen stays thin even when the highlighter is thick."
        >
          Size
          <input
            type="range"
            min={1}
            max={kunciAlat === 'penghapus' || kunciAlat === 'spidol' ? 60 : 30}
            value={ukuran}
            onChange={(e) => ubahSetelan({ size: Number(e.target.value) })}
            style={{ width: 78, accentColor: 'var(--accent)' }}
          />
          <span style={{ width: 20, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(ukuran)}
          </span>
        </label>

        {kunciAlat !== 'penghapus' && (
          <>
            <label className="ex-label flex items-center gap-2" style={{ color: 'var(--ink-soft)' }}>
              Ink
              <input
                type="range"
                min={5}
                max={100}
                value={Math.round(setelanAktif.alpha * 100)}
                onChange={(e) => ubahSetelan({ alpha: Number(e.target.value) / 100 })}
                style={{ width: 78, accentColor: 'var(--accent)' }}
              />
              <span style={{ width: 20, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {Math.round(setelanAktif.alpha * 100)}
              </span>
            </label>

            <div className="flex gap-1">
              {(['utuh', 'putus', 'titik'] as const).map((pola) => (
                <button
                  key={pola}
                  className="ex-btn flex-1 justify-center"
                  data-variant={setelanAktif.pola === pola ? 'accent' : 'ghost'}
                  title={{ utuh: 'Solid line', putus: 'Dashed line', titik: 'Dotted line' }[pola]}
                  onClick={() => ubahSetelan({ pola })}
                  style={{ padding: '4px 0' }}
                >
                  <svg width="30" height="10" viewBox="0 0 30 10" aria-hidden>
                    <line
                      x1="2"
                      y1="5"
                      x2="28"
                      y2="5"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeDasharray={pola === 'putus' ? '6 4' : pola === 'titik' ? '0.1 5' : undefined}
                    />
                  </svg>
                </button>
              ))}
            </div>
          </>
        )}

        {kunciAlat === 'penghapus' && (
          <div className="flex gap-1">
            {(['sebagian', 'goresan'] as const).map((m) => (
              <button
                key={m}
                className="ex-btn flex-1 justify-center"
                data-variant={modePenghapus === m ? 'accent' : 'ghost'}
                title={
                  m === 'sebagian'
                    ? 'Rub out only what you touch'
                    : 'One touch removes a whole stroke'
                }
                onClick={() => ubahModePenghapus(m)}
                style={{ padding: '4px 0', fontSize: 'var(--fs-label)' }}
              >
                {m === 'sebagian' ? 'Part' : 'Stroke'}
              </button>
            ))}
          </div>
        )}

        <label
          className="ex-label flex items-center gap-2"
          style={{ color: 'var(--ink-soft)' }}
          title="Smooths out hand shake. Applies to new strokes only."
        >
          <input
            type="checkbox"
            checked={steady}
            onChange={(e) => setSteady(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          Steady hand
        </label>

        <label
          className="ex-label flex items-center gap-2"
          style={{ color: 'var(--ink-soft)' }}
          title="Draw a circle, box, triangle or line, then hold the pen still — it snaps to a clean shape you can still reshape later."
        >
          <input
            type="checkbox"
            checked={tahanBentuk}
            onChange={(e) => setTahanBentuk(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          Hold to shape
        </label>

        <label
          className="ex-label flex items-center gap-2"
          style={{ color: 'var(--ink-soft)' }}
          title="Recognise lines, arrows, circles, boxes and triangles the moment the pen lifts — no holding. Handy for geometry, less so for handwriting."
        >
          <input
            type="checkbox"
            checked={autoBentuk}
            onChange={(e) => {
              setAutoBentuk(e.target.checked)
              void simpanAutoBentuk(e.target.checked)
            }}
            style={{ accentColor: 'var(--accent)' }}
          />
          Auto shapes
        </label>

        <label
          className="ex-label flex items-center gap-2"
          style={{ color: 'var(--ink-soft)' }}
          title="A quick two-finger tap undoes the last stroke (Procreate-style) — on your canvas and your students'. Turn off if a resting hand or a stray second finger keeps undoing strokes by accident."
        >
          <input
            type="checkbox"
            checked={duaJariUndo}
            onChange={(e) => {
              setDuaJariUndo(e.target.checked)
              void simpanDuaJariUndo(e.target.checked)
            }}
            style={{ accentColor: 'var(--accent)' }}
          />
          Two-finger undo
        </label>
            </>
          )}

          {panelAlat === 'kertas' && (
            <>
        <div className="flex items-center gap-1">
          <span style={{ color: 'var(--ink-faint)' }}>
            <Icon nama="petak" ukuran={14} />
          </span>
          <select
            className="ex-input"
            style={{ padding: '3px 6px', fontSize: 'var(--fs-label)', flex: 1 }}
            value={latar}
            aria-label="Paper background"
            onChange={(e) => setLatar(e.target.value as Latar)}
          >
            {LATAR.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1">
          <span style={{ color: 'var(--ink-faint)' }}>
            <Icon nama="halaman" ukuran={14} />
          </span>
          <select
            className="ex-input"
            style={{ padding: '3px 6px', fontSize: 'var(--fs-label)', flex: 1 }}
            value={kertas}
            aria-label="Page size"
            title="Infinite canvas, or stacked pages you can scroll through and export as a PDF."
            onChange={(e) => {
              setKertas(e.target.value)
              jadwalkanSimpan(coretan)
            }}
          >
            {KERTAS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
            </>
          )}

          {panelAlat === 'lapisan' && (
            <>
        <div className="flex flex-col gap-1">
          {Array.from({ length: JUMLAH_LAPISAN }, (_, i) => {
            const l = lapisanInfo[i]
            const isi = coretan.filter((c) => c.layer === i).length
            return (
              <div key={i} className="flex items-center gap-1">
                <button
                  className="ex-btn justify-start"
                  style={{ flex: 1, minWidth: 0, opacity: l.tampak ? 1 : 0.45 }}
                  data-variant={lapisan === i ? 'accent' : 'ghost'}
                  title={
                    pilihan.size > 0
                      ? `Click to draw here · double-click to move ${pilihan.size} selected here`
                      : 'Draw on this layer'
                  }
                  onClick={() => setLapisan(i)}
                  onDoubleClick={() => pindahKeLapisan(i)}
                >
                  <Icon nama="lapisan" ukuran={14} />
                  <span className="min-w-0 flex-1 truncate text-left">{l.nama}</span>
                  <span className="ex-num shrink-0" style={{ opacity: 0.5, fontSize: 11 }}>
                    {isi || ''}
                  </span>
                </button>
                <IconButton
                  nama={l.tampak ? 'mata' : 'mataCoret'}
                  label={l.tampak ? `Hide ${l.nama}` : `Show ${l.nama}`}
                  ukuran={14}
                  onClick={() =>
                    setLapisanInfo((t) =>
                      t.map((x2, j) => (j === i ? { ...x2, tampak: !x2.tampak } : x2)),
                    )
                  }
                />
                <IconButton
                  nama={l.kunci ? 'gembok' : 'gembokBuka'}
                  label={l.kunci ? `Unlock ${l.nama}` : `Lock ${l.nama}`}
                  aktif={l.kunci}
                  ukuran={14}
                  onClick={() =>
                    setLapisanInfo((t) =>
                      t.map((x2, j) => (j === i ? { ...x2, kunci: !x2.kunci } : x2)),
                    )
                  }
                />
                <IconButton
                  nama="hapus"
                  label={`Clear ${l.nama}`}
                  ukuran={14}
                  onClick={() => kosongkanLapisan(i)}
                />
              </div>
            )
          })}
          <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
            Double-click a layer to move the selection onto it.
          </p>
        </div>
            </>
          )}

          {panelAlat === 'instrumen' && (
            <>
        <div className="flex flex-col gap-1">
          {INSTRUMEN.map((i) => (
            <button
              key={i.id}
              className="ex-btn justify-start"
              data-variant={instrumen?.jenis === i.id ? 'accent' : 'ghost'}
              title={i.sub}
              onClick={() => pasangInstrumen(i.id)}
            >
              <Icon nama={i.ikon} ukuran={15} />
              <span className="flex-1 text-left">{i.label}</span>
              {instrumen?.jenis === i.id && <span style={{ fontSize: 11, opacity: 0.8 }}>on</span>}
            </button>
          ))}
        </div>
        {instrumen && (
          <button className="ex-btn" data-variant="ghost" onClick={() => setInstrumen(null)}>
            <Icon nama="silang" ukuran={14} /> Put it away
          </button>
        )}
        <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
          Drag the body to move it and the dots to rotate or resize. Strokes that start on the
          measuring edge, the arc, or the compass tip snap to it. 1 cm on the ruler is 1 cm on an
          A4 print.
        </p>
            </>
          )}

          {panelAlat === 'sisip' && (
            <>
        <button
          className="ex-btn justify-start"
          data-variant="ghost"
          title="Plot one or more functions of x on labelled axes"
          onClick={() => setEditorGrafik({ awal: null, id: null })}
        >
          <Icon nama="grafik" ukuran={15} /> Function graph…
        </button>
        <button
          className="ex-btn justify-start"
          data-variant="ghost"
          title="A table you can type into, or leave blank and fill by hand"
          onClick={() => setEditorTabel({ awal: null, id: null })}
        >
          <Icon nama="tabel" ukuran={15} /> Table…
        </button>
        <button
          className="ex-btn justify-start"
          data-variant="ghost"
          title="Each PDF page becomes an image you can draw straight onto."
          onClick={() => berkasRef.current?.click()}
        >
          <Icon nama="pdf" ukuran={15} /> PDF or image…
        </button>
        <label
          className="ex-label flex items-center gap-2"
          style={{ color: 'var(--ink-soft)' }}
          title="PDF pages, photos and pasted pictures can't be selected or moved by the lasso — only your annotations are. A picture you just added stays draggable until you click away; turn this off to reposition an older one."
        >
          <input
            type="checkbox"
            checked={kunciGambar}
            onChange={(e) => {
              setKunciGambar(e.target.checked)
              if (e.target.checked) setGambarTerpilih(null)
              void simpanKunciGambar(e.target.checked)
            }}
            style={{ accentColor: 'var(--accent)' }}
          />
          Lock pictures
        </label>
        <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
          Graphs and tables stay editable: select one with the lasso, then tap it again.
        </p>
            </>
          )}

          {panelAlat === 'kelas' && <PanelKelas onBahas={(t, lampiran, paksaTempel) => void bahasTanya(t, lampiran, paksaTempel)} />}

          {panelAlat === 'ekspor' && (
            <>
        <div className="flex gap-1">
          <IconButton nama="urungkan" label="Undo (⌘Z)" onClick={urungkan} />
          <IconButton nama="ulangi" label="Redo (⌘⇧Z)" onClick={ulangi} />
          <IconButton nama="layar" label="Fit to sketch (⌘0)" onClick={muatSemua} />
          <IconButton
            nama="tarik"
            label="Duplicate selection (⌘D)"
            onClick={duplikat}
          />
        </div>

        <button
          className="ex-btn"
          data-variant="ghost"
          title="Sketches save themselves a moment after you stop drawing. This forces it now."
          onClick={() => {
            void simpanSekarang(coretan)
            beriTahu('Saved.')
          }}
        >
          <Icon nama="arsip" ukuran={14} />
          {disimpan ? `Saved ${jam(new Date(disimpan))}` : 'Save now'}
        </button>

        <div className="flex gap-1">
          <button className="ex-btn flex-1" data-variant="ghost" onClick={() => void ekspor('png')}>
            PNG
          </button>
          <button className="ex-btn flex-1" data-variant="ghost" onClick={() => void ekspor('svg')}>
            SVG
          </button>
          <button
            className="ex-btn flex-1"
            data-variant="ghost"
            title={
              halaman.w > 0
                ? `Export ${jumlahHalaman} ${halaman.label} page${jumlahHalaman > 1 ? 's' : ''}`
                : 'Export everything drawn, on a page sized to fit'
            }
            onClick={() => void eksporPdf()}
          >
            PDF
          </button>
        </div>

        <button
          className="ex-btn"
          data-variant="ghost"
          title="Each page becomes an image you can draw straight onto."
          onClick={() => berkasRef.current?.click()}
        >
          <Icon nama="pdf" ukuran={14} /> Import PDF or image
        </button>
            </>
          )}
        </div>
      )}

      <PanelGrafik
        buka={editorGrafik !== null}
        awal={editorGrafik?.awal ?? null}
        onTutup={() => setEditorGrafik(null)}
        onSisip={(d, hasil) => {
          const id = editorGrafik?.id ?? null
          setEditorGrafik(null)
          if (hasil.galat.length > 0 && hasil.galat.length === d.fungsi.length) {
            beriTahu('None of the functions could be read.')
            return
          }
          terimaSisipan({ jenis: 'grafik', data: d }, hasil, id)
        }}
      />
      <PanelTabel
        buka={editorTabel !== null}
        awal={editorTabel?.awal ?? null}
        onTutup={() => setEditorTabel(null)}
        onSisip={(d, hasil) => {
          const id = editorTabel?.id ?? null
          setEditorTabel(null)
          terimaSisipan({ jenis: 'tabel', data: d }, hasil, id)
        }}
      />

      {(() => {
        const g = gambar.find((x2) => x2.id === gambarTerpilih)
        if (!g?.meta) return null
        return (
          <button
            className="ex-card ex-btn absolute left-1/2 top-4 z-10"
            data-variant="ghost"
            style={{ transform: 'translateX(-50%)' }}
            onClick={() => bukaEditorGambar(g)}
          >
            <Icon nama={g.meta.jenis === 'grafik' ? 'grafik' : 'tabel'} ukuran={14} />
            Edit {g.meta.jenis === 'grafik' ? 'graph' : 'table'}
          </button>
        )
      })()}

      {sibuk && (
        <p
          className="ex-card absolute left-1/2 top-4 px-3 py-1.5"
          style={{ transform: 'translateX(-50%)', color: 'var(--accent)' }}
        >
          {sibuk}
        </p>
      )}

      {petunjuk && (
        <p
          className="ex-card ex-masuk absolute bottom-3 left-1/2 px-3 py-1.5"
          style={{ transform: 'translateX(-50%)', color: 'var(--ink-soft)' }}
        >
          {petunjuk}
        </p>
      )}

      <p className="ex-label ex-statusbar absolute bottom-3 left-4" style={{ color: 'var(--ink-faint)' }}>
        {jumlahTampak} strokes
        {objek.length > 0 && ` · ${objek.length} shape${objek.length === 1 ? '' : 's'}`}
        {gambar.length > 0 && ` · ${gambar.length} image${gambar.length === 1 ? '' : 's'}`} ·{' '}
        {Math.round(v.tampilan.skala * 100)}%
        {pilihan.size > 0 && ` · ${pilihan.size} selected`}
        {tekananTersedia === false && ' · no pen pressure detected; check that the Wacom driver is installed'}
      </p>
    </div>
  )
}
