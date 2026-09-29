import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@/components/ui/Icon'
import { IconButton } from '@/components/ui/Button'
import { useData } from '@/lib/useData'
import { useSinkron } from '@/lib/sinkron'
import { urlDenganPin } from '@/lib/api'
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
  type Murid,
  type Tanya,
} from '@/lib/kelas'

type Tab = 'antrian' | 'murid' | 'grup'

/**
 * Panel kelas di rel kanvas: ruangan editor ini, antrian pertanyaan murid,
 * daftar murid dengan lampu fokus, dan grup dengan tampilan yang bisa dipilih.
 */
export function PanelKelas({
  onBahas,
}: {
  /** Guru membuka pertanyaan: nama berkas tiap lampiran (kalau ada, bukan URL —
   *  server yang membaca/mengkodekannya) untuk ditempel ke kanvas. `paksaTempel`
   *  menempel ulang meski pertanyaan ini sudah pernah "dibahas" — jalan keluar
   *  manual kalau penempelan pertama gagal (mis. galat baca foto di tablet). */
  onBahas: (t: Tanya, lampiran: string[] | null, paksaTempel?: boolean) => void
}) {
  const [tab, setTab] = useState<Tab>('antrian')
  const [cariMurid, setCariMurid] = useState('')
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

  return (
    <>
      <div className="flex gap-1">
        {(
          [
            ['antrian', `Queue${menunggu ? ` · ${menunggu}` : ''}`],
            ['murid', `Students · ${semuaMurid.length}`],
            ['grup', `Groups · ${grup.length}`],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className="ex-btn flex-1 justify-center"
            data-variant={tab === id ? 'accent' : 'ghost'}
            style={{ padding: '4px 0', fontSize: 'var(--fs-label)' }}
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
          {antrian.length > 1 && (
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
          {antrian.map((t) => (
            <BarisTanya
              key={t.id}
              t={t}
              grup={grup.find((g) => g.id === petaGrupMurid.get(t.student_id)) ?? null}
              onBahas={(paksaTempel) => onBahas(t, t.photos.length ? t.photos : null, paksaTempel)}
              onSelesai={() => void ubahTanya(t.id, 'selesai').catch(() => toastGalat('Could not close it.'))}
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
          {semuaMurid.length === 0 && !galat && !memuat && (
            <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
              No students yet. They join from the TV link on their phone.
            </p>
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
            return (
              <div key={m.id} className="flex items-center gap-2" title={`${judul}${m.phone ? ` · ${m.phone}` : ''}`}>
                <span
                  aria-hidden
                  style={{ width: 9, height: 9, borderRadius: 999, background: warna, flexShrink: 0, boxShadow: k?.fokus ? `0 0 6px ${warna}` : undefined }}
                />
                <span className="min-w-0 flex-1 truncate" style={{ fontSize: 'var(--fs-label)', opacity: k ? 1 : 0.55 }}>
                  {m.name}
                </span>
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
                {m.phone && resetId !== m.id && (
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
            )
          })}
          <p className="ex-label" style={{ color: 'var(--ink-faint)', fontSize: 11 }}>
            Green: watching the board. Blue: waiting with the screen dimmed (allowed). Red: left the
            page (count shows how often). Grey: offline.
          </p>
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
  grup,
  onBahas,
  onSelesai,
}: {
  t: Tanya
  grup: Grup | null
  onBahas: (paksaTempel?: boolean) => void
  onSelesai: () => void
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
        <span className="min-w-0 flex-1 truncate" style={{ fontWeight: 600, fontSize: 'var(--fs-label)' }}>
          {t.name}
        </span>
        {grup && (
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: grup.color ?? 'var(--accent)', color: '#fff' }}>
            {grup.name}
          </span>
        )}
        <span style={{ fontSize: 11, color: dibahas ? 'var(--accent)' : 'var(--ink-faint)' }}>
          {dibahas ? 'discussing' : lamaMenunggu(t.created_at)}
        </span>
      </div>
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
      <div className="flex gap-1">
        <button className="ex-btn flex-1" data-variant={dibahas ? 'ghost' : 'accent'} style={{ padding: '4px 0' }} onClick={() => onBahas()}>
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
