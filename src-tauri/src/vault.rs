//! Vault: data pengguna di luar aplikasi.
//!
//! Bawaannya `~/ExactCanvas`; kalau folder `ExactCanvas` sudah ada di iCloud
//! Drive (dibuat Mac lain), itu yang dipakai. Sketsa tetap berkas JSON biasa.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub root: String,
    pub db_url: String,
    pub canvas_dir: String,
}

pub const NAMA_VAULT: &str = "ExactCanvas";

/// Ingatan lokasi vault selama aplikasi hidup.
static VAULT: std::sync::RwLock<Option<PathBuf>> = std::sync::RwLock::new(None);

/// Berkas penunjuk lokasi vault, di Application Support (lokal per Mac).
fn penunjuk_vault() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.exactgroup.canvas")
        .join("vault-path")
}

fn simpan_penunjuk(p: &Path) -> std::io::Result<()> {
    let berkas = penunjuk_vault();
    if let Some(dir) = berkas.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&berkas, p.to_string_lossy().as_bytes())
}

/* ── iCloud Drive ──────────────────────────────────────────────────── */

pub fn icloud_root() -> Option<PathBuf> {
    let p = dirs::home_dir()?
        .join("Library")
        .join("Mobile Documents")
        .join("com~apple~CloudDocs");
    p.is_dir().then_some(p)
}

pub fn icloud_vault() -> Option<PathBuf> {
    icloud_root().map(|p| p.join(NAMA_VAULT))
}

pub fn di_icloud(p: &Path) -> bool {
    icloud_root().map(|c| p.starts_with(&c)).unwrap_or(false)
}

fn nama_penampung(nama: &str) -> String {
    format!(".{nama}.icloud")
}

fn ada_walau_belum_terunduh(dir: &Path, nama: &str) -> bool {
    dir.join(nama).exists() || dir.join(nama_penampung(nama)).exists()
}

/// Apakah folder ini sudah berisi vault (termasuk yang isinya masih di iCloud)?
pub fn tampak_vault(p: &Path) -> bool {
    p.is_dir()
        && ["exact-canvas.db", "canvas"]
            .iter()
            .any(|n| ada_walau_belum_terunduh(p, n))
}

fn unduh(p: &Path) {
    let _ = std::process::Command::new("/usr/bin/brctl")
        .arg("download")
        .arg(p)
        .output();
}

