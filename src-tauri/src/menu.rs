//! Menu aplikasi macOS.
//!
//! Apa pun yang hanya menyangkut jendela atau berkas dikerjakan di Rust; apa
//! pun yang mengubah tampilan (sketsa baru, cetak, tema, pengaturan) diteruskan
//! ke jendela kerja lewat event `ui:menu`.

use tauri::{
    menu::{AboutMetadata, Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager, Wry,
};

use crate::{vault, windows};

const TEMA: [(&str, &str); 18] = [
    ("kaca", "Glass"),
    ("kertas", "Paper"),
    ("klasik", "Classic"),
    ("anggun", "Elegant"),
    ("mutiara", "Pearl"),
    ("tanah", "Terracotta"),
    ("rimba", "Woodland"),
    ("mochi", "Mochi"),
    ("piksel", "8-Bit"),
    ("grimoire", "Grimoire"),
    ("arsip", "Archive"),
    ("batik", "Indigo Batik"),
    ("fosfor", "Phosphor"),
    ("senja", "Dusk"),
    ("laut", "Seabed"),
    ("samudra", "High Seas"),
    ("permen", "Candy"),
    ("arena", "Arena"),
];

fn tentang() -> AboutMetadata<'static> {
    AboutMetadata {
        name: Some("Exact Canvas".into()),
        version: Some(env!("CARGO_PKG_VERSION").into()),
        copyright: Some("© Exact Group".into()),
        comments: Some("Wacom sketching canvas. Local-first.".into()),
        ..Default::default()
    }
}

pub fn buat_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let aplikasi = SubmenuBuilder::new(app, "Exact Canvas")
        .about(Some(tentang()))
        .separator()
        .item(
            &MenuItemBuilder::new("Settings…")
                .id("aksi:pengaturan")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let berkas = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::new("New sketch")
                .id("aksi:sketsa-baru")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::new("New canvas window")
                .id("window:baru")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            // Menu yang memegang ⌘P: WKWebView tidak selalu meneruskan
            // pintasan ber-Command ke web, dan butir menu tidak pernah meleset.
            &MenuItemBuilder::new("Print sketch…")
                .id("aksi:cetak")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::new("Open vault folder")
                .id("aksi:vault")
                .build(app)?,
        )
        .build()?;

    let ubah = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let mut tema = SubmenuBuilder::new(app, "Theme");
    for (id, label) in TEMA {
        tema = tema.item(&MenuItemBuilder::new(label).id(format!("tema:{id}")).build(app)?);
    }
    let tema = tema
        .separator()
        .item(
            &MenuItemBuilder::new("Next theme")
                .id("tema:siklus")
                .accelerator("CmdOrCtrl+Shift+T")
                .build(app)?,
        )
        .build()?;

    let tampilan = SubmenuBuilder::new(app, "View").item(&tema).build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .item(&MenuItemBuilder::new("Main window").id("window:focus").build(app)?)
        .separator()
        .minimize()
        // "Enter Full Screen" sengaja tidak dipasang: layar penuh macOS sering
        // menyisakan layar hitam saat jendela kerja disembunyikan.
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&aplikasi, &berkas, &ubah, &tampilan, &window])
        .build()
}

/// Teruskan ke jendela kerja. Kalau sedang tersembunyi, munculkan dulu.
fn ke_ui(app: &AppHandle, id: &str) {
    if let Some(w) = app.get_webview_window(windows::FOCUS) {
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit_to(windows::FOCUS, "ui:menu", id.to_string());
}

/// Ikon di menu bar: aplikasi tetap melayani TV dan HP murid walau jendelanya
/// ditutup, jadi harus ada tanda yang terlihat bahwa ia masih hidup — dan satu
/// jalan kembali ke jendelanya tanpa lewat Dock.
pub fn buat_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let buka = MenuItem::with_id(app, "tray:buka", "Buka Exact Canvas", true, None::<&str>)?;
    let pisah = PredefinedMenuItem::separator(app)?;
    let keluar = PredefinedMenuItem::quit(app, Some("Keluar"))?;
    let daftar = Menu::with_items(app, &[&buka, &pisah, &keluar])?;

    let mut b = TrayIconBuilder::with_id("utama").menu(&daftar).tooltip("Exact Canvas");
    if let Some(ikon) = app.default_window_icon().cloned() {
        b = b.icon(ikon);
    }
    b.on_menu_event(|app, e| tangani(app, e.id().as_ref())).build(app)?;
    Ok(())
}

pub fn tangani(app: &AppHandle, id: &str) {
    match id {
        // Sama dengan "window:focus", tapi dinamai sendiri supaya jelas dari
        // mana datangnya kalau nanti ada yang perlu dibedakan.
        "tray:buka" => {
            let _ = windows::open_window(app.clone(), windows::FOCUS.into(), None);
        }
        "aksi:vault" => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().reveal_item_in_dir(vault::root());
        }
        "window:focus" => {
            let _ = windows::open_window(app.clone(), windows::FOCUS.into(), None);
        }
        lain => ke_ui(app, lain),
    }
}
