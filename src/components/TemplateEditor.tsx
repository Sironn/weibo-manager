import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { filenameVariables } from "../lib/filenameTemplate";

export type TemplateEditorHandle = {
  /// 在光标处插入变量芯片；光标不在编辑器内时追加到末尾。
  insertToken: (token: string) => void;
};

type TemplateEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onFocus?: () => void;
  placeholder?: string;
  ariaLabel: string;
};

// 已知变量 token → 芯片上显示的中文名；未知占位符按普通文本处理，避免误判用户手写内容。
const labelByToken = new Map<string, string>(filenameVariables.map(variable => [variable.token, variable.label]));

type TemplateSegment = { kind: "text"; text: string } | { kind: "token"; token: string };

function parseTemplate(value: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  const pattern = /%[A-Z_]+%/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const token = match[0];
    if (!labelByToken.has(token)) continue;
    if (match.index > cursor) segments.push({ kind: "text", text: value.slice(cursor, match.index) });
    segments.push({ kind: "token", token });
    cursor = match.index + token.length;
  }
  if (cursor < value.length) segments.push({ kind: "text", text: value.slice(cursor) });
  return segments;
}

function createChip(token: string): HTMLSpanElement {
  const chip = document.createElement("span");
  // 复用全局 .icon-tooltip 悬停提示，鼠标移上去显示原始 %TOKEN%。
  chip.className = "template-chip icon-tooltip";
  chip.contentEditable = "false";
  chip.dataset.token = token;
  chip.dataset.tooltip = token;
  chip.textContent = labelByToken.get(token) ?? token;
  return chip;
}

// 把编辑区还原成模板字符串：芯片取回原始占位符，其余节点拼回文本。
function serializeTemplate(root: HTMLElement): string {
  let result = "";
  root.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) result += node.textContent ?? "";
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (element.dataset.token) result += element.dataset.token;
      else if (element.tagName === "BR") result += " ";
      else result += serializeTemplate(element);
    }
  });
  return result;
}

function renderTemplate(root: HTMLElement, value: string) {
  root.textContent = "";
  for (const segment of parseTemplate(value)) {
    root.appendChild(segment.kind === "token" ? createChip(segment.token) : document.createTextNode(segment.text));
  }
}

/// 模板编辑器：把预设变量渲染成芯片，用户手打的文字保持普通文本，内部始终以 %TOKEN% 字符串对外。
const TemplateEditor = forwardRef<TemplateEditorHandle, TemplateEditorProps>(function TemplateEditor(
  { value, onChange, onFocus, placeholder, ariaLabel },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  // 最近一次写入 DOM 的模板；用于区分「自己输入引发的变化」与「外部重置」，避免重建 DOM 打断光标和输入法。
  const renderedValue = useRef<string | null>(null);

  const commit = () => {
    const root = rootRef.current;
    if (!root) return;
    const next = serializeTemplate(root);
    renderedValue.current = next;
    onChange(next);
  };

  useImperativeHandle(ref, () => ({
    insertToken: (token: string) => {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      const selection = window.getSelection();
      let range: Range | null = null;
      if (selection && selection.rangeCount > 0) {
        const candidate = selection.getRangeAt(0);
        if (root.contains(candidate.commonAncestorContainer)) range = candidate;
      }
      if (!range) {
        range = document.createRange();
        range.selectNodeContents(root);
        range.collapse(false);
      }
      range.deleteContents();
      const chip = createChip(token);
      range.insertNode(chip);
      const after = document.createRange();
      after.setStartAfter(chip);
      after.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(after);
      commit();
    },
  }));

  useEffect(() => {
    const root = rootRef.current;
    if (!root || renderedValue.current === value) return;
    renderTemplate(root, value);
    renderedValue.current = value;
  }, [value]);

  return (
    <div
      ref={rootRef}
      className="template-editor"
      role="textbox"
      aria-label={ariaLabel}
      aria-multiline="false"
      contentEditable
      suppressContentEditableWarning
      data-placeholder={placeholder}
      onFocus={onFocus}
      onInput={commit}
      onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }}
      onPaste={event => {
        event.preventDefault();
        const text = event.clipboardData.getData("text/plain").replace(/[\r\n]+/g, " ");
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        commit();
      }}
    />
  );
});

export default TemplateEditor;
