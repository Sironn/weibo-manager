//! 微博删除任务的只读预览与任务记录。
//! 本模块仅获取微博、保存待确认任务；不包含任何真实删除请求。

use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::auth::SessionStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeiboPost {
    pub id: String,
    pub date: String,
    pub created_at: String,
    pub kind: String,
    pub text: String,
    pub media: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTask {
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
    pub keyword: String,
    pub post_type: String,
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

fn parse_post(mblog: &Value) -> Option<WeiboPost> {
    let id = mblog.get("id").map(|v| if let Some(s) = v.as_str() { s.to_string() } else { v.to_string() })?;
    if id.is_empty() { return None; }
    let created_at = mblog.get("created_at").and_then(Value::as_str).unwrap_or("").to_string();
    let date = date_from_weibo(&created_at);
    let kind = if mblog.get("retweeted_status").is_some() { "转发" } else { "原创" }.to_string();
    let has_pics = mblog.get("pics").and_then(Value::as_array).map(|v| !v.is_empty()).unwrap_or(false);
    let page_type = mblog.get("page_info").and_then(|v| v.get("type")).and_then(Value::as_str).unwrap_or("");
    let media = (if has_pics { "图片" } else if page_type == "video" || mblog.get("video").is_some() { "视频" } else { "无媒体" }).to_string();
    Some(WeiboPost { id, date, created_at, kind, text: post_text(mblog), media })
}

#[tauri::command]
pub async fn get_delete_posts(date_from: String, store: State<'_, SessionStore>) -> Result<Vec<WeiboPost>, String> {
    let cookie = store.cookie()?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化微博请求失败：{e}"))?;
    let config = client.get("https://m.weibo.cn/api/config")
        .header(COOKIE, cookie.as_str()).header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
        .header(ACCEPT, "application/json, text/plain, */*").send().await
        .map_err(|e| format!("获取微博账号信息失败，请检查网络：{e}"))?;
    if !config.status().is_success() {
        return Err(format!("获取微博账号信息失败，HTTP {}", config.status().as_u16()));
    }
    let config_json: Value = config.json().await.map_err(|e| format!("微博账号信息解析失败：{e}"))?;
    let uid = config_json.pointer("/data/uid").and_then(Value::as_u64)
        .map(|v| v.to_string())
        .or_else(|| config_json.pointer("/data/uid").and_then(Value::as_str).map(str::to_string))
        .filter(|v| !v.is_empty() && v != "0")
        .ok_or_else(|| "未能从当前 Cookie 识别微博 UID。请重新登录后再试；当前不会使用模拟数据。".to_string())?;

    let mut posts = Vec::new();
    for page in 1..=100 {
        let url = format!("https://m.weibo.cn/api/container/getIndex?containerid=107603{uid}&page={page}");
        let response = client.get(&url).header(COOKIE, &cookie)
            .header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
            .header(REFERER, "https://m.weibo.cn/").header(ACCEPT, "application/json, text/plain, */*")
            .send().await.map_err(|e| format!("读取微博列表失败：{e}"))?;
        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            return Err("微博拒绝了列表请求（401/403）。登录可能已失效或触发风控，请稍后重试。".into());
        }
        if !response.status().is_success() {
            return Err(format!("读取微博列表失败，HTTP {}", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(|e| format!("微博列表解析失败：{e}"))?;
        let cards = body.pointer("/data/cards").and_then(Value::as_array)
            .ok_or_else(|| "微博列表接口没有返回预期数据；请确认登录状态有效。".to_string())?;
        let before = posts.len();
        let mut page_posts = Vec::new();
        for card in cards {
            if let Some(mblog) = card.get("mblog") {
                if let Some(post) = parse_post(mblog) { page_posts.push(post); }
            }
        }
        if page_posts.is_empty() { break; }
        let reached_start = !date_from.trim().is_empty() && page_posts.iter().all(|post| post.date < date_from);
        posts.extend(page_posts);
        if posts.len() == before || reached_start { break; }
        // 降低连续翻页频率；延时只能降低请求密度，不能保证平台不会触发风控。
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(1200))).await.ok();
    }
    posts.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| b.id.cmp(&a.id)));
    posts.dedup_by(|a, b| a.id == b.id);
    Ok(posts)
}

#[tauri::command]
pub fn create_delete_task(
    app: AppHandle,
    post_ids: Vec<String>,
    date_from: String,
    date_to: String,
    keyword: String,
    post_type: String,
) -> Result<DeleteTask, String> {
    if post_ids.is_empty() { return Err("请至少选择一条微博后再创建任务。".into()); }
    if post_ids.iter().any(|id| id.trim().is_empty()) { return Err("选中的微博 ID 无效，请刷新列表后重试。".into()); }
    let id = unix_millis();
    let created_at = format!("{id}");
    let date_label = match (date_from.trim().is_empty(), date_to.trim().is_empty()) {
        (true, true) => "全部时间".to_string(),
        (false, true) => format!("{} 起", date_from),
        (true, false) => format!("截至 {}", date_to),
        (false, false) => format!("{} 至 {}", date_from, date_to),
    };
    let detail = format!("待确认 · {} 条微博 · 日期 {} · 类型 {} · 关键词 {}",
        post_ids.len(), date_label, post_type, if keyword.trim().is_empty() { "无" } else { keyword.trim() });
    let task = DeleteTask {
        id, title: format!("微博删除 · {} 条", post_ids.len()), kind: "删除".into(),
        state: "等待中".into(), progress: 0, detail, created_at: created_at.clone(),
        post_ids, date_from, date_to, keyword, post_type,
    };
    let db = db_connection(&app)?;
    let serialized = serde_json::to_string(&task).map_err(|e| format!("序列化任务失败：{e}"))?;
    db.execute("INSERT INTO tasks (id, kind, state, created_at, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task.id.to_string(), "删除", task.state, task.created_at, serialized])
        .map_err(|e| format!("保存删除任务失败：{e}"))?;
    Ok(task)
}

#[tauri::command]
pub fn get_delete_tasks(app: AppHandle) -> Result<Vec<DeleteTask>, String> {
    let db = db_connection(&app)?;
    let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind = '删除' ORDER BY created_at DESC")
        .map_err(|e| format!("读取删除任务失败：{e}"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询删除任务失败：{e}"))?;
    let mut tasks = Vec::new();
    for row in rows {
        let serialized = row.map_err(|e| format!("读取删除任务记录失败：{e}"))?;
        if let Ok(task) = serde_json::from_str::<DeleteTask>(&serialized) { tasks.push(task); }
    }
    Ok(tasks)
}