/// Pastikan satu berkas benar-benar ada isinya sebelum dibuka.
pub fn pastikan_terunduh(p: &Path) {
    if p.exists() || !di_icloud(p) {
        return;
    }
    let (Some(dir), Some(nama)) = (p.parent(), p.file_name().and_then(|s| s.to_str())) else {
        return;
    };
    if !dir.join(nama_penampung(nama)).exists() {
        return;
    }
    unduh(p);
    for _ in 0..100 {
        if p.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Turunkan database & sketsa dari iCloud sebelum apa pun dibuka.
pub fn siapkan_icloud() {
    let r = root();
    if !di_icloud(&r) {
        return;
    }
    pastikan_terunduh(&db_path());
    let canvas = canvas_dir();
    std::thread::spawn(move || unduh(&canvas));
}

/* ── Menemukan vault ───────────────────────────────────────────────── */

/// Lokasi vault. Bisa ditimpa lewat variabel lingkungan EXACT_CANVAS_VAULT.
pub fn root() -> PathBuf {
    if let Ok(p) = std::env::var("EXACT_CANVAS_VAULT") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    if let Some(p) = VAULT.read().ok().and_then(|g| g.clone()) {
        return p;
    }
    let hasil = cari_vault();
    if let Ok(mut g) = VAULT.write() {
        *g = Some(hasil.clone());
    }
    hasil
}

fn cari_vault() -> PathBuf {
    let tertunjuk = fs::read_to_string(penunjuk_vault())
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    if let Some(p) = tertunjuk {
        if p.is_dir() {
            return p;
        }
        if di_icloud(&p) {
            let _ = fs::create_dir_all(&p);
            return p;
        }
    }

    // Belum pernah disetel di Mac ini. Kalau vault sudah ada di iCloud, pakai.
    if let Some(p) = icloud_vault() {
        if tampak_vault(&p) {
            let _ = simpan_penunjuk(&p);
            return p;
        }
    }

    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(NAMA_VAULT)
}

pub fn canvas_dir() -> PathBuf {
    root().join("canvas")
}
/// Foto pertanyaan murid; dibersihkan otomatis setelah sehari.
pub fn tanya_dir() -> PathBuf {
    root().join("tanya")
}
pub fn db_path() -> PathBuf {
    root().join("exact-canvas.db")
}

/// URL koneksi untuk tauri-plugin-sql; database ikut di dalam vault.
pub fn db_url() -> String {
    format!("sqlite:{}", db_path().to_string_lossy())
}

pub fn ensure_layout() -> std::io::Result<()> {
    fs::create_dir_all(canvas_dir())?;
    fs::create_dir_all(backup_dir())?;
    fs::create_dir_all(tanya_dir())?;
    let readme = root().join("BACA-DULU.md");
    if !ada_walau_belum_terunduh(&root(), "BACA-DULU.md") {
        let _ = fs::write(
            &readme,
            "# Vault Exact Canvas\n\n\
             Folder ini milik kamu, bukan milik aplikasi.\n\n\
             - `canvas/` — sketsa, satu berkas JSON per sketsa (vektor + gambar tempelan).\n\
             - `backup/<id>/` — 30 versi terakhir tiap sketsa, disalin sebelum ditimpa.\n\
             - `exact-canvas.db` — indeks judul sketsa dan setelan aplikasi.\n\n\
             ## Dipakai di beberapa Mac\n\n\
             Pindahkan folder ini ke iCloud Drive (Settings \u{2192} Vault \u{2192} Use another folder),\n\
             lalu di Mac berikutnya aplikasi menemukannya sendiri. Satu Mac dalam satu waktu.\n",
        );
    }
    Ok(())
}

/// Tolak path yang keluar dari folder induk.
pub fn resolve_within(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err("Absolute paths are not allowed.".into());
    }
    for c in candidate.components() {
        match c {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid path.".into())
            }
            _ => {}
        }
    }
    Ok(base.join(candidate))
}

/* ── Perintah yang dipanggil dari frontend ─────────────────────────── */

#[tauri::command]
pub fn vault_info() -> VaultInfo {
    VaultInfo {
        root: root().to_string_lossy().into(),
        db_url: db_url(),
        canvas_dir: canvas_dir().to_string_lossy().into(),
    }
}

/// Pakai folder lain sebagai vault. Berlaku setelah aplikasi dimulai ulang.
#[tauri::command]
pub fn vault_set_root(path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err("That folder is not there.".into());
    }
    simpan_penunjuk(&p).map_err(|e| e.to_string())?;
    if let Ok(mut g) = VAULT.write() {
        *g = Some(p.clone());
    }
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn app_restart(app: AppHandle) {
    app.restart()
}

#[tauri::command]
pub fn canvas_list() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(canvas_dir()) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

#[tauri::command]
pub fn canvas_read(id: String) -> Result<Option<String>, String> {
    let p = resolve_within(&canvas_dir(), &format!("{id}.json"))?;
    pastikan_terunduh(&p);
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(p).map(Some).map_err(|e| e.to_string())
}

pub fn backup_dir() -> PathBuf {
    root().join("backup")
}

/// Berapa versi lama tiap sketsa yang disimpan.
const VERSI_CADANGAN: usize = 12;

/// Simpan versi sebelumnya sebelum sebuah sketsa ditimpa.
///
/// Sketsa yang tertimpa isi kosong — oleh klien yang gagal memuat, oleh
/// pengguna yang keliru menghapus semua — pernah berarti hilang selamanya.
/// Sekarang tiap penulisan meninggalkan salinan yang lama di
/// `backup/<id>/<waktu>.json`, dan hanya tiga puluh terakhir yang ditahan.
/// Jarak minimum antar cadangan satu sketsa.
///
/// Sketsa disimpan tiap kali tangan berhenti sebentar; sketsa berisi 40 halaman
/// PDF berukuran 20 MB, dan menyalin 20 MB tiap jeda menulis membuat folder
/// cadangan membengkak ratusan megabita dalam hitungan menit. Satu salinan per
/// dua menit sudah cukup untuk kembali ke keadaan yang masuk akal.
const JARAK_CADANGAN_MS: u128 = 2 * 60 * 1000;

