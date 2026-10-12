import { useEffect, useRef, useState } from 'react'
import { useTampilan } from '@/lib/tampilan'
import { useApp } from '@/lib/appStore'
import { useData } from '@/lib/useData'
import { windowLabel } from '@/lib/runtime'
import { Icon } from '@/components/ui/Icon'
import { Kosong } from '@/components/ui/Kosong'
import { IconButton } from '@/components/ui/Button'
import { hapusDenganUrungkan, toast } from '@/lib/toast'
import { Canvas } from './Canvas'
import {
  buatKanvas,
  daftarKanvas,
  type MetaKanvas,
  gandakanKanvas,
  hapusKanvas,
  namaSketsaBaru,
  pulihkanKanvas,
  ubahJudulKanvas,
} from './data'

/**
 * Kanvas lengkap dengan pengelola sketsa: pilih, ganti nama, gandakan, hapus.
 * Sketsa pertama dibuat otomatis supaya layar tidak pernah kosong melompong.
 */
export function KanvasLayar() {
  const sembunyiPerangkat = useTampilan((x) => x.sembunyi)
  const { data: kanvas, memuat } = useData('canvas', daftarKanvas, [])
  const [aktif, setAktif] = useState<string | null>(null)
  const [ubahNama, setUbahNama] = useState(false)
  const [nama, setNama] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [kelolaTerbuka, setKelolaTerbuka] = useState(false)
  const [dipilih, setDipilih] = useState<Set<string>>(new Set())

  /**
   * Sketsa pertama hanya dibuat oleh window kerja.
   *
   * Sebelumnya setiap layar yang menampilkan kanvas ikut membuatnya, dan
   * daftarnya masih kosong selama kueri pertama berjalan — jadi tiap peluncuran
   * meninggalkan beberapa "First sketch" kosong sekaligus. Sekarang: tunggu
   * pemuatan selesai, satu window saja yang berhak, dan sekali per sesi.
   */
  const pernahBuat = useRef(false)

  /**
   * Sketsa yang baru dibuat, sebelum daftarnya sempat menyusul.
   *
   * `buatKanvas` menulis ke database lalu menyiarkan perubahan, tapi daftar di
   * layar dimuat ulang secara asinkron — jadi ada satu render di mana sketsa
   * baru sudah dipilih tapi belum ada di daftar. Tanpa penanda ini, efek di
   * bawah menganggap pilihannya lenyap dan melemparkannya kembali ke sketsa
   * lama: tombol "sketsa baru" terlihat tidak bekerja, dan sketsa kosongnya
   * menumpuk diam-diam.
   */
  const menunggu = useRef<MetaKanvas | null>(null)

  const bukaBaru = (id: string, judul: string) => {
    menunggu.current = { id, title: judul, updated_at: Date.now() }
    setAktif(id)
  }

  useEffect(() => {
    // Sketsa yang sedang dibuka bisa lenyap — dihapus di sini, atau dari window
    // lain yang membuka kanvas yang sama. Pilihannya jatuh ke sketsa berikutnya.
    if (aktif && kanvas.some((k) => k.id === aktif)) {
      menunggu.current = null
      return
    }
    if (menunggu.current?.id === aktif) return
    if (kanvas.length > 0) {
      setAktif(kanvas[0].id)
      return
    }
    setAktif(null)
    if (memuat || pernahBuat.current || windowLabel() !== 'focus') return
    pernahBuat.current = true
    const judul = namaSketsaBaru(kanvas)
    void buatKanvas(judul).then((id) => bukaBaru(id, judul))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kanvas, aktif, memuat])

  useEffect(() => {
    if (ubahNama) window.setTimeout(() => inputRef.current?.select(), 20)
  }, [ubahNama])

  /**
   * ⌘N saat kanvas terbuka: sketsa baru, bukan catatan baru.
   *
   * Tombolnya dipegang menu asli macOS dan tidak pernah sampai ke sini, jadi
   * yang disimak adalah penghitung permintaan dari penangan menu. Nilai awalnya
   * ikut disimpan supaya membuka kanvas tidak langsung terhitung satu permintaan.
   */
  const mintaSketsa = useApp((s) => s.sketsaBaru)
  const sketsaTerlayani = useRef(mintaSketsa)

  useEffect(() => {
    if (mintaSketsa === sketsaTerlayani.current) return
    sketsaTerlayani.current = mintaSketsa
    const judul = namaSketsaBaru(kanvas)
    void buatKanvas(judul).then((id) => bukaBaru(id, judul))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mintaSketsa])

  // Permintaan membuka sketsa tertentu (kanvas khusus murid) dari mana pun.
  const diminta = useApp((s) => s.sketsaDiminta)
  useEffect(() => {
    if (!diminta) return
    bukaBaru(diminta.id, diminta.judul)
    useApp.setState({ sketsaDiminta: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diminta])

  const sekarang =
    kanvas.find((k) => k.id === aktif) ??
    (menunggu.current?.id === aktif ? menunggu.current : undefined)

  if (!aktif || !sekarang) {
    if (memuat) return null
    return (
      <div className="grid h-full place-items-center">
        <Kosong
          ikon="pena"
          judul="No sketches yet."
          sub="Create one to start drawing, or paste a screenshot straight onto the canvas."
          aksi={
            <button
              className="ex-btn"
              data-variant="accent"
              onClick={() => {
                const judul = namaSketsaBaru(kanvas)
                void buatKanvas(judul).then((id) => bukaBaru(id, judul))
              }}
            >
              <Icon nama="tambah" ukuran={15} /> New sketch
            </button>
          }
        />
      </div>
    )
  }

  async function simpanNama() {
    const bersih = nama.trim()
    setUbahNama(false)
    if (!bersih || !aktif || bersih === sekarang?.title) return
    await ubahJudulKanvas(aktif, bersih)
  }

  return (
    <div className="relative h-full w-full">
      <Canvas idKanvas={aktif} judul={sekarang.title} />

      {!sembunyiPerangkat.sketsa && (
      <div className="ex-card ex-bilah ex-sketsa absolute bottom-4 left-4 flex items-center gap-1 p-1">
        {ubahNama ? (
          <input
            ref={inputRef}
            className="ex-input"
            style={{ width: 190, padding: '5px 8px', fontSize: 'var(--fs-label)' }}
            value={nama}
            aria-label="Sketch name"
            onChange={(e) => setNama(e.target.value)}
            onBlur={() => void simpanNama()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void simpanNama()
              if (e.key === 'Escape') setUbahNama(false)
            }}
          />
        ) : (
          <select
            className="ex-input"
            style={{ width: 190, padding: '5px 8px', fontSize: 'var(--fs-label)' }}
            value={aktif}
            onChange={(e) => setAktif(e.target.value)}
            aria-label="Pick a sketch"
          >
            {kanvas.map((k) => (
              <option key={k.id} value={k.id}>
                {k.title}
              </option>
            ))}
          </select>
        )}

        <IconButton
          nama="pena"
          label="Rename this sketch"
          ukuran={15}
          onClick={() => {
            setNama(sekarang.title)
            setUbahNama(true)
          }}
        />

        <button
          className="ex-btn"
          data-variant="ghost"
          title="New sketch"
          aria-label="New sketch"
          onClick={() => {
            const judul = namaSketsaBaru(kanvas)
            void buatKanvas(judul).then((id) => bukaBaru(id, judul))
          }}
        >
          <Icon nama="tambah" ukuran={16} />
        </button>

        <IconButton
          nama="tarik"
          label="Duplicate this sketch"
          ukuran={15}
          onClick={async () => {
            const baru = await gandakanKanvas(aktif)
            if (baru) {
              bukaBaru(baru, `${sekarang.title} copy`)
              toast('Sketch duplicated.')
            }
          }}
        />

        {/* Menghapus sketsa membuang berkasnya juga, jadi selalu lewat
            urung-hapus — bukan dialog konfirmasi yang cuma memperlambat. */}
        <IconButton
          nama="hapus"
          label="Delete this sketch"
          ukuran={15}
          onClick={() => {
            const id = aktif
            const judul = sekarang.title
            void hapusDenganUrungkan(
              `“${judul}” deleted.`,
              () => hapusKanvas(id),
              pulihkanKanvas,
            )
          }}
        />

        <IconButton
          nama="arsip"
          label="Manage sketches — delete several at once"
          ukuran={15}
          onClick={() => {
            setDipilih(new Set())
            setKelolaTerbuka(true)
          }}
        />
      </div>
      )}

      {kelolaTerbuka && (
        <div
          className="absolute inset-0 z-30 grid place-items-center"
          style={{ background: 'rgba(36, 38, 43, 0.35)' }}
          onClick={() => setKelolaTerbuka(false)}
        >
          <div
            className="ex-card flex flex-col gap-2 p-3"
            style={{ width: 360, maxHeight: '70vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <strong className="ex-label">Manage sketches</strong>
              <button
                className="ex-btn"
                data-variant="ghost"
                style={{ padding: '3px 9px', fontSize: 12 }}
                onClick={() =>
                  setDipilih((d) => (d.size === kanvas.length ? new Set() : new Set(kanvas.map((k) => k.id))))
                }
              >
                {dipilih.size === kanvas.length ? 'Deselect all' : `Select all · ${kanvas.length}`}
              </button>
            </div>
            <div className="flex flex-col gap-1 overflow-y-auto" style={{ minHeight: 0 }}>
              {kanvas.map((k) => (
                <label key={k.id} className="flex items-center gap-2" style={{ padding: '3px 2px' }}>
                  <input
                    type="checkbox"
                    checked={dipilih.has(k.id)}
                    onChange={(e) =>
                      setDipilih((d) => {
                        const n = new Set(d)
                        if (e.target.checked) n.add(k.id)
                        else n.delete(k.id)
                        return n
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--fs-label)' }}>
                    {k.title}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex items-center justify-end gap-2">
              <button className="ex-btn" data-variant="ghost" onClick={() => setKelolaTerbuka(false)}>
                Close
              </button>
              <button
                className="ex-btn"
                data-variant="accent"
                disabled={dipilih.size === 0}
                onClick={() => {
                  const ids = Array.from(dipilih)
                  const n = ids.length
                  setKelolaTerbuka(false)
                  void hapusDenganUrungkan(
                    `${n} sketch${n === 1 ? '' : 'es'} deleted.`,
                    async () => Promise.all(ids.map((id) => hapusKanvas(id))),
                    async (isi) => {
                      await Promise.all(isi.map((b) => pulihkanKanvas(b)))
                    },
                  )
                }}
              >
                Delete {dipilih.size || ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
