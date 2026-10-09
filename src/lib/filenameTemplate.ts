// 文件命名模板模块：集中声明占位符、默认模板与文件系统安全处理，供设置预览和后续下载逻辑共用。
export interface TemplateValues {
  USER_SCREEN_NAME: string;
  POST_TIME: string;
  POST_ID: string;
  MEDIA_INDEX: string;
  EXT: string;
}

// 模板配置分别管理下载文件名与用户文件夹名。
export interface FilenameSettings {
  fileTemplate: string;
  folderTemplate: string;
}

// 变量说明与占位符集中维护，设置界面通过此表生成可选变量。
export interface TemplateVariable {
  token: `%${string}%`;
  label: string;
  description: string;
}

export const filenameVariables: TemplateVariable[] = [
  { token: "%USER_SCREEN_NAME%", label: "用户名", description: "微博用户昵称或屏幕名称" },
  { token: "%POST_TIME%", label: "发文时间", description: "微博发布时间，格式由元数据格式化逻辑提供" },
  { token: "%POST_ID%", label: "博文 ID", description: "当前微博的唯一标识" },
  { token: "%MEDIA_INDEX%", label: "资源索引", description: "同一条微博内媒体资源的序号，从 1 开始" },
  { token: "%EXT%", label: "媒体扩展名", description: "媒体实际文件扩展名，包含点号，例如 .jpg" },
];

// 默认模板直接体现用户可自由编辑的占位符格式。
export const defaultFilenameSettings: FilenameSettings = {
  fileTemplate: "%USER_SCREEN_NAME% [%POST_TIME%] %POST_ID%_%MEDIA_INDEX%%EXT%",
  folderTemplate: "%USER_SCREEN_NAME%",
};

// 将动态字段和用户输入规范化，避免路径分隔符及 Windows 非法文件名字符进入名称。
export function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180);
}

// 解析模板中的已知占位符；未识别或为空的变量将被移除，不留下 %TOKEN% 原文。
export function renderFilenameTemplate(template: string, values: TemplateValues, fallback: string): string {
  const rendered = template.replace(/%([A-Z_]+)%/g, (placeholder) => {
    const value = values[placeholder.slice(1, -1) as keyof TemplateValues];
    return value == null ? "" : value;
  });
  return sanitizeFilenamePart(rendered) || fallback;
}

// 生成单个媒体文件名，保留模板中的空格、括号和自定义分隔符。
export function buildFilename(template: string, values: TemplateValues): string {
  const filename = renderFilenameTemplate(template, values, "weibo-media");
  return filename === "weibo-media" ? "weibo-media.bin" : filename;
}

// 生成用户下载文件夹名；不附加扩展名，也不按媒体类型拆分子目录。
export function buildFolderName(template: string, values: TemplateValues): string {
  return renderFilenameTemplate(template, values, "weibo-downloads");
}
