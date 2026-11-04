/**
 * Relevance scoring and fallback history packing for task decomposition.
 *
 * Scores history fragments against the current user message and packs
 * read-evidence plus dialogue points when the model omits relevantHistory.
 */

import { collectReadEvidenceFromTurns } from "../../../turn-rounds.ts";
import type { AgentLoopOpts } from "../types.ts";
import { extractStructuredHistory } from "./decompose-history.ts";

/** 历史工具召回相关度下限：低于此值的历史片段丢弃（60%）。 */
export const RELEVANT_HISTORY_SCORE_THRESHOLD = 0.6;
export const FALLBACK_EVIDENCE_MAX_FILES = 8;
export const FALLBACK_EVIDENCE_MAX_FILE_CHARS = 6_000;
export const FALLBACK_EVIDENCE_MAX_CHARS = 24_000;
export const FALLBACK_HISTORY_MAX_CHARS = 32_000;

export function boundRelevantHistory(text: string): string {
  return clipEvidence(text.trim(), FALLBACK_HISTORY_MAX_CHARS).text;
}

function clipEvidence(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false };
  return { text: `${text.slice(0, maxChars)}\n[… evidence clipped …]`, clipped: true };
}


/**
 * 按相关度降序排列，并丢弃 score < threshold 的命中。
 * 无 score 的项视为 0（不保留），避免未评分噪声进入上下文。
 */
