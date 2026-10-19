//! Berbagi di jaringan.
//!
//! Aplikasi ini menjadi server kecil di Wi-Fi: TV membuka `/tv` di browsernya
//! sebagai layar pengikut, tablet membuka `/` sebagai editor. Semua data tetap
//! di vault Mac — klien lain hanya jendela ke sana lewat API kecil, dan
//! peristiwa langsung (pandangan, goresan yang sedang ditarik) diteruskan
//! apa adanya lewat satu hub WebSocket: server tidak menafsirkan isinya,
//! cuma menyiarkan ke semua klien lain.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::{IpAddr, SocketAddr, TcpListener as StdTcpListener, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Path, Query, Request, State,
    },
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::AppHandle;
use tokio::sync::{broadcast, oneshot};

use crate::vault;

const PORT_AWAL: u16 = 4747;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Klien {
    pub id: String,
    pub nama: String,
    pub peran: String,
    /// Id murid untuk HP yang masuk dengan nama; kosong untuk TV dan editor.
    pub murid: String,
    /// Halaman masih di depan mata (lampu hijau) atau disembunyikan (kuning/merah).
    pub fokus: bool,
    /// Berapa kali meninggalkan halaman sejak tersambung.
    pub keluar: i64,
    /// Murid sengaja meredupkan/mengunci HP sambil menunggu giliran — bukan kabur.
    pub tunggu: bool,
    /// Id akun guru pembantu untuk editor yang masuk lewat akun ber-peran guru;
    /// kosong untuk guru utama (sandi admin / aplikasi Mac), TV, dan murid.
    pub guru: String,
}

pub struct Hub {
    pub pin: String,
    pub port: u16,
    /// Rahasia per proses yang hanya diketahui aplikasi Mac ini sendiri; ia
    /// memberi hak admin tanpa kata sandi untuk panggilan dari aplikasi.
    pub token_app: String,
    /// Penanda proses server ini. Klien yang melihatnya berganti tahu bahwa
    /// aplikasi Mac dibuka ulang — mungkin dengan versi baru — dan memuat
    /// ulang halamannya sendiri.
    pub token: String,
    pub tx: broadcast::Sender<String>,
    pub klien: Mutex<Vec<Klien>>,
    pub app: AppHandle,
}

struct Aktif {
    hub: Arc<Hub>,
    matikan: Option<oneshot::Sender<()>>,
}

static BERBAGI: Mutex<Option<Aktif>> = Mutex::new(None);

/// Kirim satu pesan ke semua klien yang tersambung — kalau sedang berbagi;
/// kalau tidak, pesannya cuma dibuang. Untuk pekerjaan latar di luar server
/// (mis. hapus otomatis kanvas lama) yang perlu mengabari layar lain.
pub fn siarkan(teks: String) {
    if let Some(a) = BERBAGI.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = a.hub.tx.send(teks);
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InfoBerbagi {
    pub url: String,
    pub url_tv: String,
    pub url_murid: String,
    /// Alamat Wi-Fi lokal, selalu ada — cadangan kalau internet mati.
    pub url_lokal: String,
    /// Alamat publik yang sedang dipakai, kalau ada.
    pub publik: Option<String>,
    /// Token admin internal untuk aplikasi ini sendiri.
    pub token_app: String,
    /// Kata sandi admin sudah disetel — editor lewat web bisa dibuka.
    pub admin_diset: bool,
    pub pin: String,
    pub port: u16,
    pub ip: String,
    pub klien: Vec<Klien>,
}

/* ── Alamat ────────────────────────────────────────────────────────── */

/// IP Mac ini di jaringan lokal.
///
/// Trik soket UDP: "menyambung" ke alamat luar tidak mengirim apa pun, tapi
/// memaksa sistem memilih antarmuka keluar — itulah IP yang dilihat TV.
/// Tanpa jalur ke luar (Wi-Fi tanpa internet), jatuh ke `ipconfig`.
fn ip_lokal() -> String {
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        if s.connect("8.8.8.8:80").is_ok() {
            if let Ok(a) = s.local_addr() {
                if !a.ip().is_loopback() {
                    return a.ip().to_string();
                }
            }
        }
    }
    for iface in ["en0", "en1", "en2", "en3"] {
        if let Ok(o) = std::process::Command::new("/usr/sbin/ipconfig")
            .args(["getifaddr", iface])
            .output()
        {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    "127.0.0.1".into()
}

fn pin_acak() -> String {
    // Empat digit dari nanodetik sekarang — bukan kriptografi, cuma pagar
    // supaya tetangga yang menebak alamatnya tidak langsung masuk.
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(1234);
    format!("{:04}", (n % 9000) + 1000)
}

fn info(hub: &Hub) -> InfoBerbagi {
    let ip = ip_lokal();
    let publik = ALAMAT_PUBLIK.lock().ok().and_then(|a| a.clone());
    let dasar = publik.clone().unwrap_or_else(|| format!("http://{ip}:{}", hub.port));
    InfoBerbagi {
        // Editor (tablet) lewat /admin dengan kata sandi admin; murid masuk
        // dengan akun. Hanya TV — yang tidak bisa mengetik — yang membawa PIN.
        url: format!("{dasar}/admin"),
        url_tv: format!("{dasar}/tv?pin={}&tv=1", hub.pin),
        url_murid: format!("{dasar}/tv?murid=1"),
        url_lokal: format!("http://{ip}:{}/tv?murid=1", hub.port),
        publik,
        token_app: hub.token_app.clone(),
        admin_diset: SANDI_ADMIN.lock().ok().and_then(|s| s.clone()).is_some(),
        pin: hub.pin.clone(),
        port: hub.port,
        ip,
        klien: hub.klien.lock().map(|k| k.clone()).unwrap_or_default(),
    }
}

/* ── Perintah ──────────────────────────────────────────────────────── */

/// Alamat publik (mis. https://meet2.exactprintsolution.com) kalau aplikasi
/// diekspos lewat Cloudflare Tunnel. Tautan & QR di Pengaturan memakainya.
static ALAMAT_PUBLIK: Mutex<Option<String>> = Mutex::new(None);

/// Kata sandi admin untuk membuka editor dari tablet/browser. Terpisah dari
/// PIN murid: PIN membuka papan dan antrian, sandi membuka pena dan data.
static SANDI_ADMIN: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
pub fn share_set_admin(sandi: Option<String>) {
    let bersih = sandi.map(|s| s.trim().to_string()).filter(|s| s.len() >= 4);
    *SANDI_ADMIN.lock().unwrap_or_else(|e| e.into_inner()) = bersih;
}

/// Hak admin: token internal aplikasi, atau kata sandi admin yang disetel.
/// Percobaan yang gagal dihitung bersama percobaan PIN yang salah.
pub fn admin_sah(hub: &Hub, headers: &HeaderMap, q: Option<&str>) -> bool {
    let asal = asal_klien(headers);
    if diblokir(&asal) {
        return false;
    }
    let kandidat = headers
        .get("x-exact-admin")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| q.map(|s| s.to_string()));
    let Some(k) = kandidat.filter(|k| !k.is_empty()) else { return false };
    if k == hub.token_app {
        return true;
    }
    let sandi = SANDI_ADMIN.lock().ok().and_then(|s| s.clone());
    let benar = sandi.as_deref() == Some(k.as_str());
    if !benar {
        catat_gagal(&asal);
    }
    benar
}

/// Hak mengajar: guru utama (admin) ATAU guru pembantu (akun ber-peran guru).
/// Dipakai untuk membahas pertanyaan, membuka/menulis kanvas, izin coret, dan
/// foto pertanyaan. Urusan admin (akun, setelan, hapus) tetap `admin_sah`.
pub fn guru_sah(hub: &Hub, headers: &HeaderMap, q_admin: Option<&str>, q_sesi: Option<&str>) -> bool {
    if (headers.contains_key("x-exact-admin") || q_admin.is_some()) && admin_sah(hub, headers, q_admin) {
        return true;
    }
    crate::akun::guru_dari_headers(headers, q_sesi).is_some()
}

/// Siapa yang menjawab: 'utama' untuk guru utama, id akun untuk guru pembantu.
pub fn penjawab(hub: &Hub, headers: &HeaderMap) -> Option<String> {
    if headers.contains_key("x-exact-admin") && admin_sah(hub, headers, None) {
        return Some("utama".into());
    }
    crate::akun::guru_dari_headers(headers, None).map(|(id, _)| id)
}

fn tolak_admin() -> Response {
    (StatusCode::UNAUTHORIZED, "Admin password required.").into_response()
}

#[derive(Deserialize)]
pub struct QueryAdmin {
    pub pin: Option<String>,
    pub admin: Option<String>,
    /// Sesi guru pembantu untuk <img> yang tidak bisa membawa header.
    pub sesi: Option<String>,
}

#[tauri::command]
pub fn share_set_public(alamat: Option<String>) {
    let bersih = alamat
        .map(|a| a.trim().trim_end_matches('/').to_string())
        .filter(|a| a.starts_with("http://") || a.starts_with("https://"));
    *ALAMAT_PUBLIK.lock().unwrap_or_else(|e| e.into_inner()) = bersih;
}

#[tauri::command]
pub async fn share_start(app: AppHandle, pin: Option<String>) -> Result<InfoBerbagi, String> {
    if let Some(a) = BERBAGI.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        return Ok(info(&a.hub));
    }

    // Port berikutnya dicoba kalau 4747 sedang dipakai proses lain.
    let mut listener = None;
    let mut port = PORT_AWAL;
    for p in PORT_AWAL..PORT_AWAL + 10 {
        if let Ok(l) = StdTcpListener::bind(SocketAddr::new(IpAddr::from([0, 0, 0, 0]), p)) {
            l.set_nonblocking(true).map_err(|e| e.to_string())?;
            listener = Some(l);
            port = p;
            break;
        }
    }
    let listener = listener.ok_or("No free port between 4747 and 4756.")?;

    // Tiap titik pena adalah satu pesan; beberapa murid menulis bersamaan
    // sementara satu klien lambat mengunduh pesan berfoto bisa melewati
    // ratusan pesan dalam sedetik — yang tertinggal ditangani di `layani`.
    let (tx, _) = broadcast::channel::<String>(4096);
    let hub = Arc::new(Hub {
        // 4–8 digit: di jaringan rumah 4 cukup; begitu dibuka lewat internet,
        // pengguna diarahkan memakai 6–8 digit (lihat pembatas percobaan di bawah).
        pin: pin.filter(|p| (4..=8).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit())).unwrap_or_else(pin_acak),
        port,
        token: format!("{}-{}", env!("CARGO_PKG_VERSION"), pin_acak()),
        token_app: format!("{:x}{:x}{:x}", sidik_teks(&pin_acak()), sidik_teks(&format!("{:?}", std::time::SystemTime::now())), sidik_teks(&pin_acak())),
        tx,
        klien: Mutex::new(Vec::new()),
        app: app.clone(),
    });

    let (kirim_matikan, terima_matikan) = oneshot::channel::<()>();
    let router = rute(hub.clone());
    let listener = tokio::net::TcpListener::from_std(listener).map_err(|e| e.to_string())?;

    // Pengingat les (Web Push) diperiksa tiap menit.
    crate::push::mulai_pengingat();
    // Foto pertanyaan kemarin dibuang saat server menyala dan tiap jam.
    tauri::async_runtime::spawn(async {
        loop {
            tokio::task::spawn_blocking(crate::kelas::bersihkan).await.ok();
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
    });

    tauri::async_runtime::spawn(async move {
        let hasil = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
            .with_graceful_shutdown(async {
                let _ = terima_matikan.await;
            })
            .await;
        if let Err(e) = hasil {
            eprintln!("[server] berhenti: {e}");
        }
    });

    let hasil = info(&hub);
    *BERBAGI.lock().unwrap_or_else(|e| e.into_inner()) = Some(Aktif { hub, matikan: Some(kirim_matikan) });
    Ok(hasil)
}

