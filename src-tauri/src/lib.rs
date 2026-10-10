//! Exact Canvas — kanvas sketsa Wacom, local-first.
//! Seluruh data ada di folder vault milik pengguna.

mod akun;
mod db;
mod kelas;
mod menu;
mod office;
mod server;
mod vault;
mod windows;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Kalau vault ada di iCloud, turunkan dulu isinya: database yang isinya
    // masih di awan tampak seperti berkas yang tidak ada.
    vault::siapkan_icloud();
    if let Err(e) = vault::ensure_layout() {
        eprintln!("[vault] gagal menyiapkan folder: {e}");
    }
    // WAL: penulis (mis. foto pertanyaan murid) tidak lagi mengunci pembaca —
    // penting saat beberapa anak mengirim hampir bersamaan lewat HTTP.
    match rusqlite::Connection::open(vault::db_path()) {
        Ok(c) => {
            if let Err(e) = c.pragma_update(None, "journal_mode", "WAL") {
                eprintln!("[db] gagal mengaktifkan WAL: {e}");
            }
        }
        Err(e) => eprintln!("[db] gagal membuka database untuk WAL: {e}"),
    }
    let db_url = vault::db_url();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(&db_url, db::migrations())
                .build(),
        )
        // Keadaan layar penuh TIDAK dipulihkan: jendela yang dibuka langsung dalam
        // layar penuh lalu ditengahkan oleh windows::siapkan tampil rusak.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::FULLSCREEN)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            vault::vault_info,
            vault::vault_set_root,
            vault::app_restart,
            vault::canvas_list,
            vault::canvas_read,
            vault::canvas_write,
            vault::canvas_delete,
            vault::write_bytes,
            office::office_convert,
            office::print_pdf,
            office::dropped_bytes,
            windows::open_window,
            windows::window_list,
            server::share_start,
            server::share_stop,
            server::share_status,
            server::share_qr,
            server::share_set_public,
            server::share_set_admin,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let daftar_menu = menu::buat_menu(&handle)?;
            app.set_menu(daftar_menu)?;
            app.on_menu_event(|app, event| menu::tangani(app, event.id().as_ref()));
            menu::buat_tray(&handle)?;
            windows::siapkan(&handle)?;
            // Kanvas yang sudah lama tidak disentuh disingkirkan — sesaat
            // setelah aplikasi menyala dan tiap jam sesudahnya. Jalan di sini,
            // bukan di server berbagi, supaya tetap terjadi walau berbagi mati.
            let latar = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                loop {
                    let dihapus = tokio::task::spawn_blocking(kelas::hapus_kanvas_lama).await.unwrap_or_default();
                    if !dihapus.is_empty() {
                        // Daftar sketsa di jendela Mac dan di layar lain
                        // (tablet, TV) menyegarkan diri; `hapus` membuat editor
                        // yang sedang membuka salah satunya tidak memuat ulang.
                        let payload = serde_json::json!({ "src": "server", "hapus": true, "ids": dihapus });
                        let _ = latar.emit("data:canvas", payload.clone());
                        server::siarkan(serde_json::json!({ "t": "data", "kanal": "canvas", "payload": payload }).to_string());
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Menutup jendela kerja hanya menyembunyikannya, supaya simpanan
            // yang masih tertunda sempat mendarat. Keluar lewat ⌘Q.
            if window.label() == windows::FOCUS {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // Menyembunyikan jendela yang sedang layar penuh menyisakan
                    // Space hitam di macOS: keluar layar penuh dulu, tunggu
                    // animasinya selesai, baru sembunyikan.
                    if window.is_fullscreen().unwrap_or(false) {
                        let _ = window.set_fullscreen(false);
                        let w = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(900));
                            let _ = w.hide();
                        });
                    } else {
                        let _ = window.hide();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("gagal menjalankan Exact Canvas")
        .run(|app, event| {
            // Klik ikon di Dock setelah jendela disembunyikan.
            if let RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window(windows::FOCUS) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        });
}
