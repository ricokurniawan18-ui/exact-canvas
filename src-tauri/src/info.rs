//! Menu "My info" murid: jadwal les, nilai ulangan semester ini, agenda
//! (ulangan/tugas bertanggal) dan catatan — dari guru maupun milik murid.
//!
//! Agenda diisi murid (untuk dirinya) atau guru (untuk satu murid atau satu
//! grup). Catatan: guru menulis untuk murid, murid menulis catatannya sendiri;
//! keduanya saling bisa membaca. Pengingat agenda H-1 ada di push.rs.

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::kelas::koneksi;
use crate::server::Hub;

fn sekarang() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn id_baru(awalan: &str) -> String {
    format!("{awalan}_{:x}{}", sekarang(), &crate::kelas::acak_tiket()[..8])
}

fn kabari(hub: &Hub, apa: &str, isi: Value) {
    let _ = hub.tx.send(json!({ "t": "data", "kanal": "kelas", "payload": { "apa": apa, "isi": isi } }).to_string());
}

/// Murid yang sedang bertanya: dari sesi akunnya kalau ada, kalau tidak dari isian.
fn murid_dari(headers: &HeaderMap, isian: Option<&str>) -> Option<String> {
    headers
        .get("x-exact-sesi")
        .and_then(|v| v.to_str().ok())
        .and_then(crate::akun::akun_dari_sesi)
        .or_else(|| isian.map(|s| s.to_string()))
        .filter(|m| !m.trim().is_empty())
}

fn tanggal_sah(t: &str) -> bool {
    chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d").is_ok()
}

