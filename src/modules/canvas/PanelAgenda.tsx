import { useMemo, useState } from 'react'
import { IconButton } from '@/components/ui/Button'
import { useData } from '@/lib/useData'
import { toast, toastGalat } from '@/lib/toast'
import {
  daftarAgenda,
  daftarCatatan,
  hapusAgenda,
  hapusCatatan,
  tambahAgenda,
  tambahCatatan,
  type Agenda,
  type Grup,
  type Murid,
} from '@/lib/kelas'

/* Tab Agenda dan Notes di panel Class (guru utama). Agenda: ulangan/tugas
 * bertanggal dari murid (untuk dirinya) atau dari guru (untuk satu murid
 * atau satu grup) — murid diingatkan lewat notifikasi malam sebelumnya.
 * Notes: catatan guru untuk murid dan catatan murid sendiri, satu utas per anak. */

const galat = (e: unknown) => toastGalat(e instanceof Error ? e.message : String(e))
const LABEL: Record<Agenda['kind'], string> = { ulangan: 'Test', tugas: 'Homework', lain: 'Other' }

function isoHari(tambah = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + tambah)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function tglPendek(iso: string): string {
  if (iso === isoHari()) return 'Today'
  if (iso === isoHari(1)) return 'Tomorrow'
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
}

const gayaInput = {
  padding: '5px 8px',
  borderRadius: 8,
  border: '1px solid var(--line-strong)',
  background: 'var(--surface)',
  color: 'var(--ink)',
  font: 'inherit',
  fontSize: 'var(--fs-label)',
  minWidth: 0,
} as const

