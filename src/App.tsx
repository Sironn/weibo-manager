import React, { useEffect, useMemo, useRef, useState } from "react";
import tauriConfig from "../src-tauri/tauri.conf.json";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { initializeLogger, log, updateLoggerEnabled } from "./lib/logger";
import {
  Activity, Archive, ArrowDownToLine, ArrowRight, Check, ChevronDown, CircleHelp, Copy,
  CloudDownload, Eye, EyeOff, FileImage, FolderOpen, Gauge, Home, Image, ListTodo,
  LockKeyhole, Moon, MoreHorizontal, Pause, Play, Plus, RefreshCw, Search, Settings2,
  ShieldCheck, Sun, Trash2, Users, Video, X,
} from "lucide-react";
import {
  buildFilename, buildFolderName, defaultFilenameSettings, filenameVariables,
  type FilenameSettings, type TemplateVariable,
} from "./lib/filenameTemplate";

type Page = "dashboard" | "accounts" | "delete" | "download" | "tasks" | "settings";
type TaskState = "未开始" | "排队中" | "执行中" | "暂停中" | "已暂停" | "已完成" | "失败";
type DeletePostResult = { postId: string; state: string; detail: string };
type DownloadSummary = { user: string; downloaded: number; skipped: number; failed: number; detail: string };
type DownloadUserDetail = { input: string; uid: string; screenName: string | null };
type DownloadTaskConfig = { users: string[]; userDetails: DownloadUserDetail[]; downloadDir: string; dateFrom: string; dateTo: string; mediaType: string; fileTemplate: string; folderTemplate: string; modifyFileTime: boolean };
type Task = { id: number; title: string; kind: "下载" | "删除"; state: TaskState; progress: number; detail: string; createdAt?: string; postIds?: string[]; dateFrom?: string; dateTo?: string; keyword?: string; postType?: string; results?: DeletePostResult[]; downloadConfig?: DownloadTaskConfig; downloadResults?: DownloadSummary[] };
type WeiboPost = { id: string; date: string; createdAt: string; kind: string; text: string; media: string };
type PersistedDeleteTask = { id: number; title: string; kind: string; state: TaskState; progress: number; detail: string; createdAt: string; postIds: string[]; dateFrom: string; dateTo: string; keyword: string; postType: string; results?: DeletePostResult[] };
type PersistedDownloadTask = { id: number; title: string; state: TaskState; progress: number; detail: string; createdAt: string; downloadConfig: DownloadTaskConfig; downloadResults?: DownloadSummary[] };
type RequestIntervalConfig = { mode: "fixed" | "random"; fixedMs: number; minMs: number; maxMs: number };
const nav: { id: Page; label: string; icon: typeof Home; group: string }[] = [
  { id: "dashboard", label: "工作台", icon: Home, group: "概览" },
  { id: "accounts", label: "Cookie 管理", icon: LockKeyhole, group: "微博管理" },
  { id: "delete", label: "微博删除", icon: Trash2, group: "微博管理" },
  { id: "download", label: "媒体下载", icon: CloudDownload, group: "微博管理" },
  { id: "tasks", label: "任务中心", icon: ListTodo, group: "系统" },
  { id: "settings", label: "设置", icon: Settings2, group: "系统" },
];
// 文件命名设置初始化：兼容旧版参数配置，并为缺失字段提供安全默认值。
const initialFilenameSettings: FilenameSettings = (() => {
  try {
    const raw = localStorage.getItem("wm-filename-settings");
    if (!raw) return defaultFilenameSettings;
    const parsed = JSON.parse(raw) as Partial<FilenameSettings> & { tokens?: string[]; separator?: string; extension?: string };
    if (typeof parsed.fileTemplate === "string" || typeof parsed.folderTemplate === "string") {
      return {
        ...defaultFilenameSettings,
        fileTemplate: parsed.fileTemplate ?? defaultFilenameSettings.fileTemplate,
        folderTemplate: parsed.folderTemplate ?? defaultFilenameSettings.folderTemplate,
      };
    }
    // 旧版按勾选参数生成的设置迁移为可编辑模板。
    const legacyNames: Record<string, string> = {
      date: "%POST_TIME%", weiboId: "%POST_ID%", index: "%MEDIA_INDEX%",
    };
    const legacyParts = (parsed.tokens ?? []).map((token) => legacyNames[token]).filter(Boolean);
    return {
      fileTemplate: legacyParts.length
        ? `${legacyParts.join(parsed.separator || "_")}.${(parsed.extension || "jpg").replace(/^\./, "")}`
        : defaultFilenameSettings.fileTemplate,
      folderTemplate: defaultFilenameSettings.folderTemplate,
    };
  } catch {
    return defaultFilenameSettings;
  }
})();
function extractWeiboUid(input: string): string {
  const value = input.trim();
  if (/^\d+$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    const pathUid = parsed.pathname.split("/").filter(Boolean).find(part => /^\d+$/.test(part));
    const queryUid = parsed.searchParams.get("uid") || parsed.searchParams.get("id");
    return pathUid || (queryUid && /^\d+$/.test(queryUid) ? queryUid : "");
  } catch { return ""; }
}
function formatDateInput(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replace(/-/g, "/") : value;
}
function normalizeDateInput(value: string): string {
  const match = value.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return value;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return value;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
function isValidDateFilter(value: string): boolean {
  if (!value) return true;
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [dark, setDark] = useState(false);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [keyword, setKeyword] = useState("");
  const [appliedDateFrom, setAppliedDateFrom] = useState("");
  const [appliedDateTo, setAppliedDateTo] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [posts, setPosts] = useState<WeiboPost[]>([]);
  const acceptDeletePostEvents = useRef(true);
  // 递增代次使取消或 Cookie 删除前启动的异步搜索结果失效。
  const deleteSearchGeneration = useRef(0);
  const activeDeleteSearchGeneration = useRef<number | null>(null);
  // 即使 UI 已显示取消，也等旧 Tauri 命令退出后才允许启动下一次搜索。
  const deleteSearchInFlight = useRef(false);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsError, setPostsError] = useState("");
  const [cookieValidity, setCookieValidity] = useState<"unknown" | "checking" | "valid" | "invalid">("unknown");
  const [postsPaused, setPostsPaused] = useState(false);
  const [postsCancelling, setPostsCancelling] = useState(false);
  const [postType, setPostType] = useState("全部类型");
  const [appliedPostType, setAppliedPostType] = useState("全部类型");
  const [postChecks, setPostChecks] = useState<Record<string, boolean>>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<number[]>([]);
  const [showDeleteTasksConfirm, setShowDeleteTasksConfirm] = useState(false);
  const [toast, setToast] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [executingDeleteTask, setExecutingDeleteTask] = useState<number | null>(null);
  const [deleteActionTask, setDeleteActionTask] = useState<Task | null>(null);
  const [pendingDeleteStartIds, setPendingDeleteStartIds] = useState<number[]>([]);
  const [moreTask, setMoreTask] = useState<Task | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [userLabels, setUserLabels] = useState<Record<string, string>>({});
  const [taskUserLabels, setTaskUserLabels] = useState<Record<string, string>>({});
  const [newUser, setNewUser] = useState("");
  // 文件名与文件夹名模板分别保存；当前阶段只演示模板配置，不执行真实下载。
  const [filenameSettings, setFilenameSettings] = useState<FilenameSettings>(initialFilenameSettings);
  // 左侧设置子菜单与变量插入目标由状态统一驱动。
  const [settingSection, setSettingSection] = useState<"general" | "filename" | "security">("general");
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [templateTarget, setTemplateTarget] = useState<"file" | "folder">("file");
  const [downloadPath, setDownloadPath] = useState("~/Downloads/WeiboDownloads");
  const [downloadDateFrom, setDownloadDateFrom] = useState("");
  const [downloadDateTo, setDownloadDateTo] = useState("");
  const [downloadMediaType, setDownloadMediaType] = useState("all");
  const [modifyDownloadFileTime, setModifyDownloadFileTime] = useState(true);
  const [appliedDownloadDateFrom, setAppliedDownloadDateFrom] = useState("");
  const [appliedDownloadDateTo, setAppliedDownloadDateTo] = useState("");
  const [appliedDownloadMediaType, setAppliedDownloadMediaType] = useState("all");
  const [downloadBusy, setDownloadBusy] = useState(false);
  const activeDownloadIds = useRef<Set<number>>(new Set());
  const activeDeleteTaskId = useRef<number | null>(null);
  const queuedDeleteTaskIds = useRef<number[]>([]);
  const scheduleWaitingDeleteRef = useRef<() => void>(() => {});
  const activeSlotWaiters = useRef<Array<() => void>>([]);
  const suspendedDownloadIds = useRef<Set<number>>(new Set());
  const downloadWorkerIds = useRef<Set<number>>(new Set());
  const pausedDeleteIds = useRef<Set<number>>(new Set());
  const pausedDownloadIds = useRef<Set<number>>(new Set());
  const tasksRef = useRef<Task[]>([]);
  tasksRef.current = tasks;
  const scheduleWaitingDownloadRef = useRef<() => void>(() => {});
  const [downloadStatus, setDownloadStatus] = useState("");
  const [downloadError, setDownloadError] = useState("");
  const [requestIntervalMode, setRequestIntervalMode] = useState<"fixed" | "random">("fixed");
  const [requestDelay, setRequestDelay] = useState("1200");
  const [requestMinDelay, setRequestMinDelay] = useState("1000");
  const [requestMaxDelay, setRequestMaxDelay] = useState("2000");
  const [theme, setTheme] = useState("system");
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const filteredPosts = useMemo(() => posts.filter(post =>
    post.text.toLowerCase().includes(appliedKeyword.trim().toLowerCase()) &&
    (!appliedDateFrom || post.date >= appliedDateFrom) && (!appliedDateTo || post.date <= appliedDateTo) &&
    (appliedPostType === "全部类型" || post.kind === appliedPostType)), [posts, appliedKeyword, appliedDateFrom, appliedDateTo, appliedPostType]);
  // 预览值模拟真实下载时可从用户资料、微博元数据和媒体响应中读取的字段。
  const previewValues = { USER_SCREEN_NAME: "travel_diary", POST_TIME: "2024-08-18 14:30:00", POST_ID: "5078219042", MEDIA_INDEX: "01", EXT: ".jpg" };
  const previewFilename = buildFilename(filenameSettings.fileTemplate, previewValues);
  const previewFoldername = buildFolderName(filenameSettings.folderTemplate, previewValues);
  const selectedCount = posts.filter(post => postChecks[post.id]).length;
  const selectableTaskIds = tasks.map(task => task.id);
  const selectedTaskCount = selectedTaskIds.filter(id => selectableTaskIds.includes(id)).length;
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };
  const resetAfterCookieDeleted = () => {
    setCookieValidity("invalid");
    setDownloadError("尚未登录微博，请先扫码登录或导入 Cookie。");
    // Cookie 删除后清除依赖当前登录会话的下载页面数据，保留下载目录与命名等用户设置。
    setUsers([]);
    setUserLabels({});
    setNewUser("");
    setDownloadDateFrom("");
    setDownloadDateTo("");
    setDownloadMediaType("all");
    setAppliedDownloadDateFrom("");
    setAppliedDownloadDateTo("");
    setAppliedDownloadMediaType("all");
    setDownloadStatus("");
    deleteSearchGeneration.current += 1;
    activeDeleteSearchGeneration.current = null;
    acceptDeletePostEvents.current = false;
    setPostsLoading(false);
    setPosts([]);
    setPostChecks({});
    setPostsError("尚未登录微博，请先扫码登录或导入 Cookie。");
    setPostsPaused(false);
    setPostsCancelling(false);
    setDateFrom("");
    setDateTo("");
    setKeyword("");
    setAppliedDateFrom("");
    setAppliedDateTo("");
    setAppliedKeyword("");
    setPostType("全部类型");
    setAppliedPostType("全部类型");
    setShowDeleteConfirm(false);
    setSelectedTaskIds([]);
    setShowDeleteTasksConfirm(false);
    setDeleteActionTask(null);
    setMoreTask(null);
    setTasks([]);
  };
  const refreshCookieValidity = async (): Promise<boolean> => {
    setCookieValidity("checking");
    try {
      const savedCookie = await invoke<string | null>("get_weibo_cookie");
      if (!savedCookie?.trim()) {
        setCookieValidity("invalid");
        setPostsError("尚未登录微博，请先扫码登录或导入 Cookie。");
        setDownloadError("尚未登录微博，请先扫码登录或导入 Cookie。");
        return false;
      }
      const status = await invoke<string>("check_weibo_cookie");
      if (status === "valid") {
        setCookieValidity("valid");
        setPostsError(current => current.includes("尚未登录微博") || current.includes("Cookie 已失效") || current.includes("Cookie 检测失败") ? "" : current);
        setDownloadError("");
        return true;
      }
      setCookieValidity("invalid");
      setPostsError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。");
      setDownloadError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。");
      return false;
    } catch (reason) {
      setCookieValidity("invalid");
      const message = String(reason).includes("尚未登录微博") ? "尚未登录微博，请先扫码登录或导入 Cookie。" : `Cookie 检测失败：${String(reason)}`;
      setPostsError(message);
      setDownloadError(message);
      return false;
    }
  };
  const refreshDownloadCookieValidity = async (): Promise<boolean> => {
    setCookieValidity("checking");
    try {
      const savedCookie = await invoke<string | null>("get_weibo_cookie");
      if (!savedCookie?.trim()) { setCookieValidity("invalid"); setDownloadError("尚未登录微博，请先扫码登录或导入 Cookie。"); return false; }
      const status = await invoke<string>("check_weibo_cookie");
      if (status === "valid") { setCookieValidity("valid"); setDownloadError(""); return true; }
      setCookieValidity("invalid"); setDownloadError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。"); return false;
    } catch (reason) {
      setCookieValidity("invalid"); setDownloadError(String(reason).includes("尚未登录微博") ? "尚未登录微博，请先扫码登录或导入 Cookie。" : `Cookie 检测失败：${String(reason)}`); return false;
    }
  };
  useEffect(() => { void refreshCookieValidity(); }, []);

  const refreshDeleteTasks = async (showSuccess = false) => {
    try {
      const [savedDeletes, savedDownloads] = await Promise.all([
        invoke<PersistedDeleteTask[]>("get_delete_tasks"),
        invoke<PersistedDownloadTask[]>("get_download_tasks"),
      ]);
      const deleteTasks: Task[] = savedDeletes.map(task => ({ id: task.id, title: task.title, kind: "删除", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, keyword: task.keyword, postType: task.postType, results: task.results }));
      const downloadTasks: Task[] = savedDownloads.map(task => ({ ...task, kind: "下载", downloadConfig: task.downloadConfig, downloadResults: task.downloadResults ?? [] }));
      const all = [...downloadTasks, ...deleteTasks].sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      setTasks(all);
      setSelectedTaskIds(current => current.filter(id => all.some(task => task.id === id)));
      if (showSuccess) notify("刷新成功");
    } catch (reason) { notify(`读取任务失败：${String(reason)}`); }
  };
  const loadDeletePosts = async (fromDate = appliedDateFrom) => {
    if (deleteSearchInFlight.current) return;
    if (cookieValidity !== "valid") {
      await refreshCookieValidity();
      return;
    }
    deleteSearchInFlight.current = true;
    const searchId = ++deleteSearchGeneration.current;
    activeDeleteSearchGeneration.current = searchId;
    const isCurrentSearch = () =>
      deleteSearchGeneration.current === searchId &&
      activeDeleteSearchGeneration.current === searchId &&
      acceptDeletePostEvents.current;
    acceptDeletePostEvents.current = true;
    setPostsLoading(true); setPostsError(""); setPostsPaused(false); setPostsCancelling(false);
    log("info", "delete", `开始搜索微博，起始日期：${fromDate || "不限"}`);
    setPosts([]); setPostChecks({});
    try {
      const savedCookie = await invoke<string | null>("get_weibo_cookie");
      if (!isCurrentSearch()) return;
      if (!savedCookie || !savedCookie.trim()) {
        setCookieValidity("invalid");
        throw "尚未登录微博，请先扫码登录或导入 Cookie。";
      }
      const cookieStatus = await invoke<string>("check_weibo_cookie");
      if (!isCurrentSearch()) return;
      if (cookieStatus !== "valid") {
        setCookieValidity("invalid");
        throw "Cookie 已失效，请先重新登录微博或导入有效 Cookie。";
      }
      setCookieValidity("valid");
      await invoke("set_delete_search_cancelled", { cancelled: false });
      if (!isCurrentSearch()) return;
      await invoke("set_delete_search_paused", { paused: false });
      if (!isCurrentSearch()) return;
      const result = await invoke<WeiboPost[]>("get_delete_posts", { dateFrom: fromDate });
      if (!isCurrentSearch()) return;
      // 事件流负责逐条展示；命令返回值用于补齐未通过事件送达的微博。
      // 更新状态时再次核对代次，防止排队中的旧状态更新覆盖取消或删除后的状态。
      setPosts(current => {
        if (!isCurrentSearch()) return current;
        const merged = new Map(current.map(post => [post.id, post]));
        result.forEach(post => merged.set(post.id, post));
        return [...merged.values()];
      });
      log("info", "delete", `微博搜索完成，后端返回 ${result.length} 条结果`);
    } catch (reason) {
      if (!isCurrentSearch()) return;
      log("error", "delete", `微博搜索失败：${String(reason)}`);
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("尚未登录微博") || message.includes("Cookie 已失效")) setCookieValidity("invalid");
      setPostsError(message);
    } finally {
      if (isCurrentSearch()) {
        setPostsLoading(false);
        setPostsPaused(false);
        setPostsCancelling(false);
        try {
          await invoke("set_delete_search_paused", { paused: false });
          if (isCurrentSearch()) {
            await invoke("set_delete_search_cancelled", { cancelled: false });
          }
        } catch { /* 搜索已结束，无需额外处理 */ }
        if (isCurrentSearch()) activeDeleteSearchGeneration.current = null;
      }
      deleteSearchInFlight.current = false;
    }
  };
  const searchDeletePosts = async () => {
    if (postsLoading || cookieValidity !== "valid") return;
    if (!isValidDateFilter(dateFrom) || !isValidDateFilter(dateTo)) { notify("请输入有效日期，格式为 yyyy/mm/dd。"); return; }
    const now = new Date();
    const effectiveEndDate = dateTo || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    setAppliedDateFrom(dateFrom);
    setAppliedDateTo(effectiveEndDate);
    setAppliedKeyword(keyword.trim());
    setAppliedPostType(postType);
    await loadDeletePosts(dateFrom);
  };
  const toggleDeleteSearchPause = async () => {
    const nextPaused = !postsPaused;
    setPostsPaused(nextPaused);
    try { await invoke("set_delete_search_paused", { paused: nextPaused }); }
    catch (reason) { setPostsPaused(!nextPaused); setPostsError(`无法控制读取状态：${String(reason)}`); }
  };
  const cancelDeleteSearch = async () => {
    if (!postsLoading || postsCancelling || activeDeleteSearchGeneration.current === null) return;
    // 先在前端让本次搜索失效，再通知后端；迟到的返回值和事件都会被忽略。
    deleteSearchGeneration.current += 1;
    activeDeleteSearchGeneration.current = null;
    acceptDeletePostEvents.current = false;
    setPostsLoading(false);
    setPostsCancelling(true);
    setPostsPaused(false);
    try {
      await invoke("set_delete_search_cancelled", { cancelled: true });
      setPostsCancelling(false);
    } catch (reason) {
      setPostsCancelling(false);
      setPostsError(`取消读取失败：${String(reason)}`);
    }
  };
  useEffect(() => { scheduleWaitingDownloadRef.current(); }, []);
  useEffect(() => { if (executingDeleteTask === null) scheduleWaitingDownloadRef.current(); }, [executingDeleteTask]);
  const saveRequestInterval = async (config: RequestIntervalConfig) => {
    try {
      const saved = await invoke<RequestIntervalConfig>("save_request_interval", { config });
      setRequestIntervalMode(saved.mode);
      setRequestDelay(String(saved.fixedMs));
      setRequestMinDelay(String(saved.minMs));
      setRequestMaxDelay(String(saved.maxMs));
    } catch (reason) { notify(`保存请求间隔失败：${String(reason)}`); }
  };
  useEffect(() => { void refreshDeleteTasks(); }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<{ taskId: number; user: string; completed: number; total: number; mediaId: string; phase: string; detail: string }>("download-progress", event => {
      const progress = event.payload;
      setTasks(current => current.map(task => task.kind === "下载" && task.id === progress.taskId && task.state === "执行中"
        ? { ...task, progress: progress.total > 0 ? Math.min(99, Math.round(progress.completed / progress.total * 100)) : task.progress, detail: progress.phase === "downloading" ? progress.detail : `${progress.user}：${progress.detail}` }
        : task));
      setDownloadStatus(`${progress.user}：${progress.detail}`);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "download", `注册下载进度监听失败：${String(reason)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<PersistedDeleteTask>("delete-task-updated", event => {
      const task = event.payload;
      setTasks(current => [{ id: task.id, title: task.title, kind: "删除", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, keyword: task.keyword, postType: task.postType, results: task.results }, ...current.filter(item => item.id !== task.id)]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "delete", `注册删除任务进度监听失败：${String(reason)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    void initializeLogger().then(setLoggingEnabled);
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen("cookie-deleted", () => {
      resetAfterCookieDeleted();
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "auth", `注册 Cookie 删除同步监听失败：${String(reason)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  const toggleLogging = async (enabled: boolean) => {
    try {
      const saved = await updateLoggerEnabled(enabled);
      setLoggingEnabled(saved);
      notify(saved ? "日志记录已开启。" : "日志记录已关闭。");
    } catch (reason) {
      notify(`更新日志设置失败：${String(reason)}`);
    }
  };
  const openLogFolder = async () => {
    try { await invoke("open_log_folder"); }
    catch (reason) { notify(`打开日志文件夹失败：${String(reason)}`); }
  };
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    log("info", "delete", "正在注册微博逐条展示事件监听器（delete-post-item）");
    void listen<unknown>("delete-post-item", event => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") {
        log("error", "delete", `收到微博逐条展示事件，但 payload 不是对象：${String(payload)}`);
        return;
      }
      const eventSearchId = activeDeleteSearchGeneration.current;
      if (!acceptDeletePostEvents.current || eventSearchId === null) return;
      const candidate = payload as Partial<WeiboPost>;
      if (typeof candidate.id !== "string" || !candidate.id) {
        log("error", "delete", `收到微博逐条展示事件，但 payload 缺少有效 id；字段：${Object.keys(payload).join(", ")}`);
        return;
      }
      const post = candidate as WeiboPost;
      log("info", "delete", `前端已收到逐条展示事件，微博 ID=${post.id}，正文长度=${typeof post.text === "string" ? post.text.length : "无效"}`);
      setPosts(current => {
        if (!acceptDeletePostEvents.current || activeDeleteSearchGeneration.current !== eventSearchId) return current;
        if (current.some(item => item.id === post.id)) {
          log("debug", "delete", `收到重复微博事件，跳过追加，微博 ID=${post.id}，当前数量=${current.length}`);
          return current;
        }
        const next = [...current, post];
        log("debug", "delete", `已将事件微博追加到前端状态，微博 ID=${post.id}，数量：${current.length} -> ${next.length}`);
        return next;
      });
    }).then(stop => {
      if (disposed) {
        stop();
        log("info", "delete", "监听器注册完成时组件已卸载，立即清理监听器");
        return;
      }
      unlisten = stop;
      log("info", "delete", "微博逐条展示事件监听器注册成功（delete-post-item）");
    }).catch(reason => {
      log("error", "delete", `微博逐条展示事件监听器注册失败：${String(reason)}`);
    });
    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
        log("info", "delete", "微博逐条展示事件监听器已清理");
      } else {
        log("info", "delete", "组件卸载时监听器注册尚未完成；注册完成后将立即清理");
      }
    };
  }, []);
  useEffect(() => {
    void invoke<RequestIntervalConfig>("get_request_interval").then(config => {
      setRequestIntervalMode(config.mode);
      setRequestDelay(String(config.fixedMs));
      setRequestMinDelay(String(config.minMs));
      setRequestMaxDelay(String(config.maxMs));
    }).catch(reason => notify(`读取请求间隔设置失败：${String(reason)}`));
  }, []);
  const runDeleteTask = async (task: Task) => {
    try {
      const result = await invoke<PersistedDeleteTask>("execute_delete_task", { taskId: task.id });
      setTasks(current => current.map(item => item.id === result.id ? {
        ...item, state: result.state, progress: result.progress, detail: result.detail, results: result.results,
      } : item));
      notify(result.state === "已完成" ? "删除任务执行完成。" : "删除任务结束：" + result.state);
    } catch (reason) {
      const detail = String(reason);
      setTasks(current => current.map(item => item.id === task.id ? { ...item, state: "失败", detail } : item));
      notify("执行删除任务失败：" + detail);
    } finally {
      activeDeleteTaskId.current = null;
      setExecutingDeleteTask(null);
      const nextId = pendingDeleteStartIds[0];
      if (nextId !== undefined) {
        setPendingDeleteStartIds(current => current.slice(1));
        const nextTask = tasksRef.current.find(item => item.id === nextId && item.kind === "删除");
        if (nextTask) setDeleteActionTask(nextTask);
      }
      scheduleWaitingDeleteRef.current();
    }
  };
  const confirmDeleteTask = async () => {
    const task = deleteActionTask;
    if (!task) return;
    setDeleteActionTask(null);
    if (activeDeleteTaskId.current !== task.id && !queuedDeleteTaskIds.current.includes(task.id)) {
      queuedDeleteTaskIds.current.push(task.id);
    }
    setTasks(current => current.map(item => item.id === task.id
      ? { ...item, state: "排队中", detail: "等待全局任务名额" }
      : item));
    scheduleWaitingDeleteRef.current();
  };
  const removeSelectedTasks = async () => {
    const ids = selectedTaskIds.filter(id => selectableTaskIds.includes(id));
    if (!ids.length) { setShowDeleteTasksConfirm(false); return; }
    const deleteIds = ids.filter(id => tasks.some(task => task.id === id && task.kind === "删除"));
    try {
      const removedDeleteIds = deleteIds.length ? await invoke<number[]>("remove_delete_tasks", { taskIds: deleteIds }) : [];
      const downloadIds = ids.filter(id => tasks.some(task => task.id === id && task.kind === "下载"));
      const removedDownloadIds = downloadIds.length ? await invoke<number[]>("remove_download_tasks", { taskIds: downloadIds }) : [];
      const removedIds = [...removedDownloadIds, ...removedDeleteIds];
      setTasks(current => current.filter(task => !removedIds.includes(task.id)));
      setSelectedTaskIds([]);
      setShowDeleteTasksConfirm(false);
      notify(`已删除 ${removedIds.length} 条任务记录。`);
    } catch (reason) {
      notify(`删除任务失败：${String(reason)}`);
    }
  };
  const createDeleteTask = async () => {
    const postIds = posts.filter(post => postChecks[post.id]).map(post => post.id);
    if (cookieValidity !== "valid") { notify("请先登录微博并确认 Cookie 可用。"); return; }
    if (!postIds.length) { notify("请至少选择一条微博。"); return; }
    try {
      const task = await invoke<PersistedDeleteTask>("create_delete_task", {
        postIds, dateFrom: appliedDateFrom, dateTo: appliedDateTo, keyword: appliedKeyword.trim(), postType: appliedPostType,
      });
      setTasks(current => [{ id: task.id, title: task.title, kind: "删除", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, keyword: task.keyword, postType: task.postType, results: task.results }, ...current.filter(item => item.id !== task.id)]);
      setShowDeleteConfirm(false);
      setPage("tasks");
      notify("删除任务已保存。请在任务中心再次确认后执行。");
    } catch (reason) {
      const message = String(reason);
      if (message.includes("所选微博都已存在于其他未完成的删除任务中")) {
        setShowDeleteConfirm(false);
        notify("所选微博都已存在于任务中，无需重复创建。");
        return;
      }
      notify(`创建任务失败：${message}`);
    }
  };
  const addDownloadUser = async () => {
    const input = newUser.trim();
    if (!input) return;
    const normalizeUser = (value: string) => extractWeiboUid(value) || value.trim().toLowerCase().replace(/\/$/, "");
    if (users.some(user => normalizeUser(user) === normalizeUser(input))) {
      notify("该用户已在目标用户队列中，无需重复添加。");
      setNewUser("");
      return;
    }
    setUsers(current => [...current, input]);
    setNewUser("");
    if (cookieValidity === "valid") {
      try {
        const resolved = await invoke<{ uid: string; screenName: string | null }>("resolve_download_user", { userInput: input });
        if (resolved.screenName) setUserLabels(current => ({ ...current, [input]: resolved.screenName! }));
      } catch (reason) { log("info", "download", `用户昵称暂不可用，保留 UID 回退显示：${String(reason)}`); }
    }
  };
  const createDownloadTask = async () => {
    const valid = await refreshDownloadCookieValidity();
    if (!valid) { notify("请先登录微博并确认 Cookie 可用。"); return; }
    const validUsers = users.map(user => user.trim()).filter(Boolean);
    if (!validUsers.length) return;
    if (!isValidDateFilter(downloadDateFrom) || !isValidDateFilter(downloadDateTo)) { notify("请输入有效日期，格式为 yyyy/mm/dd。"); return; }
    if (downloadDateFrom && downloadDateTo && downloadDateFrom > downloadDateTo) {
      notify("开始日期不能晚于结束日期。");
      return;
    }
    setAppliedDownloadDateFrom(downloadDateFrom);
    setAppliedDownloadDateTo(downloadDateTo);
    setAppliedDownloadMediaType(downloadMediaType);
    const config: DownloadTaskConfig = {
      users: validUsers,
      userDetails: [],
      downloadDir: downloadPath,
      dateFrom: downloadDateFrom,
      dateTo: downloadDateTo,
      mediaType: downloadMediaType,
      modifyFileTime: modifyDownloadFileTime,
      fileTemplate: filenameSettings.fileTemplate,
      folderTemplate: filenameSettings.folderTemplate,
    };
    try {
      const resolvedUsers = await Promise.all(config.users.map(async (user, index) => {
        try {
          const resolved = await invoke<{ uid: string; screenName: string | null }>("resolve_download_user", { userInput: user });
          return { user, uid: resolved.uid, screenName: resolved.screenName?.trim() || null, label: resolved.screenName?.trim() || (resolved.uid ? `UID ${resolved.uid}` : `用户${index + 1}`) };
        } catch {
          const uid = extractWeiboUid(user);
          return { user, uid: uid || "", screenName: null, label: uid ? `UID ${uid}` : `用户${index + 1}` };
        }
      }));
      config.userDetails = resolvedUsers.map(item => ({ input: item.user, uid: item.uid, screenName: item.screenName }));
      const names = resolvedUsers.map(item => item.label);
      const title = names.length === 1 ? names[0] : `${names.slice(0, 2).join("、")}...等${names.length}个用户`;
      const saved = await invoke<PersistedDownloadTask>("create_download_task", {
        users: config.users, title, downloadDir: config.downloadDir, dateFrom: config.dateFrom, dateTo: config.dateTo,
        mediaType: config.mediaType, modifyFileTime: config.modifyFileTime, fileTemplate: config.fileTemplate, folderTemplate: config.folderTemplate, userDetails: config.userDetails,
      });
      const task: Task = { ...saved, kind: "下载", downloadConfig: saved.downloadConfig };
      setTasks(current => [task, ...current.filter(item => item.id !== task.id)]);
      setUsers([]);
      setUserLabels({});
      setNewUser("");
      setDownloadStatus("下载任务已创建，请前往任务中心启动。");
      setPage("tasks");
      notify("下载任务已保存，请在任务中心启动。");
    } catch (reason) { notify(`创建下载任务失败：${String(reason)}`); }
  };
  const executeDownloadTask = async (task: Task) => {
    if (task.kind !== "下载" || !task.downloadConfig || activeDownloadIds.current.has(task.id)) return;
    const limit = 1;
    if (activeDeleteTaskId.current !== null || queuedDeleteTaskIds.current.length > 0 || activeDownloadIds.current.size >= limit) {
      const waitingTask = { ...task, state: "排队中" as TaskState, detail: "等待下载并发名额" };
      setTasks(current => current.map(item => item.id === task.id ? waitingTask : item));
      try { await invoke("save_download_task", { task: waitingTask }); } catch (reason) { log("error", "download", `保存等待任务状态失败：${String(reason)}`); }
      return;
    }
    activeDownloadIds.current.add(task.id);
    setDownloadBusy(true);
    if (pausedDownloadIds.current.has(task.id)) {
      activeDownloadIds.current.delete(task.id);
      downloadWorkerIds.current.delete(task.id);
      suspendedDownloadIds.current.delete(task.id);
      setDownloadBusy(activeDownloadIds.current.size > 0);
      if (activeDownloadIds.current.size === 0) activeSlotWaiters.current.splice(0).forEach(resolve => resolve());
      scheduleWaitingDownloadRef.current();
      return;
    }
    try {
      await invoke("prepare_download_task", { taskId: task.id });
      if (pausedDownloadIds.current.has(task.id)) {
        activeDownloadIds.current.delete(task.id);
        setDownloadBusy(activeDownloadIds.current.size > 0);
        if (activeDownloadIds.current.size === 0) activeSlotWaiters.current.splice(0).forEach(resolve => resolve());
        scheduleWaitingDownloadRef.current();
        return;
      }
    } catch (reason) {
      activeDownloadIds.current.delete(task.id);
      setDownloadBusy(activeDownloadIds.current.size > 0);
      if (activeDownloadIds.current.size === 0) activeSlotWaiters.current.splice(0).forEach(resolve => resolve());
      scheduleWaitingDownloadRef.current();
      notify(`准备下载任务失败：${String(reason)}`);
      return;
    }
    const startedTask = { ...task, state: "执行中" as TaskState, progress: 1, detail: "正在读取微博数据并下载媒体" };
    setTasks(current => current.map(item => item.id === task.id ? startedTask : item));
    try { await invoke("save_download_task", { task: startedTask }); } catch (reason) { log("error", "download", `保存下载任务状态失败：${String(reason)}`); }
    setDownloadStatus("正在读取微博数据并下载媒体，请保持应用运行。");
    log("info", "download", `任务 ${task.id} 开始执行，目标用户数：${task.downloadConfig.users.length}`);
    try {
      downloadWorkerIds.current.add(task.id);
      const results = await invoke<Array<{ user: string; downloaded: number; skipped: number; failed: number; detail: string }>>("download_media", { ...task.downloadConfig, taskId: task.id });
      const downloaded = results.reduce((sum, item) => sum + item.downloaded, 0);
      const skipped = results.reduce((sum, item) => sum + item.skipped, 0);
      const failed = results.reduce((sum, item) => sum + item.failed, 0);
      const state: TaskState = failed > 0 && downloaded === 0 ? "失败" : "已完成";
      const total = downloaded + skipped + failed;
      const detail = `下载 ${total}，成功 ${downloaded}，跳过 ${skipped}，失败 ${failed}`;
      const finishedTask = { ...startedTask, state, progress: 100, detail, downloadResults: results };
      setTasks(current => current.map(item => item.id === task.id ? finishedTask : item));
      await invoke("save_download_task", { task: finishedTask });
      setDownloadStatus(results.map(item => `${item.user}：${item.detail}`).join("；") || detail);
      notify(`下载结束：${detail}`);
      log(state === "失败" ? "error" : "info", "download", detail);
    } catch (reason) {
      const detail = String(reason);
      if (detail.includes("下载任务已暂停")) {
        const pausedTask = { ...startedTask, state: "已暂停" as TaskState, detail: "已暂停，点击开始后继续下载" };
        setTasks(current => current.map(item => item.id === task.id ? pausedTask : item));
        try { await invoke("save_download_task", { task: pausedTask }); } catch (saveReason) { log("error", "download", `保存暂停任务状态失败：${String(saveReason)}`); }
      } else if (detail.includes("下载任务已取消")) {
        log("info", "download", `任务 ${task.id} 已停止，按任务删除请求停止执行。`);
      } else {
        const failedTask = { ...startedTask, state: "失败" as TaskState, progress: 100, detail };
        setTasks(current => current.map(item => item.id === task.id ? failedTask : item));
        try { await invoke("save_download_task", { task: failedTask }); } catch (saveReason) { log("error", "download", `保存失败任务状态失败：${String(saveReason)}`); }
        setDownloadStatus(`下载失败：${detail}`);
        notify(`下载失败：${detail}`);
        log("error", "download", detail);
      }
    } finally {
      activeDownloadIds.current.delete(task.id);
      downloadWorkerIds.current.delete(task.id);
      suspendedDownloadIds.current.delete(task.id);
      pausedDownloadIds.current.delete(task.id);
      setDownloadBusy(activeDownloadIds.current.size > 0);
      if (activeDownloadIds.current.size === 0) activeSlotWaiters.current.splice(0).forEach(resolve => resolve());
      if (queuedDeleteTaskIds.current.length > 0) scheduleWaitingDeleteRef.current();
      else scheduleWaitingDownloadRef.current();
    }
  };
  scheduleWaitingDeleteRef.current = () => {
    if (activeDeleteTaskId.current !== null || activeDownloadIds.current.size > 0) return;
    const nextId = queuedDeleteTaskIds.current.shift();
    if (nextId !== undefined) {
      const nextTask = tasksRef.current.find(item => item.id === nextId && item.kind === "删除");
      if (!nextTask || pausedDeleteIds.current.has(nextId) || nextTask.state === "已完成") {
        scheduleWaitingDeleteRef.current();
        return;
      }
      activeDeleteTaskId.current = nextId;
      setExecutingDeleteTask(nextId);
      setTasks(current => current.map(item => item.id === nextId
        ? { ...item, state: "执行中", detail: "正在启动删除任务" }
        : item));
      void runDeleteTask(nextTask);
      return;
    }
    scheduleWaitingDownloadRef.current();
  };
  scheduleWaitingDownloadRef.current = () => {
    if (activeDeleteTaskId.current !== null) return;
    if (queuedDeleteTaskIds.current.length > 0) {
      scheduleWaitingDeleteRef.current();
      return;
    }
    const limit = 1;
    while (activeDownloadIds.current.size < limit) {
      const next = tasksRef.current.find(item => item.kind === "下载" && item.state === "排队中" && item.downloadConfig && !activeDownloadIds.current.has(item.id));
      if (!next) break;
      if (pausedDownloadIds.current.has(next.id)) void resumeDownloadTask(next); else void executeDownloadTask(next);
    }
  };
  const startSelectedTasks = () => {
    const selected = tasksRef.current.filter(task => selectedTaskIds.includes(task.id));
    const downloads = selected.filter(task => task.kind === "下载" && task.downloadConfig && task.state !== "执行中" && task.state !== "已完成");
    downloads.forEach(task => { if (task.state === "已暂停" || pausedDownloadIds.current.has(task.id)) void resumeDownloadTask(task); else void executeDownloadTask(task); });
    const deletions = selected.filter(task => task.kind === "删除" && (task.state === "未开始" || task.state === "失败"));
    if (deletions.length) {
      setPendingDeleteStartIds(deletions.slice(1).map(task => task.id));
      setDeleteActionTask(deletions[0]);
      notify("已提交所选任务；每个删除任务都会单独要求确认。");
    } else if (downloads.length) notify("已提交所选下载任务。");
    else notify("所选任务中没有可以开始的任务。");
  };
  const pauseDeleteTask = async (task: Task) => {
    if (activeDeleteTaskId.current !== task.id && task.state === "排队中") {
      queuedDeleteTaskIds.current = queuedDeleteTaskIds.current.filter(id => id !== task.id);
      pausedDeleteIds.current.add(task.id);
      setTasks(current => current.map(item => item.id === task.id
        ? { ...item, state: "已暂停", detail: "已暂停排队任务，点击继续后重新排队" }
        : item));
      return;
    }
    pausedDeleteIds.current.add(task.id);
    setTasks(current => current.map(item => item.id === task.id ? { ...item, state: "暂停中", detail: "正在停止后台删除工作" } : item));
    try {
      const finalState = await invoke<TaskState>("set_delete_task_paused", { taskId: task.id, paused: true });
      if (finalState === "已暂停") setTasks(current => current.map(item => item.id === task.id ? { ...item, state: "已暂停", detail: "已暂停，点击开始后继续执行" } : item));
      else setTasks(current => current.map(item => item.id === task.id ? { ...item, state: finalState } : item));
    } catch (reason) { notify(`暂停删除失败：${String(reason)}`); }
  };
  const resumeDeleteTask = async (task: Task) => {
    pausedDeleteIds.current.delete(task.id);
    if (activeDeleteTaskId.current !== task.id && !queuedDeleteTaskIds.current.includes(task.id)) {
      queuedDeleteTaskIds.current.push(task.id);
    }
    setTasks(current => current.map(item => item.id === task.id
      ? { ...item, state: "排队中", detail: "等待全局任务名额" }
      : item));
    scheduleWaitingDeleteRef.current();
  };
  const pauseDownloadTask = async (task: Task) => {
    const wasWorkerStarted = downloadWorkerIds.current.has(task.id);
    pausedDownloadIds.current.add(task.id);
    const pausingTask = { ...task, state: "暂停中" as TaskState, detail: "正在停止后台下载工作" };
    setTasks(current => current.map(item => item.id === task.id ? pausingTask : item));
    try {
      const suspended = await invoke<boolean>("set_download_paused", { taskId: task.id, paused: true });
      if (suspended) suspendedDownloadIds.current.add(task.id);
      else if (wasWorkerStarted) pausedDownloadIds.current.delete(task.id);
      activeDownloadIds.current.delete(task.id);
      setDownloadBusy(activeDownloadIds.current.size > 0);
      if (activeDownloadIds.current.size === 0) activeSlotWaiters.current.splice(0).forEach(resolve => resolve());
      const latest = tasksRef.current.find(item => item.id === task.id);
      if (suspended || (!wasWorkerStarted && latest?.state !== "已完成" && latest?.state !== "失败")) {
        const pausedTask = { ...task, state: "已暂停" as TaskState, detail: "已暂停，点击开始后继续下载" };
        setTasks(current => current.map(item => item.id === task.id ? pausedTask : item));
        await invoke("save_download_task", { task: pausedTask });
      }
      scheduleWaitingDownloadRef.current();
    } catch (reason) { notify(`暂停下载失败：${String(reason)}`); }
  };
  const resumeDownloadTask = async (task: Task) => {
    if (activeDeleteTaskId.current !== null || queuedDeleteTaskIds.current.length > 0 || (!activeDownloadIds.current.has(task.id) && activeDownloadIds.current.size >= 1)) {
      const waitingTask = { ...task, state: "排队中" as TaskState, detail: "等待全局任务名额" };
      setTasks(current => current.map(item => item.id === task.id ? waitingTask : item));
      try { await invoke("save_download_task", { task: waitingTask }); } catch { /* 保持排队状态 */ }
      if (queuedDeleteTaskIds.current.length > 0 && activeDownloadIds.current.size === 0) scheduleWaitingDeleteRef.current();
      return;
    }
    pausedDownloadIds.current.delete(task.id);
    if (suspendedDownloadIds.current.has(task.id)) {
      activeDownloadIds.current.add(task.id);
      setDownloadBusy(true);
      const resumedTask = { ...task, state: "执行中" as TaskState, detail: "正在继续下载" };
      setTasks(current => current.map(item => item.id === task.id ? resumedTask : item));
      try {
        const resumed = await invoke<boolean>("set_download_paused", { taskId: task.id, paused: false });
        if (!resumed) {
          suspendedDownloadIds.current.delete(task.id);
          activeDownloadIds.current.delete(task.id);
          setDownloadBusy(activeDownloadIds.current.size > 0);
          void executeDownloadTask({ ...task, state: "未开始" });
          return;
        }
        suspendedDownloadIds.current.delete(task.id);
        await invoke("save_download_task", { task: resumedTask });
      } catch (reason) { notify(`恢复下载失败：${String(reason)}`); }
      return;
    }
    void executeDownloadTask({ ...task, state: "未开始" });
  };
  const saveFilenameSettings = (next: FilenameSettings) => {
    setFilenameSettings(next);
    localStorage.setItem("wm-filename-settings", JSON.stringify(next));
  };
  const renderPage = () => {
    if (page === "dashboard") return <Dashboard tasks={tasks} go={setPage} />;
    if (page === "accounts") return <Accounts notify={notify} onCookieDeleted={resetAfterCookieDeleted} onCookieStatusChange={refreshCookieValidity} />;
    if (page === "delete") return <section className="page-stack delete-page">
      <PageHeading title="微博删除" />
      {postsError && (postsError.includes("尚未登录微博") || postsError.includes("Cookie 已失效") || postsError.includes("Cookie 检测失败")) && <div className="cookie-warning-banner" role="alert"><span>{postsError}</span><button className="button secondary" onClick={() => void refreshCookieValidity()} disabled={cookieValidity === "checking"}>{cookieValidity === "checking" ? "正在检测…" : "重试"}</button></div>}
      {postsError && !postsError.includes("尚未登录微博") && !postsError.includes("Cookie 已失效") && !postsError.includes("Cookie 检测失败") && <div className="auth-error delete-generic-error" role="alert">{postsError}</div>}
      <div className="panel filter-panel">
        <div className="panel-title"><div><strong>筛选条件</strong><span>日期可留空以搜索全部时间，设置条件后点击搜索应用筛选条件。</span></div><button className="button ghost" onClick={() => { setKeyword(""); setDateFrom(""); setDateTo(""); setPostType("全部类型"); setAppliedKeyword(""); setAppliedDateFrom(""); setAppliedDateTo(""); setAppliedPostType("全部类型"); }}>重置条件</button></div>
        <div className="filter-grid"><Field label="开始日期"><input type="text" inputMode="numeric" placeholder="yyyy/mm/dd" aria-label="开始日期 yyyy/mm/dd" value={formatDateInput(dateFrom)} onChange={e => setDateFrom(normalizeDateInput(e.target.value))} /></Field><Field label="结束日期"><input type="text" inputMode="numeric" placeholder="yyyy/mm/dd" aria-label="结束日期 yyyy/mm/dd" value={formatDateInput(dateTo)} onChange={e => setDateTo(normalizeDateInput(e.target.value))} /></Field><Field label="关键词"><div className="input-icon"><Search size={16}/><input placeholder="搜索微博正文" value={keyword} onChange={e => setKeyword(e.target.value)} /></div></Field><Field label="微博类型"><select value={postType} onChange={e => setPostType(e.target.value)}><option>全部类型</option><option>原创</option><option>转发</option></select></Field></div>
        <div className="filter-foot"><span>开始日期:{dateFrom || "不限"} 结束日期:{dateTo || "不限"} 关键字:{keyword.trim() || "不限"} 微博类型:{postType}</span><div className="account-actions"><button className="button primary" onClick={() => void searchDeletePosts()} disabled={postsLoading || cookieValidity !== "valid"}><Search size={15}/> {postsLoading ? "正在读取…" : "搜索微博"}</button></div></div>
      </div>
      <div className="panel delete-posts-panel">
        <div className="panel-title"><div><strong>待处理微博</strong><span>已获取 {posts.length} 条 满足条件 {filteredPosts.length} 条 已选择 {selectedCount} 条</span></div><div className="account-actions">{postsLoading && !postsCancelling && <><button className="button secondary continue-reading-button" onClick={() => void toggleDeleteSearchPause()}><span>{postsPaused ? "继续读取" : "暂停读取"}</span></button><button className="button danger" onClick={() => void cancelDeleteSearch()}><X size={15}/> 取消读取</button></> }<button className="button secondary" onClick={() => void loadDeletePosts(appliedDateFrom)} disabled={postsLoading || cookieValidity !== "valid"}><RefreshCw size={15}/> 刷新微博</button><button className="button danger" onClick={() => setShowDeleteConfirm(true)} disabled={!selectedCount || cookieValidity !== "valid"}><Trash2 size={15}/> 创建删除任务</button></div></div>
        <div className="table-wrap delete-posts-scroll"><table><thead><tr><th><input type="checkbox" checked={filteredPosts.length > 0 && filteredPosts.every(post => postChecks[post.id])} onChange={e => setPostChecks(current => { const next = { ...current }; filteredPosts.forEach(post => { if (e.target.checked) next[post.id] = true; else delete next[post.id]; }); return next; })} aria-label="全选当前筛选微博" /></th><th>微博内容</th><th>发布时间</th><th>类型</th><th>媒体</th></tr></thead><tbody>{filteredPosts.map(post => <tr key={post.id}><td><input type="checkbox" checked={Boolean(postChecks[post.id])} onChange={e => setPostChecks(current => ({ ...current, [post.id]: e.target.checked }))} aria-label="选择微博" /></td><td><div className="post-text">{post.text || "（无正文）"}</div><small>ID: {post.id}</small></td><td>{post.date}</td><td><span className="tag neutral">{post.kind}</span></td><td>{post.media}</td></tr>)}</tbody></table>
        {!postsLoading && (!postsError || postsError.includes("尚未登录微博") || postsError.includes("Cookie 已失效") || postsError.includes("Cookie 检测失败")) && filteredPosts.length === 0 && <EmptyState title={posts.length === 0 ? "暂无微博数据" : "没有匹配的微博"} description={posts.length === 0 ? "请确认已登录微博，然后点击刷新微博。" : "尝试调整日期、关键词或微博类型。"}/>}</div>
      </div>
      {showDeleteConfirm && <div className="modal-backdrop"><div className="modal"><div className="modal-icon warning"><Trash2/></div><h3>确认创建删除任务</h3><p>将创建一个包含 {selectedCount} 条微博的删除任务。创建任务本身不会删除微博，你还需要在任务中心再次确认并启动执行。</p><div className="warning-box">微博删除不可恢复，执行时将逐条请求并记录结果。</div><div className="modal-actions"><button className="button ghost" onClick={() => setShowDeleteConfirm(false)}>返回检查</button><button className="button danger" onClick={() => void createDeleteTask()}>创建待确认任务</button></div></div></div>}
    </section>;
    if (page === "download") return <section className="page-stack">
      <PageHeading title="媒体下载" />
      {downloadError && (downloadError.includes("尚未登录微博") || downloadError.includes("Cookie 已失效") || downloadError.includes("Cookie 检测失败")) && <div className="cookie-warning-banner" role="alert"><span>{downloadError}</span><button className="button secondary" onClick={() => void refreshDownloadCookieValidity()} disabled={cookieValidity === "checking"}>{cookieValidity === "checking" ? "正在检测…" : "重试"}</button></div>}
      {downloadError && !downloadError.includes("尚未登录微博") && !downloadError.includes("Cookie 已失效") && !downloadError.includes("Cookie 检测失败") && <div className="auth-error delete-generic-error" role="alert">{downloadError}</div>}
      <div className="stats-grid three"><Stat label="待处理用户" value={String(users.length)} icon={Users}/><Stat label="下载任务" value={String(tasks.filter(t => t.kind === "下载").length)} icon={Image} /><Stat label="下载完成" value={String(tasks.filter(t => t.kind === "下载" && t.state === "已完成").length)} icon={Check} /></div>
      <div className="panel download-user-panel">
        <div className="panel-title"><div><strong>目标用户队列</strong><span>支持添加多个用户并排队，日期留空表示不限时间。</span></div><span className="tag blue">{users.length} 个用户</span></div>
        <div className="add-user-row"><div className="input-icon"><Users size={16}/><input placeholder="微博主页链接或用户标识" value={newUser} onChange={e => setNewUser(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && newUser.trim()) void addDownloadUser(); }} /></div><button className="button secondary" onClick={() => void addDownloadUser()} disabled={!newUser.trim()}><Plus size={15}/> 添加用户</button></div>
        <div className="user-list">{users.map((user, i) => <div className="user-row" key={user + i}><div className="avatar">{user.slice(0, 1).toUpperCase()}</div><div className="user-info"><strong>{userLabels[user] ? `${userLabels[user]} UID: ${extractWeiboUid(user) || "待识别"}` : `用户名 UID: ${extractWeiboUid(user) || "待识别"}`}</strong><span>待采集 · {extractWeiboUid(user) ? "UID 已识别" : "请确认输入的是 UID 或微博主页链接"}</span></div><span className="tag neutral">队列 {i + 1}</span><button className="icon-button" aria-label="移除用户" onClick={() => setUsers(u => u.filter((_, index) => index !== i))}><X size={16}/></button></div>)}</div>
        <div className="download-form-grid"><Field className="field-date" label="开始日期"><input type="text" inputMode="numeric" placeholder="yyyy/mm/dd" aria-label="开始日期 yyyy/mm/dd" value={formatDateInput(downloadDateFrom)} onChange={e => setDownloadDateFrom(normalizeDateInput(e.target.value))}/></Field><Field className="field-date" label="结束日期"><input type="text" inputMode="numeric" placeholder="yyyy/mm/dd" aria-label="结束日期 yyyy/mm/dd" value={formatDateInput(downloadDateTo)} onChange={e => setDownloadDateTo(normalizeDateInput(e.target.value))}/></Field><Field className="field-media" label="媒体类型"><select value={downloadMediaType} onChange={e => setDownloadMediaType(e.target.value)}><option value="all">图片、视频、LivePhoto</option><option value="images">仅图片</option><option value="videos">仅视频</option><option value="livephoto">仅 LivePhoto</option></select></Field><Field className="field-path" label="下载目录"><div className="input-with-button"><input value={downloadPath} onChange={e => setDownloadPath(e.target.value)} title={downloadPath}/><button className="icon-button icon-tooltip" data-tooltip="选择下载目录" onClick={() => void invoke<string | null>("select_download_directory").then(path => { if (path) setDownloadPath(path); }).catch(reason => notify(`选择下载目录失败：${String(reason)}`))} aria-label="选择下载目录"><FolderOpen size={16}/></button></div></Field><div className="field-switch"><span>修改创建日期</span><label className="switch-control" aria-label="修改创建日期"><input type="checkbox" checked={modifyDownloadFileTime} onChange={e => setModifyDownloadFileTime(e.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></label></div></div>
        <div className="filter-foot download-filter-foot"><span>开始日期:{downloadDateFrom || "不限"} 结束日期:{downloadDateTo || "不限"} 媒体类型:{downloadMediaType === "all" ? "全部媒体" : downloadMediaType === "images" ? "仅图片" : downloadMediaType === "videos" ? "仅视频" : "仅 LivePhoto"}</span><div className="account-actions"><button className="button primary" onClick={() => void createDownloadTask()} disabled={!users.length}><Plus size={15}/> 创建下载任务</button></div></div>
      </div>
    </section>;
    if (page === "tasks") return <section className="page-stack"><PageHeading title="任务中心" actions={<button className="button secondary" onClick={() => void refreshDeleteTasks(true)}><RefreshCw size={15}/> 刷新</button>} /><div className="stats-grid four"><Stat label="全部任务" value={String(tasks.length)} icon={ListTodo}/><Stat label="执行中" value={String(tasks.filter(t => t.state === "执行中").length)} icon={Activity}/><Stat label="已完成" value={String(tasks.filter(t => t.state === "已完成").length)} icon={Check}/><Stat label="失败任务" value={String(tasks.filter(t => t.state === "失败").length)} icon={CircleHelp}/></div><div className="panel task-list-panel"><div className="panel-title task-list-heading"><div><strong>所有任务</strong></div><div className="task-bulk-actions"><button className="icon-button task-start-selected" aria-label="开始选中任务" title={selectedTaskCount ? `开始选中的 ${selectedTaskCount} 条任务` : "请先勾选任务"} disabled={!selectedTaskCount} onClick={startSelectedTasks}><Play size={17} fill="currentColor"/></button><button className="icon-button task-delete-selected" aria-label="删除选中任务" title={selectedTaskCount ? `删除选中的 ${selectedTaskCount} 条任务` : "请先勾选任务"} disabled={!selectedTaskCount} onClick={() => setShowDeleteTasksConfirm(true)}><Trash2 size={17}/></button></div></div><div className="table-wrap task-list-scroll"><table><thead><tr><th><input type="checkbox" aria-label="全选任务" checked={selectableTaskIds.length > 0 && selectableTaskIds.every(id => selectedTaskIds.includes(id))} onChange={e => setSelectedTaskIds(e.target.checked ? selectableTaskIds : [])}/></th><th>任务</th><th>类型</th><th>状态</th><th>进度</th><th>详情</th><th>操作</th><th>更多</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}>
        <td><input type="checkbox" aria-label={`选择任务 ${task.id}`} checked={selectedTaskIds.includes(task.id)} onChange={e => setSelectedTaskIds(current => e.target.checked ? [...current.filter(id => id !== task.id), task.id] : current.filter(id => id !== task.id))}/></td>
        <td className="task-title-cell" title={task.title}><strong>{task.title}</strong><small>任务 #{task.id}</small></td>
        <td>{task.kind === "下载" ? <span className="tag blue">下载</span> : <span className="tag amber">删除</span>}</td>
        <td><TaskBadge state={task.state}/></td>
        <td><div className="table-progress"><div className="progress-track"><div style={{width: `${task.progress}%`}}/></div><small>{task.progress}%</small></div></td>
        <td className="task-detail-cell" title={task.kind === "删除" && task.state === "未开始" ? "待确认 " + (task.postIds?.length ?? 0) + " 条微博" : task.detail}>{task.kind === "删除" && task.state === "未开始" ? "待确认 " + (task.postIds?.length ?? 0) + " 条微博" : task.detail}</td>
        <td><div className="account-actions task-operation-actions">
          {task.kind === "删除" && task.state === "执行中" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="暂停删除" aria-label="暂停删除" onClick={() => void pauseDeleteTask(task)}><Pause size={16} fill="currentColor" strokeWidth={2.5}/></button>}
          {task.kind === "删除" && task.state === "暂停中" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="正在暂停" aria-label="正在暂停" disabled><Pause size={16} fill="currentColor"/></button>}
          {task.kind === "删除" && task.state === "排队中" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="暂停任务" aria-label="暂停任务" onClick={() => void pauseDeleteTask(task)}><Pause size={16} fill="currentColor"/></button>}
          {task.kind === "删除" && task.state === "已暂停" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="继续删除" aria-label="继续删除" onClick={() => void resumeDeleteTask(task)}><Play size={16} fill="currentColor"/></button>}
          {task.kind === "删除" && task.state === "已完成" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="已完成" aria-label="已完成" disabled><Check size={16}/></button>}
          {task.kind === "删除" && (task.state === "未开始" || task.state === "失败") && <button className="icon-button task-action-icon icon-tooltip" data-tooltip={task.state === "未开始" ? "执行删除" : "重新开始删除"} aria-label={task.state === "未开始" ? "执行删除" : "重新开始删除"} disabled={cookieValidity === "checking"} onClick={() => setDeleteActionTask(task)}>{task.state === "未开始" ? <Play size={16} fill="currentColor"/> : <RefreshCw size={16}/>}</button>}
          {task.kind === "下载" && task.downloadConfig && <>{task.state === "执行中" || task.state === "排队中" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="暂停任务" aria-label="暂停任务" onClick={() => void pauseDownloadTask(task)}><Pause size={16} fill="currentColor" strokeWidth={2.5}/></button> : task.state === "暂停中" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="正在暂停" aria-label="正在暂停" disabled><Pause size={16} fill="currentColor"/></button> : task.state === "已暂停" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="继续下载" aria-label="继续下载" onClick={() => void resumeDownloadTask(task)}><Play size={16} fill="currentColor"/></button> : task.state === "已完成" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="打开下载目录" aria-label="打开下载目录" onClick={() => void invoke("open_download_directory", { downloadDir: task.downloadConfig!.downloadDir }).catch(reason => notify(`打开下载目录失败：${String(reason)}`))}><FolderOpen size={16}/></button> : <button className="icon-button task-action-icon icon-tooltip" data-tooltip={task.state === "失败" ? "重新开始下载" : "开始下载"} aria-label={task.state === "失败" ? "重新开始下载" : "开始下载"} disabled={cookieValidity === "checking"} onClick={() => void executeDownloadTask(task)}>{task.state === "失败" ? <RefreshCw size={16}/> : <Play size={16} fill="currentColor"/>}</button>}</>}
        </div></td>
        <td><button className="icon-button task-action-icon" aria-label="更多任务信息" title="更多" onClick={() => setMoreTask(task)}><MoreHorizontal size={17}/></button></td>
      </tr>)}</tbody></table>{tasks.length === 0 && <EmptyState title="暂无任务" description="创建删除任务后会显示在这里；执行前会再次要求确认。" />}</div></div>      {moreTask && <div className="modal-backdrop" role="presentation"><div className="modal more-task-modal" role="dialog" aria-modal="true" aria-labelledby="more-task-title"><button className="icon-button more-task-close" aria-label="关闭任务详情" title="关闭" onClick={() => setMoreTask(null)}><X size={17}/></button><div className="modal-icon" style={{background:"#eef2ff",color:"#4f67ce"}}><MoreHorizontal/></div><h3 id="more-task-title">{moreTask.title}</h3>
        <div style={{display:"grid",gap:10,fontSize:12}}>
          {moreTask.postIds && <div><strong>任务总条数：</strong>{moreTask.postIds.length} 条</div>}
          {moreTask.results && moreTask.results.length > 0 && <div><strong>执行结果：</strong>已处理 {moreTask.results.length} 条，成功 {moreTask.results.filter(item => item.state === "已删除").length} 条，失败 {moreTask.results.filter(item => item.state === "失败").length} 条</div>}
          {moreTask.results?.some(item => item.state === "失败" && item.detail.trim()) && <div><strong>失败原因：</strong><div style={{display:"grid",gap:6,marginTop:6}}>{moreTask.results.filter(item => item.state === "失败" && item.detail.trim()).map(item => <div key={item.postId}>{item.postId}：{item.detail}</div>)}</div></div>}
          {(moreTask.dateFrom || moreTask.dateTo || moreTask.keyword?.trim() || (moreTask.postType && moreTask.postType !== "全部类型")) && <div><strong>筛选条件：</strong><div style={{display:"grid",gap:5,marginTop:6}}>{(moreTask.dateFrom || moreTask.dateTo) && <div>日期：{moreTask.dateFrom || "不限"} 至 {moreTask.dateTo || "不限"}</div>}{moreTask.postType && moreTask.postType !== "全部类型" && <div>微博类型：{moreTask.postType}</div>}{moreTask.keyword?.trim() && <div>关键词：{moreTask.keyword}</div>}</div></div>}
          {moreTask.detail.trim() && moreTask.state !== "未开始" && <div><strong>任务信息：</strong>{moreTask.detail}</div>}
          {moreTask.results && moreTask.results.length > 0 && <div><strong>逐条结果：</strong><div style={{display:"grid",gap:6,marginTop:6}}>{moreTask.results.map(item => <div key={item.postId}>{item.postId} {item.state} {item.detail}</div>)}</div></div>}
          {moreTask.downloadConfig && <div><strong>目标用户：</strong><div style={{display:"grid",gap:5,marginTop:6}}>{moreTask.downloadConfig.users.map((user, index) => { const detail = moreTask.downloadConfig!.userDetails?.find(item => item.input === user); const uid = detail?.uid || extractWeiboUid(user); const url = uid ? `https://weibo.com/u/${uid}` : user; const label = detail?.screenName?.trim() || (uid ? `UID ${uid}` : "昵称未识别"); return <div key={user + index}>{label}：{url}</div>; })}</div></div>}
          {moreTask.downloadConfig && <div><strong>筛选条件：</strong><div style={{display:"grid",gap:5,marginTop:6}}><div>开始日期：{moreTask.downloadConfig.dateFrom || "不限"}</div><div>结束日期：{moreTask.downloadConfig.dateTo || "不限"}</div><div>媒体类型：{moreTask.downloadConfig.mediaType === "all" ? "全部媒体" : moreTask.downloadConfig.mediaType === "images" ? "仅图片" : moreTask.downloadConfig.mediaType === "videos" ? "仅视频" : "仅 LivePhoto"}</div></div></div>}
          {moreTask.downloadConfig && <div><strong>下载设置：</strong><div style={{display:"grid",gap:5,marginTop:6}}><div>下载目录：{moreTask.downloadConfig.downloadDir}</div><div>修改创建日期：{moreTask.downloadConfig.modifyFileTime ? "开启" : "关闭"}</div><div>文件夹模板：{moreTask.downloadConfig.folderTemplate}</div><div>文件名模板：{moreTask.downloadConfig.fileTemplate}</div></div></div>}
          {moreTask.downloadResults && moreTask.downloadResults.length > 0 && <div><strong>执行结果：</strong><div style={{marginTop:6}}>完成：下载 {moreTask.downloadResults.reduce((total, item) => total + item.downloaded, 0)}，跳过 {moreTask.downloadResults.reduce((total, item) => total + item.skipped, 0)}，失败 {moreTask.downloadResults.reduce((total, item) => total + item.failed, 0)}</div></div>}
        </div></div></div>}
            {deleteActionTask && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-action-title"><div className="modal-icon warning"><Trash2/></div><h3 id="delete-action-title">{deleteActionTask.state === "失败" ? "确认重试删除任务" : "确认执行删除任务"}</h3><p>{deleteActionTask.state === "失败" ? "任务“" + deleteActionTask.title + "”此前未完整完成。重试时会跳过已确认删除成功的微博，只处理失败或未处理项目。" : "即将向微博发送真实删除请求。任务“" + deleteActionTask.title + "”将逐条执行删除操作。"}</p><div className="warning-box">微博删除不可恢复，请确认任务内容后继续。</div><div className="modal-actions"><button className="button ghost" onClick={() => { setDeleteActionTask(null); setPendingDeleteStartIds([]); }}>取消</button><button className="button danger" onClick={() => void confirmDeleteTask()}>确认执行</button></div></div></div>}
            {showDeleteTasksConfirm && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-tasks-title"><div className="modal-icon warning"><Trash2/></div><h3 id="delete-tasks-title">确认删除任务记录</h3><p>确定删除选中的 {selectedTaskCount} 条任务记录吗？删除任务记录不会撤销已经在微博执行的删除操作。</p><div className="modal-actions"><button className="button ghost" onClick={() => setShowDeleteTasksConfirm(false)}>取消</button><button className="button danger" onClick={() => void removeSelectedTasks()}>确认删除</button></div></div></div>}
    </section>;
    // 设置页面由右侧分区承载；左侧菜单负责切换并定位到对应分区。
    if (page === "settings") return <section className="page-stack settings-page">
      <PageHeading title="设置" />
      <div className="settings-main">
        <section className="panel settings-section" id="settings-general">
          <div className="panel-title"><div><strong>常规设置</strong><span>个性化应用显示与任务行为</span></div></div>
          <Field label="主题"><select value={theme} onChange={e => { setTheme(e.target.value); setDark(e.target.value === "dark"); }}><option value="system">跟随系统（当前预览为浅色）</option><option value="light">浅色</option><option value="dark">深色</option></select></Field>
          <div className="setting-row request-interval-row"><div><strong>请求间隔</strong><span>统一配置网络请求的等待间隔</span></div><div className="request-interval-controls"><select aria-label="请求间隔模式" value={requestIntervalMode} onChange={e => { const mode = e.target.value as "fixed" | "random"; setRequestIntervalMode(mode); void saveRequestInterval({ mode, fixedMs: Number(requestDelay), minMs: Number(requestMinDelay), maxMs: Number(requestMaxDelay) }); }}><option value="fixed">固定间隔</option><option value="random">随机范围</option></select>{requestIntervalMode === "fixed" ? <select aria-label="固定请求间隔" value={requestDelay} onChange={e => { setRequestDelay(e.target.value); void saveRequestInterval({ mode: "fixed", fixedMs: Number(e.target.value), minMs: Number(requestMinDelay), maxMs: Number(requestMaxDelay) }); }}><option value="800">800 毫秒</option><option value="1200">1200 毫秒</option><option value="2000">2000 毫秒</option><option value="3000">3000 毫秒</option><option value="5000">5000 毫秒</option></select> : <div className="request-range"><label>最短 <input type="number" min="500" max="30000" step="100" value={requestMinDelay} onChange={e => setRequestMinDelay(e.target.value)} onBlur={() => { const min = Math.max(500, Number(requestMinDelay) || 500); const max = Math.max(min, Number(requestMaxDelay) || min); void saveRequestInterval({ mode: "random", fixedMs: Number(requestDelay), minMs: min, maxMs: max }); }} /> ms</label><label>最长 <input type="number" min="500" max="60000" step="100" value={requestMaxDelay} onChange={e => setRequestMaxDelay(e.target.value)} onBlur={() => { const min = Math.max(500, Number(requestMinDelay) || 500); const max = Math.max(min, Number(requestMaxDelay) || min); void saveRequestInterval({ mode: "random", fixedMs: Number(requestDelay), minMs: min, maxMs: max }); }} /> ms</label></div>}</div></div>
          <div className="setting-row"><div><strong>运行日志</strong><span>记录前后端关键操作与错误，关闭后停止写入</span></div><label className="log-toggle"><input type="checkbox" checked={loggingEnabled} onChange={e => { void toggleLogging(e.target.checked); }} /><span>{loggingEnabled ? "已开启" : "已关闭"}</span></label></div>
          <div className="setting-row"><div><strong>日志文件夹</strong><span>查看已保存的运行日志文件</span></div><button className="button secondary" onClick={() => { void openLogFolder(); }}><FolderOpen size={15}/> 打开日志文件夹</button></div>
        </section>
        <section className="panel settings-section" id="settings-filename">
          <div className="panel-title"><div><strong>文件与文件夹命名</strong><span>点击变量可插入到当前选中的模板输入框</span></div></div>
          <div className="template-field">
            <Field label="下载文件夹命名模板">
              <input value={filenameSettings.folderTemplate} onFocus={() => setTemplateTarget("folder")} onChange={e => saveFilenameSettings({...filenameSettings, folderTemplate: e.target.value})} placeholder="%USER_SCREEN_NAME%" />
            </Field>
            <p className="template-help">文件夹示例：{previewFoldername}</p>
            <Field label="下载文件名模板">
              <input value={filenameSettings.fileTemplate} onFocus={() => setTemplateTarget("file")} onChange={e => saveFilenameSettings({...filenameSettings, fileTemplate: e.target.value})} placeholder="%USER_SCREEN_NAME% [%POST_TIME%] %POST_ID%_%MEDIA_INDEX%%EXT%" />
            </Field>
            <p className="template-help">文件名示例：{previewFilename}</p>
          </div>
          <div className="variable-picker">
            <div className="variable-picker-heading"><strong>可用变量</strong><span>当前插入目标：{templateTarget === "file" ? "文件名模板" : "文件夹模板"}</span></div>
            <div className="variable-grid">{filenameVariables.map((variable: TemplateVariable) => <button type="button" className="variable-chip" key={variable.token} title={variable.description} onMouseDown={e => e.preventDefault()} onClick={() => {
              // 点击变量时追加对应占位符，避免将用户模板格式写死。
              const key = templateTarget === "file" ? "fileTemplate" : "folderTemplate";
              saveFilenameSettings({...filenameSettings, [key]: filenameSettings[key] + variable.token});
            }}><code>{variable.token}</code><span>{variable.label}</span></button>)}</div>
          </div>
        </section>
        <section className="panel settings-section" id="settings-security">
          <div className="panel-title"><div><strong>安全与数据</strong><span>本地下载目录与数据行为</span></div></div>
          <Field label="下载根目录"><div className="input-with-button"><input value={downloadPath} onChange={e => setDownloadPath(e.target.value)}/><button className="button secondary" onClick={() => void invoke<string | null>("select_download_directory").then(path => { if (path) setDownloadPath(path); }).catch(reason => notify(`选择下载目录失败：${String(reason)}`))}><FolderOpen size={15}/> 选择目录</button></div></Field>
          <p className="muted small">所有下载文件将直接放入由文件夹模板生成的用户文件夹，不再创建 img、live、video 等媒体类型子目录。窗口尺寸会在调整时自动保存；下次启动恢复尺寸，窗口位置每次默认居中。</p>
        </section>
      </div>
    </section>;
    return <section className="page-stack"><PageHeading title="Cookie 管理" subtitle="扫码登录或导入 Cookie" /><Accounts notify={notify} onCookieDeleted={resetAfterCookieDeleted} onCookieStatusChange={refreshCookieValidity} /></section>;
  };
  // 应用外壳固定视口尺寸，滚动仅交由右侧内容区处理。
  return <div className={dark ? "app-shell dark" : "app-shell"}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><img src="/weibo-logo.svg" alt="" /></div><div><strong>Weibo Manager</strong><span>微博管理工作台</span></div></div><nav>{["概览","微博管理","系统"].map(group => <div className="nav-group" key={group}><div className="nav-group-label">{group}</div>{nav.filter(item => item.group === group).map(item => { const Icon = item.icon; return <React.Fragment key={item.id}><button className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => { if (item.id === "settings") { if (page === "settings" && settingsExpanded) { setSettingsExpanded(false); } else { setPage("settings"); setSettingsExpanded(true); setSettingSection("general"); } } else { setPage(item.id); setSettingsExpanded(false); } }}><Icon size={17}/><span>{item.label}</span>{item.id === "tasks" && <span className="nav-count">{tasks.length}</span>}{item.id === "settings" && <ChevronDown size={14} className={settingsExpanded ? "nav-chevron expanded" : "nav-chevron"}/>}</button>{item.id === "settings" && page === "settings" && settingsExpanded && <div className="settings-subnav"><button className={settingSection === "general" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("general"); setSettingsExpanded(true); document.getElementById("settings-general")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><Settings2 size={14}/>常规设置</button><button className={settingSection === "filename" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("filename"); setSettingsExpanded(true); document.getElementById("settings-filename")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><FileImage size={14}/>文件命名</button><button className={settingSection === "security" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("security"); setSettingsExpanded(true); document.getElementById("settings-security")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><ShieldCheck size={14}/>安全与数据</button></div>}</React.Fragment>; })}</div>)}</nav><div className="sidebar-bottom"><div className="version">WEIBO MANAGER <span>v{tauriConfig.version}</span></div></div></aside>
    <main className="main-area"><div className={page === "dashboard" || page === "accounts" ? "content content-centered" : page === "tasks" ? "content task-center-content" : "content"}>{renderPage()}</div></main>
    {toast && <div className="toast"><Check size={17}/>{toast}</div>}
  </div>;
}
function PageHeading({ subtitle, actions }: {title: string; subtitle?: string; actions?: React.ReactNode}) {
  if (!subtitle && !actions) return null;
  return <div className="page-heading"><div>{subtitle ? <p>{subtitle}</p> : null}</div>{actions && <div>{actions}</div>}</div>;
}
function Field({ label, children, className }: {label: string; children: React.ReactNode; className?: string}) { return <label className={className ? `field ${className}` : "field"}><span>{label}</span>{children}</label>; }
function Stat({ label, value, icon: Icon, helper }: {label: string; value: string; icon: typeof Home; helper?: string}) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><div className="stat-icon"><Icon size={17}/></div></div><strong>{value}</strong>{helper ? <span className="stat-helper">{helper}</span> : null}</div>; }
function Dashboard({ tasks, go }: {tasks: Task[]; go: (page: Page) => void}) {
  return <section className="page-stack"><PageHeading title="工作台" /><div className="stats-grid four"><Stat label="下载任务" value={String(tasks.filter(t => t.kind === "下载").length)} icon={CloudDownload} /><Stat label="删除任务" value={String(tasks.filter(t => t.kind === "删除").length)} icon={Trash2} /><Stat label="已下载媒体" value={String(tasks.filter(t => t.kind === "下载").reduce((sum, task) => sum + (task.downloadResults ?? []).reduce((userSum, result) => userSum + result.downloaded, 0), 0))} icon={FileImage} /><Stat label="失败任务" value={String(tasks.filter(t => t.state === "失败").length)} icon={CircleHelp} /></div><div className="dashboard-columns"><div className="panel"><div className="panel-title"><div><strong>最近任务</strong></div><button className="text-button" onClick={() => go("tasks")}>全部任务 <ArrowRight size={14}/></button></div><div className="recent-list">{tasks.slice(0, 3).map(task => <div className="recent-row" key={task.id}><div className={task.kind === "下载" ? "recent-icon blue-bg" : "recent-icon amber-bg"}>{task.kind === "下载" ? <CloudDownload size={17}/> : <Trash2 size={17}/>}</div><div className="recent-info"><strong>{task.title}</strong><span>{task.detail}</span></div><TaskBadge state={task.state}/></div>)}</div></div><div className="panel quick-panel"><div className="panel-title"><div><strong>快捷操作</strong></div></div><button className="quick-action" onClick={() => go("download")}><div className="quick-icon blue-bg"><CloudDownload size={18}/></div><div><strong>下载媒体</strong><span>按用户备份图片和视频</span></div><ArrowRight size={16}/></button><button className="quick-action" onClick={() => go("delete")}><div className="quick-icon amber-bg"><Trash2 size={18}/></div><div><strong>整理微博</strong><span>筛选并预览待删除内容</span></div><ArrowRight size={16}/></button><button className="quick-action" onClick={() => go("accounts")}><div className="quick-icon green-bg"><LockKeyhole size={18}/></div><div><strong>Cookie 管理</strong><span>扫码登录或导入 Cookie</span></div><ArrowRight size={16}/></button></div></div></section>;
}
type WeiboAccount = { uid: string; screenName: string; avatarUrl?: string | null };

function Accounts({ notify, onCookieDeleted, onCookieStatusChange }: {notify: (message: string) => void; onCookieDeleted: () => void; onCookieStatusChange: () => Promise<boolean>}) {
  const [method, setMethod] = useState<"qr" | "cookie">("qr");
  const [cookie, setCookie] = useState("");
  const [savedCookie, setSavedCookie] = useState("");
  const [showCookie, setShowCookie] = useState(false);
  const [showDeleteCookieConfirm, setShowDeleteCookieConfirm] = useState(false);
  const [showQrDialog, setShowQrDialog] = useState(false);
  const [configFileNames, setConfigFileNames] = useState<{ cookieFile: string; windowSizeFile: string } | null>(null);
  const [qrState, setQrState] = useState("获取Cookie");
  const [account, setAccount] = useState<WeiboAccount | null>(null);
  const [cookieLoaded, setCookieLoaded] = useState(false);
  const hasSavedCookie = Boolean(savedCookie.trim());
  const cookieExists = hasSavedCookie || Boolean(account);
  const cookieLocked = !cookieLoaded || cookieExists;
  const [busy, setBusy] = useState(false);
  const [cookieCheckBusy, setCookieCheckBusy] = useState(false);
  const [cookieCheckResult, setCookieCheckResult] = useState("");
  const [error, setError] = useState("");

  // 仅为用户提供显示/复制功能而读取已保存的 Cookie；不写入日志。
  useEffect(() => {
    Promise.all([
      invoke<WeiboAccount | null>("get_weibo_account"),
      invoke<string | null>("get_weibo_cookie"),
      invoke<{ cookieFile: string; windowSizeFile: string }>("get_config_file_names"),
    ]).then(([savedAccount, currentCookie, fileNames]) => {
      setAccount(savedAccount);
      setSavedCookie(currentCookie ?? "");
      setConfigFileNames(fileNames);
    }).catch(() => {
      setAccount(null);
      setSavedCookie("");
    }).finally(() => {
      setCookieLoaded(true);
    });
  }, []);

  // 扫码网页窗口内的验证按钮通过标题标记向主界面发起请求。
  useEffect(() => {
    if (!showQrDialog) return;
    let cancelled = false;
    let timer: number | undefined;
    const pollWindow = async () => {
      try {
        const isOpen = await invoke<boolean>("is_qr_login_window_open");
        if (!isOpen && !cancelled && !busy) {
          setShowQrDialog(false);
          setError("");
          if (!savedCookie) setQrState("获取 Cookie");
          return;
        }
        if (isOpen && !busy) {
          await invoke("ensure_qr_login_controls");
          const action = await invoke<string | null>("take_qr_login_action");
          if (action === "verify") await finishQrLogin();
          if (action === "close") {
            await invoke("close_qr_login_window");
            setShowQrDialog(false);
            setError("");
            if (!savedCookie) setQrState("获取 Cookie");
            return;
          }
        }
      } catch { /* 关闭窗口或页面加载期间，下一轮继续检查。 */ }
      if (!cancelled) timer = window.setTimeout(pollWindow, 500);
    };
    timer = window.setTimeout(pollWindow, 500);
    return () => { cancelled = true; if (timer !== undefined) window.clearTimeout(timer); };
  }, [showQrDialog, busy, savedCookie]);

  const startQrLogin = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("start_qr_login");
      setQrState("等待微博扫码登录完成…");
      setShowQrDialog(true);
    } catch (reason) {
      setError(String(reason));
      setQrState("无法打开微博登录窗口");
    } finally {
      setBusy(false);
    }
  };

  const finishQrLogin = async () => {
    setBusy(true);
    setError("");
    try {
      const verified = await invoke<WeiboAccount>("finish_qr_login");
      setAccount(verified);
      setSavedCookie((await invoke<string | null>("get_weibo_cookie")) ?? "");
      setQrState("保存 Cookie 成功");
      setShowQrDialog(false);
      setCookieCheckResult((await onCookieStatusChange()) ? "Cookie 可用" : "Cookie 已失效");
      notify("保存 Cookie 成功");
    } catch (reason) {
      const message = String(reason);
      setError(message);
      setQrState("尚未验证成功，请确认扫码已完成");
      try { await invoke("show_qr_login_error", { message }); } catch { /* 网页窗口关闭时忽略 */ }
    } finally {
      setBusy(false);
    }
  };

  const importCookie = async () => {
    if (!cookie.trim()) {
      setError("请先粘贴本人微博登录 Cookie。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const verified = await invoke<WeiboAccount>("import_weibo_cookie", { cookie: cookie.trim() });
      setAccount(verified);
      setSavedCookie((await invoke<string | null>("get_weibo_cookie")) ?? "");
      setCookie("");
      setCookieCheckResult((await onCookieStatusChange()) ? "Cookie 可用" : "Cookie 已失效");
      notify("Cookie 已保存。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const checkCookie = async () => {
    setCookieCheckBusy(true);
    setCookieCheckResult("正在检测…");
    setError("");
    try {
      const valid = await onCookieStatusChange();
      setCookieCheckResult(valid ? "Cookie 可用" : "Cookie 已失效");
    } catch (reason) {
      setCookieCheckResult(`检测失败：${String(reason)}`);
    } finally {
      setCookieCheckBusy(false);
    }
  };

  const deleteCookie = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("delete_weibo_cookie");
      setAccount(null);
      setQrState("获取Cookie");
      setCookie("");
      setSavedCookie("");
      setShowCookie(false);
      setCookieCheckResult("");
      setShowDeleteCookieConfirm(false);
      onCookieDeleted();
      notify("已删除保存的 Cookie。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const copyCookie = async () => {
    try {
      await navigator.clipboard.writeText(savedCookie);
      notify("Cookie 已复制。");
    } catch {
      setError("复制失败，请检查系统剪贴板权限。");
    }
  };

  const cookieStorageNote = configFileNames
    ? `Cookie 会明文保存在本地配置目录的 ${configFileNames.cookieFile} 中，不会写入应用日志。`
    : "Cookie 会明文保存在本地配置目录中，不会写入应用日志。";

  return <div className="page-stack">
    <div className="panel account-panel">
      <div className="panel-title">
        <div><strong>{cookieExists ? "Cookie 已保存" : "保存 Cookie"}</strong><span>扫码登录或导入 Cookie</span></div>
        <span className={`tag ${cookieExists ? "green" : "neutral"}`}>{cookieExists ? "已保存" : "未获取"}</span>
      </div>
      {cookieExists && <div className="connected-account">
        <div className="avatar"><LockKeyhole size={17}/></div>
        <div className="user-info cookie-value"><strong>微博 Cookie</strong><span>{showCookie ? savedCookie : "••••••••••••••••"}</span></div>
        <div className="cookie-actions">
          <button className="button ghost icon-tooltip" data-tooltip={showCookie ? "隐藏 Cookie" : "显示 Cookie"} aria-label={showCookie ? "隐藏 Cookie" : "显示 Cookie"} onClick={() => setShowCookie(value => !value)} disabled={!hasSavedCookie || busy}>{showCookie ? <EyeOff size={17}/> : <Eye size={17}/>}</button>
          <button className="button ghost icon-tooltip" data-tooltip="复制 Cookie" aria-label="复制 Cookie" onClick={copyCookie} disabled={!hasSavedCookie || busy}><Copy size={17}/></button>
          <button className="button secondary icon-tooltip" data-tooltip={cookieCheckBusy ? "正在检测…" : "检测 Cookie 可用性"} aria-label="检测 Cookie 可用性" onClick={() => void checkCookie()} disabled={cookieCheckBusy || busy || !hasSavedCookie}><ShieldCheck size={17}/></button>
          <button className="button danger icon-tooltip" data-tooltip="删除 Cookie" aria-label="删除 Cookie" onClick={() => setShowDeleteCookieConfirm(true)} disabled={busy}><Trash2 size={17}/></button>
        </div>
      </div>}
      {hasSavedCookie && cookieCheckResult && <div className={`cookie-validity-message ${cookieCheckResult === "Cookie 可用" ? "auth-success" : "auth-error"}`} role="status">{cookieCheckResult}</div>}
      {showDeleteCookieConfirm && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-cookie-title"><div className="modal-icon warning"><Trash2/></div><h3 id="delete-cookie-title">确认删除 Cookie</h3><p>删除后将清除当前保存的微博 Cookie，并删除与该 Cookie 关联的任务及任务记录。此操作不可撤销。</p><div className="warning-box">如果还需要这些任务记录，请先取消操作。</div><div className="modal-actions"><button className="button ghost" onClick={() => setShowDeleteCookieConfirm(false)} disabled={busy}>取消</button><button className="button danger" onClick={() => void deleteCookie()} disabled={busy}>{busy ? "正在删除…" : "确认删除"}</button></div></div></div>}
      <div className="segmented">
        <button className={method === "qr" ? "selected" : ""} onClick={() => { setMethod("qr"); setError(""); }}>扫码登录</button>
        <button className={method === "cookie" ? "selected" : ""} onClick={() => { setMethod("cookie"); setError(""); }}>导入 Cookie</button>
      </div>
      {method === "qr" ? <div className="qr-layout">
        <div className="qr-placeholder"><div className="qr-inner"><div className="qr-corner tl"/><div className="qr-corner tr"/><div className="qr-corner bl"/><div className="qr-pattern">{Array.from({length: 49}, (_, i) => <i key={i} style={{opacity: ((i * 17 + 5) % 11) > 3 ? 1 : .12}}/>)}</div></div><div className="qr-overlay"><LockKeyhole size={20}/></div></div>
        <div className="qr-copy">
          <h3>{qrState}</h3>
          <p>点击下方按钮打开微博官方登录页面。登录完成后，返回此处验证会话。</p>
          <div className="account-actions">
            <button className="button secondary" onClick={startQrLogin} disabled={cookieLocked || busy}><RefreshCw size={15}/> 打开微博扫码登录</button>
            {cookieExists && <span className="cookie-lock-note">已存在 Cookie，请先删除</span>}
          </div>
        </div>
      </div> : <div className="cookie-import">
        <Field label="微博 Cookie"><textarea rows={5} placeholder="粘贴本人微博登录后的 Cookie 请求头内容" value={cookie} onChange={e => setCookie(e.target.value)} disabled={cookieLocked || busy} autoComplete="off" /></Field>
        <div className="inline-note"><LockKeyhole size={16}/> {cookieStorageNote}</div>
        <div className="account-actions">
          <button className="button primary" onClick={importCookie} disabled={cookieLocked || busy}>保存 Cookie</button>
          {cookieExists && <span className="cookie-lock-note">已存在 Cookie，请先删除</span>}
        </div>
      </div>}
      {error && (method === "cookie" || !showQrDialog) && <div className="auth-error" role="alert">{error}</div>}
    </div>

  </div>;
}
function TaskBadge({ state }: {state: TaskState}) { const cls = state === "已完成" ? "green" : state === "执行中" ? "blue" : state === "失败" ? "red" : state === "排队中" ? "amber" : state === "暂停中" ? "orange" : state === "已暂停" ? "purple" : "neutral"; return <span className={`tag ${cls}`}><span className="tag-dot"/>{state}</span>; }
function EmptyState({ title, description }: {title: string; description: string}) { return <div className="empty-state"><div className="empty-icon"><Archive size={22}/></div><strong>{title}</strong><span>{description}</span></div>; }

export default App;