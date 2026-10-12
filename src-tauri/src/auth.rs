//! 微博认证流程：打开官方扫码页面、从 WebView Cookie 存储中读取会话。
//!
//! Cookie 属于认证凭据：本模块禁止将其写入日志。Cookie 持久化到本地配置目录，
//! 并仅在用户主动查看时通过专用命令返回前端；Cookie 是否仍可用于具体下载请求，
//! 应由后续下载接口的实际响应判断。

use reqwest::header::{ACCEPT, COOKIE, USER_AGENT};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Mutex;
use crate::logger::write_log;
use tauri::{
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow,
};
use url::Url;

const LOGIN_URL: &str = "https://passport.weibo.com/sso/signin?entry=wapsso&source=wapsso&url=https://m.weibo.cn";
// 只读取移动版及 cn 站点的 Cookie；passport.weibo.com 仅作为认证入口，不进入最终会话。
const COOKIE_URLS: &[&str] = &[
    "https://m.weibo.cn/",
    "https://weibo.cn/",
];

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

/// Tauri 管理的认证状态。Cookie 持久化在独立的本地配置文件中。
pub struct SessionStore(Mutex<Option<ActiveSession>>);

impl Default for SessionStore {
    fn default() -> Self { Self(Mutex::new(None)) }
}

impl SessionStore {
    /// 为后端微博 API 提供会话 Cookie；Cookie 不会返回给前端任务对象或写入日志。
    pub(crate) fn cookie(&self) -> Result<String, String> {
        let current = self.0.lock().map_err(|_| "读取微博会话失败，请重启应用后重试。".to_string())?;
        current.as_ref().map(|session| session.cookie.clone())
            .filter(|cookie| !cookie.trim().is_empty())
            .ok_or_else(|| "尚未登录微博，请先扫码登录或导入 Cookie。".to_string())
    }

    pub fn from_saved_cookie(cookie: Option<String>) -> Self {
        let session = cookie.filter(|value| !value.trim().is_empty()).map(|cookie| ActiveSession {
            cookie,
            account: account_for_acquired_session(),
        });
        Self(Mutex::new(session))
    }
}

fn persist_cookie(app: &AppHandle, cookie: Option<&str>) -> Result<(), String> {
    crate::settings::save_cookie(app, cookie)
}

#[tauri::command]
pub async fn start_qr_login(app: AppHandle) -> Result<(), String> {
    let _ = write_log(&app, "INFO", "auth", "用户请求打开微博扫码登录窗口");
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
    let _ = write_log(&app, "INFO", "auth", "微博扫码登录窗口已打开");
    Ok(())
}

