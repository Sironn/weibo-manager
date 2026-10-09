//! 微博认证流程：打开官方扫码页面、从 WebView Cookie 存储中读取会话，并验证账号身份。
//!
//! Cookie 属于认证凭据：本模块禁止将其写入日志或返回前端。当前阶段仅在进程内存保存，
//! 后续可在独立需求中接入系统凭据存储，避免明文落盘。

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;
use tauri::{
    webview::WebviewWindowBuilder,
    AppHandle, Manager, State, WebviewUrl, WebviewWindow,
};
use url::Url;

const LOGIN_URL: &str = "https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog&url=https%3A%2F%2Fweibo.com%2F";
const COOKIE_URLS: &[&str] = &[
    "https://weibo.com/",
    "https://passport.weibo.com/",
    "https://m.weibo.cn/",
    "https://weibo.cn/",
];
const PROFILE_URL: &str = "https://weibo.com/ajax/side/nav";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeiboAccount {
    pub uid: String,
    pub screen_name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone)]
struct ActiveSession {
    cookie: String,
    account: WeiboAccount,
}

/// Tauri 管理的认证状态。Cookie 仅存在于后端进程内存中。
#[derive(Default)]
pub struct SessionStore(Mutex<Option<ActiveSession>>);

#[tauri::command]
pub fn start_qr_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("weibo-login") {
        window.set_focus().map_err(|error| format!("无法切换到微博登录窗口：{error}"))?;
        return Ok(());
    }

    let login_url = Url::parse(LOGIN_URL).map_err(|error| format!("微博登录地址无效：{error}"))?;
    WebviewWindowBuilder::new(&app, "weibo-login", WebviewUrl::External(login_url))
        .title("微博扫码登录")
        .inner_size(1000.0, 720.0)
        .min_inner_size(760.0, 560.0)
        .center()
        .build()
        .map_err(|error| format!("无法打开微博登录窗口：{error}"))?;
    Ok(())
}

/// 从嵌入式 WebView 的 Cookie 存储读取 Cookie，包含 HttpOnly/Secure 项。
/// Windows WebView2 的 Cookie 读取可能阻塞，因此必须放入阻塞任务中执行。
fn collect_login_cookie(window: WebviewWindow) -> Result<String, String> {
    let mut cookie_map = BTreeMap::<String, String>::new();

    for raw_url in COOKIE_URLS {
        let url = Url::parse(raw_url).map_err(|error| format!("Cookie 来源地址无效：{error}"))?;
        let cookies = window
            .cookies_for_url(url)
            .map_err(|error| format!("读取微博 Cookie 失败：{error}"))?;

        for cookie in cookies {
            // 以名称去重，避免多个微博子域返回同名 Cookie 时重复拼接请求头。
            cookie_map.insert(cookie.name().to_owned(), cookie.value().to_owned());
        }
    }

    if cookie_map.is_empty() {
        return Err("没有读取到微博 Cookie。请先在弹出的窗口完成扫码登录，再重试。".into());
    }

    Ok(cookie_map
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

#[tauri::command]
pub async fn finish_qr_login(
    app: AppHandle,
    store: State<'_, SessionStore>,
) -> Result<WeiboAccount, String> {
    let login_window = app
        .get_webview_window("weibo-login")
        .ok_or_else(|| "请先点击“打开微博扫码登录”，再完成扫码。".to_string())?;

    let cookie = tauri::async_runtime::spawn_blocking(move || collect_login_cookie(login_window))
        .await
        .map_err(|error| format!("读取登录窗口 Cookie 的任务失败：{error}"))??;

    let account = validate_cookie(&cookie).await?;
    {
        let mut current = store.0.lock().map_err(|_| "认证状态锁定失败，请重启应用后重试。".to_string())?;
        *current = Some(ActiveSession {
            cookie,
            account: account.clone(),
        });
    }

    // 只有服务器确认会话有效后才关闭登录窗口，避免把未完成扫码误判为成功。
    if let Some(window) = app.get_webview_window("weibo-login") {
        let _ = window.close();
    }
    Ok(account)
}

#[tauri::command]
pub async fn import_weibo_cookie(
    cookie: String,
    store: State<'_, SessionStore>,
) -> Result<WeiboAccount, String> {
    let cookie = cookie.trim().to_owned();
    if cookie.is_empty() {
        return Err("Cookie 不能为空。".into());
    }
    if cookie.contains('\n') || cookie.contains('\r') {
        return Err("Cookie 格式不正确，请粘贴单行 Cookie 请求头。".into());
    }

    let account = validate_cookie(&cookie).await?;
    let mut current = store.0.lock().map_err(|_| "认证状态锁定失败，请重启应用后重试。".to_string())?;
    *current = Some(ActiveSession {
        cookie,
        account: account.clone(),
    });
    Ok(account)
}

/// 通过需要登录态的微博接口验证 Cookie，并从返回结果提取账号信息。
/// 仅 HTTP 成功且响应包含有效用户 ID 时才视为登录成功。
async fn validate_cookie(cookie: &str) -> Result<WeiboAccount, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|error| format!("无法初始化微博请求客户端：{error}"))?;

    let response = client
        .get(PROFILE_URL)
        .header(reqwest::header::COOKIE, cookie)
        .header(reqwest::header::REFERER, "https://weibo.com/")
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .send()
        .await
        .map_err(|_| "连接微博验证接口失败，请检查网络或代理设置。".to_string())?;

    if !response.status().is_success() {
        return Err(format!("微博验证接口返回 HTTP {}，请检查 Cookie 是否有效。", response.status()));
    }

    let body = response
        .json::<Value>()
        .await
        .map_err(|_| "微博返回的数据无法识别，Cookie 可能已失效。".to_string())?;
    let data = body.get("data").unwrap_or(&body);
    let user = data
        .get("userInfo")
        .or_else(|| data.get("user_info"))
        .unwrap_or(data);

    let uid = ["id", "uid", "idstr"]
        .iter()
        .find_map(|key| value_as_string(user.get(*key)))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "微博未确认登录身份。请重新扫码，或导入仍有效的 Cookie。".to_string())?;

    let screen_name = ["screen_name", "screenName", "name"]
        .iter()
        .find_map(|key| value_as_string(user.get(*key)))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("微博用户 {uid}"));
    let avatar_url = ["avatar_large", "profile_image_url", "avatar"]
        .iter()
        .find_map(|key| value_as_string(user.get(*key)))
        .filter(|value| !value.is_empty());

    Ok(WeiboAccount {
        uid,
        screen_name,
        avatar_url,
    })
}

fn value_as_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// 只向前端返回账号资料，不返回 Cookie 本身。
#[tauri::command]
pub fn get_weibo_account(store: State<'_, SessionStore>) -> Result<Option<WeiboAccount>, String> {
    let current = store.0.lock().map_err(|_| "读取认证状态失败，请重启应用后重试。".to_string())?;
    Ok(current.as_ref().map(|session| session.account.clone()))
}

#[tauri::command]
pub fn logout_weibo(
    app: AppHandle,
    store: State<'_, SessionStore>,
) -> Result<(), String> {
    let mut current = store.0.lock().map_err(|_| "清理认证状态失败，请重启应用后重试。".to_string())?;
    *current = None;
    drop(current);
    if let Some(window) = app.get_webview_window("weibo-login") {
        let _ = window.close();
    }
    Ok(())
}
