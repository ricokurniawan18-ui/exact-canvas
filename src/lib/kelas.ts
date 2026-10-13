/**
 * Kelas langsung di sisi guru: ruangan editor ini, antrian pertanyaan, murid
 * yang masuk, dan grup. Data tinggal di SQLite vault; aksi yang harus
 * mengabari HP (membahas pertanyaan) lewat endpoint server supaya HP murid
 * yang bersangkutan berbunyi.
 */

import { api } from './api'
import { q, x } from './db'
import { pancarkan } from './events'
import { newId } from './id'

export interface Tanya {
  id: string
  student_id: string
  name: string
  room: number
  text: string | null
  /** Nama berkas di vault/tanya, satu per lampiran (foto-foto, atau satu PDF). */
  photos: string[]
  status: 'menunggu' | 'dibahas' | 'selesai'
  created_at: number
  handled_at: number | null
  /** Guru yang dituju murid: 'utama', id akun guru pembantu, atau null = siapa saja. */
  for_teacher?: string | null
  /** Guru yang membahasnya ('utama' atau id akun). */
  handled_by?: string | null
  /** Permintaan murid: 'latihan' (minta soal latihan) atau 'print'; null = pertanyaan. */
  kind?: 'latihan' | 'print' | 'hasil' | null
  /** Kanvas yang sedang dilihat murid saat bertanya (pribadi atau grup); null = aturan lama. */
  target_canvas?: string | null
}

/** Guru yang bisa dipilih murid: guru utama ('utama') dan akun ber-peran guru. */
export interface Guru {
  id: string
  nama: string
  online: boolean
}

export async function daftarGuru(): Promise<Guru[]> {
  try {
    return await api<Guru[]>('/api/kelas/guru')
  } catch {
    return []
  }
}

/** Permintaan murid: salin lampirannya ke Desktop Mac lalu buka (Gemini / PDF print). */
export async function bukaPermintaan(id: string, aksi: 'gemini' | 'print'): Promise<void> {
  await api('/api/kelas/permintaan/buka', { method: 'POST', json: { id, aksi } })
}

/** Panggil murid ke meja guru ini: HP-nya berbunyi, pertanyaannya ditutup. */
export async function panggilMurid(idTanya: string): Promise<void> {
  await api('/api/kelas/panggil', { method: 'POST', json: { id: idTanya } })
}

/** Panggil seorang murid langsung ke meja guru (HP-nya berbunyi), tanpa pertanyaan. */
export async function panggilMuridLangsung(idMurid: string): Promise<void> {
  await api('/api/kelas/panggil', { method: 'POST', json: { murid: idMurid } })
}

/** Hanya guru utama: jadikan akun ini guru pembantu, atau cabut. */
export async function jadikanGuru(id: string, guru: boolean): Promise<void> {
  await api('/api/akun/peran', { method: 'POST', json: { id, guru } })
}

/** Baris mentah dari SQLite: `photos` masih JSON, belum diurai. */
type BarisTanya = Omit<Tanya, 'photos'> & { photos: string | null }

function uraiTanya(b: BarisTanya): Tanya {
  let photos: string[] = []
  if (b.photos) {
    try {
      photos = JSON.parse(b.photos)
    } catch {
      photos = []
    }
  }
  return { ...b, photos }
}

export interface Murid {
  id: string
  name: string
  room: number
  first_seen: number
  last_seen: number
  muted_until: number | null
  /** 1 = boleh mencoret kanvasnya sendiri dari HP. */
  can_draw: number
  /** Nomor HP dari akunnya (null untuk murid lama tanpa akun). */
  phone?: string | null
  /** 'guru' = akun ini guru pembantu. */
  role?: string | null
}

/** Akun murid (nomor HP + sandi) — identitas yang mengikuti anak ke perangkat mana pun. */
export interface Akun {
  id: string
  nama: string
  hp: string
  dibuat: number
  /** Guru sudah menerima pendaftarannya. */
  disetujui: boolean
}

