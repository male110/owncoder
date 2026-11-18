/**
 * 生成文件链接展示：本轮成功写入的文件在最终回复末尾统一列出可点击链接，
 * 用户无需手动找路径即可点击查看与审核。相对路径链接由前端 Markdown 的
 * onOpenFile 打开（见 Markdown-links.test.ts），沿用同一链接惯例。
 */

/** 会写入文件的工具（其结果首行携带落盘路径）。 */
const FILE_WRITE_TOOLS = new Set([
  "write_file",
  "append_file",
  "apply_patch",
  "save_plan",
  "save_spec",
  "save_design",
  "save_tasks",
  "save_experience",
]);

/** 各写文件工具结果首行中的路径模式，按工具输出格式逐一匹配。 */
const PATH_PATTERNS: readonly RegExp[] = [
  /^(?:Wrote|Patched|Appended(?:\s+to)?)\s+([^\s(]+)/i,
  /^Saved plan:\s*([^\s(]+)/i,
  /^(?:Spec|Design|Tasks|Experience)\s+saved to\s+([^\s(]+)/i,
];

interface ToolTurnLike {
  role?: string;
  toolName?: string;
  content?: string;
}

/**
 * 从本轮工具结果中提取成功落盘的文件路径（保持出现顺序、去重）。
 * 失败结果（"Error: " 前缀）不产生链接，避免展示失效路径。
 */
export function collectGeneratedFiles(turns: readonly ToolTurnLike[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const turn of turns) {
    if (turn.role !== "tool" || !turn.toolName || !turn.content) continue;
    if (!FILE_WRITE_TOOLS.has(turn.toolName)) continue;
    const content = turn.content;
    if (content.startsWith("Error:")) continue;
    for (const pattern of PATH_PATTERNS) {
      const matched = content.match(pattern)?.[1];
      if (!matched) continue;
      const path = matched.replace(/[.,;:]+$/, "").replace(/\\/g, "/");
      if (path && !seen.has(path)) {
        seen.add(path);
        out.push(path);
      }
      break;
    }
  }
  return out;
}

/** 生成文件链接块（Markdown）。无文件时返回空串，调用方不追加空列表。 */
export function formatGeneratedFileLinks(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const lines = paths.map((p) => {
    const normalized = p.replace(/\\/g, "/");
    const label = normalized.split("/").pop() || normalized;
    return `- [${label}](${p})`;
  });
  return `### 📄 生成文件\n${lines.join("\n")}`;
}

const PLAN_MARKER = "\n\n<!--plan_saved:";

/**
 * 把链接块追加到回复文本末尾；若文本带 plan_saved 标记（渲染端会剥离），
 * 链接块插到标记之前，避免被 stripPlanMarker 一并裁掉。
 */
export function appendGeneratedFileLinks(text: string, linksBlock: string): string {
  if (!linksBlock || text.includes(linksBlock)) return text;
  const idx = text.lastIndexOf(PLAN_MARKER);
  if (idx < 0) return text.trim() ? `${text}\n\n${linksBlock}` : linksBlock;
  return `${text.slice(0, idx).trimEnd()}\n\n${linksBlock}${text.slice(idx)}`;
}
