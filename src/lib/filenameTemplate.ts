export type FilenameToken = "date" | "text" | "weiboId" | "index" | "mediaType";
export interface FilenameSettings {
  tokens: FilenameToken[];
  separator: string;
  extension: string;
}
export const tokenLabels: Record<FilenameToken, string> = {
  date: "发布时间",
  text: "正文摘要",
  weiboId: "微博 ID",
  index: "媒体序号",
  mediaType: "媒体类型",
};
export const defaultFilenameSettings: FilenameSettings = {
  tokens: ["date", "text", "weiboId", "index"],
  separator: "_",
  extension: "jpg",
};
export function sanitizeFilenamePart(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/[. ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
export function buildFilename(
  settings: FilenameSettings,
  values: Record<FilenameToken, string>,
): string {
  const parts = settings.tokens
    .map((token) => sanitizeFilenamePart(values[token] ?? ""))
    .filter(Boolean);
  const base = parts.join(settings.separator || "_") || "weibo-media";
  const extension = sanitizeFilenamePart(settings.extension.replace(/^\./, "")) || "bin";
  return `${base}.${extension}`;
}