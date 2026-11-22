import { memo, useMemo, useState, type ReactNode } from "react";
import type { ActivePlanMetaDto, SpecTaskDocumentDto, TaskItemDto, TaskStatusDto } from "../../../preload/index";
import { t as translate, type MsgId } from "../../../shared/i18n/core";

interface ListItem {
  text: string;
  checked?: boolean;
  sourceLine?: number;
}

// 同时识别任务生成时的复选框和执行后写回的进度标记。
const specCheckbox = /^\s*([-*]|\d+[.、)])\s+\[([ xX/\-])\]\s+(.+)$/;
const unorderedItem = /^[-*]\s+/;
const orderedItem = /^\d+\.\s+/;
const specFence = /^\s*(`{3,}|~{3,})(.*)$/;

function readListItem(line: string, sourceLine: number, spec: boolean, legacyTasks: boolean): { kind: "ul" | "ol"; item: ListItem } | null {
  const checkbox = spec ? line.match(specCheckbox) : null;
  if (checkbox) {
    return {
      kind: /^\d/.test(checkbox[1]!) ? "ol" as const : "ul" as const,
      item: { text: checkbox[3]!.trim(), checked: checkbox[2]!.toLowerCase() === "x", sourceLine },
    };
  }
  const kind = unorderedItem.test(line) ? "ul" : orderedItem.test(line) ? "ol" : null;
  if (!kind) return null;
  const raw = line.replace(kind === "ul" ? unorderedItem : orderedItem, "");
  const legacyCheckbox = legacyTasks ? raw.match(/^\[([ xX])\]\s*(.*)$/) : null;
  return {
    kind,
    item: legacyCheckbox ? { checked: legacyCheckbox[1]!.toLowerCase() === "x", text: legacyCheckbox[2]! } : { text: raw },
  };
}

const statusLabels: Record<TaskStatusDto, MsgId> = {
  pending: "待执行",
  in_progress: "执行中",
  partial: "部分完成",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
};
const taskDone = (status?: TaskStatusDto) => status === "completed" || status === "skipped";

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "ul"; items: ListItem[] }
  | { kind: "ol"; items: ListItem[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "code"; lang: string; code: string };

function splitFileLine(href: string): { href: string; line?: number; column?: number } {
  const trimmed = href.trim();
  const basenameStart = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1;
  const basename = trimmed.slice(basenameStart);
  const separator = basename.indexOf(":");
  if (separator <= 0) return { href: trimmed };

  // 文件名中的原始冒号与位置语法有歧义；仅完整匹配后缀才拆分，字面冒号可写为 %3A。
  const suffix = basename.slice(separator + 1).match(/^([1-9]\d*)(?::([1-9]\d*))?$/);
  if (!suffix) return { href: trimmed };
  const line = Number(suffix[1]);
  const column = suffix[2] === undefined ? undefined : Number(suffix[2]);
  if (!Number.isSafeInteger(line) || line > 1000000) return { href: trimmed };
  if (column !== undefined && (!Number.isSafeInteger(column) || column > 1000000)) return { href: trimmed };

  const pathPart = trimmed.slice(0, basenameStart + separator);
  return column === undefined ? { href: pathPart, line } : { href: pathPart, line, column };
}

function isLocalFileLink(href: string): boolean {
  const value = splitFileLine(href).href;
  return (
    /^\/?[a-z]:[\\/]/i.test(value) ||
    /^file:\/\//i.test(value) ||
    (!/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith("#"))
  );
}

function workspaceLinkPath(href: string, workspaceRoot?: string): string {
  let value = href.trim();
  try {
    if (/^file:\/\//i.test(value)) value = new URL(value).pathname;
    value = decodeURIComponent(value);
  } catch {
    return href;
  }
  if (/^\/[a-z]:[\\/]/i.test(value)) value = value.slice(1);
  value = value.replace(/\\/g, "/");
  const root = workspaceRoot?.replace(/\\/g, "/").replace(/\/$/, "");
  if (root && /^[a-z]:\//i.test(value) && value.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return value.slice(root.length + 1);
  }
  return value;
}

function openLink(href: string, onOpenFile?: (path: string, line?: number, column?: number) => void, workspaceRoot?: string): void {
  if (isLocalFileLink(href) && onOpenFile) {
    const target = splitFileLine(href);
    const path = workspaceLinkPath(target.href, workspaceRoot);
    if (target.line === undefined) onOpenFile(path);
    else onOpenFile(path, target.line, target.column);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function renderLink(
  href: string,
  label: string,
  key: number,
  onOpenFile?: (path: string, line?: number, column?: number) => void,
  workspaceRoot?: string,
): ReactNode {
  const safeHref = href.trim();
  if (/^[a-z][a-z\d+.-]*:/i.test(safeHref) && !/^(https?:|file:|[a-z]:[\\/])/i.test(safeHref)
      && !/\.[^/:]+:[1-9]\d*(?::[1-9]\d*)?$/.test(safeHref)) return label;
  return (
    <a
      key={key}
      href={safeHref}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (!isLocalFileLink(href)) return;
        event.preventDefault();
        openLink(href, onOpenFile, workspaceRoot);
      }}
    >
      {label}
    </a>
  );
}

function inlineFormat(text: string, onOpenFile?: (path: string, line?: number, column?: number) => void, workspaceRoot?: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\)|<a\s+[^>]*\bhref\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>[\s\S]*?<\/a>)/gi;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      parts.push(
        <code key={m.index} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      parts.push(<strong key={m.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      parts.push(<em key={m.index}>{token.slice(1, -1)}</em>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (linkMatch) {
        parts.push(renderLink(linkMatch[2]!, linkMatch[1]!, m.index, onOpenFile, workspaceRoot));
      } else {
        const htmlLinkMatch = token.match(/^<a\s+[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>$/i);
        if (htmlLinkMatch) {
          const label = htmlLinkMatch[3]!;
          parts.push(renderLink(htmlLinkMatch[2]!, label.replace(/^`([^`]+)`$/, "$1"), m.index, onOpenFile, workspaceRoot));
        } else {
          parts.push(token);
        }
      }
    }
    last = m.index + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length ? parts : [text];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const s = line.trim();
  if (!s.includes("-") || !s.includes("|")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s);
}

