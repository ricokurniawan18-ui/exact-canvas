import { useEffect, useState } from 'react'
import { Modal } from './ui/Modal'
import { Icon } from './ui/Icon'
import { useApp } from '@/lib/appStore'
import { TEMA, useTema } from '@/lib/theme'
import {
  GULIR_BAWAAN,
  GULIR_MAKS,
  GULIR_MIN,
  muatKecepatan,
  simpanKecepatan,
  ZOOM_BAWAAN,
} from '@/lib/gulir'
import { inTauri } from '@/lib/runtime'
import { bukaVault, vault } from '@/lib/vault'
import { toast, toastGalat } from '@/lib/toast'
import { getSetting, setSetting } from '@/lib/db'
import { pancarkan } from '@/lib/events'
import { useSinkron } from '@/lib/sinkron'
import { BAGIAN, UKURAN, useTampilan } from '@/lib/tampilan'
import { api } from '@/lib/api'
import { aktifkanPush, matikanPush, pushDidukung, statusIzin, type StatusPush } from '@/lib/push'
import type { InfoBerbagi } from '@/App'

/**
 * Pengaturan (⌘,): tema, kecepatan gulir/zoom kanvas, dan letak vault.
 */
export function Pengaturan() {
  const buka = useApp((s) => s.pengaturanTerbuka)
  const tutup = useApp((s) => s.setPengaturan)
  const tema = useTema((s) => s.tema)
  const gantiTema = useTema((s) => s.ganti)

  const [gulir, setGulir] = useState(GULIR_BAWAAN)
  const [zoom, setZoom] = useState(ZOOM_BAWAAN)
  const [root, setRoot] = useState<string>('')

  useEffect(() => {
    if (!buka) return
    void muatKecepatan().then((k) => {
      setGulir(k.gulir)
      setZoom(k.zoom)
    })
    if (inTauri) void vault.info().then((i) => setRoot(i.root)).catch(() => {})
  }, [buka])

  async function pindahVault() {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const pilih = await open({ directory: true, multiple: false, title: 'Pick the vault folder' })
      if (!pilih || typeof pilih !== 'string') return
      await vault.pakai(pilih)
      toast('Vault folder changed. Restarting…')
      window.setTimeout(() => void vault.mulaiUlang(), 600)
    } catch (e) {
      toastGalat(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal buka={buka} judul="Settings" onTutup={() => tutup(false)} lebar={640}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="ex-module-title">Theme</h3>
          <div className="ex-palet-pilihan">
            {TEMA.map((t) => (
              <button
                key={t.id}
                className="ex-palet-kartu"
                data-terpilih={tema === t.id ? '' : undefined}
                onClick={() => void gantiTema(t.id)}
              >
                <span className="ex-palet-nama">{t.nama}</span>
                <span className="ex-palet-sub">{t.sub}</span>
              </button>
            ))}
          </div>
          <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
            ⌘⇧T cycles to the next theme.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h3 className="ex-module-title">Canvas</h3>
          <p className="ex-label" style={{ color: 'var(--ink-soft)' }}>
            How far the canvas moves per scroll. A trackpad and a wheel mouse rarely want the
            same number — try it with the input you actually use.
          </p>
          <Geser
            label="Scroll speed"
            nilai={gulir}
            onUbah={(v) => {
              setGulir(v)
              void simpanKecepatan({ gulir: v })
            }}
          />
          <Geser
            label="Zoom speed"
            nilai={zoom}
            onUbah={(v) => {
              setZoom(v)
              void simpanKecepatan({ zoom: v })
            }}
          />
        </section>

        <BagianPerangkat />
        <BagianNotif />

        {inTauri && <BagianBerbagi buka={buka} />}

        {inTauri && (
        <section className="flex flex-col gap-2">
          <h3 className="ex-module-title">Vault</h3>
          <p className="ex-label" style={{ color: 'var(--ink-soft)' }}>
            Your sketches live as plain JSON files in this folder — outside the app, so they
            survive the app. Put the folder in iCloud Drive to share it between Macs.
          </p>
          <p className="ex-num ex-label break-all" style={{ color: 'var(--ink-faint)' }}>
            {root || '—'}
          </p>
          <div className="flex gap-2">
            <button className="ex-btn" data-variant="ghost" onClick={() => void bukaVault()}>
              <Icon nama="folder" ukuran={15} /> Reveal in Finder
            </button>
            <button className="ex-btn" data-variant="ghost" onClick={() => void pindahVault()}>
              <Icon nama="arsip" ukuran={15} /> Use another folder…
            </button>
          </div>
        </section>
        )}

        <section className="flex flex-col gap-1">
          <h3 className="ex-module-title">Shortcuts</h3>
          <ul className="ex-label grid gap-1" style={{ color: 'var(--ink-soft)', gridTemplateColumns: '1fr 1fr' }}>
            <li>⌘N new sketch</li>
            <li>⌘P print</li>
            <li>⌘Z / ⇧⌘Z undo / redo</li>
            <li>⌘D duplicate selection</li>
            <li>⌘0 fit to sketch</li>
            <li>⌘1–⌘9 tool slots</li>
            <li>Esc or ⌘. hide / show panels</li>
            <li>⌘S save now</li>
            <li>Space + drag pan</li>
            <li>⌘ + scroll zoom</li>
            <li>Shift lock angle / square</li>
            <li>Hold pen still snap to shape</li>
            <li>S Pen side button / Wacom back end erase</li>
          </ul>
        </section>
      </div>
    </Modal>
  )
}

function Geser({
  label,
  nilai,
  onUbah,
}: {
  label: string
  nilai: number
  onUbah: (v: number) => void
}) {
  return (
    <label className="flex flex-wrap items-center gap-3">
      <span className="ex-label" style={{ color: 'var(--ink-soft)', width: '11ch' }}>
        {label}
      </span>
      <input
        type="range"
        min={GULIR_MIN * 100}
        max={GULIR_MAKS * 100}
        step={5}
        value={Math.round(nilai * 100)}
        onChange={(e) => onUbah(Number(e.target.value) / 100)}
        style={{ accentColor: 'var(--accent)', width: 200 }}
      />
      <span className="ex-num ex-label" style={{ color: 'var(--ink-faint)', width: '5ch' }}>
        {nilai.toFixed(2)}×
      </span>
      {Math.abs(nilai - 1) > 0.001 && (
        <button className="ex-btn" data-variant="ghost" onClick={() => onUbah(1)}>
          Reset
        </button>
      )}
    </label>
  )
}

/**
 * Berbagi di jaringan: TV membuka tautan TV sebagai layar pengikut, tablet
 * membuka tautan editor. Keduanya membawa PIN, jadi tinggal dipindai.
 */
function BagianBerbagi({ buka }: { buka: boolean }) {
  const [info, setInfo] = useState<InfoBerbagi | null>(null)
  const [qr, setQr] = useState('')
  const [sibuk, setSibuk] = useState(false)
  const [publik, setPublik] = useState('')
  const [pinKustom, setPinKustom] = useState('')
  const [sandiAdmin, setSandiAdmin] = useState('')
  /** Nama guru utama di pilihan "tanya ke siapa" pada HP murid dan Exact Practice. */
  const [namaGuru, setNamaGuru] = useState('')
  const [namaGuruTersimpan, setNamaGuruTersimpan] = useState('')
  const [zoomMurid, setZoomMurid] = useState(88)
  const [hapusHari, setHapusHari] = useState(7)

  useEffect(() => {
    if (!buka) return
    void getSetting('alamat_publik').then((v) => setPublik(v ?? '')).catch(() => {})
    void getSetting('sandi_admin').then((v) => setSandiAdmin(v ?? '')).catch(() => {})
    void getSetting('nama_guru')
      .then((v) => {
        setNamaGuru(v ?? '')
        setNamaGuruTersimpan(v ?? '')
      })
      .catch(() => {})
    void getSetting('murid_zoom')
      .then((v) => setZoomMurid(v ? Math.max(50, Math.min(100, Number(v))) : 88))
      .catch(() => {})
    void getSetting('hapus_kanvas_hari')
      .then((v) => setHapusHari(v == null || v === '' ? 7 : Math.max(0, Math.min(365, Number(v) || 0))))
      .catch(() => {})
  }, [buka])

  async function simpanZoomMurid(persen: number) {
    setZoomMurid(persen)
    await setSetting('murid_zoom', String(persen))
  }

  /** Umur kanvas sebelum disingkirkan otomatis (hari); 0 = tidak pernah. Dibaca pekerjaan latar di Rust tiap jam. */
  async function simpanHapusHari(hari: number) {
    const bersih = Number.isFinite(hari) ? Math.max(0, Math.min(365, Math.round(hari))) : 7
    setHapusHari(bersih)
    await setSetting('hapus_kanvas_hari', String(bersih))
  }

  /** Dibaca server di /api/kelas/guru; kosong = "Mr. Rico". */
  async function simpanNamaGuru(nama: string) {
    const bersih = nama.trim().slice(0, 40)
    setNamaGuru(bersih)
    if (bersih === namaGuruTersimpan) return
    await setSetting('nama_guru', bersih)
    setNamaGuruTersimpan(bersih)
    await pancarkan('kelas')
    toast(bersih ? `Students now see you as "${bersih}".` : 'Name cleared — students see "Mr. Rico".')
  }

  async function simpanSandiAdmin(sandi: string) {
    const bersih = sandi.trim()
    setSandiAdmin(bersih)
    await setSetting('sandi_admin', bersih)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('share_set_admin', { sandi: bersih || null }).catch(() => {})
    setInfo(await invoke<InfoBerbagi | null>('share_status').catch(() => null))
    toast(bersih.length >= 4 ? 'Admin password saved.' : 'Admin password cleared — the tablet editor is now closed.')
  }

  /** Simpan alamat publik, beri tahu server, segarkan tautan. */
  async function simpanPublik(alamat: string) {
    const bersih = alamat.trim().replace(/\/$/, '')
    setPublik(bersih)
    await setSetting('alamat_publik', bersih)
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('share_set_public', { alamat: bersih || null }).catch(() => {})
    setInfo(await invoke<InfoBerbagi | null>('share_status').catch(() => null))
    await pancarkan('settings')
  }
  const klien = useSinkron((s) => s.klien)
  const status = useSinkron((s) => s.status)

  useEffect(() => {
    if (!buka) return
    void import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<InfoBerbagi | null>('share_status').then(setInfo).catch(() => setInfo(null)),
    )
  }, [buka])

  useEffect(() => {
    if (!info) {
      setQr('')
      return
    }
    void import('@tauri-apps/api/core').then(({ invoke }) =>
      invoke<string>('share_qr', { text: info.urlMurid }).then(setQr).catch(() => setQr('')),
    )
  }, [info])

  async function nyalakan(pinBaru: string | null) {
    setSibuk(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const i = await invoke<InfoBerbagi>('share_start', { pin: pinBaru })
      await setSetting('berbagi', '1')
      await setSetting('berbagi_pin', i.pin)
      setInfo(i)
      await pancarkan('settings')
    } catch (e) {
      toastGalat(e instanceof Error ? e.message : String(e))
    } finally {
      setSibuk(false)
    }
  }

  async function matikan() {
    setSibuk(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('share_stop')
      await setSetting('berbagi', '0')
      setInfo(null)
      await pancarkan('settings')
    } finally {
      setSibuk(false)
    }
  }

  async function pinBaru() {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('share_stop')
    await nyalakan(null)
    toast('New PIN. Devices will need the new link.')
  }

  const salin = (teks: string) =>
    navigator.clipboard
      .writeText(teks)
      .then(() => toast('Link copied.'))
      .catch(() => toastGalat('Could not copy.'))

  const bukaDiBrowser = async (url: string) => {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url).catch(() => toastGalat('Could not open the browser.'))
  }

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="ex-module-title">Share on this network</h3>
        <label className="ex-label flex items-center gap-2" style={{ color: 'var(--ink-soft)' }}>
          <input
            type="checkbox"
            checked={info !== null}
            disabled={sibuk}
            onChange={(e) => (e.target.checked ? void nyalakan(null) : void matikan())}
            style={{ accentColor: 'var(--accent)' }}
          />
          {info ? 'On' : 'Off'}
        </label>
      </div>
      <p className="ex-label" style={{ color: 'var(--ink-soft)' }}>
        TVs and tablets on the same Wi-Fi open the canvas in their browser. TVs follow whoever is
        drawing; a tablet with a pen edits the same sketches. Nothing leaves this Mac.
      </p>

      <label className="flex flex-wrap items-center gap-2">
        <span className="ex-label" style={{ color: 'var(--ink-soft)', width: '13ch' }}>
          Your name
        </span>
        <input
          className="ex-input"
          style={{ flex: 1, minWidth: 200, padding: '5px 8px', fontSize: 'var(--fs-label)' }}
          placeholder="Mr. Rico"
          maxLength={40}
          value={namaGuru}
          onChange={(e) => setNamaGuru(e.target.value)}
          onBlur={() => void simpanNamaGuru(namaGuru)}
          onKeyDown={(e) => e.key === 'Enter' && void simpanNamaGuru(namaGuru)}
        />
      </label>
      <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
        Shown to students when they choose which teacher to ask (only when you have assistant teachers).
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="ex-label" style={{ color: 'var(--ink-soft)', width: '13ch' }}>
          Admin password
        </span>
        <input
          className="ex-input"
          type="password"
          style={{ flex: 1, minWidth: 200, padding: '5px 8px', fontSize: 'var(--fs-label)' }}
          placeholder="at least 4 characters — needed to open the editor on the tablet"
          value={sandiAdmin}
          onChange={(e) => setSandiAdmin(e.target.value)}
          onBlur={() => void simpanSandiAdmin(sandiAdmin)}
          onKeyDown={(e) => e.key === 'Enter' && void simpanSandiAdmin(sandiAdmin)}
        />
      </label>
      <p className="ex-label" style={{ color: sandiAdmin.trim().length >= 4 ? 'var(--ink-faint)' : 'var(--down)', fontSize: 11 }}>
        {sandiAdmin.trim().length >= 4
          ? 'The tablet asks for this once and remembers it. Students only ever need the PIN.'
          : 'No admin password yet: the tablet editor stays closed until you set one. This Mac is unaffected.'}
      </p>
      <label className="flex flex-wrap items-center gap-2">
        <span className="ex-label" style={{ color: 'var(--ink-soft)', width: '13ch' }}>
          Public address
        </span>
        <input
          className="ex-input"
          style={{ flex: 1, minWidth: 220, padding: '5px 8px', fontSize: 'var(--fs-label)' }}
          placeholder="https://meet2.exactprintsolution.com (via Cloudflare Tunnel)"
          value={publik}
          onChange={(e) => setPublik(e.target.value)}
          onBlur={() => void simpanPublik(publik)}
          onKeyDown={(e) => e.key === 'Enter' && void simpanPublik(publik)}
        />
      </label>
      <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
        Leave empty for Wi-Fi only. With a public address, links and the QR use it so phones can join
        on mobile data; the Wi-Fi link is still shown as a fallback. Use a 6–8 digit PIN when public.
      </p>

      {info && (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <div
            className="ex-card overflow-hidden"
            style={{ width: 150, height: 150, background: '#fff', padding: 4 }}
            dangerouslySetInnerHTML={{ __html: qr.replace(/<svg /, '<svg style="width:100%;height:100%" ') }}
          />
          <div className="flex min-w-0 flex-col gap-2">
            <Tautan label="Teacher (edit)" url={info.url} onSalin={salin} onBuka={bukaDiBrowser} />
            <Tautan label="TV (follow)" url={info.urlTv} onSalin={salin} onBuka={bukaDiBrowser} />
            <Tautan label="Students" url={info.urlMurid} onSalin={salin} onBuka={bukaDiBrowser} />
            {info.publik && <Tautan label="Students · Wi-Fi" url={info.urlLokal} onSalin={salin} onBuka={bukaDiBrowser} />}
            <p className="ex-label flex flex-wrap items-center gap-1" style={{ color: 'var(--ink-faint)' }}>
              PIN <span className="ex-num" style={{ color: 'var(--ink)', letterSpacing: '0.2em' }}>{info.pin}</span>
              {' · '}
              <button className="underline" onClick={() => void pinBaru()}>
                new PIN
              </button>
              {' · '}
              <input
                className="ex-input ex-num"
                style={{ width: 96, padding: '2px 6px', fontSize: 11 }}
                placeholder="set 4–8 digits"
                inputMode="numeric"
                value={pinKustom}
                onChange={(e) => setPinKustom(e.target.value.replace(/\D/g, '').slice(0, 8))}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || pinKustom.length < 4) return
                  void (async () => {
                    const { invoke } = await import('@tauri-apps/api/core')
                    await invoke('share_stop')
                    await nyalakan(pinKustom)
                    setPinKustom('')
                    toast('PIN changed. Devices need the new link.')
                  })()
                }}
                aria-label="Set a custom PIN"
              />
              {' · '}
              <span>{status === 'tersambung' ? 'this window connected' : 'this window connecting…'}</span>
            </p>
            <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              Connected:{' '}
              {klien.filter((k) => k.nama !== 'Mac').length === 0
                ? 'no other devices yet'
                : klien
                    .filter((k) => k.nama !== 'Mac')
                    .map((k) => `${k.nama}${k.peran === 'tv' ? ' (TV)' : ''}`)
                    .join(', ')}
            </p>
            <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
              The QR is the Students link. Students register once with name, phone number, password
              and the class PIN as the class code; after that they sign in with phone and password —
              the PIN never appears in their address bar. Teacher link asks for the admin password.
              TV link carries the PIN.
            </p>
            <label className="ex-label flex items-center gap-2" style={{ color: 'var(--ink-soft)' }}>
              Student zoom
              <input
                type="range"
                min={50}
                max={100}
                step={2}
                value={zoomMurid}
                onChange={(e) => void simpanZoomMurid(Number(e.target.value))}
                style={{ flex: 1 }}
              />
              <span className="ex-num" style={{ color: 'var(--ink)', width: 34, textAlign: 'right' }}>
                {zoomMurid}%
              </span>
            </label>
            <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
              How tightly a phone screen (portrait) fills with the teacher's view. Lower if it feels
              too zoomed in. Takes effect on students' next refresh — up to 20 seconds.
            </p>
            <label className="ex-label flex items-center gap-2" style={{ color: 'var(--ink-soft)' }}>
              Auto-delete sketches untouched for
              <input
                className="ex-input"
                type="number"
                min={0}
                max={365}
                value={hapusHari}
                onChange={(e) => setHapusHari(Number(e.target.value))}
                onBlur={() => void simpanHapusHari(hapusHari)}
                onKeyDown={(e) => e.key === 'Enter' && void simpanHapusHari(hapusHari)}
                style={{ width: 64, padding: '5px 8px', fontSize: 'var(--fs-label)', textAlign: 'right' }}
              />
              days
            </label>
            <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
              Applies to every sketch — students', groups' and your own. Checked hourly; removed
              sketches sit in the vault's "sampah" folder for 30 days before being deleted for good.
              0 = never.
            </p>
          </div>
        </div>
      )}
    </section>
  )
}