export function TabAgenda({ murid, grup }: { murid: Murid[]; grup: Grup[] }) {
  const { data: agenda } = useData('kelas', daftarAgenda, [])
  const [tujuan, setTujuan] = useState('')
  const [tanggal, setTanggal] = useState(isoHari(1))
  const [jenis, setJenis] = useState<Agenda['kind']>('ulangan')
  const [mapel, setMapel] = useState('')
  const [teks, setTeks] = useState('')
  const [lampau, setLampau] = useState(false)
  const kini = isoHari()
  const tampil = agenda.filter((a) => lampau || a.date >= kini)
  const muridTerurut = useMemo(() => [...murid].filter((m) => m.role !== 'guru').sort((a, b) => a.name.localeCompare(b.name)), [murid])

  const simpan = async () => {
    if (!tujuan) return toastGalat('Choose a student or a group.')
    if (!mapel.trim() && !teks.trim()) return toastGalat('Write the subject or what it is about.')
    const [jenisTujuan, id] = tujuan.split(':')
    try {
      await tambahAgenda({ ...(jenisTujuan === 'g' ? { grup: id } : { murid: id }), tanggal, jenis, mapel, teks })
      setMapel('')
      setTeks('')
      toast('Added to the agenda.')
    } catch (e) {
      galat(e)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="ex-card flex flex-col gap-1 p-2">
        <select value={tujuan} onChange={(e) => setTujuan(e.target.value)} style={gayaInput} aria-label="For">
          <option value="">For… (student or group)</option>
          {grup.length > 0 && (
            <optgroup label="Groups">
              {grup.map((g) => (
                <option key={g.id} value={`g:${g.id}`}>
                  👥 {g.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Students">
            {muridTerurut.map((m) => (
              <option key={m.id} value={`m:${m.id}`}>
                {m.name}
              </option>
            ))}
          </optgroup>
        </select>
        <div className="flex gap-1">
          <input type="date" value={tanggal} onChange={(e) => setTanggal(e.target.value)} style={{ ...gayaInput, flex: 1 }} aria-label="Date" />
          <select value={jenis} onChange={(e) => setJenis(e.target.value as Agenda['kind'])} style={{ ...gayaInput, flex: 1 }} aria-label="Type">
            <option value="ulangan">📝 Test</option>
            <option value="tugas">📚 Homework</option>
            <option value="lain">📌 Other</option>
          </select>
        </div>
        <input value={mapel} onChange={(e) => setMapel(e.target.value)} placeholder="Subject" style={gayaInput} maxLength={40} />
        <input value={teks} onChange={(e) => setTeks(e.target.value)} placeholder="What is it? (chapter, pages…)" style={gayaInput} maxLength={300} />
        <button className="ex-btn justify-center" data-variant="accent" style={{ padding: '4px 0' }} onClick={() => void simpan()}>
          + Add to agenda
        </button>
      </div>
      <div className="flex items-center gap-1">
        {(
          [
            [false, 'Upcoming'],
            [true, 'Incl. last week'],
          ] as [boolean, string][]
        ).map(([v, label]) => (
          <button key={label} className="ex-btn" data-variant={lampau === v ? 'accent' : 'ghost'} style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => setLampau(v)}>
            {label}
          </button>
        ))}
      </div>
      {tampil.map((a) => (
        <div key={a.id} className="ex-card flex items-start gap-2 p-2" style={{ opacity: a.date < kini ? 0.55 : 1 }}>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, color: '#fff', background: a.kind === 'tugas' ? 'var(--accent-2)' : a.kind === 'lain' ? 'var(--ink-soft)' : 'var(--accent)' }}>
                {LABEL[a.kind]}
              </span>
              <span style={{ fontWeight: 600, fontSize: 'var(--fs-label)' }}>{tglPendek(a.date)}</span>
              {a.subject && <span style={{ fontSize: 'var(--fs-label)' }}>· {a.subject}</span>}
            </div>
            {a.text && <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{a.text}</div>}
            <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>
              {a.group_id ? '👥 ' : ''}
              {a.untuk ?? '—'} · {a.created_by === 'guru' ? `by ${a.author_name || 'teacher'}` : 'by the student'}
            </div>
          </div>
          <IconButton nama="hapus" label="Delete" ukuran={12} onClick={() => void hapusAgenda(a.id).catch(galat)} />
        </div>
      ))}
      {tampil.length === 0 && (
        <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
          No upcoming tests or homework. Students add them from 📒 My info on their phone; they get a reminder at 18:00 the evening before.
        </p>
      )}
    </div>
  )
}

export function TabCatatan({ murid }: { murid: Murid[] }) {
  const { data: catatan } = useData('kelas', daftarCatatan, [])
  const [pilih, setPilih] = useState('')
  const [teks, setTeks] = useState('')
  const muridTerurut = useMemo(() => [...murid].filter((m) => m.role !== 'guru').sort((a, b) => a.name.localeCompare(b.name)), [murid])
  const tampil = pilih ? catatan.filter((n) => n.student_id === pilih) : catatan

  const simpan = async () => {
    if (!pilih) return toastGalat('Choose a student first.')
    if (!teks.trim()) return
    try {
      await tambahCatatan(pilih, teks)
      setTeks('')
      toast('Note sent — the student gets a notification.')
    } catch (e) {
      galat(e)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="ex-card flex flex-col gap-1 p-2">
        <select value={pilih} onChange={(e) => setPilih(e.target.value)} style={gayaInput} aria-label="Student">
          <option value="">All students</option>
          {muridTerurut.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {pilih && (
          <>
            <textarea
              value={teks}
              onChange={(e) => setTeks(e.target.value)}
              placeholder="Note for this student (they see it in 📒 My info → Notes)"
              rows={3}
              maxLength={1000}
              style={{ ...gayaInput, resize: 'vertical' }}
            />
            <button className="ex-btn justify-center" data-variant="accent" style={{ padding: '4px 0' }} onClick={() => void simpan()}>
              Send note
            </button>
          </>
        )}
      </div>
      {tampil.map((n) => (
        <div key={n.id} className="ex-card flex items-start gap-2 p-2" style={{ borderColor: n.author === 'guru' ? 'var(--accent)' : undefined }}>
          <div className="min-w-0 flex-1">
            <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
              {!pilih && <strong style={{ color: 'var(--ink)' }}>{n.murid ?? '—'} · </strong>}
              {n.author === 'guru' ? `👩‍🏫 ${n.author_name || 'Teacher'}` : '🙂 Student'} ·{' '}
              {new Date(n.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
            <div style={{ fontSize: 'var(--fs-label)', whiteSpace: 'pre-wrap' }}>{n.text}</div>
          </div>
          <IconButton nama="hapus" label="Delete" ukuran={12} onClick={() => void hapusCatatan(n.id).catch(galat)} />
        </div>
      ))}
      {tampil.length === 0 && (
        <p className="ex-label" style={{ color: 'var(--ink-faint)' }}>
          No notes yet. Pick a student to write one; students can also keep their own notes, which you see here.
        </p>
      )}
    </div>
  )
}
