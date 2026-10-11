/**
 * Ukuran halaman dalam satuan dunia, dihitung pada 96 dpi — angka yang sama
 * yang dipakai CSS, jadi 1 satuan dunia = 1 piksel CSS dan ukuran cetaknya
 * bisa dihitung langsung tanpa faktor konversi tersembunyi.
 *
 * Dipakai kanvas dan halaman TV; keduanya harus menggambar halaman yang sama.
 */
export interface Kertas {
  id: string
  label: string
  w: number
  h: number
  /** Milimeter, untuk PDF. */
  mmW: number
  mmH: number
}

/** Jarak antar halaman dalam satuan dunia — cukup untuk terlihat terpisah. */
export const JARAK_HALAMAN = 40

/** Batas halaman ke-`i` dalam koordinat dunia; halaman ditumpuk ke bawah. */
export function kotakHalaman(k: Kertas, i: number) {
  const atas = i * (k.h + JARAK_HALAMAN)
  return { x1: 0, y1: atas, x2: k.w, y2: atas + k.h }
}

export const KERTAS: Kertas[] = [
  { id: 'bebas', label: 'Infinite canvas', w: 0, h: 0, mmW: 0, mmH: 0 },
  { id: 'a4', label: 'A4 portrait', w: 794, h: 1123, mmW: 210, mmH: 297 },
  { id: 'a4l', label: 'A4 landscape', w: 1123, h: 794, mmW: 297, mmH: 210 },
  { id: 'a3', label: 'A3 portrait', w: 1123, h: 1587, mmW: 297, mmH: 420 },
  { id: 'letter', label: 'Letter portrait', w: 816, h: 1056, mmW: 216, mmH: 279 },
  { id: 'letterl', label: 'Letter landscape', w: 1056, h: 816, mmW: 279, mmH: 216 },
]

export function kertasDari(id: string | undefined): Kertas {
  return KERTAS.find((k) => k.id === id) ?? KERTAS[0]
}

/**
 * Halaman dan tinggi (koordinat dunia) coretan GURU yang terakhir — coretan
 * tanpa tanda `murid`. Dipakai saat membuka kanvas murid untuk dibahas lagi:
 * melompat ke halaman terakhir menjatuhkan guru di ujung PDF yang belum
 * pernah disentuh, padahal pembahasannya berhenti di halaman lain.
 * Kosong bila guru belum pernah mencoret di kanvas itu.
 */
export function letakCoretanGuruTerakhir(
  strokes: { points: [number, number, number][]; murid?: string }[],
  k: Kertas,
  jumlahHalaman: number,
): { halaman: number; cy: number } | null {
  if (k.h <= 0) return null
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i]
    if (s.murid || !s.points?.length) continue
    let lo = Infinity
    let hi = -Infinity
    for (const p of s.points) {
      if (p[1] < lo) lo = p[1]
      if (p[1] > hi) hi = p[1]
    }
    const cy = (lo + hi) / 2
    const halaman = Math.max(0, Math.min(jumlahHalaman - 1, Math.floor(cy / (k.h + JARAK_HALAMAN))))
    return { halaman, cy }
  }
  return null
}