export interface Grup {
  id: string
  name: string
  color: string | null
  /** null = kanvas sendiri/grup (bawaan); 'editor:<id>' | 'sketsa:<id>' */
  target: string | null
  /** Jadwal tetap, teks bebas: "Sen 16:00". */
  schedule?: string | null
  /** Kanvas grup hari ini (satu kanvas per grup per hari). */
  sketch_id?: string | null
  sketch_day?: string | null
  sort_order: number | null
}

/* ── Antrian ───────────────────────────────────────────────────────── */

export async function daftarTanya(): Promise<Tanya[]> {
  const baris = await q<BarisTanya>(
    "SELECT * FROM questions WHERE status != 'selesai' ORDER BY CASE status WHEN 'dibahas' THEN 0 ELSE 1 END, created_at ASC",
  )
  return baris.map(uraiTanya)
}

export async function riwayatTanya(batas = 30): Promise<Tanya[]> {
  const baris = await q<BarisTanya>("SELECT * FROM questions WHERE status = 'selesai' ORDER BY handled_at DESC LIMIT ?", [batas])
  return baris.map(uraiTanya)
}

/** Lewat server, bukan SQL langsung: HP murid (dan grupnya) harus dikabari. */
export async function ubahTanya(id: string, status: 'dibahas' | 'selesai', editor?: string, sketsa?: string): Promise<void> {
  await api('/api/kelas/ubah', { method: 'POST', json: { id, status, editor: editor ?? null, sketsa: sketsa ?? null } })
}

/* ── Murid & grup ──────────────────────────────────────────────────── */

/** Murid yang terlihat dalam 10 jam terakhir — satu hari mengajar. */
export async function daftarMurid(): Promise<Murid[]> {
  return q<Murid>(
    'SELECT s.*, a.phone, a.role FROM students s LEFT JOIN accounts a ON a.id = s.id WHERE s.last_seen > ? ORDER BY s.room, s.name COLLATE NOCASE',
    [Date.now() - 10 * 3600_000],
  )
}

/** Semua murid yang pernah masuk — untuk menyusun anggota tetap grup. */
export async function daftarMuridSemua(): Promise<Murid[]> {
  return q<Murid>('SELECT s.*, a.phone, a.role FROM students s LEFT JOIN accounts a ON a.id = s.id ORDER BY s.name COLLATE NOCASE')
}

export async function daftarAkun(): Promise<Akun[]> {
  // Berbagi belum menyala → server belum ada → belum ada akun yang bisa mendaftar.
  try {
    return await api<Akun[]>('/api/akun')
  } catch {
    return []
  }
}

/** Terima (akun aktif) atau tolak (akun dihapus) seorang pendaftar. */
export async function setujuiAkun(id: string, setuju: boolean): Promise<void> {
  await api('/api/akun/setujui', { method: 'POST', json: { id, setuju } })
}

/** Ganti sandi murid yang lupa; sesi lamanya dicabut. */
export async function resetSandiAkun(id: string, sandi: string): Promise<void> {
  await api('/api/akun/reset', { method: 'POST', json: { id, sandi } })
}

export async function daftarGrup(): Promise<Grup[]> {
  return q<Grup>('SELECT * FROM groups ORDER BY sort_order, name COLLATE NOCASE')
}

export async function anggotaGrup(): Promise<{ group_id: string; student_id: string }[]> {
  return q('SELECT group_id, student_id FROM group_members')
}

const WARNA_GRUP = ['#b4531a', '#1f6f5c', '#1d4ed8', '#7c3aed', '#d97706', '#0891b2']

export async function buatGrup(nama: string): Promise<string> {
  const id = newId('grp')
  const semua = await daftarGrup()
  await x('INSERT INTO groups (id, name, color, target, sort_order) VALUES (?, ?, ?, NULL, ?)', [
    id,
    nama.trim() || 'Group',
    WARNA_GRUP[semua.length % WARNA_GRUP.length],
    Date.now(),
  ])
  await pancarkan('kelas', { apa: 'grup' })
  return id
}

