import { useCallback, useEffect, useState } from 'react'
import { inTauri, sentuh, windowLabel } from '@/lib/runtime'
import { pasangTema, useTema, type TemaId } from '@/lib/theme'
import { useApp } from '@/lib/appStore'
import { getSetting, lipatWal } from '@/lib/db'
import { dengarkan } from '@/lib/events'
import { bukaJendelaBaru } from '@/lib/layar'
import { adminAktif, api, guruPembantu, namaPerangkat, pinAktif, sesiAktif, setAlamatServer, setPeranEditor, simpanAdmin, simpanSesi, type PeranEditor } from '@/lib/api'
import { hentikanSinkron, mulaiSinkron } from '@/lib/sinkron'
import { Toast } from '@/components/Toast'
import { Pengaturan } from '@/components/Pengaturan'
import { IconButton } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { KanvasLayar } from '@/modules/canvas/KanvasLayar'
import { toast } from '@/lib/toast'

const label = windowLabel()

// Layar sentuh (tablet Android/iPad): panel dan tombol dibesarkan lewat CSS.
// Jari butuh sasaran yang lebih lapang daripada kursor, dan di tablet 11 inci
// panel seukuran desktop terasa seperti mainan.
if (sentuh) document.documentElement.classList.add('ex-sentuh')

export interface InfoBerbagi {
  url: string
  urlTv: string
  urlMurid: string
  urlLokal: string
  publik: string | null
  tokenApp: string
  adminDiset: boolean
  pin: string
  port: number
  ip: string
  klien: { id: string; nama: string; peran: string }[]
}

/** Alamat publik Exact Practice (ruang guru: kunci jawaban + pemantauan). */
const ALAMAT_PRACTICE = 'https://practice2.exactprintsolution.com'

/**
 * Buka ruang guru Exact Practice. Guru pembantu dibawa masuk dengan sesi
 * Canvas-nya (tanpa login lagi; Practice memberinya peran guru); guru utama
 * di Mac/tablet membuka /guru dengan akun admin Practice-nya.
 */
async function bukaRuangGuru() {
  const sesi = sesiAktif()
  const url =
    guruPembantu() && sesi
      ? `${ALAMAT_PRACTICE}/api/auth/canvas?sesi=${encodeURIComponent(sesi)}&next=${encodeURIComponent('/guru')}`
      : `${ALAMAT_PRACTICE}/guru`
  if (inTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url).catch(() => {})
  } else {
    window.open(url, '_blank')
  }
}

export default function App() {
  const [siap, setSiap] = useState(false)
  const [galat, setGalat] = useState<string | null>(null)
  /** Di browser: editor butuh kata sandi admin (sandi admin sekaligus membuka kelas). */
  const [perluAdmin, setPerluAdmin] = useState(false)

  useEffect(() => pasangTema(), [])

  // Pastikan database (atau server, di browser) bisa dijangkau sebelum kanvas
  // mencoba membacanya.
  useEffect(() => {
    if (inTauri) {
      void getSetting('theme')
        .then(() => setSiap(true))
        .catch((e: unknown) => setGalat(e instanceof Error ? e.message : String(e)))
      return
    }
    void api<PeranEditor | undefined>('/api/admin/cek')
      .then((p) => {
        setPeranEditor(p)
        setSiap(true)
      })
      .catch((e: unknown) => {
        const status = (e as { status?: number }).status
        if (status === 401) setPerluAdmin(true)
        else setGalat(e instanceof Error ? e.message : String(e))
      })
  }, [])

  useAksi()
  usePenjagaWal()
  useBerbagi(siap)
  usePantauVersi(siap)

  if (galat) return <LayarGalat pesan={galat} />
  if (!inTauri && perluAdmin) {
    return (
      <LayarAdmin
        onMasuk={async (sandi) => {
          simpanAdmin(sandi)
          try {
            setPeranEditor(await api<PeranEditor | undefined>('/api/admin/cek'))
            setPerluAdmin(false)
            setSiap(true)
            return true
          } catch {
            simpanAdmin('')
            return false
          }
        }}
        onMasukGuru={async (hp, sandi) => {
          // Guru pembantu: akun biasa (nomor HP + sandi) yang diberi peran guru.
          try {
            const r = await api<{ token: string }>('/api/akun/masuk', { method: 'POST', json: { hp, sandi } })
            simpanAdmin('')
            simpanSesi(r.token)
            const p = await api<PeranEditor | undefined>('/api/admin/cek')
            if (p?.peran !== 'guru') {
              simpanSesi('')
              return 'This account is not a teacher yet — ask the main teacher to make it one.'
            }
            setPeranEditor(p)
            setPerluAdmin(false)
            setSiap(true)
            return null
          } catch (e) {
            simpanSesi('')
            return e instanceof Error ? e.message : String(e)
          }
        }}
      />
    )
  }
  if (!siap) return <LayarMemuat />

  return (
    <>
      <div className="ex-texture relative h-full w-full">
        <KanvasLayar />
        <div className="absolute right-3 top-3 z-10 flex gap-2">
          <button
            className="ex-card ex-btn"
            data-variant="ghost"
            style={{ padding: '6px 10px', fontSize: 'var(--fs-label)' }}
            title="Answer keys and live monitoring in Exact Practice"
            onClick={() => void bukaRuangGuru()}
          >
            📘 Answer keys
          </button>
          {!guruPembantu() && (
            <IconButton
              nama="atur"
              label="Settings (⌘,)"
              className="ex-card"
              onClick={() => useApp.getState().setPengaturan(true)}
            />
          )}
        </div>
      </div>
      <Pengaturan />
      <Toast />
    </>
  )
}

