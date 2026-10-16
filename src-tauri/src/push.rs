//! Notifikasi Web Push: tetap sampai ke HP murid dan tablet guru walau
//! layarnya terkunci dan aplikasinya ditutup.
//!
//! - Pengingat les 1 jam sebelum jadwal (`students.schedule`, {"Mon":"16:00"}).
//! - Ringkasan harian untuk perangkat guru: siapa saja les hari ini.
//! - "Kamu dipanggil ke meja guru" dan "pertanyaanmu sedang dibahas".
//!
//! Enkripsi isi pesan mengikuti RFC 8291 (aes128gcm) dan otorisasi VAPID
//! (RFC 8292). Kirimannya lewat `/usr/bin/curl` bawaan macOS — aplikasi ini
//! tidak membawa pustaka TLS sendiri, dan pesannya cuma beberapa per hari.

use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use chrono::{Datelike, Timelike};
use hkdf::Hkdf;
use p256::ecdsa::signature::Signer;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;

use crate::kelas::koneksi;
use crate::server::Hub;

/// Kunci VAPID disimpan sebagai berkas di vault, BUKAN di tabel settings:
/// guru pembantu boleh membaca settings lewat jembatan SQL.
fn berkas_kunci() -> std::path::PathBuf {
    crate::vault::root().join("push-vapid.key")
}

fn kunci_vapid() -> Result<p256::SecretKey, String> {
    let p = berkas_kunci();
    if let Ok(isi) = std::fs::read(&p) {
        if let Ok(k) = p256::SecretKey::from_slice(&isi) {
            return Ok(k);
        }
    }
    let mut acak = [0u8; 32];
    loop {
        getrandom::getrandom(&mut acak).map_err(|e| e.to_string())?;
        if let Ok(k) = p256::SecretKey::from_slice(&acak) {
            std::fs::write(&p, k.to_bytes()).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
            }
            return Ok(k);
        }
    }
}

fn publik_vapid() -> Result<String, String> {
    let k = kunci_vapid()?;
    Ok(B64.encode(k.public_key().to_encoded_point(false).as_bytes()))
}

/* ── Enkripsi (RFC 8291) ───────────────────────────────────────────── */

fn enkripsi(p256dh: &str, auth: &str, isi: &[u8]) -> Result<Vec<u8>, String> {
    let ua_publik = B64.decode(p256dh.trim_end_matches('=')).map_err(|_| "p256dh")?;
    let rahasia_auth = B64.decode(auth.trim_end_matches('=')).map_err(|_| "auth")?;
    let ua = p256::PublicKey::from_sec1_bytes(&ua_publik).map_err(|_| "kunci HP tidak sah")?;

    let mut acak = [0u8; 32];
    let as_rahasia = loop {
        getrandom::getrandom(&mut acak).map_err(|e| e.to_string())?;
        if let Ok(k) = p256::SecretKey::from_slice(&acak) {
            break k;
        }
    };
    let as_publik = as_rahasia.public_key().to_encoded_point(false);
    let bersama = p256::ecdh::diffie_hellman(as_rahasia.to_nonzero_scalar(), ua.as_affine());

    let mut info_kunci = b"WebPush: info\0".to_vec();
    info_kunci.extend_from_slice(&ua_publik);
    info_kunci.extend_from_slice(as_publik.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&rahasia_auth), bersama.raw_secret_bytes())
        .expand(&info_kunci, &mut ikm)
        .map_err(|_| "hkdf")?;

    let mut garam = [0u8; 16];
    getrandom::getrandom(&mut garam).map_err(|e| e.to_string())?;
    let prk = Hkdf::<Sha256>::new(Some(&garam), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).map_err(|_| "hkdf")?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce).map_err(|_| "hkdf")?;

    let mut polos = isi.to_vec();
    polos.push(2); // pembatas rekaman terakhir
    let sandi = aes_gcm::Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| "aes")?
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), polos.as_ref())
        .map_err(|_| "aes")?;

    let mut badan = Vec::with_capacity(86 + sandi.len());
    badan.extend_from_slice(&garam);
    badan.extend_from_slice(&4096u32.to_be_bytes());
    badan.push(65);
    badan.extend_from_slice(as_publik.as_bytes());
    badan.extend_from_slice(&sandi);
    Ok(badan)
}

