//! Migrasi SQLite. Dijalankan tauri-plugin-sql saat koneksi pertama dibuka.
//! Sumber kebenaran sketsa tetap berkas JSON di vault/canvas — tabel di sini
//! hanya indeks (judul & waktu ubah) plus setelan aplikasi.
//!
//! JANGAN mengubah SQL migrasi yang sudah pernah diterapkan: sqlx menyimpan
//! checksum-nya. Tambahkan migrasi baru dengan versi berikutnya.

use tauri_plugin_sql::{Migration, MigrationKind};

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "skema awal",
            kind: MigrationKind::Up,
            sql: SKEMA_AWAL,
        },
        Migration {
            version: 2,
            description: "kelas langsung: murid, grup, pertanyaan",
            kind: MigrationKind::Up,
            sql: SKEMA_KELAS,
        },
        Migration {
            version: 3,
            description: "kanvas khusus tiap murid",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE students ADD COLUMN sketch_id TEXT;",
        },
        Migration {
            version: 4,
            description: "kanvas bersama tiap grup",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE groups ADD COLUMN sketch_id TEXT;",
        },
        Migration {
            version: 5,
            description: "anti-spam: murid dibisukan sementara",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE students ADD COLUMN muted_until INTEGER;",
        },
        Migration {
            version: 6,
            description: "akun murid & sesi login",
            kind: MigrationKind::Up,
            sql: SKEMA_AKUN,
        },
        Migration {
            version: 7,
            description: "izin murid mencoret kanvasnya sendiri",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE students ADD COLUMN can_draw INTEGER NOT NULL DEFAULT 0;",
        },
        Migration {
            version: 8,
            description: "akun perlu persetujuan guru; grup permanen (jadwal, kanvas per hari)",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE accounts ADD COLUMN approved INTEGER NOT NULL DEFAULT 0;
                  ALTER TABLE groups ADD COLUMN schedule TEXT;
                  ALTER TABLE groups ADD COLUMN sketch_day TEXT;",
        },
        Migration {
            version: 9,
            description: "riwayat kanvas grup: tiap kanvas harian dicap grupnya",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE canvases ADD COLUMN group_id TEXT;
                  CREATE INDEX IF NOT EXISTS idx_canvases_grup ON canvases(group_id);",
        },
        Migration {
            version: 10,
            description: "pertanyaan boleh bawa beberapa foto sekaligus",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE questions ADD COLUMN photos TEXT;",
        },
        Migration {
            version: 11,
            description: "kanvas pribadi murid per hari, seperti kanvas grup",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE students ADD COLUMN sketch_day TEXT;",
        },
        Migration {
            version: 12,
            description: "riwayat kanvas pribadi murid: tiap kanvas harian dicap muridnya (grup sudah punya group_id sejak migrasi 9, tapi tidak pernah benar-benar ditulis — diperbaiki bersamaan)",
            kind: MigrationKind::Up,
            sql: "ALTER TABLE canvases ADD COLUMN student_id TEXT;
                  CREATE INDEX IF NOT EXISTS idx_canvases_murid ON canvases(student_id);",
        },
    ]
}

/// Akun murid: nomor HP sebagai nama pengguna, sandi disimpan sebagai hash
/// PBKDF2 bergaram. Sesi adalah token acak yang dipegang browser; satu akun
/// boleh punya beberapa sesi (HP dan laptop).
const SKEMA_AKUN: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device     TEXT,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_akun ON sessions(account_id);
"#;

/// Kelas langsung: murid yang masuk lewat HP, grup buatan guru, dan antrian
/// pertanyaan. Foto pertanyaan tinggal di `vault/tanya/` dan dihapus bersama
/// barisnya setelah sehari — ini antrian, bukan arsip.
const SKEMA_KELAS: &str = r#"
CREATE TABLE IF NOT EXISTS students (
  id         TEXT PRIMARY KEY,   -- id perangkat, dibuat HP sekali lalu diingat
  name       TEXT NOT NULL,
  room       INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT,
  -- Apa yang diikuti anggota grup: NULL = ruangannya sendiri,
  -- 'ruang:2' = editor aktif di ruangan 2, 'editor:<id>' = satu editor
  -- tertentu, 'sketsa:<id>' = satu sketsa tetap (satu halaman penuh).
  target     TEXT,
  sort_order REAL
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id   TEXT NOT NULL,
  student_id TEXT NOT NULL,
  PRIMARY KEY (group_id, student_id)
);

CREATE TABLE IF NOT EXISTS questions (
  id         TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  room       INTEGER NOT NULL,
  text       TEXT,
  photo      TEXT,               -- nama berkas di vault/tanya, NULL kalau tanpa foto
  status     TEXT NOT NULL,      -- 'menunggu' | 'dibahas' | 'selesai'
  created_at INTEGER NOT NULL,
  handled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_questions_status ON questions(status, created_at);
"#;

const SKEMA_AWAL: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Kanvas (metadata; stroke ada di vault/canvas/*.json)
CREATE TABLE IF NOT EXISTS canvases (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  updated_at INTEGER
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'kaca');
"#;
