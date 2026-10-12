use crate::{auth::SessionStore, logger::write_log, settings};
use chrono::{DateTime, FixedOffset, Local};
use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Clone, Serialize)]
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
    user: String,
    completed: usize,
    total: usize,
    detail: String,
}

fn safe_name(value: &str) -> String {
    let name: String = value.chars().map(|c| {
        if c.is_control() || ['<', '>', ':', '"', '/', '\\', '|', '?', '*'].contains(&c) { '-' } else { c }
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
    let id = url.path_segments().and_then(|mut segments| segments.find(|s| !s.is_empty()))
        .ok_or_else(|| "无法从微博主页链接中读取 UID。".to_string())?;
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("微博主页链接中未找到数字 UID；请直接输入 UID。".into());
    }
    Ok(id.to_string())
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

#[tauri::command]
pub async fn download_media(
    app: AppHandle,
    store: State<'_, SessionStore>,
    users: Vec<String>,
    download_dir: String,
    date_from: String,
    date_to: String,
    media_type: String,
    file_template: String,
    folder_template: String,
) -> Result<Vec<DownloadSummary>, String> {
    if users.is_empty() { return Err("请先添加至少一个目标用户。".into()); }
    let cookie = store.cookie()?;
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
        let mut empty_pages = 0usize;
        let mut display_name = uid.clone();
        let mut user_folder = root.join(safe_name(&replace_template(&folder_template, &uid, "", "", 0, "")));
        fs::create_dir_all(&user_folder).map_err(|e| format!("无法创建用户目录：{e}"))?;
        let mut total = 0usize;

        loop {
            if page > 100 { break; }
            let endpoint = format!("https://m.weibo.cn/api/container/getIndex?type=uid&value={uid}&containerid=107603{uid}&page={page}");
            let response = client.get(&endpoint)
                .header(COOKIE, &cookie)
                .header(REFERER, "https://m.weibo.cn/")
                .header(ACCEPT, "application/json, text/plain, */*")
                .header(USER_AGENT, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
                .send().await.map_err(|e| format!("读取用户 {uid} 第 {page} 页失败：{e}"))?;
            if !response.status().is_success() {
                return Err(format!("读取用户 {uid} 失败：微博返回 HTTP {}。", response.status()));
            }
            let body: Value = response.json().await.map_err(|e| format!("解析用户 {uid} 的微博数据失败：{e}"))?;
            if body.get("ok").and_then(Value::as_i64) != Some(1) {
                return Err(format!("读取用户 {uid} 失败：微博接口未返回成功结果，请检查 Cookie 或 UID。"));
            }
            let cards = body.pointer("/data/cards").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut posts_this_page = 0usize;
            for card in cards {
                let Some(post) = card.get("mblog") else { continue; };
                let post_id = post.get("id").and_then(Value::as_str).or_else(|| post.get("id").and_then(Value::as_i64).map(|_| "")).unwrap_or("");
                if post_id.is_empty() { continue; }
                let post_date = post.get("created_at").and_then(Value::as_str).and_then(parse_post_date).unwrap_or_default();
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
                    total += 1;
                    let filename = replace_template(&file_template, &display_name, &post_date, post_id, total, &ext);
                    let mut target = user_folder.join(filename);
                    if target.exists() {
                        skipped += 1;
                        continue;
                    }
                    let result = client.get(&url).header(COOKIE, &cookie).header(REFERER, "https://m.weibo.cn/")
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
                        user: display_name.clone(), completed: downloaded + skipped + failed, total: 0,
                        detail: format!("已下载 {downloaded}，跳过 {skipped}，失败 {failed}"),
                    });
                }
                posts_this_page += 1;
            }
            if posts_this_page == 0 { empty_pages += 1; } else { empty_pages = 0; }
            if empty_pages >= 2 || cards.is_empty() { break; }
            page += 1;
            tokio::time::sleep(Duration::from_millis(settings::request_delay_ms(&app))).await;
        }
        summaries.push(DownloadSummary {
            user: display_name.clone(), downloaded, skipped, failed,
            detail: format!("完成：下载 {downloaded}，跳过 {skipped}，失败 {failed}"),
        });
        let _ = write_log(&app, "INFO", "download", &format!("用户 {uid} 下载结束：下载 {downloaded}，跳过 {skipped}，失败 {failed}"));
    }
    Ok(summaries)
}