/// JWT VAPID (ES256) untuk asal (origin) layanan push tujuan.
fn jwt_vapid(endpoint: &str) -> Result<String, String> {
    let asal = {
        let tanpa = endpoint.split("://").nth(1).ok_or("endpoint")?;
        let host = tanpa.split('/').next().ok_or("endpoint")?;
        format!("https://{host}")
    };
    let exp = chrono::Utc::now().timestamp() + 12 * 3600;
    let kepala = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let klaim = B64.encode(json!({ "aud": asal, "exp": exp, "sub": "https://meet2.exactprintsolution.com" }).to_string());
    let data = format!("{kepala}.{klaim}");
    let k = p256::ecdsa::SigningKey::from(kunci_vapid()?);
    let tt: p256::ecdsa::Signature = k.sign(data.as_bytes());
    Ok(format!("{data}.{}", B64.encode(tt.to_bytes())))
}

/// Kirim satu pesan. `Ok(false)` = langganan sudah tidak berlaku (hapus).
fn kirim_satu(endpoint: &str, p256dh: &str, auth: &str, isi: &Value) -> Result<bool, String> {
    if !endpoint.starts_with("https://") {
        return Ok(false);
    }
    let badan = enkripsi(p256dh, auth, isi.to_string().as_bytes())?;
    let otorisasi = format!("vapid t={}, k={}", jwt_vapid(endpoint)?, publik_vapid()?);
    let mut anak = std::process::Command::new("/usr/bin/curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "20", "-X", "POST"])
        .args(["-H", "Content-Encoding: aes128gcm", "-H", "Content-Type: application/octet-stream"])
        .args(["-H", "TTL: 3600", "-H", "Urgency: high"])
        .args(["-H", &format!("Authorization: {otorisasi}")])
        .args(["--data-binary", "@-", endpoint])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        anak.stdin.take().ok_or("stdin")?.write_all(&badan).map_err(|e| e.to_string())?;
    }
    let keluar = anak.wait_with_output().map_err(|e| e.to_string())?;
    let kode: u16 = String::from_utf8_lossy(&keluar.stdout).trim().parse().unwrap_or(0);
    match kode {
        200..=299 => Ok(true),
        404 | 410 => Ok(false),
        _ => Err(format!("layanan push menjawab {kode}")),
    }
}

