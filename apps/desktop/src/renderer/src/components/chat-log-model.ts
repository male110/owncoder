/**
 * ChatLog pure data layer — transform turns into LogBlocks / ChatItems
 * and derive live status text. Kept free of React so it can be unit-tested
 * and benchmarked independently of Virtuoso rendering.
 */
import type { ChatTurnDto } from "../../../preload/index";
import type { LiveEvent } from "../store/chat-store";

export type LogBlock =
  | { kind: "user"; turn: ChatTurnDto }
  | { kind: "assistant"; turn: ChatTurnDto }
  | { kind: "tools"; items: ChatTurnDto[] }
  | { kind: "process"; items: ChatTurnDto[] };

export type ChatItem =
  | { kind: "block"; block: LogBlock; key: string };

export function toolLabel(name?: string): string {
  const TOOL_LABELS: Record<string, string> = {
    read_file: "读取文件",
    write_file: "写入文件",
    apply_patch: "应用补丁",
    search_code: "搜索代码",
    search_symbols: "搜索符号",
    list_dir: "列出目录",
    grep: "搜索文本",
    bash: "运行命令",
    save_plan: "保存计划",
    repo_map: "仓库地图",
  };
  if (!name) return "工具";
  return TOOL_LABELS[name] ?? name;
}

/** Status line for a tool phase (shared by ChatLog derivation). */
export function toolStatusLabel(
  phase: "running" | "done" | "error",
  name?: string,
  args?: Record<string, unknown>,
): string {
  const verb: Record<string, string> = {
    read_file: "读取文件",
    write_file: "写入文件",
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
  };
  const label = (name && verb[name]) || toolLabel(name);
  const pathHint =
    args && typeof args === "object"
      ? (args.path as string) ||
        (args.filePath as string) ||
        (args.query as string) ||
        (args.pattern as string)
      : undefined;
  const tail = pathHint ? ` ${pathHint}` : "";
  if (phase === "running") return `正在${label}${tail}…`;
  if (phase === "error") return `${label}${tail} 失败`;
  return `已${label}${tail}`;
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
    let finalTurn: ChatTurnDto | null = null;

    for (let i = 0; i < round.length; i++) {
      const t = round[i]!;
      if (t.role === "user") continue;
      if (t.role === "tool") {
        process.push(t);
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
    if (e.kind === "thinking" && e.streaming) return "思考中…";
  }
  return "思考中…";
}

export function lastAssistantBlockIndex(blocks: LogBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === "assistant") return i;
  }
  return -1;
}

/** Compose Virtuoso items from committed history blocks only.
 * Live status + thinking/text/tools render outside Virtuoso (shared scroller)
 * so streaming height changes refresh in place (no remount / no stale row). */
export function buildChatItems(blocks: LogBlock[]): ChatItem[] {
  return blocks.map((b, i) => {
    if (b.kind === "user" || b.kind === "assistant") {
      return {
        kind: "block",
        block: b,
        key: b.turn.id ?? `b-${b.kind}-${i}-${b.turn.content.slice(0, 24)}`,
      };
    }
    const first = b.items[0];
    const last = b.items[b.items.length - 1];
    const stable =
      first?.id && last?.id
        ? `${b.kind}-${first.id}-${last.id}-${b.items.length}`
        : `${b.kind}-${i}-${b.items.map((t) => t.toolName ?? t.role).join("|")}`;
    return { kind: "block", block: b, key: stable };
  });
}