fn cadangkan_sebelum_tulis(id: &str, p: &Path, baru: &str) {
    let Ok(lama) = fs::read_to_string(p) else { return };
    if lama == baru {
        return;
    }
    let dir = backup_dir().join(id);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stempel = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // Cadangan terbaru masih segar: lewati, jangan tumpuk salinan tiap jeda.
    if let Ok(entries) = fs::read_dir(&dir) {
        let terbaru = entries
            .flatten()
            .filter_map(|e| e.path().file_stem()?.to_str()?.parse::<u128>().ok())
            .max()
            .unwrap_or(0);
        if stempel.saturating_sub(terbaru) < JARAK_CADANGAN_MS {
            return;
        }
    }
    let _ = fs::write(dir.join(format!("{stempel}.json")), lama);
    // Pangkas yang paling tua.
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut berkas: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
            .collect();
        berkas.sort();
        while berkas.len() > VERSI_CADANGAN {
            let _ = fs::remove_file(berkas.remove(0));
        }
    }
}

/// Satu kunci untuk SEMUA penulisan berkas sketsa: simpanan editor (Mac,
/// tablet) dan coretan murid yang digabung server adalah baca–ubah–tulis atas
/// berkas yang sama. Tanpa kunci, dua penulis yang berselisih beberapa
/// milidetik saling menimpa — goresan salah satunya hilang tanpa jejak.
static KUNCI_TULIS: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn kunci_tulis() -> std::sync::MutexGuard<'static, ()> {
    KUNCI_TULIS.lock().unwrap_or_else(|e| e.into_inner())
}

/// `updated_at` tingkat atas berkas sketsa, tanpa mengurai seluruh JSON
/// (sketsa ber-PDF bisa belasan MB). Kunci itu hanya ada di tingkat atas.
pub fn updated_at_berkas(teks: &str) -> Option<i64> {
    let i = teks.rfind("\"updated_at\":")? + "\"updated_at\":".len();
    let angka: String = teks[i..].trim_start().chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
    angka.parse().ok()
}

/// Tulis berkas sketsa. Pemanggil WAJIB sudah memegang `kunci_tulis()`.
pub fn tulis_berkas_terkunci(id: &str, json: &str) -> Result<(), String> {
    // JSON yang tidak terbaca ditolak di sini, bukan disimpan lalu gagal dibuka.
    serde_json::from_str::<serde_json::Value>(json).map_err(|e| format!("Sketch data is not valid JSON: {e}"))?;
    fs::create_dir_all(canvas_dir()).map_err(|e| e.to_string())?;
    let p = resolve_within(&canvas_dir(), &format!("{id}.json"))?;
    cadangkan_sebelum_tulis(id, &p, json);
    // Tulis ke berkas sementara lalu ganti nama: pembaca tidak pernah melihat
    // berkas setengah jadi, dan aplikasi yang mati di tengah jalan tidak
    // meninggalkan sketsa terpotong.
    let sementara = p.with_extension("json.tmp");
    fs::write(&sementara, json).map_err(|e| e.to_string())?;
    fs::rename(&sementara, &p).map_err(|e| e.to_string())
}

/// Simpan sketsa. `dasar` = `updated_at` versi yang sedang disunting penulis;
/// kalau berkasnya sudah berubah sejak itu (penulis lain menyimpan lebih dulu),
/// tulisan ditolak dengan "KONFLIK:<updated_at sekarang>" supaya penulis
/// menggabungkan dulu, bukan menimpa.
#[tauri::command]
pub fn canvas_write(id: String, json: String, dasar: Option<i64>) -> Result<(), String> {
    let _g = kunci_tulis();
    if let Some(d) = dasar {
        if let Ok(p) = resolve_within(&canvas_dir(), &format!("{id}.json")) {
            if let Some(kini) = fs::read_to_string(&p).ok().as_deref().and_then(updated_at_berkas) {
                if kini != d {
                    return Err(format!("KONFLIK:{kini}"));
                }
            }
        }
    }
    tulis_berkas_terkunci(&id, &json)
}

/// Hapus berkas sketsa. Berkas yang sudah tidak ada bukan dianggap galat.
#[tauri::command]
pub fn canvas_delete(id: String) -> Result<(), String> {
    let p = resolve_within(&canvas_dir(), &format!("{id}.json"))?;
    if !p.exists() {
        return Ok(());
    }
    fs::remove_file(p).map_err(|e| e.to_string())
}

