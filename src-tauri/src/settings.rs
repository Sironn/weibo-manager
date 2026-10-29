use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};

static APP_SETTINGS_LOCK: Mutex<()> = Mutex::new(());
static COOKIE_LOCK: Mutex<()> = Mutex::new(());
static WINDOW_SIZE_LOCK: Mutex<()> = Mutex::new(());
const CONFIG_DIRECTORY: &str = "config";
const COOKIE_FILE_NAME: &str = "Cookie.json";
const WINDOW_SIZE_FILE_NAME: &str = "window-size.json";
const APP_SETTINGS_FILE_NAME: &str = "app-settings.json";

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WindowSize {
    #[serde(default, skip_serializing_if = "Option::is_none")] pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub height: Option<f64>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileNames { pub cookie_file: String, pub window_size_file: String, pub app_settings_file: String }
#[derive(Debug, Default, Serialize, Deserialize)]
struct CookieData { #[serde(default, skip_serializing_if = "Option::is_none")] cookie: Option<String> }
pub struct StartupSettings { pub cookie: Option<String>, pub window_size: WindowSize }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestIntervalConfig {
    pub mode: String,
    pub fixed_ms: u64,
    pub min_ms: u64,
    pub max_ms: u64,
}
impl Default for RequestIntervalConfig {
    fn default() -> Self { Self { mode: "fixed".into(), fixed_ms: 1200, min_ms: 1000, max_ms: 2000 } }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilenameSettings {
    pub file_template: String,
    pub folder_template: String,
}
impl Default for FilenameSettings {
    fn default() -> Self {
        Self { file_template: "%USER_SCREEN_NAME% [%POST_TIME%] %POST_ID%_%MEDIA_INDEX%%EXT%".into(), folder_template: "%USER_SCREEN_NAME%".into() }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_theme")] pub theme: String,
    #[serde(default)] pub filename_settings: FilenameSettings,
    #[serde(default)] pub download_directory: String,
    #[serde(default)] pub request_interval: RequestIntervalConfig,
    #[serde(default)] pub logging_enabled: bool,
}
fn default_theme() -> String { "system".into() }
impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            filename_settings: FilenameSettings::default(),
            download_directory: String::new(),
            request_interval: RequestIntervalConfig::default(),
            logging_enabled: false,
        }
    }
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| format!("无法获取应用数据目录：{e}"))
}
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> { Ok(app_data_dir(app)?.join(CONFIG_DIRECTORY)) }
fn cookie_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(config_dir(app)?.join(COOKIE_FILE_NAME)) }
fn window_size_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(config_dir(app)?.join(WINDOW_SIZE_FILE_NAME)) }
fn app_settings_path(app: &AppHandle) -> Result<PathBuf, String> { Ok(config_dir(app)?.join(APP_SETTINGS_FILE_NAME)) }
fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    fs::read_to_string(path).ok().and_then(|raw| serde_json::from_str::<T>(&raw).ok()).unwrap_or_default()
}
fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "配置文件路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("无法创建配置目录：{e}"))?;
    let json = serde_json::to_vec_pretty(value).map_err(|e| format!("无法序列化配置：{e}"))?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, json).map_err(|e| format!("无法写入本地配置：{e}"))?;
    fs::rename(&temp_path, path).map_err(|e| format!("无法保存本地配置：{e}"))
}
fn clamp_window_size(mut size: WindowSize) -> WindowSize {
    size.width = size.width.map(|v| v.clamp(980.0, 2400.0));
    size.height = size.height.map(|v| v.clamp(640.0, 1800.0));
    size
}
fn read_app_settings_unlocked(app: &AppHandle) -> AppSettings {
    app_settings_path(app).map(|path| read_json(&path)).unwrap_or_default()
}
fn write_app_settings_unlocked(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    write_json(&app_settings_path(app)?, settings)
}
fn update_app_settings(app: &AppHandle, update: impl FnOnce(&mut AppSettings)) -> Result<AppSettings, String> {
    let _guard = APP_SETTINGS_LOCK.lock().map_err(|_| "本地配置锁定失败，请重启应用后重试。".to_string())?;
    let mut settings = read_app_settings_unlocked(app);
    update(&mut settings);
    write_app_settings_unlocked(app, &settings)?;
    Ok(settings)
}