/**
 * Tablet/browser bisa tetap membuka tab lamanya sementara Mac-nya sudah
 * dipasangi versi baru aplikasi — tanpa ini, tab itu diam-diam terus
 * menjalankan kode lama (ini yang berkali-kali membuat perbaikan yang sudah
 * dipasang di Mac terasa "belum berhasil" padahal cuma tabnya yang basi).
 * Dicek berkala; begitu boot id server berubah (Mac dibuka ulang dengan
 * pemasangan baru), tawarkan muat ulang alih-alih memaksanya diam-diam.
 */
function usePantauVersi(siap: boolean) {
  useEffect(() => {
    if (!siap || inTauri) return
    let bootAwal: string | null = null
    let ditawarkan = false
    const cek = async () => {
      if (ditawarkan) return
      try {
        const r = await api<{ boot: string }>('/api/boot')
        if (bootAwal === null) {
          bootAwal = r.boot
          return
        }
        if (r.boot !== bootAwal) {
          ditawarkan = true
          toast('A new version was installed on the Mac.', { label: 'Refresh', jalankan: () => location.reload() })
        }
      } catch {
        // Server sedang tidak terjangkau — coba lagi di siklus berikutnya.
      }
    }
    void cek()
    const id = window.setInterval(() => void cek(), 45_000)
    return () => window.clearInterval(id)
  }, [siap])
}

/**
 * Berbagi di jaringan.
 *
 * Di Mac: kalau sakelarnya menyala di Pengaturan, servernya dinyalakan saat
 * aplikasi dibuka dan jendela ini menyambung ke hub-nya sendiri supaya ikut
 * menyiarkan goresan. Di browser (tablet): langsung menyambung ke server yang
 * menyajikan halaman ini.
 */
function useBerbagi(siap: boolean) {
  useEffect(() => {
    if (!siap) return
    if (!inTauri) {
      const ws = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
      mulaiSinkron({ url: ws, pin: pinAktif(), peran: 'editor', nama: namaPerangkat(), admin: adminAktif(), sesi: sesiAktif() || undefined })
      return () => hentikanSinkron()
    }
    const terapkan = async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      const mau = (await getSetting('berbagi').catch(() => null)) === '1'
      // Alamat publik (Cloudflare) diberitahukan ke server sebelum tautan dibuat.
      const publik = await getSetting('alamat_publik').catch(() => null)
      await invoke('share_set_public', { alamat: publik || null }).catch(() => {})
      const sandi = await getSetting('sandi_admin').catch(() => null)
      await invoke('share_set_admin', { sandi: sandi || null }).catch(() => {})
      let info = await invoke<InfoBerbagi | null>('share_status').catch(() => null)
      if (mau && !info) {
        const pin = await getSetting('berbagi_pin').catch(() => null)
        info = await invoke<InfoBerbagi>('share_start', { pin }).catch((e: unknown) => {
          toast(`Could not start sharing: ${e instanceof Error ? e.message : String(e)}`)
          return null
        })
      }
      if (!mau && info) {
        await invoke('share_stop').catch(() => {})
        info = null
      }
      if (info) {
        setAlamatServer(`http://127.0.0.1:${info.port}`, info.pin, info.tokenApp)
        mulaiSinkron({ url: `ws://127.0.0.1:${info.port}/ws`, pin: info.pin, peran: 'editor', nama: 'Mac', admin: info.tokenApp })
      } else hentikanSinkron()
    }
    void terapkan()
    const lepas = dengarkan('settings', () => void terapkan())
    return () => lepas()
  }, [siap])
}