fn jawab(hasil: Result<Result<Value, String>, tokio::task::JoinError>) -> Response {
    match hasil {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Nama guru yang menulis: akun guru pembantu, atau nama guru utama dari setelan.
fn nama_penulis_guru(c: &rusqlite::Connection, headers: &HeaderMap) -> String {
    if let Some((_, nama)) = crate::akun::guru_dari_headers(headers, None) {
        return nama;
    }
    c.query_row("SELECT value FROM settings WHERE key = 'nama_guru'", [], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Mr. Rico".into())
}

/* ── Baca ──────────────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct QueryInfo {
    pub murid: String,
    pub pin: Option<String>,
    pub sesi: Option<String>,
}

pub async fn api_info(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<QueryInfo>) -> Response {
    if !crate::server::sah_lengkap(&hub, &headers, q.pin.as_deref(), q.sesi.as_deref(), None) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(murid) = murid_dari(&headers, Some(&q.murid)) else {
        return (StatusCode::BAD_REQUEST, "Student not specified.").into_response();
    };
    jawab(
        tokio::task::spawn_blocking(move || -> Result<Value, String> {
            let c = koneksi()?;
            let jadwal: Option<String> = c
                .query_row("SELECT schedule FROM students WHERE id = ?1", rusqlite::params![murid], |r| r.get(0))
                .ok()
                .flatten();
            let jadwal: Value = jadwal.as_deref().and_then(|j| serde_json::from_str(j).ok()).unwrap_or(Value::Null);

            let mut st = c
                .prepare("SELECT subject, test, score, test_date, created_at FROM score_reports WHERE student_id = ?1 ORDER BY COALESCE(NULLIF(test_date, ''), created_at) DESC, created_at DESC LIMIT 200")
                .map_err(|e| e.to_string())?;
            let nilai: Vec<Value> = st
                .query_map(rusqlite::params![murid], |r| {
                    Ok(json!({ "mapel": r.get::<_, Option<String>>(0)?, "ujian": r.get::<_, Option<String>>(1)?, "nilai": r.get::<_, String>(2)?, "tanggal": r.get::<_, Option<String>>(3)?, "dibuat": r.get::<_, i64>(4)? }))
                })
                .map_err(|e| e.to_string())?
                .flatten()
                .collect();

            // Agenda: milik murid ini dan milik grupnya, dari 2 minggu lalu ke depan.
            let sejak = (chrono::Local::now().date_naive() - chrono::Duration::days(14)).format("%Y-%m-%d").to_string();
            let mut st = c
                .prepare(
                    "SELECT a.id, a.date, a.kind, a.subject, a.text, a.created_by, a.author_name, a.group_id, g.name
                     FROM agenda a LEFT JOIN groups g ON g.id = a.group_id
                     WHERE (a.student_id = ?1 OR a.group_id IN (SELECT group_id FROM group_members WHERE student_id = ?1))
                       AND a.date >= ?2
                     ORDER BY a.date ASC, a.created_at ASC LIMIT 300",
                )
                .map_err(|e| e.to_string())?;
            let agenda: Vec<Value> = st
                .query_map(rusqlite::params![murid, sejak], |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?, "tanggal": r.get::<_, String>(1)?, "jenis": r.get::<_, String>(2)?,
                        "mapel": r.get::<_, Option<String>>(3)?, "teks": r.get::<_, Option<String>>(4)?,
                        "oleh": r.get::<_, String>(5)?, "penulis": r.get::<_, Option<String>>(6)?,
                        "grup": r.get::<_, Option<String>>(8)?,
                    }))
                })
                .map_err(|e| e.to_string())?
                .flatten()
                .collect();

            let mut st = c
                .prepare("SELECT id, author, author_name, text, created_at FROM notes WHERE student_id = ?1 ORDER BY created_at DESC LIMIT 200")
                .map_err(|e| e.to_string())?;
            let catatan: Vec<Value> = st
                .query_map(rusqlite::params![murid], |r| {
                    Ok(json!({ "id": r.get::<_, String>(0)?, "oleh": r.get::<_, String>(1)?, "penulis": r.get::<_, Option<String>>(2)?, "teks": r.get::<_, String>(3)?, "dibuat": r.get::<_, i64>(4)? }))
                })
                .map_err(|e| e.to_string())?
                .flatten()
                .collect();
            Ok(json!({ "jadwal": jadwal, "nilai": nilai, "agenda": agenda, "catatan": catatan }))
        })
        .await,
    )
}

/* ── Agenda ────────────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct AgendaBaru {
    #[serde(default)]
    pub murid: Option<String>,
    /// Hanya guru: agenda untuk satu grup.
    #[serde(default)]
    pub grup: Option<String>,
    pub tanggal: String,
    /// 'ulangan' | 'tugas' | 'lain'
    pub jenis: String,
    #[serde(default)]
    pub mapel: String,
    #[serde(default)]
    pub teks: String,
}

pub async fn api_agenda(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(a): Json<AgendaBaru>) -> Response {
    if !crate::server::sah(&hub, &headers, None) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let guru = crate::server::guru_sah(&hub, &headers, None, None);
    if !tanggal_sah(&a.tanggal) {
        return (StatusCode::BAD_REQUEST, "Choose a date.").into_response();
    }
    let jenis = match a.jenis.as_str() {
        "ulangan" | "tugas" | "lain" => a.jenis.clone(),
        _ => return (StatusCode::BAD_REQUEST, "Unknown type.").into_response(),
    };
    let (murid, grup) = if guru {
        (a.murid.clone().filter(|m| !m.is_empty()), a.grup.clone().filter(|g| !g.is_empty()))
    } else {
        (murid_dari(&headers, a.murid.as_deref()), None)
    };
    if murid.is_none() == grup.is_none() {
        return (StatusCode::BAD_REQUEST, "Choose one student or one group.").into_response();
    }
    let mapel: String = a.mapel.trim().chars().take(40).collect();
    let teks: String = a.teks.trim().chars().take(300).collect();
    if mapel.is_empty() && teks.is_empty() {
        return (StatusCode::BAD_REQUEST, "Write the subject or what it is about.").into_response();
    }
    let h2 = headers.clone();
    let hasil = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let c = koneksi()?;
        if !guru {
            let jumlah: i64 = c
                .query_row("SELECT COUNT(*) FROM agenda WHERE student_id = ?1 AND created_by = 'murid' AND date >= date('now', '-1 day')", rusqlite::params![murid], |r| r.get(0))
                .unwrap_or(0);
            if jumlah >= 60 {
                return Err("Your agenda is full — delete old items first.".into());
            }
        }
        let penulis = if guru { nama_penulis_guru(&c, &h2) } else { String::new() };
        let id = id_baru("agd");
        c.execute(
            "INSERT INTO agenda (id, student_id, group_id, date, kind, subject, text, created_by, author_name, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![id, murid, grup, a.tanggal, jenis, mapel, teks, if guru { "guru" } else { "murid" }, if guru { Some(penulis) } else { None }, sekarang()],
        )
        .map_err(|e| e.to_string())?;
        Ok(json!({ "id": id, "murid": murid, "grup": grup }))
    })
    .await;
    if let Ok(Ok(v)) = &hasil {
        kabari(&hub, "agenda", v.clone());
    }
    jawab(hasil)
}

#[derive(Deserialize)]
pub struct HapusInfo {
    pub id: String,
    #[serde(default)]
    pub murid: Option<String>,
}

/// Guru menghapus apa saja; murid hanya agenda/catatan yang ia tulis sendiri.
async fn hapus(hub: Arc<Hub>, headers: HeaderMap, h: HapusInfo, tabel: &'static str, kolom_penulis: &'static str) -> Response {
    if !crate::server::sah(&hub, &headers, None) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let guru = crate::server::guru_sah(&hub, &headers, None, None);
    let murid = murid_dari(&headers, h.murid.as_deref());
    let hasil = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let c = koneksi()?;
        let n = if guru {
            c.execute(&format!("DELETE FROM {tabel} WHERE id = ?1"), rusqlite::params![h.id])
        } else {
            c.execute(
                &format!("DELETE FROM {tabel} WHERE id = ?1 AND student_id = ?2 AND {kolom_penulis} = 'murid'"),
                rusqlite::params![h.id, murid],
            )
        }
        .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("You can only delete what you wrote yourself.".into());
        }
        Ok(json!({ "id": h.id }))
    })
    .await;
    if let Ok(Ok(v)) = &hasil {
        kabari(&hub, tabel, v.clone());
    }
    jawab(hasil)
}

pub async fn api_hapus_agenda(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(h): Json<HapusInfo>) -> Response {
    hapus(hub, headers, h, "agenda", "created_by").await
}

/* ── Catatan ───────────────────────────────────────────────────────── */

#[derive(Deserialize)]
pub struct CatatanBaru {
    pub murid: String,
    pub teks: String,
}

pub async fn api_catatan(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(n): Json<CatatanBaru>) -> Response {
    if !crate::server::sah(&hub, &headers, None) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let guru = crate::server::guru_sah(&hub, &headers, None, None);
    let murid = if guru { Some(n.murid.clone()).filter(|m| !m.is_empty()) } else { murid_dari(&headers, Some(&n.murid)) };
    let Some(murid) = murid else {
        return (StatusCode::BAD_REQUEST, "Student not specified.").into_response();
    };
    let teks: String = n.teks.trim().chars().take(1000).collect();
    if teks.is_empty() {
        return (StatusCode::BAD_REQUEST, "Write something first.").into_response();
    }
    let h2 = headers.clone();
    let hasil = tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let c = koneksi()?;
        let penulis: Option<String> = if guru {
            Some(nama_penulis_guru(&c, &h2))
        } else {
            c.query_row("SELECT name FROM students WHERE id = ?1", rusqlite::params![murid], |r| r.get(0)).ok()
        };
        let id = id_baru("ctt");
        c.execute(
            "INSERT INTO notes (id, student_id, author, author_name, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, murid, if guru { "guru" } else { "murid" }, penulis, teks, sekarang()],
        )
        .map_err(|e| e.to_string())?;
        Ok(json!({ "id": id, "murid": murid, "guru": guru }))
    })
    .await;
    if let Ok(Ok(v)) = &hasil {
        kabari(&hub, "catatan", v.clone());
        // Catatan baru dari guru: HP murid diberi tahu walau terkunci.
        if v["guru"] == true {
            if let Some(m) = v["murid"].as_str() {
                crate::push::kirim_latar(Some(m.to_string()), "📝 Catatan baru dari guru".into(), "Buka Exact Canvas → 📒 My info → Notes.".into(), "catatan".into(), "/tv?murid=1&info=catatan".into());
            }
        }
    }
    jawab(hasil)
}

pub async fn api_hapus_catatan(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(h): Json<HapusInfo>) -> Response {
    hapus(hub, headers, h, "notes", "author").await
}
