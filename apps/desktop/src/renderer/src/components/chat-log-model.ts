/**
 * ChatLog pure data layer — transform turns into LogBlocks / ChatItems
 * and derive live status text. Kept free of React so it can be unit-tested
 * and benchmarked independently of Virtuoso rendering.
 */
import type { ChatTurnDto } from "../../../preload/index";
import type { LiveEvent } from "../store/chat-store";
import { t, type MsgId } from "../../../shared/i18n/core";

export type LogBlock =
  | { kind: "user"; turn: ChatTurnDto }
  | { kind: "assistant"; turn: ChatTurnDto }
  | { kind: "tools"; items: ChatTurnDto[] }
  | { kind: "process"; items: ChatTurnDto[] };

export type ChatItem =
  | { kind: "block"; block: LogBlock; key: string };

const TOOL_LABELS: Record<string, MsgId> = {
  read_file: "读取文件",
  read_symbol: "读取符号",
  read_outline: "读取大纲",
  write_file: "写入文件",
  append_file: "追加文件",
  apply_patch: "应用补丁",
  search_code: "搜索代码",
  search_symbols: "搜索符号",
  graph_search: "图搜索",
  codemap_search: "代码地图搜索",
  codemap_impact: "影响分析",
  list_dir: "列出目录",
  grep: "搜索文本",
  bash: "运行命令",
  save_plan: "保存计划",
  repo_map: "仓库地图",
  git_status: "Git 状态",
  project_deps: "项目依赖",
  type_check: "类型检查",
  web_search: "网页搜索",
  web_fetch: "获取网页",
  semantic_diff: "语义差异",
  ask_user: "询问用户",
  save_memory: "保存记忆",
  update_memory: "更新记忆",
  forget_memory: "删除记忆",
  list_memories: "列出记忆",
  list_session_changes: "会话变更",
  undo_session_change: "撤销变更",
  lsp_go_to_definition: "跳转定义",
  lsp_find_references: "查找引用",
  lsp_hover: "悬停信息",
  lsp_document_symbols: "文档符号",
  lsp_workspace_symbols: "工作区符号",
  lsp_diagnostics: "LSP 诊断",
  lsp_code_actions: "代码操作",
  save_experience: "保存经验",
  save_spec: "保存规格",
  save_design: "保存设计",
  list_sdd: "列出 SDD",
  analyze_issue: "分析问题",
  report_blocker: "报告阻塞",
};

export function toolLabel(name?: string): string {
  if (!name) return t("工具");
  const id = TOOL_LABELS[name];
  return id ? t(id) : name;
}

/** Status line for a tool phase (shared by ChatLog derivation). */
export function toolStatusLabel(
  phase: "running" | "done" | "error",
  name?: string,
  args?: Record<string, unknown>,
): string {
  const verb: Record<string, MsgId> = {
    read_file: "读取文件",
    read_symbol: "读取符号",
    read_outline: "读取大纲",
    write_file: "写入文件",
    append_file: "追加文件",
    apply_patch: "编辑文件",
    search_code: "搜索代码",
    search_symbols: "搜索符号",
    list_dir: "列出目录",
    grep: "搜索文本",
    bash: "运行命令",
    save_plan: "保存计划",
    repo_map: "生成仓库地图",
    git_status: "查看 Git 状态",
    type_check: "类型检查",
    ask_user: "询问用户",
    save_memory: "保存记忆",
    lsp_diagnostics: "检查 LSP 诊断",
  };
  const label = name && verb[name] ? t(verb[name]) : toolLabel(name);
  const pathHint =
    args && typeof args === "object"
      ? (args.path as string) ||
        (args.filePath as string) ||
        (args.query as string) ||
        (args.pattern as string)
      : undefined;
  const tail = pathHint ? ` ${pathHint}` : "";
  if (phase === "running") return t("正在{{label}}{{tail}}…", { label, tail });
  if (phase === "error") return t("{{label}}{{tail}} 失败", { label, tail });
  return t("已{{label}}{{tail}}", { label, tail });
}