export async function ubahGrup(id: string, ubah: { name?: string; target?: string | null; schedule?: string | null }): Promise<void> {
  if (ubah.name !== undefined) await x('UPDATE groups SET name = ? WHERE id = ?', [ubah.name, id])
  if (ubah.target !== undefined) await x('UPDATE groups SET target = ? WHERE id = ?', [ubah.target, id])
  if (ubah.schedule !== undefined) await x('UPDATE groups SET schedule = ? WHERE id = ?', [ubah.schedule, id])
  await pancarkan('kelas', { apa: 'grup' })
}

export async function hapusGrup(id: string): Promise<void> {
  await x('DELETE FROM group_members WHERE group_id = ?', [id])
  await x('DELETE FROM groups WHERE id = ?', [id])
  await pancarkan('kelas', { apa: 'grup' })
}

/** Satu murid hanya di satu grup; null mengeluarkannya dari grup mana pun. */
export async function tetapkanGrup(muridId: string, grupId: string | null): Promise<void> {
  await x('DELETE FROM group_members WHERE student_id = ?', [muridId])
  if (grupId) await x('INSERT OR IGNORE INTO group_members (group_id, student_id) VALUES (?, ?)', [grupId, muridId])
  await pancarkan('kelas', { apa: 'grup' })
}

/** Bisukan pertanyaan dari seorang murid selama `menit`; 0 = buka lagi. */
export async function bisukanMurid(muridId: string, menit: number): Promise<void> {
  await x('UPDATE students SET muted_until = ? WHERE id = ?', [menit > 0 ? Date.now() + menit * 60_000 : null, muridId])
  await pancarkan('kelas', { apa: 'bisu' })
}

/**
 * Izinkan/cabut izin murid mencoret kanvasnya sendiri dari HP. Lewat server,
 * bukan SQL langsung: server yang memegang koneksi WebSocket murid itu dan
 * membuat kanvasnya kalau belum ada.
 */
export async function izinkanCoret(muridId: string, boleh: boolean): Promise<void> {
  await api('/api/kelas/izin', { method: 'POST', json: { murid: muridId, boleh } })
}

/** Tutup semua pertanyaan yang masih terbuka. */
export async function kosongkanAntrean(): Promise<void> {
  await x("UPDATE questions SET status = 'selesai', handled_at = ? WHERE status != 'selesai'", [Date.now()])
  await pancarkan('kelas', { apa: 'kosong' })
}

/* ── Bunyi ─────────────────────────────────────────────────────────── */

let bunyiTerakhir = 0

/** Bunyi pertanyaan baru paling sering sekali tiap 4 detik — banjir pertanyaan bukan alasan kelas berisik. */
export function bunyiTanya(): void {
  const kini = Date.now()
  if (kini - bunyiTerakhir < 4000) return
  bunyiTerakhir = kini
  bunyi('tanya')
}

let audio: AudioContext | null = null

/**
 * Dua nada pendek. AudioContext dibuat saat pertama dipanggil; di browser
 * ia baru boleh berbunyi setelah ada ketukan pengguna, jadi pemanggil di HP
 * memanggilnya sekali (tanpa bunyi) saat tombol Masuk ditekan.
 */
export function bunyi(jenis: 'tanya' | 'bahas' | 'diam' = 'tanya'): void {
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume()
    if (jenis === 'diam') return
    const nada = jenis === 'tanya' ? [880, 1174] : [659, 880, 1046]
    nada.forEach((f, i) => {
      const o = audio!.createOscillator()
      const g = audio!.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.value = 0.0001
      o.connect(g).connect(audio!.destination)
      const t0 = audio!.currentTime + i * 0.16
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15)
      o.start(t0)
      o.stop(t0 + 0.16)
    })
  } catch {
    /* tanpa audio */
  }
}

