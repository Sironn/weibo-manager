//! 取消点赞：点赞列表的只读读取与取消点赞任务记录。
//! 列表读取与取消操作都使用 weibo.com 的 JSON 接口，取消操作需要与 Cookie 配对的 XSRF 令牌。

use reqwest::header::{ACCEPT, CONTENT_TYPE, COOKIE, REFERER, USER_AGENT};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::auth::{check_cookie_availability, SessionStore};
use crate::logger::write_log;

const WEB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
const TASK_KIND: &str = "取消赞";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LikePost {
    /// 微博编号；取消点赞请求需要传这个值。
    pub id: String,
    /// 微博发布日期（yyyy-mm-dd），用于日期筛选。
    pub date: String,
    /// 微博原始的发布时间字符串。
    pub created_at: String,
    /// 微博正文。
    pub text: String,
    /// 媒体类型：图片 / 视频 / 无媒体。
    pub media: String,
    /// 作者昵称；失效微博没有作者信息时为空字符串。
    pub author: String,
    /// 被点赞的微博已失效：微博本身被删，或它是转发且原文被删。
    #[serde(default)]
    pub deleted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlikePostResult {
    pub post_id: String,
    pub state: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlikeTask {
    pub id: u64,
    pub title: String,
    pub kind: String,
    pub state: String,
    pub progress: u8,
    pub detail: String,
    pub created_at: String,
    pub post_ids: Vec<String>,
    pub date_from: String,
    pub date_to: String,
    /// 创建任务时是否勾选了“原文失效”条件，仅用于任务详情展示。
    #[serde(default)]
    pub deleted_only: bool,
    #[serde(default)]
    pub results: Vec<UnlikePostResult>,
}

fn unix_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn db_connection(app: &AppHandle) -> Result<Connection, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建应用数据目录：{e}"))?;
    let db = Connection::open(dir.join("weibo-manager.sqlite3")).map_err(|e| format!("无法打开任务数据库：{e}"))?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL);"
    ).map_err(|e| format!("初始化任务表失败：{e}"))?;
    Ok(db)
}

fn month_number(value: &str) -> Option<&'static str> {
    match value {
        "Jan" => Some("01"), "Feb" => Some("02"), "Mar" => Some("03"),
        "Apr" => Some("04"), "May" => Some("05"), "Jun" => Some("06"),
        "Jul" => Some("07"), "Aug" => Some("08"), "Sep" => Some("09"),
        "Oct" => Some("10"), "Nov" => Some("11"), "Dec" => Some("12"),
        _ => None,
    }
}

fn date_from_weibo(value: &str) -> String {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() >= 6 {
        if let (Some(month), Some(day), Some(year)) = (month_number(parts[1]), parts[2].parse::<u32>().ok(), parts[5].parse::<u32>().ok()) {
            return format!("{year:04}-{month}-{day:02}");
        }
    }
    value.get(..10).unwrap_or(value).to_string()
}

fn post_text(mblog: &Value) -> String {
    let raw = mblog.get("text_raw").and_then(Value::as_str)
        .or_else(|| mblog.get("text").and_then(Value::as_str)).unwrap_or("");
    // 仅作轻量 HTML 标签清理，避免将网页标签原样显示在表格中。
    let mut out = String::with_capacity(raw.len());
    let mut in_tag = false;
    for ch in raw.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
}

/// 微博用字符串 "1" 标记已删除，同时兼容数字 1 的返回形态。
fn deleted_flag(value: Option<&Value>) -> bool {
    value.map(|item| item.as_u64() == Some(1) || item.as_str() == Some("1")).unwrap_or(false)
}

