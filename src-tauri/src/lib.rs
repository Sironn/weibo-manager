mod auth;
mod delete;
mod settings;

use rusqlite::Connection;
use std::{fs, path::PathBuf};
use tauri::{Manager, RunEvent, WindowEvent};

fn app_data_file(app: &tauri::AppHandle, name: &str) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(name))
}


pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let saved_settings = settings::load_with_migration(&handle);
            // 启动时从独立配置文件恢复 Cookie；Cookie 不写入日志。
            app.manage(auth::SessionStore::from_saved_cookie(saved_settings.cookie.clone()));
            if let Some(window) = app.get_webview_window("main") {
                let width = saved_settings.window_size.width.unwrap_or(1280.0).clamp(980.0, 2400.0);
                let height = saved_settings.window_size.height.unwrap_or(820.0).clamp(640.0, 1800.0);
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
                // The size is restored, but the position is never persisted.
                let _ = window.center();
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
        .invoke_handler(tauri::generate_handler![
            auth::start_qr_login,
            auth::finish_qr_login,
            auth::is_qr_login_window_open,
            auth::close_qr_login_window,
            auth::import_weibo_cookie,
            auth::get_weibo_account,
            auth::get_weibo_cookie,
            auth::logout_weibo,
            delete::get_delete_posts,
            delete::create_delete_task,
            delete::get_delete_tasks,
            settings::get_config_file_names,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Weibo Manager");

    app.run(|app_handle, event| {
        if let RunEvent::WindowEvent { label, event: WindowEvent::Resized(size), .. } = event {
            // 只保存主窗口尺寸，避免微博扫码登录窗口覆盖主窗口设置。
            if label == "main" {
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let logical = size.to_logical::<f64>(scale);
                    settings::save_window_size(&app_handle, logical.width, logical.height);
                }
            }
        }
    });
}