/// 启动时只读取当前配置文件，不执行旧版配置迁移。
pub fn load_startup_settings(app: &AppHandle) -> StartupSettings {
    let cookie = cookie_path(app).ok().map(|path| read_json::<CookieData>(&path).cookie).flatten();
    let window_size = window_size_path(app).map(|path| clamp_window_size(read_json(&path))).unwrap_or_default();
    StartupSettings { cookie, window_size }
}
pub fn save_cookie(app: &AppHandle, cookie: Option<&str>) -> Result<(), String> {
    let _guard = COOKIE_LOCK.lock().map_err(|_| "Cookie 配置锁定失败，请重启应用后重试。".to_string())?;
    write_json(&cookie_path(app)?, &CookieData { cookie: cookie.map(str::to_owned) })
}
pub fn save_window_size(app: &AppHandle, width: f64, height: f64) {
    let Ok(_guard) = WINDOW_SIZE_LOCK.lock() else { return; };
    let Ok(path) = window_size_path(app) else { return; };
    let size = WindowSize { width: Some(width.clamp(980.0, 2400.0)), height: Some(height.clamp(640.0, 1800.0)) };
    let _ = write_json(&path, &size);
}

#[tauri::command]
pub fn get_config_file_names() -> ConfigFileNames {
    ConfigFileNames {
        cookie_file: COOKIE_FILE_NAME.to_string(),
        window_size_file: WINDOW_SIZE_FILE_NAME.to_string(),
        app_settings_file: APP_SETTINGS_FILE_NAME.to_string(),
    }
}
#[tauri::command]
pub fn get_app_settings(app: AppHandle) -> AppSettings {
    read_app_settings_unlocked(&app)
}
#[tauri::command]
pub fn save_app_setting(app: AppHandle, key: String, value: Value) -> Result<AppSettings, String> {
    update_app_settings(&app, |settings| match key.as_str() {
        "theme" => {
            if let Some(theme) = value.as_str().filter(|v| ["system", "light", "dark"].contains(v)) {
                settings.theme = theme.to_string();
            }
        }
        "filenameSettings" => {
            if let Ok(filename_settings) = serde_json::from_value::<FilenameSettings>(value) {
                settings.filename_settings = filename_settings;
            }
        }
        "downloadDirectory" => {
            if let Some(path) = value.as_str() { settings.download_directory = path.trim().to_string(); }
        }
        "requestInterval" => {
            if let Ok(mut config) = serde_json::from_value::<RequestIntervalConfig>(value) {
                config.fixed_ms = config.fixed_ms.clamp(500, 30000);
                config.min_ms = config.min_ms.clamp(500, 30000);
                config.max_ms = config.max_ms.clamp(config.min_ms, 60000);
                if config.mode != "random" { config.mode = "fixed".into(); }
                settings.request_interval = config;
            }
        }
        "loggingEnabled" => {
            if let Some(enabled) = value.as_bool() { settings.logging_enabled = enabled; }
        }
        _ => {}
    })
}

#[tauri::command]
pub fn get_download_directory(app: AppHandle) -> Option<String> {
    let value = read_app_settings_unlocked(&app).download_directory.trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}
#[tauri::command]
pub fn save_download_directory(app: AppHandle, path: String) -> Result<String, String> {
    let path = path.trim().to_string();
    if path.is_empty() { return Err("下载目录不能为空。".into()); }
    update_app_settings(&app, |settings| settings.download_directory = path.clone())?;
    Ok(path)
}
#[tauri::command]
pub fn get_request_interval(app: AppHandle) -> RequestIntervalConfig {
    read_app_settings_unlocked(&app).request_interval
}
#[tauri::command]
pub fn save_request_interval(app: AppHandle, config: RequestIntervalConfig) -> Result<RequestIntervalConfig, String> {
    let settings = update_app_settings(&app, |settings| {
        let mut config = config;
        config.fixed_ms = config.fixed_ms.clamp(500, 30000);
        config.min_ms = config.min_ms.clamp(500, 30000);
        config.max_ms = config.max_ms.clamp(config.min_ms, 60000);
        if config.mode != "random" { config.mode = "fixed".into(); }
        settings.request_interval = config;
    })?;
    Ok(settings.request_interval)
}
pub fn logging_enabled(app: &AppHandle) -> bool { read_app_settings_unlocked(app).logging_enabled }
pub fn set_logging_enabled_value(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    update_app_settings(app, |settings| settings.logging_enabled = enabled)?;
    Ok(enabled)
}
/// 供列表读取、下载及其他网络模块复用的统一请求间隔。
pub fn request_delay_ms(app: &AppHandle) -> u64 {
    let config = get_request_interval(app.clone());
    if config.mode != "random" { return config.fixed_ms; }
    let min = config.min_ms;
    let span = config.max_ms.saturating_sub(min);
    if span == 0 { return min; }
    let seed = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default().as_nanos() as u64;
    min + seed % (span + 1)
}
