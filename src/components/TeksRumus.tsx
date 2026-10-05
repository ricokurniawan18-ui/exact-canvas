import { useEffect, useMemo, useState } from 'react'
import katex from 'katex'

/* Teks yang memuat rumus LaTeX di antara tanda $ … $ (atau $$ … $$ untuk rumus
 * yang berdiri sendiri), digambar dengan KaTeX; tag diagram "[[grafik: …]]",
 * "[[gerak: …]]", dst. digambar penggambar Exact Worksheet Maker.
 *
 * Dipakai kartu antrean pertanyaan: soal yang dikirim Exact Practice memakai
 * notasi yang sama dengan bank soalnya, jadi tanpa ini guru membaca
 * "$2^{x^2 - 3x} \le 16$" apa adanya — pertidaksamaan yang justru jadi inti
 * pertanyaannya malah paling sulit dibaca — dan grafik gerak yang ditanyakan
 * anak cuma tampil sebagai "[[gerak: titik=…]]".
 *
 * Pemisah dan pilihan sengaja disamakan dengan RichText milik Exact Practice
 * supaya satu teks tergambar sama di kedua aplikasi.
 */

/* Tag diagram diangkat PALING AWAL: isinya penuh tanda $ dan garis bawah yang
 * kalau dibiarkan akan ditangkap sebagai rumus. */
const RE_TAG = /\[\[([\s\S]*?)\]\]/g
const RE_RUMUS = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g

/** Penggambar tag diagram: isi tag tanpa kurung siku → HTML. */
export type GambarTag = (inner: string) => string

interface Bagian {
  isi: string
  jenis: 'teks' | 'rumus' | 'diagram' | 'tabel'
  blok: boolean
}

function pisahRumus(teks: string, bagian: Bagian[]) {
  let akhir = 0
  for (const m of teks.matchAll(RE_RUMUS)) {
    const mulai = m.index ?? 0
    if (mulai > akhir) bagian.push({ isi: teks.slice(akhir, mulai), jenis: 'teks', blok: false })
    const blok = m[1] !== undefined
    bagian.push({ isi: blok ? m[1] : m[2], jenis: 'rumus', blok })
    akhir = mulai + m[0].length
  }
  if (akhir < teks.length) bagian.push({ isi: teks.slice(akhir), jenis: 'teks', blok: false })
}

/* Tabel markdown ("| a | b |" berderet, baris pemisah "|---|---|" dibuang)
 * dipisah per blok baris sebelum rumus, sama seperti RichText Exact Practice. */
const RE_TABEL = /(?:^|\n)((?:[ \t]*\|[^\n]*(?:\n|$))+)/g

function pisahTabel(teks: string, bagian: Bagian[]) {
  let akhir = 0
  for (const m of teks.matchAll(RE_TABEL)) {
    const mulai = (m.index ?? 0) + (m[0].startsWith('\n') ? 1 : 0)
    if (mulai > akhir) pisahRumus(teks.slice(akhir, mulai), bagian)
    bagian.push({ isi: m[1].replace(/\n$/, ''), jenis: 'tabel', blok: true })
    akhir = (m.index ?? 0) + m[0].length
  }
  if (akhir < teks.length) pisahRumus(teks.slice(akhir), bagian)
}

function pisah(teks: string): Bagian[] {
  const bagian: Bagian[] = []
  let akhir = 0
  for (const m of teks.matchAll(RE_TAG)) {
    const mulai = m.index ?? 0
    if (mulai > akhir) pisahTabel(teks.slice(akhir, mulai), bagian)
    bagian.push({ isi: m[1].trim(), jenis: 'diagram', blok: true })
    akhir = mulai + m[0].length
  }
  if (akhir < teks.length) pisahTabel(teks.slice(akhir), bagian)
  return bagian
}

function lolos(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* Kesalahan LaTeX yang kerap ditulis AI dan membuat KaTeX menolak seluruh
 * rumus: pangkat di dalam \text{} ("29.0\text{ ^\circ C}"). Diangkat keluar
 * jadi "29.0^\circ\text{C}" — sama dengan sanitizeMath di Worksheet Maker
 * dan rapikanLatex di Practice. */
function rapikanLatex(src: string): string {
  return src
    .replace(/\\,\s*\^/g, '^')
    .replace(/\\text\{\s*\^\s*(\{\s*\\circ\s*\}|\\circ)\s*([^{}]*?)\s*\}/g, (_m, _c, rest: string) => '^\\circ' + (rest ? '\\text{' + rest + '}' : ''))
}

function htmlTabel(src: string, gambar?: GambarTag): string {
  const baris = src
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r && !/^\|[\s:|-]+\|?$/.test(r))
    .map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
  if (baris.length === 0) return ''
  const sel = (tag: 'th' | 'td', c: string) =>
    `<${tag} style="border:1px solid #999;padding:4px 10px;text-align:${tag === 'th' ? 'left' : 'inherit'}${tag === 'th' ? ';background:#f0f0f0' : ''}">${htmlRumus(c, gambar)}</${tag}>`
  const [kepala, ...isi] = baris
  return (
    '<table style="border-collapse:collapse;margin:8px 0;white-space:normal"><thead><tr>' +
    kepala.map((c) => sel('th', c)).join('') +
    '</tr></thead><tbody>' +
    isi.map((r) => `<tr>${r.map((c) => sel('td', c)).join('')}</tr>`).join('') +
    '</tbody></table>'
  )
}