#[tauri::command]
pub fn share_stop() {
    if let Some(mut a) = BERBAGI.lock().unwrap_or_else(|e| e.into_inner()).take() {
        if let Some(m) = a.matikan.take() {
            let _ = m.send(());
        }
        // Klien yang masih tersambung diberi tahu supaya layarnya tidak
        // membeku diam-diam menampilkan halaman terakhir.
        let _ = a.hub.tx.send(json!({ "t": "server-mati" }).to_string());
    }
}

#[tauri::command]
pub fn share_status() -> Option<InfoBerbagi> {
    BERBAGI
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map(|a| info(&a.hub))
}

/// QR sebagai SVG, untuk dipindai tablet.
#[tauri::command]
pub fn share_qr(text: String) -> Result<String, String> {
    use qrcode::render::svg;
    let kode = qrcode::QrCode::new(text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(kode
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .quiet_zone(true)
        .dark_color(svg::Color("#111111"))
        .light_color(svg::Color("#ffffff"))
        .build())
}

/* ── Rute ──────────────────────────────────────────────────────────── */

fn rute(hub: Arc<Hub>) -> Router {
    Router::new()
        .route("/", get(halaman_utama))
        .route("/admin", get(halaman_admin))
        .route("/tv", get(halaman_tv))
        .route("/api/boot", get(api_boot))
        .route("/api/vault", get(api_vault))
        .route("/api/admin/cek", get(api_admin_cek))
        .route("/api/canvas", get(api_canvas_list))
        .route(
            "/api/canvas/{id}",
            get(api_canvas_read).put(api_canvas_write).patch(api_canvas_tambal).delete(api_canvas_delete),
        )
        .route("/api/canvas/{id}/ringan", get(api_canvas_ringan))
        .route("/api/canvas/{id}/gambar/{nama}", get(api_canvas_gambar))
        .route("/api/sql", axum::routing::post(api_sql))
        .route("/api/kelas/masuk", axum::routing::post(crate::kelas::api_masuk))
        .route("/api/kelas/saya", get(crate::kelas::api_saya))
        .route("/api/kelas/tanya", axum::routing::post(crate::kelas::api_tanya))
        .route("/api/kelas/ubah", axum::routing::post(crate::kelas::api_ubah_tanya))
        .route("/api/kelas/foto/{nama}", get(crate::kelas::api_foto))
        .route("/api/kelas/foto-data", axum::routing::post(crate::kelas::api_foto_data))
        .route("/api/kelas/paham", axum::routing::post(crate::kelas::api_paham))
        .route("/api/kelas/izin", axum::routing::post(crate::kelas::api_izin))
        .route("/api/akun/daftar", axum::routing::post(crate::akun::api_daftar))
        .route("/api/akun/masuk", axum::routing::post(crate::akun::api_masuk_akun))
        .route("/api/akun/saya", get(crate::akun::api_saya_akun))
        .route("/api/akun/sesi", axum::routing::post(crate::akun::api_sesi_akun))
        .route("/api/akun/keluar", axum::routing::post(crate::akun::api_keluar))
        .route("/api/akun", get(crate::akun::api_daftar_akun))
        .route("/api/akun/reset", axum::routing::post(crate::akun::api_reset_sandi))
        .route("/api/akun/setujui", axum::routing::post(crate::akun::api_setujui))
        .route("/api/akun/peran", axum::routing::post(crate::akun::api_peran))
        .route("/api/kelas/guru", get(crate::kelas::api_daftar_guru))
        .route("/api/kelas/panggil", axum::routing::post(crate::kelas::api_panggil))
        .route("/api/kelas/permintaan/buka", axum::routing::post(crate::kelas::api_buka_permintaan))
        .route("/api/kelas/harian", get(crate::kelas::api_harian).post(crate::kelas::api_isi_harian))
        .route("/api/kelas/info", get(crate::info::api_info))
        .route("/api/kelas/agenda", axum::routing::post(crate::info::api_agenda))
        .route("/api/kelas/agenda/hapus", axum::routing::post(crate::info::api_hapus_agenda))
        .route("/api/kelas/catatan", axum::routing::post(crate::info::api_catatan))
        .route("/api/kelas/catatan/hapus", axum::routing::post(crate::info::api_hapus_catatan))
        .route("/api/push/kunci", get(crate::push::api_kunci))
        .route("/api/push/daftar", axum::routing::post(crate::push::api_daftar))
        .route("/api/push/hapus", axum::routing::post(crate::push::api_hapus))
        .route("/api/guru/tiket", axum::routing::post(api_buat_tiket))
        .route("/api/guru/tiket/tukar", axum::routing::post(api_tukar_tiket))
        .route("/api/akun/{id}", axum::routing::delete(crate::akun::api_hapus_akun))
        .route("/api/kelas/terbaru", get(crate::kelas::api_terbaru))
        .route("/api/kelas/grup/buat", axum::routing::post(crate::kelas::api_grup_buat))
        .route("/api/kelas/grup/daftar", get(crate::kelas::api_grup_daftar))
        .route("/api/kelas/grup/gabung", axum::routing::post(crate::kelas::api_grup_gabung))
        .route("/api/kelas/grup/keluar", axum::routing::post(crate::kelas::api_grup_keluar))
        .route("/api/kelas/grup/riwayat", get(crate::kelas::api_grup_riwayat))
        .route("/ws", get(ws_masuk))
        .fallback(aset_lain)
        .layer(axum::middleware::from_fn(cors))
        .layer(axum::middleware::from_fn(tandai_asal))
        // Bawaannya 2 MB — sketsa dengan foto atau halaman PDF jauh lebih besar
        // dari itu, dan tablet menyimpan seluruh sketsa lewat jalur ini.
        .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024))
        .with_state(hub)
}

