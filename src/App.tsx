import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity, Archive, ArrowDownToLine, ArrowRight, Check, ChevronDown, CircleHelp, Copy,
  Clock3, CloudDownload, Eye, EyeOff, FileImage, FolderOpen, Gauge, Home, Image, ListTodo,
  LockKeyhole, Moon, MoreHorizontal, Play, Plus, RefreshCw, Search, Settings2,
  ShieldCheck, Sun, Trash2, Users, Video, X,
} from "lucide-react";
import {
  buildFilename, buildFolderName, defaultFilenameSettings, filenameVariables,
  type FilenameSettings, type TemplateVariable,
} from "./lib/filenameTemplate";

type Page = "dashboard" | "accounts" | "delete" | "download" | "tasks" | "settings";
type TaskState = "执行中" | "等待中" | "已完成" | "失败" | "已取消";
type Task = { id: number; title: string; kind: "下载" | "删除"; state: TaskState; progress: number; detail: string };
const initialTasks: Task[] = [
  { id: 1, title: "旅行日记 · 媒体采集", kind: "下载", state: "执行中", progress: 68, detail: "已处理 34 / 50 项" },
  { id: 2, title: "2023 年微博清理", kind: "删除", state: "等待中", progress: 0, detail: "模拟任务 · 等待确认" },
  { id: 3, title: "摄影作品备份", kind: "下载", state: "已完成", progress: 100, detail: "共 126 个文件" },
];
const nav: { id: Page; label: string; icon: typeof Home; group: string }[] = [
  { id: "dashboard", label: "工作台", icon: Home, group: "概览" },
  { id: "accounts", label: "账号管理", icon: Users, group: "微博管理" },
  { id: "delete", label: "微博删除", icon: Trash2, group: "微博管理" },
  { id: "download", label: "媒体下载", icon: CloudDownload, group: "微博管理" },
  { id: "tasks", label: "任务中心", icon: ListTodo, group: "系统" },
  { id: "settings", label: "设置", icon: Settings2, group: "系统" },
];
const demoPosts = [
  { date: "2024-08-18", type: "原创", text: "周末散步，记录一些沿途的光影。", media: "图片", checked: true },
  { date: "2024-05-06", type: "转发", text: "分享一组最近很喜欢的城市摄影。", media: "图片", checked: true },
  { date: "2023-12-21", type: "原创", text: "年末整理：一些旅行途中拍下的风景。", media: "视频", checked: false },
  { date: "2023-07-09", type: "原创", text: "今天的天空有很漂亮的云。", media: "无媒体", checked: false },
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
function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [dark, setDark] = useState(false);
  const [query, setQuery] = useState("");
  const [dateFrom, setDateFrom] = useState("2023-01-01");
  const [dateTo, setDateTo] = useState("2024-12-31");
  const [keyword, setKeyword] = useState("");
  const [postChecks, setPostChecks] = useState<boolean[]>(demoPosts.map(p => p.checked));
  const [tasks, setTasks] = useState(initialTasks);
  const [toast, setToast] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [users, setUsers] = useState(["travel_diary", "photo_notes"]);
  const [newUser, setNewUser] = useState("");
  // 文件名与文件夹名模板分别保存；当前阶段只演示模板配置，不执行真实下载。
  const [filenameSettings, setFilenameSettings] = useState<FilenameSettings>(initialFilenameSettings);
  // 左侧设置子菜单与变量插入目标由状态统一驱动。
  const [settingSection, setSettingSection] = useState<"general" | "filename" | "security">("general");
  const [settingsExpanded, setSettingsExpanded] = useState(false);
  const [templateTarget, setTemplateTarget] = useState<"file" | "folder">("file");
  const [downloadPath, setDownloadPath] = useState("~/Downloads/WeiboDownloads");
  const [concurrency, setConcurrency] = useState("3");
  const [requestDelay, setRequestDelay] = useState("1200");
  const [theme, setTheme] = useState("system");
  const filteredPosts = useMemo(() => demoPosts.map((post, i) => ({ ...post, checked: postChecks[i] }))
    .filter(post => post.text.toLowerCase().includes(keyword.toLowerCase()) && post.date >= dateFrom && post.date <= dateTo), [keyword, dateFrom, dateTo, postChecks]);
  // 预览值模拟真实下载时可从用户资料、微博元数据和媒体响应中读取的字段。
  const previewValues = { USER_SCREEN_NAME: "travel_diary", POST_TIME: "2024-08-18 14:30:00", POST_ID: "5078219042", MEDIA_INDEX: "01", EXT: ".jpg" };
  const previewFilename = buildFilename(filenameSettings.fileTemplate, previewValues);
  const previewFoldername = buildFolderName(filenameSettings.folderTemplate, previewValues);
  const selectedCount = filteredPosts.filter(post => post.checked).length;
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };
  const saveFilenameSettings = (next: FilenameSettings) => {
    setFilenameSettings(next);
    localStorage.setItem("wm-filename-settings", JSON.stringify(next));
  };
  const startMockTask = (title: string, kind: Task["kind"]) => {
    const next: Task = { id: Date.now(), title, kind, state: "等待中", progress: 0, detail: "模拟任务 · 尚未连接微博" };
    setTasks(current => [next, ...current]);
    setPage("tasks");
    notify("已创建模拟任务；当前阶段不会访问微博或执行真实操作。");
  };
  const pageTitle = nav.find(item => item.id === page)?.label ?? "工作台";
  const renderPage = () => {
    if (page === "dashboard") return <Dashboard tasks={tasks} go={setPage} />;
    if (page === "accounts") return <Accounts notify={notify} />;
    if (page === "delete") return <section className="page-stack">
      <PageHeading title="微博删除" subtitle="先筛选并预览待处理微博。当前使用模拟数据，不会执行真实删除。" />
      <div className="panel filter-panel">
        <div className="panel-title"><div><strong>筛选条件</strong><span>设置条件后查看匹配结果</span></div><button className="button ghost" onClick={() => { setKeyword(""); setDateFrom("2023-01-01"); setDateTo("2024-12-31"); }}>重置</button></div>
        <div className="filter-grid"><Field label="开始日期"><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></Field><Field label="结束日期"><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></Field><Field label="关键词"><div className="input-icon"><Search size={16}/><input placeholder="搜索微博正文" value={keyword} onChange={e => setKeyword(e.target.value)} /></div></Field><Field label="微博类型"><select><option>全部类型</option><option>原创</option><option>转发</option></select></Field></div>
        <div className="filter-foot"><span><ShieldCheck size={15}/> 预览后确认 · 不可恢复操作</span><span>匹配 {filteredPosts.length} 条</span></div>
      </div>
      <div className="panel">
        <div className="panel-title"><div><strong>待处理微博</strong><span>已选择 {selectedCount} 条（模拟）</span></div><button className="button danger" onClick={() => setShowDeleteConfirm(true)} disabled={!selectedCount}><Trash2 size={15}/> 预览并确认删除</button></div>
        <div className="table-wrap"><table><thead><tr><th><input type="checkbox" checked={postChecks.every(Boolean)} onChange={e => setPostChecks(demoPosts.map(() => e.target.checked))} aria-label="全选微博" /></th><th>微博内容</th><th>发布时间</th><th>类型</th><th>媒体</th></tr></thead><tbody>{filteredPosts.map(post => { const idx = demoPosts.findIndex(p => p.date === post.date); return <tr key={post.date}><td><input type="checkbox" checked={postChecks[idx]} onChange={e => setPostChecks(c => c.map((v, i) => i === idx ? e.target.checked : v))} aria-label="选择微博" /></td><td><div className="post-text">{post.text}</div><small>ID: 50{idx}8219042</small></td><td>{post.date}</td><td><span className="tag neutral">{post.type}</span></td><td>{post.media}</td></tr>; })}</tbody></table>{filteredPosts.length === 0 && <EmptyState title="没有匹配的微博" description="尝试调整时间范围或关键词。" />}</div>
      </div>
      {showDeleteConfirm && <div className="modal-backdrop"><div className="modal"><div className="modal-icon warning"><Trash2/></div><h3>确认删除预览</h3><p>当前选择了 {selectedCount} 条模拟微博。真实删除模块尚未启用，此操作不会删除任何微博。</p><div className="warning-box">微博删除不可恢复。正式版本将在此处要求二次确认。</div><div className="modal-actions"><button className="button ghost" onClick={() => setShowDeleteConfirm(false)}>返回检查</button><button className="button danger" onClick={() => { setShowDeleteConfirm(false); notify("模拟预览完成：未发送任何删除请求。"); }}>确认模拟流程</button></div></div></div>}
    </section>;
    if (page === "download") return <section className="page-stack">
      <PageHeading title="媒体下载" subtitle="按用户与时间范围组织媒体采集任务。当前为模拟流程。" actions={<button className="button primary" onClick={() => startMockTask(`采集 ${users.length} 个用户的媒体`, "下载")}><Plus size={16}/> 创建下载任务</button>} />
      <div className="panel download-user-panel">
        <div className="panel-title"><div><strong>目标用户队列</strong><span>支持添加多个用户并排队</span></div><span className="tag blue">{users.length} 个用户</span></div>
        <div className="add-user-row"><div className="input-icon"><Users size={16}/><input placeholder="微博主页链接或用户标识" value={newUser} onChange={e => setNewUser(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && newUser.trim()) { setUsers(u => [...u, newUser.trim()]); setNewUser(""); } }} /></div><button className="button secondary" onClick={() => { if (newUser.trim()) { setUsers(u => [...u, newUser.trim()]); setNewUser(""); } }}><Plus size={15}/> 添加用户</button></div>
        <div className="user-list">{users.map((user, i) => <div className="user-row" key={user + i}><div className="avatar">{user.slice(0, 1).toUpperCase()}</div><div className="user-info"><strong>{user}</strong><span>待采集 · 模拟目标用户</span></div><span className="tag neutral">队列 {i + 1}</span><button className="icon-button" aria-label="移除用户" onClick={() => setUsers(u => u.filter((_, index) => index !== i))}><X size={16}/></button></div>)}</div>
        <div className="divider-line"/><div className="form-grid"><Field label="开始日期"><input type="date" defaultValue="2020-01-01"/></Field><Field label="结束日期"><input type="date" defaultValue="2024-12-31"/></Field><Field label="媒体类型"><select defaultValue="all"><option value="all">图片、视频、LivePhoto</option><option>仅图片</option><option>仅视频</option><option>仅 LivePhoto</option></select></Field><Field label="下载目录"><div className="input-with-button"><input value={downloadPath} onChange={e => setDownloadPath(e.target.value)}/><button className="icon-button" onClick={() => notify("目录选择器将在桌面运行环境接入。")} aria-label="选择目录"><FolderOpen size={16}/></button></div></Field></div>
      </div>
      <div className="stats-grid three"><Stat label="待处理用户" value={String(users.length)} icon={Users}/><Stat label="发现媒体" value="—" icon={Image} helper="等待真实采集模块"/><Stat label="下载完成" value="—" icon={Check} helper="当前为模拟数据"/></div>
    </section>;
    if (page === "tasks") return <section className="page-stack"><PageHeading title="任务中心" subtitle="集中查看下载与删除任务、执行进度和结果。" actions={<button className="button secondary" onClick={() => notify("当前展示的是本地模拟任务。")}><RefreshCw size={15}/> 刷新</button>} /><div className="stats-grid four"><Stat label="全部任务" value={String(tasks.length)} icon={ListTodo}/><Stat label="执行中" value={String(tasks.filter(t => t.state === "执行中").length)} icon={Activity}/><Stat label="已完成" value={String(tasks.filter(t => t.state === "已完成").length)} icon={Check}/><Stat label="失败任务" value={String(tasks.filter(t => t.state === "失败").length)} icon={CircleHelp}/></div><div className="panel"><div className="panel-title"><div><strong>所有任务</strong><span>模拟任务状态可用于验收界面交互</span></div><button className="button ghost" onClick={() => setTasks([])}>清空模拟列表</button></div><div className="table-wrap"><table><thead><tr><th>任务</th><th>类型</th><th>状态</th><th>进度</th><th>详情</th><th>操作</th></tr></thead><tbody>{tasks.map(task => <tr key={task.id}><td><strong>{task.title}</strong><small>任务 #{task.id}</small></td><td>{task.kind === "下载" ? <span className="tag blue">下载</span> : <span className="tag amber">删除</span>}</td><td><TaskBadge state={task.state}/></td><td><div className="table-progress"><div className="progress-track"><div style={{width: `${task.progress}%`}}/></div><small>{task.progress}%</small></div></td><td>{task.detail}</td><td><button className="icon-button" aria-label="查看任务详情" onClick={() => notify(`${task.title}：${task.detail}`)}><MoreHorizontal size={17}/></button></td></tr>)}</tbody></table>{tasks.length === 0 && <EmptyState title="暂无任务" description="创建下载或删除模拟任务后会显示在这里。" />}</div></div></section>;
    // 设置页面由右侧分区承载；左侧菜单负责切换并定位到对应分区。
    if (page === "settings") return <section className="page-stack settings-page">
      <PageHeading title="设置" subtitle="管理应用常规行为、下载命名规则与本地数据选项。" />
      <div className="settings-main">
        <section className="panel settings-section" id="settings-general">
          <div className="panel-title"><div><strong>常规设置</strong><span>个性化应用显示与任务行为</span></div></div>
          <Field label="主题"><select value={theme} onChange={e => { setTheme(e.target.value); setDark(e.target.value === "dark"); }}><option value="system">跟随系统（当前预览为浅色）</option><option value="light">浅色</option><option value="dark">深色</option></select></Field>
          <div className="setting-row"><div><strong>任务并发数</strong><span>同时处理的任务数量</span></div><select value={concurrency} onChange={e => setConcurrency(e.target.value)}><option value="1">1 个</option><option value="2">2 个</option><option value="3">3 个</option><option value="5">5 个</option></select></div>
          <div className="setting-row"><div><strong>请求间隔</strong><span>模拟请求间的等待时间</span></div><select value={requestDelay} onChange={e => setRequestDelay(e.target.value)}><option value="800">800 毫秒</option><option value="1200">1200 毫秒</option><option value="2000">2000 毫秒</option><option value="3000">3000 毫秒</option></select></div>
        </section>
        <section className="panel settings-section" id="settings-filename">
          <div className="panel-title"><div><strong>文件与文件夹命名</strong><span>直接编辑占位符模板；点击变量可插入到当前选中的模板输入框</span></div><span className="tag blue">模板化</span></div>
          <div className="template-field">
            <Field label="下载文件夹命名模板">
              <input value={filenameSettings.folderTemplate} onFocus={() => setTemplateTarget("folder")} onChange={e => saveFilenameSettings({...filenameSettings, folderTemplate: e.target.value})} placeholder="%USER_SCREEN_NAME%" />
            </Field>
            <Field label="下载文件名模板">
              <input value={filenameSettings.fileTemplate} onFocus={() => setTemplateTarget("file")} onChange={e => saveFilenameSettings({...filenameSettings, fileTemplate: e.target.value})} placeholder="%USER_SCREEN_NAME% [%POST_TIME%] %POST_ID%_%MEDIA_INDEX%%EXT%" />
            </Field>
            <p className="template-help">示例：%USER_SCREEN_NAME% [%POST_TIME%] %POST_ID%_%MEDIA_INDEX%%EXT%</p>
          </div>
          <div className="variable-picker">
            <div className="variable-picker-heading"><strong>可用变量</strong><span>当前插入目标：{templateTarget === "file" ? "文件名模板" : "文件夹模板"}</span></div>
            <div className="variable-grid">{filenameVariables.map((variable: TemplateVariable) => <button type="button" className="variable-chip" key={variable.token} title={variable.description} onMouseDown={e => e.preventDefault()} onClick={() => {
              // 点击变量时追加对应占位符，避免将用户模板格式写死。
              const key = templateTarget === "file" ? "fileTemplate" : "folderTemplate";
              saveFilenameSettings({...filenameSettings, [key]: filenameSettings[key] + variable.token});
            }}><code>{variable.token}</code><span>{variable.label}</span></button>)}</div>
          </div>
          <div className="filename-preview"><span>文件夹名称预览</span><div><FolderOpen size={18}/><code>{previewFoldername}</code></div></div>
          <div className="filename-preview"><span>文件名预览</span><div><FileImage size={18}/><code>{previewFilename}</code><button className="icon-button" aria-label="复制文件名预览" onClick={() => { void navigator.clipboard?.writeText(previewFilename); notify("文件名预览已复制（如果系统允许剪贴板访问）。"); }}><ArrowRight size={16}/></button></div></div>
          <div className="inline-note"><CircleHelp size={16}/> 非法字符会被安全替换；媒体索引、发布时间和扩展名在真实下载模块接入后由媒体元数据填充。当前阶段仅预览，不会下载文件。</div>
        </section>
        <section className="panel settings-section" id="settings-security">
          <div className="panel-title"><div><strong>安全与数据</strong><span>本地下载目录与数据行为</span></div></div>
          <Field label="下载根目录"><div className="input-with-button"><input value={downloadPath} onChange={e => setDownloadPath(e.target.value)}/><button className="button secondary" onClick={() => notify("目录选择器将在桌面运行环境接入。")}><FolderOpen size={15}/> 选择目录</button></div></Field>
          <p className="muted small">所有下载文件将直接放入由文件夹模板生成的用户文件夹，不再创建 img、live、video 等媒体类型子目录。窗口尺寸会在调整时自动保存；下次启动恢复尺寸，窗口位置每次默认居中。</p>
        </section>
      </div>
    </section>;
    return <section className="page-stack"><PageHeading title="账号管理" subtitle="管理微博会话。当前阶段仅演示交互，不连接微博。" /><Accounts notify={notify}/></section>;
  };
  // 应用外壳固定视口尺寸，滚动仅交由右侧内容区处理。
  return <div className={dark ? "app-shell dark" : "app-shell"}>
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><img src="/weibo-logo.svg" alt="" /></div><div><strong>Weibo Manager</strong><span>微博管理工作台</span></div></div><nav>{["概览","微博管理","系统"].map(group => <div className="nav-group" key={group}><div className="nav-group-label">{group}</div>{nav.filter(item => item.group === group).map(item => { const Icon = item.icon; return <React.Fragment key={item.id}><button className={page === item.id ? "nav-item active" : "nav-item"} onClick={() => { if (item.id === "settings") { if (page === "settings" && settingsExpanded) { setSettingsExpanded(false); } else { setPage("settings"); setSettingsExpanded(true); setSettingSection("general"); } } else { setPage(item.id); setSettingsExpanded(false); } }}><Icon size={17}/><span>{item.label}</span>{item.id === "tasks" && <span className="nav-count">{tasks.length}</span>}{item.id === "settings" && <ChevronDown size={14} className={settingsExpanded ? "nav-chevron expanded" : "nav-chevron"}/>}</button>{item.id === "settings" && page === "settings" && settingsExpanded && <div className="settings-subnav"><button className={settingSection === "general" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("general"); setSettingsExpanded(true); document.getElementById("settings-general")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><Settings2 size={14}/>常规设置</button><button className={settingSection === "filename" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("filename"); setSettingsExpanded(true); document.getElementById("settings-filename")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><FileImage size={14}/>文件命名</button><button className={settingSection === "security" ? "settings-subnav-item active" : "settings-subnav-item"} onClick={() => { setSettingSection("security"); setSettingsExpanded(true); document.getElementById("settings-security")?.scrollIntoView({behavior:"smooth",block:"start"}); }}><ShieldCheck size={14}/>安全与数据</button></div>}</React.Fragment>; })}</div>)}</nav><div className="sidebar-bottom"><div className="version">WEIBO MANAGER <span>v0.1.0 · 阶段 1</span></div></div></aside>
    <main className="main-area"><header className="topbar"><div className="breadcrumbs"><span>Weibo Manager</span><span className="crumb-slash">/</span><strong>{pageTitle}</strong></div></header><div className="content">{renderPage()}</div></main>
    {toast && <div className="toast"><Check size={17}/>{toast}</div>}
  </div>;
}
function PageHeading({ title, subtitle, actions }: {title: string; subtitle: string; actions?: React.ReactNode}) {
  return <div className="page-heading"><div><div className="eyebrow">WEIBO MANAGER</div><h1>{title}</h1><p>{subtitle}</p></div>{actions && <div>{actions}</div>}</div>;
}
function Field({ label, children }: {label: string; children: React.ReactNode}) { return <label className="field"><span>{label}</span>{children}</label>; }
function Stat({ label, value, icon: Icon, helper }: {label: string; value: string; icon: typeof Home; helper?: string}) { return <div className="stat-card"><div className="stat-top"><span>{label}</span><div className="stat-icon"><Icon size={17}/></div></div><strong>{value}</strong><span className="stat-helper">{helper ?? "较上次更新 —"}</span></div>; }
function Dashboard({ tasks, go }: {tasks: Task[]; go: (page: Page) => void}) {
  return <section className="page-stack"><PageHeading title="工作台" subtitle="微博管理任务概览，快速进入常用功能。" actions={<span className="date-chip"><Clock3 size={15}/> 本地工作区</span>}/><div className="stats-grid four"><Stat label="已连接账号" value="0" icon={Users} helper="完成登录后显示"/><Stat label="下载任务" value={String(tasks.filter(t => t.kind === "下载").length)} icon={CloudDownload} helper="包含历史模拟任务"/><Stat label="删除任务" value={String(tasks.filter(t => t.kind === "删除").length)} icon={Trash2} helper="真实删除尚未启用"/><Stat label="已下载媒体" value="126" icon={FileImage} helper="模拟统计数据"/></div><div className="dashboard-columns"><div className="panel"><div className="panel-title"><div><strong>最近任务</strong><span>查看下载与删除的最新进展</span></div><button className="text-button" onClick={() => go("tasks")}>全部任务 <ArrowRight size={14}/></button></div><div className="recent-list">{tasks.slice(0, 3).map(task => <div className="recent-row" key={task.id}><div className={task.kind === "下载" ? "recent-icon blue-bg" : "recent-icon amber-bg"}>{task.kind === "下载" ? <CloudDownload size={17}/> : <Trash2 size={17}/>}</div><div className="recent-info"><strong>{task.title}</strong><span>{task.detail}</span></div><TaskBadge state={task.state}/></div>)}</div></div><div className="panel quick-panel"><div className="panel-title"><div><strong>快捷操作</strong><span>开始常用工作流</span></div></div><button className="quick-action" onClick={() => go("download")}><div className="quick-icon blue-bg"><CloudDownload size={18}/></div><div><strong>下载媒体</strong><span>按用户备份图片和视频</span></div><ArrowRight size={16}/></button><button className="quick-action" onClick={() => go("delete")}><div className="quick-icon amber-bg"><Trash2 size={18}/></div><div><strong>整理微博</strong><span>筛选并预览待删除内容</span></div><ArrowRight size={16}/></button><button className="quick-action" onClick={() => go("accounts")}><div className="quick-icon green-bg"><Users size={18}/></div><div><strong>管理账号</strong><span>准备账号登录方式</span></div><ArrowRight size={16}/></button></div></div></section>;
}
type WeiboAccount = { uid: string; screenName: string; avatarUrl?: string | null };

function Accounts({ notify }: {notify: (message: string) => void}) {
  const [method, setMethod] = useState<"qr" | "cookie">("qr");
  const [cookie, setCookie] = useState("");
  const [savedCookie, setSavedCookie] = useState("");
  const [showCookie, setShowCookie] = useState(false);
  const [qrState, setQrState] = useState("尚未开始登录");
  const [account, setAccount] = useState<WeiboAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // 仅为用户提供显示/复制功能而读取已保存的 Cookie；不写入日志。
  useEffect(() => {
    Promise.all([
      invoke<WeiboAccount | null>("get_weibo_account"),
      invoke<string | null>("get_weibo_cookie"),
    ]).then(([savedAccount, currentCookie]) => {
      setAccount(savedAccount);
      setSavedCookie(currentCookie ?? "");
    }).catch(() => {
      setAccount(null);
      setSavedCookie("");
    });
  }, []);

  // 登录窗口打开后自动轮询后端；后端只在验证成功时返回账号资料并关闭窗口。
  useEffect(() => {
    if (qrState !== "等待微博扫码登录完成…" || account) return;
    let cancelled = false;
    let timer: number | undefined;
    const pollLogin = async () => {
      try {
        const verified = await invoke<WeiboAccount | null>("check_qr_login");
        if (verified && !cancelled) {
          setAccount(verified);
          setSavedCookie((await invoke<string | null>("get_weibo_cookie")) ?? "");
          setQrState("登录成功");
          setError("");
          return;
        }
      } catch {
        // 自动检测过程中的暂时错误不打断等待；手动验证仍会显示具体原因。
      }
      if (!cancelled) timer = window.setTimeout(pollLogin, 3000);
    };
    timer = window.setTimeout(pollLogin, 1500);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [qrState, account]);

  const startQrLogin = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("start_qr_login");
      setQrState("等待微博扫码登录完成…");
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
      setQrState("登录成功");
      notify("已获取并保存微博 Cookie。");
    } catch (reason) {
      setError(String(reason));
      setQrState("尚未验证成功，请确认扫码已完成");
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
      notify("Cookie 已保存。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setError("");
    try {
      await invoke("logout_weibo");
      setAccount(null);
      setQrState("尚未开始登录");
      setCookie("");
      setSavedCookie("");
      setShowCookie(false);
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

  return <div className="page-stack">
    <div className="panel account-panel">
      <div className="panel-title">
        <div><strong>{account ? "Cookie 已获取" : "获取微博 Cookie"}</strong><span>扫码登录或导入 Cookie；Cookie 会明文保存在本地 Settings.json 中</span></div>
        <span className={`tag ${account ? "green" : "neutral"}`}>{account ? "已保存" : "未获取"}</span>
      </div>
      {account && <div className="connected-account">
        <div className="avatar"><LockKeyhole size={17}/></div>
        <div className="user-info cookie-value"><strong>微博 Cookie</strong><span>{showCookie ? savedCookie : "••••••••••••••••"}</span></div>
        <button className="icon-button" onClick={() => setShowCookie(value => !value)} title={showCookie ? "隐藏 Cookie" : "显示 Cookie"} aria-label={showCookie ? "隐藏 Cookie" : "显示 Cookie"} disabled={!savedCookie}>{showCookie ? <EyeOff size={17}/> : <Eye size={17}/>}</button>
        <button className="icon-button" onClick={copyCookie} disabled={!savedCookie} title="复制 Cookie" aria-label="复制 Cookie"><Copy size={17}/></button>
        <button className="button ghost" onClick={logout} disabled={busy}>退出登录</button>
      </div>}
      <div className="segmented">
        <button className={method === "qr" ? "selected" : ""} onClick={() => { setMethod("qr"); setError(""); }}>扫码登录</button>
        <button className={method === "cookie" ? "selected" : ""} onClick={() => { setMethod("cookie"); setError(""); }}>导入 Cookie</button>
      </div>
      {method === "qr" ? <div className="qr-layout">
        <div className="qr-placeholder"><div className="qr-inner"><div className="qr-corner tl"/><div className="qr-corner tr"/><div className="qr-corner bl"/><div className="qr-pattern">{Array.from({length: 49}, (_, i) => <i key={i} style={{opacity: ((i * 17 + 5) % 11) > 3 ? 1 : .12}}/>)}</div></div><div className="qr-overlay"><LockKeyhole size={20}/></div></div>
        <div className="qr-copy">
          <h3>{qrState}</h3>
          <p>点击下方按钮打开微博官方登录页面。登录完成后，返回此处验证会话；不会仅凭扫码动作判断成功。</p>
          <div className="account-actions">
            <button className="button secondary" onClick={startQrLogin} disabled={busy}><RefreshCw size={15}/> 打开微博扫码登录</button>
            <button className="button primary" onClick={finishQrLogin} disabled={busy}>已登录，验证并获取 Cookie</button>
          </div>
          <div className="security-note"><ShieldCheck size={16}/> Cookie 会明文保存在本地 Settings.json，不会写入应用日志。</div>
        </div>
      </div> : <div className="cookie-import">
        <Field label="微博 Cookie"><textarea rows={5} placeholder="粘贴本人微博登录后的 Cookie 请求头内容" value={cookie} onChange={e => setCookie(e.target.value)} autoComplete="off" /></Field>
        <div className="inline-note"><LockKeyhole size={16}/> Cookie 会明文保存在本地 Settings.json，不会写入应用日志。</div>
        <button className="button primary" onClick={importCookie} disabled={busy}>保存 Cookie</button>
      </div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
    </div>
    <div className="panel">
      <div className="panel-title"><div><strong>Cookie 状态</strong><span>本地保存的微博会话</span></div></div>
      {account ? <div className="connected-account">
        <div className="avatar"><LockKeyhole size={17}/></div>
        <div className="user-info"><strong>Cookie 已获取</strong><span>Cookie 已保存在本地 Settings.json 中</span></div>
        <span className="tag green">已保存</span>
      </div> : <EmptyState title="尚未获取 Cookie" description="使用扫码登录或导入 Cookie 后即可保存到本地。"/>}
    </div>
  </div>;
}
function TaskBadge({ state }: {state: TaskState}) { const cls = state === "已完成" ? "green" : state === "执行中" ? "blue" : state === "失败" ? "red" : state === "等待中" ? "amber" : "neutral"; return <span className={`tag ${cls}`}><span className="tag-dot"/>{state}</span>; }
function EmptyState({ title, description }: {title: string; description: string}) { return <div className="empty-state"><div className="empty-icon"><Archive size={22}/></div><strong>{title}</strong><span>{description}</span></div>; }

export default App;