/** "3 min", "just now" */
export function lamaMenunggu(sejak: number): string {
  const m = Math.round((Date.now() - sejak) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} m`
}

/* ── Laporan harian murid: nilai ulangan & jadwal les ─────────────── */

export interface LaporanNilai {
  id: string
  student_id: string
  name: string
  subject: string | null
  test: string | null
  score: string
  test_date: string | null
  created_at: number
  read_at: number | null
}

export interface UpdateJadwal {
  id: string
  student_id: string
  name: string
  /** JSON {"Mon":"16:00", ...} */
  schedule: string
  previous: string | null
  created_at: number
  read_at: number | null
}

export const HARI_LES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

/** {"Mon":"16:00","Thu":"15:30"} → "Mon 16:00 · Thu 15:30" */
export function teksJadwal(json: string | null): string {
  if (!json) return '—'
  try {
    const j = JSON.parse(json) as Record<string, string>
    const isi = HARI_LES.filter((h) => h in j).map((h) => `${h} ${j[h] || ''}`.trim())
    return isi.length ? isi.join(' · ') : 'No lessons'
  } catch {
    return '—'
  }
}

export async function daftarLaporanNilai(): Promise<LaporanNilai[]> {
  return q<LaporanNilai>('SELECT * FROM score_reports ORDER BY created_at DESC LIMIT 400')
}

export async function daftarUpdateJadwal(): Promise<UpdateJadwal[]> {
  return q<UpdateJadwal>('SELECT * FROM schedule_updates ORDER BY created_at DESC LIMIT 200')
}

/** Tandai sudah dibaca (satu, atau semua bila id kosong). */
export async function tandaiDibaca(tabel: 'score_reports' | 'schedule_updates', id?: string): Promise<void> {
  if (id) await x(`UPDATE ${tabel} SET read_at = ? WHERE id = ?`, [Date.now(), id])
  else await x(`UPDATE ${tabel} SET read_at = ? WHERE read_at IS NULL`, [Date.now()])
  await pancarkan('kelas')
}

/* ── Agenda & catatan ──────────────────────────────────────────────── */

export interface Agenda {
  id: string
  student_id: string | null
  group_id: string | null
  date: string
  kind: 'ulangan' | 'tugas' | 'lain'
  subject: string | null
  text: string | null
  created_by: 'murid' | 'guru'
  author_name: string | null
  created_at: number
  /** Nama murid atau nama grup tujuan (hasil JOIN). */
  untuk: string | null
}

export interface Catatan {
  id: string
  student_id: string
  author: 'murid' | 'guru'
  author_name: string | null
  text: string
  created_at: number
  /** Nama murid (hasil JOIN). */
  murid: string | null
}

/** Agenda semua murid & grup, dari seminggu lalu ke depan. */
export async function daftarAgenda(): Promise<Agenda[]> {
  const d = new Date()
  d.setDate(d.getDate() - 7)
  const sejak = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return q<Agenda>(
    `SELECT a.*, COALESCE(s.name, g.name) AS untuk FROM agenda a
     LEFT JOIN students s ON s.id = a.student_id LEFT JOIN groups g ON g.id = a.group_id
     WHERE a.date >= ? ORDER BY a.date ASC, a.created_at ASC LIMIT 500`,
    [sejak],
  )
}

/** Lewat server, bukan SQL langsung: HP murid yang membuka My info ikut segar. */
export async function tambahAgenda(a: { murid?: string; grup?: string; tanggal: string; jenis: string; mapel: string; teks: string }): Promise<void> {
  await api('/api/kelas/agenda', { method: 'POST', json: a })
}

export async function hapusAgenda(id: string): Promise<void> {
  await api('/api/kelas/agenda/hapus', { method: 'POST', json: { id } })
}

export async function daftarCatatan(): Promise<Catatan[]> {
  return q<Catatan>(
    'SELECT n.*, s.name AS murid FROM notes n LEFT JOIN students s ON s.id = n.student_id ORDER BY n.created_at DESC LIMIT 500',
  )
}

export async function tambahCatatan(murid: string, teks: string): Promise<void> {
  await api('/api/kelas/catatan', { method: 'POST', json: { murid, teks } })
}

export async function hapusCatatan(id: string): Promise<void> {
  await api('/api/kelas/catatan/hapus', { method: 'POST', json: { id } })
}
