//! Jendela: satu jendela kerja `focus`, plus jendela kanvas tambahan
//! `layar-2` … `layar-9` yang bisa dibuka dari dalam kanvas.

use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const FOCUS: &str = "focus";

/// Cocokkan dengan pola di `capabilities/default.json`.
fn label_sah(label: &str) -> bool {
    label == FOCUS
        || label
            .strip_prefix("layar-")
            .and_then(|n| n.parse::<u8>().ok())
            .is_some_and(|n| (2..=9).contains(&n))
}

fn logical_rect(m: &Monitor) -> (LogicalPosition<f64>, LogicalSize<f64>) {
    let s = m.scale_factor();
    let p = m.position();
    let sz = m.size();
    (
        LogicalPosition::new(p.x as f64 / s, p.y as f64 / s),
        LogicalSize::new(sz.width as f64 / s, sz.height as f64 / s),
    )
}

/// Tempatkan jendela di tengah monitor, 82% lebarnya.
fn tengahkan(win: &WebviewWindow, m: &Monitor) {
    let (pos, size) = logical_rect(m);
    let w = (size.width * 0.82).min(1600.0);
    let h = (size.height * 0.86).min(1000.0);
    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.set_position(LogicalPosition::new(
        pos.x + (size.width - w) / 2.0,
        pos.y + (size.height - h) / 2.0,
    ));
}

fn buat(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    let url = WebviewUrl::App("index.html".into());
    WebviewWindowBuilder::new(app, label, url)
        .title("Exact Canvas")
        .inner_size(1440.0, 900.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .visible(false)
        // Penangkap drop asli Tauri hanya mengenali jalur berkas; seretan dari
        // WhatsApp/Foto membawa file promise atau data gambar. Dimatikan supaya
        // drop HTML5 WebKit — yang mengerti keduanya — sampai ke halaman.
        .disable_drag_drop_handler()
        .build()
}

fn atau_buat(app: &AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    match app.get_webview_window(label) {
        Some(w) => Ok(w),
        None => buat(app, label),
    }
}

/// Pengaturan awal: buka jendela kerja di layar utama.
pub fn siapkan(app: &AppHandle) -> tauri::Result<()> {
    let focus = atau_buat(app, FOCUS)?;
    // Hanya tempatkan bila belum pernah — plugin window-state memulihkan
    // posisi terakhir, dan itu yang harus menang.
    // Jendela layar penuh memang berposisi (0,0); jangan diubah ukurannya.
    let penuh = focus.is_fullscreen().unwrap_or(false);
    if !penuh && focus.outer_position().map(|p| p.x == 0 && p.y == 0).unwrap_or(true) {
        if let Some(m) = app.primary_monitor().ok().flatten() {
            tengahkan(&focus, &m);
        }
    }
    let _ = focus.show();
    let _ = focus.set_focus();
    Ok(())
}

#[tauri::command]
pub fn open_window(app: AppHandle, label: String, title: Option<String>) -> Result<(), String> {
    if !label_sah(&label) {
        return Err(format!("Unknown window label: {label}"));
    }
    let baru = app.get_webview_window(&label).is_none();
    let win = atau_buat(&app, &label).map_err(|e| e.to_string())?;
    if let Some(t) = title {
        let _ = win.set_title(&t);
    }
    if baru {
        // Jendela baru mendarat di monitor tempat kursor berada, sedikit
        // bergeser dari jendela kerja supaya keduanya terlihat berbeda.
        let m = app
            .cursor_position()
            .ok()
            .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
            .or_else(|| app.primary_monitor().ok().flatten());
        if let Some(m) = m {
            tengahkan(&win, &m);
        }
    }
    win.show().map_err(|e| e.to_string())?;
    win.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_list(app: AppHandle) -> Vec<String> {
    app.webview_windows()
        .iter()
        .filter(|(_, w)| w.is_visible().unwrap_or(false))
        .map(|(k, _)| k.clone())
        .collect()
}