/// 从嵌入式 WebView 的 Cookie 存储读取 Cookie，包含 HttpOnly/Secure 项。
/// 只查询 m.weibo.cn 和 weibo.cn，避免将 passport.weibo.com 或 weibo.com 的 Cookie
/// 混入下载会话。Windows WebView2 的 Cookie 读取可能阻塞，因此放入阻塞任务中执行。
fn collect_login_cookie(window: WebviewWindow) -> Result<String, String> {
    let mut cookie_map = BTreeMap::<String, String>::new();

    for raw_url in COOKIE_URLS {
        let url = Url::parse(raw_url).map_err(|error| format!("Cookie 来源地址无效：{error}"))?;
        let cookies = window
            .cookies_for_url(url)
            .map_err(|error| format!("读取微博 Cookie 失败：{error}"))?;

        for cookie in cookies {
            // 与参考项目一致，按 Cookie 名称去重，避免请求头中出现重复名称。
            cookie_map.insert(cookie.name().to_owned(), cookie.value().to_owned());
        }
    }

    if cookie_map.is_empty() {
        return Err("没有读取到 m.weibo.cn 或 weibo.cn 的 Cookie。请先完成扫码登录后重试。".into());
    }

    Ok(cookie_map
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

/// 登录流程必须取得非空的相关登录 Cookie；不依赖固定账号资料接口返回用户 ID。
fn has_login_cookie(cookie: &str) -> bool {
    cookie
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .any(|(name, value)| {
            !value.trim().is_empty()
                && matches!(name.trim(), "SUB" | "SUBP" | "SSOLoginState" | "ALF")
        })
}

fn account_for_acquired_session() -> WeiboAccount {
    WeiboAccount {
        // 账号资料不再作为登录门槛；后续真实接口可在成功响应中补充 UID 和昵称。
        uid: String::new(),
        screen_name: "微博会话已获取".to_string(),
        avatar_url: None,
    }
}

fn validate_imported_cookie_format(cookie: &str) -> Result<(), String> {
    let has_valid_pair = cookie.split(';').any(|part| {
        let Some((name, value)) = part.trim().split_once('=') else {
            return false;
        };
        !name.trim().is_empty() && !value.trim().is_empty()
    });

    if !has_valid_pair {
        return Err("Cookie 格式不正确，请粘贴包含“名称=值”的单行 Cookie。".into());
    }
    Ok(())
}

/// 在微博官方网页窗口内添加验证按钮。通过窗口标题传递点击动作，不向远程网页暴露 Tauri API。
#[tauri::command]
pub async fn ensure_qr_login_controls(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("weibo-login") else { return Ok(()); };
    let script = r#"(function(){
      if (!document.body || document.getElementById('__wm_qr_controls')) return;
      const style=document.createElement('style');
      style.id='__wm_qr_controls_style';
      style.textContent='#__wm_qr_controls{position:fixed;z-index:2147483000;right:18px;bottom:18px;display:flex;align-items:center;gap:12px;padding:12px 14px;background:#fff;border:1px solid #dbe2ef;border-radius:12px;box-shadow:0 8px 28px rgba(20,35,70,.22);font:14px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#26334a}#__wm_qr_controls button{border:0;border-radius:7px;padding:10px 14px;background:#4e68d9;color:white;font-weight:600;cursor:pointer}#__wm_qr_controls button.secondary{background:#eef1f7;color:#47536a}#__wm_qr_error_backdrop{position:fixed;inset:0;z-index:2147483600;background:rgba(18,26,43,.48);display:grid;place-items:center;font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}#__wm_qr_error_box{width:min(420px,calc(100vw - 40px));box-sizing:border-box;background:white;color:#27334d;border-radius:12px;padding:24px;box-shadow:0 18px 60px rgba(0,0,0,.28)}#__wm_qr_error_box h3{margin:0 0 12px;font-size:17px}#__wm_qr_error_box p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;color:#a32626}#__wm_qr_error_box button{display:block;margin:20px 0 0 auto;border:0;border-radius:7px;padding:9px 16px;background:#4e68d9;color:white;font-weight:600;cursor:pointer}';
      document.head.appendChild(style);
      const root=document.createElement('div');root.id='__wm_qr_controls';
      const label=document.createElement('span');label.textContent='完成扫码后，点击验证并获取 Cookie';
      const verify=document.createElement('button');verify.textContent='已登录，验证并获取 Cookie';
      verify.onclick=function(){window.location.hash='__WM_VERIFY_QR__';};
      const close=document.createElement('button');close.className='secondary';close.textContent='关闭';close.onclick=function(){window.location.hash='__WM_CLOSE_QR__';};
      root.append(label,verify,close);document.body.appendChild(root);
    })();"#;
    window.eval(script).map_err(|error| format!("无法在微博网页窗口添加验证按钮：{error}"))
}

#[tauri::command]
pub async fn show_qr_login_error(app: AppHandle, message: String) -> Result<(), String> {
    let Some(window) = app.get_webview_window("weibo-login") else { return Ok(()); };
    let encoded = serde_json::to_string(&message).map_err(|error| format!("编码登录错误信息失败：{error}"))?;
    let script = format!(r#"(function(){{
      const old=document.getElementById('__wm_qr_error_backdrop'); if(old) old.remove();
      const back=document.createElement('div'); back.id='__wm_qr_error_backdrop';
      const box=document.createElement('div'); box.id='__wm_qr_error_box'; box.setAttribute('role','alertdialog'); box.setAttribute('aria-modal','true');
      const title=document.createElement('h3'); title.textContent='Cookie 验证失败';
      const detail=document.createElement('p'); detail.textContent={encoded};
      const button=document.createElement('button'); button.textContent='知道了'; button.onclick=function(){{back.remove();}};
      box.append(title,detail,button); back.appendChild(box); document.body.appendChild(back);
    }})();"#);
    window.eval(&script).map_err(|error| format!("无法显示扫码验证错误：{error}"))
}

