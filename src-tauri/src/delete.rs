//! 微博删除任务的只读预览与任务记录。
//! 本模块仅获取微博、保存待确认任务；不包含任何真实删除请求。

use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::auth::SessionStore;
use crate::logger::write_log;

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
pub struct DeletePostResult { pub post_id: String, pub state: String, pub detail: String }

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
    #[serde(default)]
    pub results: Vec<DeletePostResult>,
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

/// 控制列表读取的暂停与取消状态；读取任务在网络请求前后检查这些标记。
#[derive(Default)]
pub struct DeleteSearchControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    task_paused: AtomicBool,
    task_cancelled: AtomicBool,
}
#[tauri::command]
pub fn set_delete_search_paused(paused: bool, control: State<'_, DeleteSearchControl>) {
    control.paused.store(paused, Ordering::Relaxed);
}
#[tauri::command]
pub fn set_delete_search_cancelled(cancelled: bool, control: State<'_, DeleteSearchControl>) {
    control.cancelled.store(cancelled, Ordering::Relaxed);
    if cancelled {
        // 取消时解除暂停，避免暂停中的读取任务一直等待。
        control.paused.store(false, Ordering::Relaxed);
    }
}
async fn wait_for_search_resume(control: &DeleteSearchControl) -> bool {
    while control.paused.load(Ordering::Relaxed) && !control.cancelled.load(Ordering::Relaxed) {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(std::time::Duration::from_millis(150))).await.ok();
    }
    !control.cancelled.load(Ordering::Relaxed)
}
async fn wait_request_interval(app: &AppHandle, control: &DeleteSearchControl) -> bool {
    let delay = crate::settings::request_delay_ms(app);
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < delay as u128 {
        if !wait_for_search_resume(control).await { return false; }
        let remaining = delay.saturating_sub(started.elapsed().as_millis() as u64);
        let slice = remaining.min(150);
        tauri::async_runtime::spawn_blocking(move || std::thread::sleep(std::time::Duration::from_millis(slice))).await.ok();
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
#[tauri::command]
pub async fn get_delete_posts(
    date_from: String,
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, DeleteSearchControl>,
 ) -> Result<Vec<WeiboPost>, String> {
    let _ = write_log(&app, "INFO", "delete", &format!("开始读取微博列表，起始日期：{}", if date_from.trim().is_empty() { "不限" } else { date_from.as_str() }));
    let mut posts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if !wait_for_search_resume(&control).await { return Ok(posts); }
    let cookie = store.cookie()?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build()
        .map_err(|e| format!("初始化微博请求失败：{e}"))?;
    if !wait_for_search_resume(&control).await { return Ok(posts); }
    let config = client.get("https://m.weibo.cn/api/config")
        .header(COOKIE, cookie.as_str()).header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
        .header(ACCEPT, "application/json, text/plain, */*").send().await
        .map_err(|e| format!("获取微博账号信息失败，请检查网络：{e}"))?;
    if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
    if config.status().as_u16() == 401 || config.status().as_u16() == 403 {
        return Err("微博拒绝了账号信息请求（401/403）。请检查登录状态，必要时重新登录。".into());
    }
    if config.status().as_u16() == 429 {
        return Err("微博返回限流响应（HTTP 429），已停止读取。请等待一段时间后再试。".into());
    }
    if !config.status().is_success() {
        return Err(format!("获取微博账号信息失败，HTTP {}", config.status().as_u16()));
    }
    let config_json: Value = config.json().await.map_err(|e| format!("微博账号信息解析失败：{e}"))?;
    if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
    if looks_rate_limited(&config_json) {
        return Err("微博提示请求过于频繁，已停止读取。请等待一段时间后再试。".into());
    }
    let uid = config_json.pointer("/data/uid").and_then(Value::as_u64)
        .map(|v| v.to_string())
        .or_else(|| config_json.pointer("/data/uid").and_then(Value::as_str).map(str::to_string))
        .filter(|v| !v.is_empty() && v != "0")
        .ok_or_else(|| "未能从当前 Cookie 识别微博 UID。请重新登录后再试；当前不会使用模拟数据。".to_string())?;
    let _ = write_log(&app, "INFO", "delete", "已识别当前微博账号，开始分页读取（不记录账号标识）");

    for page in 1..=1000 {
        if !wait_for_search_resume(&control).await { return Ok(posts); }
        if !wait_request_interval(&app, &control).await { return Ok(posts); }
        if !wait_for_search_resume(&control).await { return Ok(posts); }
        let url = format!("https://m.weibo.cn/api/container/getIndex?containerid=107603{uid}&page={page}");
        let response = client.get(&url).header(COOKIE, &cookie)
            .header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36")
            .header(REFERER, "https://m.weibo.cn/").header(ACCEPT, "application/json, text/plain, */*")
            .send().await.map_err(|e| format!("读取微博列表失败：{e}"))?;
        if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
        if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
            return Err("微博拒绝了列表请求（401/403）。请检查登录状态，必要时重新登录。已停止继续请求。".into());
        }
        if response.status().as_u16() == 429 || response.status().as_u16() == 418 {
            return Err(format!("微博返回限流响应（HTTP {}），已停止读取。请等待一段时间后再试。", response.status().as_u16()));
        }
        if !response.status().is_success() {
            return Err(format!("读取微博列表失败，HTTP {}", response.status().as_u16()));
        }
        let body: Value = response.json().await.map_err(|e| format!("微博列表解析失败：{e}"))?;
        if control.cancelled.load(Ordering::Relaxed) { return Ok(posts); }
        if looks_rate_limited(&body) {
            return Err("微博提示请求过于频繁或触发风控，已停止读取。请等待一段时间后再试。".into());
        }
        let cards = body.pointer("/data/cards").and_then(Value::as_array)
            .ok_or_else(|| "微博列表接口没有返回预期数据；请确认登录状态有效。".to_string())?;
        let mut page_posts = Vec::new();
        for card in cards {
            if let Some(mblog) = card.get("mblog") {
                if let Some(post) = parse_post(mblog) { page_posts.push(post); }
            }
        }
        if page_posts.is_empty() { break; }
        let reached_start = !date_from.trim().is_empty() && page_posts.iter().all(|post| post.date < date_from);
        for post in page_posts {
            if seen.insert(post.id.clone()) {
                posts.push(post.clone());
                if let Err(error) = app.emit("delete-post-item", post.clone()) {
                    let _ = write_log(&app, "ERROR", "delete", &format!("逐条展示事件发送失败，微博 ID={}：{}", post.id, error));
                } else {
                    let _ = write_log(&app, "DEBUG", "delete", &format!("逐条展示事件已发送，微博 ID={}", post.id));
                }
            }
        }
        if reached_start { break; }
    }
    let _ = write_log(&app, "INFO", "delete", &format!("微博列表读取结束，共收集 {} 条微博", posts.len()));
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
        post_ids, date_from, date_to, keyword, post_type, results: Vec::new(),
    };
    let db = db_connection(&app)?;
    let serialized = serde_json::to_string(&task).map_err(|e| format!("序列化任务失败：{e}"))?;
    db.execute("INSERT INTO tasks (id, kind, state, created_at, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task.id.to_string(), "删除", task.state, task.created_at, serialized])
        .map_err(|e| format!("保存删除任务失败：{e}"))?;
    Ok(task)
}



fn save_delete_task(app: &AppHandle, task: &DeleteTask) -> Result<(), String> {
 let db=db_connection(app)?; let json=serde_json::to_string(task).map_err(|e|format!("序列化删除任务失败：{e}"))?;
 db.execute("UPDATE tasks SET state=?1, detail=?2 WHERE id=?3 AND kind='删除'",params![task.state,json,task.id.to_string()]).map_err(|e|format!("更新删除任务失败：{e}"))?; Ok(())
}
fn load_delete_task(app:&AppHandle,id:u64)->Result<DeleteTask,String>{
 let db=db_connection(app)?;let json:String=db.query_row("SELECT detail FROM tasks WHERE id=?1 AND kind='删除'",params![id.to_string()],|r|r.get(0)).map_err(|e|format!("找不到删除任务：{e}"))?;
 serde_json::from_str(&json).map_err(|e|format!("解析删除任务失败：{e}"))
}
async fn task_sleep(ms:u64){tauri::async_runtime::spawn_blocking(move||std::thread::sleep(std::time::Duration::from_millis(ms))).await.ok();}
async fn wait_delete_resume(c:&DeleteSearchControl)->bool{while c.task_paused.load(Ordering::Relaxed)&&!c.task_cancelled.load(Ordering::Relaxed){task_sleep(150).await;}!c.task_cancelled.load(Ordering::Relaxed)}
fn numeric_id_to_bid(id:&str)->Option<String>{
 const A:&[u8]=b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";if id.is_empty()||!id.bytes().all(|b|b.is_ascii_digit()){return None;}
 let mut left=id;let mut out=Vec::new();while !left.is_empty(){let start=left.len().saturating_sub(7);let mut n=left[start..].parse::<u64>().ok()?;let mut chars=Vec::new();while n>0{chars.push(A[(n%62)as usize]as char);n/=62;}if chars.is_empty(){chars.push('0');}chars.reverse();let mut p:String=chars.into_iter().collect();if start>0{p=format!("{:0>4}",p);}out.insert(0,p);left=&left[..start];}Some(out.concat())
}
fn clean_html_text(raw:&str)->String{let mut o=String::new();let mut tag=false;for c in raw.chars(){match c{'<'=>tag=true,'>'=>tag=false,_ if !tag=>o.push(c),_=>{}}}o.replace("&nbsp;"," ").replace("&amp;","&")}
fn links_for_ids(html:&str,wanted:&std::collections::HashSet<String>)->std::collections::HashMap<String,String>{
 let mut out=std::collections::HashMap::new();let mut cur=0;while let Some(rel)=html[cur..].find("<a"){let s=cur+rel;let Some(te)=html[s..].find('>')else{break};let e=s+te;let Some(cl)=html[e+1..].find("</a>")else{break};let z=e+1+cl;let tag=&html[s..=e];
 if clean_html_text(&html[e+1..z]).trim()=="删除"{if let Some(h)=tag.find("href=\""){let b=h+6;if let Some(n)=tag[b..].find('"'){let mut url=tag[b..b+n].replace("&amp;","&");if url.starts_with('/'){url=format!("https://weibo.cn{url}");}for id in wanted{if url.contains(&format!("id={id}")){out.insert(id.clone(),url.clone());}}}}}
 cur=z+4;if cur>=html.len(){break;}}out
}
fn find_anchor_url(html:&str,wanted:&[&str])->Option<String>{
 let mut cur=0;while let Some(rel)=html[cur..].find("<a"){let s=cur+rel;let e=s+html[s..].find('>')?;let z=e+1+html[e+1..].find("</a>")?;let label=clean_html_text(&html[e+1..z]).trim().to_string();
 if wanted.iter().any(|v|*v==label){let tag=&html[s..=e];if let Some(h)=tag.find("href=\""){let b=h+6;if let Some(n)=tag[b..].find('"'){let mut u=tag[b..b+n].replace("&amp;","&");if u.starts_with('/'){u=format!("https://weibo.cn{u}");}return Some(u);}}}
 cur=z+4;if cur>=html.len(){break;}}None
}
async fn delete_one(client:&reqwest::Client,url:&str,uid:&str)->Result<(),String>{
 let ua="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36";
 let first=client.get(url).header(USER_AGENT,ua).header(REFERER,"https://weibo.cn/").send().await.map_err(|e|format!("请求删除确认页失败：{e}"))?;
 if first.status().as_u16()==401||first.status().as_u16()==403{return Err(format!("HTTP {}：登录失效或触发风控，停止后续删除",first.status().as_u16()));}
 if !first.status().is_success(){return Err(format!("获取删除确认页失败，HTTP {}",first.status().as_u16()));}
 let html=first.text().await.map_err(|e|format!("读取删除确认页失败：{e}"))?;
 let confirm=find_anchor_url(&html,&["确定删除","确认删除"]).ok_or_else(||"未找到确认页的删除链接，未执行最终删除请求".to_string())?;
 let second=client.get(&confirm).header(USER_AGENT,ua).header(REFERER,"https://weibo.cn/").send().await.map_err(|e|format!("发送最终删除请求失败：{e}"))?;
 if second.status().as_u16()==401||second.status().as_u16()==403{return Err(format!("HTTP {}：登录失效或触发风控",second.status().as_u16()));}
 if !second.status().is_success(){return Err(format!("删除请求失败，HTTP {}",second.status().as_u16()));}
 let final_url=second.url().to_string();let body=second.text().await.map_err(|e|format!("读取删除结果失败：{e}"))?;
 if final_url.contains(&format!("/{uid}/profile"))||body.matches(">删除</a>").count()>=2{Ok(())}else{Err("响应页面无法确认删除成功，按失败记录以避免误报".into())}
}
#[tauri::command]
pub fn set_delete_task_paused(paused:bool,control:State<'_,DeleteSearchControl>){control.task_paused.store(paused,Ordering::Relaxed);}
#[tauri::command]
pub fn set_delete_task_cancelled(cancelled:bool,control:State<'_,DeleteSearchControl>){control.task_cancelled.store(cancelled,Ordering::Relaxed);if cancelled{control.task_paused.store(false,Ordering::Relaxed);}}
#[tauri::command]
pub async fn execute_delete_task(task_id:u64,app:AppHandle,store:State<'_,SessionStore>,control:State<'_,DeleteSearchControl>)->Result<DeleteTask,String>{
 let mut task=load_delete_task(&app,task_id)?;if task.post_ids.is_empty(){return Err("任务中没有可删除的微博 ID。".into());}if task.state=="执行中"{return Err("该删除任务已经在执行。".into());}if task.state=="已完成"{return Err("该任务已完成，不能重复执行。".into());}
 control.task_cancelled.store(false,Ordering::Relaxed);control.task_paused.store(false,Ordering::Relaxed);let cookie=store.cookie()?;
 let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(25)).build().map_err(|e|format!("初始化删除请求失败：{e}"))?;
 let config=client.get("https://m.weibo.cn/api/config").header(COOKIE,cookie.as_str()).header(USER_AGENT,"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36").header(ACCEPT,"application/json, text/plain, */*").send().await.map_err(|e|format!("验证微博会话失败：{e}"))?;
 if !config.status().is_success(){return Err(format!("验证微博会话失败，HTTP {}",config.status().as_u16()));}let json:Value=config.json().await.map_err(|e|format!("解析微博账号信息失败：{e}"))?;
 let uid=json.pointer("/data/uid").and_then(Value::as_u64).map(|v|v.to_string()).or_else(||json.pointer("/data/uid").and_then(Value::as_str).map(str::to_string)).filter(|v|!v.is_empty()&&v!="0").ok_or_else(||"无法识别当前微博 UID，未执行删除。".to_string())?;
 let retry=task.state=="失败"||task.state=="已取消";let successful:std::collections::HashSet<String>=task.results.iter().filter(|r|r.state=="已删除").map(|r|r.post_id.clone()).collect();
 let targets:Vec<String>=if retry{task.post_ids.iter().filter(|id|!successful.contains(*id)).cloned().collect()}else{task.post_ids.clone()};if targets.is_empty(){return Err("该任务没有待重试的失败项目。".into());}
 let mut id_to_bid=std::collections::HashMap::new();let mut wanted=std::collections::HashSet::new();for id in &targets{let bid=numeric_id_to_bid(id).ok_or_else(||format!("微博 ID 格式无效：{id}"))?;wanted.insert(bid.clone());id_to_bid.insert(id.clone(),bid);}
 task.state="执行中".into();task.progress=((successful.len()*100)/task.post_ids.len()).min(100)as u8;task.detail=format!("正在查找本人微博删除链接，待处理 {} 条",targets.len());if !retry{task.results.clear();}
 save_delete_task(&app,&task)?;let _=app.emit("delete-task-updated",task.clone());let mut urls=std::collections::HashMap::new();
 for page in 1..=500{if !wait_delete_resume(&control).await{break;}let response=client.get(format!("https://weibo.cn/{uid}/profile?page={page}")).header(COOKIE,&cookie).header(USER_AGENT,"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36").header(REFERER,"https://weibo.cn/").send().await.map_err(|e|format!("读取本人微博删除链接失败：{e}"))?;
 if response.status().as_u16()==401||response.status().as_u16()==403{task.state="失败".into();task.detail=format!("读取本人微博主页被拒绝（HTTP {}），尚未执行删除",response.status().as_u16());save_delete_task(&app,&task)?;let _=app.emit("delete-task-updated",task.clone());return Ok(task);}
 if !response.status().is_success(){return Err(format!("读取本人微博主页失败，HTTP {}",response.status().as_u16()));}let html=response.text().await.map_err(|e|format!("读取本人微博主页内容失败：{e}"))?;urls.extend(links_for_ids(&html,&wanted));if urls.len()>=wanted.len()||!html.contains("删除"){break;}task_sleep(crate::settings::request_delay_ms(&app)).await;}
 for id in targets{if !wait_delete_resume(&control).await{break;}let outcome=match id_to_bid.get(&id).and_then(|bid|urls.get(bid)){Some(url)=>delete_one(&client,url,&uid).await,None=>Err("未在本人微博主页中找到该微博的删除链接，未发送删除请求".into())};
 let (state,detail)=match outcome{Ok(())=>("已删除".to_string(),"已收到可确认的删除成功页面".to_string()),Err(e)=>("失败".to_string(),e)};let fatal=detail.contains("HTTP 401")||detail.contains("HTTP 403")||detail.contains("风控");
 task.results.retain(|r|r.post_id!=id);task.results.push(DeletePostResult{post_id:id,state,detail});task.progress=((task.results.len()*100)/task.post_ids.len()).min(100)as u8;let ok=task.results.iter().filter(|r|r.state=="已删除").count();let failed=task.results.iter().filter(|r|r.state=="失败").count();task.detail=format!("已处理 {}/{} 条；成功 {} 条，失败 {} 条",task.results.len(),task.post_ids.len(),ok,failed);
 save_delete_task(&app,&task)?;let _=app.emit("delete-task-updated",task.clone());if fatal{break;}task_sleep(crate::settings::request_delay_ms(&app)).await;}
 if control.task_cancelled.load(Ordering::Relaxed){task.state="已取消".into();task.detail=format!("任务已取消，已处理 {}/{} 条",task.results.len(),task.post_ids.len());}else if task.results.iter().any(|r|r.state=="失败")||task.results.len()<task.post_ids.len(){task.state="失败".into();}else{task.state="已完成".into();}
 save_delete_task(&app,&task)?;let _=app.emit("delete-task-updated",task.clone());Ok(task)
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
