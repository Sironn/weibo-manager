import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import DateSegmentInput from "./components/DateSegmentInput";
import { listen } from "@tauri-apps/api/event";
import { initializeLogger, log, updateLoggerEnabled } from "./lib/logger";
import {
  Activity, Archive, ArrowDownToLine, ArrowRight, Check, ChevronDown, CircleHelp, Copy,
  CloudDownload, Eye, EyeOff, FileImage, FolderOpen, Gauge, Home, Image, ListTodo,
  LockKeyhole, MessageSquare, Moon, MoreHorizontal, Play, Plus, RefreshCw, Search, Settings2,
  ShieldCheck, Sun, ThumbsDown, Trash2, UserMinus, Users, Video, X,
} from "lucide-react";
import {
  buildFilename, buildFolderName, defaultFilenameSettings, filenameVariables,
  type FilenameSettings, type TemplateVariable,
} from "./lib/filenameTemplate";

type Page = "dashboard" | "accounts" | "delete" | "unlike" | "comment" | "follow" | "download" | "tasks" | "settings";
type TaskState = "未开始" | "排队中" | "执行中" | "暂停中" | "已暂停" | "已完成" | "失败";
type DeletePostResult = { postId: string; state: string; detail: string };
type DownloadSummary = { user: string; downloaded: number; skipped: number; failed: number; detail: string };
type DownloadUserDetail = { input: string; uid: string; screenName: string | null };
type DownloadTaskConfig = { users: string[]; userDetails: DownloadUserDetail[]; downloadDir: string; dateFrom: string; dateTo: string; mediaType: string; fileTemplate: string; folderTemplate: string; modifyFileTime: boolean };
type Task = { id: number; title: string; kind: "下载" | "删除" | "取消赞" | "评论" | "取关"; state: TaskState; progress: number; detail: string; createdAt?: string; postIds?: string[]; dateFrom?: string; dateTo?: string; keyword?: string; postType?: string; deletedOnly?: boolean; relation?: string; groupNames?: string[]; results?: DeletePostResult[]; downloadConfig?: DownloadTaskConfig; downloadResults?: DownloadSummary[] };
type WeiboPost = { id: string; date: string; createdAt: string; kind: string; text: string; media: string; originDeleted?: boolean };
type LikePost = { id: string; date: string; createdAt: string; text: string; media: string; author: string; deleted: boolean };
type CommentPost = { id: string; date: string; createdAt: string; text: string; author: string; statusText: string; statusMissing: boolean };
type PersistedCommentTask = { id: number; title: string; kind: string; state: TaskState; progress: number; detail: string; createdAt: string; postIds: string[]; dateFrom: string; dateTo: string; keyword?: string; results?: DeletePostResult[] };
type PersistedDeleteTask = { id: number; title: string; kind: string; state: TaskState; progress: number; detail: string; createdAt: string; postIds: string[]; dateFrom: string; dateTo: string; keyword: string; postType: string; results?: DeletePostResult[] };
type PersistedUnlikeTask = { id: number; title: string; kind: string; state: TaskState; progress: number; detail: string; createdAt: string; postIds: string[]; dateFrom: string; dateTo: string; deletedOnly?: boolean; results?: DeletePostResult[] };
type FollowUser = { id: string; screenName: string; avatar: string; followersCount: number; followMe: boolean; description: string; remark: string };
type FollowGroup = { id: string; name: string; count: number };
type PersistedFollowTask = { id: number; title: string; kind: string; state: TaskState; progress: number; detail: string; createdAt: string; postIds: string[]; relation?: string; groupNames?: string[]; keyword?: string; results?: DeletePostResult[] };
type ExecutedTask = { id: number; state: TaskState; progress: number; detail: string; results?: DeletePostResult[] };
type PersistedDownloadTask = { id: number; title: string; state: TaskState; progress: number; detail: string; createdAt: string; downloadConfig: DownloadTaskConfig; downloadResults?: DownloadSummary[] };
type RequestIntervalConfig = { mode: "fixed" | "random"; fixedMs: number; minMs: number; maxMs: number };
const nav: { id: Page; label: string; icon: typeof Home; group: string }[] = [
  { id: "dashboard", label: "工作台", icon: Home, group: "概览" },
  { id: "accounts", label: "Cookie 管理", icon: LockKeyhole, group: "微博管理" },
  { id: "delete", label: "删除微博", icon: Trash2, group: "微博管理" },
  { id: "unlike", label: "取消点赞", icon: ThumbsDown, group: "微博管理" },
  { id: "comment", label: "删除评论", icon: MessageSquare, group: "微博管理" },
  { id: "follow", label: "取消关注", icon: UserMinus, group: "微博管理" },
  { id: "download", label: "媒体下载", icon: CloudDownload, group: "微博管理" },
  { id: "tasks", label: "任务中心", icon: ListTodo, group: "系统" },
  { id: "settings", label: "设置", icon: Settings2, group: "系统" },
];
type ThemePreference = "system" | "light" | "dark";
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
function isValidDateFilter(value: string): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
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
  const [dateFilterResetToken, setDateFilterResetToken] = useState(0);
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
  // 逐条展示缓冲：后端一页返回 10 条时事件会同时到达，这里按固定间隔逐条追加以呈现实时出现的效果。
  const pendingPostQueue = useRef<{ post: WeiboPost; searchId: number }[]>([]);
  const pendingPostTimer = useRef<number | null>(null);
  const clearPendingPosts = () => {
    pendingPostQueue.current = [];
    if (pendingPostTimer.current !== null) {
      window.clearInterval(pendingPostTimer.current);
      pendingPostTimer.current = null;
    }
  };
  // 取消点赞页独立维护搜索状态与逐条展示队列，避免与微博删除页的读取互相打断。
  const [likePosts, setLikePosts] = useState<LikePost[]>([]);
  const [likePostChecks, setLikePostChecks] = useState<Record<string, boolean>>({});
  const [likePostsLoading, setLikePostsLoading] = useState(false);
  const [likePostsError, setLikePostsError] = useState("");
  const [likePostsPaused, setLikePostsPaused] = useState(false);
  const [likePostsCancelling, setLikePostsCancelling] = useState(false);
  const [unlikeDateFrom, setUnlikeDateFrom] = useState("");
  const [unlikeDateTo, setUnlikeDateTo] = useState("");
  const [unlikeDateResetToken, setUnlikeDateResetToken] = useState(0);
  const [unlikeDeletedOnly, setUnlikeDeletedOnly] = useState(false);
  const [appliedUnlikeDateFrom, setAppliedUnlikeDateFrom] = useState("");
  const [appliedUnlikeDateTo, setAppliedUnlikeDateTo] = useState("");
  const [appliedUnlikeDeletedOnly, setAppliedUnlikeDeletedOnly] = useState(false);
  const [showUnlikeConfirm, setShowUnlikeConfirm] = useState(false);
  const unlikeSearchGeneration = useRef(0);
  const activeUnlikeSearchGeneration = useRef<number | null>(null);
  const unlikeSearchInFlight = useRef(false);
  const acceptUnlikePostEvents = useRef(true);
  const pendingLikeQueue = useRef<{ post: LikePost; searchId: number }[]>([]);
  const pendingLikeTimer = useRef<number | null>(null);
  const clearPendingLikePosts = () => {
    pendingLikeQueue.current = [];
    if (pendingLikeTimer.current !== null) {
      window.clearInterval(pendingLikeTimer.current);
      pendingLikeTimer.current = null;
    }
  };
  // 评论删除页独立维护搜索状态与逐条展示队列，避免与其它页面的读取互相打断。
  const [commentPosts, setCommentPosts] = useState<CommentPost[]>([]);
  const [commentPostChecks, setCommentPostChecks] = useState<Record<string, boolean>>({});
  const [commentPostsLoading, setCommentPostsLoading] = useState(false);
  const [commentPostsError, setCommentPostsError] = useState("");
  const [commentPostsPaused, setCommentPostsPaused] = useState(false);
  const [commentPostsCancelling, setCommentPostsCancelling] = useState(false);
  const [commentDateFrom, setCommentDateFrom] = useState("");
  const [commentDateTo, setCommentDateTo] = useState("");
  const [commentKeyword, setCommentKeyword] = useState("");
  const [commentDateResetToken, setCommentDateResetToken] = useState(0);
  const [appliedCommentDateFrom, setAppliedCommentDateFrom] = useState("");
  const [appliedCommentDateTo, setAppliedCommentDateTo] = useState("");
  const [appliedCommentKeyword, setAppliedCommentKeyword] = useState("");
  const [showCommentConfirm, setShowCommentConfirm] = useState(false);
  const commentSearchGeneration = useRef(0);
  const activeCommentSearchGeneration = useRef<number | null>(null);
  const commentSearchInFlight = useRef(false);
  const acceptCommentPostEvents = useRef(true);
  const pendingCommentQueue = useRef<{ post: CommentPost; searchId: number }[]>([]);
  const pendingCommentTimer = useRef<number | null>(null);
  const clearPendingCommentPosts = () => {
    pendingCommentQueue.current = [];
    if (pendingCommentTimer.current !== null) {
      window.clearInterval(pendingCommentTimer.current);
      pendingCommentTimer.current = null;
    }
  };
  // 取消关注页：关系与分组只作为筛选条件，取关仍按单个人逐个执行。
  const [followUsers, setFollowUsers] = useState<FollowUser[]>([]);
  const [followUserChecks, setFollowUserChecks] = useState<Record<string, boolean>>({});
  const [followLoading, setFollowLoading] = useState(false);
  const [followError, setFollowError] = useState("");
  const [followPaused, setFollowPaused] = useState(false);
  const [followCancelling, setFollowCancelling] = useState(false);
  const [followRelation, setFollowRelation] = useState("all");
  const [followGroupIds, setFollowGroupIds] = useState<string[]>([]);
  const [followGroups, setFollowGroups] = useState<FollowGroup[]>([]);
  const [followKeyword, setFollowKeyword] = useState("");
  const [appliedFollowRelation, setAppliedFollowRelation] = useState("all");
  const [appliedFollowGroupIds, setAppliedFollowGroupIds] = useState<string[]>([]);
  const [appliedFollowKeyword, setAppliedFollowKeyword] = useState("");
  const [showFollowConfirm, setShowFollowConfirm] = useState(false);
  const followSearchGeneration = useRef(0);
  const activeFollowSearchGeneration = useRef<number | null>(null);
  const followSearchInFlight = useRef(false);
  const acceptFollowEvents = useRef(true);
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
  const [filenameSettings, setFilenameSettings] = useState<FilenameSettings>(defaultFilenameSettings);
  // 左侧设置子菜单与变量插入目标由状态统一驱动。
  const [settingSection, setSettingSection] = useState<"general" | "filename">("general");
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [templateTarget, setTemplateTarget] = useState<"file" | "folder">("file");
  const [downloadPath, setDownloadPath] = useState("~/Downloads/WeiboDownloads");
  const [downloadDateFrom, setDownloadDateFrom] = useState("");
  const [downloadDateTo, setDownloadDateTo] = useState("");
  const [downloadDateResetToken, setDownloadDateResetToken] = useState(0);
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
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const filteredPosts = useMemo(() => posts.filter(post =>
    post.text.toLowerCase().includes(appliedKeyword.trim().toLowerCase()) &&
    (!appliedDateFrom || post.date >= appliedDateFrom) && (!appliedDateTo || post.date <= appliedDateTo) &&
    (appliedPostType === "全部类型" || (appliedPostType === "失效转发" ? Boolean(post.originDeleted) : post.kind === appliedPostType))), [posts, appliedKeyword, appliedDateFrom, appliedDateTo, appliedPostType]);
  // 点赞列表的日期与失效状态均由本地筛选：接口不按发布时间排序，无法交给服务端过滤。
  const filteredLikePosts = useMemo(() => likePosts.filter(post =>
    (!appliedUnlikeDateFrom || post.date >= appliedUnlikeDateFrom) && (!appliedUnlikeDateTo || post.date <= appliedUnlikeDateTo) &&
    (!appliedUnlikeDeletedOnly || post.deleted)), [likePosts, appliedUnlikeDateFrom, appliedUnlikeDateTo, appliedUnlikeDeletedOnly]);
  // 评论列表按正文关键词与日期在本地过滤：接口不支持按内容检索。
  const filteredCommentPosts = useMemo(() => commentPosts.filter(post =>
    (post.text || "").toLowerCase().includes(appliedCommentKeyword.trim().toLowerCase()) &&
    (!appliedCommentDateFrom || post.date >= appliedCommentDateFrom) &&
    (!appliedCommentDateTo || post.date <= appliedCommentDateTo)), [commentPosts, appliedCommentKeyword, appliedCommentDateFrom, appliedCommentDateTo]);
  // 关注列表的关系与分组已由接口筛选，这里只按关键词匹配昵称和备注。
  const filteredFollowUsers = useMemo(() => {
    const keyword = appliedFollowKeyword.trim().toLowerCase();
    if (!keyword) return followUsers;
    return followUsers.filter(user =>
      user.screenName.toLowerCase().includes(keyword) || (user.remark || "").toLowerCase().includes(keyword));
  }, [followUsers, appliedFollowKeyword]);
  const selectedFollowCount = followUsers.filter(user => followUserChecks[user.id]).length;
  // 预览值模拟真实下载时可从用户资料、微博元数据和媒体响应中读取的字段。
  const previewValues = { USER_SCREEN_NAME: "travel_diary", POST_TIME: "2024-08-18 14:30:00", POST_ID: "5078219042", MEDIA_INDEX: "01", EXT: ".jpg" };
  const previewFilename = buildFilename(filenameSettings.fileTemplate, previewValues);
  const previewFoldername = buildFolderName(filenameSettings.folderTemplate, previewValues);
  const selectedCount = posts.filter(post => postChecks[post.id]).length;
  const selectedLikeCount = likePosts.filter(post => likePostChecks[post.id]).length;
  const selectedCommentCount = commentPosts.filter(post => commentPostChecks[post.id]).length;
  const selectableTaskIds = tasks.map(task => task.id);
  const selectedTaskCount = selectedTaskIds.filter(id => selectableTaskIds.includes(id)).length;
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };
  // 删除、取消赞、评论三类本地批量任务只有命令名与计数单位不同，集中在这里避免多处分支漂移。
  const isLocalBatchKind = (kind: Task["kind"]) => kind === "删除" || kind === "取消赞" || kind === "评论" || kind === "取关";
  const localBatchLabel = (kind: Task["kind"]) => kind === "取消赞" ? "取消点赞" : kind === "评论" ? "删除评论" : kind === "取关" ? "取消关注" : "删除";
  const localBatchUnit = (kind: Task["kind"]) => kind === "取消赞" ? "条点赞" : kind === "评论" ? "条评论" : kind === "取关" ? "人" : "条微博";
  const localBatchExecuteCommand = (kind: Task["kind"]) => kind === "取消赞" ? "execute_unlike_task" : kind === "评论" ? "execute_comment_task" : kind === "取关" ? "execute_follow_task" : "execute_delete_task";
  const localBatchPauseCommand = (kind: Task["kind"]) => kind === "取消赞" ? "set_unlike_task_paused" : kind === "评论" ? "set_comment_task_paused" : kind === "取关" ? "set_follow_task_paused" : "set_delete_task_paused";
  const resetAfterCookieDeleted = () => {
    setCookieValidity("invalid");
    setDownloadError("尚未登录微博，请先扫码登录或导入 Cookie。");
    // Cookie 删除后清除依赖当前登录会话的下载页面数据，保留下载目录与命名等用户设置。
    setUsers([]);
    setUserLabels({});
    setNewUser("");
    setDownloadDateResetToken(token => token + 1);
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
    clearPendingPosts();
    setPostsLoading(false);
    setPosts([]);
    setPostChecks({});
    setPostsError("尚未登录微博，请先扫码登录或导入 Cookie。");
    setPostsPaused(false);
    setPostsCancelling(false);
    setDateFilterResetToken(token => token + 1);
    setDateFrom("");
    setDateTo("");
    setKeyword("");
    setAppliedDateFrom("");
    setAppliedDateTo("");
    setAppliedKeyword("");
    setPostType("全部类型");
    setAppliedPostType("全部类型");
    // 取消点赞页依赖同一份登录会话，Cookie 删除后同样需要清空列表与筛选条件。
    unlikeSearchGeneration.current += 1;
    activeUnlikeSearchGeneration.current = null;
    acceptUnlikePostEvents.current = false;
    clearPendingLikePosts();
    setLikePostsLoading(false);
    setLikePosts([]);
    setLikePostChecks({});
    setLikePostsError("尚未登录微博，请先扫码登录或导入 Cookie。");
    setLikePostsPaused(false);
    setLikePostsCancelling(false);
    setUnlikeDateResetToken(token => token + 1);
    setUnlikeDateFrom("");
    setUnlikeDateTo("");
    setUnlikeDeletedOnly(false);
    setAppliedUnlikeDateFrom("");
    setAppliedUnlikeDateTo("");
    setAppliedUnlikeDeletedOnly(false);
    setShowUnlikeConfirm(false);
    // 评论删除页同样依赖登录会话，Cookie 删除后一并清空。
    commentSearchGeneration.current += 1;
    activeCommentSearchGeneration.current = null;
    acceptCommentPostEvents.current = false;
    clearPendingCommentPosts();
    setCommentPostsLoading(false);
    setCommentPosts([]);
    setCommentPostChecks({});
    setCommentPostsError("尚未登录微博，请先扫码登录或导入 Cookie。");
    setCommentPostsPaused(false);
    setCommentPostsCancelling(false);
    setCommentDateResetToken(token => token + 1);
    setCommentDateFrom("");
    setCommentDateTo("");
    setCommentKeyword("");
    setAppliedCommentDateFrom("");
    setAppliedCommentDateTo("");
    setAppliedCommentKeyword("");
    setShowCommentConfirm(false);
    // 取消关注页同属登录态数据，Cookie 删除后清空列表、筛选与分组缓存。
    followSearchGeneration.current += 1;
    activeFollowSearchGeneration.current = null;
    acceptFollowEvents.current = false;
    setFollowLoading(false);
    setFollowUsers([]);
    setFollowUserChecks({});
    setFollowError("尚未登录微博，请先扫码登录或导入 Cookie。");
    setFollowPaused(false);
    setFollowCancelling(false);
    setFollowRelation("all");
    setFollowGroupIds([]);
    setFollowGroups([]);
    setFollowKeyword("");
    setAppliedFollowRelation("all");
    setAppliedFollowGroupIds([]);
    setAppliedFollowKeyword("");
    setShowFollowConfirm(false);
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
        // 四个依赖登录态的页面必须一起清掉旧的登录错误，否则横幅会一直留着。
        setPostsError(current => isCookieError(current) ? "" : current);
        setLikePostsError(current => isCookieError(current) ? "" : current);
        setCommentPostsError(current => isCookieError(current) ? "" : current);
        setFollowError(current => isCookieError(current) ? "" : current);
        setDownloadError("");
        return true;
      }
      setCookieValidity("invalid");
      setPostsError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。");
      setLikePostsError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。");
      setCommentPostsError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。");
      setFollowError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。");
      setDownloadError("Cookie 已失效，请先重新登录微博或导入有效 Cookie。");
      return false;
    } catch (reason) {
      setCookieValidity("invalid");
      const message = String(reason).includes("尚未登录微博") ? "尚未登录微博，请先扫码登录或导入 Cookie。" : `Cookie 检测失败：${String(reason)}`;
      setPostsError(message);
      setLikePostsError(message);
      setCommentPostsError(message);
      setFollowError(message);
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
  useEffect(() => {
    void invoke<string | null>("get_download_directory").then(path => {
      if (path?.trim()) setDownloadPath(path);
    }).catch(reason => notify(`读取下载目录配置失败：${String(reason)}`));
  }, []);

  const refreshDeleteTasks = async (showSuccess = false) => {
    try {
      const [savedDeletes, savedUnlikes, savedComments, savedFollows, savedDownloads] = await Promise.all([
        invoke<PersistedDeleteTask[]>("get_delete_tasks"),
        invoke<PersistedUnlikeTask[]>("get_unlike_tasks"),
        invoke<PersistedCommentTask[]>("get_comment_tasks"),
        invoke<PersistedFollowTask[]>("get_follow_tasks"),
        invoke<PersistedDownloadTask[]>("get_download_tasks"),
      ]);
      const deleteTasks: Task[] = savedDeletes.map(task => ({ id: task.id, title: task.title, kind: "删除", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, keyword: task.keyword, postType: task.postType, results: task.results }));
      const unlikeTasks: Task[] = savedUnlikes.map(task => ({ id: task.id, title: task.title, kind: "取消赞", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, deletedOnly: task.deletedOnly, results: task.results }));
      const downloadTasks: Task[] = savedDownloads.map(task => ({ ...task, kind: "下载", downloadConfig: task.downloadConfig, downloadResults: task.downloadResults ?? [] }));
      const commentTasks: Task[] = savedComments.map(task => ({ id: task.id, title: task.title, kind: "评论", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, keyword: task.keyword, results: task.results }));
      const followTasks: Task[] = savedFollows.map(task => ({ id: task.id, title: task.title, kind: "取关", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, relation: task.relation, groupNames: task.groupNames, keyword: task.keyword, results: task.results }));
      const all = [...downloadTasks, ...deleteTasks, ...unlikeTasks, ...commentTasks, ...followTasks].sort((a,b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
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
    clearPendingPosts();
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
        // 已在逐条展示队列中的微博稍后单独追加，避免这里一次性补齐打乱逐条出现的节奏。
        const queued = new Set(pendingPostQueue.current.map(item => item.post.id));
        result.forEach(post => { if (!queued.has(post.id)) merged.set(post.id, post); });
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
    clearPendingPosts();
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
  const loadLikePosts = async () => {
    if (unlikeSearchInFlight.current) return;
    if (cookieValidity !== "valid") {
      await refreshCookieValidity();
      return;
    }
    unlikeSearchInFlight.current = true;
    const searchId = ++unlikeSearchGeneration.current;
    activeUnlikeSearchGeneration.current = searchId;
    const isCurrentSearch = () =>
      unlikeSearchGeneration.current === searchId &&
      activeUnlikeSearchGeneration.current === searchId &&
      acceptUnlikePostEvents.current;
    acceptUnlikePostEvents.current = true;
    setLikePostsLoading(true); setLikePostsError(""); setLikePostsPaused(false); setLikePostsCancelling(false);
    log("info", "unlike", "开始读取点赞列表");
    clearPendingLikePosts();
    setLikePosts([]); setLikePostChecks({});
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
      await invoke("set_unlike_search_cancelled", { cancelled: false });
      if (!isCurrentSearch()) return;
      await invoke("set_unlike_search_paused", { paused: false });
      if (!isCurrentSearch()) return;
      const result = await invoke<LikePost[]>("get_like_posts");
      if (!isCurrentSearch()) return;
      // 事件流负责逐条展示；命令返回值用于补齐未通过事件送达的点赞。
      setLikePosts(current => {
        if (!isCurrentSearch()) return current;
        const merged = new Map(current.map(post => [post.id, post]));
        const queued = new Set(pendingLikeQueue.current.map(item => item.post.id));
        result.forEach(post => { if (!queued.has(post.id)) merged.set(post.id, post); });
        return [...merged.values()];
      });
      log("info", "unlike", `点赞列表读取完成，后端返回 ${result.length} 条`);
    } catch (reason) {
      if (!isCurrentSearch()) return;
      log("error", "unlike", `点赞列表读取失败：${String(reason)}`);
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("尚未登录微博") || message.includes("Cookie 已失效")) setCookieValidity("invalid");
      setLikePostsError(message);
    } finally {
      if (isCurrentSearch()) {
        setLikePostsLoading(false);
        setLikePostsPaused(false);
        setLikePostsCancelling(false);
        try {
          await invoke("set_unlike_search_paused", { paused: false });
          if (isCurrentSearch()) {
            await invoke("set_unlike_search_cancelled", { cancelled: false });
          }
        } catch { /* 读取已结束，无需额外处理 */ }
        if (isCurrentSearch()) activeUnlikeSearchGeneration.current = null;
      }
      unlikeSearchInFlight.current = false;
    }
  };
  const searchLikePosts = async () => {
    if (likePostsLoading || cookieValidity !== "valid") return;
    if (!isValidDateFilter(unlikeDateFrom) || !isValidDateFilter(unlikeDateTo)) { notify("请输入有效日期，格式为 yyyy/mm/dd。"); return; }
    if (unlikeDateFrom && unlikeDateTo && unlikeDateFrom > unlikeDateTo) { notify("开始日期不能晚于结束日期。"); return; }
    const now = new Date();
    const effectiveEndDate = unlikeDateTo || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    setAppliedUnlikeDateFrom(unlikeDateFrom);
    setAppliedUnlikeDateTo(effectiveEndDate);
    setAppliedUnlikeDeletedOnly(unlikeDeletedOnly);
    await loadLikePosts();
  };
  const toggleUnlikeSearchPause = async () => {
    const nextPaused = !likePostsPaused;
    setLikePostsPaused(nextPaused);
    try { await invoke("set_unlike_search_paused", { paused: nextPaused }); }
    catch (reason) { setLikePostsPaused(!nextPaused); setLikePostsError(`无法控制读取状态：${String(reason)}`); }
  };
  const cancelUnlikeSearch = async () => {
    if (!likePostsLoading || likePostsCancelling || activeUnlikeSearchGeneration.current === null) return;
    // 先在前端让本次读取失效，再通知后端；迟到的返回值和事件都会被忽略。
    unlikeSearchGeneration.current += 1;
    activeUnlikeSearchGeneration.current = null;
    acceptUnlikePostEvents.current = false;
    clearPendingLikePosts();
    setLikePostsLoading(false);
    setLikePostsCancelling(true);
    setLikePostsPaused(false);
    try {
      await invoke("set_unlike_search_cancelled", { cancelled: true });
      setLikePostsCancelling(false);
    } catch (reason) {
      setLikePostsCancelling(false);
      setLikePostsError(`取消读取失败：${String(reason)}`);
    }
  };
  const createUnlikeTask = async () => {
    const postIds = likePosts.filter(post => likePostChecks[post.id]).map(post => post.id);
    if (cookieValidity !== "valid") { notify("请先登录微博并确认 Cookie 可用。"); return; }
    if (!postIds.length) { notify("请至少选择一条点赞。"); return; }
    try {
      const task = await invoke<PersistedUnlikeTask>("create_unlike_task", {
        postIds, dateFrom: appliedUnlikeDateFrom, dateTo: appliedUnlikeDateTo, deletedOnly: appliedUnlikeDeletedOnly,
      });
      setTasks(current => [{ id: task.id, title: task.title, kind: "取消赞", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, deletedOnly: task.deletedOnly, results: task.results }, ...current.filter(item => item.id !== task.id)]);
      setShowUnlikeConfirm(false);
      setPage("tasks");
      notify("取消点赞任务已保存。请在任务中心再次确认后执行。");
    } catch (reason) {
      const message = String(reason);
      if (message.includes("所选点赞都已存在于其他未完成的取消点赞任务中")) {
        setShowUnlikeConfirm(false);
        notify("所选点赞都已存在于任务中，无需重复创建。");
        return;
      }
      notify(`创建任务失败：${message}`);
    }
  };
  const loadCommentPosts = async (dateFrom: string) => {
    if (commentSearchInFlight.current) return;
    if (cookieValidity !== "valid") {
      await refreshCookieValidity();
      return;
    }
    commentSearchInFlight.current = true;
    const searchId = ++commentSearchGeneration.current;
    activeCommentSearchGeneration.current = searchId;
    const isCurrentSearch = () =>
      commentSearchGeneration.current === searchId &&
      activeCommentSearchGeneration.current === searchId &&
      acceptCommentPostEvents.current;
    acceptCommentPostEvents.current = true;
    setCommentPostsLoading(true); setCommentPostsError(""); setCommentPostsPaused(false); setCommentPostsCancelling(false);
    log("info", "comment", "开始读取评论列表");
    clearPendingCommentPosts();
    setCommentPosts([]); setCommentPostChecks({});
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
      await invoke("set_comment_search_cancelled", { cancelled: false });
      if (!isCurrentSearch()) return;
      await invoke("set_comment_search_paused", { paused: false });
      if (!isCurrentSearch()) return;
      // 起始日期只用于让后端提前结束翻页，最终筛选仍在前端按已应用条件执行。
      const result = await invoke<CommentPost[]>("get_comment_posts", { dateFrom });
      if (!isCurrentSearch()) return;
      setCommentPosts(current => {
        if (!isCurrentSearch()) return current;
        const merged = new Map(current.map(post => [post.id, post]));
        const queued = new Set(pendingCommentQueue.current.map(item => item.post.id));
        result.forEach(post => { if (!queued.has(post.id)) merged.set(post.id, post); });
        return [...merged.values()];
      });
      log("info", "comment", `评论列表读取完成，后端返回 ${result.length} 条`);
    } catch (reason) {
      if (!isCurrentSearch()) return;
      log("error", "comment", `评论列表读取失败：${String(reason)}`);
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("尚未登录微博") || message.includes("Cookie 已失效")) setCookieValidity("invalid");
      setCommentPostsError(message);
    } finally {
      if (isCurrentSearch()) {
        setCommentPostsLoading(false);
        setCommentPostsPaused(false);
        setCommentPostsCancelling(false);
        try {
          await invoke("set_comment_search_paused", { paused: false });
          if (isCurrentSearch()) {
            await invoke("set_comment_search_cancelled", { cancelled: false });
          }
        } catch { /* 读取已结束，无需额外处理 */ }
        if (isCurrentSearch()) activeCommentSearchGeneration.current = null;
      }
      commentSearchInFlight.current = false;
    }
  };
  const searchCommentPosts = async () => {
    if (commentPostsLoading || cookieValidity !== "valid") return;
    if (!isValidDateFilter(commentDateFrom) || !isValidDateFilter(commentDateTo)) { notify("请输入有效日期，格式为 yyyy/mm/dd。"); return; }
    if (commentDateFrom && commentDateTo && commentDateFrom > commentDateTo) { notify("开始日期不能晚于结束日期。"); return; }
    const now = new Date();
    const effectiveEndDate = commentDateTo || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    setAppliedCommentDateFrom(commentDateFrom);
    setAppliedCommentDateTo(effectiveEndDate);
    setAppliedCommentKeyword(commentKeyword);
    await loadCommentPosts(commentDateFrom);
  };
  const toggleCommentSearchPause = async () => {
    const nextPaused = !commentPostsPaused;
    setCommentPostsPaused(nextPaused);
    try { await invoke("set_comment_search_paused", { paused: nextPaused }); }
    catch (reason) { setCommentPostsPaused(!nextPaused); setCommentPostsError(`无法控制读取状态：${String(reason)}`); }
  };
  const cancelCommentSearch = async () => {
    if (!commentPostsLoading || commentPostsCancelling || activeCommentSearchGeneration.current === null) return;
    commentSearchGeneration.current += 1;
    activeCommentSearchGeneration.current = null;
    acceptCommentPostEvents.current = false;
    clearPendingCommentPosts();
    setCommentPostsLoading(false);
    setCommentPostsCancelling(true);
    setCommentPostsPaused(false);
    try {
      await invoke("set_comment_search_cancelled", { cancelled: true });
      setCommentPostsCancelling(false);
    } catch (reason) {
      setCommentPostsCancelling(false);
      setCommentPostsError(`取消读取失败：${String(reason)}`);
    }
  };
  const createCommentTask = async () => {
    const postIds = commentPosts.filter(post => commentPostChecks[post.id]).map(post => post.id);
    if (cookieValidity !== "valid") { notify("请先登录微博并确认 Cookie 可用。"); return; }
    if (!postIds.length) { notify("请至少选择一条评论。"); return; }
    try {
      const task = await invoke<PersistedCommentTask>("create_comment_task", {
        postIds, dateFrom: appliedCommentDateFrom, dateTo: appliedCommentDateTo, keyword: appliedCommentKeyword,
      });
      setTasks(current => [{ id: task.id, title: task.title, kind: "评论", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, keyword: task.keyword, results: task.results }, ...current.filter(item => item.id !== task.id)]);
      setShowCommentConfirm(false);
      setPage("tasks");
      notify("删除评论任务已保存。请在任务中心再次确认后执行。");
    } catch (reason) {
      const message = String(reason);
      if (message.includes("所选评论都已存在于其他未完成的评论任务中")) {
        setShowCommentConfirm(false);
        notify("所选评论都已存在于任务中，无需重复创建。");
        return;
      }
      notify(`创建任务失败：${message}`);
    }
  };
  useEffect(() => { scheduleWaitingDownloadRef.current(); }, []);
  const loadFollowGroups = async () => {
    if (cookieValidity !== "valid" || followGroups.length > 0) return;
    try { setFollowGroups(await invoke<FollowGroup[]>("get_follow_groups")); }
    catch (reason) { log("error", "follow", `读取关注分组失败：${String(reason)}`); }
  };
  // 取消关注页打开且登录态可用时，顺手把分组列表取回来供筛选使用。
  useEffect(() => { if (page === "follow") void loadFollowGroups(); }, [page, cookieValidity]);
  const loadFollowUsers = async (relation: string, groupIds: string[]) => {
    if (followSearchInFlight.current) return;
    if (cookieValidity !== "valid") {
      await refreshCookieValidity();
      return;
    }
    followSearchInFlight.current = true;
    const searchId = ++followSearchGeneration.current;
    activeFollowSearchGeneration.current = searchId;
    const isCurrentSearch = () =>
      followSearchGeneration.current === searchId &&
      activeFollowSearchGeneration.current === searchId &&
      acceptFollowEvents.current;
    acceptFollowEvents.current = true;
    setFollowLoading(true); setFollowError(""); setFollowPaused(false); setFollowCancelling(false);
    log("info", "follow", "开始读取关注列表");
    setFollowUsers([]); setFollowUserChecks({});
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
      await invoke("set_follow_search_cancelled", { cancelled: false });
      if (!isCurrentSearch()) return;
      await invoke("set_follow_search_paused", { paused: false });
      if (!isCurrentSearch()) return;
      const result = await invoke<FollowUser[]>("get_follow_users", { relation, groupIds });
      if (!isCurrentSearch()) return;
      setFollowUsers(current => {
        const merged = new Map(current.map(user => [user.id, user]));
        result.forEach(user => merged.set(user.id, user));
        return [...merged.values()];
      });
      log("info", "follow", `关注列表读取完成，后端返回 ${result.length} 人`);
    } catch (reason) {
      if (!isCurrentSearch()) return;
      log("error", "follow", `关注列表读取失败：${String(reason)}`);
      const message = reason instanceof Error ? reason.message : String(reason);
      if (message.includes("尚未登录微博") || message.includes("Cookie 已失效")) setCookieValidity("invalid");
      setFollowError(message);
    } finally {
      if (isCurrentSearch()) {
        setFollowLoading(false);
        setFollowPaused(false);
        setFollowCancelling(false);
        try {
          await invoke("set_follow_search_paused", { paused: false });
          if (isCurrentSearch()) await invoke("set_follow_search_cancelled", { cancelled: false });
        } catch { /* 读取已结束，无需额外处理 */ }
        activeFollowSearchGeneration.current = null;
      }
      followSearchInFlight.current = false;
    }
  };
  const searchFollowUsers = async () => {
    if (followLoading || cookieValidity !== "valid") return;
    setAppliedFollowRelation(followRelation);
    setAppliedFollowGroupIds(followGroupIds);
    setAppliedFollowKeyword(followKeyword);
    await loadFollowUsers(followRelation, followGroupIds);
  };
  const toggleFollowSearchPause = async () => {
    const nextPaused = !followPaused;
    setFollowPaused(nextPaused);
    try { await invoke("set_follow_search_paused", { paused: nextPaused }); }
    catch (reason) { setFollowPaused(!nextPaused); setFollowError(`无法控制读取状态：${String(reason)}`); }
  };
  const cancelFollowSearch = async () => {
    if (!followLoading || followCancelling || activeFollowSearchGeneration.current === null) return;
    followSearchGeneration.current += 1;
    activeFollowSearchGeneration.current = null;
    acceptFollowEvents.current = false;
    setFollowLoading(false);
    setFollowCancelling(true);
    setFollowPaused(false);
    try {
      await invoke("set_follow_search_cancelled", { cancelled: true });
      setFollowCancelling(false);
    } catch (reason) {
      setFollowCancelling(false);
      setFollowError(`取消读取失败：${String(reason)}`);
    }
  };
  const createFollowTask = async () => {
    const postIds = followUsers.filter(user => followUserChecks[user.id]).map(user => user.id);
    if (cookieValidity !== "valid") { notify("请先登录微博并确认 Cookie 可用。"); return; }
    if (!postIds.length) { notify("请至少选择一个要取关的用户。"); return; }
    try {
      const groupNames = followGroups.filter(group => appliedFollowGroupIds.includes(group.id)).map(group => group.name);
      const task = await invoke<PersistedFollowTask>("create_follow_task", {
        postIds, relation: appliedFollowRelation, groupNames, keyword: appliedFollowKeyword,
      });
      setTasks(current => [{ id: task.id, title: task.title, kind: "取关", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, relation: task.relation, groupNames: task.groupNames, keyword: task.keyword, results: task.results }, ...current.filter(item => item.id !== task.id)]);
      setShowFollowConfirm(false);
      setPage("tasks");
      notify("取消关注任务已保存。请在任务中心再次确认后执行。");
    } catch (reason) {
      const message = String(reason);
      if (message.includes("其他未完成的取关任务中")) {
        setShowFollowConfirm(false);
        notify("所选用户都已存在于任务中，无需重复创建。");
        return;
      }
      notify(`创建任务失败：${message}`);
    }
  };
  useEffect(() => { if (executingDeleteTask === null) scheduleWaitingDownloadRef.current(); }, [executingDeleteTask]);
  const persistDownloadPath = async (path: string) => {
    try { await invoke("save_download_directory", { path }); }
    catch (reason) { notify(`保存下载目录失败：${String(reason)}`); }
  };
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
    void listen<{ taskId: number; user: string; completed: number; total: number; mediaId: string; phase: string; percent: number; detail: string }>("download-progress", event => {
      const progress = event.payload;
      // 下载任务按单个媒体文件的进度展示：当前文件下载完显示 100%，下一个文件从 0% 重新开始。
      setTasks(current => current.map(task => task.kind === "下载" && task.id === progress.taskId && task.state === "执行中"
        ? { ...task, progress: progress.phase === "completed" ? 100 : (progress.percent ?? task.progress), detail: progress.phase === "downloading" ? progress.detail : `${progress.user}：${progress.detail}` }
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
      if (pendingPostQueue.current.some(item => item.post.id === post.id)) {
        log("debug", "delete", `事件微博已在待展示队列中，跳过，微博 ID=${post.id}`);
        return;
      }
      pendingPostQueue.current.push({ post, searchId: eventSearchId });
      if (pendingPostTimer.current === null) {
        pendingPostTimer.current = window.setInterval(() => {
          const next = pendingPostQueue.current.shift();
          if (!next) {
            if (pendingPostTimer.current !== null) window.clearInterval(pendingPostTimer.current);
            pendingPostTimer.current = null;
            return;
          }
          // 只校验代次而不依赖“搜索进行中”标记：搜索命令已返回时仍要把队列里剩下的微博逐条补齐，否则最后一批会被合并逻辑跳过而丢失。
          if (!acceptDeletePostEvents.current || deleteSearchGeneration.current !== next.searchId) return;
          setPosts(current => current.some(item => item.id === next.post.id) ? current : [...current, next.post]);
        }, 120);
      }
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
      clearPendingPosts();
      if (unlisten) {
        unlisten();
        log("info", "delete", "微博逐条展示事件监听器已清理");
      } else {
        log("info", "delete", "组件卸载时监听器注册尚未完成；注册完成后将立即清理");
      }
    };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<unknown>("unlike-post-item", event => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      const eventSearchId = activeUnlikeSearchGeneration.current;
      if (!acceptUnlikePostEvents.current || eventSearchId === null) return;
      const candidate = payload as Partial<LikePost>;
      if (typeof candidate.id !== "string" || !candidate.id) {
        log("error", "unlike", `收到点赞逐条展示事件，但 payload 缺少有效 id；字段：${Object.keys(payload).join(", ")}`);
        return;
      }
      const post = candidate as LikePost;
      if (pendingLikeQueue.current.some(item => item.post.id === post.id)) return;
      pendingLikeQueue.current.push({ post, searchId: eventSearchId });
      if (pendingLikeTimer.current === null) {
        pendingLikeTimer.current = window.setInterval(() => {
          const next = pendingLikeQueue.current.shift();
          if (!next) {
            if (pendingLikeTimer.current !== null) window.clearInterval(pendingLikeTimer.current);
            pendingLikeTimer.current = null;
            return;
          }
          if (!acceptUnlikePostEvents.current || unlikeSearchGeneration.current !== next.searchId) return;
          setLikePosts(current => current.some(item => item.id === next.post.id) ? current : [...current, next.post]);
        }, 120);
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "unlike", `点赞逐条展示事件监听器注册失败：${String(reason)}`);
    });
    return () => { disposed = true; clearPendingLikePosts(); unlisten?.(); };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<PersistedUnlikeTask>("unlike-task-updated", event => {
      const task = event.payload;
      setTasks(current => [{ id: task.id, title: task.title, kind: "取消赞", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, deletedOnly: task.deletedOnly, results: task.results }, ...current.filter(item => item.id !== task.id)]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "unlike", `注册取消点赞任务进度监听失败：${String(reason)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<unknown>("comment-post-item", event => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      const eventSearchId = activeCommentSearchGeneration.current;
      if (!acceptCommentPostEvents.current || eventSearchId === null) return;
      const candidate = payload as Partial<CommentPost>;
      if (typeof candidate.id !== "string" || !candidate.id) {
        log("error", "comment", `收到评论逐条展示事件，但 payload 缺少有效 id；字段：${Object.keys(payload).join(", ")}`);
        return;
      }
      const post = candidate as CommentPost;
      if (pendingCommentQueue.current.some(item => item.post.id === post.id)) return;
      pendingCommentQueue.current.push({ post, searchId: eventSearchId });
      if (pendingCommentTimer.current === null) {
        pendingCommentTimer.current = window.setInterval(() => {
          const next = pendingCommentQueue.current.shift();
          if (!next) {
            if (pendingCommentTimer.current !== null) window.clearInterval(pendingCommentTimer.current);
            pendingCommentTimer.current = null;
            return;
          }
          if (!acceptCommentPostEvents.current || commentSearchGeneration.current !== next.searchId) return;
          setCommentPosts(current => current.some(item => item.id === next.post.id) ? current : [...current, next.post]);
        }, 120);
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "comment", `评论逐条展示事件监听器注册失败：${String(reason)}`);
    });
    return () => { disposed = true; clearPendingCommentPosts(); unlisten?.(); };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<PersistedCommentTask>("comment-task-updated", event => {
      const task = event.payload;
      setTasks(current => [{ id: task.id, title: task.title, kind: "评论", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, dateFrom: task.dateFrom, dateTo: task.dateTo, keyword: task.keyword, results: task.results }, ...current.filter(item => item.id !== task.id)]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "comment", `注册评论任务进度监听失败：${String(reason)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const queue: { user: FollowUser; searchId: number }[] = [];
    let timer: number | null = null;
    const clear = () => {
      queue.length = 0;
      if (timer !== null) { window.clearInterval(timer); timer = null; }
    };
    void listen<unknown>("follow-user-item", event => {
      const payload = event.payload;
      if (!payload || typeof payload !== "object") return;
      const eventSearchId = activeFollowSearchGeneration.current;
      if (!acceptFollowEvents.current || eventSearchId === null) return;
      const candidate = payload as Partial<FollowUser>;
      if (typeof candidate.id !== "string" || !candidate.id) {
        log("error", "follow", `收到关注逐条展示事件，但 payload 缺少有效 id；字段：${Object.keys(payload).join(", ")}`);
        return;
      }
      const user = candidate as FollowUser;
      if (queue.some(item => item.user.id === user.id)) return;
      queue.push({ user, searchId: eventSearchId });
      if (timer === null) {
        timer = window.setInterval(() => {
          const next = queue.shift();
          if (!next) {
            if (timer !== null) window.clearInterval(timer);
            timer = null;
            return;
          }
          if (!acceptFollowEvents.current || followSearchGeneration.current !== next.searchId) return;
          setFollowUsers(current => current.some(item => item.id === next.user.id) ? current : [...current, next.user]);
        }, 120);
      }
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "follow", `关注逐条展示事件监听器注册失败：${String(reason)}`);
    });
    return () => { disposed = true; clear(); unlisten?.(); };
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<PersistedFollowTask>("follow-task-updated", event => {
      const task = event.payload;
      setTasks(current => [{ id: task.id, title: task.title, kind: "取关", state: task.state, progress: task.progress, detail: task.detail, createdAt: task.createdAt, postIds: task.postIds, relation: task.relation, groupNames: task.groupNames, keyword: task.keyword, results: task.results }, ...current.filter(item => item.id !== task.id)]);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(reason => {
      log("error", "follow", `注册取关任务进度监听失败：${String(reason)}`);
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    void invoke<{ theme: ThemePreference; filenameSettings: FilenameSettings }>("get_app_settings").then(settings => {
      setTheme(settings.theme);
      setFilenameSettings(settings.filenameSettings ?? defaultFilenameSettings);
    }).catch(reason => notify("读取应用设置失败：" + String(reason)));
    void invoke<RequestIntervalConfig>("get_request_interval").then(config => {
      setRequestIntervalMode(config.mode);
      setRequestDelay(String(config.fixedMs));
      setRequestMinDelay(String(config.minMs));
      setRequestMaxDelay(String(config.maxMs));
    }).catch(reason => notify(`读取请求间隔设置失败：${String(reason)}`));
  }, []);
  useEffect(() => {
    if (theme !== "system") {
      setDark(theme === "dark");
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const syncSystemTheme = () => setDark(mediaQuery.matches);
    syncSystemTheme();
    mediaQuery.addEventListener("change", syncSystemTheme);
    return () => mediaQuery.removeEventListener("change", syncSystemTheme);
  }, [theme]);
  // 删除、取消点赞、评论删除共用同一个执行名额：各自调用自己的执行命令，前端排队逻辑保持一致。
  const runDeleteTask = async (task: Task) => {
    const command = localBatchExecuteCommand(task.kind);
    const label = localBatchLabel(task.kind);
    try {
      const result = await invoke<ExecutedTask>(command, { taskId: task.id });
      setTasks(current => current.map(item => item.id === result.id ? {
        ...item, state: result.state, progress: result.progress, detail: result.detail, results: result.results,
      } : item));
      notify(result.state === "已完成" ? `${label}任务执行完成。` : `${label}任务结束：${result.state}`);
    } catch (reason) {
      const detail = String(reason);
      setTasks(current => current.map(item => item.id === task.id ? { ...item, state: "失败", detail } : item));
      notify(`执行${label}任务失败：${detail}`);
    } finally {
      activeDeleteTaskId.current = null;
      setExecutingDeleteTask(null);
      const nextId = pendingDeleteStartIds[0];
      if (nextId !== undefined) {
        setPendingDeleteStartIds(current => current.slice(1));
        const nextTask = tasksRef.current.find(item => item.id === nextId && isLocalBatchKind(item.kind));
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
    const unlikeIds = ids.filter(id => tasks.some(task => task.id === id && task.kind === "取消赞"));
    const commentIds = ids.filter(id => tasks.some(task => task.id === id && task.kind === "评论"));
    const followIds = ids.filter(id => tasks.some(task => task.id === id && task.kind === "取关"));
    try {
      const removedDeleteIds = deleteIds.length ? await invoke<number[]>("remove_delete_tasks", { taskIds: deleteIds }) : [];
      const removedUnlikeIds = unlikeIds.length ? await invoke<number[]>("remove_unlike_tasks", { taskIds: unlikeIds }) : [];
      const removedCommentIds = commentIds.length ? await invoke<number[]>("remove_comment_tasks", { taskIds: commentIds }) : [];
      const removedFollowIds = followIds.length ? await invoke<number[]>("remove_follow_tasks", { taskIds: followIds }) : [];
      const downloadIds = ids.filter(id => tasks.some(task => task.id === id && task.kind === "下载"));
      const removedDownloadIds = downloadIds.length ? await invoke<number[]>("remove_download_tasks", { taskIds: downloadIds }) : [];
      const removedIds = [...removedDownloadIds, ...removedDeleteIds, ...removedUnlikeIds, ...removedCommentIds, ...removedFollowIds];
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
      const nextTask = tasksRef.current.find(item => item.id === nextId && isLocalBatchKind(item.kind));
      if (!nextTask || pausedDeleteIds.current.has(nextId) || nextTask.state === "已完成") {
        scheduleWaitingDeleteRef.current();
        return;
      }
      activeDeleteTaskId.current = nextId;
      setExecutingDeleteTask(nextId);
      setTasks(current => current.map(item => item.id === nextId
        ? { ...item, state: "执行中", detail: `正在启动${localBatchLabel(nextTask.kind)}任务` }
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
    const deletions = selected.filter(task => isLocalBatchKind(task.kind) && (task.state === "未开始" || task.state === "失败"));
    if (deletions.length) {
      setPendingDeleteStartIds(deletions.slice(1).map(task => task.id));
      setDeleteActionTask(deletions[0]);
      notify("已提交所选任务；每个任务都会单独要求确认。");
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
    const label = localBatchLabel(task.kind);
    setTasks(current => current.map(item => item.id === task.id ? { ...item, state: "暂停中", detail: `正在停止后台${label}工作` } : item));
    try {
      const command = localBatchPauseCommand(task.kind);
      const finalState = await invoke<TaskState>(command, { taskId: task.id, paused: true });
      if (finalState === "已暂停") setTasks(current => current.map(item => item.id === task.id ? { ...item, state: "已暂停", detail: "已暂停，点击开始后继续执行" } : item));
      else setTasks(current => current.map(item => item.id === task.id ? { ...item, state: finalState } : item));
    } catch (reason) { notify(`暂停${label}失败：${String(reason)}`); }
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
    void invoke("save_app_setting", { key: "filenameSettings", value: next })
      .catch(reason => notify("保存命名模板失败：" + String(reason)));
  };
  const renderPage = () => {
    if (page === "dashboard") return <Dashboard tasks={tasks} go={setPage} />;
    if (page === "accounts") return <Accounts notify={notify} onCookieDeleted={resetAfterCookieDeleted} onCookieStatusChange={refreshCookieValidity} />;
    if (page === "delete") return <section className="page-stack delete-page">
      <PageHeading title="删除微博" />
      {postsError && isCookieError(postsError) && <div className="cookie-warning-banner" role="alert"><span>{postsError}</span><button className="button secondary" onClick={() => void refreshCookieValidity()} disabled={cookieValidity === "checking"}>{cookieValidity === "checking" ? "正在检测…" : "重试"}</button></div>}
      {postsError && !isCookieError(postsError) && <div className="auth-error delete-generic-error" role="alert">{postsError}</div>}
      <div className="panel filter-panel">
        <div className="panel-title"><div><strong>筛选条件</strong><span>日期可留空以搜索全部时间，设置条件后点击搜索应用筛选条件。</span></div><button className="button ghost" onClick={() => { setDateFilterResetToken(token => token + 1); setKeyword(""); setDateFrom(""); setDateTo(""); setPostType("全部类型"); setAppliedKeyword(""); setAppliedDateFrom(""); setAppliedDateTo(""); setAppliedPostType("全部类型"); }}>重置条件</button></div>
        <div className="filter-grid"><Field label="开始日期"><DateSegmentInput key={dateFilterResetToken} ariaLabel="开始日期" value={dateFrom} onChange={setDateFrom} /></Field><Field label="结束日期"><DateSegmentInput key={dateFilterResetToken + 1000} ariaLabel="结束日期" value={dateTo} onChange={setDateTo} /></Field><Field label="关键词"><div className="input-icon"><Search size={16}/><input placeholder="搜索微博正文" value={keyword} onChange={e => setKeyword(e.target.value)} /></div></Field><Field label="微博类型"><select value={postType} onChange={e => setPostType(e.target.value)}><option>全部类型</option><option>原创</option><option>转发</option><option>失效转发</option></select></Field></div>
        <div className="filter-foot"><FilterSummary items={[["开始日期", dateFrom || "不限"], ["结束日期", dateTo || "不限"], ["关键字", keyword.trim() || "不限"], ["微博类型", postType]]}/><div className="account-actions"><button className="button primary" onClick={() => void searchDeletePosts()} disabled={postsLoading || cookieValidity !== "valid"}><Search size={15}/> {postsLoading ? "正在读取…" : "搜索微博"}</button></div></div>
      </div>
      <div className="panel delete-posts-panel">
        <div className="panel-title"><div><strong>待处理微博</strong><span>已获取 {posts.length} 条 满足条件 {filteredPosts.length} 条 已选择 {selectedCount} 条</span></div><div className="account-actions">{postsLoading && !postsCancelling && <><button className="button secondary" onClick={() => void toggleDeleteSearchPause()}>{postsPaused ? <Play size={15}/> : <PauseSolid size={15}/>} {postsPaused ? "继续读取" : "暂停读取"}</button><button className="button danger" onClick={() => void cancelDeleteSearch()}><X size={15}/> 取消读取</button></> }<button className="button secondary" onClick={() => void loadDeletePosts(appliedDateFrom)} disabled={postsLoading || cookieValidity !== "valid"}><RefreshCw size={15}/> 刷新</button><button className="button danger" onClick={() => setShowDeleteConfirm(true)} disabled={!selectedCount || cookieValidity !== "valid"}><Trash2 size={15}/> 创建任务</button></div></div>
        <div className="table-wrap delete-posts-scroll"><table><thead><tr><th><input type="checkbox" checked={filteredPosts.length > 0 && filteredPosts.every(post => postChecks[post.id])} onChange={e => setPostChecks(current => { const next = { ...current }; filteredPosts.forEach(post => { if (e.target.checked) next[post.id] = true; else delete next[post.id]; }); return next; })} aria-label="全选当前筛选微博" /></th><th>微博内容</th><th>发布时间</th><th>类型</th><th>媒体</th></tr></thead><tbody>{filteredPosts.map(post => <tr key={post.id}><td><input type="checkbox" checked={Boolean(postChecks[post.id])} onChange={e => setPostChecks(current => ({ ...current, [post.id]: e.target.checked }))} aria-label="选择微博" /></td><td><div className="post-text">{post.text || "（无正文）"}</div><small>ID: {post.id}</small></td><td>{post.date}</td><td><span className="tag neutral">{post.originDeleted ? "失效转发" : post.kind}</span></td><td>{post.media}</td></tr>)}</tbody></table>
        {!postsLoading && (!postsError || isCookieError(postsError)) && filteredPosts.length === 0 && <EmptyState title={posts.length === 0 ? "暂无微博数据" : "没有匹配的微博"} description={posts.length === 0 ? "请确认已登录微博，然后点击刷新微博。" : "尝试调整日期、关键词或微博类型。"}/>}</div>
      </div>
      {showDeleteConfirm && <div className="modal-backdrop"><div className="modal"><div className="modal-icon warning"><Trash2/></div><h3>确认创建删除任务</h3><p>将创建一个包含 {selectedCount} 条微博的删除任务。创建任务本身不会删除微博，你还需要在任务中心再次确认并启动执行。</p><div className="warning-box">微博删除不可恢复，执行时将逐条请求并记录结果。</div><div className="modal-actions"><button className="button ghost" onClick={() => setShowDeleteConfirm(false)}>返回检查</button><button className="button danger" onClick={() => void createDeleteTask()}>创建待确认任务</button></div></div></div>}
    </section>;
    if (page === "unlike") {
    // Cookie 未登录或失效时，页面提示与微博删除页保持一致。
    const likeError = likePostsError || (cookieValidity === "invalid" ? "尚未登录微博，请先扫码登录或导入 Cookie。" : "");
    return <section className="page-stack delete-page unlike-page">
      <PageHeading title="取消点赞" />
      {likeError && isCookieError(likeError) && <div className="cookie-warning-banner" role="alert"><span>{likeError}</span><button className="button secondary" onClick={() => void refreshCookieValidity()} disabled={cookieValidity === "checking"}>{cookieValidity === "checking" ? "正在检测…" : "重试"}</button></div>}
      {likeError && !isCookieError(likeError) && <div className="auth-error delete-generic-error" role="alert">{likeError}</div>}
      <div className="panel filter-panel">
        <div className="panel-title"><div><strong>筛选条件</strong><span>日期可留空以搜索全部时间，设置条件后点击搜索应用筛选条件。</span></div><button className="button ghost" onClick={() => { setUnlikeDateResetToken(token => token + 1); setUnlikeDateFrom(""); setUnlikeDateTo(""); setUnlikeDeletedOnly(false); setAppliedUnlikeDateFrom(""); setAppliedUnlikeDateTo(""); setAppliedUnlikeDeletedOnly(false); }}>重置条件</button></div>
        <div className="filter-grid filter-grid-action"><Field label="开始日期"><DateSegmentInput key={unlikeDateResetToken} ariaLabel="开始日期" value={unlikeDateFrom} onChange={setUnlikeDateFrom} /></Field><Field label="结束日期"><DateSegmentInput key={unlikeDateResetToken + 1000} ariaLabel="结束日期" value={unlikeDateTo} onChange={setUnlikeDateTo} /></Field><Field label="原文失效"><label className="inline-toggle"><input type="checkbox" checked={unlikeDeletedOnly} onChange={e => setUnlikeDeletedOnly(e.target.checked)} /><span>仅显示已失效的点赞</span></label></Field><div className="filter-action"><button className="button primary" onClick={() => void searchLikePosts()} disabled={likePostsLoading || cookieValidity !== "valid"}><Search size={15}/> {likePostsLoading ? "正在读取…" : "搜索点赞"}</button></div></div>
        <div className="filter-foot"><FilterSummary items={[["开始日期", unlikeDateFrom || "不限"], ["结束日期", unlikeDateTo || "不限"], ["原文失效", unlikeDeletedOnly ? "仅失效" : "不限"]]}/></div>
      </div>
      <div className="panel delete-posts-panel">
        <div className="panel-title"><div><strong>待处理点赞</strong><span>已获取 {likePosts.length} 条 满足条件 {filteredLikePosts.length} 条 已选择 {selectedLikeCount} 条</span></div><div className="account-actions">{likePostsLoading && !likePostsCancelling && <><button className="button secondary" onClick={() => void toggleUnlikeSearchPause()}>{likePostsPaused ? <Play size={15}/> : <PauseSolid size={15}/>} {likePostsPaused ? "继续读取" : "暂停读取"}</button><button className="button danger" onClick={() => void cancelUnlikeSearch()}><X size={15}/> 取消读取</button></> }<button className="button secondary" onClick={() => void loadLikePosts()} disabled={likePostsLoading || cookieValidity !== "valid"}><RefreshCw size={15}/> 刷新</button><button className="button danger" onClick={() => setShowUnlikeConfirm(true)} disabled={!selectedLikeCount || cookieValidity !== "valid"}><ThumbsDown size={15}/> 创建任务</button></div></div>
        <div className="table-wrap delete-posts-scroll"><table><thead><tr><th><input type="checkbox" checked={filteredLikePosts.length > 0 && filteredLikePosts.every(post => likePostChecks[post.id])} onChange={e => setLikePostChecks(current => { const next = { ...current }; filteredLikePosts.forEach(post => { if (e.target.checked) next[post.id] = true; else delete next[post.id]; }); return next; })} aria-label="全选当前筛选点赞" /></th><th>微博内容</th><th>作者</th><th>发布时间</th><th>状态</th><th>媒体</th></tr></thead><tbody>{filteredLikePosts.map(post => <tr key={post.id}><td><input type="checkbox" checked={Boolean(likePostChecks[post.id])} onChange={e => setLikePostChecks(current => ({ ...current, [post.id]: e.target.checked }))} aria-label="选择点赞" /></td><td><div className="post-text">{post.text || "（无正文）"}</div><small>ID: {post.id}</small></td><td>{post.author || "—"}</td><td>{post.date}</td><td><span className={`tag ${post.deleted ? "amber" : "neutral"}`}>{post.deleted ? "原文失效" : "正常"}</span></td><td>{post.media}</td></tr>)}</tbody></table>
        {!likePostsLoading && (!likeError || isCookieError(likeError)) && filteredLikePosts.length === 0 && <EmptyState title={likePosts.length === 0 ? "暂无点赞数据" : "没有匹配的点赞"} description={likePosts.length === 0 ? "请确认已登录微博，然后点击刷新点赞。" : "尝试调整日期或关闭原文失效筛选。"}/>}</div>
      </div>
      {showUnlikeConfirm && <div className="modal-backdrop"><div className="modal"><div className="modal-icon warning"><ThumbsDown/></div><h3>确认创建取消点赞任务</h3><p>将创建一个包含 {selectedLikeCount} 条点赞的取消点赞任务。创建任务本身不会取消点赞，你还需要在任务中心再次确认并启动执行。</p><div className="warning-box">取消点赞不可恢复，需要重新手动点赞才能恢复。</div><div className="modal-actions"><button className="button ghost" onClick={() => setShowUnlikeConfirm(false)}>返回检查</button><button className="button danger" onClick={() => void createUnlikeTask()}>创建待确认任务</button></div></div></div>}
    </section>;
    }
    if (page === "comment") {
    const commentError = commentPostsError || (cookieValidity === "invalid" ? "尚未登录微博，请先扫码登录或导入 Cookie。" : "");
    return <section className="page-stack delete-page">
      <PageHeading title="删除评论" />
      {commentError && isCookieError(commentError) && <div className="cookie-warning-banner" role="alert"><span>{commentError}</span><button className="button secondary" onClick={() => void refreshCookieValidity()} disabled={cookieValidity === "checking"}>{cookieValidity === "checking" ? "正在检测…" : "重试"}</button></div>}
      {commentError && !isCookieError(commentError) && <div className="auth-error delete-generic-error" role="alert">{commentError}</div>}
      <div className="panel filter-panel">
        <div className="panel-title">
          <div><strong>筛选条件</strong><span>日期可留空以搜索全部时间，设置条件后点击搜索应用筛选条件。</span></div>
          <button className="button ghost" onClick={() => { setCommentDateResetToken(token => token + 1); setCommentDateFrom(""); setCommentDateTo(""); setCommentKeyword(""); setAppliedCommentDateFrom(""); setAppliedCommentDateTo(""); setAppliedCommentKeyword(""); }}>重置条件</button>
        </div>
        <div className="filter-grid filter-grid-action">
          <Field label="开始日期"><DateSegmentInput key={commentDateResetToken} ariaLabel="开始日期" value={commentDateFrom} onChange={setCommentDateFrom} /></Field>
          <Field label="结束日期"><DateSegmentInput key={commentDateResetToken + 1000} ariaLabel="结束日期" value={commentDateTo} onChange={setCommentDateTo} /></Field>
          <Field label="关键词"><div className="input-icon"><Search size={16}/><input placeholder="搜索评论内容" value={commentKeyword} onChange={e => setCommentKeyword(e.target.value)} /></div></Field>
          <div className="filter-action"><button className="button primary" onClick={() => void searchCommentPosts()} disabled={commentPostsLoading || cookieValidity !== "valid"}><Search size={15}/> {commentPostsLoading ? "正在读取…" : "搜索评论"}</button></div>
        </div>
        <div className="filter-foot"><FilterSummary items={[["开始日期", commentDateFrom || "不限"], ["结束日期", commentDateTo || "不限"], ["关键词", commentKeyword.trim() || "不限"]]}/></div>
      </div>
      <div className="panel delete-posts-panel">
        <div className="panel-title">
          <div><strong>待处理评论</strong><span>已获取 {commentPosts.length} 条 满足条件 {filteredCommentPosts.length} 条 已选择 {selectedCommentCount} 条</span></div>
          <div className="account-actions">{commentPostsLoading && !commentPostsCancelling && <>
            <button className="button secondary" onClick={() => void toggleCommentSearchPause()}>{commentPostsPaused ? <Play size={15}/> : <PauseSolid size={15}/>} {commentPostsPaused ? "继续读取" : "暂停读取"}</button>
            <button className="button danger" onClick={() => void cancelCommentSearch()}><X size={15}/> 取消读取</button>
          </> }<button className="button secondary" onClick={() => void loadCommentPosts(appliedCommentDateFrom)} disabled={commentPostsLoading || cookieValidity !== "valid"}><RefreshCw size={15}/> 刷新</button>
          <button className="button danger" onClick={() => setShowCommentConfirm(true)} disabled={!selectedCommentCount || cookieValidity !== "valid"}><Trash2 size={15}/> 创建任务</button>
          </div>
        </div>
        <div className="table-wrap delete-posts-scroll compact-table">
          <table>
            <thead><tr>
              <th><input type="checkbox" checked={filteredCommentPosts.length > 0 && filteredCommentPosts.every(post => commentPostChecks[post.id])} onChange={e => setCommentPostChecks(current => { const next = { ...current }; filteredCommentPosts.forEach(post => { if (e.target.checked) next[post.id] = true; else delete next[post.id]; }); return next; })} aria-label="全选当前筛选评论" /></th>
              <th>评论内容</th>
              <th>所属微博</th>
              <th>发布时间</th>
            </tr></thead>
            <tbody>{filteredCommentPosts.map(post => <tr key={post.id}>
              <td><input type="checkbox" checked={Boolean(commentPostChecks[post.id])} onChange={e => setCommentPostChecks(current => ({ ...current, [post.id]: e.target.checked }))} aria-label="选择评论" /></td>
              <td><div className="post-text">{post.text || "（无正文）"}</div><small>ID: {post.id}</small></td>
              <td><div className="post-text">{post.statusText}</div>{post.statusMissing && <small>原文当前不可见</small>}</td>
              <td>{post.date}</td>
            </tr>)}</tbody>
          </table>
          {!commentPostsLoading && (!commentError || isCookieError(commentError)) && filteredCommentPosts.length === 0 && <EmptyState title={commentPosts.length === 0 ? "暂无评论数据" : "没有匹配的评论"} description={commentPosts.length === 0 ? "请确认已登录微博，然后点击刷新。" : "尝试调整日期或关键词。"}/>}</div>
      </div>
      {showCommentConfirm && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="comment-confirm-title"><div className="modal-icon warning"><MessageSquare/></div><h3 id="comment-confirm-title">确认创建删除评论任务</h3><p>将创建一个包含 {selectedCommentCount} 条评论的删除任务。创建任务本身不会删除评论，你还需要在任务中心再次确认并启动执行。</p><div className="warning-box">评论删除不可恢复，执行时将逐条请求并记录结果。</div><div className="modal-actions"><button className="button ghost" onClick={() => setShowCommentConfirm(false)}>返回检查</button><button className="button danger" onClick={() => void createCommentTask()}>创建待确认任务</button></div></div></div>}
    </section>;
    }
    if (page === "follow") {
    const followBanner = followError || (cookieValidity === "invalid" ? "尚未登录微博，请先扫码登录或导入 Cookie。" : "");
    const relationLabel = followRelation === "followme" ? "互相关注" : followRelation === "notfollowme" ? "非互相关注" : "全部关注";
    const groupLabel = followGroupIds.length === 0 ? "不限" : followGroups.filter(group => followGroupIds.includes(group.id)).map(group => group.name).join("、") || "已选分组";
    return <section className="page-stack delete-page">
      <PageHeading title="取消关注" />
      {followBanner && isCookieError(followBanner) && <div className="cookie-warning-banner" role="alert"><span>{followBanner}</span><button className="button secondary" onClick={() => void refreshCookieValidity()} disabled={cookieValidity === "checking"}>{cookieValidity === "checking" ? "正在检测…" : "重试"}</button></div>}
      {followBanner && !isCookieError(followBanner) && <div className="auth-error delete-generic-error" role="alert">{followBanner}</div>}
      <div className="panel filter-panel">
        <div className="panel-title">
          <div><strong>筛选条件</strong><span>关系与分组只决定列表里出现谁；勾选后创建任务，执行时仍逐个用户单独取关。</span></div>
          <button className="button ghost" onClick={() => { setFollowRelation("all"); setFollowGroupIds([]); setFollowKeyword(""); setAppliedFollowRelation("all"); setAppliedFollowGroupIds([]); setAppliedFollowKeyword(""); }}>重置条件</button>
        </div>
        <div className="filter-grid filter-grid-action">
          <Field label="关注关系"><select value={followRelation} onChange={e => setFollowRelation(e.target.value)}><option value="all">全部关注</option><option value="followme">互相关注</option><option value="notfollowme">非互相关注</option></select></Field>
          <Field label="关注分组"><MultiSelect options={followGroups.map(group => ({ value: group.id, label: group.count > 0 ? `${group.name}（${group.count}）` : group.name }))} selected={followGroupIds} onChange={setFollowGroupIds} placeholder={followGroups.length === 0 ? "暂无可选分组" : "全部分组"} /></Field>
          <Field label="关键词"><div className="input-icon"><Search size={16}/><input placeholder="搜索昵称或备注" value={followKeyword} onChange={e => setFollowKeyword(e.target.value)} /></div></Field>
        </div>
        <div className="filter-foot"><FilterSummary items={[["关注关系", relationLabel], ["关注分组", groupLabel], ["关键词", followKeyword.trim() || "不限"]]}/><div className="account-actions"><button className="button primary" onClick={() => void searchFollowUsers()} disabled={followLoading || cookieValidity !== "valid"}><Search size={15}/> {followLoading ? "正在读取…" : "搜索关注"}</button></div></div>
      </div>
      <div className="panel delete-posts-panel">
        <div className="panel-title">
          <div><strong>待处理关注</strong><span>已获取 {followUsers.length} 人 满足条件 {filteredFollowUsers.length} 人 已选择 {selectedFollowCount} 人</span></div>
          <div className="account-actions">{followLoading && !followCancelling && <>
            <button className="button secondary" onClick={() => void toggleFollowSearchPause()}>{followPaused ? <Play size={15}/> : <PauseSolid size={15}/>} {followPaused ? "继续读取" : "暂停读取"}</button>
            <button className="button danger" onClick={() => void cancelFollowSearch()}><X size={15}/> 取消读取</button>
          </> }<button className="button secondary" onClick={() => void loadFollowUsers(appliedFollowRelation, appliedFollowGroupIds)} disabled={followLoading || cookieValidity !== "valid"}><RefreshCw size={15}/> 刷新</button>
          <button className="button danger" onClick={() => setShowFollowConfirm(true)} disabled={!selectedFollowCount || cookieValidity !== "valid"}><UserMinus size={15}/> 创建任务</button>
          </div>
        </div>
        <div className="table-wrap delete-posts-scroll compact-table follow-table">
          <table>
            <thead><tr>
              <th><input type="checkbox" checked={filteredFollowUsers.length > 0 && filteredFollowUsers.every(user => followUserChecks[user.id])} onChange={e => setFollowUserChecks(current => { const next = { ...current }; filteredFollowUsers.forEach(user => { if (e.target.checked) next[user.id] = true; else delete next[user.id]; }); return next; })} aria-label="全选当前筛选关注" /></th>
              <th>用户</th>
              <th>粉丝数</th>
              <th>关系</th>
              <th>简介</th>
            </tr></thead>
            <tbody>{filteredFollowUsers.map(user => <tr key={user.id}>
              <td><input type="checkbox" checked={Boolean(followUserChecks[user.id])} onChange={e => setFollowUserChecks(current => ({ ...current, [user.id]: e.target.checked }))} aria-label="选择关注" /></td>
              <td><div className="follow-cell">{user.avatar ? <img className="follow-avatar" src={user.avatar} alt="" loading="lazy" /> : <span className="follow-avatar" />}<div className="user-info"><strong>{user.screenName}</strong><span>{user.remark || `UID ${user.id}`}</span></div></div></td>
              <td>{user.followersCount}</td>
              <td><span className={`tag ${user.followMe ? "green" : "neutral"}`}>{user.followMe ? "互关" : "单向"}</span></td>
              <td><div className="post-text">{user.description || "（无简介）"}</div></td>
            </tr>)}</tbody>
          </table>
          {!followLoading && (!followBanner || isCookieError(followBanner)) && filteredFollowUsers.length === 0 && <EmptyState title={appliedFollowRelation !== "all" || appliedFollowGroupIds.length > 0 || appliedFollowKeyword.trim() ? "没有匹配的关注" : "暂无关注数据"} description={appliedFollowRelation !== "all" || appliedFollowGroupIds.length > 0 || appliedFollowKeyword.trim() ? "尝试调整关注关系、分组或关键词。" : "请确认已登录微博，然后点击搜索关注。"}/>}</div>
      </div>
      {showFollowConfirm && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="follow-confirm-title"><div className="modal-icon warning"><UserMinus/></div><h3 id="follow-confirm-title">确认创建取消关注任务</h3><p>将创建一个包含 {selectedFollowCount} 人的取消关注任务。创建任务本身不会取关，你还需要在任务中心再次确认并启动执行。</p><div className="warning-box">取消关注不可恢复，需要重新搜索并关注该用户才能恢复。</div><div className="modal-actions"><button className="button ghost" onClick={() => setShowFollowConfirm(false)}>返回检查</button><button className="button danger" onClick={() => void createFollowTask()}>创建待确认任务</button></div></div></div>}
    </section>;
    }
    if (page === "download") return <section className="page-stack">
      <PageHeading title="媒体下载" />
      {downloadError && isCookieError(downloadError) && <div className="cookie-warning-banner" role="alert"><span>{downloadError}</span><button className="button secondary" onClick={() => void refreshDownloadCookieValidity()} disabled={cookieValidity === "checking"}>{cookieValidity === "checking" ? "正在检测…" : "重试"}</button></div>}
      {downloadError && !isCookieError(downloadError) && <div className="auth-error delete-generic-error" role="alert">{downloadError}</div>}
      <div className="stats-grid three"><Stat label="待处理用户" value={String(users.length)} icon={Users}/><Stat label="下载任务" value={String(tasks.filter(t => t.kind === "下载").length)} icon={Image} /><Stat label="下载完成" value={String(tasks.filter(t => t.kind === "下载" && t.state === "已完成").length)} icon={Check} /></div>
      <div className="panel download-user-panel">
        <div className="panel-title"><div><strong>目标用户队列</strong><span>支持添加多个用户并排队，日期留空表示不限时间。</span></div><span className="tag blue">{users.length} 个用户</span></div>
        <div className="add-user-row"><div className="input-icon"><Users size={16}/><input placeholder="微博主页链接或用户标识" value={newUser} onChange={e => setNewUser(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && newUser.trim()) void addDownloadUser(); }} /></div><button className="button secondary" onClick={() => void addDownloadUser()} disabled={!newUser.trim()}><Plus size={15}/> 添加用户</button></div>
        <div className="user-list">{users.map((user, i) => <div className="user-row" key={user + i}><div className="avatar">{user.slice(0, 1).toUpperCase()}</div><div className="user-info"><strong>{userLabels[user] ? `${userLabels[user]} UID: ${extractWeiboUid(user) || "待识别"}` : `用户名 UID: ${extractWeiboUid(user) || "待识别"}`}</strong><span>待采集 · {extractWeiboUid(user) ? "UID 已识别" : "请确认输入的是 UID 或微博主页链接"}</span></div><span className="tag neutral">队列 {i + 1}</span><button className="icon-button" aria-label="移除用户" onClick={() => setUsers(u => u.filter((_, index) => index !== i))}><X size={16}/></button></div>)}</div>
        <div className="download-form-grid"><Field className="field-date" label="开始日期"><DateSegmentInput key={downloadDateResetToken} ariaLabel="开始日期" value={downloadDateFrom} onChange={setDownloadDateFrom} /></Field><Field className="field-date" label="结束日期"><DateSegmentInput key={downloadDateResetToken + 1000} ariaLabel="结束日期" value={downloadDateTo} onChange={setDownloadDateTo} /></Field><Field className="field-media" label="媒体类型"><select value={downloadMediaType} onChange={e => setDownloadMediaType(e.target.value)}><option value="all">图片、视频、LivePhoto</option><option value="images">仅图片</option><option value="videos">仅视频</option><option value="livephoto">仅 LivePhoto</option></select></Field><Field className="field-path" label="下载目录"><div className="input-with-button"><span className="path-input-tooltip icon-tooltip" data-tooltip={downloadPath}><input value={downloadPath} onChange={e => setDownloadPath(e.target.value)} onBlur={() => void persistDownloadPath(downloadPath)} /></span><button className="icon-button icon-tooltip" data-tooltip="选择下载目录" onClick={() => void invoke<string | null>("select_download_directory", { initialDir: downloadPath }).then(path => { if (path) { setDownloadPath(path); void persistDownloadPath(path); } }).catch(reason => notify(`选择下载目录失败：${String(reason)}`))} aria-label="选择下载目录"><FolderOpen size={16}/></button></div></Field><div className="field-switch"><span>修改创建日期</span><label className="switch-control" aria-label="修改创建日期"><input type="checkbox" checked={modifyDownloadFileTime} onChange={e => setModifyDownloadFileTime(e.target.checked)}/><span className="switch-track"><span className="switch-thumb"/></span></label></div></div>
        <div className="filter-foot download-filter-foot"><FilterSummary items={[["开始日期", downloadDateFrom || "不限"], ["结束日期", downloadDateTo || "不限"], ["媒体类型", downloadMediaType === "all" ? "全部媒体" : downloadMediaType === "images" ? "仅图片" : downloadMediaType === "videos" ? "仅视频" : "仅 LivePhoto"]]}/><div className="account-actions"><button className="button primary" onClick={() => void createDownloadTask()} disabled={!users.length || cookieValidity !== "valid"}><Plus size={15}/> 创建下载任务</button></div></div>
      </div>
    </section>;
    if (page === "tasks") return <section className="page-stack"><PageHeading title="任务中心" actions={<button className="button secondary" onClick={() => void refreshDeleteTasks(true)}><RefreshCw size={15}/> 刷新</button>} /><div className="stats-grid four"><Stat label="全部任务" value={String(tasks.length)} icon={ListTodo}/><Stat label="执行中" value={String(tasks.filter(t => t.state === "执行中").length)} icon={Activity}/><Stat label="已完成" value={String(tasks.filter(t => t.state === "已完成").length)} icon={Check}/><Stat label="失败任务" value={String(tasks.filter(t => t.state === "失败").length)} icon={CircleHelp}/></div><div className="panel task-list-panel"><div className="panel-title task-list-heading"><div><strong>所有任务</strong></div><div className="task-bulk-actions"><button className="icon-button icon-tooltip task-start-selected" data-tooltip={selectedTaskCount ? `开始选中的 ${selectedTaskCount} 条任务` : "请先勾选任务"} aria-label="开始选中任务" disabled={!selectedTaskCount} onClick={startSelectedTasks}><Play size={17} fill="currentColor"/></button><button className="icon-button icon-tooltip task-delete-selected" data-tooltip={selectedTaskCount ? `删除选中的 ${selectedTaskCount} 条任务` : "请先勾选任务"} aria-label="删除选中任务" disabled={!selectedTaskCount} onClick={() => setShowDeleteTasksConfirm(true)}><Trash2 size={17}/></button></div></div><div className="table-wrap task-list-scroll"><table><thead><tr><th><input type="checkbox" aria-label="全选任务" checked={selectableTaskIds.length > 0 && selectableTaskIds.every(id => selectedTaskIds.includes(id))} onChange={e => setSelectedTaskIds(e.target.checked ? selectableTaskIds : [])}/></th><th>任务</th><th>类型</th><th>状态</th><th>进度</th><th>详情</th><th>操作</th><th>更多</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}>
        <td><input type="checkbox" aria-label={`选择任务 ${task.id}`} checked={selectedTaskIds.includes(task.id)} onChange={e => setSelectedTaskIds(current => e.target.checked ? [...current.filter(id => id !== task.id), task.id] : current.filter(id => id !== task.id))}/></td>
        <td className="task-title-cell"><span className="icon-tooltip task-title-tooltip" data-tooltip={task.title}><strong>{task.title}</strong></span><small>任务 #{task.id}</small></td>
        <td>{task.kind === "下载" ? <span className="tag blue">下载</span> : task.kind === "取消赞" ? <span className="tag green">取消赞</span> : task.kind === "评论" ? <span className="tag purple">评论</span> : task.kind === "取关" ? <span className="tag neutral">取关</span> : <span className="tag amber">删除</span>}</td>
        <td><TaskBadge state={task.state}/></td>
        <td><div className="table-progress"><div className="progress-track"><div style={{width: `${task.progress}%`}}/><span className="progress-label">{task.progress}%</span></div></div></td>
        <td><span className="icon-tooltip task-detail-tooltip" data-tooltip={isLocalBatchKind(task.kind) && task.state === "未开始" ? "待确认 " + (task.postIds?.length ?? 0) + " " + localBatchUnit(task.kind) : task.detail}><span className="task-detail-cell">{isLocalBatchKind(task.kind) && task.state === "未开始" ? "待确认 " + (task.postIds?.length ?? 0) + " " + localBatchUnit(task.kind) : task.detail}</span></span></td>
        <td><div className="account-actions task-operation-actions">
          {isLocalBatchKind(task.kind) && task.state === "执行中" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip={`暂停${localBatchLabel(task.kind)}`} aria-label={`暂停${localBatchLabel(task.kind)}`} onClick={() => void pauseDeleteTask(task)}><PauseSolid size={16}/></button>}
          {isLocalBatchKind(task.kind) && task.state === "暂停中" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="正在暂停" aria-label="正在暂停" disabled><PauseSolid size={16}/></button>}
          {isLocalBatchKind(task.kind) && task.state === "排队中" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="暂停任务" aria-label="暂停任务" onClick={() => void pauseDeleteTask(task)}><PauseSolid size={16}/></button>}
          {isLocalBatchKind(task.kind) && task.state === "已暂停" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip={`继续${localBatchLabel(task.kind)}`} aria-label={`继续${localBatchLabel(task.kind)}`} onClick={() => void resumeDeleteTask(task)}><Play size={16} fill="currentColor"/></button>}
          {isLocalBatchKind(task.kind) && task.state === "已完成" && <button className="icon-button task-action-icon icon-tooltip" data-tooltip="已完成" aria-label="已完成" disabled><Check size={16}/></button>}
          {isLocalBatchKind(task.kind) && (task.state === "未开始" || task.state === "失败") && <button className="icon-button task-action-icon icon-tooltip" data-tooltip={task.state === "未开始" ? `执行${localBatchLabel(task.kind)}` : `重新开始${localBatchLabel(task.kind)}`} aria-label={task.state === "未开始" ? `执行${localBatchLabel(task.kind)}` : `重新开始${localBatchLabel(task.kind)}`} disabled={cookieValidity !== "valid"} onClick={() => setDeleteActionTask(task)}>{task.state === "未开始" ? <Play size={16} fill="currentColor"/> : <RefreshCw size={16}/>}</button>}
          {task.kind === "下载" && task.downloadConfig && <>{task.state === "执行中" || task.state === "排队中" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="暂停任务" aria-label="暂停任务" onClick={() => void pauseDownloadTask(task)}><PauseSolid size={16}/></button> : task.state === "暂停中" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="正在暂停" aria-label="正在暂停" disabled><PauseSolid size={16}/></button> : task.state === "已暂停" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="继续下载" aria-label="继续下载" onClick={() => void resumeDownloadTask(task)}><Play size={16} fill="currentColor"/></button> : task.state === "已完成" ? <button className="icon-button task-action-icon icon-tooltip" data-tooltip="打开下载目录" aria-label="打开下载目录" onClick={() => {
             const config = task.downloadConfig!;
             const targetFolder = config.users.length === 1
               ? buildFolderName(config.folderTemplate, {
                   USER_SCREEN_NAME: task.downloadResults?.length === 1
                     ? task.downloadResults[0].user
                     : config.userDetails?.find(item => item.input === config.users[0])?.screenName?.trim() || extractWeiboUid(config.users[0]),
                   POST_TIME: "", POST_ID: "", MEDIA_INDEX: "", EXT: "",
                 })
               : null;
             void invoke("open_download_directory", { downloadDir: config.downloadDir, targetFolder })
               .catch(reason => notify(`打开下载目录失败：${String(reason)}`));
           }}><FolderOpen size={16}/></button> : <button className="icon-button task-action-icon icon-tooltip" data-tooltip={task.state === "失败" ? "重新开始下载" : "开始下载"} aria-label={task.state === "失败" ? "重新开始下载" : "开始下载"} disabled={cookieValidity === "checking"} onClick={() => void executeDownloadTask(task)}>{task.state === "失败" ? <RefreshCw size={16}/> : <Play size={16} fill="currentColor"/>}</button>}</>}
        </div></td>
        <td><button className="icon-button task-action-icon icon-tooltip" data-tooltip="更多" aria-label="更多任务信息" onClick={() => setMoreTask(task)}><MoreHorizontal size={17}/></button></td>
      </tr>)}</tbody></table>{tasks.length === 0 && <EmptyState title="暂无任务" description="创建删除任务后会显示在这里；执行前会再次要求确认。" />}</div></div>      {moreTask && <div className="modal-backdrop" role="presentation"><div className="modal more-task-modal" role="dialog" aria-modal="true" aria-labelledby="more-task-title"><button className="icon-button more-task-close icon-tooltip" data-tooltip="关闭" aria-label="关闭任务详情" onClick={() => setMoreTask(null)}><X size={17}/></button><div className="modal-icon" style={{background:"#eef2ff",color:"#4f67ce"}}><MoreHorizontal/></div><h3 id="more-task-title">{moreTask.title}</h3>
        <div style={{display:"grid",gap:10,fontSize:12}}>
          {moreTask.postIds && <div><strong>任务总条数：</strong>{moreTask.postIds.length} 条</div>}
          {moreTask.results && moreTask.results.length > 0 && <div><strong>执行结果：</strong>已处理 {moreTask.results.length} 条，成功 {moreTask.results.filter(item => item.state === "已删除" || item.state === "已取消").length} 条，失败 {moreTask.results.filter(item => item.state === "失败").length} 条</div>}
          {moreTask.results?.some(item => item.state === "失败" && item.detail.trim()) && <div><strong>失败原因：</strong><div style={{display:"grid",gap:6,marginTop:6}}>{moreTask.results.filter(item => item.state === "失败" && item.detail.trim()).map(item => <div key={item.postId}>{item.postId}：{item.detail}</div>)}</div></div>}
          {(moreTask.dateFrom || moreTask.dateTo || moreTask.keyword?.trim() || (moreTask.postType && moreTask.postType !== "全部类型")) && <div><strong>筛选条件：</strong><div style={{display:"grid",gap:5,marginTop:6}}>{(moreTask.dateFrom || moreTask.dateTo) && <div>日期：{moreTask.dateFrom || "不限"} 至 {moreTask.dateTo || "不限"}</div>}{moreTask.kind === "取消赞" && <div>点赞范围：{moreTask.deletedOnly ? "仅原文失效" : "全部点赞"}</div>}{moreTask.postType && moreTask.postType !== "全部类型" && <div>微博类型：{moreTask.postType}</div>}{moreTask.keyword?.trim() && <div>关键词：{moreTask.keyword}</div>}</div></div>}
          {moreTask.detail.trim() && moreTask.state !== "未开始" && <div><strong>任务信息：</strong>{moreTask.detail}</div>}
          {moreTask.results && moreTask.results.length > 0 && <div><strong>逐条结果：</strong><div style={{display:"grid",gap:6,marginTop:6}}>{moreTask.results.map(item => <div key={item.postId}>{item.postId} {item.state} {item.detail}</div>)}</div></div>}
          {moreTask.downloadConfig && <div><strong>目标用户：</strong><div style={{display:"grid",gap:5,marginTop:6}}>{moreTask.downloadConfig.users.map((user, index) => { const detail = moreTask.downloadConfig!.userDetails?.find(item => item.input === user); const uid = detail?.uid || extractWeiboUid(user); const url = uid ? `https://weibo.com/u/${uid}` : user; const label = detail?.screenName?.trim() || (uid ? `UID ${uid}` : "昵称未识别"); return <div key={user + index}>{label}：{url}</div>; })}</div></div>}
          {moreTask.downloadConfig && <div><strong>筛选条件：</strong><div style={{display:"grid",gap:5,marginTop:6}}><div>开始日期：{moreTask.downloadConfig.dateFrom || "不限"}</div><div>结束日期：{moreTask.downloadConfig.dateTo || "不限"}</div><div>媒体类型：{moreTask.downloadConfig.mediaType === "all" ? "全部媒体" : moreTask.downloadConfig.mediaType === "images" ? "仅图片" : moreTask.downloadConfig.mediaType === "videos" ? "仅视频" : "仅 LivePhoto"}</div></div></div>}
          {moreTask.downloadConfig && <div><strong>下载设置：</strong><div style={{display:"grid",gap:5,marginTop:6}}><div>下载目录：{moreTask.downloadConfig.downloadDir}</div><div>修改创建日期：{moreTask.downloadConfig.modifyFileTime ? "开启" : "关闭"}</div><div>文件夹模板：{moreTask.downloadConfig.folderTemplate}</div><div>文件名模板：{moreTask.downloadConfig.fileTemplate}</div></div></div>}
          {moreTask.downloadResults && moreTask.downloadResults.length > 0 && <div><strong>执行结果：</strong><div style={{marginTop:6}}>完成：下载 {moreTask.downloadResults.reduce((total, item) => total + item.downloaded, 0)}，跳过 {moreTask.downloadResults.reduce((total, item) => total + item.skipped, 0)}，失败 {moreTask.downloadResults.reduce((total, item) => total + item.failed, 0)}</div></div>}
        </div></div></div>}
            {deleteActionTask && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-action-title"><div className="modal-icon warning">{deleteActionTask.kind === "取消赞" ? <ThumbsDown/> : deleteActionTask.kind === "评论" ? <MessageSquare/> : deleteActionTask.kind === "取关" ? <UserMinus/> : <Trash2/>}</div><h3 id="delete-action-title">{deleteActionTask.state === "失败" ? `确认重试${localBatchLabel(deleteActionTask.kind)}任务` : `确认执行${localBatchLabel(deleteActionTask.kind)}任务`}</h3><p>{deleteActionTask.state === "失败" ? `任务“${deleteActionTask.title}”此前未完整完成。重试时会跳过已确认成功的项目，只处理失败或未处理项目。` : `即将向微博发送真实${localBatchLabel(deleteActionTask.kind)}请求。任务“${deleteActionTask.title}”将逐条执行。`}</p><div className="warning-box">{deleteActionTask.kind === "取消赞" ? "取消点赞不可恢复，需要重新手动点赞才能恢复。" : deleteActionTask.kind === "评论" ? "评论删除不可恢复，删除后无法找回。" : deleteActionTask.kind === "取关" ? "取消关注不可恢复，需要重新搜索并关注该用户才能恢复。" : "微博删除不可恢复，请确认任务内容后继续。"}</div><div className="modal-actions"><button className="button ghost" onClick={() => { setDeleteActionTask(null); setPendingDeleteStartIds([]); }}>取消</button><button className="button danger" onClick={() => void confirmDeleteTask()}>确认执行</button></div></div></div>}
            {showDeleteTasksConfirm && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="delete-tasks-title"><div className="modal-icon warning"><Trash2/></div><h3 id="delete-tasks-title">确认删除任务记录</h3><p>确定删除选中的 {selectedTaskCount} 条任务记录吗？删除任务记录不会撤销已经在微博执行的删除操作。</p><div className="modal-actions"><button className="button ghost" onClick={() => setShowDeleteTasksConfirm(false)}>取消</button><button className="button danger" onClick={() => void removeSelectedTasks()}>确认删除</button></div></div></div>}
    </section>;
    // 设置页面由右侧分区承载；左侧菜单负责切换并定位到对应分区。
    if (page === "settings") return <section className="page-stack settings-page">
      <PageHeading title="设置" />
      <div className="settings-main">
        <section className="panel settings-section" id="settings-general">
          <div className="panel-title"><div><strong>常规设置</strong><span>个性化应用显示与任务行为</span></div></div>
          <Field label="主题"><select value={theme} onChange={e => { const nextTheme = e.target.value as ThemePreference; setTheme(nextTheme); void invoke("save_app_setting", { key: "theme", value: nextTheme }).catch(reason => notify("保存主题失败：" + String(reason))); }}><option value="system">{dark ? "跟随系统（当前为深色）" : "跟随系统（当前为浅色）"}</option><option value="light">浅色</option><option value="dark">深色</option></select></Field>
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
            <div className="variable-grid">{filenameVariables.map((variable: TemplateVariable) => <button type="button" className="variable-chip icon-tooltip" key={variable.token} data-tooltip={variable.description} onMouseDown={e => e.preventDefault()} onClick={() => {
              // 点击变量时追加对应占位符，避免将用户模板格式写死。
              const key = templateTarget === "file" ? "fileTemplate" : "folderTemplate";
              saveFilenameSettings({...filenameSettings, [key]: filenameSettings[key] + variable.token});
            }}><code>{variable.token}</code><span>{variable.label}</span></button>)}</div>
          </div>
        </section>

      </div>
    </section>;
    return <section className="page-stack"><PageHeading title="Cookie 管理" subtitle="扫码登录或导入 Cookie" /><Accounts notify={notify} onCookieDeleted={resetAfterCookieDeleted} onCookieStatusChange={refreshCookieValidity} /></section>;
  };
  // 应用外壳固定视口尺寸，滚动仅交由右侧内容区处理。
  return <div className={dark ? "app-shell dark" : "app-shell"}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><img src="/weibo-logo.svg" alt="" /></div><div><strong>Weibo Manager</strong><span>微博管理工作台</span></div></div><nav>{["概览","微博管理","系统"].map(group => <div className="nav-group" key={group}><div className="nav-group-label">{group}</div>{nav.filter(item => item.group === group).map(item => { const Icon = item.icon; return <React.Fragment key={item.id}><button className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => { if (item.id === "settings") { if (page === "settings" && settingsExpanded) { setSettingsExpanded(false); } else { setPage("settings"); setSettingsExpanded(true); setSettingSection("general"); } } else { setPage(item.id); setSettingsExpanded(false); } }}><Icon size={17}/><span>{item.label}</span>{item.id === "tasks" && <span className="nav-count">{tasks.length}</span>}{item.id === "settings" && <ChevronDown size={14} className={settingsExpanded ? "nav-chevron expanded" : "nav-chevron"}/>}</button>{item.id === "settings" && page === "settings" && settingsExpanded && <div className="settings-subnav"><button className={settingSection === "general" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("general"); setSettingsExpanded(true); document.getElementById("settings-general")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><Settings2 size={14}/>常规设置</button><button className={settingSection === "filename" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("filename"); setSettingsExpanded(true); document.getElementById("settings-filename")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><FileImage size={14}/>文件命名</button></div>}</React.Fragment>; })}</div>)}</nav></aside>
    <main className="main-area"><div className={page === "dashboard" || page === "accounts" ? "content content-centered" : page === "tasks" ? "content task-center-content" : "content"}>{renderPage()}</div></main>
    {toast && <div className="toast"><Check size={17}/>{toast}</div>}
  </div>;
}
function PageHeading({ subtitle, actions }: {title: string; subtitle?: string; actions?: React.ReactNode}) {
  if (!subtitle && !actions) return null;
  return <div className="page-heading"><div>{subtitle ? <p>{subtitle}</p> : null}</div>{actions && <div>{actions}</div>}</div>;
}
function Field({ label, children, className }: {label: string; children: React.ReactNode; className?: string}) { return <label className={className ? `field ${className}` : "field"}><span>{label}</span>{children}</label>; }

// 多选下拉：触发器只读，展开后逐项勾选，已选项按勾选顺序显示在触发器里。
function MultiSelect({ options, selected, onChange, placeholder }: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);
  const label = options.filter(option => selected.includes(option.value)).map(option => option.label).join("、");
  return <div className="multi-select" ref={boxRef}>
    <button type="button" className="multi-select-trigger" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <span className={label ? "" : "placeholder"}>{label || placeholder}</span><ChevronDown size={14}/>
    </button>
    {open && <div className="multi-select-panel">
      {options.length === 0
        ? <span className="muted multi-select-empty">暂无可选分组</span>
        : options.map(option => <label className="multi-select-option" key={option.value}>
            <input type="checkbox" checked={selected.includes(option.value)} onChange={e => onChange(e.target.checked ? [...selected, option.value] : selected.filter(value => value !== option.value))}/>
            <span>{option.label}</span>
          </label>)}
    </div>}
  </div>;
}

// 筛选条件摘要：条件之间用统一间距分隔，冒号统一用中文全角。
function FilterSummary({ items }: { items: [string, string][] }) {
  return <span className="filter-summary">{items.map(([label, value]) => <span key={label}><em>{label}</em>：{value}</span>)}</span>;
}
function Stat({ label, value, icon: Icon, helper }: {label: string; value: string; icon: typeof Home; helper?: string}) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><div className="stat-icon"><Icon size={17}/></div></div><strong>{value}</strong>{helper ? <span className="stat-helper">{helper}</span> : null}</div>; }
function Dashboard({ tasks, go }: {tasks: Task[]; go: (page: Page) => void}) {
  return <section className="page-stack"><PageHeading title="工作台" /><div className="stats-grid four"><Stat label="下载任务" value={String(tasks.filter(t => t.kind === "下载").length)} icon={CloudDownload} /><Stat label="删除任务" value={String(tasks.filter(t => t.kind === "删除").length)} icon={Trash2} /><Stat label="已下载媒体" value={String(tasks.filter(t => t.kind === "下载").reduce((sum, task) => sum + (task.downloadResults ?? []).reduce((userSum, result) => userSum + result.downloaded, 0), 0))} icon={FileImage} /><Stat label="失败任务" value={String(tasks.filter(t => t.state === "失败").length)} icon={CircleHelp} /></div><div className="dashboard-columns"><div className="panel"><div className="panel-title"><div><strong>最近任务</strong></div><button className="text-button" onClick={() => go("tasks")}>全部任务 <ArrowRight size={14}/></button></div><div className="recent-list">{tasks.slice(0, 3).map(task => <div className="recent-row" key={task.id}><div className={task.kind === "下载" ? "recent-icon blue-bg" : task.kind === "取消赞" ? "recent-icon green-bg" : task.kind === "评论" ? "recent-icon purple-bg" : task.kind === "取关" ? "recent-icon neutral-bg" : "recent-icon amber-bg"}>{task.kind === "下载" ? <CloudDownload size={17}/> : task.kind === "取消赞" ? <ThumbsDown size={17}/> : task.kind === "评论" ? <MessageSquare size={17}/> : task.kind === "取关" ? <UserMinus size={17}/> : <Trash2 size={17}/>}</div><div className="recent-info"><strong>{task.title}</strong><span>{task.detail}</span></div><TaskBadge state={task.state}/></div>)}</div></div><div className="panel quick-panel"><div className="panel-title"><div><strong>快捷操作</strong></div></div><button className="quick-action" onClick={() => go("download")}><div className="quick-icon blue-bg"><CloudDownload size={18}/></div><div><strong>下载媒体</strong><span>按用户备份图片和视频</span></div><ArrowRight size={16}/></button><button className="quick-action" onClick={() => go("delete")}><div className="quick-icon amber-bg"><Trash2 size={18}/></div><div><strong>整理微博</strong><span>筛选并预览待删除内容</span></div><ArrowRight size={16}/></button><button className="quick-action" onClick={() => go("accounts")}><div className="quick-icon green-bg"><LockKeyhole size={18}/></div><div><strong>Cookie 管理</strong><span>扫码登录或导入 Cookie</span></div><ArrowRight size={16}/></button></div></div></section>;
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
    // 昵称需要访问微博接口，单独加载，避免网络慢时挡住 Cookie 卡片显示。
    void invoke<WeiboAccount | null>("get_weibo_account")
      .then(savedAccount => setAccount(savedAccount))
      .catch(() => setAccount(null));
    Promise.all([
      invoke<string | null>("get_weibo_cookie"),
      invoke<{ cookieFile: string; windowSizeFile: string }>("get_config_file_names"),
    ]).then(([currentCookie, fileNames]) => {
      setSavedCookie(currentCookie ?? "");
      setConfigFileNames(fileNames);
    }).catch(() => {
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
        <div className="avatar avatar-image">{account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <LockKeyhole size={17}/>}</div>
        <div className="user-info cookie-value"><strong>{account?.screenName || "微博 Cookie"}</strong><span>{showCookie ? savedCookie : "••••••••••••••••"}</span></div>
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
// 判断一条错误文案是否属于“登录态不可用”，各页面据此显示统一的 Cookie 警示横幅。
function isCookieError(message: string) {
  return message.includes("尚未登录微博") || message.includes("Cookie 已失效") || message.includes("Cookie 检测失败");
}

/// 实心暂停图标：lucide 的 Pause 竖条宽 4/24，小字号下偏粗，这里收到 3.2/24 并保持左右对称。
function PauseSolid({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6.6" y="4.6" width="3.2" height="14.8" rx="1" />
      <rect x="14.2" y="4.6" width="3.2" height="14.8" rx="1" />
    </svg>
  );
}

function EmptyState({ title, description }: {title: string; description: string}) { return <div className="empty-state"><div className="empty-icon"><Archive size={22}/></div><strong>{title}</strong><span>{description}</span></div>; }

export default App;