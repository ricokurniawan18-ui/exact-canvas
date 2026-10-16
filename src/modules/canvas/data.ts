import { q, x } from '@/lib/db'
import { pancarkan } from '@/lib/events'
import { kanvas } from '@/lib/vault'
import { newId } from '@/lib/id'
import { idKlien } from '@/lib/sinkron'
import { kunciTanggal, tanggalPendek } from '@/lib/tanggal'
import {
  bacaLapisan,
  lapisanBawaan,
  type BerkasKanvas,
  type Coretan,
  type Gambar,
  type Lapisan,
  type Teks,
} from './strokes'
import type { Objek } from './objek'

/** Ukuran kertas sketsa baru dan sketsa lama yang belum menyimpan pilihannya. */
export const KERTAS_BAWAAN = 'a4'

export interface MetaKanvas {
  id: string
  title: string
  updated_at: number
}

/**
 * Waktu pembuatan sketsa, dibaca dari id-nya sendiri.
 *
 * `newId` menaruh `Date.now()` dalam base-36 di depan lima huruf acak, jadi
 * tanggal pembuatan sebenarnya sudah tersimpan sejak sketsa pertama dibuat —
 * tidak perlu kolom baru di database, dan sketsa lama ikut terbaca tanpa
 * migrasi apa pun.
 */
export function dibuatPada(id: string): number | null {
  const ekor = id.split('_')[1] ?? ''
  if (ekor.length <= 5) return null
  const t = parseInt(ekor.slice(0, -5), 36)
  // Rentang waras: milidetik epoch antara tahun 2001 dan 2096.
  return t > 1e12 && t < 4e12 ? t : null
}

/**
 * Nama bawaan sketsa baru: "27 Aug 2026 · 3" — tanggal pembuatan, lalu sketsa
 * ke berapa yang dibuat hari itu.
 */
export function namaSketsaBaru(daftar: MetaKanvas[], saat = new Date()): string {
  const hari = kunciTanggal(saat)
  const hariIni = daftar.filter((k) => {
    const t = dibuatPada(k.id)
    return t !== null && kunciTanggal(new Date(t)) === hari
  })
  const tanggal = `${tanggalPendek(saat)} ${saat.getFullYear()}`
  const dipakai = new Set(daftar.map((k) => k.title))
  let ke = hariIni.length + 1
  let nama = `${tanggal} · ${ke}`
  // Sketsa yang sudah diganti namanya tidak lagi terhitung, jadi nomor urutnya
  // bisa bentrok dengan yang masih memakai nama bawaan. Naikkan sampai bebas.
  while (dipakai.has(nama)) nama = `${tanggal} · ${++ke}`
  return nama
}

export async function daftarKanvas(): Promise<MetaKanvas[]> {
  return q<MetaKanvas>('SELECT * FROM canvases ORDER BY updated_at DESC')
}

/**
 * `grupId`: dicap ke baris index-nya (bukan berkas JSON-nya) supaya grup itu
 * bisa membuka kembali kanvas harian lamanya lewat riwayat — sekali dicap
 * saat kanvas dibuat, cap ini tidak pernah tertimpa oleh penyimpanan berikutnya.
 */
export async function buatKanvas(judul = 'New sketch', grupId?: string): Promise<string> {
  const id = newId('cnv')
  await simpanKanvas({
    id,
    title: judul,
    strokes: [],
    images: [],
    objects: [],
    texts: [],
    layers: lapisanBawaan(),
    // Bawaannya kertas A4 tegak, satu halaman — halaman berikutnya muncul
    // sendiri begitu yang terakhir mulai terisi.
    paper: KERTAS_BAWAAN,
    pages: 1,
    updated_at: Date.now(),
  })
  if (grupId) await x('UPDATE canvases SET group_id = ? WHERE id = ?', [grupId, id])
  return id
}

export async function ubahJudulKanvas(id: string, judul: string): Promise<void> {
  const berkas = await bacaKanvas(id)
  if (!berkas) return
  await simpanKanvas({ ...berkas, title: judul, updated_at: Date.now() })
}

/** Salinan lengkap dengan id baru — untuk mencoba arah lain tanpa merusak aslinya. */
export async function gandakanKanvas(id: string): Promise<string | null> {
  const berkas = await bacaKanvas(id)
  if (!berkas) return null
  const baru = newId('cnv')
  await simpanKanvas({ ...berkas, id: baru, title: `${berkas.title} copy`, updated_at: Date.now() })
  return baru
}

export async function bacaKanvas(id: string): Promise<BerkasKanvas | null> {
  const teks = await kanvas.baca(id)
  if (!teks) return null
  try {
    const data = JSON.parse(teks) as BerkasKanvas
    return {
      ...data,
      strokes: data.strokes ?? [],
      images: data.images ?? [],
      objects: data.objects ?? [],
      texts: data.texts ?? [],
      paper: data.paper ?? KERTAS_BAWAAN,
      pages: Math.max(1, Math.round(data.pages ?? 1)),
      layers: bacaLapisan(data.layers),
    }
  } catch {
    return null
  }
}

export async function simpanKanvas(berkas: BerkasKanvas, dasar?: number): Promise<void> {
  await kanvas.tulis(berkas.id, JSON.stringify(berkas), dasar)
  await x(
    `INSERT INTO canvases (id, title, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
    [berkas.id, berkas.title, berkas.updated_at],
  )
  // Id dan pengirim ikut disiarkan: editor lain yang membuka sketsa yang sama
  // memuat ulang dan menggabungkan, editor yang mengirimnya sendiri tidak.
  await pancarkan('canvas', { id: berkas.id, src: idKlien })
}

/**
 * Hapus sketsa: baris database dan berkas JSON-nya sekaligus.
 *
 * Isinya dikembalikan supaya penghapusan bisa diurungkan. Sebelumnya hanya
 * baris database yang dihapus, jadi berkas di folder vault menumpuk diam-diam
 * dan sketsa yang "sudah dihapus" kembali muncul saat vault diindeks ulang.
 */
export async function hapusKanvas(id: string): Promise<BerkasKanvas | null> {
  const isi = await bacaKanvas(id)
  await x('DELETE FROM canvases WHERE id = ?', [id])
  await kanvas.hapus(id).catch(() => {})
  await pancarkan('canvas', { id, src: idKlien, hapus: true })
  return isi
}

export async function pulihkanKanvas(berkas: BerkasKanvas | null): Promise<void> {
  if (!berkas) return
  await simpanKanvas(berkas)
}

export function berkasBaru(
  id: string,
  judul: string,
  coretan: Coretan[],
  lapisan: Lapisan[],
  gambar: Gambar[],
  objek: Objek[],
  teks: Teks[],
  kertas: string,
  halaman: number,
): BerkasKanvas {
  return {
    id,
    title: judul,
    strokes: coretan,
    images: gambar,
    objects: objek,
    texts: teks,
    layers: lapisan,
    paper: kertas,
    pages: halaman,
    updated_at: Date.now(),
  }
}
