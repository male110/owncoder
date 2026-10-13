import { memo, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: 1 | 2 | 3; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "code"; lang: string; code: string };

function splitFileLine(href: string): { href: string; line?: number } {
  const trimmed = href.trim();
  
  // 匹配末尾的 :数字 格式
  const match = trimmed.match(/^(.+):([1-9]\d*)$/);
  if (!match) {
    return { href: trimmed };
  }
  
  const [, pathPart, lineStr] = match;
  const line = Number(lineStr);
  
  // 验证行号在合理范围内（1 到 1000000）
  if (line < 1 || line > 1000000) {
    return { href: trimmed };
  }
  
  // 仅当路径部分以路径分隔符结尾，或是盘符格式时才认为这是行号
  // 避免文件名本身包含 :数字 时被误判（如 log:2024.txt）
  if (/[/\\]$/.test(pathPart!) || /^[a-z]:[\\/]?/i.test(pathPart!)) {
    return { href: pathPart!, line };
  }
  
  // 如果路径中包含路径分隔符，也认为末尾的 :数字 是行号
  if (/[/\\]/.test(pathPart!)) {
    return { href: pathPart!, line };
  }
  
  // 否则保留原样（如 log:2024.txt）
  return { href: trimmed };
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

function openLink(href: string, onOpenFile?: (path: string, line?: number) => void, workspaceRoot?: string): void {
  if (isLocalFileLink(href) && onOpenFile) {
    const target = splitFileLine(href);
    const path = workspaceLinkPath(target.href, workspaceRoot);
    if (target.line === undefined) onOpenFile(path);
    else onOpenFile(path, target.line);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

function renderLink(
  href: string,
  label: string,
  key: number,
  onOpenFile?: (path: string, line?: number) => void,
  workspaceRoot?: string,
): ReactNode {
  return (
    <a
      key={key}
      href={href}
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

function inlineFormat(text: string, onOpenFile?: (path: string, line?: number) => void, workspaceRoot?: string): ReactNode[] {
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

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
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

    if (line.includes("|") && isTableSeparator(lines[i + 1] ?? "")) {
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

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    const htmlListItem = line.match(/^\s*<li>([\s\S]*?)<\/li>\s*$/i);
    if (htmlListItem) {
      const items: string[] = [];
      while (i < lines.length) {
        const item = (lines[i] ?? "").match(/^\s*<li>([\s\S]*?)<\/li>\s*$/i);
        if (!item) break;
        items.push(item[1]!);
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
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
        /^[-*]\s+/.test(l) ||
        /^\d+\.\s+/.test(l) ||
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
  onOpenFile?: (path: string, line?: number) => void;
  workspaceRoot?: string;
  /** 代码块是否显示复制按钮；思考内容应关闭。默认开启。 */
  showCopy?: boolean;
}

function CodeBlock({ lang, code, showCopy }: { lang: string; code: string; showCopy: boolean }) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();

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

function MarkdownImpl({ content, className, onOpenFile, workspaceRoot, showCopy = true }: Props) {
  const blocks = useMemo(() => parseBlocks(content.trim()), [content]);

  if (!content.trim()) return null;

  return (
    <div className={className ?? "md-body"}>
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
        if (b.kind === "ul") {
          return (
            <ul key={i} className="md-ul">
              {b.items.map((item, j) => (
                <li key={j}>{inlineFormat(item, onOpenFile, workspaceRoot)}</li>
              ))}
            </ul>
          );
        }
        if (b.kind === "ol") {
          return (
            <ol key={i} className="md-ol">
              {b.items.map((item, j) => (
                <li key={j}>{inlineFormat(item, onOpenFile, workspaceRoot)}</li>
              ))}
            </ol>
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
    prev.showCopy === next.showCopy,
);

/** Public API kept as `export function` for stable call sites / type exports. */
export function Markdown({ content, className, onOpenFile, workspaceRoot, showCopy }: Props) {
  return <MarkdownMemo content={content} className={className} onOpenFile={onOpenFile} workspaceRoot={workspaceRoot} showCopy={showCopy} />;
}
