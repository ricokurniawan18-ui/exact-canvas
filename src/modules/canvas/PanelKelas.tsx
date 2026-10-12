import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { IconButton } from '@/components/ui/Button'
import { useData } from '@/lib/useData'
import { useSinkron } from '@/lib/sinkron'
import { guruPembantu, peranEditorIni, urlDenganPin } from '@/lib/api'
import { toast, toastGalat } from '@/lib/toast'
import { TeksRumus } from '@/components/TeksRumus'
import { daftarKanvas } from './data'
import {
  anggotaGrup,
  bisukanMurid,
  izinkanCoret,
  buatGrup,
  kosongkanAntrean,
  daftarAkun,
  daftarGuru,
  jadikanGuru,
  panggilMurid,
  panggilMuridLangsung,
  bukaPermintaan,
  daftarLaporanNilai,
  daftarUpdateJadwal,
  tandaiDibaca,
  teksJadwal,
  daftarGrup,
  daftarMuridSemua,
  daftarTanya,
  hapusGrup,
  lamaMenunggu,
  resetSandiAkun,
  setujuiAkun,
  tetapkanGrup,
  ubahGrup,
  ubahTanya,
  type Grup,
  type LaporanNilai,
  type Murid,
  type Tanya,
  type UpdateJadwal,
} from '@/lib/kelas'

type Tab = 'antrian' | 'murid' | 'grup' | 'guru' | 'nilai' | 'jadwal'

/**
 * Panel kelas di rel kanvas: ruangan editor ini, antrian pertanyaan murid,
 * daftar murid dengan lampu fokus, dan grup dengan tampilan yang bisa dipilih.
 */