/// Izinkan permintaan lintas-asal.
///
/// Aplikasi Mac sendiri memanggil server ini dari asal `tauri://localhost`,
/// dan tanpa header ini browser di dalamnya menolak jawabannya diam-diam —
/// foto pertanyaan tidak pernah sampai ke kanvas guru. PIN tetap yang
/// menjaga pintunya; asal boleh siapa saja.
async fn cors(req: axum::extract::Request, next: axum::middleware::Next) -> Response {
    if req.method() == axum::http::Method::OPTIONS {
        let mut r = StatusCode::NO_CONTENT.into_response();
        pasang_cors(r.headers_mut());
        return r;
    }
    let mut r = next.run(req).await;
    pasang_cors(r.headers_mut());
    r
}

fn pasang_cors(h: &mut HeaderMap) {
    h.insert("access-control-allow-origin", "*".parse().unwrap());
    h.insert("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS".parse().unwrap());
    // Semua header kredensial: aplikasi Mac (asal tauri://localhost) mengirim
    // x-exact-admin; tanpa ini preflight-nya gagal dan tiap aksi admin dari Mac
    // ditolak browser sebelum sampai ke server.
    h.insert("access-control-allow-headers", "content-type, x-exact-pin, x-exact-admin, x-exact-sesi".parse().unwrap());
    h.insert("access-control-max-age", "86400".parse().unwrap());
}

#[derive(Deserialize)]
pub struct QueryPin {
    pub pin: Option<String>,
    /// Token sesi murid (untuk <img>/WebSocket yang tidak bisa membawa header).
    pub sesi: Option<String>,
}

/// Percobaan PIN yang gagal per alamat asal. Lewat Cloudflare, alamat asli
/// klien ada di header `CF-Connecting-IP`; di jaringan lokal dipakai alamat
/// IP sambungannya sendiri (`x-exact-asal`, diisi `tandai_asal`).
static GAGAL_PIN: Mutex<Option<HashMap<String, (u32, std::time::Instant)>>> = Mutex::new(None);
const BATAS_GAGAL: u32 = 12;
const JENDELA_GAGAL: Duration = Duration::from_secs(10 * 60);

/// Catat alamat IP lawan sambungan di header, supaya pembatas percobaan PIN
/// memisahkan tiap perangkat di Wi-Fi lokal. Dulu semua perangkat lokal
/// berbagi satu ember: satu HP murid dengan PIN basi yang terus mencoba
/// mengunci semua perangkat lain — termasuk foto pertanyaan di layar guru.
async fn tandai_asal(ConnectInfo(alamat): ConnectInfo<SocketAddr>, mut req: Request, next: Next) -> Response {
    if let Ok(v) = alamat.ip().to_string().parse() {
        req.headers_mut().insert("x-exact-asal", v);
    }
    next.run(req).await
}

fn asal_klien(headers: &HeaderMap) -> String {
    for nama in ["cf-connecting-ip", "x-forwarded-for", "x-real-ip", "x-exact-asal"] {
        if let Some(v) = headers.get(nama).and_then(|v| v.to_str().ok()) {
            let pertama = v.split(',').next().unwrap_or("").trim();
            if !pertama.is_empty() {
                return pertama.to_string();
            }
        }
    }
    "lokal".into()
}

/// Terlalu banyak PIN salah dari satu asal → ditolak sementara, PIN benar pun.
/// Menebak 10.000 kombinasi empat digit jadi butuh bertahun-tahun, bukan menit.
pub fn diblokir(asal: &str) -> bool {
    let mut g = GAGAL_PIN.lock().unwrap_or_else(|e| e.into_inner());
    let peta = g.get_or_insert_with(HashMap::new);
    match peta.get(asal) {
        Some((n, sejak)) if *n >= BATAS_GAGAL && sejak.elapsed() < JENDELA_GAGAL => true,
        Some((_, sejak)) if sejak.elapsed() >= JENDELA_GAGAL => {
            peta.remove(asal);
            false
        }
        _ => false,
    }
}

pub fn catat_gagal(asal: &str) {
    let mut g = GAGAL_PIN.lock().unwrap_or_else(|e| e.into_inner());
    let peta = g.get_or_insert_with(HashMap::new);
    let masuk = peta.entry(asal.to_string()).or_insert((0, std::time::Instant::now()));
    if masuk.1.elapsed() >= JENDELA_GAGAL {
        *masuk = (0, std::time::Instant::now());
    }
    masuk.0 += 1;
    if peta.len() > 5000 {
        peta.retain(|_, (_, sejak)| sejak.elapsed() < JENDELA_GAGAL);
    }
}

/// Boleh masuk kelas ini? Lewat PIN (TV, tautan lama), lewat sesi akun murid
/// (HP yang sudah masuk), atau lewat hak admin (guru). Percobaan PIN yang
/// salah dihitung; permintaan tanpa kredensial sama sekali tidak.
pub fn sah(hub: &Hub, headers: &HeaderMap, q: Option<&str>) -> bool {
    sah_lengkap(hub, headers, q, None, None)
}

/// `q_admin`: sandi admin lewat parameter URL — satu-satunya cara koneksi
/// WebSocket dari browser bisa membawanya, karena API WebSocket bawaan
/// tidak bisa mengirim header kustom seperti x-exact-admin.
pub fn sah_lengkap(hub: &Hub, headers: &HeaderMap, q_pin: Option<&str>, q_sesi: Option<&str>, q_admin: Option<&str>) -> bool {
    let asal = asal_klien(headers);
    if diblokir(&asal) {
        return false;
    }
    let pin_header = headers.get("x-exact-pin").and_then(|v| v.to_str().ok());
    if let Some(p) = pin_header.or(q_pin) {
        if p == hub.pin {
            return true;
        }
    }
    let sesi = headers
        .get("x-exact-sesi")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| q_sesi.map(|s| s.to_string()));
    if let Some(t) = sesi {
        if crate::akun::akun_dari_sesi(&t).is_some() {
            return true;
        }
    }
    if headers.contains_key("x-exact-admin") || q_admin.is_some() {
        if admin_sah(hub, headers, q_admin) {
            return true;
        }
    }
    if pin_header.is_some() || q_pin.is_some() {
        catat_gagal(&asal);
    }
    false
}

pub fn tolak() -> Response {
    (StatusCode::UNAUTHORIZED, "PIN salah.").into_response()
}

/* ── Berkas frontend ───────────────────────────────────────────────── */