#[tauri::command]
pub async fn take_qr_login_action(app: AppHandle) -> Result<Option<String>, String> {
    let Some(window) = app.get_webview_window("weibo-login") else { return Ok(None); };
    // 使用 URL fragment 传递网页按钮动作，避免依赖 WebView 对 document.title 的同步。
    if let Ok(url) = window.url() {
        match url.fragment() {
            Some("__WM_VERIFY_QR__") => {
                let _ = window.eval("window.location.hash = '';");
                return Ok(Some("verify".into()));
            }
            Some("__WM_CLOSE_QR__") => {
                let _ = window.eval("window.location.hash = '';");
                return Ok(Some("close".into()));
            }
            _ => {}
        }
    }

    // 兼容旧版通过窗口标题传递动作的情况。
    let title = window.title().map_err(|error| format!("读取微博登录窗口标题失败：{error}"))?;
    if title == "__WM_VERIFY_QR__" {
        window.set_title("微博扫码登录").map_err(|error| format!("恢复微博登录窗口标题失败：{error}"))?;
        return Ok(Some("verify".into()));
    }
    if title == "__WM_CLOSE_QR__" {
        window.set_title("微博扫码登录").map_err(|error| format!("恢复微博登录窗口标题失败：{error}"))?;
        return Ok(Some("close".into()));
    }
    Ok(None)
}

/// 查询微博官方登录窗口是否仍打开；此命令不读取或保存 Cookie。
#[tauri::command]
pub fn is_qr_login_window_open(app: AppHandle) -> bool { app.get_webview_window("weibo-login").is_some() }
#[tauri::command]
pub async fn close_qr_login_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("weibo-login") {
        window.close().map_err(|error| format!("无法关闭微博登录窗口：{error}"))?;
    }
    Ok(())
}
#[tauri::command]
pub async fn finish_qr_login(
    app: AppHandle,
    store: State<'_, SessionStore>,
 ) -> Result<WeiboAccount, String> {
    let _ = write_log(&app, "INFO", "auth", "开始验证扫码登录状态");
    let login_window = app
        .get_webview_window("weibo-login")
        .ok_or_else(|| "请先点击“打开微博扫码登录”，再完成扫码。".to_string())?;

    let cookie = tauri::async_runtime::spawn_blocking(move || collect_login_cookie(login_window))
        .await
        .map_err(|error| format!("读取登录窗口 Cookie 的任务失败：{error}"))??;

    if !has_login_cookie(&cookie) {
        return Err("尚未读取到有效的 m.weibo.cn / weibo.cn 登录 Cookie，请确认扫码登录已完成。".into());
    }

    let account = account_for_acquired_session();
    persist_cookie(&app, Some(&cookie))?;
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
    let _ = write_log(&app, "INFO", "auth", "扫码登录完成");
    Ok(account)
}

#[tauri::command]
pub async fn import_weibo_cookie(
    app: AppHandle,
    cookie: String,
    store: State<'_, SessionStore>,
 ) -> Result<WeiboAccount, String> {
    let _ = write_log(&app, "INFO", "auth", "用户提交 Cookie 导入（不记录 Cookie 内容）");
    let cookie = cookie.trim().to_owned();
    if cookie.is_empty() {
        return Err("Cookie 不能为空。".into());
    }
    if cookie.contains('\n') || cookie.contains('\r') {
        return Err("Cookie 格式不正确，请粘贴单行 Cookie 请求头。".into());
    }
    validate_imported_cookie_format(&cookie)?;

    // 导入时不请求固定资料接口。Cookie 的实际可用性由后续 m.weibo.cn 下载响应判断。
    let account = account_for_acquired_session();
    persist_cookie(&app, Some(&cookie))?;
    let mut current = store.0.lock().map_err(|_| "认证状态锁定失败，请重启应用后重试。".to_string())?;
    *current = Some(ActiveSession {
        cookie,
        account: account.clone(),
    });
    let _ = write_log(&app, "INFO", "auth", "Cookie 已导入（未记录 Cookie 内容或账号标识）");
    Ok(account)
}

/// 只在用户主动查看 Cookie 时调用此命令；普通账号状态查询不返回 Cookie。
#[tauri::command]
pub fn get_weibo_cookie(store: State<'_, SessionStore>) -> Result<Option<String>, String> {
    let current = store.0.lock().map_err(|_| "读取认证状态失败，请重启应用后重试。".to_string())?;
    Ok(current.as_ref().map(|session| session.cookie.clone()))
}