function htmlBagian(b: Bagian, gambar?: GambarTag): string {
  if (b.jenis === 'tabel') return htmlTabel(b.isi, gambar)
  if (b.jenis === 'rumus') {
    return katex.renderToString(rapikanLatex(b.isi), { displayMode: b.blok, throwOnError: false, output: 'html', strict: false })
  }
  if (b.jenis === 'diagram') {
    if (!gambar) return '<span class="ws-diagram-memuat">memuat diagram…</span>'
    // Tag yang tidak dikenal penggambar dikembalikan apa adanya supaya guru
    // masih melihat apa yang ditulis muridnya, bukan lubang kosong.
    return gambar(b.isi) || lolos(`[[${b.isi}]]`)
  }
  return lolos(b.isi)
}

/* Penggambar diagram itu 240 KB — terlalu berat untuk ikut di bundel awal,
 * padahal kebanyakan pertanyaan tidak berdiagram. Jadi modulnya baru diambil
 * saat ada teks yang benar-benar memuat "[[", lalu dipakai ulang. */
let modulDiagram: GambarTag | null = null
let sedangMuat: Promise<GambarTag> | null = null

/** Penggambar diagram, dimuat sekali saat pertama diminta. */
export function muatPenggambar(): Promise<GambarTag> {
  if (modulDiagram) return Promise.resolve(modulDiagram)
  if (!sedangMuat) {
    sedangMuat = import('@/lib/diagrams.js').then((m) => {
      modulDiagram = m.renderDiagramTag
      return modulDiagram
    })
  }
  return sedangMuat
}

function useGambarDiagram(perlu: boolean): GambarTag | null {
  /* useState(fn) memperlakukan fungsi sebagai inisialisator malas dan
   * memanggilnya, jadi penggambar harus dibungkus. */
  const [gambar, setGambar] = useState<GambarTag | null>(() => modulDiagram)
  useEffect(() => {
    if (!perlu || gambar) return
    let hidup = true
    void muatPenggambar().then((g) => {
      if (hidup) setGambar(() => g)
    })
    return () => {
      hidup = false
    }
  }, [perlu, gambar])
  return perlu ? gambar : null
}

/**
 * Teks yang sama sebagai string HTML: teks biasa dilolos-escape, rumus lewat
 * KaTeX, diagram lewat `gambar` (ambil dari muatPenggambar() bila teksnya
 * memuat "[["). Dipakai saat soal teks (mis. kiriman Exact Practice) harus
 * jadi gambar di kanvas — html2canvas butuh DOM sungguhan, bukan simpul React.
 */
export function htmlRumus(teks: string, gambar?: GambarTag): string {
  return pisah(teks)
    .map((b) => htmlBagian(b, gambar))
    .join('')
}

export function TeksRumus({ teks }: { teks: string }) {
  const gambar = useGambarDiagram(teks.includes('[['))
  const bagian = useMemo(() => pisah(teks), [teks])
  return (
    <>
      {bagian.map((b, i) =>
        b.jenis === 'teks' ? (
          <span key={i}>{b.isi}</span>
        ) : (
          <span
            key={i}
            /* Hanya potongan rumus/diagram yang disisipkan sebagai HTML, dan
               isinya keluaran KaTeX (throwOnError mati, jadi LaTeX cacat
               kembali sebagai teks bertanda, bukan lemparan) atau SVG dari
               penggambar diagram yang meng-escape teksnya sendiri. Teks biasa
               tetap simpul teks React sehingga lolos-escape tidak mungkin
               terjadi. */
            style={b.jenis === 'diagram' || b.jenis === 'tabel' ? { display: 'block' } : undefined}
            dangerouslySetInnerHTML={{ __html: htmlBagian(b, gambar ?? undefined) }}
          />
        ),
      )}
    </>
  )
}