export function rankAndFilterByRelevance<T extends { score?: number }>(
  items: readonly T[],
  threshold = RELEVANT_HISTORY_SCORE_THRESHOLD,
): T[] {
  return items
    .filter((item) => typeof item.score === "number" && Number.isFinite(item.score) && item.score >= threshold)
    .slice()
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/**
 * 从查询中提取用于相关度匹配的词元：
 * - 拉丁/数字标识符（长度 ≥2）
 * - 连续中文按 2-gram 切分，避免整句中文变成一个超长 token 导致几乎永不命中
 */
function relevanceTerms(query: string): string[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [];
  const terms = new Set<string>();
  for (const raw of q.match(/[\p{L}\p{N}_./:-]+/gu) ?? []) {
    const token = raw.trim();
    if (!token) continue;
    if (/[\u4e00-\u9fff]/.test(token)) {
      if (token.length === 1) {
        terms.add(token);
      } else {
        for (let i = 0; i < token.length - 1; i++) {
          terms.add(token.slice(i, i + 2));
        }
        // 短词整段保留，便于「缓存」「登录」等直接命中
        if (token.length <= 4) terms.add(token);
      }
    } else if (token.length >= 2) {
      terms.add(token);
    }
  }
  return [...terms].slice(0, 32);
}

/**
 * 简易文本相关度（0–1）：查询词元在候选文本中的覆盖率。
 * 用于 fallback 打包时对已读文件 / 对话要点排序与 <0.6 过滤。
 */
export function estimateTextRelevance(query: string, text: string): number {
  const q = query.trim().toLocaleLowerCase();
  const t = text.trim().toLocaleLowerCase();
  if (!q || !t) return 0;

  const terms = relevanceTerms(q);
  if (terms.length === 0) {
    return t.includes(q) ? 1 : 0;
  }
  const hits = terms.filter((term) => t.includes(term)).length;
  let score = hits / terms.length;

  // 路径/标识符强命中加权：basename 或关键 token 命中时抬到至少阈值，避免「login.ts」被中文噪声词拖死
  const strong = terms.filter((term) =>
    /^[a-z0-9_./:-]+$/i.test(term) && term.length >= 3 && t.includes(term),
  );
  if (strong.length > 0) {
    score = Math.max(score, Math.min(1, 0.5 + 0.2 * strong.length));
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * 若 LLM 未返回 relevantHistory，从近期历史本地打包成文本（已读文件 + 对话要点等），
 * 按与当前用户输入的相关度降序，并丢弃 < 0.6 的块，供 React 循环直接复用。
 */
export function packFallbackRelevantHistory(
  opts: Pick<AgentLoopOpts, "history" | "userMessage">,
): string | undefined {
  const sections: string[] = [];
  const query = opts.userMessage?.trim() ?? "";
  // 无当前用户输入时无法打分：保留原顺序与上限，不做 <0.6 丢弃。
  const canScore = query.length > 0;

  const collected = collectReadEvidenceFromTurns(
    opts.history.map((turn) => ({
      role: turn.role,
      toolName: turn.toolName,
      content: typeof turn.content === "string" ? turn.content : undefined,
    })),
  );
  type ScoredFile = {
    path: string;
    content: string;
    startLine?: number;
    endLine?: number;
    note?: string;
    score: number;
  };
  const files: ScoredFile[] = [];
  const seen = new Set<string>();
  for (const item of collected) {
    const path = item.path?.trim();
    const content = item.fileEvidence?.content || item.excerpt || "";
    if (!path || !content) continue;
    const key = `${path}:${item.startLine ?? ""}:${item.endLine ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const score = canScore
      ? estimateTextRelevance(query, `${path}\n${content}\n${item.summary ?? ""}`)
      : 1;
    const bounded = clipEvidence(content, FALLBACK_EVIDENCE_MAX_FILE_CHARS);
    files.push({
      path,
      content: bounded.text,
      startLine: item.startLine,
      endLine: item.endLine,
      note: item.summary || "Historical evidence only; reuse only if the current task needs it",
      score,
    });
    if (!canScore && files.length >= FALLBACK_EVIDENCE_MAX_FILES) break;
  }
  const rankedFiles = (canScore
    ? rankAndFilterByRelevance(files, RELEVANT_HISTORY_SCORE_THRESHOLD)
    : files
  ).slice(0, 8);
  const filePayload = rankedFiles.map(({ path, content, startLine, endLine, note }) => ({
    path,
    content,
    startLine,
    endLine,
    note,
  }));
  let fileText = filePayload.length > 0 ? JSON.stringify({ files: filePayload }) : "";
  if (fileText.length > FALLBACK_EVIDENCE_MAX_CHARS) {
    const boundedFiles: typeof filePayload = [];
    for (const file of filePayload) {
      const candidate = JSON.stringify({ files: [...boundedFiles, file] });
      if (candidate.length > FALLBACK_EVIDENCE_MAX_CHARS) break;
      boundedFiles.push(file);
    }
    fileText = boundedFiles.length > 0
      ? `${JSON.stringify({ files: boundedFiles })}\n[… evidence clipped …]`
      : "";
  }
  if (fileText) sections.push(fileText);

  type ScoredDialogue = { text: string; score: number };
  const dialogueBlocks: ScoredDialogue[] = [];
  for (const round of extractStructuredHistory(opts.history, 5, true)) {
    const parts: string[] = [];
    if (round.userInput && round.userInput !== "(empty)") {
      parts.push(`user: ${round.userInput}`);
    }
    if (round.taskDecompose) {
      try {
        const parsed = JSON.parse(round.taskDecompose) as Record<string, unknown>;
        // 新格式 intent；旧持久化数据的理解段兜底映射。
        const intent = typeof parsed.intent === "string" && parsed.intent.trim()
          ? parsed.intent
          : parsed.understanding;
        if (typeof intent === "string" && intent.trim()) {
          parts.push(`intent: ${intent.trim()}`);
        }
        if (Array.isArray(parsed.userConstraints)) {
          const constraints = parsed.userConstraints
            .filter((c): c is string => typeof c === "string" && c.trim().length > 0)
            .map((c) => c.trim());
          if (constraints.length > 0) {
            parts.push(`constraints: ${constraints.join("; ")}`);
          }
        }
      } catch {
        // 分解 JSON 损坏时跳过，不影响其它历史块
      }
    }
    if (round.assistantReport) {
      parts.push(`assistant: ${round.assistantReport}`);
    }
    if (parts.length > 0) {
      const text = parts.join("\n");
      dialogueBlocks.push({
        text,
        score: canScore ? estimateTextRelevance(query, text) : 1,
      });
    }
  }
  const rankedDialogue = (canScore
    ? rankAndFilterByRelevance(dialogueBlocks, RELEVANT_HISTORY_SCORE_THRESHOLD)
    : dialogueBlocks
  ).map((block) => block.text);
  if (rankedDialogue.length > 0) {
    sections.push(`## Recent Conversation Highlights\n\n${rankedDialogue.join("\n\n")}`);
  }

  const packed = sections.join("\n\n").trim();
  if (!packed) return undefined;
  return clipEvidence(packed, FALLBACK_HISTORY_MAX_CHARS).text;
}
