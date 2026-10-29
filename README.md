# Weibo Manager

跨平台微博管理桌面应用，采用 Tauri 2、React、TypeScript、Rust 与 SQLite。

## 阶段 1

当前分支包含完整界面与模拟业务流程：工作台、账号管理、微博删除、媒体下载、任务中心、设置。当前阶段不会发起真实微博请求。

- 窗口尺寸在桌面端调整后保存；下次启动恢复尺寸，窗口位置默认居中且不保存。
- 文件命名通过独立参数模块配置，可组合日期、正文摘要、微博 ID、媒体序号、媒体类型，并预览结果。
- 本地 SQLite 基础表由 Rust 启动时初始化。

## 构建

GitHub Actions 支持 `develop` 和 `master` 分支 push 自动构建，也支持手动运行。构建目标为 Windows x64、macOS Apple Silicon 和 macOS Intel。构建产物以 Actions Artifacts 形式提供。

## 安全边界

阶段 1 仅使用模拟数据；扫码登录、Cookie 验证、真实删除和真实媒体下载将在后续阶段接入。
