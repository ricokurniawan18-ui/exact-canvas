//! Murid yang membuka Canvas lewat Cloudflare padahal duduk di Wi-Fi les.
//!
//! Dari Cloudflare yang terlihat hanya IP publik murid (`CF-Connecting-IP`).
//! Murid di Wi-Fi les keluar ke internet lewat router yang sama dengan Mac,
//! jadi IP publiknya sama dengan IP publik Mac — itu tandanya ia bisa
//! dialihkan ke alamat lokal Mac (tanpa bolak-balik ke server Singapura).
//!
//! Mac bisa tersambung ke beberapa jaringan sekaligus (kabel + Wi-Fi) yang
//! keluar lewat IP publik yang sama; murid hanya bisa menjangkau alamat Mac
//! di jaringannya sendiri, jadi semua jalur dikembalikan beserta namanya
//! (SSID untuk Wi-Fi) dan murid memilih kalau lebih dari satu.

use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct Jalur {
    pub ip: String,
    pub nama: String,
}

struct Peta {
    kapan: Instant,
    publik: Vec<String>,
    jalur: Vec<Jalur>,
}

static PETA: Mutex<Option<Peta>> = Mutex::new(None);
/// IP publik rumahan bisa berganti (router restart), jadi dicek ulang berkala.
const SEGAR: Duration = Duration::from_secs(300);

fn keluaran(prog: &str, args: &[&str]) -> String {
    Command::new(prog)
        .args(args)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// IP publik yang dipakai antarmuka ini untuk keluar ke internet.
fn ip_publik(iface: &str) -> Option<String> {
    let teks = keluaran(
        "/usr/bin/curl",
        &["-s", "-4", "--max-time", "4", "--interface", iface, "https://www.cloudflare.com/cdn-cgi/trace"],
    );
    teks.lines()
        .find_map(|b| b.strip_prefix("ip="))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn ssid(iface: &str) -> Option<String> {
    keluaran("/usr/sbin/ipconfig", &["getsummary", iface])
        .lines()
        .find_map(|b| b.trim().strip_prefix("SSID : ").map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
}

fn segarkan() -> Peta {
    let ifaces: Vec<(String, String)> = (0..8)
        .map(|n| format!("en{n}"))
        .filter_map(|i| {
            let ip = keluaran("/usr/sbin/ipconfig", &["getifaddr", &i]).trim().to_string();
            (!ip.is_empty()).then_some((i, ip))
        })
        .collect();
    // Tiap antarmuka dicek bersamaan: curl yang macet tidak menahan yang lain.
    let hasil: Vec<(String, String, Option<String>, Option<String>)> = std::thread::scope(|s| {
        let tugas: Vec<_> = ifaces
            .iter()
            .map(|(i, ip)| s.spawn(move || (i.clone(), ip.clone(), ip_publik(i), ssid(i))))
            .collect();
        tugas.into_iter().filter_map(|t| t.join().ok()).collect()
    });
    let mut publik: Vec<String> = hasil.iter().filter_map(|h| h.2.clone()).collect();
    publik.sort();
    publik.dedup();
    let mut jalur: Vec<(bool, Jalur)> = hasil
        .into_iter()
        .filter(|h| h.2.is_some())
        .map(|(_, ip, _, ssid)| {
            let wifi = ssid.is_some();
            let nama = ssid.unwrap_or_else(|| {
                let awal: Vec<&str> = ip.split('.').take(3).collect();
                format!("Other Wi-Fi ({}.x)", awal.join("."))
            });
            (wifi, Jalur { ip, nama })
        })
        .collect();
    // Wi-Fi Mac (ber-SSID) didahulukan: paling mungkin sama dengan HP murid.
    jalur.sort_by_key(|(wifi, _)| !*wifi);
    Peta { kapan: Instant::now(), publik, jalur: jalur.into_iter().map(|(_, j)| j).collect() }
}

/// Alamat lokal Mac yang bisa dicoba murid ber-IP publik `ip_klien`;
/// kosong kalau murid tidak di jaringan les. Memanggil curl — jalankan
/// di thread pemblokir.
pub fn untuk(ip_klien: &str) -> Vec<Jalur> {
    let basi = PETA
        .lock()
        .map(|p| p.as_ref().is_none_or(|p| p.kapan.elapsed() > SEGAR))
        .unwrap_or(true);
    if basi {
        let baru = segarkan();
        if let Ok(mut p) = PETA.lock() {
            *p = Some(baru);
        }
    }
    let g = PETA.lock().unwrap_or_else(|e| e.into_inner());
    match g.as_ref() {
        Some(p) if p.publik.iter().any(|x| x == ip_klien.trim()) => p.jalur.clone(),
        _ => Vec::new(),
    }
}

/// Isi peta di latar belakang saat server mulai, supaya tombol pertama cepat.
pub fn panaskan() {
    std::thread::spawn(|| {
        untuk("");
    });
}
