use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
const CONFIG_DIRECTORY: &str = "config";
const COOKIE_FILE_NAME: &str = "Cookie.json";
const WINDOW_SIZE_FILE_NAME: &str = "window-size.json";
const LEGACY_SETTINGS_FILE_NAME: &str = "Settings.json";
#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub height: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileNames { pub cookie_file: String, pub window_size_file: String }
#[derive(Debug, Default, Serialize, Deserialize)]
struct CookieData { #[serde(default, skip_serializing_if = "Option::is_none")] cookie: Option<String> }
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySettings { cookie: Option<String>, width: Option<f64>, height: Option<f64> }
#[derive(Debug, Default, Serialize, Deserialize)]
struct LegacyWindowSize { width: Option<f64>, height: Option<f64> }
pub struct StartupSettings { pub cookie: Option<String>, pub window_size: WindowSize }
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> { app.path().app_data_dir().map_err(|e| format!("无法获取应用数据目录：{e}")) }
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_data_dir(app)?.join(CONFIG_DIRECTORY)) }
fn cookie_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(config_dir(app)?.join(COOKIE_FILE_NAME)) }
fn window_size_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(config_dir(app)?.join(WINDOW_SIZE_FILE_NAME)) }
fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str::<T>(&raw).ok()).unwrap_or_default()
}
fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "配置文件路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录：{e}"))?;
    let json = serde_json::to_vec_pretty(value).map_err(|e| format!("无法序列化配置：{e}"))?;
    fs::write(path, json).map_err(|e| format!("无法写入本地配置：{e}"))
}
fn clamp_window_size(mut size: WindowSize) -> WindowSize {
    size.width = size.width.map(|v| v.clamp(980.0, 2400.0));
    size.height = size.height.map(|v| v.clamp(640.0, 1800.0));
    size
}
/// 将旧版 Settings.json 与根目录的 window-size.json 迁移到统一 config 目录。
/// 旧文件仅在新配置安全落盘后删除。
pub fn load_with_migration(app: &AppHandle) -> StartupSettings {
    let fallback = StartupSettings { cookie: None, window_size: WindowSize::default() };
    let Ok(root) = app_data_dir(app) else { return fallback; };
    let Ok(cookie_file) = cookie_path(app) else { return fallback; };
    let Ok(size_file) = window_size_path(app) else { return fallback; };
    let old_settings_path = root.join(LEGACY_SETTINGS_FILE_NAME);
    let old_size_path = root.join(WINDOW_SIZE_FILE_NAME);
    let old_settings_exists = old_settings_path.exists();
    let old_settings: LegacySettings = read_json(&old_settings_path);
    let old_size: LegacyWindowSize = read_json(&old_size_path);
    let cookie_exists = cookie_file.exists();
    let size_exists = size_file.exists();
    let current_cookie: CookieData = read_json(&cookie_file);
    let mut size: WindowSize = read_json(&size_file);
    if size.width.is_none() { size.width = old_settings.width.or(old_size.width); }
    if size.height.is_none() { size.height = old_settings.height.or(old_size.height); }
    size = clamp_window_size(size);
    let cookie = if cookie_exists { current_cookie.cookie } else { old_settings.cookie.clone() };
    let cookie_ok = if !cookie_exists && old_settings_exists {
        write_json(&cookie_file, &CookieData { cookie: cookie.clone() }).is_ok()
    } else { true };
    let size_ok = if !size_exists && (old_settings_exists || old_size_path.exists()) {
        write_json(&size_file, &size).is_ok()
    } else { true };
    if old_settings_exists && cookie_ok && size_ok { let _ = fs::remove_file(&old_settings_path); }
    if old_size_path.exists() && size_ok { let _ = fs::remove_file(&old_size_path); }
    StartupSettings { cookie, window_size: size }
}
pub fn save_cookie(app: &AppHandle, cookie: Option<&str>) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| "本地配置锁定失败，请重启应用后重试。".to_string())?;
    write_json(&cookie_path(app)?, &CookieData { cookie: cookie.map(str::to_owned) })
}
pub fn save_window_size(app: &AppHandle, width: f64, height: f64) {
    let Ok(_guard) = SETTINGS_LOCK.lock() else { return; };
    let Ok(path) = window_size_path(app) else { return; };
    let size = WindowSize { width: Some(width.clamp(980.0, 2400.0)), height: Some(height.clamp(640.0, 1800.0)) };
    let _ = write_json(&path, &size);
}
/// 返回界面说明使用的文件名，避免在多个界面写死。
#[tauri::command]
pub fn get_config_file_names() -> ConfigFileNames {
    ConfigFileNames { cookie_file: COOKIE_FILE_NAME.to_string(), window_size_file: WINDOW_SIZE_FILE_NAME.to_string() }
}