fn parse_like_post(mblog: &Value) -> Option<LikePost> {
    let id = mblog.get("id").map(|v| if let Some(s) = v.as_str() { s.to_string() } else { v.to_string() })?;
    if id.is_empty() { return None; }
    let created_at = mblog.get("created_at").and_then(Value::as_str).unwrap_or("").to_string();
    let date = date_from_weibo(&created_at);
    let author = mblog.pointer("/user/screen_name").and_then(Value::as_str).unwrap_or("").to_string();
    let has_pics = mblog.get("pics").and_then(Value::as_array).map(|v| !v.is_empty()).unwrap_or(false);
    let page_type = mblog.get("page_info").and_then(|v| v.get("type")).and_then(Value::as_str).unwrap_or("");
    let media = (if has_pics { "图片" } else if page_type == "video" || mblog.get("video").is_some() { "视频" } else { "无媒体" }).to_string();
    // 两种失效形态都算失效：微博本身被删，或转发微博的原文被删。
    let deleted = deleted_flag(mblog.get("deleted"))
        || deleted_flag(mblog.get("retweeted_status").and_then(|origin| origin.get("deleted")));
    Some(LikePost { id, date, created_at, text: post_text(mblog), media, author, deleted })
}

/// 控制点赞列表读取与取消点赞任务的暂停、取消状态。
#[derive(Default)]
pub struct UnlikeSearchControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    task_paused: AtomicBool,
    task_cancelled: AtomicBool,
    task_running: AtomicBool,
    active_task_id: std::sync::atomic::AtomicU64,
    task_stopped_notify: tokio::sync::Notify,
    cookie_removal: AtomicBool,
}

struct TaskExecutionGuard<'a> {
    running: &'a AtomicBool,
    active_task_id: Option<&'a std::sync::atomic::AtomicU64>,
    stopped_notify: Option<&'a tokio::sync::Notify>,
}
impl Drop for TaskExecutionGuard<'_> {
    fn drop(&mut self) {
        if let Some(task_id) = self.active_task_id {
            task_id.store(0, Ordering::Release);
        }
        self.running.store(false, Ordering::Release);
        if let Some(notify) = self.stopped_notify {
            notify.notify_one();
        }
    }
}

pub(crate) async fn begin_cookie_removal(control: &UnlikeSearchControl) {
    control.cookie_removal.store(true, Ordering::Release);
    control.cancelled.store(true, Ordering::Release);
    control.paused.store(false, Ordering::Release);
    control.task_cancelled.store(true, Ordering::Release);
    control.task_paused.store(false, Ordering::Release);
    while control.task_running.load(Ordering::Acquire) {
        task_sleep(100).await;
    }
}

pub(crate) fn finish_cookie_removal(control: &UnlikeSearchControl) {
    control.task_cancelled.store(false, Ordering::Release);
    control.cookie_removal.store(false, Ordering::Release);
}

