use chrono::Local;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

static LOG_LOCK: Mutex<()> = Mutex::new(());

fn log_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_log_dir().map_err(|e| format!("无法获取日志目录：{e}"))
}

/// 所有前后端日志统一走此入口；关闭开关时不创建、不写入日志文件。
pub fn write_log(app: &AppHandle, level: &str, source: &str, message: &str) -> Result<(), String> {
    if !crate::settings::logging_enabled(app) {
        return Ok(());
    }
    let _guard = LOG_LOCK.lock().map_err(|_| "日志写入锁定失败。".to_string())?;
    let dir = log_dir(app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建日志目录：{e}"))?;
    let now = Local::now();
    let path = dir.join(format!("weibo-manager-{}.log", now.format("%Y-%m-%d")));
    let mut file = OpenOptions::new().create(true).append(true).open(path)
        .map_err(|e| format!("无法打开日志文件：{e}"))?;
    let safe_source = source.replace('\r', " ").replace('\n', " ").replace('\t', " ");
    let safe_message = message.replace('\r', " ").replace('\n', " ");
    writeln!(file, "{} [{}] [{}] {}", now.format("%Y-%m-%d %H:%M:%S%.3f"), level.to_uppercase(), safe_source, safe_message)
        .map_err(|e| format!("无法写入日志文件：{e}"))
}

#[tauri::command]
pub fn get_logging_enabled(app: AppHandle) -> bool {
    crate::settings::logging_enabled(&app)
}

#[tauri::command]
pub fn set_logging_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if !enabled {
        let _ = write_log(&app, "INFO", "settings", "用户关闭了日志记录");
    }
    crate::settings::set_logging_enabled_value(&app, enabled)?;
    if enabled {
        let _ = write_log(&app, "INFO", "settings", "用户开启了日志记录");
    }
    Ok(enabled)
}

#[tauri::command]
pub fn log_message(app: AppHandle, level: String, source: String, message: String) -> Result<(), String> {
    let level = match level.to_lowercase().as_str() {
        "error" => "ERROR",
        "warn" | "warning" => "WARN",
        "debug" => "DEBUG",
        _ => "INFO",
    };
    write_log(&app, level, &source, &message)
}

#[tauri::command]
pub fn open_log_folder(app: AppHandle) -> Result<(), String> {
    let dir = log_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建日志目录：{e}"))?;
    #[cfg(target_os = "windows")]
    let result = Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&dir).spawn();
    result.map(|_| ()).map_err(|e| format!("无法打开日志文件夹：{e}"))
}