function Tautan({
  label,
  url,
  onSalin,
  onBuka,
}: {
  label: string
  url: string
  onSalin: (u: string) => void
  onBuka: (u: string) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="ex-label shrink-0" style={{ color: 'var(--ink-soft)', width: '10ch' }}>
        {label}
      </span>
      <span className="ex-num ex-label min-w-0 flex-1 truncate" style={{ color: 'var(--ink)' }} title={url}>
        {url}
      </span>
      <button className="ex-btn" data-variant="ghost" style={{ padding: '3px 8px' }} onClick={() => onSalin(url)}>
        Copy
      </button>
      <button className="ex-btn" data-variant="ghost" style={{ padding: '3px 8px' }} onClick={() => onBuka(url)}>
        Open
      </button>
    </div>
  )
}


/** Tampilan perangkat ini: ukuran bilah dan bagian yang boleh tampil. Disimpan di perangkat ini saja. */
/** Notifikasi di perangkat guru (tablet/HP lewat browser atau PWA): ringkasan les hari ini. */
function BagianNotif() {
  const [status, setStatus] = useState<StatusPush>(() => statusIzin())
  const [sibuk, setSibuk] = useState(false)
  useEffect(() => {
    if (statusIzin() === 'aktif') void aktifkanPush(api, 'guru', null, false).catch(() => undefined)
  }, [])
  if (inTauri || !pushDidukung()) return null
  const nyalakan = async () => {
    setSibuk(true)
    try {
      const s = await aktifkanPush(api, 'guru', null, true)
      setStatus(s)
      if (s === 'aktif') toast('Notifications on for this device.')
    } catch (e) {
      toastGalat(e instanceof Error ? e.message : String(e))
    } finally {
      setSibuk(false)
    }
  }
  const matikan = async () => {
    setSibuk(true)
    await matikanPush(api).catch((e) => toastGalat(e instanceof Error ? e.message : String(e)))
    setSibuk(false)
    toast('Notifications off for this device.')
  }
  return (
    <section className="flex flex-col gap-2">
      <h3 className="ex-module-title">This device: notifications</h3>
      <p className="ex-label" style={{ color: 'var(--ink-soft)' }}>
        A morning summary of today&apos;s lessons (who, what time), even when this tablet is locked. The Mac must be on.
      </p>
      <div className="flex flex-wrap gap-2">
        {status === 'aktif' ? (
          <button className="ex-btn" data-variant="ghost" disabled={sibuk} onClick={() => void matikan()}>
            🔕 Turn off on this device
          </button>
        ) : status === 'ditolak' ? (
          <span className="ex-label">Blocked — allow notifications for this site in the browser settings.</span>
        ) : (
          <button className="ex-btn" data-variant="accent" disabled={sibuk} onClick={() => void nyalakan()}>
            🔔 Turn on notifications
          </button>
        )}
      </div>
    </section>
  )
}