/**
 * Rapikan database tiap kali jendela ditinggalkan, dan sebelum berhenti —
 * supaya salinan yang disinkron iCloud selalu satu berkas yang utuh.
 */
function usePenjagaWal() {
  useEffect(() => {
    if (!inTauri || label !== 'focus') return
    const rapikan = () => void lipatWal()
    const saatSembunyi = () => {
      if (document.hidden) rapikan()
    }
    window.addEventListener('blur', rapikan)
    window.addEventListener('beforeunload', rapikan)
    document.addEventListener('visibilitychange', saatSembunyi)
    return () => {
      window.removeEventListener('blur', rapikan)
      window.removeEventListener('beforeunload', rapikan)
      document.removeEventListener('visibilitychange', saatSembunyi)
    }
  }, [])
}

/* ── Perintah menu & pintasan ──────────────────────────────────────── */

/** Pintasan cadangan, hanya dipakai saat aplikasi dibuka di browser. */
const PINTASAN: Record<string, string | undefined> = {
  n: 'aksi:sketsa-baru',
  ',': 'aksi:pengaturan',
  p: 'aksi:cetak',
}
const PINTASAN_SHIFT: Record<string, string | undefined> = {
  t: 'tema:siklus',
  n: 'window:baru',
}

function useAksi() {
  const mintaSketsaBaru = useApp((s) => s.mintaSketsaBaru)
  const mintaCetak = useApp((s) => s.mintaCetak)
  const setPengaturan = useApp((s) => s.setPengaturan)
  const gantiTema = useTema((s) => s.ganti)
  const siklusTema = useTema((s) => s.siklus)

  const jalankan = useCallback(
    async (id: string) => {
      if (id.startsWith('tema:')) {
        const t = id.slice(5)
        if (t === 'siklus') await siklusTema()
        else await gantiTema(t as TemaId)
        return
      }
      switch (id) {
        case 'aksi:sketsa-baru':
          mintaSketsaBaru()
          break
        case 'aksi:cetak':
          mintaCetak()
          break
        case 'aksi:pengaturan':
          setPengaturan(true)
          break
        case 'window:baru': {
          const l = await bukaJendelaBaru('kanvas')
          if (!l) toast('All canvas windows are already open.')
          break
        }
      }
    },
    [mintaSketsaBaru, mintaCetak, setPengaturan, gantiTema, siklusTema],
  )

  // Menu bar macOS meneruskan kliknya ke sini.
  useEffect(() => {
    if (!inTauri) return
    let lepas: (() => void) | null = null
    let batal = false
    void import('@tauri-apps/api/event').then(async ({ listen }) => {
      const un = await listen<string>('ui:menu', (e) => void jalankan(String(e.payload)))
      if (batal) un()
      else lepas = un
    })
    return () => {
      batal = true
      lepas?.()
    }
  }, [jalankan])

  // Di dalam aplikasi, pintasan dipegang menu asli macOS — kalau ditangani di
  // sini juga, satu tekanan tombol menjalankan aksinya dua kali.
  useEffect(() => {
    if (inTauri) return
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      const id = e.shiftKey ? PINTASAN_SHIFT[k] : PINTASAN[k]
      if (!id) return
      e.preventDefault()
      void jalankan(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jalankan])
}

/* ── Layar keadaan ─────────────────────────────────────────────────── */

function LayarMemuat() {
  return (
    <div className="grid h-full place-items-center" style={{ color: 'var(--ink-faint)' }}>
      {inTauri ? 'Preparing vault…' : 'Connecting to the Mac…'}
    </div>
  )
}

function LayarGalat({ pesan }: { pesan: string }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <div className="ex-card max-w-[560px] p-6">
        <h1 className="ex-module-title mb-2">{inTauri ? 'Cannot open the database' : 'Cannot reach the Mac'}</h1>
        <p style={{ color: 'var(--ink-soft)' }}>{pesan}</p>
        <p className="ex-label mt-3" style={{ color: 'var(--ink-faint)' }}>
          {inTauri
            ? 'Check the vault folder (~/ExactCanvas) and its permissions, then restart the app.'
            : 'Make sure Exact Canvas is open on the Mac with sharing turned on, and that this device is on the same Wi-Fi.'}
        </p>
      </div>
    </div>
  )
}