/// Simpan hasil ekspor (PNG/SVG/PDF) ke lokasi yang dipilih pengguna.
#[tauri::command]
pub fn write_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| e.to_string())
}

/// Perubahan sebagian satu koleksi (strokes/images/objects/texts): id yang
/// dihapus, dan butir baru atau yang berubah (diganti di tempat; yang baru
/// ditambahkan di belakang).
#[derive(serde::Deserialize, Default)]
pub struct KoleksiTambalan {
    #[serde(default)]
    pub hapus: Vec<String>,
    #[serde(default)]
    pub tambah: Vec<serde_json::Value>,
}

#[derive(serde::Deserialize)]
pub struct Tambalan {
    /// `updated_at` versi berkas yang menjadi dasar perubahan ini.
    pub dasar: i64,
    /// Gabung tanpa cek versi: selisih koleksi (tambah/ganti/hapus per id)
    /// diterapkan di atas berkas terbaru, termasuk goresan murid yang masuk di
    /// sela-sela — itulah hasil penggabungan tiga arah untuk koleksi, tanpa
    /// editor harus mengunduh ulang berkas puluhan MB dulu.
    #[serde(default)]
    pub gabung: bool,
    pub updated_at: i64,
    /// Nilai tingkat atas yang kecil: title, layers, paper, pages.
    #[serde(default)]
    pub set: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub koleksi: std::collections::HashMap<String, KoleksiTambalan>,
}

/// Terapkan simpanan sebagian ke berkas sketsa, dengan cek versi yang sama
/// seperti `canvas_write` (KONFLIK bila berkas berubah sejak `dasar`).
pub fn canvas_tambal(id: &str, t: Tambalan) -> Result<(), String> {
    let _g = kunci_tulis();
    let p = resolve_within(&canvas_dir(), &format!("{id}.json"))?;
    let teks = fs::read_to_string(&p).map_err(|_| "Sketch file not found.".to_string())?;
    let kini = updated_at_berkas(&teks);
    if !t.gabung && kini != Some(t.dasar) {
        return Err(format!("KONFLIK:{}", kini.unwrap_or(0)));
    }
    let mut d: serde_json::Value = serde_json::from_str(&teks).map_err(|e| e.to_string())?;
    if !d.is_object() {
        return Err("Sketch file is not an object.".into());
    }
    for (k, v) in t.set {
        if matches!(k.as_str(), "title" | "layers" | "paper" | "pages") {
            d[k] = v;
        }
    }
    for (nama, kol) in t.koleksi {
        if !matches!(nama.as_str(), "strokes" | "images" | "objects" | "texts") {
            continue;
        }
        if !d[&nama].is_array() {
            d[&nama] = serde_json::Value::Array(vec![]);
        }
        let arr = d[&nama].as_array_mut().expect("array");
        if !kol.hapus.is_empty() {
            let ids: std::collections::HashSet<&str> = kol.hapus.iter().map(|s| s.as_str()).collect();
            arr.retain(|x| !x["id"].as_str().map(|i| ids.contains(i)).unwrap_or(false));
        }
        for butir in kol.tambah {
            let Some(bid) = butir["id"].as_str().map(|s| s.to_string()) else { continue };
            if let Some(ada) = arr.iter_mut().find(|x| x["id"].as_str() == Some(bid.as_str())) {
                *ada = butir;
            } else {
                arr.push(butir);
            }
        }
    }
    d["updated_at"] = serde_json::json!(t.updated_at);
    tulis_berkas_terkunci(id, &d.to_string())
}

#[cfg(test)]
mod uji_tulis {
    use super::{canvas_read, canvas_write, updated_at_berkas};

