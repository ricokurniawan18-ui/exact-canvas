import { create } from 'zustand'

/**
 * Tampilan PER PERANGKAT (disimpan di localStorage browser/aplikasi ini, tidak ikut ke perangkat lain):
 * ukuran bilah (rel alat, panel, pemilih sketsa) dan bagian mana yang disembunyikan. HP guru pembantu dan Mac guru
 * utama punya kebutuhan berbeda, jadi pengaturannya tidak dibagi lewat kelas.
 */
export interface BagianTampilan {
  id: string
  label: string
  grup: 'rel' | 'layar'
}

export const BAGIAN: BagianTampilan[] = [
  { id: 'alat', label: 'Tools and shapes', grup: 'rel' },
  { id: 'penghapus', label: 'Eraser', grup: 'rel' },
  { id: 'warna', label: 'Colour', grup: 'rel' },
  { id: 'goresan', label: 'Thickness, ink, line pattern', grup: 'rel' },
  { id: 'kertas', label: 'Paper and pages', grup: 'rel' },
  { id: 'lapisan', label: 'Layers', grup: 'rel' },
  { id: 'instrumen', label: 'Ruler, protractor, compass', grup: 'rel' },
  { id: 'sisip', label: 'Insert graph, table, PDF, image', grup: 'rel' },
  { id: 'kelas', label: 'Class (queue, students, groups)', grup: 'rel' },
  { id: 'undo', label: 'Undo / redo', grup: 'rel' },
  { id: 'ekspor', label: 'Export, print, import', grup: 'rel' },
  { id: 'jendela', label: 'Open in another window', grup: 'rel' },
  { id: 'sembunyi', label: 'Hide-all-panels button', grup: 'rel' },
  { id: 'sketsa', label: 'Sketch picker bar (bottom left)', grup: 'layar' },
  { id: 'halaman', label: 'Page list (bottom right)', grup: 'layar' },
  { id: 'practice', label: 'Practice button (top right)', grup: 'layar' },
  { id: 'statusbar', label: 'Status line', grup: 'layar' },
]

export const UKURAN = [
  { nilai: 0.85, label: 'Small' },
  { nilai: 1, label: 'Normal' },
  { nilai: 1.2, label: 'Large' },
  { nilai: 1.45, label: 'Extra large' },
] as const

const KUNCI = 'exact-tampilan-perangkat'

interface Isi {
  skala: number
  sembunyi: Record<string, boolean>
}

function muat(): Isi {
  try {
    const d = JSON.parse(localStorage.getItem(KUNCI) || '{}') as Partial<Isi>
    const skala = typeof d.skala === 'number' && d.skala >= 0.6 && d.skala <= 2 ? d.skala : 1
    return { skala, sembunyi: d.sembunyi && typeof d.sembunyi === 'object' ? d.sembunyi : {} }
  } catch {
    return { skala: 1, sembunyi: {} }
  }
}

function simpan(i: Isi) {
  try {
    localStorage.setItem(KUNCI, JSON.stringify(i))
  } catch {
    /* penyimpanan diblokir: tampilan tetap berlaku sampai muat ulang */
  }
}

function terapkan(skala: number) {
  document.documentElement.style.setProperty('--skala-bilah', String(skala))
}

interface Toko extends Isi {
  setSkala: (v: number) => void
  ganti: (id: string) => void
  setel: () => void
  atur: (id: string, tampil: boolean) => void
  pulihkan: () => void
}

export const useTampilan = create<Toko>((set, get) => ({
  ...muat(),
  setSkala: (skala) => {
    terapkan(skala)
    set({ skala })
    simpan({ skala, sembunyi: get().sembunyi })
  },
  ganti: (id) => get().atur(id, !!get().sembunyi[id]),
  setel: () => terapkan(get().skala),
  atur: (id, tampil) => {
    const sembunyi = { ...get().sembunyi, [id]: !tampil }
    set({ sembunyi })
    simpan({ skala: get().skala, sembunyi })
  },
  pulihkan: () => {
    terapkan(1)
    set({ skala: 1, sembunyi: {} })
    simpan({ skala: 1, sembunyi: {} })
  },
}))

/** true bila bagian ini boleh tampil di perangkat ini. */
export const useAda = (id: string) => useTampilan((s) => !s.sembunyi[id])
