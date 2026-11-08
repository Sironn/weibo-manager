//! 取消关注：读取当前账号关注的人（可按互关关系与关注分组筛选），并把选中的人逐条取关。
//! 列表与取关都使用 weibo.com 的 JSON 接口，取关需要与 Cookie 配对的 XSRF 令牌。

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
const TASK_KIND: &str = "取关";
/// 我关注的人列表；page 是页码，从 1 开始。
const FOLLOW_LIST_API: &str = "https://weibo.com/ajax/friendships/friends";
/// 关注分组列表。
const FOLLOW_GROUPS_API: &str = "https://weibo.com/ajax/profile/getGroups";
/// 某个分组里的成员，page 同样是页码。
const FOLLOW_GROUP_MEMBERS_API: &str = "https://weibo.com/ajax/profile/getGroupMembers";
/// 取关单个用户。注意官方路径就是 destory（拼写如此），写成 destroy 会 404。
const FOLLOW_DESTROY_API: &str = "https://weibo.com/ajax/friendships/destory";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUser {
    /// 用户数字编号；取关请求要传这个值。
    pub id: String,
    /// 昵称。
    pub screen_name: String,
    /// 头像地址。
    #[serde(default)]
    pub avatar: String,
    /// 粉丝数（关注他的人有多少）。
    #[serde(default)]
    pub followers_count: u64,
    /// 他是否也关注我：true 表示互相关注。
    #[serde(default)]
    pub follow_me: bool,
    /// 个人简介原文。
    #[serde(default)]
    pub description: String,
    /// 我给他设置的备注名，没设置时为空。
    #[serde(default)]
    pub remark: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowResult {
    /// 用户数字编号。
    pub post_id: String,
    /// 处理结果：已取关 / 已跳过 / 失败 / 跳过重复。
    pub state: String,
    /// 结果说明。
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowTask {
    pub id: u64,
    pub title: String,
    pub kind: String,
    pub state: String,
    pub progress: u8,
    pub detail: String,
    pub created_at: String,
    /// 待取关的用户编号列表。
    pub post_ids: Vec<String>,
    /// 关系筛选口径：all / followme / notfollowme。
    #[serde(default)]
    pub relation: String,
    /// 选中的关注分组名称，仅用于详情展示。
    #[serde(default)]
    pub group_names: Vec<String>,
    /// 关键词，仅用于详情展示。
    #[serde(default)]
    pub keyword: String,
    #[serde(default)]
    pub results: Vec<FollowResult>,
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

fn parse_follow_user(item: &Value) -> Option<FollowUser> {
    let id = item.get("idstr").and_then(Value::as_str).map(str::to_string)
        .or_else(|| item.get("id").map(|v| if let Some(s) = v.as_str() { s.to_string() } else { v.to_string() }))?;
    if id.is_empty() || id == "0" { return None; }
    let screen_name = item.get("screen_name").and_then(Value::as_str).unwrap_or("").to_string();
    if screen_name.is_empty() { return None; }
    let avatar = item.get("avatar_hd").and_then(Value::as_str)
        .or_else(|| item.get("profile_image_url").and_then(Value::as_str))
        .unwrap_or("").to_string();
    let followers_count = item.get("followers_count").and_then(Value::as_u64).unwrap_or(0);
    let follow_me = item.get("follow_me").and_then(Value::as_bool).unwrap_or(false);
    let description = strip_html(item.get("description").and_then(Value::as_str).unwrap_or(""));
    let remark = strip_html(item.get("remark").and_then(Value::as_str).unwrap_or(""));
    Some(FollowUser { id, screen_name, avatar, followers_count, follow_me, description, remark })
}

/// 关系筛选：all 全部，followme 只看互相关注，notfollowme 只看单向关注。
fn relation_matches(user: &FollowUser, relation: &str) -> bool {
    match relation {
        "followme" => user.follow_me,
        "notfollowme" => !user.follow_me,
        _ => true,
    }
}

/// 控制关注列表读取与取关任务的暂停、取消状态。
#[derive(Default)]
pub struct FollowSearchControl {
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

pub(crate) async fn begin_cookie_removal(control: &FollowSearchControl) {
    control.cookie_removal.store(true, Ordering::Release);
    control.cancelled.store(true, Ordering::Release);
    control.paused.store(false, Ordering::Release);
    control.task_cancelled.store(true, Ordering::Release);
    control.task_paused.store(false, Ordering::Release);
    while control.task_running.load(Ordering::Acquire) {
        task_sleep(100).await;
    }
}

pub(crate) fn finish_cookie_removal(control: &FollowSearchControl) {
    control.task_cancelled.store(false, Ordering::Release);
    control.cookie_removal.store(false, Ordering::Release);
}

#[tauri::command]
pub fn set_follow_search_paused(paused: bool, control: State<'_, FollowSearchControl>) {
    control.paused.store(paused, Ordering::Relaxed);
}

#[tauri::command]
pub fn set_follow_search_cancelled(cancelled: bool, control: State<'_, FollowSearchControl>) {
    if !cancelled && control.cookie_removal.load(Ordering::Acquire) { return; }
    control.cancelled.store(cancelled, Ordering::Release);
    if cancelled {
        control.paused.store(false, Ordering::Relaxed);
    }
}

async fn task_sleep(millis: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(millis)).await;
}

async fn wait_for_follow_resume(control: &FollowSearchControl) -> bool {
    while control.paused.load(Ordering::Acquire)
        && !control.cancelled.load(Ordering::Acquire)
        && !control.cookie_removal.load(Ordering::Acquire) {
        task_sleep(150).await;
    }
    !control.cancelled.load(Ordering::Acquire) && !control.cookie_removal.load(Ordering::Acquire)
}

async fn wait_follow_interval(app: &AppHandle, control: &FollowSearchControl) -> bool {
    let delay = crate::settings::request_delay_ms(app);
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < delay as u128 {
        if !wait_for_follow_resume(control).await { return false; }
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

fn json_ok(body: &Value) -> bool {
    body.get("ok").map(|v| v.as_u64() == Some(1) || v.as_str() == Some("1")).unwrap_or(false)
}

fn api_error_message(body: &Value) -> String {
    body.get("message").or_else(|| body.get("msg")).and_then(Value::as_str).unwrap_or("接口未返回错误说明").to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowGroupOption {
    pub id: String,
    pub name: String,
    pub count: u64,
}

/// 读取当前账号的关注分组，供筛选条件使用。
#[tauri::command]
pub async fn get_follow_groups(
    store: State<'_, SessionStore>,
) -> Result<Vec<FollowGroupOption>, String> {
    let cookie = store.cookie()?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20)).build()
        .map_err(|e| format!("初始化分组请求失败：{e}"))?;
    let response = client.get(FOLLOW_GROUPS_API)
        .query(&[("showBilateral", "1")])
        .header(COOKIE, &cookie).header(USER_AGENT, WEB_UA)
        .header(REFERER, "https://weibo.com/").header(ACCEPT, "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest")
        .send().await.map_err(|e| format!("读取关注分组失败：{e}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("Cookie 已失效，请重新登录微博后再读取关注分组。".into());
    }
    if !status.is_success() {
        return Err(format!("读取关注分组失败，HTTP {}", status.as_u16()));
    }
    let body: Value = response.json().await.map_err(|e| format!("关注分组解析失败：{e}"))?;
    if !json_ok(&body) {
        return Err(format!("读取关注分组失败：{}", api_error_message(&body)));
    }
    let lists = body.pointer("/data/lists").and_then(Value::as_array).cloned().unwrap_or_default();
    let groups = lists.iter().filter_map(|item| {
        let id = item.get("idstr").and_then(Value::as_str).map(str::to_string)
            .or_else(|| item.get("id").map(|v| if let Some(s) = v.as_str() { s.to_string() } else { v.to_string() }))?;
        let name = item.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        if name.is_empty() { return None; }
        Some(FollowGroupOption { id, name, count: item.get("member_count").and_then(Value::as_u64).unwrap_or(0) })
    }).collect();
    Ok(groups)
}

/// 逐页拉一个来源（关注列表或某个分组）里的用户，交给 `sink` 去重入库。
async fn fetch_follow_page(
    client: &reqwest::Client,
    cookie: &str,
    url: &str,
    page: u32,
    group_id: Option<&str>,
) -> Result<(Vec<FollowUser>, u64), String> {
    let mut request = client.get(url)
        .header(COOKIE, cookie).header(USER_AGENT, WEB_UA)
        .header(REFERER, "https://weibo.com/").header(ACCEPT, "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest");
    request = match group_id {
        Some(id) => request.query(&[("groupId", id.to_string()), ("page", page.to_string())]),
        None => request.query(&[("page", page.to_string()), ("relate", "friends".to_string())]),
    };
    let response = request.send().await.map_err(|e| format!("读取关注列表失败：{e}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("微博拒绝了关注列表请求（401/403）。请检查登录状态，必要时重新登录。已停止继续请求。".into());
    }
    if status.as_u16() == 429 || status.as_u16() == 418 {
        return Err(format!("微博返回限流响应（HTTP {}），已停止读取。请等待一段时间后再试。", status.as_u16()));
    }
    if !status.is_success() {
        return Err(format!("读取关注列表失败，HTTP {}", status.as_u16()));
    }
    let body: Value = response.json().await.map_err(|e| format!("关注列表解析失败：{e}"))?;
    if looks_rate_limited(&body) {
        return Err("微博提示请求过于频繁或触发风控，已停止读取。请等待一段时间后再试。".into());
    }
    if !json_ok(&body) {
        return Err(format!("读取关注列表失败：{}", api_error_message(&body)));
    }
    // 关注列表的 users 在顶层，分组成员在 data.users。
    let items = body.get("users").and_then(Value::as_array)
        .or_else(|| body.pointer("/data/users").and_then(Value::as_array))
        .cloned().unwrap_or_default();
    let total = body.get("total_number").and_then(Value::as_u64)
        .or_else(|| body.pointer("/data/total_number").and_then(Value::as_u64))
        .unwrap_or(0);
    let users: Vec<FollowUser> = items.iter().filter_map(parse_follow_user).collect();
    Ok((users, total))
}

/// 读取关注列表。group_ids 为空表示全部关注，否则逐个分组取并集。
#[tauri::command]
pub async fn get_follow_users(
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, FollowSearchControl>,
    relation: String,
    group_ids: Vec<String>,
) -> Result<Vec<FollowUser>, String> {
    let _ = write_log(&app, "INFO", "follow", "开始读取关注列表");
    let mut users = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if !wait_for_follow_resume(&control).await { return Ok(users); }
    let cookie = store.cookie()?;
    if check_cookie_availability(&cookie).await? != "valid" {
        return Err("Cookie 已失效，请重新登录微博后再读取关注列表。".into());
    }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化关注请求失败：{e}"))?;

    // 每个来源（全部关注，或每个分组）单独翻页；同一人出现在多个分组时只保留一次。
    let sources: Vec<Option<String>> = if group_ids.is_empty() {
        vec![None]
    } else {
        group_ids.into_iter().map(Some).collect()
    };

    for source in sources {
        let mut page = 1u32;
        loop {
            if !wait_for_follow_resume(&control).await { return Ok(users); }
            if !wait_follow_interval(&app, &control).await { return Ok(users); }
            let (batch, total) = fetch_follow_page(
                &client, &cookie,
                if source.is_some() { FOLLOW_GROUP_MEMBERS_API } else { FOLLOW_LIST_API },
                page, source.as_deref(),
            ).await?;
            if control.cancelled.load(Ordering::Relaxed) { return Ok(users); }
            if batch.is_empty() { break; }
            let mut added = 0;
            for user in batch {
                if control.cancelled.load(Ordering::Acquire) || control.cookie_removal.load(Ordering::Acquire) {
                    return Ok(users);
                }
                if !relation_matches(&user, &relation) { continue; }
                if seen.insert(user.id.clone()) {
                    added += 1;
                    users.push(user.clone());
                    let _ = app.emit("follow-user-item", user);
                }
            }
            // 接口已经翻过最后一页，或整页都被关系条件过滤掉时结束该来源。
            if (total > 0 && (page as u64) * 20 >= total) || added == 0 || page >= 500 { break; }
            page += 1;
        }
    }
    let _ = write_log(&app, "INFO", "follow", &format!("关注列表读取结束，共收集 {} 人", users.len()));
    Ok(users)
}

#[tauri::command]
pub fn create_follow_task(
    app: AppHandle,
    post_ids: Vec<String>,
    relation: String,
    group_names: Vec<String>,
    keyword: String,
) -> Result<FollowTask, String> {
    if post_ids.is_empty() { return Err("请至少选择一个要取关的用户后再创建任务。".into()); }
    if post_ids.iter().any(|id| id.trim().is_empty()) { return Err("选中的用户编号无效，请刷新列表后重试。".into()); }
    let mut db = db_connection(&app)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("无法锁定取关任务记录：{e}"))?;
    let mut requested = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for post_id in post_ids {
        if seen.insert(post_id.clone()) { requested.push(post_id); }
    }
    let mut claimed = std::collections::HashSet::new();
    {
        let mut statement = tx.prepare("SELECT detail FROM tasks WHERE kind=?1 AND state IN ('未开始','排队中','执行中','暂停中','已暂停','失败')")
            .map_err(|e| format!("检查重复取关任务失败：{e}"))?;
        let rows = statement.query_map(params![TASK_KIND], |row| row.get::<_, String>(0))
            .map_err(|e| format!("读取现有取关任务失败：{e}"))?;
        for row in rows {
            let serialized = row.map_err(|e| format!("读取现有取关任务失败：{e}"))?;
            if let Ok(existing) = serde_json::from_str::<FollowTask>(&serialized) {
                claimed.extend(existing.post_ids);
            }
        }
    }
    let skipped = requested.iter().filter(|post_id| claimed.contains(*post_id)).count();
    let post_ids: Vec<String> = requested.into_iter().filter(|post_id| !claimed.contains(post_id)).collect();
    if post_ids.is_empty() {
        return Err("所选用户都已存在于其他未完成的取关任务中，请先处理或重试原任务。".into());
    }
    let id = unix_millis();
    let created_at = format!("{id}");
    let relation_label = match relation.as_str() {
        "followme" => "互相关注",
        "notfollowme" => "非互相关注",
        _ => "全部关注",
    };
    let detail = format!("待确认 {} 人，关系 {}{}{}{}",
        post_ids.len(), relation_label,
        if group_names.is_empty() { String::new() } else { format!("，分组 {}", group_names.join("、")) },
        if keyword.trim().is_empty() { String::new() } else { format!("，关键词 {}", keyword.trim()) },
        if skipped > 0 { format!("，已跳过与其他未完成任务重叠的 {} 人", skipped) } else { String::new() });
    let task = FollowTask {
        id, title: format!("取消关注 {} 人", post_ids.len()), kind: TASK_KIND.into(),
        state: "未开始".into(), progress: 0, detail, created_at: created_at.clone(),
        post_ids, relation, group_names, keyword, results: Vec::new(),
    };
    tx.execute(
        "INSERT INTO tasks (id, kind, state, created_at, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task.id.to_string(), TASK_KIND, task.state, task.created_at,
            serde_json::to_string(&task).map_err(|e| format!("序列化取关任务失败：{e}"))?],
    ).map_err(|e| format!("保存取关任务失败：{e}"))?;
    tx.commit().map_err(|e| format!("提交取关任务失败：{e}"))?;
    let _ = app.emit("follow-task-updated", task.clone());
    Ok(task)
}

fn load_follow_task(app: &AppHandle, task_id: u64) -> Result<FollowTask, String> {
    let db = db_connection(app)?;
    let detail: Option<String> = db.query_row(
        "SELECT detail FROM tasks WHERE id=?1 AND kind=?2",
        params![task_id.to_string(), TASK_KIND],
        |row| row.get(0),
    ).optional().map_err(|e| format!("读取取关任务失败：{e}"))?;
    let serialized = detail.ok_or_else(|| format!("取关任务 #{task_id} 不存在或已被删除。"))?;
    serde_json::from_str(&serialized).map_err(|e| format!("解析取关任务失败：{e}"))
}

fn save_follow_task(app: &AppHandle, task: &FollowTask) -> Result<(), String> {
    let db = db_connection(app)?;
    let changed = db.execute(
        "UPDATE tasks SET state=?1, detail=?2 WHERE id=?3 AND kind=?4",
        params![task.state, serde_json::to_string(task).map_err(|e| format!("序列化取关任务失败：{e}"))?, task.id.to_string(), TASK_KIND],
    ).map_err(|e| format!("保存取关任务失败：{e}"))?;
    if changed == 0 { return Err(format!("取关任务 #{} 不存在或已被删除。", task.id)); }
    Ok(())
}

#[tauri::command]
pub async fn set_follow_task_paused(
    task_id: u64,
    paused: bool,
    app: AppHandle,
    control: State<'_, FollowSearchControl>,
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
        let mut task = load_follow_task(&app, task_id)?;
        if task.state != "已完成" && task.state != "失败" {
            task.state = "已暂停".into();
            task.detail = format!("已暂停，已处理 {}/{} 人", task.results.len(), task.post_ids.len());
            save_follow_task(&app, &task)?;
            let _ = app.emit("follow-task-updated", task.clone());
        }
        return Ok(task.state);
    }
    control.task_paused.store(false, Ordering::Release);
    let task = load_follow_task(&app, task_id)?;
    Ok(task.state)
}

#[tauri::command]
pub fn set_follow_task_cancelled(cancelled: bool, control: State<'_, FollowSearchControl>) {
    control.task_cancelled.store(cancelled, Ordering::Relaxed);
    if cancelled { control.task_paused.store(false, Ordering::Relaxed); }
}

async fn destroy_follow(client: &reqwest::Client, uid: &str, cookie: &str, xsrf: &str) -> Result<(), String> {
    let response = client.post(FOLLOW_DESTROY_API)
        .header(COOKIE, cookie).header(USER_AGENT, WEB_UA)
        .header(REFERER, "https://weibo.com/").header(ACCEPT, "application/json, text/plain, */*")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("X-Xsrf-Token", xsrf)
        .header(CONTENT_TYPE, "application/json;charset=UTF-8")
        .json(&serde_json::json!({ "uid": uid }))
        .send().await.map_err(|e| format!("取关请求失败：{e}"))?;
    let status = response.status();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(format!("微博拒绝取关请求（HTTP {}），请检查登录状态。", status.as_u16()));
    }
    if status.as_u16() == 429 || status.as_u16() == 418 {
        return Err(format!("微博返回限流响应（HTTP {}），请稍后重试。", status.as_u16()));
    }
    let body: Value = response.json().await.map_err(|e| format!("取关响应解析失败：{e}"))?;
    // 成功时返回被取关用户的对象，不再带 ok 字段。
    if status.is_success() && (body.get("id").is_some() || json_ok(&body)) {
        return Ok(());
    }
    let message = api_error_message(&body);
    // 20522：这个人当前不在关注列表里（可能已被取关），按已跳过处理。
    if message.contains("20522") {
        return Err("该用户已不在关注列表，已跳过。".into());
    }
    if looks_rate_limited(&body) {
        return Err(format!("微博提示请求过于频繁（{}），已停止任务。", message));
    }
    Err(format!("微博拒绝了取关请求：{message}"))
}

async fn wait_follow_task_resume(control: &FollowSearchControl) -> bool {
    while control.task_paused.load(Ordering::Acquire) && !control.task_cancelled.load(Ordering::Acquire) {
        task_sleep(150).await;
    }
    !control.task_cancelled.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn execute_follow_task(
    task_id: u64,
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, FollowSearchControl>,
    execution_gate: State<'_, crate::task_execution::TaskExecutionGate>,
) -> Result<FollowTask, String> {
    if control.cookie_removal.load(Ordering::Acquire) { return Err("正在删除 Cookie，请稍后重试。".into()); }
    if control.task_running.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() {
        return Err("已有取关任务正在执行，请等待当前任务结束。".into());
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
    if control.task_cancelled.load(Ordering::Acquire) { return Err("取关任务已停止。".into()); }
    let result = execute_follow_task_inner(task_id, app.clone(), &store, &control).await;
    if let Err(error) = &result {
        if let Ok(mut task) = load_follow_task(&app, task_id) {
            if task.state != "已完成" && task.state != "已暂停" && !error.contains("该取关任务已经在执行") {
                task.state = "失败".into();
                task.detail = error.to_string();
                if save_follow_task(&app, &task).is_ok() { let _ = app.emit("follow-task-updated", task); }
            }
        }
    }
    result
}

async fn execute_follow_task_inner(
    task_id: u64,
    app: AppHandle,
    store: &SessionStore,
    control: &FollowSearchControl,
) -> Result<FollowTask, String> {
    let mut task = load_follow_task(&app, task_id)?;
    if task.post_ids.is_empty() { return Err("任务中没有可取关的用户。".into()); }
    if task.state == "执行中" { return Err("该取关任务已经在执行。".into()); }
    if task.state == "已完成" { return Err("该任务已完成，不能重复执行。".into()); }

    let cookie = match store.cookie() {
        Ok(cookie) => cookie,
        Err(error) => {
            task.state = "失败".into(); task.detail = error.clone();
            save_follow_task(&app, &task)?; let _ = app.emit("follow-task-updated", task.clone());
            return Err(error);
        }
    };
    match check_cookie_availability(&cookie).await {
        Ok(state) if state == "valid" => {}
        Ok(_) => {
            let error = "Cookie 已失效，请重新登录微博后再执行取关任务。".to_string();
            task.state = "失败".into(); task.detail = error.clone();
            save_follow_task(&app, &task)?; let _ = app.emit("follow-task-updated", task.clone());
            return Err(error);
        }
        Err(error) => {
            task.state = "失败".into(); task.detail = error.clone();
            save_follow_task(&app, &task)?; let _ = app.emit("follow-task-updated", task.clone());
            return Err(error);
        }
    }
    if control.task_cancelled.load(Ordering::Acquire) { return Err("取关任务已停止。".into()); }
    if control.task_paused.load(Ordering::Acquire) {
        task.state = "已暂停".into(); task.detail = "已暂停，尚未发送取关请求".into();
        save_follow_task(&app, &task)?; let _ = app.emit("follow-task-updated", task.clone());
        return Ok(task);
    }

    let xsrf = xsrf_token_from_cookie(&cookie).ok_or_else(||
        "当前 Cookie 缺少 XSRF-TOKEN，无法发送取关请求。请重新登录微博后再试。".to_string())?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化取关请求失败：{e}"))?;

    let retry = task.state == "失败" || task.state == "已暂停";
    let finished: std::collections::HashSet<String> = task.results.iter()
        .filter(|item| item.state == "已取关" || item.state == "已跳过")
        .map(|item| item.post_id.clone())
        .collect();
    let mut claimed = std::collections::HashSet::new();
    {
        let db = db_connection(&app)?;
        let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind=?1 AND id<>?2 AND state IN ('未开始','排队中','执行中','暂停中','已暂停','失败')")
            .map_err(|e| format!("执行前检查重复取关失败：{e}"))?;
        let rows = statement.query_map(params![TASK_KIND, task.id.to_string()], |row| row.get::<_, String>(0))
            .map_err(|e| format!("读取其他取关任务失败：{e}"))?;
        for row in rows {
            let json = row.map_err(|e| format!("读取其他取关任务失败：{e}"))?;
            if let Ok(other) = serde_json::from_str::<FollowTask>(&json) { claimed.extend(other.post_ids); }
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
        task.results.push(FollowResult { post_id: id, state: "跳过重复".into(), detail: "该用户已存在于其他未完成取关任务，本次跳过；重试时会再次检查".into() });
    }
    if targets.is_empty() {
        task.state = "失败".into();
        task.progress = ((task.results.len() * 100) / task.post_ids.len()).min(100) as u8;
        task.detail = "本次没有可取关的用户：全部项目均已处理或与其他未完成任务重叠".into();
        save_follow_task(&app, &task)?;
        let _ = app.emit("follow-task-updated", task.clone());
        return Ok(task);
    }

    task.state = "执行中".into();
    task.progress = ((finished.len() * 100) / task.post_ids.len()).min(100) as u8;
    task.detail = format!("正在取消关注，待处理 {} 人", targets.len());
    save_follow_task(&app, &task)?;
    let _ = app.emit("follow-task-updated", task.clone());

    for id in targets {
        if !wait_follow_task_resume(control).await { break; }
        let outcome = destroy_follow(&client, &id, &cookie, &xsrf).await;
        let (state, detail) = match outcome {
            Ok(()) => ("已取关".to_string(), "微博已返回取关成功".to_string()),
            Err(error) if error.contains("已跳过") => ("已跳过".to_string(), error),
            Err(error) => ("失败".to_string(), error),
        };
        let fatal = detail.contains("HTTP 401") || detail.contains("HTTP 403") || detail.contains("风控") || detail.contains("请求过于频繁");
        task.results.retain(|result| result.post_id != id);
        task.results.push(FollowResult { post_id: id, state, detail });
        task.progress = ((task.results.len() * 100) / task.post_ids.len()).min(100) as u8;
        let ok = task.results.iter().filter(|item| item.state == "已取关").count();
        let skipped = task.results.iter().filter(|item| item.state == "已跳过").count();
        let failed = task.results.iter().filter(|item| item.state == "失败").count();
        task.detail = format!("已处理 {}/{} 人；取关 {} 人，跳过 {} 人，失败 {} 人",
            task.results.len(), task.post_ids.len(), ok, skipped, failed);
        save_follow_task(&app, &task)?;
        let _ = app.emit("follow-task-updated", task.clone());
        if fatal { break; }
        task_sleep(crate::settings::request_delay_ms(&app)).await;
    }

    if control.task_cancelled.load(Ordering::Relaxed) {
        task.state = "失败".into();
        task.detail = format!("任务已停止，已处理 {}/{} 人", task.results.len(), task.post_ids.len());
    } else if control.task_paused.load(Ordering::Acquire) {
        task.state = "已暂停".into();
        task.detail = format!("已暂停，已处理 {}/{} 人", task.results.len(), task.post_ids.len());
    } else if task.results.iter().any(|item| item.state == "失败") || task.results.len() < task.post_ids.len() {
        task.state = "失败".into();
    } else {
        task.state = "已完成".into();
    }
    save_follow_task(&app, &task)?;
    let _ = app.emit("follow-task-updated", task.clone());
    Ok(task)
}

#[tauri::command]
pub fn get_follow_tasks(app: AppHandle) -> Result<Vec<FollowTask>, String> {
    let db = db_connection(&app)?;
    let mut statement = db.prepare("SELECT detail FROM tasks WHERE kind=?1 ORDER BY created_at DESC")
        .map_err(|e| format!("读取取关任务失败：{e}"))?;
    let rows = statement.query_map(params![TASK_KIND], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询取关任务失败：{e}"))?;
    let mut tasks = Vec::new();
    for row in rows {
        let serialized = row.map_err(|e| format!("读取取关任务记录失败：{e}"))?;
        if let Ok(task) = serde_json::from_str::<FollowTask>(&serialized) { tasks.push(task); }
    }
    Ok(tasks)
}

#[tauri::command]
pub fn remove_follow_tasks(
    task_ids: Vec<u64>,
    app: AppHandle,
    control: State<'_, FollowSearchControl>,
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
        return Err("有取关任务正在执行，请稍后重试删除。".into());
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