function parseBlocks(src: string, spec: boolean, legacyTasks: boolean): Block[] {
  const lines = (spec ? src : src.trim()).replace(/\r\n/g, "\n").split("\n");
  const listAt = (index: number) => readListItem(lines[index] ?? "", index + 1, spec, legacyTasks);
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = spec ? line.match(specFence) : null;
    if (fence || line.startsWith("```")) {
      const lang = (fence ? fence[2]! : line.slice(3)).trim();
      const closesFence = (text: string) => {
        if (!fence) return text.startsWith("```");
        const end = text.match(specFence);
        return end && end[1]![0] === fence[1]![0] && end[1]!.length >= fence[1]!.length && !end[2]!.trim();
      };
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      i++;
      continue;
    }

    const hMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (hMatch) {
      blocks.push({
        kind: "h",
        level: hMatch[1]!.length as 1 | 2 | 3,
        text: hMatch[2]!,
      });
      i++;
      continue;
    }

    if (!(spec && specCheckbox.test(line)) && line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
      const headers = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim() !== "") {
        rows.push(splitRow(lines[i] ?? ""));
        i++;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
        quoteLines.push((lines[i] ?? "").replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: quoteLines.join("\n") });
      continue;
    }

    const listItem = listAt(i);
    if (listItem) {
      const kind = listItem.kind;
      const items: ListItem[] = [];
      let entry: ReturnType<typeof listAt> = listItem;
      while (entry?.kind === kind) {
        items.push(entry.item);
        entry = listAt(++i);
      }
      blocks.push({ kind, items });
      continue;
    }

    const htmlListItem = line.match(/^\s*<li>([\s\S]*?)<\/li>\s*$/i);
    if (htmlListItem) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const item = (lines[i] ?? "").match(/^\s*<li>([\s\S]*?)<\/li>\s*$/i);
        if (!item) break;
        items.push({ text: item[1]! });
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (
        l.trim() === "" ||
        l.startsWith("```") ||
        /^(#{1,3})\s+/.test(l) ||
        (spec && specFence.test(l)) ||
        listAt(i) ||
        /^>\s?/.test(l) ||
        (l.includes("|") && isTableSeparator(lines[i + 1] ?? ""))
      ) {
        break;
      }
      paraLines.push(l);
      i++;
    }
    blocks.push({ kind: "p", text: paraLines.join("\n") });
  }

  return blocks;
}

interface Props {
  content: string;
  className?: string;
  onOpenFile?: (path: string, line?: number, column?: number) => void;
  workspaceRoot?: string;
  /** 代码块是否显示复制按钮；思考内容应关闭。默认开启。 */
  showCopy?: boolean;
  taskMeta?: ActivePlanMetaDto | null;
  specTaskDocument?: SpecTaskDocumentDto | null;
  specTasksStale?: boolean;
  tasksDirty?: boolean;
  taskBusy?: boolean;
  onExecuteSpecTasks?: (document: SpecTaskDocumentDto, taskId?: string) => void;
  onExecuteTasks?: () => void;
  onUpdateTask?: (taskId: string, status: TaskStatusDto, document?: SpecTaskDocumentDto) => void;
}

