use crate::{auth::SessionStore, logger::write_log, settings};
use chrono::DateTime;
use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, fs, path::{Path, PathBuf}, sync::{Arc, Mutex}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "windows")]
use std::os::windows::fs::FileTimesExt;

#[derive(Default)]
pub struct DownloadControl {
    tasks: Mutex<HashMap<u64, Arc<DownloadTaskControl>>>,
}
struct DownloadTaskControl {
    paused: std::sync::atomic::AtomicBool,
    cancelled: std::sync::atomic::AtomicBool,
    running: std::sync::atomic::AtomicBool,
    paused_ack: std::sync::atomic::AtomicBool,
    resume_notify: tokio::sync::Notify,
    pause_ack_notify: tokio::sync::Notify,
}
impl Default for DownloadTaskControl {
    fn default() -> Self { Self {
        paused: std::sync::atomic::AtomicBool::new(false),
        cancelled: std::sync::atomic::AtomicBool::new(false),
        running: std::sync::atomic::AtomicBool::new(false),
        paused_ack: std::sync::atomic::AtomicBool::new(false),
        resume_notify: tokio::sync::Notify::new(),
        pause_ack_notify: tokio::sync::Notify::new(),
    } }
}
/// Cookie 被删除或替换时，取消所有下载任务并解除暂停，避免任务一直卡住。
pub fn cancel_all_downloads(control: &DownloadControl) {
    let tasks = control.tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for task in tasks.values() {
        task.cancelled.store(true, std::sync::atomic::Ordering::Release);
        task.paused.store(false, std::sync::atomic::Ordering::Release);
        task.resume_notify.notify_one();
        task.pause_ack_notify.notify_one();
    }
}
fn task_control(control: &DownloadControl, task_id: u64) -> Arc<DownloadTaskControl> {
    let mut tasks = control.tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    tasks.entry(task_id).or_insert_with(|| Arc::new(DownloadTaskControl::default())).clone()
}
struct DownloadExecutionGuard {
    task: Arc<DownloadTaskControl>,
    _permit: Option<tokio::sync::OwnedSemaphorePermit>,
}
impl Drop for DownloadExecutionGuard {
    fn drop(&mut self) {
        self.task.running.store(false, std::sync::atomic::Ordering::Release);
        self.task.paused_ack.store(false, std::sync::atomic::Ordering::Release);
        self.task.pause_ack_notify.notify_one();
    }
}
#[tauri::command]
pub fn prepare_download_task(task_id: u64, control: State<'_, DownloadControl>) -> Result<(), String> {
    let task = task_control(&control, task_id);
    if task.running.load(std::sync::atomic::Ordering::Acquire) {
        return Err("任务正在执行，不能重置控制状态。".into());
    }
    task.cancelled.store(false, std::sync::atomic::Ordering::Release);
    task.paused.store(false, std::sync::atomic::Ordering::Release);
    task.paused_ack.store(false, std::sync::atomic::Ordering::Release);
    Ok(())
}
async fn wait_download_resume(control: &DownloadTaskControl, guard: &mut DownloadExecutionGuard, gate: &crate::task_execution::TaskExecutionGate) -> Result<(), String> {
    while control.paused.load(std::sync::atomic::Ordering::Acquire) {
        if control.cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已取消。".into()); }
        guard._permit.take();
        control.paused_ack.store(true, std::sync::atomic::Ordering::Release);
        control.pause_ack_notify.notify_one();
        let notified = control.resume_notify.notified();
        if control.cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已取消。".into()); }
        if control.paused.load(std::sync::atomic::Ordering::Acquire) { notified.await; }
        if control.cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已取消。".into()); }
        control.paused_ack.store(false, std::sync::atomic::Ordering::Release);
        let permit = gate.acquire().await?;
        guard._permit = Some(permit);
        if control.cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已取消。".into()); }
    }
    if control.cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已取消。".into()); }
    Ok(())
}
#[tauri::command]
pub async fn set_download_paused(task_id: u64, paused: bool, control: State<'_, DownloadControl>) -> Result<bool, String> {
    let task = task_control(&control, task_id);
    task.paused.store(paused, std::sync::atomic::Ordering::Release);
    if !paused {
        task.resume_notify.notify_one();
        return Ok(task.running.load(std::sync::atomic::Ordering::Acquire));
    }
    loop {
        if task.paused_ack.load(std::sync::atomic::Ordering::Acquire) { return Ok(true); }
        if !task.running.load(std::sync::atomic::Ordering::Acquire) { return Ok(false); }
        let notified = task.pause_ack_notify.notified();
        if task.paused_ack.load(std::sync::atomic::Ordering::Acquire) { return Ok(true); }
        if !task.running.load(std::sync::atomic::Ordering::Acquire) { return Ok(false); }
        notified.await;
    }
}
#[tauri::command]
pub fn cancel_download(task_id: u64, control: State<'_, DownloadControl>) {
    let task = task_control(&control, task_id);
    task.cancelled.store(true, std::sync::atomic::Ordering::Release);
    task.paused.store(false, std::sync::atomic::Ordering::Release);
    task.resume_notify.notify_one();
    task.pause_ack_notify.notify_one();
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTaskConfig {
    pub users: Vec<String>,
    pub download_dir: String,
    pub date_from: String,
    pub date_to: String,
    pub media_type: String,
    pub file_template: String,
    pub folder_template: String,
    #[serde(default)]
    pub modify_file_time: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTaskRecord {
    pub id: u64,
    pub title: String,
    pub state: String,
    pub progress: u8,
    pub detail: String,
    pub created_at: String,
    pub download_config: DownloadTaskConfig,
    #[serde(default)]
    pub download_results: Vec<DownloadSummary>,
}
fn task_db(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    let db = Connection::open(dir.join("weibo-manager.sqlite3")).map_err(|e| format!("无法打开任务数据库：{e}"))?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL);")
        .map_err(|e| format!("初始化任务表失败：{e}"))?;
    Ok(db)
}

#[tauri::command]
pub fn open_download_directory(app: AppHandle, download_dir: String, folder_template: Option<String>, user_name: Option<String>) -> Result<(), String> {
    let root = resolve_download_root(&app, &download_dir)?;
    if !root.is_dir() { return Err(format!("下载根目录不存在或不可访问：{}", root.display())); }
    // 单用户任务直接进入实际存放媒体文件的用户文件夹；多用户任务则打开根目录。
    let path = match (folder_template.as_deref(), user_name.as_deref()) {
        (Some(template), Some(name)) if !name.trim().is_empty() => {
            let user_folder = root.join(replace_template(template, name, "", "", 0, ""));
            if user_folder.is_dir() { user_folder } else { root.clone() }
        }
        _ => root.clone(),
    };
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer").arg(&path).spawn()
        .map_err(|e| format!("无法打开下载目录：{e}"))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&path).spawn()
        .map_err(|e| format!("无法打开下载目录：{e}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    std::process::Command::new("xdg-open").arg(&path).spawn()
        .map_err(|e| format!("无法打开下载目录：{e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn select_download_directory(app: AppHandle) -> Result<Option<String>, String> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected.into_path()
        .map_err(|e| format!("无法读取所选目录：{e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn create_download_task(app: AppHandle, users: Vec<String>, title: String, download_dir: String, date_from: String, date_to: String, media_type: String, modify_file_time: bool, file_template: String, folder_template: String) -> Result<DownloadTaskRecord, String> {
    if users.is_empty() { return Err("请先添加至少一个目标用户。".into()); }
    let config = DownloadTaskConfig { users: users.clone(), download_dir, date_from, date_to, media_type, modify_file_time, file_template, folder_template };
    let mut db = task_db(&app)?;
    // 与删除任务一样，在同一事务中检查并创建，避免连续点击时重复插入。
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("无法锁定下载任务记录：{e}"))?;
    let mut requested_users = config.users.iter().map(|user| user.trim().to_lowercase()).filter(|user| !user.is_empty()).collect::<Vec<_>>();
    requested_users.sort();
    requested_users.dedup();
    {
        let mut statement = tx.prepare("SELECT detail FROM tasks WHERE kind='下载' AND state IN ('未开始','排队中','执行中','已暂停')")
            .map_err(|e| format!("检查重复下载任务失败：{e}"))?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("读取现有下载任务失败：{e}"))?;
        for row in rows {
            let serialized = row.map_err(|e| format!("读取现有下载任务失败：{e}"))?;
            if let Ok(existing) = serde_json::from_str::<DownloadTaskRecord>(&serialized) {
                let mut existing_users = existing.download_config.users.iter().map(|user| user.trim().to_lowercase()).filter(|user| !user.is_empty()).collect::<Vec<_>>();
                existing_users.sort();
                existing_users.dedup();
                let same_scope = requested_users == existing_users
                    && config.download_dir.trim() == existing.download_config.download_dir.trim()
                    && config.date_from == existing.download_config.date_from
                    && config.date_to == existing.download_config.date_to
                    && config.media_type == existing.download_config.media_type;
                if same_scope {
                    return Err("相同目标用户、下载目录和筛选条件的下载任务已存在，请前往任务中心继续处理原任务。".into());
                }
            }
        }
    }
    let task = DownloadTaskRecord {
        id: SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 + 1_000_000_000_000,
        title: title.trim().to_string(), state: "未开始".into(), progress: 0,
        detail: "待启动".into(), created_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(), download_config: config, download_results: Vec::new(),
    };
    let json = serde_json::to_string(&task).map_err(|e| format!("序列化下载任务失败：{e}"))?;
    tx.execute("INSERT INTO tasks (id, kind, state, created_at, detail) VALUES (?1, '下载', ?2, ?3, ?4)",
        params![task.id.to_string(), task.state, task.created_at, json])
        .map_err(|e| format!("保存下载任务失败：{e}"))?;
    tx.commit().map_err(|e| format!("提交下载任务事务失败：{e}"))?;
    Ok(task)
}
#[tauri::command]
pub fn get_download_tasks(app: AppHandle) -> Result<Vec<DownloadTaskRecord>, String> {
    let db = task_db(&app)?;
    let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind='下载' ORDER BY created_at DESC")
        .map_err(|e| format!("读取下载任务失败：{e}"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| format!("读取下载任务失败：{e}"))?;
    let mut tasks = Vec::new();
    for row in rows {
        let raw = row.map_err(|e| format!("读取下载任务失败：{e}"))?;
        if let Ok(task) = serde_json::from_str::<DownloadTaskRecord>(&raw) { tasks.push(task); }
    }
    Ok(tasks)
}
#[tauri::command]
pub fn save_download_task(app: AppHandle, task: DownloadTaskRecord) -> Result<(), String> {
    let json = serde_json::to_string(&task).map_err(|e| format!("序列化下载任务失败：{e}"))?;
    let db = task_db(&app)?;
    db.execute("UPDATE tasks SET state=?2, detail=?3 WHERE id=?1 AND kind='下载'",
        params![task.id.to_string(), task.state, json])
        .map_err(|e| format!("更新下载任务失败：{e}"))?;
    Ok(())
}
#[tauri::command]
pub fn remove_download_tasks(app: AppHandle, task_ids: Vec<u64>, control: State<'_, DownloadControl>) -> Result<Vec<u64>, String> {
    let active_controls = task_ids.iter().map(|id| (*id, task_control(&control, *id))).collect::<Vec<_>>();
    for (_, task) in &active_controls {
        task.cancelled.store(true, std::sync::atomic::Ordering::Release);
        task.paused.store(false, std::sync::atomic::Ordering::Release);
        task.resume_notify.notify_one();
        task.pause_ack_notify.notify_one();
    }
    for (_, task) in &active_controls {
        while task.running.load(std::sync::atomic::Ordering::Acquire) { std::thread::sleep(Duration::from_millis(50)); }
    }
    let mut db = task_db(&app)?;
    let tx = db.transaction().map_err(|e| format!("开始删除下载任务事务失败：{e}"))?;
    let mut removed = Vec::new();
    for id in task_ids {
        if tx.execute("DELETE FROM tasks WHERE id=?1 AND kind='下载'", params![id.to_string()])
            .map_err(|e| format!("删除下载任务失败：{e}"))? > 0 { removed.push(id); }
    }
    tx.commit().map_err(|e| format!("提交下载任务删除失败：{e}"))?;
    let mut controls = control.tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for id in &removed { controls.remove(id); }
    Ok(removed)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedDownloadUser {
    pub uid: String,
    pub screen_name: Option<String>,
}
#[tauri::command]
pub async fn resolve_download_user(store: State<'_, SessionStore>, user_input: String) -> Result<ResolvedDownloadUser, String> {
    let uid = user_id_from_input(&user_input)?;
    let cookie = store.cookie()?;
    if crate::auth::check_cookie_availability(&cookie).await? != "valid" {
        return Err("Cookie 已失效，请重新登录微博后再识别用户昵称。".into());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()
        .map_err(|e| format!("创建用户识别请求失败：{e}"))?;
    let endpoint = format!("https://m.weibo.cn/api/container/getIndex?type=uid&value={uid}&containerid=100505{uid}");
    let response = client.get(endpoint).header(COOKIE, &cookie)
        .header(REFERER, "https://m.weibo.cn/")
        .header(ACCEPT, "application/json, text/plain, */*")
        .header(USER_AGENT, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")
        .send().await.map_err(|e| format!("识别微博用户失败：{e}"))?;
    if !response.status().is_success() { return Err(format!("识别微博用户失败，HTTP {}", response.status().as_u16())); }
    let body: Value = response.json().await.map_err(|e| format!("解析用户资料失败：{e}"))?;
    let screen_name = body.pointer("/data/userInfo/screen_name").and_then(Value::as_str)
        .or_else(|| body.pointer("/data/cards/0/user/screen_name").and_then(Value::as_str))
        .map(str::trim).filter(|name| !name.is_empty()).map(str::to_string);
    Ok(ResolvedDownloadUser { uid, screen_name })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSummary {
    pub user: String,
    pub downloaded: usize,
    pub skipped: usize,
    pub failed: usize,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    task_id: u64,
    user: String,
    completed: usize,
    total: usize,
    media_id: String,
    phase: String,
    detail: String,
}

fn safe_name(value: &str) -> String {
    let name: String = value.chars().map(|c| {
        if c.is_control() || ['<', '>', '"', '/', '\\', '|', '?', '*'].contains(&c) { '-' } else if c == ':' { 'ː' } else { c }
    }).collect();
    let name = name.trim().trim_matches('.').trim();
    if name.is_empty() { "weibo".into() } else { name.chars().take(100).collect() }
}

fn resolve_download_root(app: &AppHandle, requested: &str) -> Result<PathBuf, String> {
    let value = requested.trim();
    if value.is_empty() || value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        let home = app.path().home_dir().map_err(|e| format!("无法获取用户目录：{e}"))?;
        let rest = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")).unwrap_or("");
        let base = if rest.is_empty() { home } else { home.join(rest) };
        return Ok(base);
    }
    let path = PathBuf::from(value);
    if path.is_absolute() { Ok(path) } else {
        let home = app.path().home_dir().map_err(|e| format!("无法获取用户目录：{e}"))?;
        Ok(home.join(path))
    }
}

fn user_id_from_input(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() { return Err("目标用户不能为空。".into()); }
    if trimmed.chars().all(|c| c.is_ascii_digit()) { return Ok(trimmed.to_string()); }
    let url = url::Url::parse(trimmed).map_err(|_| "请输入微博 UID 或包含 UID 的微博主页链接；暂不支持仅凭昵称查找用户。".to_string())?;
    if !matches!(url.host_str(), Some("m.weibo.cn" | "weibo.cn" | "www.weibo.cn" | "weibo.com")) {
        return Err("目前只支持微博主页链接或 UID。".into());
    }
    let id = url.path_segments().and_then(|segments| segments.filter(|s| !s.is_empty()).find(|s| s.chars().all(|c| c.is_ascii_digit())))
        .ok_or_else(|| "微博主页链接中未找到数字 UID；请直接输入 UID。".to_string())?;
    Ok(id.to_string())
}

fn parse_post_time(raw: &str) -> Option<String> {
    DateTime::parse_from_str(raw, "%a %b %d %H:%M:%S %z %Y").ok()
        .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
        .or_else(|| {
            let s = raw.trim();
            if s.len() >= 10 && s.as_bytes().get(4) == Some(&b'-') && s.as_bytes().get(7) == Some(&b'-') {
                Some(s[..10].to_string())
            } else { None }
        })
}

fn parse_post_date(raw: &str) -> Option<String> {
    DateTime::parse_from_str(raw, "%a %b %d %H:%M:%S %z %Y").ok()
        .map(|value| value.format("%Y-%m-%d").to_string())
        .or_else(|| {
            let s = raw.trim();
            if s.len() >= 10 && s.as_bytes().get(4) == Some(&b'-') && s.as_bytes().get(7) == Some(&b'-') {
                Some(s[..10].to_string())
            } else { None }
        })
}

fn ext_from_url(raw: &str, fallback: &str) -> String {
    let path = url::Url::parse(raw).ok().map(|u| u.path().to_string()).unwrap_or_else(|| raw.to_string());
    let ext = Path::new(&path).extension().and_then(|v| v.to_str()).unwrap_or(fallback).to_ascii_lowercase();
    if ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) { ext } else { fallback.into() }
}

fn replace_template(template: &str, user: &str, post_time: &str, post_id: &str, index: usize, ext: &str) -> String {
    let rendered = template
        .replace("%USER_SCREEN_NAME%", user)
        .replace("%POST_TIME%", post_time)
        .replace("%POST_ID%", post_id)
        .replace("%MEDIA_INDEX%", &format!("{index:02}"))
        .replace("%EXT%", &format!(".{ext}"));
    safe_name(&rendered)
}

fn extract_media(post: &Value, requested_type: &str) -> Vec<(String, String, String)> {
    let mut found = Vec::new();
    let mblog = post.get("mblog").unwrap_or(post);
    if requested_type != "video" && requested_type != "livephoto" {
        if let Some(pics) = mblog.get("pics").and_then(Value::as_array) {
            for pic in pics {
                let url = pic.pointer("/large/url").and_then(Value::as_str)
                    .or_else(|| pic.get("url").and_then(Value::as_str));
                if let Some(url) = url.filter(|v| v.starts_with("http")) {
                    found.push((url.to_string(), "image".to_string(), "jpg".to_string()));
                }
            }
        }
        if found.is_empty() {
            if let Some(url) = mblog.get("original_pic").and_then(Value::as_str).filter(|v| v.starts_with("http")) {
                found.push((url.to_string(), "image".to_string(), "jpg".to_string()));
            }
        }
    }
    if requested_type == "all" || requested_type == "video" {
        if let Some(url) = mblog.pointer("/page_info/media_info/stream_url_hd").and_then(Value::as_str)
            .or_else(|| mblog.pointer("/page_info/media_info/stream_url").and_then(Value::as_str))
            .filter(|v| v.starts_with("http")) {
            found.push((url.to_string(), "video".to_string(), "mp4".to_string()));
        }
    }
    if requested_type == "all" || requested_type == "livephoto" {
        if let Some(items) = mblog.get("live_photo").and_then(Value::as_array) {
            for item in items.iter().filter_map(Value::as_str).filter(|v| v.starts_with("http")) {
                let ext = ext_from_url(item, "mov");
                found.push((item.to_string(), "livephoto".to_string(), ext));
            }
        }
    }
    found
}

fn apply_file_times(path: &Path, post_time: &DateTime<chrono::FixedOffset>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let file_time: SystemTime = post_time.to_owned().into();
        let file = fs::File::open(path)
            .map_err(|e| format!("打开文件以设置时间失败：{e}"))?;
        file.set_times(
            std::fs::FileTimes::new()
                .set_created(file_time)
                .set_modified(file_time)
                .set_accessed(file_time),
        ).map_err(|e| format!("设置文件创建、修改和访问时间失败：{e}"))?;
        return Ok("已设置创建、修改和访问时间".into());
    }
    #[cfg(target_os = "macos")]
    {
        let stamp = post_time.format("%Y%m%d%H%M.%S").to_string();
        let touch = std::process::Command::new("touch").args(["-a", "-m", "-t", &stamp]).arg(path).status()
            .map_err(|e| format!("设置访问和修改时间失败：{e}"))?;
        if !touch.success() { return Err("系统未能设置文件访问和修改时间".into()); }
        let setfile_date = post_time.format("%m/%d/%Y %H:%M:%S").to_string();
        match std::process::Command::new("SetFile").args(["-d", &setfile_date, "-m", &setfile_date]).arg(path).status() {
            Ok(status) if status.success() => Ok("已设置创建、修改和访问时间".into()),
            _ => Ok("已设置访问和修改时间；系统未提供可用的 SetFile，创建时间未修改".into()),
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let file_time: std::time::SystemTime = post_time.to_owned().into();
        fs::File::open(path).and_then(|file| file.set_modified(file_time))
            .map_err(|e| format!("设置文件修改时间失败：{e}"))?;
        Ok("已设置修改时间；当前平台未统一设置创建和访问时间".into())
    }
}

#[tauri::command]
pub async fn download_media(
    app: AppHandle,
    store: State<'_, SessionStore>,
    task_id: u64,
    users: Vec<String>,
    download_dir: String,
    date_from: String,
    date_to: String,
    media_type: String,
    file_template: String,
    folder_template: String,
    modify_file_time: bool,
    control: State<'_, DownloadControl>,
    execution_gate: State<'_, crate::task_execution::TaskExecutionGate>,
) -> Result<Vec<DownloadSummary>, String> {
    let task_control = task_control(&control, task_id);
    if task_control.cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已取消。".into()); }
    if task_control.running.compare_exchange(false, true, std::sync::atomic::Ordering::AcqRel, std::sync::atomic::Ordering::Acquire).is_err() {
        return Err("该下载任务已经在执行，不能重复启动。".into());
    }
    let mut _execution_guard = DownloadExecutionGuard { task: task_control.clone(), _permit: None };
    let permit = execution_gate.acquire().await?;
    _execution_guard._permit = Some(permit);
    if task_control.cancelled.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已取消。".into()); }
    if task_control.paused.load(std::sync::atomic::Ordering::Acquire) { return Err("下载任务已暂停。".into()); }
    if users.is_empty() { return Err("请先添加至少一个目标用户。".into()); }
    let cookie = store.cookie()?;
    if crate::auth::check_cookie_availability(&cookie).await? != "valid" {
        return Err("Cookie 已失效，请重新登录微博后再开始下载。".into());
    }
    let root = resolve_download_root(&app, &download_dir)?;
    fs::create_dir_all(&root).map_err(|e| format!("无法创建下载目录：{e}"))?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(45)).redirect(reqwest::redirect::Policy::limited(5)).build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;
    let media_filter = match media_type.as_str() {
        "images" => "images", "videos" => "video", "livephoto" => "livephoto", _ => "all",
    };
    let mut summaries = Vec::new();

    for input in users {
        let uid = match user_id_from_input(&input) {
            Ok(id) => id,
            Err(error) => {
                summaries.push(DownloadSummary { user: input, downloaded: 0, skipped: 0, failed: 1, detail: error });
                continue;
            }
        };
        let mut downloaded = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;
        let mut page = 1usize;
        let mut since_id = String::new();
        let mut empty_pages = 0usize;
        let mut display_name = uid.clone();
        let mut user_folder = root.join(safe_name(&replace_template(&folder_template, &uid, "", "", 0, "")));
        let mut total = 0usize;

        loop {
            wait_download_resume(&task_control, &mut _execution_guard, &execution_gate).await?;
            if page > 100 { break; }
            let endpoint = format!("https://m.weibo.cn/api/container/getIndex?type=uid&value={uid}&containerid=107603{uid}");
            let mut request = client.get(&endpoint)
                .header(COOKIE, &cookie)
                .header(REFERER, "https://m.weibo.cn/")
                .header(ACCEPT, "application/json, text/plain, */*")
                .header(USER_AGENT, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
            if !since_id.is_empty() {
                request = request.query(&[("since_id", since_id.as_str())]);
            }
            let response = request.send().await
                .map_err(|e| format!("读取用户 {uid} 第 {page} 页失败：{e}"))?;
            if !response.status().is_success() {
                return Err(format!("读取用户 {uid} 失败：微博返回 HTTP {}。", response.status()));
            }
            let body: Value = response.json().await.map_err(|e| format!("解析用户 {uid} 的微博数据失败：{e}"))?;
            let api_ok = body.get("ok").and_then(|v| {
                v.as_i64().map(|n| n == 1).or_else(|| v.as_str().map(|s| s == "1"))
            }).unwrap_or(false);
            if !api_ok {
                let api_message = body.get("msg").and_then(Value::as_str)
                    .or_else(|| body.pointer("/data/msg").and_then(Value::as_str))
                    .unwrap_or("接口未提供错误说明");
                // 参考 WeiboAlbumDownloader：移动端时间线通过 since_id 游标翻页。
                // 到达末尾时接口可能返回“这里还没有内容”，这是正常结束而不是下载失败。
                if page > 1 && (api_message.contains("这里还没有内容") || api_message.contains("暂无数据")) {
                    break;
                }
                let api_code = body.get("errno").or_else(|| body.get("error_code"))
                    .map(Value::to_string).unwrap_or_else(|| "未知".into());
                return Err(format!("读取用户 {uid} 第 {page} 次请求失败：微博接口拒绝请求（错误码 {api_code}，说明：{api_message}）。请确认 UID 正确且 Cookie 仍有效。"));
            }
            let next_since_id = body.pointer("/data/cardlistInfo/since_id").and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| body.pointer("/data/cardlistInfo/since_id").and_then(Value::as_i64).map(|id| id.to_string()))
                .unwrap_or_default();
            let cards = body.pointer("/data/cards").and_then(Value::as_array).cloned().unwrap_or_default();
            let cards_empty = cards.is_empty();
            let cursor_unchanged = !next_since_id.is_empty() && next_since_id == since_id;
            let mut posts_this_page = 0usize;
            for card in cards {
                let Some(post) = card.get("mblog") else { continue; };
                let post_id = post.get("id").and_then(Value::as_str).map(str::to_string)
                    .or_else(|| post.get("id").and_then(Value::as_i64).map(|id| id.to_string()))
                    .unwrap_or_default();
                if post_id.is_empty() { continue; }
                let post_time = post.get("created_at").and_then(Value::as_str).and_then(parse_post_time).unwrap_or_default();
                let post_date = post_time.get(..10).unwrap_or(&post_time).to_string();
                if !date_from.is_empty() && !post_date.is_empty() && post_date < date_from { continue; }
                if !date_to.is_empty() && !post_date.is_empty() && post_date > date_to { continue; }
                let name = post.pointer("/user/screen_name").and_then(Value::as_str).unwrap_or(&uid);
                if display_name == uid {
                    display_name = name.to_string();
                    user_folder = root.join(safe_name(&replace_template(&folder_template, &display_name, "", "", 0, "")));
                    fs::create_dir_all(&user_folder).map_err(|e| format!("无法创建用户目录：{e}"))?;
                }
                let mut media = extract_media(&card, media_filter);
                for (url, kind, ext) in media.drain(..) {
                    wait_download_resume(&task_control, &mut _execution_guard, &execution_gate).await?;
                    total += 1;
                    let filename = replace_template(&file_template, &display_name, &post_time, &post_id, total, &ext);
                    let target = user_folder.join(filename);
                    if target.exists() {
                        skipped += 1;
                        continue;
                    }
                    let media_id = url::Url::parse(&url).ok().and_then(|parsed| parsed.path_segments().and_then(|segments| segments.filter(|part| !part.is_empty()).last().map(str::to_string))).unwrap_or_default();
                    let _ = app.emit("download-progress", DownloadProgress {
                        task_id, user: display_name.clone(), completed: downloaded + skipped + failed, total: 0,
                        media_id: media_id.clone(), phase: "downloading".into(),
                        detail: if media_id.is_empty() { "正在下载媒体".into() } else { format!("正在下载 媒体文件 {media_id}") },
                    });
                    let result = client.get(&url).header(REFERER, "https://m.weibo.cn/")
                        .header(USER_AGENT, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")
                        .send().await;
                    match result {
                        Ok(response) if response.status().is_success() => {
                            match response.bytes().await {
                                Ok(bytes) if !bytes.is_empty() => {
                                    if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| format!("创建媒体目录失败：{e}"))?; }
                                    if let Err(e) = fs::write(&target, &bytes) {
                                        failed += 1;
                                        let _ = write_log(&app, "ERROR", "download", &format!("保存媒体文件失败：{e}"));
                                        continue;
                                    }
                                    downloaded += 1;
                                    if modify_file_time {
                                        let post_time_value = post.get("created_at").and_then(Value::as_str).and_then(|raw| DateTime::parse_from_str(raw, "%a %b %d %H:%M:%S %z %Y").ok());
                                        if let Some(timestamp) = post_time_value {
                                            match apply_file_times(&target, &timestamp) {
                                                Ok(message) => { let _ = write_log(&app, "INFO", "download", &format!("微博文件时间处理结果：{message}")); }
                                                Err(error) => { let _ = write_log(&app, "WARN", "download", &format!("设置微博文件时间失败，保留系统支持的默认值：{error}")); }
                                            }
                                        } else {
                                            let _ = write_log(&app, "WARN", "download", "微博接口未返回可解析的完整发布时间，文件时间保留系统时间");
                                        }
                                    }
                                }
                                _ => failed += 1,
                            }
                        }
                        Ok(response) => {
                            failed += 1;
                            let _ = write_log(&app, "WARN", "download", &format!("媒体下载失败，HTTP {}，类型 {kind}", response.status()));
                        }
                        Err(error) => {
                            failed += 1;
                            let _ = write_log(&app, "WARN", "download", &format!("媒体请求失败：{error}"));
                        }
                    }
                    let _ = app.emit("download-progress", DownloadProgress {
                        task_id, user: display_name.clone(), completed: downloaded + skipped + failed, total: 0,
                        media_id, phase: "completed".into(),
                        detail: format!("已下载 {downloaded}，跳过 {skipped}，失败 {failed}"),
                    });
                }
                posts_this_page += 1;
            }
            if posts_this_page == 0 { empty_pages += 1; } else { empty_pages = 0; }
            if empty_pages >= 2 || cards_empty || next_since_id.is_empty() || cursor_unchanged { break; }
            since_id = next_since_id;
            page += 1;
            let delay = Duration::from_millis(settings::request_delay_ms(&app));
            let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(delay)).await;
        }
        summaries.push(DownloadSummary {
            user: display_name.clone(), downloaded, skipped, failed,
            detail: format!("完成：下载 {downloaded}，跳过 {skipped}，失败 {failed}"),
        });
        let _ = write_log(&app, "INFO", "download", &format!("用户 {uid} 下载结束：下载 {downloaded}，跳过 {skipped}，失败 {failed}"));
    }
    Ok(summaries)
}