/** Tinta cepat (kanvas latensi rendah + prediksi pena) per perangkat — lihat Canvas.tsx. */
function TintaCepat() {
  const [aktif, setAktif] = useState(() => {
    try {
      return localStorage.getItem('exact-tinta-cepat') !== '0'
    } catch {
      return true
    }
  })
  return (
    <label className="flex items-start gap-2" style={{ fontSize: 'var(--fs-label)' }}>
      <input
        type="checkbox"
        checked={aktif}
        onChange={(e) => {
          setAktif(e.target.checked)
          try {
            localStorage.setItem('exact-tinta-cepat', e.target.checked ? '1' : '0')
          } catch {
            /* tidak tersedia */
          }
          toast('Reload the page to apply.')
        }}
        style={{ accentColor: 'var(--accent)', width: 18, height: 18, marginTop: 1 }}
      />
      <span>
        Fast ink (low-latency drawing with pen prediction)
        <span className="ex-label block" style={{ color: 'var(--ink-soft)' }}>
          Keeps the ink right under the pen tip. Turn off only if ink flickers on this device.
        </span>
      </span>
    </label>
  )
}

function BagianPerangkat() {
  const skala = useTampilan((s) => s.skala)
  const sembunyi = useTampilan((s) => s.sembunyi)
  const setSkala = useTampilan((s) => s.setSkala)
  const atur = useTampilan((s) => s.atur)
  const pulihkan = useTampilan((s) => s.pulihkan)
  const kotak = (grup: 'rel' | 'layar') => (
    <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {BAGIAN.filter((b) => b.grup === grup).map((b) => (
        <label key={b.id} className="ex-label flex items-center gap-2" style={{ color: 'var(--ink-soft)', minHeight: 30 }}>
          <input
            type="checkbox"
            checked={!sembunyi[b.id]}
            onChange={(e) => atur(b.id, e.target.checked)}
            style={{ accentColor: 'var(--accent)', width: 18, height: 18 }}
          />
          {b.label}
        </label>
      ))}
    </div>
  )
  return (
    <section className="flex flex-col gap-3">
      <h3 className="ex-module-title">This device: toolbar</h3>
      <p className="ex-label" style={{ color: 'var(--ink-soft)' }}>
        Applies to this phone, tablet or computer only — other devices keep their own layout. Uncheck what you never
        use to give the canvas more room; this page and the gear button always stay.
      </p>
      <div className="flex flex-col gap-1">
        <span className="ex-label" style={{ color: 'var(--ink-soft)' }}>Toolbar size</span>
        <div className="flex flex-wrap gap-1">
          {UKURAN.map((u) => (
            <button
              key={u.nilai}
              className="ex-btn"
              data-variant={Math.abs(skala - u.nilai) < 0.01 ? 'accent' : 'ghost'}
              style={{ padding: '6px 12px', fontSize: 'var(--fs-label)' }}
              onClick={() => setSkala(u.nilai)}
            >
              {u.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="ex-label" style={{ color: 'var(--ink-soft)' }}>Tool rail (left)</span>
        {kotak('rel')}
      </div>
      <div className="flex flex-col gap-1">
        <span className="ex-label" style={{ color: 'var(--ink-soft)' }}>On the canvas</span>
        {kotak('layar')}
      </div>
      <TintaCepat />
      <div>
        <button className="ex-btn" data-variant="ghost" onClick={pulihkan}>
          Reset this device to the default layout
        </button>
      </div>
    </section>
  )
}
