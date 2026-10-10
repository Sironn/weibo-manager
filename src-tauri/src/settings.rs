use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Mutex};

static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cookie: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir()
        .map(|dir| dir.join("Settings.json"))
        .map_err(|error| format!("无法获取应用数据目录：{error}"))
}

fn read_path(path: &PathBuf) -> AppSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<AppSettings>(&raw).ok())
        .unwrap_or_default()
}

fn write_path(path: &PathBuf, settings: &AppSettings) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| "配置文件路径无效。".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建配置目录：{error}"))?;
    let json = serde_json::to_vec_pretty(settings).map_err(|error| format!("无法序列化应用设置：{error}"))?;
    fs::write(path, json).map_err(|error| format!("无法保存 Settings.json：{error}"))
}

/// 迁移旧版窗口尺寸；只有写入 Settings.json 成功后才删除旧文件。
pub fn load_with_migration(app: &AppHandle) -> AppSettings {
    let Ok(path) = settings_path(app) else { return AppSettings::default(); };
    let mut settings = read_path(&path);
    let legacy_path = path.with_file_name("window-size.json");
    if let Ok(raw) = fs::read_to_string(&legacy_path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if settings.width.is_none() {
                settings.width = value["width"].as_f64().map(|v| v.clamp(980.0, 2400.0));
            }
            if settings.height.is_none() {
                settings.height = value["height"].as_f64().map(|v| v.clamp(640.0, 1800.0));
            }
            if write_path(&path, &settings).is_ok() {
                let _ = fs::remove_file(legacy_path);
            }
        }
    }
    settings
}

pub fn update(app: &AppHandle, update: impl FnOnce(&mut AppSettings)) -> Result<(), String> {
    let _guard = SETTINGS_LOCK.lock().map_err(|_| "应用设置锁定失败，请重启应用后重试。".to_string())?;
    let path = settings_path(app)?;
    let mut settings = read_path(&path);
    update(&mut settings);
    write_path(&path, &settings)
}

pub fn save_window_size(app: &AppHandle, width: f64, height: f64) {
    let _ = update(app, |settings| {
        settings.width = Some(width.clamp(980.0, 2400.0));
        settings.height = Some(height.clamp(640.0, 1800.0));
    });
}