function CodeBlock({ lang, code, showCopy }: { lang: string; code: string; showCopy: boolean }) {
  const [copied, setCopied] = useState(false);
  const t = translate;

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch { /* ignore */ }
  };

  return (
    <div className="md-code-block">
      {(lang || showCopy) ? (
        <div className="md-code-header">
          {lang ? <span className="md-code-lang">{lang}</span> : null}
          {showCopy ? (
            <button
              type="button"
              className="md-code-copy-btn"
              onClick={() => void onCopy()}
              title={copied ? t("已复制") : t("复制代码")}
            >
              {copied ? "✓" : t("复制")}
            </button>
          ) : null}
        </div>
      ) : null}
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

function MarkdownImpl({
  content,
  className,
  onOpenFile,
  workspaceRoot,
  showCopy = true,
  taskMeta,
  specTaskDocument,
  specTasksStale = false,
  tasksDirty = false,
  taskBusy = false,
  onExecuteSpecTasks,
  onExecuteTasks,
  onUpdateTask,
}: Props) {
  const isSpec = Boolean(specTaskDocument);
  const legacyTasks = Boolean(taskMeta && !isSpec);
  const blocks = useMemo(() => parseBlocks(content, isSpec, legacyTasks), [content, isSpec, legacyTasks]);
  const specLiveMeta = !specTasksStale && specTaskDocument && taskMeta && specTaskDocument.path === taskMeta.path
    && specTaskDocument.version === taskMeta.documentDigest && specTaskDocument.approvedAt === taskMeta.approvedAt
    ? taskMeta : null;
  const liveById = new Map(specLiveMeta?.tasks.map((task) => [task.id, task.status]));
  const tasks = specTaskDocument?.tasks.map((task) => ({ ...task, status: liveById.get(task.id) ?? task.status })) ?? taskMeta?.tasks ?? [];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const tasksByLine = new Map(tasks.flatMap((task) => task.sourceLine === undefined ? [] : [[task.sourceLine, task] as const]));
  const dependenciesDone = (task: TaskItemDto) => task.dependsOn.every((id) => taskDone(tasksById.get(id)?.status));
  const canStartSpec = blocks.some((block) => (block.kind === "ul" || block.kind === "ol") && block.items.some((item) => {
    const task = item.sourceLine === undefined ? undefined : tasksByLine.get(item.sourceLine);
    return (task?.status === "pending" || task?.status === "failed") && dependenciesDone(task);
  }));
  const completed = tasks.filter((task) => taskDone(task.status)).length;
  const pct = Math.round(completed / (tasks.length || 1) * 100);
  const actionsDisabled = taskBusy || tasksDirty || specTasksStale;
  const specExecutionDisabled = actionsDisabled || !onExecuteSpecTasks || tasks.some((task) => task.status === "in_progress");
  const currentTaskId = specLiveMeta ? specLiveMeta.currentTaskId : specTaskDocument?.currentTaskId;
  let taskIndex = 0;

  if (!content.trim()) return null;

  return (
    <div className={className ?? "md-body"}>
      {isSpec || tasks.length > 0 ? (
        <section className="md-task-progress" aria-label={translate("任务进度")}>
          <div className="md-task-progress-summary">
            <strong>{(isSpec ? specLiveMeta : taskMeta)?.title || translate("任务进度")}</strong>
            <span>{completed}/{tasks.length}</span>
            <div className="md-task-progress-track" role="progressbar" aria-valuenow={pct} aria-label={translate("任务进度")}>
              <div className="md-task-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            {specTaskDocument ? (
              <button type="button" className="ghost tiny accent" disabled={specExecutionDisabled || !canStartSpec}
                onClick={() => onExecuteSpecTasks?.(specTaskDocument)}>
                {translate("全部执行")}
              </button>
            ) : (
              <button type="button" className="ghost tiny accent" disabled={actionsDisabled || !onExecuteTasks}
                onClick={onExecuteTasks}
                title={tasksDirty ? translate("请先保存任务文档，再开始执行。") : translate("开始执行")}>
                {translate("开始执行")}
              </button>
            )}
          </div>
          {tasksDirty ? <p className="md-task-unsaved" role="status">{translate("任务文档有未保存修改，请先保存后再执行。")}</p> :
            specTasksStale ? <p className="md-task-unsaved" role="status">{translate("任务文档已更改，请重新加载预览。")}</p> : null}
        </section>
      ) : null}
      {blocks.map((b, i) => {
        if (b.kind === "h") {
          // 不显示"任务 X："这类标题
          if (b.text.match(/^任务\s*\d+[：:]/)) {
            return null;
          }
          const Tag = (`h${b.level}` as "h1" | "h2" | "h3");
          return (
            <Tag key={i} className={`md-h md-h${b.level}`}>
              {inlineFormat(b.text, onOpenFile, workspaceRoot)}
            </Tag>
          );
        }
        if (b.kind === "ul" || b.kind === "ol") {
          const List = b.kind === "ul" ? "ul" : "ol";
          return (
            <List key={i} className={b.kind === "ul" ? "md-ul" : "md-ol"}>
              {b.items.map((item, j) => {
                if (item.checked === undefined) return <li key={j}>{inlineFormat(item.text, onOpenFile, workspaceRoot)}</li>;
                const task = isSpec
                  ? (!tasksDirty && !specTasksStale && item.sourceLine !== undefined ? tasksByLine.get(item.sourceLine) : undefined)
                  : tasks[taskIndex++];
                const status = task?.status;
                const checked = status ? taskDone(status) : item.checked;
                const update = onUpdateTask && task && (!isSpec || specTaskDocument?.approvedAt) ? (next: TaskStatusDto) => {
                  if (specTaskDocument) onUpdateTask(task.id, next, specTaskDocument);
                  else onUpdateTask(task.id, next);
                } : undefined;
                const current = Boolean(task && task.id === currentTaskId);
                return (
                  <li key={j} aria-current={current || undefined}
                    className={`md-task-item${status ? ` md-task-item--${status}` : ""}${current ? " md-task-item--current" : ""}`}>
                    <span className={`md-task-checkbox${checked ? " checked" : ""}`} aria-hidden>{checked ? "✓" : "□"}</span>
                    <span className="md-task-item-text">{inlineFormat(item.text, onOpenFile, workspaceRoot)}</span>
                    {status ? <span className={`md-task-status md-task-status--${status}`}>{translate(statusLabels[status])}</span> : null}
                    {specTaskDocument && task && (status === "pending" || status === "failed") ? (
                      <button type="button" className="ghost tiny accent"
                        disabled={specExecutionDisabled || !dependenciesDone(task)}
                        title={!dependenciesDone(task) ? translate("请先完成前置任务") : undefined}
                        onClick={() => onExecuteSpecTasks?.(specTaskDocument, task.id)}>
                        {translate("执行")}
                      </button>
                    ) : null}
                    {update && status === "pending" ? (
                      <button type="button" className="ghost tiny" disabled={actionsDisabled} onClick={() => update("skipped")}>
                        {translate("跳过")}
                      </button>
                    ) : null}
                    {update && (status === "failed" || status === "skipped") ? (
                      <button type="button" className="ghost tiny accent" disabled={actionsDisabled} onClick={() => update("pending")}>
                        {translate("重置")}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </List>
          );
        }
        if (b.kind === "code") {
          return <CodeBlock key={i} lang={b.lang} code={b.code} showCopy={showCopy} />;
        }
        if (b.kind === "quote") {
          return (
            <blockquote key={i} className="md-quote">
              {inlineFormat(b.text, onOpenFile, workspaceRoot)}
            </blockquote>
          );
        }
        if (b.kind === "table") {
          return (
            <div key={i} className="md-table-wrap">
              <table className="md-table">
                <thead>
                  <tr>
                    {b.headers.map((h, j) => (
                      <th key={j}>{inlineFormat(h, onOpenFile, workspaceRoot)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td key={c}>{inlineFormat(cell, onOpenFile, workspaceRoot)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <p key={i} className="md-p">
            {inlineFormat(b.text, onOpenFile, workspaceRoot)}
          </p>
        );
      })}
    </div>
  );
}

const MarkdownMemo = memo(
  MarkdownImpl,
  (prev, next) =>
    prev.content === next.content &&
    prev.className === next.className &&
    prev.onOpenFile === next.onOpenFile &&
    prev.workspaceRoot === next.workspaceRoot &&
    prev.showCopy === next.showCopy &&
    prev.taskMeta === next.taskMeta &&
    prev.specTaskDocument === next.specTaskDocument &&
    prev.specTasksStale === next.specTasksStale &&
    prev.tasksDirty === next.tasksDirty &&
    prev.taskBusy === next.taskBusy &&
    prev.onExecuteSpecTasks === next.onExecuteSpecTasks &&
    prev.onExecuteTasks === next.onExecuteTasks &&
    prev.onUpdateTask === next.onUpdateTask,
);

/** Public API kept as `export function` for stable call sites / type exports. */
export function Markdown(props: Props) {
  return <MarkdownMemo {...props} />;
}