/// Kirim ke semua perangkat yang cocok. `murid` = Some(id) → HP murid itu;
/// None → semua perangkat guru.
pub fn kirim(murid: Option<&str>, judul: &str, isi: &str, tag: &str, url: &str) {
    let Ok(c) = koneksi() else { return };
    let baris: Vec<(String, String, String)> = {
        let (sql, p): (&str, Vec<String>) = match murid {
            Some(m) => ("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE student_id = ?1", vec![m.to_string()]),
            None => ("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE role = 'guru'", vec![]),
        };
        let Ok(mut st) = c.prepare(sql) else { return };
        st.query_map(rusqlite::params_from_iter(p.iter()), |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map(|it| it.flatten().collect())
            .unwrap_or_default()
    };
    let pesan = json!({ "judul": judul, "isi": isi, "tag": tag, "url": url });
    for (ep, k, a) in baris {
        match kirim_satu(&ep, &k, &a, &pesan) {
            Ok(true) => {}
            Ok(false) => {
                let _ = c.execute("DELETE FROM push_subscriptions WHERE endpoint = ?1", rusqlite::params![ep]);
            }
            Err(e) => eprintln!("push: {e}"),
        }
    }
}

/// Versi async untuk dipanggil dari handler: tidak menahan jawaban HTTP.
pub fn kirim_latar(murid: Option<String>, judul: String, isi: String, tag: String, url: String) {
    tokio::task::spawn_blocking(move || kirim(murid.as_deref(), &judul, &isi, &tag, &url));
}

/// "Pertanyaanmu sedang dibahas" — sekali per pertanyaan (membuka lagi
/// kanvasnya tidak membunyikan HP murid berulang-ulang).
pub fn kirim_bahas(murid: String, id_tanya: String) {
    tokio::task::spawn_blocking(move || {
        let Ok(c) = koneksi() else { return };
        if tandai_sekali(&c, &format!("bahas|{id_tanya}")) {
            kirim(Some(&murid), "✏️ Pertanyaanmu sedang dibahas", "Buka Exact Canvas dan lihat papan guru.", "bahas", "/tv?murid=1");
        }
    });
}

/* ── API ───────────────────────────────────────────────────────────── */

pub async fn api_kunci() -> Response {
    match tokio::task::spawn_blocking(publik_vapid).await {
        Ok(Ok(k)) => Json(json!({ "kunci": k })).into_response(),
        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

#[derive(Deserialize)]
pub struct Daftar {
    /// Id murid (layar murid); kosong untuk perangkat guru.
    #[serde(default)]
    pub murid: Option<String>,
    /// 'murid' | 'guru'
    pub peran: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

pub async fn api_daftar(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(d): Json<Daftar>) -> Response {
    if !crate::server::sah(&hub, &headers, None) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let guru = d.peran == "guru";
    if guru && !crate::server::guru_sah(&hub, &headers, None, None) {
        return (StatusCode::UNAUTHORIZED, "Admin password required.").into_response();
    }
    // Murid yang masuk dengan akun: id-nya dari sesi, bukan dari isian.
    let murid = if guru {
        None
    } else {
        let dari_sesi = headers.get("x-exact-sesi").and_then(|v| v.to_str().ok()).and_then(crate::akun::akun_dari_sesi);
        dari_sesi.or(d.murid.clone()).filter(|m| !m.is_empty())
    };
    if !guru && murid.is_none() {
        return (StatusCode::BAD_REQUEST, "Student not specified.").into_response();
    }
    if !d.endpoint.starts_with("https://") || d.endpoint.len() > 1000 || d.p256dh.len() > 200 || d.auth.len() > 100 {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let hasil = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let c = koneksi()?;
        c.execute(
            "INSERT INTO push_subscriptions (endpoint, student_id, role, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(endpoint) DO UPDATE SET student_id = ?2, role = ?3, p256dh = ?4, auth = ?5",
            rusqlite::params![d.endpoint, murid, if guru { "guru" } else { "murid" }, d.p256dh, d.auth, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await;
    match hasil {
        Ok(Ok(())) => Json(json!({ "ok": true })).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
pub struct Hapus {
    pub endpoint: String,
}

pub async fn api_hapus(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(h): Json<Hapus>) -> Response {
    if !crate::server::sah(&hub, &headers, None) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let _ = tokio::task::spawn_blocking(move || {
        koneksi().map(|c| c.execute("DELETE FROM push_subscriptions WHERE endpoint = ?1", rusqlite::params![h.endpoint]))
    })
    .await;
    Json(json!({ "ok": true })).into_response()
}

/* ── Pengingat les ─────────────────────────────────────────────────── */

const HARI: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/// Pengingat dikirim sejak 60 menit sebelum les sampai les dimulai (kalau
/// Mac baru menyala di tengah jendela itu, tetap terkirim sekali).
const SEBELUM_MENIT: i64 = 60;
/// Ringkasan untuk guru: sejak jam ini, sekali sehari.
const JAM_RINGKASAN: u32 = 7;
/// Pengingat agenda (ulangan/tugas) H-1: sejak jam ini.
const JAM_AGENDA: u32 = 18;

/// Agenda pada satu tanggal, satu baris per murid penerima (agenda grup
/// dipecah ke anggotanya): (id agenda, murid, judul, isi, untuk-siapa).
/// `untuk-siapa` = nama murid, atau nama grup untuk agenda grup.
fn agenda_pada(c: &rusqlite::Connection, tanggal: &str) -> Vec<(String, String, String, String, String)> {
    let Ok(mut st) = c.prepare(
        "SELECT a.id, s.id, s.name, a.kind, a.subject, a.text FROM agenda a
           JOIN students s ON s.id = a.student_id WHERE a.date = ?1
         UNION ALL
         SELECT a.id, s.id, g.name, a.kind, a.subject, a.text FROM agenda a
           JOIN groups g ON g.id = a.group_id
           JOIN group_members gm ON gm.group_id = a.group_id
           JOIN students s ON s.id = gm.student_id WHERE a.date = ?1",
    ) else {
        return Vec::new();
    };
    st.query_map(rusqlite::params![tanggal], |r| {
        let (id, murid, untuk, jenis): (String, String, String, String) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
        let (mapel, teks): (Option<String>, Option<String>) = (r.get(4)?, r.get(5)?);
        let label = match jenis.as_str() {
            "ulangan" => "Ulangan",
            "tugas" => "Tugas",
            _ => "Agenda",
        };
        let judul = format!("{label} {}", mapel.unwrap_or_default()).trim().to_string();
        let isi = teks.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Jangan lupa disiapkan ya!".into());
        Ok((id, murid, judul, isi, untuk))
    })
    .map(|it| it.flatten().collect())
    .unwrap_or_default()
}

/// "16:00" / "16.00" / "4:30" → menit sejak tengah malam.
fn menit_dari(teks: &str) -> Option<i64> {
    let t = teks.trim().replace('.', ":");
    let (j, m) = t.split_once(':').unwrap_or((t.as_str(), "0"));
    let j: i64 = j.trim().parse().ok()?;
    let m: i64 = m.trim().get(..2.min(m.trim().len()))?.parse().ok()?;
    ((0..24).contains(&j) && (0..60).contains(&m)).then_some(j * 60 + m)
}

/// Sudah pernah dikirim? Kalau belum, tandai — atomik lewat PRIMARY KEY.
fn tandai_sekali(c: &rusqlite::Connection, kunci: &str) -> bool {
    c.execute("INSERT OR IGNORE INTO push_sent (key, sent_at) VALUES (?1, ?2)", rusqlite::params![kunci, chrono::Utc::now().timestamp_millis()])
        .map(|n| n == 1)
        .unwrap_or(false)
}

fn periksa_jadwal() {
    let Ok(c) = koneksi() else { return };
    let kini = chrono::Local::now();
    let hari = HARI[kini.weekday().num_days_from_monday() as usize];
    let tanggal = kini.format("%Y-%m-%d").to_string();
    let menit_kini = (kini.hour() * 60 + kini.minute()) as i64;

    let murid: Vec<(String, String, String)> = c
        .prepare("SELECT id, name, schedule FROM students WHERE schedule IS NOT NULL AND schedule != ''")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|it| it.flatten().collect()))
        .unwrap_or_default();

    let mut hari_ini: Vec<(i64, String)> = Vec::new();
    for (id, nama, jadwal) in murid {
        let Ok(j) = serde_json::from_str::<serde_json::Map<String, Value>>(&jadwal) else { continue };
        let Some(jam) = j.get(hari).and_then(|v| v.as_str()).and_then(menit_dari) else { continue };
        hari_ini.push((jam, nama.clone()));
        if menit_kini >= jam - SEBELUM_MENIT && menit_kini < jam && tandai_sekali(&c, &format!("les|{id}|{tanggal}|{jam}")) {
            let teks_jam = format!("{:02}:{:02}", jam / 60, jam % 60);
            kirim(Some(&id), "📚 Les hari ini", &format!("Les Exact Course jam {teks_jam} — {} menit lagi. Siapkan bukumu!", jam - menit_kini), "les", "/tv?murid=1");
        }
    }

    // Agenda (ulangan/tugas) BESOK: diingatkan sejak 18:00, sekali per murid.
    let besok = (kini.date_naive() + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
    if menit_kini >= (JAM_AGENDA * 60) as i64 {
        for (id, murid, judul, isi, _) in agenda_pada(&c, &besok) {
            if tandai_sekali(&c, &format!("agenda|{id}|{murid}")) {
                kirim(Some(&murid), &format!("📌 Besok: {judul}"), &isi, &format!("agenda-{id}"), "/tv?murid=1&info=agenda");
            }
        }
    }

    // Ringkasan guru: sekali sehari sejak 07:00 (sebelum les pertama dimulai) —
    // les hari ini dan ulangan/tugas murid yang jatuh hari ini.
    hari_ini.sort();
    let agenda_kini: Vec<String> = {
        let mut terlihat = std::collections::HashSet::new();
        agenda_pada(&c, &tanggal)
            .into_iter()
            .filter(|(id, ..)| terlihat.insert(id.clone()))
            .map(|(_, _, judul, _, untuk)| format!("{judul} ({untuk})"))
            .collect()
    };
    let sebelum_les = hari_ini.first().map(|(m, _)| menit_kini < *m).unwrap_or(true);
    if (!hari_ini.is_empty() || !agenda_kini.is_empty())
        && menit_kini >= (JAM_RINGKASAN * 60) as i64
        && menit_kini < 20 * 60
        && sebelum_les
        && tandai_sekali(&c, &format!("ringkasan|{tanggal}"))
    {
        let mut bagian: Vec<String> = Vec::new();
        if !hari_ini.is_empty() {
            let les: Vec<String> = hari_ini.iter().map(|(m, n)| format!("{n} {:02}:{:02}", m / 60, m % 60)).collect();
            bagian.push(format!("Les: {}", les.join(", ")));
        }
        if !agenda_kini.is_empty() {
            bagian.push(format!("Hari ini: {}", agenda_kini.join("; ")));
        }
        kirim(None, &format!("📚 Hari ini: {} les, {} agenda", hari_ini.len(), agenda_kini.len()), &bagian.join(" · "), "ringkasan-les", "/admin");
    }
    // Catatan kiriman lebih dari 3 hari dibuang.
    let _ = c.execute("DELETE FROM push_sent WHERE sent_at < ?1", rusqlite::params![chrono::Utc::now().timestamp_millis() - 3 * 86_400_000]);
}

/// Dijalankan sekali saat server menyala: memeriksa jadwal tiap menit.
pub fn mulai_pengingat() {
    tauri::async_runtime::spawn(async {
        loop {
            tokio::task::spawn_blocking(periksa_jadwal).await.ok();
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}

#[cfg(test)]
mod uji {
    use super::*;

    #[test]
    fn jam() {
        assert_eq!(menit_dari("16:00"), Some(960));
        assert_eq!(menit_dari("16.30"), Some(990));
        assert_eq!(menit_dari("8"), Some(480));
        assert_eq!(menit_dari(""), None);
        assert_eq!(menit_dari("25:00"), None);
    }

    /// Hasil enkripsi bisa dibuka kembali oleh "HP" (kebalikan RFC 8291).
    #[test]
    fn enkripsi_bolak_balik() {
        let ua = p256::SecretKey::from_slice(&[7u8; 32]).unwrap();
        let ua_pub = ua.public_key().to_encoded_point(false);
        let auth = [9u8; 16];
        let badan = enkripsi(&B64.encode(ua_pub.as_bytes()), &B64.encode(auth), b"halo").unwrap();
        let (garam, sisa) = badan.split_at(16);
        assert_eq!(&sisa[..4], &4096u32.to_be_bytes());
        assert_eq!(sisa[4], 65);
        let as_pub = p256::PublicKey::from_sec1_bytes(&sisa[5..70]).unwrap();
        let sandi = &sisa[70..];
        let bersama = p256::ecdh::diffie_hellman(ua.to_nonzero_scalar(), as_pub.as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(ua_pub.as_bytes());
        info.extend_from_slice(&sisa[5..70]);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&auth), bersama.raw_secret_bytes()).expand(&info, &mut ikm).unwrap();
        let prk = Hkdf::<Sha256>::new(Some(garam), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek).unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce).unwrap();
        let polos = aes_gcm::Aes128Gcm::new_from_slice(&cek).unwrap().decrypt(aes_gcm::Nonce::from_slice(&nonce), sandi).unwrap();
        assert_eq!(polos, b"halo\x02");
    }

    #[test]
    fn jwt_terverifikasi() {
        // Satu folder vault uji untuk semua tes (variabel lingkungan dipakai bersama antar-thread).
        std::env::set_var("EXACT_CANVAS_VAULT", std::env::temp_dir().join("uji-exact-vault"));
        let _ = std::fs::create_dir_all(std::env::temp_dir().join("uji-exact-vault"));
        let t = jwt_vapid("https://fcm.googleapis.com/fcm/send/abc").unwrap();
        let bagian: Vec<&str> = t.split('.').collect();
        let klaim: Value = serde_json::from_slice(&B64.decode(bagian[1]).unwrap()).unwrap();
        assert_eq!(klaim["aud"], "https://fcm.googleapis.com");
        use p256::ecdsa::signature::Verifier;
        let vk = p256::ecdsa::VerifyingKey::from_sec1_bytes(&B64.decode(publik_vapid().unwrap()).unwrap()).unwrap();
        let tt = p256::ecdsa::Signature::from_slice(&B64.decode(bagian[2]).unwrap()).unwrap();
        vk.verify(format!("{}.{}", bagian[0], bagian[1]).as_bytes(), &tt).unwrap();
    }
}