export function PanelKelas({
  onBahas,
  onBukaKanvas,
}: {
  /** Buka kanvas murid ini (kanvas grupnya, atau kanvas pribadinya hari ini) tanpa pertanyaan. */
  onBukaKanvas: (idMurid: string, nama: string) => void
  /** Guru membuka pertanyaan: nama berkas tiap lampiran (kalau ada, bukan URL —
   *  server yang membaca/mengkodekannya) untuk ditempel ke kanvas. `paksaTempel`
   *  menempel ulang meski pertanyaan ini sudah pernah "dibahas" — jalan keluar
   *  manual kalau penempelan pertama gagal (mis. galat baca foto di tablet). */
  onBahas: (t: Tanya, lampiran: string[] | null, paksaTempel?: boolean) => void
}) {
  const [tab, setTab] = useState<Tab>('antrian')
  const [cariMurid, setCariMurid] = useState('')
  /** Murid yang kartu datanya sedang dibuka (ketuk namanya). */
  const [terbuka, setTerbuka] = useState<string | null>(null)
  /** Daftar murid: semua akun, atau hanya yang sedang terhubung sekarang. */
  const [saringMurid, setSaringMurid] = useState<'semua' | 'online'>('semua')
  const [cariGuru, setCariGuru] = useState('')
  const { data: laporanNilai } = useData('kelas', daftarLaporanNilai, [])
  const { data: updateJadwal } = useData('kelas', daftarUpdateJadwal, [])
  const [semuaLaporan, setSemuaLaporan] = useState(false)
  // window.prompt() tidak menampilkan apa pun di WKWebView (app Mac) — jadi
  // input sandi baru dibuka inline di sini, bukan lewat dialog bawaan browser.
  const [resetId, setResetId] = useState<string | null>(null)
  const [resetSandi, setResetSandi] = useState('')
  const { data: daftarSketsa } = useData('canvas', daftarKanvas, [])
  const klien = useSinkron((s) => s.klien)
  const qAntrian = useData('kelas', daftarTanya, [])
  const qGrup = useData('kelas', daftarGrup, [])
  const qAnggota = useData('kelas', anggotaGrup, [])
  const qAkun = useData('kelas', daftarAkun, [])
  const { data: daftarPengajar } = useData('kelas', daftarGuru, [])
  /** Saya di antrean: 'utama' untuk guru utama, id akun untuk guru pembantu. */
  const pembantu = guruPembantu()
  const idSaya = pembantu ? peranEditorIni().id ?? '' : 'utama'
  const namaGuru = (id: string | null | undefined) => (id ? daftarPengajar.find((g) => g.id === id)?.nama ?? null : null)
  // Guru pembantu mulai dari "untuk saya"; guru utama melihat semuanya.
  const [hanyaSaya, setHanyaSaya] = useState(pembantu)
  // Daftar SEMUA murid yang pernah bergabung, bukan cuma yang terlihat 10 jam
  // terakhir: murid yang lupa sandi (justru yang paling butuh direset) tidak
  // akan pernah "terlihat" karena dia tidak pernah berhasil masuk — kalau
  // daftarnya dibatasi ke yang aktif belakangan, dia tidak akan pernah muncul
  // untuk direset sama sekali.
  const qSemuaMurid = useData('kelas', daftarMuridSemua, [])
  const { data: antrian } = qAntrian
  const { data: grup } = qGrup
  const { data: anggota } = qAnggota
  const { data: akun } = qAkun
  const { data: semuaMurid } = qSemuaMurid
  const menungguSetuju = akun.filter((a) => !a.disetujui)

  /**
   * Pemuatan yang gagal tidak boleh menyamar jadi kelas yang kosong.
   *
   * `useData` sudah menyimpan galatnya, tapi panel ini dulu hanya membaca
   * `data` — yang tetap `[]` saat kueri gagal. Hasilnya guru membaca "No
   * students yet" padahal kelasnya penuh, dan satu-satunya petunjuk bahwa
   * ada yang salah adalah rasa "kok kadang-kadang begini".
   */
  const kueri = [qAntrian, qGrup, qAnggota, qAkun, qSemuaMurid]
  const galat = kueri.find((k) => k.galat)?.galat ?? null
  const memuat = kueri.some((k) => k.memuat)
  const muatUlangSemua = () => kueri.forEach((k) => k.muatUlang())

  const petaGrupMurid = useMemo(() => new Map(anggota.map((a) => [a.student_id, a.group_id])), [anggota])
  const hadir = useMemo(() => new Map(klien.filter((k) => k.murid).map((k) => [k.murid, k])), [klien])
  const editorLain = klien.filter((k) => k.peran === 'editor')
  const menunggu = antrian.filter((t) => t.status === 'menunggu').length
  /** Untuk saya: ditujukan ke saya, ke siapa saja dan belum diambil, atau sedang saya bahas. */
  const untukSaya = (t: Tanya) =>
    t.handled_by === idSaya || t.for_teacher === idSaya || (!t.for_teacher && t.status === 'menunggu')
  const antrianTampil = hanyaSaya ? antrian.filter(untukSaya) : antrian
  const adaGuruLain = daftarPengajar.length > 1

  return (
    <>
      <div className="flex flex-wrap gap-1">
        {(
          [
            ['antrian', `Queue${menunggu ? ` · ${menunggu}` : ''}`],
            ['murid', `Students · ${semuaMurid.length}`],
            ['grup', `Groups · ${grup.length}`],
            ['nilai', `Scores${laporanNilai.some((n) => !n.read_at) ? ` · ${laporanNilai.filter((n) => !n.read_at).length}` : ''}`],
            ['jadwal', `Schedule${updateJadwal.some((n) => !n.read_at) ? ` · ${updateJadwal.filter((n) => !n.read_at).length}` : ''}`],
            // Hanya guru utama yang mengangkat/mencabut guru pembantu.
            ...(pembantu ? [] : ([['guru', `Teachers · ${semuaMurid.filter((m) => m.role === 'guru').length}`]] as [Tab, string][])),
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className="ex-btn flex-1 justify-center"
            data-variant={tab === id ? 'accent' : 'ghost'}
            style={{ padding: '4px 8px', fontSize: 'var(--fs-label)', whiteSpace: 'nowrap' }}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {galat && (
        <div className="ex-card flex flex-col gap-1 p-2" style={{ borderColor: 'var(--down)' }}>
          <span className="ex-label" style={{ color: 'var(--down)' }}>
            Class data could not be loaded
          </span>
          <span style={{ fontSize: 11, color: 'var(--ink-soft)', wordBreak: 'break-word' }}>{galat}</span>
          <button
            className="ex-btn self-start"
            data-variant="ghost"
            style={{ padding: '3px 8px', fontSize: 11 }}
            onClick={muatUlangSemua}
          >
            Try again
          </button>
        </div>
      )}

      {tab === 'antrian' && (
        <div className="flex flex-col gap-1">
          {adaGuruLain && (
            <div className="flex gap-1">
              {(
                [
                  [true, `For me · ${antrian.filter(untukSaya).length}`],
                  [false, `All · ${antrian.length}`],
                ] as [boolean, string][]
              ).map(([v, label]) => (
                <button
                  key={label}
                  className="ex-btn flex-1 justify-center"
                  data-variant={hanyaSaya === v ? 'accent' : 'ghost'}
                  style={{ padding: '3px 0', fontSize: 11 }}
                  onClick={() => setHanyaSaya(v)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {antrian.length > 1 && !pembantu && (
            <button
              className="ex-btn self-end"
              data-variant="ghost"
              style={{ padding: '3px 8px', fontSize: 11 }}
              title="Close every open question"
              onClick={() => void kosongkanAntrean().then(() => toast('Queue cleared.'))}
            >
              <Icon nama="silang" ukuran={12} /> Clear queue
            </button>
          )}
          {antrian.length === 0 && !galat && !memuat && (
            <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              No one is waiting. Students raise a hand or send a question from their phone.
            </p>
          )}
          {antrianTampil.map((t) => (
            <BarisTanya
              key={t.id}
              t={t}
              tujuan={adaGuruLain ? (t.for_teacher ? namaGuru(t.for_teacher) ?? 'a teacher' : 'anyone') : null}
              penjawab={t.status === 'dibahas' && t.handled_by && t.handled_by !== idSaya ? namaGuru(t.handled_by) ?? 'another teacher' : null}
              grup={grup.find((g) => g.id === petaGrupMurid.get(t.student_id)) ?? null}
              onBahas={(paksaTempel) => onBahas(t, t.photos.length ? t.photos : null, paksaTempel)}
              onSelesai={() => void ubahTanya(t.id, 'selesai').catch(() => toastGalat('Could not close it.'))}
              onPanggil={() =>
                void panggilMurid(t.id)
                  .then(() => toast(`${t.name} called to your desk.`))
                  .catch(toastGalat)
              }
            />
          ))}
        </div>
      )}

      {tab === 'murid' && (
        <div className="flex flex-col gap-1">
          {menungguSetuju.length > 0 && (
            <div className="ex-card flex flex-col gap-1 p-2" style={{ borderColor: 'var(--accent)' }}>
              <span className="ex-label" style={{ color: 'var(--accent)' }}>
                Waiting for your approval · {menungguSetuju.length}
              </span>
              {menungguSetuju.map((a) => (
                <div key={a.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--fs-label)' }}>
                    {a.nama}
                    <span className="ex-num" style={{ marginLeft: 6, fontSize: 11, color: 'var(--ink-faint)' }}>
                      {a.hp}
                    </span>
                  </span>
                  <IconButton
                    nama="centang"
                    label={`Accept ${a.nama}`}
                    ukuran={13}
                    onClick={() => setujuiAkun(a.id, true).then(() => toast(`${a.nama} accepted.`)).catch(toastGalat)}
                  />
                  <IconButton
                    nama="silang"
                    label={`Reject ${a.nama} (removes the account)`}
                    ukuran={13}
                    onClick={() => setujuiAkun(a.id, false).then(() => toast(`${a.nama} rejected.`)).catch(toastGalat)}
                  />
                </div>
              ))}
            </div>
          )}
          {saringMurid === 'online' && semuaMurid.length > 0 && !semuaMurid.some((m) => hadir.has(m.id)) && (
            <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              No student is connected right now.
            </p>
          )}
          {semuaMurid.length === 0 && !galat && !memuat && (
            <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              No students yet. They join from the TV link on their phone.
            </p>
          )}
          {semuaMurid.length > 0 && (
            <div className="flex gap-1">
              {(
                [
                  ['semua', `All · ${semuaMurid.length}`],
                  ['online', `Online now · ${semuaMurid.filter((m) => hadir.has(m.id)).length}`],
                ] as ['semua' | 'online', string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  className="ex-btn flex-1 justify-center"
                  data-variant={saringMurid === id ? 'accent' : 'ghost'}
                  style={{ padding: '3px 8px', fontSize: 'var(--fs-label)', whiteSpace: 'nowrap' }}
                  onClick={() => setSaringMurid(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {semuaMurid.length > 0 && (
            <input
              className="ex-input"
              style={{ padding: '4px 8px', fontSize: 'var(--fs-label)' }}
              placeholder="Search students…"
              value={cariMurid}
              onChange={(e) => setCariMurid(e.target.value)}
            />
          )}
          {semuaMurid
            .filter((m) => m.name.toLowerCase().includes(cariMurid.trim().toLowerCase()))
            .filter((m) => saringMurid === 'semua' || hadir.has(m.id))
            .map((m) => {
            const k = hadir.get(m.id)
            const warna = !k ? 'var(--ink-faint)' : k.tunggu ? 'var(--accent-2)' : k.fokus ? 'var(--up)' : 'var(--down)'
            const judul = !k
              ? 'Offline'
              : k.tunggu
                ? 'Waiting — screen dimmed or phone locked on purpose'
                : k.fokus
                  ? `On the board${k.keluar ? ` · left ${k.keluar}×` : ''}`
                  : `Left the page · ${k.keluar}×`
            const buka = terbuka === m.id
            return (
              <div key={m.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1" title={`${judul}${m.phone ? ` · ${m.phone}` : ''}`}>
                <span
                  aria-hidden
                  style={{ width: 9, height: 9, borderRadius: 999, background: warna, flexShrink: 0, boxShadow: k?.fokus ? `0 0 6px ${warna}` : undefined }}
                />
                <button
                  type="button"
                  className="min-w-[8rem] flex-1 truncate"
                  style={{
                    fontSize: 'var(--fs-label)',
                    opacity: k ? 1 : 0.55,
                    textAlign: 'left',
                    background: 'none',
                    border: 0,
                    padding: 0,
                    cursor: 'pointer',
                    color: 'inherit',
                    fontWeight: buka ? 700 : 400,
                    textDecoration: buka ? 'none' : 'underline dotted',
                    textUnderlineOffset: 3,
                  }}
                  title="Tap to see this student's data"
                  aria-expanded={buka}
                  onClick={() => setTerbuka(buka ? null : m.id)}
                >
                  {m.name}
                </button>
                {k && k.keluar > 0 && (
                  <span className="ex-num" style={{ fontSize: 11, color: 'var(--ink-faint)' }}>
                    {k.keluar}×
                  </span>
                )}
                {m.phone && resetId === m.id && (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (resetSandi.length < 4) return
                      resetSandiAkun(m.id, resetSandi)
                        .then(() => {
                          toast(`Password for ${m.name} changed.`)
                          setResetId(null)
                          setResetSandi('')
                        })
                        .catch(toastGalat)
                    }}
                  >
                    <input
                      className="ex-input ex-num"
                      style={{ width: 90, padding: '2px 6px', fontSize: 11 }}
                      placeholder="new password"
                      autoFocus
                      value={resetSandi}
                      onChange={(e) => setResetSandi(e.target.value)}
                    />
                    <IconButton nama="centang" label="Save" ukuran={12} type="submit" aktif={resetSandi.length >= 4} />
                    <IconButton
                      nama="silang"
                      label="Cancel"
                      ukuran={12}
                      onClick={() => {
                        setResetId(null)
                        setResetSandi('')
                      }}
                    />
                  </form>
                )}
                {m.phone && resetId !== m.id && !pembantu && (
                  <IconButton
                    nama="gembok"
                    label="Reset this student's password"
                    ukuran={12}
                    onClick={() => {
                      setResetId(m.id)
                      setResetSandi('')
                    }}
                  />
                )}
                <IconButton
                  nama="pena"
                  label={m.can_draw ? 'Allowed to draw on their own canvas — tap to revoke' : 'Allow drawing on their own canvas from the phone'}
                  aktif={!!m.can_draw}
                  ukuran={12}
                  onClick={() =>
                    izinkanCoret(m.id, !m.can_draw)
                      .then(() => toast(m.can_draw ? `${m.name} can no longer draw` : `${m.name} can now draw on their canvas`))
                      .catch(toastGalat)
                  }
                />
                <IconButton
                  nama={m.muted_until && m.muted_until > Date.now() ? 'silang' : 'lonceng'}
                  label={m.muted_until && m.muted_until > Date.now() ? 'Muted — tap to allow questions again' : 'Mute questions from this student for 10 min'}
                  aktif={!!m.muted_until && m.muted_until > Date.now()}
                  ukuran={12}
                  onClick={() => void bisukanMurid(m.id, m.muted_until && m.muted_until > Date.now() ? 0 : 10)}
                />
                <select
                  className="ex-input"
                  style={{ width: 96, padding: '2px 4px', fontSize: 11 }}
                  value={petaGrupMurid.get(m.id) ?? ''}
                  onChange={(e) => void tetapkanGrup(m.id, e.target.value || null)}
                  aria-label={`Group of ${m.name}`}
                >
                  <option value="">no group</option>
                  {grup.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </div>
              {buka && (
                <KartuMurid
                  murid={m}
                  hadir={k}
                  namaGrup={grup.find((g) => g.id === petaGrupMurid.get(m.id))?.name ?? null}
                  tanya={antrian.filter((t) => t.student_id === m.id)}
                  nilai={laporanNilai.filter((n) => n.student_id === m.id)}
                  jadwal={updateJadwal.filter((u) => u.student_id === m.id)}
                  onPanggil={() =>
                    panggilMuridLangsung(m.id)
                      .then(() => toast(`Calling ${m.name} to your desk.`))
                      .catch(toastGalat)
                  }
                  onBukaKanvas={() => onBukaKanvas(m.id, m.name)}
                  onTutup={() => setTerbuka(null)}
                />
              )}
              </div>
            )
          })}
          <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
            Green: watching the board. Blue: waiting with the screen dimmed (allowed). Red: left the
            page (count shows how often). Grey: offline.
          </p>
        </div>
      )}

      {tab === 'guru' && !pembantu && (
        <div className="flex flex-col gap-1">
          <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
            Assistant teachers sign in to the editor with their own account and can answer questions. Search a student
            account to make it a teacher.
          </p>
          {semuaMurid
            .filter((m) => m.role === 'guru')
            .map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--fs-label)', fontWeight: 600 }}>
                  {m.name}
                </span>
                <button
                  className="ex-btn"
                  data-variant="ghost"
                  style={{ padding: '2px 8px', fontSize: 11 }}
                  onClick={() =>
                    jadikanGuru(m.id, false)
                      .then(() => toast(`${m.name} is a student again.`))
                      .catch(toastGalat)
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          {semuaMurid.every((m) => m.role !== 'guru') && (
            <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              No assistant teachers yet.
            </p>
          )}
          <input
            className="ex-input"
            style={{ padding: '4px 8px', fontSize: 'var(--fs-label)', marginTop: 6 }}
            placeholder="Search a name to add…"
            value={cariGuru}
            onChange={(e) => setCariGuru(e.target.value)}
          />
          {cariGuru.trim() &&
            semuaMurid
              .filter((m) => m.phone && m.role !== 'guru' && m.name.toLowerCase().includes(cariGuru.trim().toLowerCase()))
              .slice(0, 12)
              .map((m) => (
                <div key={m.id} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--fs-label)' }}>
                    {m.name}
                    <span className="ex-num" style={{ marginLeft: 6, fontSize: 11, color: 'var(--ink-faint)' }}>
                      {m.phone}
                    </span>
                  </span>
                  <button
                    className="ex-btn"
                    data-variant="accent"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={() =>
                      jadikanGuru(m.id, true)
                        .then(() => {
                          toast(`${m.name} is now an assistant teacher.`)
                          setCariGuru('')
                        })
                        .catch(toastGalat)
                    }
                  >
                    Make teacher
                  </button>
                </div>
              ))}
        </div>
      )}

      {(tab === 'nilai' || tab === 'jadwal') && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1">
            {(
              [
                [false, 'Unread'],
                [true, 'All'],
              ] as [boolean, string][]
            ).map(([v, label]) => (
              <button
                key={label}
                className="ex-btn"
                data-variant={semuaLaporan === v ? 'accent' : 'ghost'}
                style={{ padding: '2px 10px', fontSize: 11 }}
                onClick={() => setSemuaLaporan(v)}
              >
                {label}
              </button>
            ))}
            <button
              className="ex-btn ml-auto"
              data-variant="ghost"
              style={{ padding: '2px 8px', fontSize: 11 }}
              onClick={() => void tandaiDibaca(tab === 'nilai' ? 'score_reports' : 'schedule_updates').catch(toastGalat)}
            >
              <Icon nama="centang" ukuran={12} /> Mark all read
            </button>
          </div>
          {tab === 'nilai' &&
            laporanNilai
              .filter((n) => semuaLaporan || !n.read_at)
              .map((n) => (
                <div key={n.id} className="ex-card flex items-start gap-2 p-2" style={{ opacity: n.read_at ? 0.6 : 1 }}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate" style={{ fontWeight: 600, fontSize: 'var(--fs-label)' }}>{n.name}</span>
                      <span className="ex-num" style={{ marginLeft: 'auto', fontWeight: 700, fontSize: 15 }}>{n.score}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
                      {[n.subject, n.test, n.test_date].filter(Boolean).join(' · ') || 'Test score'}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>sent {new Date(n.created_at).toLocaleString()}</div>
                  </div>
                  {!n.read_at && (
                    <IconButton nama="centang" label="Mark as read" ukuran={12} onClick={() => void tandaiDibaca('score_reports', n.id).catch(toastGalat)} />
                  )}
                </div>
              ))}
          {tab === 'jadwal' &&
            updateJadwal
              .filter((n) => semuaLaporan || !n.read_at)
              .map((n) => (
                <div key={n.id} className="ex-card flex items-start gap-2 p-2" style={{ opacity: n.read_at ? 0.6 : 1 }}>
                  <div className="min-w-0 flex-1">
                    <div style={{ fontWeight: 600, fontSize: 'var(--fs-label)' }}>{n.name}</div>
                    <div style={{ fontSize: 12 }}>{teksJadwal(n.schedule)}</div>
                    {n.previous && (
                      <div style={{ fontSize: 11, color: 'var(--ink-faint)', textDecoration: 'line-through' }}>{teksJadwal(n.previous)}</div>
                    )}
                    <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>updated {new Date(n.created_at).toLocaleString()}</div>
                  </div>
                  {!n.read_at && (
                    <IconButton nama="centang" label="Mark as read" ukuran={12} onClick={() => void tandaiDibaca('schedule_updates', n.id).catch(toastGalat)} />
                  )}
                </div>
              ))}
          {(tab === 'nilai' ? laporanNilai : updateJadwal).filter((n) => semuaLaporan || !n.read_at).length === 0 && (
            <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              {tab === 'nilai'
                ? 'No new test scores. Students report them when they arrive each day. Scores are kept for the current semester.'
                : 'No schedule changes. Students confirm their lesson days and times when they arrive each day.'}
            </p>
          )}
        </div>
      )}

      {tab === 'grup' && (
        <div className="flex flex-col gap-2">
          {grup.map((g) => (
            <BarisGrup
              key={g.id}
              g={g}
              anggota={anggota.filter((a) => a.group_id === g.id).map((a) => semuaMurid.find((m) => m.id === a.student_id) ?? { id: a.student_id, name: a.student_id })}
              bebas={semuaMurid.filter((m) => !anggota.some((a) => a.student_id === m.id))}
              editorLain={editorLain.map((e) => ({ id: e.id, nama: e.nama }))}
              daftarSketsa={daftarSketsa}
            />
          ))}
          <TambahGrup />
          <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
            Groups are permanent: members stay in their group across days (their account is
            their identity), and each group gets a fresh canvas per day. A group's view overrides
            its members' room.
          </p>
        </div>
      )}
    </>
  )
}

function BarisTanya({
  t,
  tujuan,
  penjawab,
  grup,
  onBahas,
  onSelesai,
  onPanggil,
}: {
  t: Tanya
  /** Nama guru yang dituju (atau 'anyone'); null bila hanya ada satu guru. */
  tujuan: string | null
  /** Nama guru LAIN yang sedang membahasnya. */
  penjawab: string | null
  grup: Grup | null
  onBahas: (paksaTempel?: boolean) => void
  onSelesai: () => void
  /** Panggil murid ke meja guru ini (dibahas langsung, bukan di kanvas). */
  onPanggil: () => void
}) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])
  const dibahas = t.status === 'dibahas'
  return (
    <div
      className="ex-card flex flex-col gap-1 p-2"
      style={{ borderColor: dibahas ? 'var(--accent)' : undefined, background: dibahas ? 'var(--surface-2)' : undefined }}
    >
      <div className="flex items-center gap-2">
        {t.kind && (
          <span
            style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: t.kind === 'print' ? 'var(--accent-2)' : 'var(--accent)', color: '#fff', flexShrink: 0 }}
          >
            {t.kind === 'print' ? '🖨️ Print' : t.kind === 'hasil' ? '📊 Practice result' : '📝 Practice'}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate" style={{ fontWeight: 600, fontSize: 'var(--fs-label)' }}>
          {t.name}
        </span>
        {grup && (
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: grup.color ?? 'var(--accent)', color: '#fff' }}>
            {grup.name}
          </span>
        )}
        <span style={{ fontSize: 11, color: dibahas ? 'var(--accent)' : 'var(--ink-faint)' }}>
          {dibahas ? (penjawab ? `${penjawab} is on it` : 'discussing') : lamaMenunggu(t.created_at)}
        </span>
      </div>
      {tujuan && (
        <span style={{ fontSize: 10, color: 'var(--ink-faint)' }}>→ {tujuan}</span>
      )}
      {t.text && (
        /* div, bukan p: diagram di dalam teks adalah blok (<div>), dan <p>
           tidak boleh memuatnya. */
        <div style={{ fontSize: 'var(--fs-label)', color: 'var(--ink-soft)', whiteSpace: 'pre-wrap' }}>
          <TeksRumus teks={t.text} />
        </div>
      )}
      {t.photos.length > 0 && t.photos[0].endsWith('.pdf') ? (
        <span className="ex-label flex items-center gap-1" style={{ color: 'var(--ink-soft)' }}>
          <Icon nama="pdf" ukuran={14} /> PDF attached
        </span>
      ) : t.photos.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {t.photos.map((f) => (
            <img
              key={f}
              src={urlDenganPin(`/api/kelas/foto/${encodeURIComponent(f)}`)}
              alt=""
              style={{ maxHeight: 90, width: 'auto', maxWidth: '100%', borderRadius: 6, border: '1px solid var(--line)' }}
            />
          ))}
        </div>
      ) : null}
      {(t.kind === 'print' || t.kind === 'latihan') && (
        <button
          className="ex-btn"
          data-variant="accent"
          style={{ padding: '4px 0' }}
          title={
            t.kind === 'print'
              ? 'Save the PDF to the Mac Desktop as "Print - name - date" and open it'
              : 'Copy the photos/PDF to a Desktop folder with the student\'s name and open Gemini in Chrome'
          }
          onClick={() =>
            void bukaPermintaan(t.id, t.kind === 'print' ? 'print' : 'gemini')
              .then(() => toast(t.kind === 'print' ? 'PDF opened on the Mac.' : 'Folder and Gemini opened on the Mac.'))
              .catch(toastGalat)
          }
        >
          {t.kind === 'print' ? '🖨️ Open PDF' : '✨ Make questions in Gemini'}
        </button>
      )}
      <div className="flex gap-1">
        <button className="ex-btn flex-1" data-variant={dibahas || t.kind === 'print' || t.kind === 'latihan' ? 'ghost' : 'accent'} style={{ padding: '4px 0' }} onClick={() => onBahas()}>
          <Icon nama="pena" ukuran={13} />{' '}
          {dibahas
            ? 'Back to canvas'
            : t.photos.length > 0
              ? t.photos[0].endsWith('.pdf')
                ? 'Open PDF on canvas'
                : t.photos.length > 1
                  ? `Open ${t.photos.length} photos on canvas`
                  : 'Open on canvas'
              : 'Discuss'}
        </button>
        {/* Kalau penempelan pertama gagal (mis. galat baca foto di tablet),
            pertanyaan ini sudah kadung "dibahas" dan tombol di atas cuma
            berpindah kanvas — jalan ini menempel ulang secara eksplisit. */}
        {dibahas && (t.photos.length > 0 || !!t.text) && (
          <button
            className="ex-btn"
            data-variant="ghost"
            style={{ padding: '4px 8px' }}
            onClick={() => onBahas(true)}
            title={
              t.photos.length > 1
                ? `Insert the ${t.photos.length} photos onto the canvas again`
                : t.photos.length === 1
                  ? 'Insert the photo onto the canvas again'
                  : 'Insert the question text onto the canvas again'
            }
          >
            <Icon nama="sisip" ukuran={13} />
          </button>
        )}
        <button className="ex-btn" data-variant="ghost" style={{ padding: '4px 8px', fontSize: 11 }} onClick={onPanggil} title="Call this student to your desk — their phone rings">
          🙋 Call
        </button>
        <button className="ex-btn" data-variant="ghost" style={{ padding: '4px 8px' }} onClick={onSelesai} title="Done">
          <Icon nama="centang" ukuran={13} />
        </button>
      </div>
    </div>
  )
}

function BarisGrup({
  g,
  anggota,
  bebas,
  editorLain,
  daftarSketsa,
}: {
  g: Grup
  anggota: Pick<Murid, 'id' | 'name'>[]
  bebas: Pick<Murid, 'id' | 'name'>[]
  editorLain: { id: string; nama: string }[]
  daftarSketsa: { id: string; title: string }[]
}) {
  const [nama, setNama] = useState(g.name)
  const [jadwal, setJadwal] = useState(g.schedule ?? '')
  useEffect(() => setNama(g.name), [g.name])
  useEffect(() => setJadwal(g.schedule ?? ''), [g.schedule])
  return (
    <div className="ex-card flex flex-col gap-1 p-2">
      <div className="flex items-center gap-2">
        <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, background: g.color ?? 'var(--accent)' }} />
        <input
          className="ex-input"
          style={{ padding: '3px 6px', fontSize: 'var(--fs-label)', flex: 1 }}
          value={nama}
          onChange={(e) => setNama(e.target.value)}
          onBlur={() => nama.trim() && nama !== g.name && void ubahGrup(g.id, { name: nama.trim() })}
          aria-label="Group name"
        />
        <input
          className="ex-input"
          style={{ padding: '3px 6px', fontSize: 11, width: 88 }}
          value={jadwal}
          placeholder="Mon 16:00"
          onChange={(e) => setJadwal(e.target.value)}
          onBlur={() => jadwal.trim() !== (g.schedule ?? '') && void ubahGrup(g.id, { schedule: jadwal.trim() || null })}
          aria-label="Schedule"
          title="Fixed schedule (free text)"
        />
        <IconButton nama="hapus" label="Delete group" ukuran={13} onClick={() => void hapusGrup(g.id)} />
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {anggota.map((m) => (
          <span
            key={m.id}
            className="flex items-center gap-1"
            style={{ fontSize: 11, padding: '1px 4px 1px 7px', borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--line)' }}
          >
            {m.name}
            <IconButton nama="silang" label={`Remove ${m.name} from ${g.name}`} ukuran={10} onClick={() => void tetapkanGrup(m.id, null)} />
          </span>
        ))}
        <select
          className="ex-input"
          style={{ padding: '2px 4px', fontSize: 11, width: 110 }}
          value=""
          onChange={(e) => e.target.value && void tetapkanGrup(e.target.value, g.id)}
          aria-label={`Add a member to ${g.name}`}
        >
          <option value="">+ add member…</option>
          {bebas.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <select
        className="ex-input"
        style={{ padding: '3px 6px', fontSize: 11 }}
        value={g.target ?? ''}
        onChange={(e) => void ubahGrup(g.id, { target: e.target.value || null })}
        aria-label="What this group sees"
      >
        <option value="">Their own canvas (default)</option>
        {editorLain.map((e) => (
          <option key={e.id} value={`editor:${e.id}`}>
            Follow {e.nama}
          </option>
        ))}
        {daftarSketsa.map((s) => (
          <option key={s.id} value={`sketsa:${s.id}`}>
            Show sketch: {s.title}
          </option>
        ))}
      </select>
    </div>
  )
}

function TambahGrup() {
  const [nama, setNama] = useState('')
  return (
    <form
      className="flex gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        if (!nama.trim()) return
        void buatGrup(nama).then(() => {
          setNama('')
          toast('Group created.')
        })
      }}
    >
      <input
        className="ex-input"
        style={{ padding: '4px 8px', fontSize: 'var(--fs-label)' }}
        placeholder="New group, e.g. Matematika 9"
        value={nama}
        onChange={(e) => setNama(e.target.value)}
      />
      <button className="ex-btn" data-variant="ghost" type="submit" disabled={!nama.trim()}>
        <Icon nama="tambah" ukuran={14} />
      </button>
    </form>
  )
}


const waktuLengkap = (t: number | null | undefined) =>
  t ? new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

/** Kartu data satu murid: status sekarang, grup, pertanyaan, nilai ulangan, dan jadwal les yang ia laporkan. */
function KartuMurid({
  murid,
  hadir,
  namaGrup,
  tanya,
  nilai,
  jadwal,
  onPanggil,
  onBukaKanvas,
  onTutup,
}: {
  murid: Murid
  hadir: { fokus?: boolean; tunggu?: boolean; keluar: number } | undefined
  namaGrup: string | null
  tanya: Tanya[]
  nilai: LaporanNilai[]
  jadwal: UpdateJadwal[]
  onPanggil: () => void
  onBukaKanvas: () => void
  onTutup: () => void
}) {
  const status = !hadir ? 'Offline' : hadir.tunggu ? 'Waiting (screen dimmed)' : hadir.fokus ? 'On the board' : 'Left the page'
  const baris = (k: string, v: string) => (
    <div className="flex gap-2" style={{ fontSize: 'var(--fs-label)' }}>
      <span style={{ width: 120, flexShrink: 0, color: 'var(--ink-faint)' }}>{k}</span>
      <span className="min-w-0 flex-1" style={{ overflowWrap: 'anywhere' }}>{v}</span>
    </div>
  )
  const menunggu = tanya.filter((t) => t.status === 'menunggu').length
  const pertanyaan = tanya.filter((t) => !t.kind)
  return (
    <div className="ex-card flex flex-col gap-2 p-2" style={{ marginLeft: 17, borderColor: 'var(--accent)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="ex-label" style={{ color: 'var(--accent)' }}>{murid.name}</span>
        <IconButton nama="silang" label="Close" ukuran={12} onClick={onTutup} />
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          className="ex-btn flex-1 justify-center"
          data-variant="accent"
          style={{ padding: '4px 8px', fontSize: 'var(--fs-label)', whiteSpace: 'nowrap' }}
          onClick={onBukaKanvas}
          title="Open this student's canvas (their group's canvas, or their own for today)"
        >
          Open canvas
        </button>
        <button
          className="ex-btn flex-1 justify-center"
          data-variant="ghost"
          style={{ padding: '4px 8px', fontSize: 'var(--fs-label)', whiteSpace: 'nowrap' }}
          onClick={onPanggil}
          disabled={!hadir}
          title={hadir ? 'Call this student to your desk — their phone rings' : 'Offline — the phone cannot ring'}
        >
          🙋 Call
        </button>
      </div>
      <div className="flex flex-col gap-0.5">
        {baris('Status', `${status}${hadir && hadir.keluar > 0 ? ` · left the page ${hadir.keluar}×` : ''}`)}
        {baris('Phone', murid.phone || '—')}
        {baris('Group', namaGrup || 'no group')}
        {baris('Room', String(murid.room))}
        {baris('First seen', waktuLengkap(murid.first_seen))}
        {baris('Last seen', waktuLengkap(murid.last_seen))}
        {baris('Draw on canvas', murid.can_draw ? 'allowed' : 'not allowed')}
        {murid.muted_until && murid.muted_until > Date.now() && baris('Muted until', waktuLengkap(murid.muted_until))}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="ex-label" style={{ color: 'var(--ink-faint)' }}>
          Questions · {pertanyaan.length}
          {menunggu ? ` (${menunggu} waiting)` : ''}
        </span>
        {pertanyaan.length === 0 && <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>None in the queue history.</span>}
        {pertanyaan.slice(0, 5).map((t) => (
          <div key={t.id} className="flex gap-2" style={{ fontSize: 11 }}>
            <span className="ex-num" style={{ width: 92, flexShrink: 0, color: 'var(--ink-faint)' }}>{waktuLengkap(t.created_at)}</span>
            <span className="min-w-0 flex-1 truncate">{t.text || (t.photos.length ? `${t.photos.length} photo(s)` : '—')}</span>
            <span style={{ color: 'var(--ink-faint)' }}>{t.status}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="ex-label" style={{ color: 'var(--ink-faint)' }}>Reported scores · {nilai.length}</span>
        {nilai.length === 0 && <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>No score reports yet.</span>}
        {nilai.slice(0, 8).map((n) => (
          <div key={n.id} className="flex gap-2" style={{ fontSize: 11 }}>
            <span className="min-w-0 flex-1 truncate">
              {[n.subject, n.test].filter(Boolean).join(' · ') || 'Test'}
              {n.test_date ? ` · ${n.test_date}` : ''}
            </span>
            <span className="ex-num" style={{ fontWeight: 700 }}>{n.score}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="ex-label" style={{ color: 'var(--ink-faint)' }}>Lesson schedule</span>
        {jadwal.length === 0 && <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>No schedule reported yet.</span>}
        {jadwal.length > 0 && (
          <div className="flex gap-2" style={{ fontSize: 'var(--fs-label)' }}>
            <span style={{ width: 92, flexShrink: 0, color: 'var(--ink-faint)' }}>Current</span>
            <span className="min-w-0 flex-1" style={{ fontWeight: 700, overflowWrap: 'anywhere' }}>{teksJadwal(jadwal[0].schedule)}</span>
          </div>
        )}
        {jadwal.length > 0 && (
          <span style={{ fontSize: 11, color: 'var(--ink-faint)' }}>Updated {waktuLengkap(jadwal[0].created_at)}</span>
        )}
        {jadwal.slice(0, 4).map((u) => (
          <div key={u.id} className="flex gap-2" style={{ fontSize: 11 }}>
            <span className="ex-num" style={{ width: 92, flexShrink: 0, color: 'var(--ink-faint)' }}>{waktuLengkap(u.created_at)}</span>
            <span className="min-w-0 flex-1" style={{ overflowWrap: 'anywhere' }}>
              {teksJadwal(u.schedule)}
              {u.previous ? <span style={{ color: 'var(--ink-faint)' }}> (was {teksJadwal(u.previous)})</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