#[tauri::command]
pub fn set_unlike_search_paused(paused: bool, control: State<'_, UnlikeSearchControl>) {
    control.paused.store(paused, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_unlike_search_cancelled(cancelled: bool, control: State<'_, UnlikeSearchControl>) {
    // Cookie 删除期间不允许迟到的前端收尾逻辑重新启用搜索。
    if !cancelled && control.cookie_removal.load(Ordering::Acquire) { return; }
    control.cancelled.store(cancelled, Ordering::Release);
    if cancelled {
        control.paused.store(false, Ordering::Relaxed);
    }
}

async fn wait_for_search_resume(control: &UnlikeSearchControl) -> bool {
    while control.paused.load(Ordering::Acquire)
        && !control.cancelled.load(Ordering::Acquire)
        && !control.cookie_removal.load(Ordering::Acquire) {
        task_sleep(150).await;
    }
    !control.cancelled.load(Ordering::Acquire) && !control.cookie_removal.load(Ordering::Acquire)
}

async fn wait_request_interval(app: &AppHandle, control: &UnlikeSearchControl) -> bool {
    let delay = crate::settings::request_delay_ms(app);
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < delay as u128 {
        if !wait_for_search_resume(control).await { return false; }
        let remaining = delay.saturating_sub(started.elapsed().as_millis() as u64);
        task_sleep(remaining.min(150)).await;
    }
    !control.cancelled.load(Ordering::Relaxed)
}

fn looks_rate_limited(body: &Value) -> bool {
    let mut messages = Vec::new();
    for key in ["msg", "errmsg", "message", "error", "error_code", "code", "errno"] {
        if let Some(value) = body.get(key) {
            messages.push(value.to_string().to_lowercase());
        }
    }
    let text = messages.join(" ");
    ["429", "10023", "10024", "rate limit", "too many requests", "请求过于频繁", "操作频繁", "访问频次", "频率过高"]
        .iter().any(|needle| text.contains(needle))
}

/// 从保存的 Cookie 头里取出与 `X-Xsrf-Token` 请求头配对的令牌。
fn xsrf_token_from_cookie(cookie: &str) -> Option<String> {
    for part in cookie.split(';') {
        let mut pair = part.trim().splitn(2, '=');
        let name = pair.next().unwrap_or("").trim();
        let value = pair.next().unwrap_or("").trim();
        if name.eq_ignore_ascii_case("XSRF-TOKEN") && !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

async fn current_uid(client: &reqwest::Client, cookie: &str) -> Result<String, String> {
    let config = client.get("https://m.weibo.cn/api/config")
        .header(COOKIE, cookie).header(USER_AGENT, WEB_UA)
        .header(ACCEPT, "application/json, text/plain, */*").send().await
        .map_err(|e| format!("获取微博账号信息失败，请检查网络：{e}"))?;
    if config.status().as_u16() == 401 || config.status().as_u16() == 403 {
        return Err("微博拒绝了账号信息请求（401/403）。请检查登录状态，必要时重新登录。".into());
    }
    if !config.status().is_success() {
        return Err(format!("获取微博账号信息失败，HTTP {}", config.status().as_u16()));
    }
    let json: Value = config.json().await.map_err(|e| format!("微博账号信息解析失败：{e}"))?;
    json.pointer("/data/uid").and_then(Value::as_u64)
        .map(|v| v.to_string())
        .or_else(|| json.pointer("/data/uid").and_then(Value::as_str).map(str::to_string))
        .filter(|v| !v.is_empty() && v != "0")
        .ok_or_else(|| "未能从当前 Cookie 识别微博 UID。请重新登录后再试。".to_string())
}

#[tauri::command]
pub async fn get_like_posts(
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, UnlikeSearchControl>,
) -> Result<Vec<LikePost>, String> {
    let _ = write_log(&app, "INFO", "unlike", "开始读取点赞列表");
    let mut posts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if !wait_for_search_resume(&control).await { return Ok(posts); }
    let cookie = store.cookie()?;
    if check_cookie_availability(&cookie).await? != "valid" {
        return Err("Cookie 已失效，请重新登录微博后再读取点赞列表。".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化点赞请求失败：{e}"))?;
    if !wait_for_search_resume(&control).await { return Ok(posts); }
    let uid = current_uid(&client, &cookie).await?;
    let _ = write_log(&app, "INFO", "unlike", "已识别当前微博账号，开始分页读取点赞列表（不记录账号标识）");

    // 点赞列表不按微博发布时间排序，无法按日期提前结束，必须读完所有页再交给前端筛选。
    for page in 1..=1000 {
        if !wait_for_search_resume(&control).await { return Ok(posts); }
        if !wait_request_interval(&app, &control).await { return Ok(posts); }
        if !wait_for_search_resume(&control).await { return Ok(posts); }
        let url = format!("https://weibo.com/ajax/statuses/likelist?uid={uid}&page={page}&with_total=1");
        let response = client.get(&url).header(COOKIE, &cookie).header(USER_AGENT, WEB_UA)
            .header(REFERER, "https://weibo.com/").header(ACCEPT, "application/json, text/plain, */*")
            .header("X-Requested-With", "XMLHttpRequest")
            .send().await.map_err(|e| format!("读取点赞列表失败：{e}"))?;
        if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            return Err("微博拒绝了点赞列表请求（401/403）。请检查登录状态，必要时重新登录。已停止继续请求。".into());
        }
        if response.status().as_u16() == 429 || response.status().as_u16() == 418 {
            return Err(format!("微博返回限流响应（HTTP {}），已停止读取。请等待一段时间后再试。", response.status().as_u16()));
        }
        if !response.status().is_success() {
            return Err(format!("读取点赞列表失败，HTTP {}", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(|e| format!("点赞列表解析失败：{e}"))?;
        if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
        if looks_rate_limited(&body) {
            return Err("微博提示请求过于频繁或触发风控，已停止读取。请等待一段时间后再试。".into());
        }
        let items = body.pointer("/data/list").and_then(Value::as_array)
            .ok_or_else(|| "点赞列表接口没有返回预期数据；请确认登录状态有效。".to_string())?;
        let mut page_posts = Vec::new();
        for item in items {
            // 列表条目本身即是微博对象，兼容被包在 mblog 字段内的返回形态。
            let mblog = item.get("mblog").unwrap_or(item);
            if let Some(post) = parse_like_post(mblog) { page_posts.push(post); }
        }
        if page_posts.is_empty() { break; }
        let mut added = 0;
        for post in page_posts {
            if control.cancelled.load(Ordering::Acquire) || control.cookie_removal.load(Ordering::Acquire) {
                return Ok(posts);
            }
            if seen.insert(post.id.clone()) {
                added += 1;
                posts.push(post.clone());
                let _ = app.emit("unlike-post-item", post.clone());
            }
        }
        // 页码超出范围时接口可能重复返回最后一页，没有新条目即视为已读完。
        if added == 0 { break; }
    }
    let _ = write_log(&app, "INFO", "unlike", &format!("点赞列表读取结束，共收集 {} 条点赞", posts.len()));
    Ok(posts)
}

#[tauri::command]
pub fn create_unlike_task(
    app: AppHandle,
    post_ids: Vec<String>,
    date_from: String,
    date_to: String,
    deleted_only: bool,
) -> Result<UnlikeTask, String> {
    if post_ids.is_empty() { return Err("请至少选择一条点赞后再创建任务。".into()); }
    if post_ids.iter().any(|id| id.trim().is_empty()) { return Err("选中的微博 ID 无效，请刷新列表后重试。".into()); }
    let mut db = db_connection(&app)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("无法锁定取消点赞任务记录：{e}"))?;
    let mut requested = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for post_id in post_ids {
        if seen.insert(post_id.clone()) { requested.push(post_id); }
    }
    let mut claimed = std::collections::HashSet::new();
    {
        let mut statement = tx.prepare("SELECT detail FROM tasks WHERE kind=?1 AND state IN ('未开始','排队中','执行中','暂停中','已暂停','失败')")
            .map_err(|e| format!("检查重复取消点赞任务失败：{e}"))?;
        let rows = statement.query_map(params![TASK_KIND], |row| row.get::<_, String>(0))
            .map_err(|e| format!("读取现有取消点赞任务失败：{e}"))?;
        for row in rows {
            let serialized = row.map_err(|e| format!("读取现有取消点赞任务失败：{e}"))?;
            if let Ok(existing) = serde_json::from_str::<UnlikeTask>(&serialized) {
                claimed.extend(existing.post_ids);
            }
        }
    }
    let skipped = requested.iter().filter(|post_id| claimed.contains(*post_id)).count();
    let post_ids: Vec<String> = requested.into_iter().filter(|post_id| !claimed.contains(post_id)).collect();
    if post_ids.is_empty() {
        return Err("所选点赞都已存在于其他未完成的取消点赞任务中，请先处理或重试原任务。".into());
    }
    let id = unix_millis();
    let created_at = format!("{id}");
    let date_label = match (date_from.trim().is_empty(), date_to.trim().is_empty()) {
        (true, true) => "全部时间".to_string(),
        (false, true) => format!("{} 起", date_from),
        (true, false) => format!("截至 {}", date_to),
        (false, false) => format!("{} 至 {}", date_from, date_to),
    };
    let detail = format!("待确认 {} 条点赞，日期 {}，范围 {}{}",
        post_ids.len(), date_label, if deleted_only { "仅原文失效" } else { "全部点赞" },
        if skipped > 0 { format!("，已跳过与其他未完成任务重叠的 {} 条点赞", skipped) } else { String::new() });
    let task = UnlikeTask {
        id, title: format!("取消点赞 {} 条", post_ids.len()), kind: TASK_KIND.into(),
        state: "未开始".into(), progress: 0, detail, created_at: created_at.clone(),
        post_ids, date_from, date_to, deleted_only, results: Vec::new(),
    };
    let serialized = serde_json::to_string(&task).map_err(|e| format!("序列化任务失败：{e}"))?;
    tx.execute("INSERT INTO tasks (id, kind, state, created_at, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task.id.to_string(), TASK_KIND, task.state, task.created_at, serialized])
        .map_err(|e| format!("保存取消点赞任务失败：{e}"))?;
    tx.commit().map_err(|e| format!("提交取消点赞任务失败：{e}"))?;
    Ok(task)
}

fn save_unlike_task(app: &AppHandle, task: &UnlikeTask) -> Result<(), String> {
    let db = db_connection(app)?;
    let json = serde_json::to_string(task).map_err(|e| format!("序列化取消点赞任务失败：{e}"))?;
    db.execute("UPDATE tasks SET state=?1, detail=?2 WHERE id=?3 AND kind=?4",
        params![task.state, json, task.id.to_string(), TASK_KIND])
        .map_err(|e| format!("更新取消点赞任务失败：{e}"))?;
    Ok(())
}

fn load_unlike_task(app: &AppHandle, id: u64) -> Result<UnlikeTask, String> {
    let db = db_connection(app)?;
    let json: String = db.query_row("SELECT detail FROM tasks WHERE id=?1 AND kind=?2",
        params![id.to_string(), TASK_KIND], |row| row.get(0))
        .map_err(|e| format!("找不到取消点赞任务：{e}"))?;
    serde_json::from_str(&json).map_err(|e| format!("解析取消点赞任务失败：{e}"))
}

async fn task_sleep(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(ms))).await.ok();
}

async fn wait_unlike_resume(control: &UnlikeSearchControl) -> bool {
    !control.task_cancelled.load(Ordering::Acquire) && !control.task_paused.load(Ordering::Acquire)
}

async fn cancel_like(client: &reqwest::Client, post_id: &str, cookie: &str, xsrf: &str) -> Result<(), String> {
    // 请求体固定为 {"id":"<微博ID>"}；与 Cookie 配对的 XSRF 令牌缺失时微博会直接拒绝。
    let payload = serde_json::json!({ "id": post_id }).to_string();
    let response = client.post("https://weibo.com/ajax/statuses/cancelLike")
        .header(COOKIE, cookie)
        .header(USER_AGENT, WEB_UA)
        .header(REFERER, "https://weibo.com/")
        .header(ACCEPT, "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("X-Xsrf-Token", xsrf)
        .header(CONTENT_TYPE, "application/json;charset=UTF-8")
        .body(payload)
        .send().await.map_err(|e| format!("取消点赞请求失败：{e}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(format!("HTTP {}：登录失效或触发风控", status.as_u16()));
    }
    if !status.is_success() {
        return Err(format!("取消点赞请求失败，HTTP {}", status.as_u16()));
    }
    let body: Value = response.json().await.map_err(|e| format!("取消点赞响应解析失败：{e}"))?;
    let succeeded = body.get("ok").and_then(Value::as_u64) == Some(1)
        || body.get("result").and_then(Value::as_bool) == Some(true);
    if succeeded { return Ok(()); }
    let message = ["message", "msg", "error"].iter()
        .find_map(|key| body.get(*key).and_then(Value::as_str))
        .unwrap_or("微博未返回成功状态")
        .to_string();
    Err(message)
}

#[tauri::command]
pub async fn set_unlike_task_paused(task_id: u64, paused: bool, app: AppHandle, control: State<'_, UnlikeSearchControl>) -> Result<String, String> {
    let active_task_id = control.active_task_id.load(Ordering::Acquire);
    if active_task_id != task_id {
        if !paused {
            return Ok(load_unlike_task(&app, task_id)?.state);
        }
        let mut task = load_unlike_task(&app, task_id)?;
        if task.state != "已完成" && task.state != "失败" {
            task.state = "已暂停".into();
            task.detail = format!("已暂停，已处理 {}/{} 条", task.results.len(), task.post_ids.len());
            save_unlike_task(&app, &task)?;
            let _ = app.emit("unlike-task-updated", task.clone());
        }
        return Ok(task.state);
    }
    control.task_paused.store(paused, Ordering::Release);
    if !paused { return Ok("执行中".into()); }
    while control.task_running.load(Ordering::Acquire)
        && control.active_task_id.load(Ordering::Acquire) == task_id {
        let stopped = control.task_stopped_notify.notified();
        if !control.task_running.load(Ordering::Acquire)
            || control.active_task_id.load(Ordering::Acquire) != task_id {
            break;
        }
        stopped.await;
    }
    let mut task = load_unlike_task(&app, task_id)?;
    if task.state != "已完成" && task.state != "失败" {
        task.state = "已暂停".into();
        task.detail = format!("已暂停，已处理 {}/{} 条", task.results.len(), task.post_ids.len());
        save_unlike_task(&app, &task)?;
        let _ = app.emit("unlike-task-updated", task.clone());
    }
    Ok(task.state)
}

#[tauri::command]
pub fn set_unlike_task_cancelled(cancelled: bool, control: State<'_, UnlikeSearchControl>) {
    control.task_cancelled.store(cancelled, Ordering::Relaxed);
    if cancelled { control.task_paused.store(false, Ordering::Relaxed); }
}

#[tauri::command]
pub async fn execute_unlike_task(
    task_id: u64,
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, UnlikeSearchControl>,
    execution_gate: State<'_, crate::task_execution::TaskExecutionGate>,
) -> Result<UnlikeTask, String> {
    if control.cookie_removal.load(Ordering::Acquire) { return Err("正在删除 Cookie，请稍后重试。".into()); }
    if control.task_running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("已有取消点赞任务正在执行，请等待当前任务结束。".into());
    }
    control.task_cancelled.store(false, Ordering::Release);
    control.task_paused.store(false, Ordering::Release);
    control.active_task_id.store(task_id, Ordering::Release);
    let _execution_guard = TaskExecutionGuard {
        running: &control.task_running,
        active_task_id: Some(&control.active_task_id),
        stopped_notify: Some(&control.task_stopped_notify),
    };
    let _execution_permit = execution_gate.acquire().await?;
    if control.cookie_removal.load(Ordering::Acquire) { return Err("正在删除 Cookie，请稍后重试。".into()); }
    if control.task_cancelled.load(Ordering::Acquire) { return Err("取消点赞任务已停止。".into()); }
    let result = execute_unlike_task_inner(task_id, app.clone(), &store, &control).await;
    if let Err(error) = &result {
        if let Ok(mut task) = load_unlike_task(&app, task_id) {
            if task.state != "已完成" && task.state != "已暂停" && !error.contains("该取消点赞任务已经在执行") {
                task.state = "失败".into();
                task.detail = error.to_string();
                if save_unlike_task(&app, &task).is_ok() { let _ = app.emit("unlike-task-updated", task); }
            }
        }
    }
    result
}

async fn execute_unlike_task_inner(task_id: u64, app: AppHandle, store: &SessionStore, control: &UnlikeSearchControl) -> Result<UnlikeTask, String> {
    let mut task = load_unlike_task(&app, task_id)?;
    if task.post_ids.is_empty() { return Err("任务中没有可取消点赞的微博 ID。".into()); }
    if task.state == "执行中" { return Err("该取消点赞任务已经在执行。".into()); }
    if task.state == "已完成" { return Err("该任务已完成，不能重复执行。".into()); }

    let cookie = match store.cookie() {
        Ok(cookie) => cookie,
        Err(error) => {
            task.state = "失败".into(); task.detail = error.clone();
            save_unlike_task(&app, &task)?; let _ = app.emit("unlike-task-updated", task.clone());
            return Err(error);
        }
    };
    match check_cookie_availability(&cookie).await {
        Ok(state) if state == "valid" => {}
        Ok(_) => {
            let error = "Cookie 已失效，请重新登录微博后再执行取消点赞任务。".to_string();
            task.state = "失败".into(); task.detail = error.clone();
            save_unlike_task(&app, &task)?; let _ = app.emit("unlike-task-updated", task.clone());
            return Err(error);
        }
        Err(error) => {
            task.state = "失败".into(); task.detail = error.clone();
            save_unlike_task(&app, &task)?; let _ = app.emit("unlike-task-updated", task.clone());
            return Err(error);
        }
    }
    if control.task_cancelled.load(Ordering::Acquire) { return Err("取消点赞任务已停止。".into()); }
    if control.task_paused.load(Ordering::Acquire) {
        task.state = "已暂停".into(); task.detail = "已暂停，尚未发送取消点赞请求".into();
        save_unlike_task(&app, &task)?; let _ = app.emit("unlike-task-updated", task.clone());
        return Ok(task);
    }

    let xsrf = xsrf_token_from_cookie(&cookie).ok_or_else(||
        "当前 Cookie 缺少 XSRF-TOKEN，无法发送取消点赞请求。请重新登录微博后再试。".to_string())?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化取消点赞请求失败：{e}"))?;

    let retry = task.state == "失败" || task.state == "已暂停";
    let successful: std::collections::HashSet<String> = task.results.iter()
        .filter(|item| item.state == "已取消").map(|item| item.post_id.clone()).collect();
    let mut claimed = std::collections::HashSet::new();
    {
        let db = db_connection(&app)?;
        let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind=?1 AND id<>?2 AND state IN ('未开始','排队中','执行中','暂停中','已暂停','失败')")
            .map_err(|e| format!("执行前检查重复点赞失败：{e}"))?;
        let rows = statement.query_map(params![TASK_KIND, task.id.to_string()], |row| Ok(row.get::<_, String>(0)?))
            .map_err(|e| format!("读取其他取消点赞任务失败：{e}"))?;
        for row in rows {
            let json = row.map_err(|e| format!("读取其他取消点赞任务失败：{e}"))?;
            if let Ok(other) = serde_json::from_str::<UnlikeTask>(&json) { claimed.extend(other.post_ids); }
        }
    }
    let mut targets: Vec<String> = if retry {
        task.post_ids.iter().filter(|id| !successful.contains(*id)).cloned().collect()
    } else {
        task.post_ids.clone()
    };
    if !retry { task.results.clear(); }
    let overlaps: Vec<String> = targets.iter().filter(|id| claimed.contains(*id)).cloned().collect();
    targets.retain(|id| !claimed.contains(id));
    for id in overlaps {
        task.results.retain(|result| result.post_id != id);
        task.results.push(UnlikePostResult { post_id: id, state: "跳过重复".into(), detail: "该微博已存在于其他未完成取消点赞任务，本次跳过；重试时会再次检查".into() });
    }
    if targets.is_empty() {
        task.state = "失败".into();
        task.progress = ((task.results.len() * 100) / task.post_ids.len()).min(100) as u8;
        task.detail = "本次没有可取消的点赞：全部项目均已成功取消或与其他未完成任务重叠".into();
        save_unlike_task(&app, &task)?;
        let _ = app.emit("unlike-task-updated", task.clone());
        return Ok(task);
    }

    task.state = "执行中".into();
    task.progress = ((successful.len() * 100) / task.post_ids.len()).min(100) as u8;
    task.detail = format!("正在取消点赞，待处理 {} 条", targets.len());
    save_unlike_task(&app, &task)?;
    let _ = app.emit("unlike-task-updated", task.clone());

    for id in targets {
        if !wait_unlike_resume(control).await { break; }
        let outcome = cancel_like(&client, &id, &cookie, &xsrf).await;
        let (state, detail) = match outcome {
            Ok(()) => ("已取消".to_string(), "微博已返回取消成功".to_string()),
            Err(error) => ("失败".to_string(), error),
        };
        let fatal = detail.contains("HTTP 401") || detail.contains("HTTP 403") || detail.contains("风控");
        task.results.retain(|result| result.post_id != id);
        task.results.push(UnlikePostResult { post_id: id, state, detail });
        task.progress = ((task.results.len() * 100) / task.post_ids.len()).min(100) as u8;
        let ok = task.results.iter().filter(|item| item.state == "已取消").count();
        let failed = task.results.iter().filter(|item| item.state == "失败").count();
        task.detail = format!("已处理 {}/{} 条；成功 {} 条，失败 {} 条", task.results.len(), task.post_ids.len(), ok, failed);
        save_unlike_task(&app, &task)?;
        let _ = app.emit("unlike-task-updated", task.clone());
        if fatal { break; }
        task_sleep(crate::settings::request_delay_ms(&app)).await;
    }

    if control.task_cancelled.load(Ordering::Relaxed) {
        task.state = "失败".into();
        task.detail = format!("任务已停止，已处理 {}/{} 条", task.results.len(), task.post_ids.len());
    } else if control.task_paused.load(Ordering::Acquire) {
        task.state = "已暂停".into();
        task.detail = format!("已暂停，已处理 {}/{} 条", task.results.len(), task.post_ids.len());
    } else if task.results.iter().any(|item| item.state == "失败") || task.results.len() < task.post_ids.len() {
        task.state = "失败".into();
    } else {
        task.state = "已完成".into();
    }
    save_unlike_task(&app, &task)?;
    let _ = app.emit("unlike-task-updated", task.clone());
    Ok(task)
}

#[tauri::command]
pub fn get_unlike_tasks(app: AppHandle) -> Result<Vec<UnlikeTask>, String> {
    let db = db_connection(&app)?;
    let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind=?1 ORDER BY created_at DESC")
        .map_err(|e| format!("读取取消点赞任务失败：{e}"))?;
    let rows = statement.query_map(params![TASK_KIND], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询取消点赞任务失败：{e}"))?;
    let mut tasks = Vec::new();
    for row in rows {
        let serialized = row.map_err(|e| format!("读取取消点赞任务记录失败：{e}"))?;
        if let Ok(task) = serde_json::from_str::<UnlikeTask>(&serialized) { tasks.push(task); }
    }
    Ok(tasks)
}

#[tauri::command]
pub fn remove_unlike_tasks(
    task_ids: Vec<u64>,
    app: AppHandle,
    control: State<'_, UnlikeSearchControl>,
) -> Result<Vec<u64>, String> {
    if task_ids.is_empty() { return Err("请先选择要删除的任务。".into()); }
    let mut db = db_connection(&app)?;
    // 如果所选任务正在执行，先请求取消并解除暂停，等后端停止后再删除记录。
    let active_task_id = control.active_task_id.load(Ordering::Acquire);
    let mut active_selected = active_task_id != 0 && task_ids.contains(&active_task_id);
    if active_task_id == 0 {
        for task_id in &task_ids {
            let state = db.query_row(
                "SELECT state FROM tasks WHERE id=?1 AND kind=?2",
                params![task_id.to_string(), TASK_KIND],
                |row| row.get::<_, String>(0),
            ).optional().map_err(|e| format!("读取任务状态失败：{e}"))?;
            if matches!(state.as_deref(), Some("执行中" | "已暂停")) {
                active_selected = true;
                break;
            }
        }
    }
    if active_selected {
        control.task_cancelled.store(true, Ordering::Release);
        control.task_paused.store(false, Ordering::Release);
        while control.task_running.load(Ordering::Acquire) {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        control.task_cancelled.store(false, Ordering::Release);
    }
    if control.task_running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("有取消点赞任务正在执行，请稍后重试删除。".into());
    }
    let _execution_guard = TaskExecutionGuard {
        running: &control.task_running,
        active_task_id: None,
        stopped_notify: Some(&control.task_stopped_notify),
    };
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("无法锁定任务数据库：{e}"))?;
    let mut unique_ids = std::collections::HashSet::new();
    let mut removed_ids = Vec::new();
    for task_id in task_ids {
        if !unique_ids.insert(task_id) { continue; }
        let state = tx.query_row(
            "SELECT state FROM tasks WHERE id=?1 AND kind=?2",
            params![task_id.to_string(), TASK_KIND],
            |row| row.get::<_, String>(0),
        ).optional().map_err(|e| format!("读取任务状态失败：{e}"))?;
        if state.is_none() { continue; }
        let changed = tx.execute(
            "DELETE FROM tasks WHERE id=?1 AND kind=?2",
            params![task_id.to_string(), TASK_KIND],
        ).map_err(|e| format!("删除任务 #{} 失败：{e}", task_id))?;
        if changed > 0 { removed_ids.push(task_id); }
    }
    tx.commit().map_err(|e| format!("提交任务删除失败：{e}"))?;
    Ok(removed_ids)
}
