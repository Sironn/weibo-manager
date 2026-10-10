import { invoke } from "@tauri-apps/api/core";

export type LogLevel = "info" | "warn" | "error" | "debug";

let enabled = false;
let initialized = false;

export async function initializeLogger(): Promise<boolean> {
  try {
    enabled = await invoke<boolean>("get_logging_enabled");
  } catch {
    enabled = false;
    return false;
  }

  if (!initialized && typeof window !== "undefined") {
    initialized = true;
    window.addEventListener("error", event => {
      log("error", "frontend", `未捕获异常：${event.message}（${event.filename}:${event.lineno}:${event.colno}）`);
    });
    window.addEventListener("unhandledrejection", event => {
      const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
      log("error", "frontend", `未处理的 Promise 异常：${reason}`);
    });
  }

  log("info", "frontend", "前端日志系统已初始化");
  return enabled;
}

export async function updateLoggerEnabled(value: boolean): Promise<boolean> {
  const saved = await invoke<boolean>("set_logging_enabled", { enabled: value });
  enabled = saved;
  return saved;
}

/// 统一前端日志入口。调用方不要传入 Cookie、令牌或其他敏感认证信息。
export function log(level: LogLevel, source: string, message: string): void {
  if (!enabled) return;
  void invoke("log_message", { level, source, message }).catch(() => {
    // 日志写入失败不能影响正常业务流程，也不能递归记录日志错误。
  });
}