/// 统一检测 Cookie 是否仍可访问微博登录态；后续媒体下载也应复用此函数。
pub(crate) async fn check_cookie_availability(cookie: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|error| format!("创建 Cookie 检测请求失败：{error}"))?;
    let response = client
        .get("https://weibo.cn/")
        .header(ACCEPT, "text/html,application/xhtml+xml")
        .header(COOKIE, cookie)
        .header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36")
        .send()
        .await
        .map_err(|error| format!("网络请求失败：{error}"))?;

    let status = response.status();
    if status.as_u16() == 401 {
        return Ok("invalid".to_string());
    }
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err(format!("微博返回 HTTP {}，暂时无法判断 Cookie 状态。", status.as_u16()));
    }
    if !status.is_success() {
        return Err(format!("微博返回 HTTP {}，检测失败。", status.as_u16()));
    }

    let final_url = response.url().as_str().to_ascii_lowercase();
    let body = response.text().await
        .map_err(|error| format!("读取微博响应失败：{error}"))?;
    let body_lower = body.to_ascii_lowercase();
    if final_url.contains("login") || final_url.contains("passport") ||
        body.contains("请先登录") || body.contains("登录后") {
        return Ok("invalid".to_string());
    }
    if body_lower.contains("logout.php") || body.contains("退出") {
        return Ok("valid".to_string());
    }
    Err("微博响应未能明确确认登录状态，请稍后重试。".to_string())
}

#[tauri::command]
pub async fn check_weibo_cookie(store: State<'_, SessionStore>) -> Result<String, String> {
    let cookie = store.cookie()?;
    check_cookie_availability(&cookie).await
}

/// 只向前端返回账号状态，不返回 Cookie 本身。
#[tauri::command]
pub fn get_weibo_account(store: State<'_, SessionStore>) -> Result<Option<WeiboAccount>, String> {
    let current = store.0.lock().map_err(|_| "读取认证状态失败，请重启应用后重试。".to_string())?;
    Ok(current.as_ref().map(|session| session.account.clone()))
}

#[tauri::command]
pub async fn delete_weibo_cookie(
    app: AppHandle,
    store: State<'_, SessionStore>,
    control: State<'_, crate::delete::DeleteSearchControl>,
    download_control: State<'_, crate::download::DownloadControl>,
) -> Result<(), String> {
    download_control.cancelled.store(true, std::sync::atomic::Ordering::Release);
    download_control.paused.store(false, std::sync::atomic::Ordering::Release);
    crate::delete::begin_cookie_removal(&control).await;
    let result = (|| -> Result<(), String> {
        let _ = write_log(&app, "INFO", "auth", "用户请求删除 Cookie 及关联任务");
        let previous_cookie = {
            let current = store.0.lock().map_err(|_| "读取认证状态失败，请重启应用后重试。".to_string())?;
            current.as_ref().map(|session| session.cookie.clone())
        };

        let data_dir = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?;
        std::fs::create_dir_all(&data_dir).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
        let mut db = Connection::open(data_dir.join("weibo-manager.sqlite3"))
            .map_err(|error| format!("无法打开任务数据库：{error}"))?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL);")
            .map_err(|error| format!("初始化任务表失败：{error}"))?;

        let tx = db.transaction().map_err(|error| format!("无法开始任务清理事务：{error}"))?;
        tx.execute("DELETE FROM tasks", [])
            .map_err(|error| format!("删除 Cookie 关联任务失败：{error}"))?;
        persist_cookie(&app, None)?;
        if let Err(error) = tx.commit() {
            if let Some(cookie) = previous_cookie.as_deref() {
                let _ = persist_cookie(&app, Some(cookie));
            }
            return Err(format!("清理任务记录失败，已尝试恢复 Cookie：{error}"));
        }

        let mut current = store.0.lock().map_err(|_| "清理认证状态失败，请重启应用后重试。".to_string())?;
        *current = None;
        drop(current);
        if let Some(window) = app.get_webview_window("weibo-login") {
            let _ = window.close();
        }
        // Shared event contract: Cookie-dependent modules (including future media downloads)
        // must clear in-memory queues and reload persisted state when this event fires.
        let _ = app.emit("cookie-deleted", ());
        let _ = write_log(&app, "INFO", "auth", "Cookie 与关联任务已删除");
        Ok(())
    })();
    crate::delete::finish_cookie_removal(&control);
    result
}