/** Data transform: ChatTurnDto[] → LogBlock[] (rounds / collapse). */
export function buildLogBlocks(
  turns: ChatTurnDto[],
  sending: boolean,
  liveEventCount: number,
): LogBlock[] {
  const out: LogBlock[] = [];

  const isPlanNotice = (t: ChatTurnDto) =>
    t.role === "assistant" && t.content.includes("<!--plan_saved:");

  const rounds: ChatTurnDto[][] = [];
  for (const t of turns) {
    if (t.role === "user" || rounds.length === 0) rounds.push([]);
    rounds[rounds.length - 1]!.push(t);
  }

  const lastRoundActive = sending || liveEventCount > 0;

  rounds.forEach((round, ri) => {
    const active = ri === rounds.length - 1 && lastRoundActive;

    let finalIdx = -1;
    for (let i = 0; i < round.length; i++) {
      const t = round[i]!;
      if (
        t.role === "assistant" &&
        t.content.trim() &&
        !t.content.startsWith("Error:") &&
        !isPlanNotice(t)
      ) {
        finalIdx = i;
      }
    }

    if (active || finalIdx < 0) {
      for (const t of round) {
        if (t.role === "user") {
          out.push({ kind: "user", turn: t });
        } else if (t.role === "assistant") {
          if (t.content.startsWith("Error:")) continue;
          if (!t.content.trim()) continue;
          out.push({ kind: "assistant", turn: t });
        } else if (t.role === "tool") {
          const last = out[out.length - 1];
          if (last?.kind === "tools") last.items.push(t);
          else out.push({ kind: "tools", items: [t] });
        }
      }
      return;
    }

    const userTurn = round.find((t) => t.role === "user");
    const process: ChatTurnDto[] = [];
    const planNotices: ChatTurnDto[] = [];
    const toolArgsById = new Map<string, Record<string, unknown>>();
    for (const t of round) {
      for (const part of t.parts ?? []) {
        if (part.type === "tool_use") toolArgsById.set(part.id, part.input);
      }
    }
    let finalTurn: ChatTurnDto | null = null;

    for (let i = 0; i < round.length; i++) {
      const t = round[i]!;
      if (t.role === "user") continue;
      if (t.role === "tool") {
        const toolArgs = t.id ? toolArgsById.get(t.id) : undefined;
        // 后备：如果没有从 parts 中找到，使用 turn 自带的 toolArgs（历史数据）
        const finalArgs = toolArgs ?? t.toolArgs;
        process.push(finalArgs ? { ...t, toolArgs: finalArgs } : t);
        continue;
      }
      if (t.content.startsWith("Error:") || !t.content.trim()) continue;
      if (isPlanNotice(t)) {
        planNotices.push(t);
        continue;
      }
      if (i === finalIdx) {
        finalTurn = t;
        continue;
      }
      process.push(t);
    }

    if (userTurn) out.push({ kind: "user", turn: userTurn });
    if (process.length > 0) out.push({ kind: "process", items: process });
    if (finalTurn) out.push({ kind: "assistant", turn: finalTurn });
    for (const p of planNotices) out.push({ kind: "assistant", turn: p });
  });

  return out;
}

/** State derivation: concise status label from liveStatus / liveEvents. */
export function deriveLiveStatus(
  sending: boolean,
  liveStatus: string,
  liveEvents: LiveEvent[],
): string {
  if (liveStatus) return liveStatus;
  if (!sending) return "";
  for (let i = liveEvents.length - 1; i >= 0; i--) {
    const e = liveEvents[i]!;
    if (e.kind === "tool" && e.tool.status === "running") {
      return toolStatusLabel("running", e.tool.name, e.tool.args);
    }
  }
  for (let i = liveEvents.length - 1; i >= 0; i--) {
    const e = liveEvents[i]!;
    if (e.kind === "thinking" && e.streaming) return t("思考中…");
  }
  return t("思考中…");
}

export function lastAssistantBlockIndex(blocks: LogBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === "assistant") return i;
  }
  return -1;
}

/** Compose Virtuoso items from committed history blocks only.
 * Live status + thinking/text/tools render outside Virtuoso (shared scroller)
 * so streaming height changes refresh in place (no remount / no stale row).
 * tools（进行中轮次的工具链）不进列表，避免与 LiveToolCard/liveStatus 重复；
 * process（已完成轮次的过程步骤）以可展开的折叠控件进入列表，供用户回看过程。 */
export function buildChatItems(blocks: LogBlock[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (b.kind === "tools") continue;
    const key =
      b.kind === "process"
        ? `b-process-${i}-${b.items[0]?.id ?? b.items.length}`
        : b.turn.id ?? `b-${b.kind}-${i}-${b.turn.content.slice(0, 24)}`;
    items.push({ kind: "block", block: b, key });
  }
  return items;
}
