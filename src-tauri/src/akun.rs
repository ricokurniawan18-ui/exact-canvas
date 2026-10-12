//! Akun murid: daftar, masuk, sesi.
//!
//! Identitas murid adalah nomor HP-nya, bukan perangkatnya — ganti HP tetap
//! orang yang sama, riwayat pertanyaannya ikut. Sandi disimpan sebagai
//! PBKDF2-HMAC-SHA256 bergaram; yang dipegang browser hanya token sesi acak,
//! sehingga PIN kelas tidak pernah muncul di alamat HP murid. PIN dipakai
//! sekali saja sebagai "kode kelas" saat mendaftar.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::kelas::{alamat_klien, kebanjiran, koneksi};
use crate::server::{admin_sah, catat_gagal, diblokir, sah, tolak, Hub};

const ITERASI: u32 = 60_000;

fn sekarang() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn acak_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    if getrandom::getrandom(&mut b).is_err() {
        // Cadangan yang sangat tidak mungkin terpakai di macOS.
        for (i, x) in b.iter_mut().enumerate() {
            *x = (sekarang() as u64 >> (i % 8 * 8)) as u8 ^ (i as u8);
        }
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// PBKDF2-HMAC-SHA256 satu blok (32 byte) — cukup untuk sandi.
fn pbkdf2(sandi: &str, garam: &str) -> String {
    type H = Hmac<Sha256>;
    let mut mac = H::new_from_slice(sandi.as_bytes()).expect("hmac");
    mac.update(garam.as_bytes());
    mac.update(&1u32.to_be_bytes());
    let mut u = mac.finalize().into_bytes();
    let mut hasil = u.clone();
    for _ in 1..ITERASI {
        let mut m = H::new_from_slice(sandi.as_bytes()).expect("hmac");
        m.update(&u);
        u = m.finalize().into_bytes();
        for (h, x) in hasil.iter_mut().zip(u.iter()) {
            *h ^= x;
        }
    }
    hasil.iter().map(|x| format!("{x:02x}")).collect()
}

fn sama_tetap(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Nomor HP dinormalkan: hanya digit, 08xx → 628xx.
pub fn normalkan_hp(hp: &str) -> String {
    let digit: String = hp.chars().filter(|c| c.is_ascii_digit()).collect();
    if let Some(sisa) = digit.strip_prefix('0') {
        format!("62{sisa}")
    } else {
        digit
    }
}

/* ── Sesi ──────────────────────────────────────────────────────────── */

/// Token yang baru diperiksa, supaya tiap permintaan tidak membuka SQLite.
static CACHE_SESI: Mutex<Option<HashMap<String, (String, Instant)>>> = Mutex::new(None);

/// Id akun pemilik token — hanya akun yang sudah disetujui guru. Akun yang
/// masih menunggu punya sesi (supaya HP-nya bisa menanyakan statusnya) tetapi
/// belum membuka kelas.
pub fn akun_dari_sesi(token: &str) -> Option<String> {
    if token.len() < 16 {
        return None;
    }
    {
        let mut g = CACHE_SESI.lock().unwrap_or_else(|e| e.into_inner());
        let peta = g.get_or_insert_with(HashMap::new);
        if let Some((akun, sejak)) = peta.get(token) {
            if sejak.elapsed().as_secs() < 300 {
                return Some(akun.clone());
            }
        }
    }
    let c = koneksi().ok()?;
    let akun: String = c
        .query_row(
            "SELECT s.account_id FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?1 AND a.approved = 1",
            rusqlite::params![token],
            |r| r.get(0),
        )
        .ok()?;
    let _ = c.execute("UPDATE sessions SET last_seen = ?1 WHERE token = ?2", rusqlite::params![sekarang(), token]);
    let mut g = CACHE_SESI.lock().unwrap_or_else(|e| e.into_inner());
    let peta = g.get_or_insert_with(HashMap::new);
    if peta.len() > 5000 {
        peta.clear();
    }
    peta.insert(token.to_string(), (akun.clone(), Instant::now()));
    Some(akun)
}

/// Guru pembantu di balik sebuah sesi: (id akun, nama) bila akunnya disetujui
/// DAN berperan 'guru'. Tidak di-cache: peran bisa dicabut kapan saja dan
/// harus langsung berlaku.
pub fn guru_dari_sesi(token: &str) -> Option<(String, String)> {
    let id = akun_dari_sesi(token)?;
    let c = koneksi().ok()?;
    c.query_row(
        "SELECT id, name FROM accounts WHERE id = ?1 AND role = 'guru' AND approved = 1",
        rusqlite::params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .ok()
}

/// Token sesi dari header x-exact-sesi atau parameter URL.
pub fn sesi_dari(headers: &HeaderMap, q_sesi: Option<&str>) -> Option<String> {
    headers
        .get("x-exact-sesi")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| q_sesi.map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
}

/// Guru pembantu yang mengirim permintaan ini, kalau ada.
pub fn guru_dari_headers(headers: &HeaderMap, q_sesi: Option<&str>) -> Option<(String, String)> {
    guru_dari_sesi(&sesi_dari(headers, q_sesi)?)
}

fn kosongkan_cache_sesi() {
    if let Ok(mut g) = CACHE_SESI.lock() {
        if let Some(p) = g.as_mut() {
            p.clear();
        }
    }
}

fn lupakan_sesi(token: &str) {
    if let Ok(mut g) = CACHE_SESI.lock() {
        if let Some(p) = g.as_mut() {
            p.remove(token);
        }
    }
}

fn buat_sesi(c: &rusqlite::Connection, akun: &str, perangkat: &str) -> Result<String, String> {
    let token = acak_hex(24);
    c.execute(
        "INSERT INTO sessions (token, account_id, device, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)",
        rusqlite::params![token, akun, perangkat, sekarang()],
    )
    .map_err(|e| e.to_string())?;
    Ok(token)
}

fn perangkat_dari(headers: &HeaderMap) -> String {
    headers
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(120).collect())
        .unwrap_or_default()
}

fn token_dari(headers: &HeaderMap) -> Option<String> {
    headers.get("x-exact-sesi").and_then(|v| v.to_str().ok()).map(|s| s.to_string())
}

/* ── Daftar & masuk ────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct Daftar {
    pub nama: String,
    pub hp: String,
    pub sandi: String,
    /// PIN kelas, diketik sekali saat mendaftar — tidak pernah ada di alamat.
    pub kode: String,
}

pub async fn api_daftar(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(d): Json<Daftar>) -> Response {
    if kebanjiran(&headers) {
        return (StatusCode::TOO_MANY_REQUESTS, "Too many requests — slow down.").into_response();
    }
    let asal = alamat_klien(&headers);
    if diblokir(&asal) {
        return tolak();
    }
    if d.kode.trim() != hub.pin {
        catat_gagal(&asal);
        return (StatusCode::UNAUTHORIZED, "Wrong class code.").into_response();
    }
    let nama: String = d.nama.trim().chars().take(40).collect();
    let hp = normalkan_hp(&d.hp);
    if nama.chars().count() < 2 {
        return (StatusCode::BAD_REQUEST, "Please enter your name.").into_response();
    }
    if hp.len() < 9 || hp.len() > 16 {
        return (StatusCode::BAD_REQUEST, "That phone number doesn't look right.").into_response();
    }
    if d.sandi.chars().count() < 4 {
        return (StatusCode::BAD_REQUEST, "Password needs at least 4 characters.").into_response();
    }
    let perangkat = perangkat_dari(&headers);
    let hasil = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, String)> {
        let c = koneksi().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let ada: bool = c
            .query_row("SELECT COUNT(*) FROM accounts WHERE phone = ?1", rusqlite::params![hp], |r| r.get::<_, i64>(0))
            .map(|n| n > 0)
            .unwrap_or(false);
        if ada {
            return Err((StatusCode::CONFLICT, "This phone number is already registered — sign in instead.".into()));
        }
        let id = format!("a{}", acak_hex(6));
        let garam = acak_hex(12);
        let hash = pbkdf2(&d.sandi, &garam);
        c.execute(
            "INSERT INTO accounts (id, name, phone, pass_hash, salt, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, nama, hp, hash, garam, sekarang()],
        )
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let token = buat_sesi(&c, &id, &perangkat).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(json!({ "token": token, "id": id, "nama": nama, "hp": hp, "disetujui": false }))
    })
    .await;
    match hasil {
        Ok(Ok(v)) => {
            // Panel Class di Mac/tablet langsung menampilkan pendaftar baru.
            let _ = hub.tx.send(json!({ "t": "data", "kanal": "kelas", "payload": { "apa": "akun", "isi": {} } }).to_string());
            Json(v).into_response()
        }
        Ok(Err((s, e))) => (s, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct Masuk {
    pub hp: String,
    pub sandi: String,
}

pub async fn api_masuk_akun(State(_hub): State<Arc<Hub>>, headers: HeaderMap, Json(m): Json<Masuk>) -> Response {
    if kebanjiran(&headers) {
        return (StatusCode::TOO_MANY_REQUESTS, "Too many requests — slow down.").into_response();
    }
    let asal = alamat_klien(&headers);
    if diblokir(&asal) {
        return (StatusCode::TOO_MANY_REQUESTS, "Too many failed attempts. Try again in a few minutes.").into_response();
    }
    let hp = normalkan_hp(&m.hp);
    let perangkat = perangkat_dari(&headers);
    let hasil = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, String)> {
        let c = koneksi().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let baris: Option<(String, String, String, String, i64)> = c
            .query_row(
                "SELECT id, name, pass_hash, salt, approved FROM accounts WHERE phone = ?1",
                rusqlite::params![hp],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .ok();
        let Some((id, nama, hash, garam, disetujui)) = baris else {
            // Hitung hash palsu supaya waktu jawabnya sama dengan sandi salah.
            let _ = pbkdf2(&m.sandi, "garam-palsu");
            return Err((StatusCode::UNAUTHORIZED, "Phone number or password is wrong.".into()));
        };
        if !sama_tetap(&pbkdf2(&m.sandi, &garam), &hash) {
            return Err((StatusCode::UNAUTHORIZED, "Phone number or password is wrong.".into()));
        }
        let token = buat_sesi(&c, &id, &perangkat).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        // Peran ikut dikirim: akun guru pembantu dialihkan langsung ke editor.
        let peran: Option<String> = c
            .query_row("SELECT role FROM accounts WHERE id = ?1", rusqlite::params![id], |r| r.get(0))
            .ok()
            .flatten();
        Ok(json!({ "token": token, "id": id, "nama": nama, "hp": hp, "disetujui": disetujui != 0, "peran": peran }))
    })
    .await;
    match hasil {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err((s, e))) => {
            if s == StatusCode::UNAUTHORIZED {
                catat_gagal(&asal);
            }
            (s, e).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SesiUntuk {
    pub id: String,
}

/// Sesi murid atas permintaan aplikasi pendamping di Mac yang sama (Exact
/// Practice): murid yang bertanya dari halaman latihan mendapat layar Canvas
/// tertanam di halaman itu tanpa masuk lagi. Hanya untuk sambungan loopback
/// TANPA header proxy — permintaan lewat Cloudflare juga tiba dari 127.0.0.1
/// tetapi selalu membawa cf-connecting-ip — dan tetap harus membawa PIN.
/// Akun yang belum disetujui guru tidak diberi sesi.
pub async fn api_sesi_akun(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(s): Json<SesiUntuk>) -> Response {
    let lewat_proxy = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"].iter().any(|h| headers.contains_key(*h));
    let asal = headers.get("x-exact-asal").and_then(|v| v.to_str().ok()).unwrap_or("");
    let lokal = asal == "127.0.0.1" || asal == "::1";
    if lewat_proxy || !lokal || !sah(&hub, &headers, None) {
        return tolak();
    }
    let id = s.id.trim().to_string();
    if id.is_empty() {
        return (StatusCode::BAD_REQUEST, "id kosong").into_response();
    }
    let perangkat = format!("{} (Exact Practice)", perangkat_dari(&headers));
    let hasil = tokio::task::spawn_blocking(move || -> Result<Value, (StatusCode, String)> {
        let c = koneksi().map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        let baris: Option<(String, String, i64)> = c
            .query_row(
                "SELECT id, name, approved FROM accounts WHERE id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        let Some((id, nama, disetujui)) = baris else {
            return Err((StatusCode::NOT_FOUND, "Akun tidak ditemukan.".into()));
        };
        if disetujui == 0 {
            return Err((StatusCode::FORBIDDEN, "Akun belum disetujui guru.".into()));
        }
        let token = buat_sesi(&c, &id, &perangkat).map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e))?;
        Ok(json!({ "token": token, "id": id, "nama": nama, "disetujui": true }))
    })
    .await;
    match hasil {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err((s, e))) => (s, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Siapa pemilik sesi ini — juga untuk akun yang masih menunggu persetujuan,
/// supaya HP-nya bisa menunggu sambil bertanya berkala.
pub async fn api_saya_akun(State(_hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    let Some(token) = token_dari(&headers) else { return (StatusCode::UNAUTHORIZED, "No session.").into_response() };
    if token.len() < 16 {
        return (StatusCode::UNAUTHORIZED, "Session expired.").into_response();
    }
    let hasil = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let c = koneksi()?;
        let (id, nama, hp, disetujui, peran): (String, String, String, i64, Option<String>) = c
            .query_row(
                "SELECT a.id, a.name, a.phone, a.approved, a.role FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token = ?1",
                rusqlite::params![token],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .map_err(|_| "Session expired.".to_string())?;
        Ok(json!({ "id": id, "nama": nama, "hp": hp, "disetujui": disetujui != 0, "peran": peran }))
    })
    .await;
    match hasil {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => (StatusCode::UNAUTHORIZED, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn api_keluar(State(_hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    if let Some(token) = token_dari(&headers) {
        lupakan_sesi(&token);
        let _ = tokio::task::spawn_blocking(move || {
            if let Ok(c) = koneksi() {
                let _ = c.execute("DELETE FROM sessions WHERE token = ?1", rusqlite::params![token]);
            }
        })
        .await;
    }
    StatusCode::NO_CONTENT.into_response()
}

/* ── Admin ─────────────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct UbahPeran {
    pub id: String,
    pub guru: bool,
}

/// Hanya guru utama (admin): jadikan akun guru pembantu, atau cabut lagi.
pub async fn api_peran(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(u): Json<UbahPeran>) -> Response {
    if !sah(&hub, &headers, None) || !admin_sah(&hub, &headers, None) {
        return (StatusCode::UNAUTHORIZED, "Admin password required.").into_response();
    }
    let hasil = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let c = koneksi()?;
        c.execute(
            "UPDATE accounts SET role = ?1 WHERE id = ?2 AND approved = 1",
            rusqlite::params![if u.guru { Some("guru") } else { None }, u.id],
        )
        .map_err(|e| e.to_string())
    })
    .await;
    match hasil {
        Ok(Ok(0)) => (StatusCode::NOT_FOUND, "Account not found or not approved yet.").into_response(),
        Ok(Ok(_)) => {
            crate::server::siarkan(json!({ "t": "data", "kanal": "kelas" }).to_string());
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn api_daftar_akun(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    if !sah(&hub, &headers, None) || !admin_sah(&hub, &headers, None) {
        return (StatusCode::UNAUTHORIZED, "Admin password required.").into_response();
    }
    let hasil = tokio::task::spawn_blocking(|| -> Result<Value, String> {
        let c = koneksi()?;
        let mut st = c
            .prepare("SELECT id, name, phone, created_at, approved FROM accounts ORDER BY approved, name COLLATE NOCASE")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "nama": r.get::<_, String>(1)?, "hp": r.get::<_, String>(2)?, "dibuat": r.get::<_, i64>(3)?, "disetujui": r.get::<_, i64>(4)? != 0 })))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect::<Vec<_>>();
        Ok(Value::Array(rows))
    })
    .await;
    match hasil {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct Setujui {
    pub id: String,
    pub setuju: bool,
}

/// Guru menerima pendaftar (akun aktif) atau menolaknya (akun dihapus).
/// Tanpa persetujuan, siapa pun yang tahu PIN bisa mendaftar — jadi PIN
/// hanya membuka pintu depan; guru yang memutuskan siapa masuk kelas.
pub async fn api_setujui(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(s): Json<Setujui>) -> Response {
    if !sah(&hub, &headers, None) || !admin_sah(&hub, &headers, None) {
        return (StatusCode::UNAUTHORIZED, "Admin password required.").into_response();
    }
    let id = s.id.clone();
    let setuju = s.setuju;
    let hasil = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let c = koneksi()?;
        if setuju {
            c.execute("UPDATE accounts SET approved = 1 WHERE id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        } else {
            c.execute("DELETE FROM sessions WHERE account_id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
            c.execute("DELETE FROM accounts WHERE id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
            c.execute("DELETE FROM students WHERE id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await;
    kosongkan_cache_sesi();
    match hasil {
        Ok(Ok(())) => {
            let _ = hub.tx.send(json!({ "t": "data", "kanal": "kelas", "payload": { "apa": "akun", "isi": { "id": s.id, "setuju": setuju } } }).to_string());
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct Reset {
    pub id: String,
    pub sandi: String,
}

/// Guru mengganti sandi murid yang lupa; semua sesi lamanya dicabut.
pub async fn api_reset_sandi(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(r): Json<Reset>) -> Response {
    if !sah(&hub, &headers, None) || !admin_sah(&hub, &headers, None) {
        return (StatusCode::UNAUTHORIZED, "Admin password required.").into_response();
    }
    if r.sandi.chars().count() < 4 {
        return (StatusCode::BAD_REQUEST, "Password needs at least 4 characters.").into_response();
    }
    let hasil = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let c = koneksi()?;
        let garam = acak_hex(12);
        let hash = pbkdf2(&r.sandi, &garam);
        c.execute("UPDATE accounts SET pass_hash = ?1, salt = ?2 WHERE id = ?3", rusqlite::params![hash, garam, r.id]).map_err(|e| e.to_string())?;
        c.execute("DELETE FROM sessions WHERE account_id = ?1", rusqlite::params![r.id]).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    if let Ok(mut g) = CACHE_SESI.lock() {
        if let Some(p) = g.as_mut() {
            p.clear();
        }
    }
    match hasil {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

pub async fn api_hapus_akun(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !sah(&hub, &headers, None) || !admin_sah(&hub, &headers, None) {
        return (StatusCode::UNAUTHORIZED, "Admin password required.").into_response();
    }
    let hasil = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let c = koneksi()?;
        c.execute("DELETE FROM sessions WHERE account_id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        c.execute("DELETE FROM accounts WHERE id = ?1", rusqlite::params![id]).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    if let Ok(mut g) = CACHE_SESI.lock() {
        if let Some(p) = g.as_mut() {
            p.clear();
        }
    }
    match hasil {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}
