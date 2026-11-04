import type { ChatTurn } from "./harness/loop.ts";

export interface CompactHistoryOptions {
  /** 保留最近多少条不参与压缩。 */
  recentWindow: number;
  /** 超过该字节数（UTF-16 字符数 × 2）才触发压缩。 */
  budgetBytes: number;
  /** 写入 metadata.compressionReason。 */
  reason: "manual" | "auto";
}

export interface CompactHistoryOutcome {
  /** 压缩后的历史（未触发压缩时原样返回）。 */
  history: ChatTurn[];
  compacted: boolean;
  /** 被折叠进摘要的旧轮次数。 */
  oldCount: number;
}

/**
 * 就地压缩 runtime 历史：保留最近 recentWindow 条，把更早的轮次折叠成一条
 * 摘要 system 消息；若压缩后仍超预算，再从最旧的保留轮次开始丢弃。
 * compactNow（手动 /compact）与每轮结束的 auto-compact 共用本函数。
 */
export function compactHistory(history: ChatTurn[], opts: CompactHistoryOptions): CompactHistoryOutcome {
  const size = (turn: ChatTurn) => turn.content.length * 2;
  let total = history.reduce((n, turn) => n + size(turn), 0);
  if (total <= opts.budgetBytes || history.length <= opts.recentWindow) {
    return { history, compacted: false, oldCount: 0 };
  }
  const keepFrom = Math.max(0, history.length - opts.recentWindow);
  const old = history.slice(0, keepFrom);
  const summary = old.map((turn) => `${turn.role}: ${turn.content.slice(0, 240)}`).join("\n").slice(0, 16 * 1024);
  const compacted: ChatTurn = {
    role: "system",
    content: `[历史摘要，共 ${old.length} 条，原始内容已压缩]\n${summary}`,
    metadata: { isCompressed: true, originalLength: old.length, compressedAt: new Date().toISOString(), compressionReason: opts.reason },
  };
  const next = [compacted, ...history.slice(keepFrom)];
  while (total > opts.budgetBytes && next.length > opts.recentWindow + 1) {
    next.splice(1, 1);
    total = next.reduce((n, turn) => n + size(turn), 0);
  }
  return { history: next, compacted: true, oldCount: old.length };
}