/// Ambil berkas hasil build frontend.
///
/// Saat dibundel, berkasnya tertanam di dalam aplikasi lewat penyelesai aset
/// Tauri. Saat `tauri dev`, tidak ada yang tertanam — dibaca dari folder
/// `dist` hasil `npm run build` supaya servernya tetap bisa diuji.
fn aset(app: &AppHandle, path: &str) -> Option<(Vec<u8>, String)> {
    let bersih = path.trim_start_matches('/');
    let bersih = if bersih.is_empty() { "index.html" } else { bersih };
    if let Some(a) = app.asset_resolver().get(format!("/{bersih}")) {
        return Some((a.bytes().to_vec(), a.mime_type().to_string()));
    }
    let mut cwd = std::env::current_dir().ok()?;
    for _ in 0..3 {
        let calon = cwd.join("dist").join(bersih);
        if calon.is_file() {
            let isi = std::fs::read(&calon).ok()?;
            return Some((isi, mime_dari(bersih).to_string()));
        }
        cwd = cwd.parent()?.to_path_buf();
    }
    None
}

fn mime_dari(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "json" => "application/json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn balas_aset(app: &AppHandle, path: &str) -> Response {
    match aset(app, path) {
        Some((isi, mime)) => {
            let mut r = Response::new(Body::from(isi));
            r.headers_mut().insert(header::CONTENT_TYPE, mime.parse().unwrap());
            // Berkas berhash boleh di-cache lama; HTML jangan, supaya versi baru
            // aplikasi langsung terlihat di TV tanpa membersihkan cache.
            let cache = if path.ends_with(".html") || path == "/" || path.is_empty() {
                "no-cache"
            } else if !path.starts_with("/assets/") {
                // Manifest PWA, ikon, dan berkas public/ lain tidak berhash:
                // jangan dibekukan setahun.
                "public, max-age=3600"
            } else {
                "public, max-age=31536000, immutable"
            };
            r.headers_mut().insert(header::CACHE_CONTROL, cache.parse().unwrap());
            r
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

/// `/` di alamat publik mengarah ke halaman murid: yang datang dari internet
/// adalah anak-anak. Editor ada di `/admin`. Di Wi-Fi lokal `/` tetap editor
/// (dengan kata sandi admin) supaya alur lama di tablet tidak putus.
async fn halaman_utama(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
    let publik = ALAMAT_PUBLIK.lock().ok().and_then(|a| a.clone());
    let host_publik = publik.as_deref().and_then(|a| a.split("://").nth(1)).map(|h| h.trim_end_matches('/'));
    let lewat_cloudflare = headers.contains_key("cf-connecting-ip") || host_publik.is_some_and(|h| h.eq_ignore_ascii_case(host));
    if lewat_cloudflare {
        return axum::response::Redirect::temporary("/tv?murid=1").into_response();
    }
    balas_aset(&hub.app, "index.html")
}

async fn halaman_admin(State(hub): State<Arc<Hub>>) -> Response {
    balas_aset(&hub.app, "index.html")
}

async fn api_admin_cek(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<QueryAdmin>) -> Response {
    if !sah(&hub, &headers, q.pin.as_deref()) {
        return tolak();
    }
    if admin_sah(&hub, &headers, q.admin.as_deref()) {
        return Json(json!({ "peran": "admin" })).into_response();
    }
    if let Some((id, nama)) = crate::akun::guru_dari_headers(&headers, None) {
        return Json(json!({ "peran": "guru", "id": id, "nama": nama })).into_response();
    }
    tolak_admin()
}

async fn halaman_tv(State(hub): State<Arc<Hub>>) -> Response {
    balas_aset(&hub.app, "tv.html")
}

async fn aset_lain(State(hub): State<Arc<Hub>>, uri: axum::http::Uri) -> Response {
    balas_aset(&hub.app, uri.path())
}

/// Berubah tiap kali aplikasi Mac dibuka ulang (baru dibangun, tidak cuma
/// halaman disegarkan). Tablet/browser membandingkannya secara berkala dan
/// memuat ulang sendiri kalau berubah — supaya versi baru yang baru dipasang
/// di Mac tidak diam-diam tertahan di tab lama yang masih membawa kode lama.
/// Tanpa PIN dengan sengaja: cuma angka acak, tidak membocorkan apa pun.
async fn api_boot(State(hub): State<Arc<Hub>>) -> Response {
    Json(json!({ "boot": hub.token_app })).into_response()
}

/* ── API vault ─────────────────────────────────────────────────────── */

async fn api_vault(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<QueryPin>) -> Response {
    if !sah_lengkap(&hub, &headers, q.pin.as_deref(), q.sesi.as_deref(), None) {
        return tolak();
    }
    Json(vault::vault_info()).into_response()
}

async fn api_canvas_list(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    if !sah(&hub, &headers, None) {
        return tolak();
    }
    Json(vault::canvas_list()).into_response()
}

async fn api_canvas_read(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !sah(&hub, &headers, None) {
        return tolak();
    }
    // Berkas utuh (dengan data gambar) hanya untuk editor; murid memakai /ringan.
    if !guru_sah(&hub, &headers, None, None) {
        return tolak_admin();
    }
    match vault::canvas_read(id) {
        // Sebagai teks, bukan JSON: klien menyimpan berkasnya apa adanya dan
        // mengurainya sendiri, sama seperti saat membaca dari disk.
        Ok(Some(isi)) => ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], isi).into_response(),
        Ok(None) => StatusCode::NOT_FOUND.into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn api_canvas_write(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: String,
) -> Response {
    if !sah(&hub, &headers, None) {
        return tolak();
    }
    if !guru_sah(&hub, &headers, None, None) {
        return tolak_admin();
    }
    let dasar = headers.get("x-exact-dasar").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i64>().ok());
    match tokio::task::spawn_blocking(move || vault::canvas_write(id, body, dasar)).await.unwrap_or_else(|e| Err(e.to_string())) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        // Ada yang menyimpan lebih dulu: editor menggabungkan lalu mencoba lagi.
        Err(e) if e.starts_with("KONFLIK:") => (StatusCode::CONFLICT, e).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

/// Simpanan sebagian dari editor di browser (tablet): hanya goresan/objek
/// yang berubah, bukan seluruh berkas yang bisa puluhan MB karena foto/PDF.
async fn api_canvas_tambal(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(t): Json<vault::Tambalan>,
) -> Response {
    if !sah(&hub, &headers, None) {
        return tolak();
    }
    if !guru_sah(&hub, &headers, None, None) {
        return tolak_admin();
    }
    match tokio::task::spawn_blocking(move || vault::canvas_tambal(&id, t)).await.unwrap_or_else(|e| Err(e.to_string())) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) if e.starts_with("KONFLIK:") => (StatusCode::CONFLICT, e).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

async fn api_canvas_delete(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    if !sah(&hub, &headers, None) {
        return tolak();
    }
    if !admin_sah(&hub, &headers, None) {
        return tolak_admin();
    }
    match vault::canvas_delete(id) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

/* ── Sketsa ringan untuk layar pengikut ────────────────────────────── */

/// Gambar tempelan satu sketsa, sudah didekode dari data URL-nya.
struct GambarSketsa {
    mime: String,
    bytes: Vec<u8>,
}

struct CacheSketsa {
    mtime: SystemTime,
    gambar: Arc<Vec<GambarSketsa>>,
}

/// Gambar yang sudah didekode, per sketsa, selama berkasnya belum berubah.
///
/// Tanpa ini, tiap HP yang meminta satu halaman PDF memaksa server mengurai
/// ulang berkas 20 MB — empat puluh HP dikali empat puluh halaman adalah
/// ribuan penguraian untuk satu sketsa yang tidak berubah.
static CACHE_SKETSA: Mutex<Option<HashMap<String, CacheSketsa>>> = Mutex::new(None);

fn sidik_teks(s: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

pub fn dekode_data_url(src: &str) -> Option<(String, Vec<u8>)> {
    use base64::Engine;
    let sisa = src.strip_prefix("data:")?;
    let (kepala, isi) = sisa.split_once(',')?;
    let mime = kepala.trim_end_matches(";base64").to_string();
    let bytes = base64::engine::general_purpose::STANDARD.decode(isi.as_bytes()).ok()?;
    Some((mime, bytes))
}

/// Baca sketsa; kembalikan JSON tanpa isi gambar (diganti URL) dan simpan
/// gambar yang didekode di cache untuk dilayani per permintaan.
fn sketsa_ringan(id: &str, kred: &str) -> Result<String, String> {
    let p = vault::resolve_within(&vault::canvas_dir(), &format!("{id}.json"))?;
    let mtime = std::fs::metadata(&p).and_then(|m| m.modified()).map_err(|e| e.to_string())?;
    let teks = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_str(&teks).map_err(|e| e.to_string())?;

    let mut daftar: Vec<GambarSketsa> = Vec::new();
    if let Some(gambar) = v.get_mut("images").and_then(|g| g.as_array_mut()) {
        for (i, g) in gambar.iter_mut().enumerate() {
            let Some(src) = g.get("src").and_then(|s| s.as_str()) else { continue };
            let sidik = sidik_teks(src);
            // Sidik jari isi masuk ke URL supaya browser boleh men-cache selamanya.
            if let Some((mime, bytes)) = dekode_data_url(src) {
                // Ekstensi di jalurnya: Cloudflare (dan proksi lain) men-cache
                // .jpg/.png secara bawaan, jadi 40 HP di luar Wi-Fi tidak
                // menarik tiap halaman PDF dari Mac ini satu per satu.
                let ext = if mime.contains("png") { "png" } else if mime.contains("webp") { "webp" } else { "jpg" };
                daftar.push(GambarSketsa { mime, bytes });
                g["src"] = Value::String(format!("/api/canvas/{id}/gambar/{i}.{ext}?v={sidik:x}&{kred}"));
            } else {
                // Bukan data URL (sudah berupa URL): biarkan; slot cache tetap
                // terisi supaya indeksnya sejajar dengan urutan gambar.
                daftar.push(GambarSketsa { mime: String::new(), bytes: Vec::new() });
            }
        }
    }
    let mut cache = CACHE_SKETSA.lock().unwrap_or_else(|e| e.into_inner());
    let peta = cache.get_or_insert_with(HashMap::new);
    // Paling banyak beberapa sketsa yang ditahan; TV biasanya menonton satu.
    if peta.len() >= 4 && !peta.contains_key(id) {
        if let Some(k) = peta.keys().next().cloned() {
            peta.remove(&k);
        }
    }
    peta.insert(id.to_string(), CacheSketsa { mtime, gambar: Arc::new(daftar) });
    serde_json::to_string(&v).map_err(|e| e.to_string())
}

fn gambar_dari_cache(id: &str, kred: &str) -> Result<Arc<Vec<GambarSketsa>>, String> {
    let p = vault::resolve_within(&vault::canvas_dir(), &format!("{id}.json"))?;
    let mtime = std::fs::metadata(&p).and_then(|m| m.modified()).map_err(|e| e.to_string())?;
    {
        let cache = CACHE_SKETSA.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = cache.as_ref().and_then(|m| m.get(id)) {
            if c.mtime == mtime {
                return Ok(c.gambar.clone());
            }
        }
    }
    sketsa_ringan(id, kred)?;
    let cache = CACHE_SKETSA.lock().unwrap_or_else(|e| e.into_inner());
    cache
        .as_ref()
        .and_then(|m| m.get(id))
        .map(|c| c.gambar.clone())
        .ok_or_else(|| "Sketch not cached.".into())
}

async fn api_canvas_ringan(State(hub): State<Arc<Hub>>, headers: HeaderMap, Query(q): Query<QueryPin>, Path(id): Path<String>) -> Response {
    if !sah_lengkap(&hub, &headers, q.pin.as_deref(), q.sesi.as_deref(), None) {
        return tolak();
    }
    // Kredensial yang dipakai peminta itulah yang ditanam di URL gambarnya:
    // murid bersesi tidak pernah melihat PIN kelas.
    let kred = match q.sesi.clone().or_else(|| headers.get("x-exact-sesi").and_then(|v| v.to_str().ok()).map(|s| s.to_string())) {
        Some(s) => format!("sesi={s}"),
        None => format!("pin={}", hub.pin),
    };
    match tokio::task::spawn_blocking(move || sketsa_ringan(&id, &kred)).await {
        Ok(Ok(isi)) => ([(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "no-store")], isi).into_response(),
        Ok(Err(e)) => (StatusCode::NOT_FOUND, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

async fn api_canvas_gambar(
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Query(q): Query<QueryPin>,
    Path((id, nama)): Path<(String, String)>,
) -> Response {
    if !sah_lengkap(&hub, &headers, q.pin.as_deref(), q.sesi.as_deref(), None) {
        return tolak();
    }
    let Ok(i) = nama.split('.').next().unwrap_or("").parse::<usize>() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let kred = format!("pin={}", hub.pin);
    let hasil = tokio::task::spawn_blocking(move || gambar_dari_cache(&id, &kred)).await;
    match hasil {
        Ok(Ok(daftar)) => match daftar.get(i) {
            Some(g) if !g.bytes.is_empty() => {
                let mut r = Response::new(Body::from(g.bytes.clone()));
                r.headers_mut().insert(header::CONTENT_TYPE, g.mime.parse().unwrap_or(header::HeaderValue::from_static("application/octet-stream")));
                // URL-nya memuat sidik isi, jadi browser boleh menyimpannya selamanya.
                r.headers_mut().insert(header::CACHE_CONTROL, "public, max-age=31536000, immutable".parse().unwrap());
                r
            }
            _ => StatusCode::NOT_FOUND.into_response(),
        },
        Ok(Err(e)) => (StatusCode::NOT_FOUND, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/* ── API SQL ───────────────────────────────────────────────────────── */

enum SaringSql {
    Boleh,
    Abaikan,
    Tolak(&'static str),
}

/// Penjaga SQL untuk guru pembantu (lihat api_sql).
fn saring_sql_guru(sql: &str, params: &[Value]) -> SaringSql {
    let s = sql.to_ascii_lowercase();
    let s = s.trim_start();
    let kata: Vec<&str> = s.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').filter(|k| !k.is_empty()).collect();
    let ada = |k: &str| kata.iter().any(|x| *x == k);
    if ada("push_") || ada("sessions") || ada("pass_hash") || ada("salt") || ada("attach") || ada("pragma") || ada("drop") || ada("alter") {
        return SaringSql::Tolak("Not allowed for assistant teachers.");
    }
    let tulis = ["insert", "update", "delete", "replace", "create"].iter().any(|k| s.starts_with(k));
    if !tulis {
        // Akun: hanya dua kueri daftar murid editor (nomor HP + peran). Kueri
        // bebas ("SELECT * FROM accounts") akan ikut membawa hash sandi.
        if ada("accounts") {
            let pola = s.split_whitespace().collect::<Vec<_>>().join(" ");
            const DAFTAR_MURID: [&str; 2] = [
                "select s.*, a.phone, a.role from students s left join accounts a on a.id = s.id where s.last_seen > ? order by s.room, s.name collate nocase",
                "select s.*, a.phone, a.role from students s left join accounts a on a.id = s.id order by s.name collate nocase",
            ];
            if !DAFTAR_MURID.contains(&pola.as_str()) {
                return SaringSql::Tolak("Not allowed for assistant teachers.");
            }
        }
        // Setelan menyimpan sandi admin: hanya baca per kunci (pola getSetting),
        // dan kunci sandi tidak pernah diberikan.
        if ada("settings") {
            let pola = s.split_whitespace().collect::<Vec<_>>().join(" ");
            let rahasia = params.iter().any(|p| p.as_str() == Some("sandi_admin")) || s.contains("sandi_admin");
            if pola != "select value from settings where key = ?" || rahasia {
                return SaringSql::Tolak("Not allowed for assistant teachers.");
            }
        }
        return SaringSql::Boleh;
    }
    if ada("accounts") {
        return SaringSql::Tolak("Only the main teacher can change accounts.");
    }
    if ada("settings") {
        return SaringSql::Abaikan;
    }
    if s.starts_with("delete") && ada("canvases") {
        return SaringSql::Tolak("Only the main teacher can delete canvases.");
    }
    SaringSql::Boleh
}

#[derive(Deserialize)]
struct PermintaanSql {
    sql: String,
    #[serde(default)]
    params: Vec<Value>,
}

fn ke_param(v: &Value) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Value::Null => V::Null,
        Value::Bool(b) => V::Integer(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                V::Integer(i)
            } else {
                V::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => V::Text(s.clone()),
        lain => V::Text(lain.to_string()),
    }
}

fn dari_sql(v: rusqlite::types::Value) -> Value {
    use rusqlite::types::Value as V;
    match v {
        V::Null => Value::Null,
        V::Integer(i) => json!(i),
        V::Real(f) => json!(f),
        V::Text(t) => json!(t),
        V::Blob(b) => json!(b),
    }
}

/// Jalankan satu pernyataan di database vault.
///
/// Klien web memakai lapisan data yang sama dengan aplikasi Mac; yang berbeda
/// hanya jalannya. SELECT dan PRAGMA mengembalikan baris; sisanya mengembalikan
/// jumlah baris yang berubah — bentuk yang sama dengan tauri-plugin-sql.
fn jalankan_sql(req: PermintaanSql) -> Result<Value, String> {
    let conn = rusqlite::Connection::open(vault::db_path()).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_millis(15000)).map_err(|e| e.to_string())?;
    let params: Vec<rusqlite::types::Value> = req.params.iter().map(ke_param).collect();
    let awal = req.sql.trim_start().to_ascii_uppercase();
    let membaca = awal.starts_with("SELECT") || awal.starts_with("PRAGMA") || awal.starts_with("WITH");
    if membaca {
        let mut stmt = conn.prepare(&req.sql).map_err(|e| e.to_string())?;
        let kolom: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let baris = stmt
            .query_map(rusqlite::params_from_iter(params.iter()), |row| {
                let mut obj = Map::new();
                for (i, k) in kolom.iter().enumerate() {
                    let v: rusqlite::types::Value = row.get(i)?;
                    obj.insert(k.clone(), dari_sql(v));
                }
                Ok(Value::Object(obj))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(json!({ "rows": baris }))
    } else {
        let n = conn
            .execute(&req.sql, rusqlite::params_from_iter(params.iter()))
            .map_err(|e| e.to_string())?;
        Ok(json!({ "rowsAffected": n }))
    }
}

async fn api_sql(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(req): Json<PermintaanSql>) -> Response {
    if !sah(&hub, &headers, None) {
        return tolak();
    }
    // SQL bebas hanya untuk editor: murid tidak boleh membaca, apalagi menulis, database.
    if !(headers.contains_key("x-exact-admin") && admin_sah(&hub, &headers, None)) {
        if crate::akun::guru_dari_headers(&headers, None).is_none() {
            return tolak_admin();
        }
        // Guru pembantu: hanya pekerjaan mengajar. Sesi & sandi tidak pernah
        // tersentuh, akun hanya dibaca, kanvas tidak dihapus, dan tulisan ke
        // setelan diabaikan diam-diam supaya setelan guru utama tidak berubah
        // tanpa membuat layar editor si guru pembantu galat.
        match saring_sql_guru(&req.sql, &req.params) {
            SaringSql::Boleh => {}
            SaringSql::Abaikan => return Json(json!({ "rows": [] })).into_response(),
            SaringSql::Tolak(alasan) => return (StatusCode::FORBIDDEN, alasan).into_response(),
        }
    }
    match tokio::task::spawn_blocking(move || jalankan_sql(req)).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => (StatusCode::BAD_REQUEST, e).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/* ── Hub WebSocket ─────────────────────────────────────────────────── */

#[derive(Deserialize)]
struct QueryWs {
    pin: Option<String>,
    id: Option<String>,
    name: Option<String>,
    role: Option<String>,
    murid: Option<String>,
    admin: Option<String>,
    sesi: Option<String>,
}

async fn ws_masuk(
    ws: WebSocketUpgrade,
    State(hub): State<Arc<Hub>>,
    headers: HeaderMap,
    Query(q): Query<QueryWs>,
) -> Response {
    if !sah_lengkap(&hub, &headers, q.pin.as_deref(), q.sesi.as_deref(), q.admin.as_deref()) {
        return tolak();
    }
    // Peran editor menyiarkan pandangan dan goresan ke semua layar; itu hak
    // admin. Yang tidak punya sandinya diturunkan jadi pengikut biasa.
    let peran_minta = q.role.clone().unwrap_or_else(|| "editor".into());
    let mut peran = peran_minta.clone();
    if peran == "editor" && !admin_sah(&hub, &headers, q.admin.as_deref()) {
        peran = "tv".into();
    }
    // Guru pembantu masuk sebagai editor lewat sesi akunnya; namanya di
    // daftar klien diambil dari akun supaya murid melihat siapa yang membahas.
    let mut guru = String::new();
    let mut nama = q.name.clone().unwrap_or_else(|| "Device".into());
    if peran_minta == "editor" && peran == "tv" {
        if let Some((id, n)) = crate::akun::guru_dari_headers(&headers, q.sesi.as_deref()) {
            peran = "editor".into();
            guru = id;
            nama = n;
        }
    }
    let klien = Klien {
        id: q.id.unwrap_or_else(|| format!("k{}", pin_acak())),
        nama,
        peran,
        murid: q.murid.unwrap_or_default(),
        fokus: true,
        keluar: 0,
        tunggu: false,
        guru,
    };
    ws.on_upgrade(move |soket| layani(soket, hub, klien))
}

/// Saring pesan dari HP murid: goresan pena (titik / selesai / ubah coretan)
/// dan foto yang ditempelnya sendiri ke kanvasnya (lihat "sisip foto" di HP),
/// di kanvas yang diizinkan; hapusan hanya untuk coretan buatannya sendiri.
/// Pesan yang lolos ditandai `dariMurid` supaya layar lain tahu ini bukan
/// guru. Mengembalikan None untuk pesan yang dibuang.
fn coretan_murid(
    v: &Value,
    jenis: &str,
    boleh: bool,
    kanvas: Option<&str>,
    murid: &str,
    punya: &mut std::collections::HashSet<String>,
) -> Option<Value> {
    if !boleh {
        return None;
    }
    let kanvas = kanvas?;
    if v.get("idKanvas").and_then(|x| x.as_str()) != Some(kanvas) {
        return None;
    }
    let mut keluar = match jenis {
        "titik" | "goresan-selesai" | "kursor" => v.clone(),
        "ubah" => {
            let mut tambah: Vec<Value> = v["tambah"]["coretan"].as_array().cloned().unwrap_or_default();
            tambah.retain(|c| c["id"].is_string() && c["points"].as_array().map(|p| p.len() <= 6000).unwrap_or(false));
            if tambah.len() > 50 {
                return None;
            }
            for c in &mut tambah {
                if let Some(id) = c["id"].as_str() {
                    punya.insert(id.to_string());
                }
                // Cap pemilik ikut tersimpan di berkas: sesudah muat ulang,
                // goresan ini tetap dikenali sebagai miliknya (lihat goresan_milik).
                c["murid"] = Value::String(murid.to_string());
            }
            let hapus: Vec<Value> = v["hapus"]["coretan"]
                .as_array()
                .map(|h| h.iter().filter(|x| x.as_str().map(|s| punya.contains(s)).unwrap_or(false)).cloned().collect())
                .unwrap_or_default();
            // Foto yang ditempel murid sendiri ke kanvasnya — data URL sudah
            // diperkecil di HP; batas ukuran & jumlah di sini cuma pagar kalau
            // ada yang mengutak-atik klien.
            let mut gambar: Vec<Value> = v["tambah"]["gambar"].as_array().cloned().unwrap_or_default();
            gambar.retain(|g| {
                g["id"].is_string()
                    && g["x"].is_number()
                    && g["y"].is_number()
                    && g["w"].is_number()
                    && g["h"].is_number()
                    && g["src"].as_str().map(|s| s.starts_with("data:image/") && s.len() <= 900_000).unwrap_or(false)
            });
            gambar.truncate(8);
            // Bentuk hasil mode shape murid (garis, persegi, bulat). Sama
            // seperti coretan: dicap namanya supaya ia — dan hanya ia — bisa
            // menghapus atau mengurungkannya lagi sesudah halaman dimuat ulang.
            let mut objek: Vec<Value> = v["tambah"]["objek"].as_array().cloned().unwrap_or_default();
            objek.retain(|o| {
                o["id"].is_string()
                    && o["jenis"].is_string()
                    && o["titik"]
                        .as_array()
                        .map(|ts| {
                            !ts.is_empty()
                                && ts.len() <= 64
                                && ts.iter().all(|q| {
                                    q.as_array().map(|xy| xy.len() == 2 && xy.iter().all(|n| n.is_number())).unwrap_or(false)
                                })
                        })
                        .unwrap_or(false)
            });
            objek.truncate(50);
            for o in &mut objek {
                if let Some(id) = o["id"].as_str() {
                    punya.insert(id.to_string());
                }
                o["murid"] = Value::String(murid.to_string());
            }
            let hapus_objek: Vec<Value> = v["hapus"]["objek"]
                .as_array()
                .map(|h| h.iter().filter(|x| x.as_str().map(|s| punya.contains(s)).unwrap_or(false)).cloned().collect())
                .unwrap_or_default();
            if tambah.is_empty() && hapus.is_empty() && gambar.is_empty() && objek.is_empty() && hapus_objek.is_empty() {
                return None;
            }
            json!({
                "t": "ubah", "idKanvas": kanvas, "src": v.get("src").cloned().unwrap_or(Value::Null),
                "hapus": { "coretan": hapus, "objek": hapus_objek },
                "tambah": { "coretan": tambah, "objek": objek, "gambar": gambar },
            })
        }
        _ => return None,
    };
    keluar["dariMurid"] = Value::String(murid.to_string());
    Some(keluar)
}

fn siarkan_klien(hub: &Hub) {
    let daftar = hub.klien.lock().map(|k| k.clone()).unwrap_or_default();
    let _ = hub.tx.send(json!({ "t": "klien", "daftar": daftar, "server": hub.token }).to_string());
}

async fn layani(soket: WebSocket, hub: Arc<Hub>, klien: Klien) {
    let id = klien.id.clone();
    let editor = klien.peran == "editor";
    let murid = klien.murid.clone();
    // Murid yang diizinkan guru boleh mencoret satu kanvas: kanvasnya sendiri.
    // Izinnya dibaca sekali di sini dan diperbarui lewat siaran `izin`.
    // Dibaca sekali di awal (mungkin membuka database) supaya pembacaan
    // per pesan selanjutnya tinggal dari cache bersama.
    if !editor && !murid.is_empty() {
        let m = murid.clone();
        let _ = tokio::task::spawn_blocking(move || crate::kelas::izin_murid_terkini(&m)).await;
    }
    // Coretan miliknya — hanya itu yang boleh ia hapus lagi (undo, penghapus):
    // yang dibuat koneksi ini, ditambah yang bercap namanya di berkas kanvas
    // yang diizinkan (dibaca sekali per kanvas, saat kanvas izinnya berganti).
    let mut punya: std::collections::HashSet<String> = Default::default();
    let mut kanvas_dibenihi: Option<String> = None;
    // Kanvas yang diikuti layar ini ({t:'lihat', kanvas:[...]}): pesan goresan
    // dari kanvas LAIN tidak dikirim ke sini. Dulu setiap HP menerima goresan
    // semua murid di semua kanvas pribadi lalu membuangnya sendiri — berat di
    // HP dan di Cloudflare saat kelas ramai. None = belum menyatakan (semua).
    let mut dilihat: Option<std::collections::HashSet<String>> = None;
    // Berlangganan dulu, baru mengumumkan diri: kalau dibalik, klien yang baru
    // masuk justru tidak pernah menerima daftar yang memuat dirinya sendiri.
    let mut rx = hub.tx.subscribe();
    if let Ok(mut k) = hub.klien.lock() {
        k.retain(|x| x.id != id);
        k.push(klien);
    }
    siarkan_klien(&hub);

    let (mut tulis, mut baca) = soket.split();

    loop {
        tokio::select! {
            masuk = baca.next() => {
                match masuk {
                    Some(Ok(Message::Text(t))) => {
                        // Status fokus (lampu pengawasan) mengubah catatan
                        // klien di server sebelum diteruskan.
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            let jenis = v.get("t").and_then(|x| x.as_str()).unwrap_or("");
                            // Denyut: klien tahu sambungannya masih hidup (sambungan
                            // seluler/tunnel bisa "terbuka" padahal sudah mati).
                            if jenis == "ping" {
                                if tulis.send(Message::Text(json!({ "t": "pong" }).to_string().into())).await.is_err() {
                                    break;
                                }
                                continue;
                            }
                            // Pesan berkunci (goresan murid): diakui begitu diterima
                            // server, supaya HP tahu kapan boleh berhenti mengirim ulang.
                            if let Some(k) = v.get("kunci").and_then(|x| x.as_str()) {
                                if tulis.send(Message::Text(json!({ "t": "ack", "kunci": k }).to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                            if jenis == "lihat" {
                                dilihat = v.get("kanvas").and_then(|x| x.as_array()).map(|a| {
                                    a.iter().filter_map(|x| x.as_str()).take(20).map(|x| x.to_string()).collect()
                                });
                                continue;
                            }
                            if jenis == "fokus" {
                                if let Ok(mut k) = hub.klien.lock() {
                                    if let Some(me) = k.iter_mut().find(|x| x.id == id) {
                                        let aktif = v.get("aktif").and_then(|x| x.as_bool()).unwrap_or(true);
                                        let tunggu = v.get("tunggu").and_then(|x| x.as_bool()).unwrap_or(false);
                                        // Meninggalkan halaman saat mode menunggu tidak dihitung kabur.
                                        if me.fokus && !aktif && !tunggu {
                                            me.keluar += 1;
                                        }
                                        me.fokus = aktif || tunggu;
                                        me.tunggu = tunggu;
                                    }
                                }
                                siarkan_klien(&hub);
                                continue;
                            }
                            // Selain fokus, hanya editor yang boleh menyiarkan:
                            // HP murid tidak bisa menyamar jadi guru. Kecuali
                            // murid berizin, untuk goresan di kanvasnya sendiri.
                            if !editor {
                                let (boleh_coret, kanvas_izin) = if murid.is_empty() { (false, None) } else { crate::kelas::izin_murid_terkini(&murid) };
                                // Murid berizin boleh menulis di kanvas grupnya ATAU kanvas
                                // pribadinya — mana pun yang sedang ia tampilkan.
                                let kanvas_izin = if boleh_coret {
                                    let di = v.get("idKanvas").and_then(|x| x.as_str()).map(|x| x.to_string());
                                    // Sudah di kanvas izin bawaan: tak perlu mencari kanvas pribadi.
                                    let pribadi = if murid.is_empty() || di.is_none() || di == kanvas_izin { None } else {
                                        let m = murid.clone();
                                        tokio::task::spawn_blocking(move || crate::kelas::kanvas_pribadi_terkini(&m)).await.ok().flatten()
                                    };
                                    if di.is_some() && di == pribadi { pribadi } else { kanvas_izin }
                                } else { kanvas_izin };
                                if boleh_coret && kanvas_izin.is_some() && kanvas_izin != kanvas_dibenihi {
                                    let (k, m) = (kanvas_izin.clone().unwrap_or_default(), murid.clone());
                                    if let Ok(ids) = tokio::task::spawn_blocking(move || crate::kelas::goresan_milik(&k, &m)).await {
                                        punya.extend(ids);
                                    }
                                    kanvas_dibenihi = kanvas_izin.clone();
                                }
                                if let Some(pesan) = coretan_murid(&v, jenis, boleh_coret, kanvas_izin.as_deref(), &murid, &mut punya) {
                                    if jenis == "ubah" {
                                        crate::kelas::antre_coretan_murid(hub.clone(), kanvas_izin.clone().unwrap_or_default(), pesan.clone());
                                    }
                                    let _ = hub.tx.send(pesan.to_string());
                                }
                                continue;
                            }
                        }
                        let _ = hub.tx.send(t.to_string());
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
            keluar = rx.recv() => {
                match keluar {
                    Ok(pesan) => {
                        if !editor {
                            if let Some(set) = &dilihat {
                                if pesan_kanvas_lain(&pesan, set) {
                                    continue;
                                }
                            }
                        }
                        if tulis.send(Message::Text(pesan.into())).await.is_err() {
                            break;
                        }
                    }
                    // Tertinggal: klien lambat kehilangan beberapa pesan langsung.
                    // Goresan yang sudah selesai ('ubah') ikut hilang, bukan
                    // cuma titik pratinjau — beri tahu supaya ia memuat ulang
                    // kanvasnya dari simpanan, bukan menunggu perubahan berikutnya.
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        if tulis.send(Message::Text(json!({ "t": "tertinggal", "n": n }).to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    if let Ok(mut k) = hub.klien.lock() {
        k.retain(|x| x.id != id);
    }
    siarkan_klien(&hub);
}

/// Nilai string sebuah kunci JSON tingkat mana pun, dicari tanpa mengurai
/// seluruh pesan (dipanggil untuk setiap pesan ke setiap layar).
fn nilai_kunci<'a>(pesan: &'a str, kunci: &str) -> Option<&'a str> {
    let pola = format!("\"{kunci}\":\"");
    let i = pesan.find(&pola)? + pola.len();
    let j = pesan[i..].find('"')?;
    Some(&pesan[i..i + j])
}

/// Pesan goresan langsung untuk kanvas yang TIDAK diikuti layar ini?
/// Hanya jenis goresan yang disaring; pandangan, data, kabar kelas, dll. tetap lewat.
fn pesan_kanvas_lain(pesan: &str, dilihat: &std::collections::HashSet<String>) -> bool {
    let Some(jenis) = nilai_kunci(pesan, "t") else { return false };
    if !matches!(jenis, "titik" | "goresan" | "goresan-selesai" | "kursor" | "objek" | "instrumen" | "ubah") {
        return false;
    }
    match nilai_kunci(pesan, "idKanvas") {
        Some(k) => !dilihat.contains(k),
        None => false,
    }
}

#[cfg(test)]
mod uji_saring_kanvas {
    use super::pesan_kanvas_lain;

    #[test]
    fn saring() {
        let lihat: std::collections::HashSet<String> = ["cnv_a".to_string(), "cnv_b".to_string()].into();
        assert!(!pesan_kanvas_lain(r#"{"t":"titik","idKanvas":"cnv_a","titik":[[1,2,0.5]]}"#, &lihat));
        assert!(pesan_kanvas_lain(r#"{"t":"titik","idKanvas":"cnv_z","titik":[[1,2,0.5]]}"#, &lihat));
        // Pesan dari server (kunci terurut abjad): "t" di belakang.
        assert!(pesan_kanvas_lain(r#"{"dariMurid":true,"idKanvas":"cnv_z","t":"ubah"}"#, &lihat));
        // Pandangan tidak pernah disaring: TV mengikuti guru pindah kanvas lewat ini.
        assert!(!pesan_kanvas_lain(r#"{"t":"pandangan","idKanvas":"cnv_z"}"#, &lihat));
        assert!(!pesan_kanvas_lain(r#"{"t":"data","kanal":"canvas"}"#, &lihat));
    }
}

#[cfg(test)]
mod uji_guru {
    use super::{saring_sql_guru as saring_p, SaringSql};
    use serde_json::{json, Value};

    fn saring_sql_guru(s: &str) -> SaringSql {
        saring_p(s, &[])
    }
    fn boleh(s: &str) -> bool {
        matches!(saring_sql_guru(s), SaringSql::Boleh)
    }

    #[test]
    fn penjaga_sql_guru_pembantu() {
        // Pekerjaan mengajar tetap jalan.
        assert!(boleh("SELECT s.*, a.phone, a.role FROM students s LEFT JOIN accounts a ON a.id = s.id ORDER BY s.name COLLATE NOCASE"));
        assert!(!boleh("SELECT * FROM accounts"));
        assert!(!boleh("SELECT s.*, x.* FROM students s JOIN accounts x ON x.id = s.id"));
        assert!(boleh("SELECT * FROM questions WHERE status != 'selesai'"));
        assert!(boleh("UPDATE students SET can_draw = 1 WHERE id = ?"));
        assert!(boleh("INSERT INTO canvases (id, title, updated_at) VALUES (?, ?, ?)"));
        assert!(boleh("  update groups set name = ? where id = ?"));
        // Sesi dan sandi tidak pernah tersentuh, bahkan dibaca.
        assert!(matches!(saring_sql_guru("SELECT token FROM sessions"), SaringSql::Tolak(_)));
        assert!(matches!(saring_sql_guru("SELECT pass_hash, salt FROM accounts"), SaringSql::Tolak(_)));
        // Akun hanya dibaca; peran tidak bisa dinaikkan sendiri.
        assert!(matches!(saring_sql_guru("UPDATE accounts SET role = 'guru'"), SaringSql::Tolak(_)));
        assert!(matches!(saring_sql_guru("DELETE FROM accounts WHERE id = ?"), SaringSql::Tolak(_)));
        // Hapus kanvas hanya guru utama; setelan diabaikan diam-diam.
        assert!(matches!(saring_sql_guru("DELETE FROM canvases WHERE id = ?"), SaringSql::Tolak(_)));
        assert!(matches!(saring_sql_guru("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"), SaringSql::Abaikan));
        assert!(matches!(saring_sql_guru("DROP TABLE questions"), SaringSql::Tolak(_)));
        assert!(matches!(saring_sql_guru("PRAGMA journal_mode = DELETE"), SaringSql::Tolak(_)));
        // Setelan: hanya baca per kunci, dan sandi admin tidak pernah keluar.
        let q = "SELECT value FROM settings WHERE key = ?";
        assert!(matches!(saring_p(q, &[json!("theme")]), SaringSql::Boleh));
        assert!(matches!(saring_p(q, &[json!("sandi_admin")]), SaringSql::Tolak(_)));
        assert!(matches!(saring_p("SELECT * FROM settings", &[] as &[Value]), SaringSql::Tolak(_)));
        assert!(matches!(saring_p("SELECT value FROM settings WHERE key = 'sandi_admin'", &[]), SaringSql::Tolak(_)));
    }
}

/* ── Tiket masuk Exact Practice (tanpa login) ──────────────────────── */

/// Tiket sekali pakai, berlaku 60 detik: editor (guru utama atau guru
/// pembantu) memintanya, lalu membuka Practice dengan tiket itu; server
/// Practice menukarnya di sini (dengan PIN, dari Mac yang sama) untuk tahu
/// siapa yang datang. Sandi admin tidak pernah ikut ke alamat.
static TIKET: Mutex<Option<std::collections::HashMap<String, (Value, std::time::Instant)>>> = Mutex::new(None);

async fn api_buat_tiket(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    if !sah(&hub, &headers, None) {
        return tolak();
    }
    let identitas = if headers.contains_key("x-exact-admin") && admin_sah(&hub, &headers, None) {
        json!({ "peran": "admin" })
    } else if let Some((id, nama)) = crate::akun::guru_dari_headers(&headers, None) {
        let hp: String = crate::kelas::koneksi()
            .ok()
            .and_then(|c| c.query_row("SELECT phone FROM accounts WHERE id = ?1", rusqlite::params![id], |r| r.get(0)).ok())
            .unwrap_or_default();
        json!({ "peran": "guru", "id": id, "nama": nama, "hp": hp, "disetujui": true })
    } else {
        return tolak_admin();
    };
    let tiket = format!("{}{}", pin_acak(), crate::kelas::acak_tiket());
    let mut g = TIKET.lock().unwrap_or_else(|e| e.into_inner());
    let peta = g.get_or_insert_with(std::collections::HashMap::new);
    peta.retain(|_, (_, t)| t.elapsed().as_secs() < 60);
    peta.insert(tiket.clone(), (identitas, std::time::Instant::now()));
    Json(json!({ "tiket": tiket })).into_response()
}

#[derive(Deserialize)]
struct Tukar {
    tiket: String,
}

async fn api_tukar_tiket(State(hub): State<Arc<Hub>>, headers: HeaderMap, Json(t): Json<Tukar>) -> Response {
    // Hanya server Practice (memegang PIN kelas) yang menukar tiket.
    let pin = headers.get("x-exact-pin").and_then(|v| v.to_str().ok()).unwrap_or("");
    if pin != hub.pin {
        return tolak();
    }
    let mut g = TIKET.lock().unwrap_or_else(|e| e.into_inner());
    let peta = g.get_or_insert_with(std::collections::HashMap::new);
    match peta.remove(&t.tiket) {
        Some((v, dibuat)) if dibuat.elapsed().as_secs() < 60 => Json(v).into_response(),
        _ => (StatusCode::UNAUTHORIZED, "Ticket expired.").into_response(),
    }
}