/** Gerbang kata sandi admin: editor hanya untuk guru, PIN saja tidak cukup. */
function LayarAdmin({
  onMasuk,
  onMasukGuru,
}: {
  onMasuk: (sandi: string) => Promise<boolean>
  /** null = berhasil, teks = pesan galat. */
  onMasukGuru: (hp: string, sandi: string) => Promise<string | null>
}) {
  const [sandi, setSandi] = useState('')
  const [salah, setSalah] = useState(false)
  const [sibuk, setSibuk] = useState(false)
  const [modeGuru, setModeGuru] = useState(false)
  const [hp, setHp] = useState('')
  const [sandiGuru, setSandiGuru] = useState('')
  const [galatGuru, setGalatGuru] = useState<string | null>(null)
  if (modeGuru) {
    return (
      <div className="grid h-full place-items-center p-8">
        <form
          className="ex-card flex w-full max-w-[380px] flex-col gap-3 p-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (!hp || !sandiGuru) return
            setSibuk(true)
            void onMasukGuru(hp, sandiGuru).then((g) => {
              setSibuk(false)
              setGalatGuru(g)
            })
          }}
        >
          <h1 className="ex-module-title flex items-center gap-2">
            <Icon nama="gembok" ukuran={15} /> Assistant teacher sign-in
          </h1>
          <p style={{ color: 'var(--ink-soft)' }}>
            Sign in with your class account (phone number and password). The main teacher has to mark the account as a
            teacher first.
          </p>
          <input className="ex-input" inputMode="tel" autoFocus placeholder="Phone number" value={hp}
            onChange={(e) => { setGalatGuru(null); setHp(e.target.value) }} aria-label="Phone number" />
          <input className="ex-input" type="password" placeholder="Password" value={sandiGuru}
            onChange={(e) => { setGalatGuru(null); setSandiGuru(e.target.value) }} aria-label="Password" />
          {galatGuru && (
            <p className="ex-label" style={{ color: 'var(--down)' }}>
              {galatGuru}
            </p>
          )}
          <button className="ex-btn" data-variant="accent" disabled={!hp || !sandiGuru || sibuk} type="submit">
            Open the editor
          </button>
          <button className="ex-btn" data-variant="ghost" type="button" onClick={() => setModeGuru(false)}>
            Main teacher? Use the admin password
          </button>
        </form>
      </div>
    )
  }
  return (
    <div className="grid h-full place-items-center p-8">
      <form
        className="ex-card flex w-full max-w-[380px] flex-col gap-3 p-6"
        onSubmit={(e) => {
          e.preventDefault()
          if (!sandi) return
          setSibuk(true)
          void onMasuk(sandi).then((ok) => {
            setSibuk(false)
            if (!ok) setSalah(true)
          })
        }}
      >
        <h1 className="ex-module-title flex items-center gap-2">
          <Icon nama="gembok" ukuran={15} /> Teacher sign-in
        </h1>
        <p style={{ color: 'var(--ink-soft)' }}>
          The editor is for the teacher. Enter the admin password from Settings on the Mac — no PIN
          needed.
        </p>
        <input
          className="ex-input"
          type="password"
          autoFocus
          value={sandi}
          onChange={(e) => {
            setSalah(false)
            setSandi(e.target.value)
          }}
          aria-label="Admin password"
        />
        {salah && (
          <p className="ex-label" style={{ color: 'var(--down)' }}>
            Wrong password, or no admin password has been set yet on the Mac.
          </p>
        )}
        <button className="ex-btn" data-variant="accent" disabled={!sandi || sibuk} type="submit">
          Open the editor
        </button>
        <button className="ex-btn" data-variant="ghost" type="button" onClick={() => setModeGuru(true)}>
          Assistant teacher? Sign in with your account
        </button>
      </form>
    </div>
  )
}

