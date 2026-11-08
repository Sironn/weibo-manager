//! 评论删除：读取当前账号发出的评论列表，并把选中的评论逐条删除。
//! 列表与删除都使用 weibo.com 的 JSON 接口，删除需要与 Cookie 配对的 XSRF 令牌。

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
const TASK_KIND: &str = "评论";
/// 发出的评论列表；max_id 是游标而不是页码。
const COMMENT_LIST_API: &str = "https://weibo.com/ajax/message/myCmt";
/// 删除单条评论；请求体只需要评论编号 cid。
const COMMENT_DELETE_API: &str = "https://weibo.com/ajax/statuses/destroyComment";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPost {
    /// 评论编号；删除请求要传这个值。
    pub id: String,
    /// 评论发布日期（yyyy-mm-dd），用于日期筛选。
    pub date: String,
    /// 评论原始的发布时间字符串。
    pub created_at: String,
    /// 评论正文。
    pub text: String,
    /// 评论者昵称。
    pub author: String,
    /// 这条评论所在的微博正文。
    pub status_text: String,
    /// 所在微博当前是否不可见：字段缺失或 visible.type 不为 0。
    #[serde(default)]
    pub status_missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPostResult {
    pub post_id: String,
    pub state: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentTask {
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
    #[serde(default)]
    pub keyword: String,
    #[serde(default)]
    pub results: Vec<CommentPostResult>,
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

/// 微博评论时间形如 `Sun Jun 30 20:19:13 +0800 2024`，转成本地筛选用的 yyyy-mm-dd。
fn date_from_weibo(value: &str) -> String {
    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() >= 6 {
        if let (Some(month), Some(day), Some(year)) = (month_number(parts[1]), parts[2].parse::<u32>().ok(), parts[5].parse::<u32>().ok()) {
            return format!("{year:04}-{month}-{day:02}");
        }
    }
    value.get(..10).unwrap_or(value).to_string()
}

/// 只做轻量标签清理，避免把表情图片标签原样显示在表格里。
fn strip_html(raw: &str) -> String {
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
        .trim().to_string()
}

fn parse_comment(item: &Value) -> Option<CommentPost> {
    let id = item.get("idstr").and_then(Value::as_str).map(str::to_string)
        .or_else(|| item.get("id").map(|v| if let Some(s) = v.as_str() { s.to_string() } else { v.to_string() }))?;
    if id.is_empty() || id == "0" { return None; }
    let created_at = item.get("created_at").and_then(Value::as_str).unwrap_or("").to_string();
    let date = date_from_weibo(&created_at);
    let author = item.pointer("/user/screen_name").and_then(Value::as_str).unwrap_or("").to_string();
    let text = strip_html(
        item.get("text_raw").and_then(Value::as_str)
            .or_else(|| item.get("text").and_then(Value::as_str)).unwrap_or("")
    );
    // status 是评论所在的那条微博；微博被删后该字段缺失，或 visible.type 不再为 0。
    let (status_text, status_missing) = match item.get("status") {
        Some(status) if status.is_object() => {
            let visible_type = status.pointer("/visible/type").and_then(Value::as_u64).unwrap_or(0);
            let body = strip_html(
                status.get("text_raw").and_then(Value::as_str)
                    .or_else(|| status.get("text").and_then(Value::as_str)).unwrap_or("")
            );
            (if body.is_empty() { "（原文不可见）".to_string() } else { body }, visible_type != 0)
        }
        _ => ("（原文已删除）".to_string(), true),
    };
    Some(CommentPost { id, date, created_at, text, author, status_text, status_missing })
}

/// 控制评论列表读取与删除任务的暂停、取消状态。
#[derive(Default)]
pub struct CommentSearchControl {
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

pub(crate) async fn begin_cookie_removal(control: &CommentSearchControl) {
    control.cookie_removal.store(true, Ordering::Release);
    control.cancelled.store(true, Ordering::Release);
    control.paused.store(false, Ordering::Release);
    control.task_cancelled.store(true, Ordering::Release);
    control.task_paused.store(false, Ordering::Release);
    while control.task_running.load(Ordering::Acquire) {
        task_sleep(100).await;
    }
}

pub(crate) fn finish_cookie_removal(control: &CommentSearchControl) {
    control.task_cancelled.store(false, Ordering::Release);
    control.cookie_removal.store(false, Ordering::Release);
}

#[tauri::command]
pub fn set_comment_search_paused(paused: bool, control: State<'_, CommentSearchControl>) {
    control.paused.store(paused, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_comment_search_cancelled(cancelled: bool, control: State<'_, CommentSearchControl>) {
    if !cancelled && control.cookie_removal.load(Ordering::Acquire) { return; }
    control.cancelled.store(cancelled, Ordering::Release);
    if cancelled {
        control.paused.store(false, Ordering::Relaxed);
    }
}

async fn task_sleep(millis: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
}

async fn wait_for_comment_resume(control: &CommentSearchControl) -> bool {
    while control.paused.load(Ordering::Acquire)
        && !control.cancelled.load(Ordering::Acquire)
        && !control.cookie_removal.load(Ordering::Acquire) {
        task_sleep(150).await;
    }
    !control.cancelled.load(Ordering::Acquire) && !control.cookie_removal.load(Ordering::Acquire)
}

async fn wait_comment_interval(app: &AppHandle, control: &CommentSearchControl) -> bool {
    let delay = crate::settings::request_delay_ms(app);
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < delay as u128 {
        if !wait_for_comment_resume(control).await { return false; }
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

#[tauri::command]
pub async fn get_comment_posts(
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, CommentSearchControl>,
    date_from: String,
) -> Result<Vec<CommentPost>, String> {
    let _ = write_log(&app, "INFO", "comment", "开始读取发出的评论");
    let mut posts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if !wait_for_comment_resume(&control).await { return Ok(posts); }
    let cookie = store.cookie()?;
    if check_cookie_availability(&cookie).await? != "valid" {
        return Err("Cookie 已失效，请重新登录微博后再读取评论列表。".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化评论请求失败：{e}"))?;

    // myCmt 用游标翻页：首屏 max_id=0，之后把上一页的 next_cursor 回传。
    let mut cursor = "0".to_string();
    for page in 1..=500 {
        if !wait_for_comment_resume(&control).await { return Ok(posts); }
        if !wait_comment_interval(&app, &control).await { return Ok(posts); }
        if !wait_for_comment_resume(&control).await { return Ok(posts); }
        let response = client.get(COMMENT_LIST_API)
            .query(&[("max_id", cursor.as_str())])
            .header(COOKIE, &cookie).header(USER_AGENT, WEB_UA)
            .header(REFERER, "https://weibo.com/").header(ACCEPT, "application/json, text/plain, */*")
            .header("X-Requested-With", "XMLHttpRequest")
            .send().await.map_err(|e| format!("读取评论列表失败：{e}"))?;
        if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            return Err("微博拒绝了评论列表请求（401/403）。请检查登录状态，必要时重新登录。已停止继续请求。".into());
        }
        if response.status().as_u16() == 429 || response.status().as_u16() == 418 {
            return Err(format!("微博返回限流响应（HTTP {}），已停止读取。请等待一段时间后再试。", response.status().as_u16()));
        }
        if !response.status().is_success() {
            return Err(format!("读取评论列表失败，HTTP {}", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(|e| format!("评论列表解析失败：{e}"))?;
        if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
        if looks_rate_limited(&body) {
            return Err("微博提示请求过于频繁或触发风控，已停止读取。请等待一段时间后再试。".into());
        }
        if !body.get("ok").map(|v| v.as_u64() == Some(1) || v.as_str() == Some("1")).unwrap_or(false) {
            let message = body.get("message").or_else(|| body.get("msg")).and_then(Value::as_str).unwrap_or("接口未返回错误说明");
            return Err(format!("读取评论列表失败：{message}"));
        }
        let items = body.pointer("/data/comments").and_then(Value::as_array).cloned().unwrap_or_default();
        if items.is_empty() { break; }

        let mut added = 0;
        let mut page_all_before_from = true;
        for item in &items {
            if control.cancelled.load(Ordering::Acquire) || control.cookie_removal.load(Ordering::Acquire) {
                return Ok(posts);
            }
            let Some(post) = parse_comment(item) else { continue };
            if date_from.trim().is_empty() || post.date.as_str() >= date_from.as_str() {
                page_all_before_from = false;
            }
            if seen.insert(post.id.clone()) {
                added += 1;
                posts.push(post.clone());
                let _ = app.emit("comment-post-item", post);
            }
        }
        // 评论按时间倒序返回：整页都早于筛选起始日期时，后面的只会更早，可以提前结束。
        if !date_from.trim().is_empty() && page_all_before_from { break; }
        let next_cursor = body.pointer("/data/next_cursor").map(|v| {
            if let Some(s) = v.as_str() { s.to_string() } else { v.to_string() }
        }).unwrap_or_default();
        if next_cursor.is_empty() || next_cursor == "0" || next_cursor == "null" { break; }
        if added == 0 { break; }
        if page >= 500 { break; }
        cursor = next_cursor;
    }
    let _ = write_log(&app, "INFO", "comment", &format!("评论列表读取结束，共收集 {} 条", posts.len()));
    Ok(posts)
}

#[tauri::command]
pub fn create_comment_task(
    app: AppHandle,
    post_ids: Vec<String>,
    date_from: String,
    date_to: String,
    keyword: String,
) -> Result<CommentTask, String> {
    if post_ids.is_empty() { return Err("请至少选择一条评论后再创建任务。".into()); }
    if post_ids.iter().any(|id| id.trim().is_empty()) { return Err("选中的评论编号无效，请刷新列表后重试。".into()); }
    let mut db = db_connection(&app)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("无法锁定评论任务记录：{e}"))?;
    let mut requested = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for post_id in post_ids {
        if seen.insert(post_id.clone()) { requested.push(post_id); }
    }
    let mut claimed = std::collections::HashSet::new();
    {
        let mut statement = tx.prepare("SELECT detail FROM tasks WHERE kind=?1 AND state IN ('未开始','排队中','执行中','暂停中','已暂停','失败')")
            .map_err(|e| format!("检查重复评论任务失败：{e}"))?;
        let rows = statement.query_map(params![TASK_KIND], |row| row.get::<_, String>(0))
            .map_err(|e| format!("读取现有评论任务失败：{e}"))?;
        for row in rows {
            let serialized = row.map_err(|e| format!("读取现有评论任务失败：{e}"))?;
            if let Ok(existing) = serde_json::from_str::<CommentTask>(&serialized) {
                claimed.extend(existing.post_ids);
            }
        }
    }
    let skipped = requested.iter().filter(|post_id| claimed.contains(*post_id)).count();
    let post_ids: Vec<String> = requested.into_iter().filter(|post_id| !claimed.contains(post_id)).collect();
    if post_ids.is_empty() {
        return Err("所选评论都已存在于其他未完成的评论任务中，请先处理或重试原任务。".into());
    }
    let id = unix_millis();
    let created_at = format!("{id}");
    let date_label = match (date_from.trim().is_empty(), date_to.trim().is_empty()) {
        (true, true) => "全部时间".to_string(),
        (false, true) => format!("{} 起", date_from),
        (true, false) => format!("截至 {}", date_to),
        (false, false) => format!("{} 至 {}", date_from, date_to),
    };
    let detail = format!("待确认 {} 条评论，日期 {}{}{}",
        post_ids.len(), date_label,
        if keyword.trim().is_empty() { String::new() } else { format!("，关键词 {}", keyword.trim()) },
        if skipped > 0 { format!("，已跳过与其他未完成任务重叠的 {} 条", skipped) } else { String::new() });
    let task = CommentTask {
        id, title: format!("删除评论 {} 条", post_ids.len()), kind: TASK_KIND.into(),
        state: "未开始".into(), progress: 0, detail, created_at: created_at.clone(),
        post_ids, date_from, date_to, keyword, results: Vec::new(),
    };
    tx.execute(
        "INSERT INTO tasks (id, kind, state, created_at, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task.id.to_string(), TASK_KIND, task.state, task.created_at,
            serde_json::to_string(&task).map_err(|e| format!("序列化评论任务失败：{e}"))?],
    ).map_err(|e| format!("保存评论任务失败：{e}"))?;
    tx.commit().map_err(|e| format!("提交评论任务失败：{e}"))?;
    let _ = app.emit("comment-task-updated", task.clone());
    Ok(task)
}

fn load_comment_task(app: &AppHandle, task_id: u64) -> Result<CommentTask, String> {
    let db = db_connection(app)?;
    let detail: Option<String> = db.query_row(
        "SELECT detail FROM tasks WHERE id=?1 AND kind=?2",
        params![task_id.to_string(), TASK_KIND],
        |row| row.get(0),
    ).optional().map_err(|e| format!("读取评论任务失败：{e}"))?;
    let serialized = detail.ok_or_else(|| format!("评论任务 #{task_id} 不存在或已被删除。"))?;
    serde_json::from_str(&serialized).map_err(|e| format!("解析评论任务失败：{e}"))
}

fn save_comment_task(app: &AppHandle, task: &CommentTask) -> Result<(), String> {
    let db = db_connection(app)?;
    let changed = db.execute(
        "UPDATE tasks SET state=?1, detail=?2 WHERE id=?3 AND kind=?4",
        params![task.state, serde_json::to_string(task).map_err(|e| format!("序列化评论任务失败：{e}"))?, task.id.to_string(), TASK_KIND],
    ).map_err(|e| format!("保存评论任务失败：{e}"))?;
    if changed == 0 { return Err(format!("评论任务 #{} 不存在或已被删除。", task.id)); }
    Ok(())
}

#[tauri::command]
pub async fn set_comment_task_paused(
    task_id: u64,
    paused: bool,
    app: AppHandle,
    control: State<'_, CommentSearchControl>,
) -> Result<String, String> {
    if paused {
        control.task_paused.store(true, Ordering::Release);
        let active = control.active_task_id.load(Ordering::Acquire);
        if active == task_id && control.task_running.load(Ordering::Acquire) {
            let mut waited = 0;
            while control.task_running.load(Ordering::Acquire) && waited < 15000 {
                task_sleep(50).await;
                waited += 50;
            }
        }
        let mut task = load_comment_task(&app, task_id)?;
        if task.state != "已完成" && task.state != "失败" {
            task.state = "已暂停".into();
            task.detail = format!("已暂停，已处理 {}/{} 条", task.results.len(), task.post_ids.len());
            save_comment_task(&app, &task)?;
            let _ = app.emit("comment-task-updated", task.clone());
        }
        return Ok(task.state);
    }
    control.task_paused.store(false, Ordering::Release);
    let task = load_comment_task(&app, task_id)?;
    Ok(task.state)
}

#[tauri::command]
pub fn set_comment_task_cancelled(cancelled: bool, control: State<'_, CommentSearchControl>) {
    control.task_cancelled.store(cancelled, Ordering::Relaxed);
    if cancelled { control.task_paused.store(false, Ordering::Relaxed); }
}

async fn delete_comment(client: &reqwest::Client, cid: &str, cookie: &str, xsrf: &str) -> Result<(), String> {
    let response = client.post(COMMENT_DELETE_API)
        .header(COOKIE, cookie).header(USER_AGENT, WEB_UA)
        .header(REFERER, "https://weibo.com/").header(ACCEPT, "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("X-Xsrf-Token", xsrf)
        .header(CONTENT_TYPE, "application/json;charset=UTF-8")
        .json(&serde_json::json!({ "cid": cid }))
        .send().await.map_err(|e| format!("删除评论请求失败：{e}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(format!("微博拒绝删除请求（HTTP {}），请检查登录状态。", status.as_u16()));
    }
    if status.as_u16() == 429 || status.as_u16() == 418 {
        return Err(format!("微博返回限流响应（HTTP {}），请稍后重试。", status.as_u16()));
    }
    let body: Value = response.json().await.map_err(|e| format!("删除评论响应解析失败：{e}"))?;
    if body.get("ok").map(|v| v.as_u64() == Some(1) || v.as_str() == Some("1")).unwrap_or(false) {
        return Ok(());
    }
    let message = body.get("message").or_else(|| body.get("msg")).and_then(Value::as_str).unwrap_or("微博未返回错误说明").to_string();
    if message.contains("20203") || message.contains("不是您的评论") {
        return Err("该评论已不存在或不属于当前账号，已跳过。".into());
    }
    if looks_rate_limited(&body) {
        return Err(format!("微博提示请求过于频繁（{}），已停止任务。", message));
    }
    Err(format!("微博拒绝了删除请求：{message}"))
}

async fn wait_comment_task_resume(control: &CommentSearchControl) -> bool {
    while control.task_paused.load(Ordering::Acquire) && !control.task_cancelled.load(Ordering::Acquire) {
        task_sleep(150).await;
    }
    !control.task_cancelled.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn execute_comment_task(
    task_id: u64,
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, CommentSearchControl>,
    execution_gate: State<'_, crate::task_execution::TaskExecutionGate>,
) -> Result<CommentTask, String> {
    if control.cookie_removal.load(Ordering::Acquire) { return Err("正在删除 Cookie，请稍后重试。".into()); }
    if control.task_running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("已有评论删除任务正在执行，请等待当前任务结束。".into());
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
    if control.task_cancelled.load(Ordering::Acquire) { return Err("评论任务已停止。".into()); }
    let result = execute_comment_task_inner(task_id, app.clone(), &store, &control).await;
    if let Err(error) = &result {
        if let Ok(mut task) = load_comment_task(&app, task_id) {
            if task.state != "已完成" && task.state != "已暂停" && !error.contains("该评论任务已经在执行") {
                task.state = "失败".into();
                task.detail = error.to_string();
                if save_comment_task(&app, &task).is_ok() { let _ = app.emit("comment-task-updated", task); }
            }
        }
    }
    result
}

async fn execute_comment_task_inner(
    task_id: u64,
    app: AppHandle,
    store: &SessionStore,
    control: &CommentSearchControl,
) -> Result<CommentTask, String> {
    let mut task = load_comment_task(&app, task_id)?;
    if task.post_ids.is_empty() { return Err("任务中没有可删除的评论。".into()); }
    if task.state == "执行中" { return Err("该评论任务已经在执行。".into()); }
    if task.state == "已完成" { return Err("该任务已完成，不能重复执行。".into()); }

    let cookie = match store.cookie() {
        Ok(cookie) => cookie,
        Err(error) => {
            task.state = "失败".into(); task.detail = error.clone();
            save_comment_task(&app, &task)?; let _ = app.emit("comment-task-updated", task.clone());
            return Err(error);
        }
    };
    match check_cookie_availability(&cookie).await {
        Ok(state) if state == "valid" => {}
        Ok(_) => {
            let error = "Cookie 已失效，请重新登录微博后再执行评论任务。".to_string();
            task.state = "失败".into(); task.detail = error.clone();
            save_comment_task(&app, &task)?; let _ = app.emit("comment-task-updated", task.clone());
            return Err(error);
        }
        Err(error) => {
            task.state = "失败".into(); task.detail = error.clone();
            save_comment_task(&app, &task)?; let _ = app.emit("comment-task-updated", task.clone());
            return Err(error);
        }
    }
    if control.task_cancelled.load(Ordering::Acquire) { return Err("评论任务已停止。".into()); }
    if control.task_paused.load(Ordering::Acquire) {
        task.state = "已暂停".into(); task.detail = "已暂停，尚未发送删除评论请求".into();
        save_comment_task(&app, &task)?; let _ = app.emit("comment-task-updated", task.clone());
        return Ok(task);
    }

    let xsrf = xsrf_token_from_cookie(&cookie).ok_or_else(||
        "当前 Cookie 缺少 XSRF-TOKEN，无法发送删除评论请求。请重新登录微博后再试。".to_string())?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化评论删除请求失败：{e}"))?;

    let retry = task.state == "失败" || task.state == "已暂停";
    let finished: std::collections::HashSet<String> = task.results.iter()
        .filter(|item| item.state == "已删除" || item.state == "已跳过")
        .map(|item| item.post_id.clone()).collect();
    let mut claimed = std::collections::HashSet::new();
    {
        let db = db_connection(&app)?;
        let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind=?1 AND id<>?2 AND state IN ('未开始','排队中','执行中','暂停中','已暂停','失败')")
            .map_err(|e| format!("执行前检查重复评论失败：{e}"))?;
        let rows = statement.query_map(params![TASK_KIND, task.id.to_string()], |row| Ok(row.get::<_, String>(0)?))
            .map_err(|e| format!("读取其他评论任务失败：{e}"))?;
        for row in rows {
            let json = row.map_err(|e| format!("读取其他评论任务失败：{e}"))?;
            if let Ok(other) = serde_json::from_str::<CommentTask>(&json) { claimed.extend(other.post_ids); }
        }
    }
    let mut targets: Vec<String> = if retry {
        task.post_ids.iter().filter(|id| !finished.contains(*id)).cloned().collect()
    } else {
        task.post_ids.clone()
    };
    if !retry { task.results.clear(); }
    let overlaps: Vec<String> = targets.iter().filter(|id| claimed.contains(*id)).cloned().collect();
    targets.retain(|id| !claimed.contains(id));
    for id in overlaps {
        task.results.retain(|result| result.post_id != id);
        task.results.push(CommentPostResult { post_id: id, state: "跳过重复".into(), detail: "该评论已存在于其他未完成评论任务，本次跳过；重试时会再次检查".into() });
    }
    if targets.is_empty() {
        task.state = "失败".into();
        task.progress = ((task.results.len() * 100) / task.post_ids.len()).min(100) as u8;
        task.detail = "本次没有可删除的评论：全部项目均已处理或与其他未完成任务重叠".into();
        save_comment_task(&app, &task)?;
        let _ = app.emit("comment-task-updated", task.clone());
        return Ok(task);
    }

    task.state = "执行中".into();
    task.progress = ((finished.len() * 100) / task.post_ids.len()).min(100) as u8;
    task.detail = format!("正在删除评论，待处理 {} 条", targets.len());
    save_comment_task(&app, &task)?;
    let _ = app.emit("comment-task-updated", task.clone());

    for id in targets {
        if !wait_comment_task_resume(control).await { break; }
        let outcome = delete_comment(&client, &id, &cookie, &xsrf).await;
        let (state, detail) = match outcome {
            Ok(()) => ("已删除".to_string(), "微博已返回删除成功".to_string()),
            Err(error) if error.contains("已跳过") => ("已跳过".to_string(), error),
            Err(error) => ("失败".to_string(), error),
        };
        let fatal = detail.contains("HTTP 401") || detail.contains("HTTP 403") || detail.contains("风控") || detail.contains("请求过于频繁");
        task.results.retain(|result| result.post_id != id);
        task.results.push(CommentPostResult { post_id: id, state, detail });
        task.progress = ((task.results.len() * 100) / task.post_ids.len()).min(100) as u8;
        let ok = task.results.iter().filter(|item| item.state == "已删除").count();
        let skipped = task.results.iter().filter(|item| item.state == "已跳过").count();
        let failed = task.results.iter().filter(|item| item.state == "失败").count();
        task.detail = format!("已处理 {}/{} 条；删除 {} 条，跳过 {} 条，失败 {} 条",
            task.results.len(), task.post_ids.len(), ok, skipped, failed);
        save_comment_task(&app, &task)?;
        let _ = app.emit("comment-task-updated", task.clone());
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
    save_comment_task(&app, &task)?;
    let _ = app.emit("comment-task-updated", task.clone());
    Ok(task)
}

#[tauri::command]
pub fn get_comment_tasks(app: AppHandle) -> Result<Vec<CommentTask>, String> {
    let db = db_connection(&app)?;
    let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind=?1 ORDER BY created_at DESC")
        .map_err(|e| format!("读取评论任务失败：{e}"))?;
    let rows = statement.query_map(params![TASK_KIND], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询评论任务失败：{e}"))?;
    let mut tasks = Vec::new();
    for row in rows {
        let serialized = row.map_err(|e| format!("读取评论任务记录失败：{e}"))?;
        if let Ok(task) = serde_json::from_str::<CommentTask>(&serialized) { tasks.push(task); }
    }
    Ok(tasks)
}

#[tauri::command]
pub fn remove_comment_tasks(
    task_ids: Vec<u64>,
    app: AppHandle,
    control: State<'_, CommentSearchControl>,
) -> Result<Vec<u64>, String> {
    if task_ids.is_empty() { return Err("请先选择要删除的任务。".into()); }
    let mut db = db_connection(&app)?;
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
        return Err("有评论任务正在执行，请稍后重试删除。".into());
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
