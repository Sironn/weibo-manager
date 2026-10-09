use rusqlite::Connection;
use std::{fs, path::PathBuf};
use tauri::{Manager, RunEvent, WindowEvent};

fn app_data_file(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(name))
}

fn save_window_size(app: &tauri::AppHandle, width: f64, height: f64) {
    if let Some(path) = app_data_file(app, "window-size.json") {
        if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
        if let Ok(json) = serde_json::to_vec(&serde_json::json!({
            "width": width.clamp(980.0, 2400.0),
            "height": height.clamp(640.0, 1800.0)
        })) { let _ = fs::write(path, json); }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(path) = app_data_file(&handle, "window-size.json") {
                if let Ok(raw) = fs::read_to_string(path) {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                        let width = value["width"].as_f64().unwrap_or(1280.0).clamp(980.0, 2400.0);
                        let height = value["height"].as_f64().unwrap_or(820.0).clamp(640.0, 1800.0);
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
                            // The size is restored, but the position is never persisted.
                            let _ = window.center();
                        }
                    }
                }
            }
            if let Some(path) = app_data_file(&handle, "weibo-manager.sqlite3") {
                if let Some(parent) = path.parent() { let _ = fs::create_dir_all(parent); }
                if let Ok(db) = Connection::open(path) {
                    let _ = db.execute_batch(
                        "PRAGMA journal_mode=WAL;
                         CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                         CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL);
                         CREATE TABLE IF NOT EXISTS media_records (media_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, media_type TEXT NOT NULL, local_path TEXT, state TEXT NOT NULL, paired_media_id TEXT);
                         PRAGMA user_version = 1;"
                    );
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Weibo Manager");

    app.run(|app_handle, event| {
        if let RunEvent::WindowEvent { label, event: WindowEvent::Resized(size), .. } = event {
            if let Some(window) = app_handle.get_webview_window(&label) {
                let scale = window.scale_factor().unwrap_or(1.0);
                let logical = size.to_logical::<f64>(scale);
                save_window_size(&app_handle, logical.width, logical.height);
            }
        }
    });
}
