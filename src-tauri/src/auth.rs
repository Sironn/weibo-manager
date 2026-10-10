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
// 扫码窗口先收集 weibo.com 登录流程使用的 Cookie，避免把 weibo.cn
// 的同名 Cookie 合并进同一个请求头，覆盖真正用于 weibo.com 的值。
const COOKIE_URLS: &[&str] = &[
    "https://weibo.com/",
    "https://passport.weibo.com/",
];
const PROFILE_URL: &str = "https://weibo.com/ajax/setting/getBasicInfo";

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
pub async fn start_qr_login(app: AppHandle) -> Result<(), String> {
    // 窗口创建和 WebView 初始化可能触发平台级同步操作。
    // 将命令声明为 async，避免在前端 invoke 的同步调用路径中阻塞主界面事件处理。
    if let Some(window) = app.get_webview_window("weibo-login") {
        window
            .set_focus()
            .map_err(|error| format!("无法切换到微博登录窗口：{error}"))?;
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

/// 自动轮询扫码登录状态。未完成扫码或临时验证失败时返回 None，不向前端暴露 Cookie。
#[tauri::command]
pub async fn check_qr_login(
    app: AppHandle,
    store: State<'_, SessionStore>,
) -> Result<Option<WeiboAccount>, String> {
    let Some(login_window) = app.get_webview_window("weibo-login") else {
        return Ok(None);
    };

    let cookie = match tauri::async_runtime::spawn_blocking(move || collect_login_cookie(login_window)).await {
        Ok(Ok(cookie)) => cookie,
        // 登录窗口初始化期间可能暂时没有 Cookie；继续等待即可。
        _ => return Ok(None),
    };

    // 只有出现登录态相关 Cookie 后才访问验证接口，避免扫码前频繁请求微博。
    if !has_login_cookie(&cookie) {
        return Ok(None);
    }

    let account = match validate_cookie(&cookie).await {
        Ok(account) => account,
        // 扫码流程中接口可能暂时拒绝请求，下一轮继续检测；手动验证/导入仍会显示具体错误。
        Err(_) => return Ok(None),
    };

    {
        let mut current = store.0.lock().map_err(|_| "认证状态锁定失败，请重启应用后重试。".to_string())?;
        *current = Some(ActiveSession {
            cookie,
            account: account.clone(),
        });
    }

    if let Some(window) = app.get_webview_window("weibo-login") {
        let _ = window.close();
    }
    Ok(Some(account))
}

fn has_login_cookie(cookie: &str) -> bool {
    cookie.split(';').filter_map(|part| part.trim().split_once('='))
        .any(|(name, value)| {
            !value.is_empty() && matches!(name.trim(), "SUB" | "SUBP" | "SSOLoginState" | "ALF")
        })
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

/// 通过与 Cookie 域名匹配的微博接口验证会话，并从实际响应中提取账号资料。
/// 手动导入的 Cookie 不携带域名信息，因此依次尝试 weibo.com 与 m.weibo.cn。
async fn validate_cookie(cookie: &str) -> Result<WeiboAccount, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|error| format!("无法初始化微博请求客户端：{error}"))?;

    let endpoints = [
        ("https://weibo.com/ajax/setting/getBasicInfo", "https://weibo.com/"),
        ("https://m.weibo.cn/api/config", "https://m.weibo.cn/"),
    ];
    let mut last_error = "微博未确认登录身份。请确认 Cookie 来源域名与登录状态后重试。".to_string();

    for (endpoint, referer) in endpoints {
        let response = match client
            .get(endpoint)
            .header(reqwest::header::COOKIE, cookie)
            .header(reqwest::header::REFERER, referer)
            .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
            .send()
            .await
        {
            Ok(response) => response,
            Err(_) => {
                last_error = "连接微博验证接口失败，请检查网络或代理设置。".to_string();
                continue;
            }
        };

        let status = response.status();
        if !status.is_success() {
            last_error = match status.as_u16() {
                401 => "微博拒绝了当前会话（HTTP 401），Cookie 可能已过期。".to_string(),
                403 => "微博验证请求被拒绝（HTTP 403），可能触发了安全限制；请稍后重试。".to_string(),
                404 => format!("微博验证接口返回 HTTP 404：{endpoint}"),
                429 | 432 => format!("微博暂时限制了验证请求（HTTP {}），请稍后重试。", status.as_u16()),
                _ => format!("微博验证接口返回 HTTP {}。", status.as_u16()),
            };
            continue;
        }

        let body = match response.json::<Value>().await {
            Ok(body) => body,
            Err(_) => {
                last_error = "微博返回的数据无法识别，请确认网络未被拦截后重试。".to_string();
                continue;
            }
        };

        if body.get("ok").and_then(Value::as_i64).is_some_and(|ok| ok != 1) {
            let message = body.get("msg").and_then(Value::as_str).unwrap_or("");
            last_error = if message.is_empty() {
                "微博未确认当前登录状态，请重新登录后重试。".to_string()
            } else {
                format!("微博验证未通过：{message}")
            };
            continue;
        }

        // 不假定账号资料一定在 data.userInfo；微博不同域名/接口的响应层级不同。
        let uid = find_nested_string(&body, &["uid", "id", "idstr"])
            .filter(|value| !value.is_empty());
        let Some(uid) = uid else {
            last_error = format!(
                "接口 {endpoint} 已响应，但返回内容中没有可识别的用户 ID；请确认使用的是本人登录后的 Cookie。"
            );
            continue;
        };

        let screen_name = find_nested_string(&body, &["screen_name", "screenName", "nick", "nickname", "name"])
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("微博用户 {uid}"));
        let avatar_url = find_nested_string(&body, &["avatar_large", "profile_image_url", "avatar", "profile_image"])
            .filter(|value| !value.is_empty());

        return Ok(WeiboAccount { uid, screen_name, avatar_url });
    }

    Err(last_error)
}

/// 在 JSON 对象的嵌套结构中查找指定字段；兼容微博接口响应层级差异。
fn find_nested_string(value: &Value, keys: &[&str]) -> Option<String> {
    if let Some(object) = value.as_object() {
        for key in keys {
            if let Some(found) = value_as_string(object.get(*key)) {
                if !found.is_empty() {
                    return Some(found);
                }
            }
        }
        for child in object.values() {
            if let Some(found) = find_nested_string(child, keys) {
                return Some(found);
            }
        }
    } else if let Some(array) = value.as_array() {
        for child in array {
            if let Some(found) = find_nested_string(child, keys) {
                return Some(found);
            }
        }
    }
    None
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