    #[test]
    fn stempel_waktu() {
        assert_eq!(updated_at_berkas(r#"{"id":"a","strokes":[],"updated_at":1760000000123}"#), Some(1760000000123));
        // Urutan kunci dari serde (abjad): updated_at tetap terbaca.
        assert_eq!(updated_at_berkas(r#"{"pages":1,"title":"x","updated_at": 42}"#), Some(42));
        assert_eq!(updated_at_berkas(r#"{"id":"a"}"#), None);
    }

    /// Simpanan yang dibuat dari versi basi ditolak; yang dari versi terbaru diterima.
    #[test]
    fn simpanan_basi_ditolak() {
        std::env::set_var("EXACT_CANVAS_VAULT", std::env::temp_dir().join("uji-exact-vault"));
        let _ = std::fs::create_dir_all(std::env::temp_dir().join("uji-exact-vault"));
        let id = format!("cnv_uji{}", std::process::id());
        canvas_write(id.clone(), r#"{"id":"x","strokes":[],"updated_at":100}"#.into(), None).unwrap();
        // Murid menyimpan goresan → versi 200.
        canvas_write(id.clone(), r#"{"id":"x","strokes":[{"id":"m"}],"updated_at":200}"#.into(), Some(100)).unwrap();
        // Tablet guru masih memegang versi 100: ditolak, bukan menimpa goresan murid.
        let e = canvas_write(id.clone(), r#"{"id":"x","strokes":[{"id":"g"}],"updated_at":300}"#.into(), Some(100)).unwrap_err();
        assert_eq!(e, "KONFLIK:200");
        assert!(canvas_read(id.clone()).unwrap().unwrap().contains(r#""id":"m""#));
        // Sesudah menggabung (dasar 200) diterima.
        canvas_write(id.clone(), r#"{"id":"x","strokes":[{"id":"m"},{"id":"g"}],"updated_at":300}"#.into(), Some(200)).unwrap();
        assert_eq!(updated_at_berkas(&canvas_read(id.clone()).unwrap().unwrap()), Some(300));
        let _ = super::canvas_delete(id);
    }

    #[test]
    fn tambalan_sebagian() {
        use super::{canvas_tambal, KoleksiTambalan, Tambalan};
        std::env::set_var("EXACT_CANVAS_VAULT", std::env::temp_dir().join("uji-exact-vault"));
        let _ = std::fs::create_dir_all(std::env::temp_dir().join("uji-exact-vault"));
        let id = format!("cnv_ujitambal{}", std::process::id());
        canvas_write(id.clone(), r#"{"id":"x","title":"T","strokes":[{"id":"a","w":1},{"id":"b","w":1}],"images":[{"id":"g","src":"data:besar"}],"updated_at":10}"#.into(), None).unwrap();
        let mut koleksi = std::collections::HashMap::new();
        koleksi.insert("strokes".to_string(), KoleksiTambalan {
            hapus: vec!["a".into()],
            tambah: vec![serde_json::json!({"id":"b","w":2}), serde_json::json!({"id":"c","w":1})],
        });
        let t = Tambalan { dasar: 10, gabung: false, updated_at: 20, set: serde_json::Map::new(), koleksi };
        canvas_tambal(&id, t).unwrap();
        let d: serde_json::Value = serde_json::from_str(&canvas_read(id.clone()).unwrap().unwrap()).unwrap();
        assert_eq!(d["strokes"], serde_json::json!([{"id":"b","w":2},{"id":"c","w":1}]));
        assert_eq!(d["images"][0]["src"], "data:besar", "gambar yang tidak dikirim tetap utuh");
        assert_eq!(d["updated_at"], 20);
        // Dasar basi ditolak.
        let basi = Tambalan { dasar: 10, gabung: false, updated_at: 30, set: serde_json::Map::new(), koleksi: Default::default() };
        assert_eq!(canvas_tambal(&id, basi).unwrap_err(), "KONFLIK:20");
        // Mode gabung: dasar basi tetap diterapkan di atas versi terbaru, goresan lain tidak tersentuh.
        let mut k2 = std::collections::HashMap::new();
        k2.insert("strokes".to_string(), KoleksiTambalan { hapus: vec![], tambah: vec![serde_json::json!({"id":"d"})] });
        canvas_tambal(&id, Tambalan { dasar: 10, gabung: true, updated_at: 40, set: serde_json::Map::new(), koleksi: k2 }).unwrap();
        let d: serde_json::Value = serde_json::from_str(&canvas_read(id.clone()).unwrap().unwrap()).unwrap();
        assert_eq!(d["strokes"], serde_json::json!([{"id":"b","w":2},{"id":"c","w":1},{"id":"d"}]));
        let _ = super::canvas_delete(id);
    }
}
