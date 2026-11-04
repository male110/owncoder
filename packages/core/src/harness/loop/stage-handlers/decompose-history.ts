/**
 * Conversation-history helpers shared by the task_decompose stage.
 *
 * Tag stripping, plain-text extraction, explicit-change / behavior-inquiry
 * detection, tolerant JSON extraction and structured round parsing.
 */

import { jsonrepair } from "jsonrepair";
import type { ChatTurn } from "../types.ts";

interface StructuredRound {
  userInput: string;
  taskDecompose?: string;
  assistantReport?: string;
  transcript?: string;
}

export function stripConversationHistoryTags(content: string): string {
  return content
    .replace(/<conversation_history>\s*/gi, "")
    .replace(/\s*<\/conversation_history>/gi, "")
    .trim();
}

function messageText(turn: ChatTurn): string {
  if (Array.isArray(turn.parts) && turn.parts.length > 0) {
    const parts = turn.parts
      .map((part) => {
        switch (part.type) {
          case "text":
          case "thinking":
            return part.text.trim();
          case "tool_result":
            return "";
          case "tool_use":
            return `[${part.name}]${Object.keys(part.input).length > 0 ? ` ${JSON.stringify(part.input)}` : ""}`;
          default:
            return "";
        }
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return typeof turn.content === "string" ? turn.content.trim() : "";
}

/**
 * 短句式的“继续改代码”不能被当成讨论请求。任务分解阶段必须把这类
 * 当前输入路由到实现流程，而不是让下游模型自行生成 need_details。
 */
export function isExplicitCodeChangeRequest(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return /(改代码|修改代码|修复代码|修一下|修复这个|实现一下|加一下|写代码|直接改|请修改|帮我改|fix\s+(this|it|the)|change\s+(the\s+)?code|implement)/i.test(text);
}

/** 文件路径 token：xxx/yyy.ext 或 yyy.ext（扩展名 1~12 个字母）。 */
const FILE_PATH_RE = /[\w./\\-]+\.[a-z]{1,12}/i;
/** 行号锚点：path:123、第 123 行、第 123-130 行、L123。 */
const LINE_ANCHOR_RE = /(?::\d+\b|第\s*\d+(?:\s*[-–~至]\s*\d+)?\s*行|\bL\d+\b)/i;
/** 嵌入的原始文本：围栏代码块，或反引号/引号包裹的多记号片段。 */
const EMBEDDED_TEXT_RE = /```[\s\S]*?```|`[^`\n]{4,}`|"[^"\n]{8,}"|“[^”\n]{8,}”/;

/**
 * 用户消息是否已经精确定位了改动点：既给了文件路径，又给了行号锚点或
 * 待替换的原文。此时任务自身就是完整指令（分解器应返回空 tasks，
 * 执行器走精确快速路径：读指定范围 → 改 → 按指定方式验证）。
 * Exported for testing.
 */
export function isPreciseLocatedRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (!FILE_PATH_RE.test(text)) return false;
  return LINE_ANCHOR_RE.test(text) || EMBEDDED_TEXT_RE.test(text);
}

/**
 * 询问「当前代码 / 当前步骤如何处理 X」必须进入定位阅读链路。
 * 模型常把 inquire 映射成 discuss 并清空 steps；运行时在此兜底。
 * Exported for testing.
 */
export function isCurrentCodeBehaviorInquiry(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  const asksCurrentZh =
    /(当前|现在|现有|这段|这个).{0,24}(代码|实现|步骤|这一步|阶段|流水线|处理).{0,40}(如何处理|怎么处理|怎样处理|是怎么|是如何|如何工作|怎么工作)/i.test(text)
    || /(如何处理|怎么处理|怎样处理|是怎么|是如何).{0,24}(当前|现在|现有|这段|这个).{0,24}(代码|实现|步骤|这一步|阶段|流水线)/i.test(text)
    || /(现在|当前).{0,20}(这一步|步骤|阶段).{0,40}(如何处理|怎么处理|怎样处理|是怎么|是如何)/i.test(text);
  const asksCurrentEn =
    /how\s+(?:is|does|do)\s+(?:the\s+)?(?:current|existing|this)\b[\s\S]{0,80}(?:code|implementation|step|stage|pipeline)\b[\s\S]{0,40}(?:handle|process|work)/i.test(text)
    || /how\s+(?:the\s+)?(?:current|existing|this)\b[\s\S]{0,80}(?:code|implementation|step|stage|pipeline)\b[\s\S]{0,40}(?:handle|process|work)/i.test(text);
  return asksCurrentZh || asksCurrentEn;
}

function extractDecomposeJson(content: string): string | undefined {
  if ((!content.includes("intent") && !content.includes("understanding"))
    || (!content.includes("tasks") && !content.includes("steps"))) return undefined;
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || content.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return undefined;
  const isDecomposeShape = (parsed: unknown): boolean =>
    typeof parsed === "object" && parsed !== null
    && ("intent" in parsed || "understanding" in parsed)
    && ("tasks" in parsed || "steps" in parsed);
  try {
    const parsed = JSON.parse(candidate);
    return isDecomposeShape(parsed)
      ? JSON.stringify(parsed, null, 2)
      : undefined;
  } catch {
    try {
      const parsed = JSON.parse(jsonrepair(candidate));
      return isDecomposeShape(parsed)
        ? JSON.stringify(parsed, null, 2)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * 从历史中提取结构化的轮次。
 * 每一轮 = 用户输入 + (可选)任务分解 + (可选)LLM报告
 * 
 * @param history - 完整的对话历史
 * @param minRounds - 最少提取的轮次数
 * @param excludeCurrentTurn - 是否排除当前轮（最后一条可能是当前用户输入）
 */
export function extractStructuredHistory(
  history: ChatTurn[],
  minRounds: number,
  excludeCurrentTurn = true,
): StructuredRound[] {
  const rounds: StructuredRound[] = [];
  let current: StructuredRound | null = null;
  const finish = () => {
    if (!current) return;
    current.transcript = current.transcript?.trim();
    rounds.push(current);
    current = null;
  };

  for (const turn of history) {
    const content = messageText(turn);
    if (turn.role === "user") {
      finish();
      current = { userInput: content || "(empty)" };
      continue;
    }
    if (!current || !content || turn.role === "system") continue;

    const label = turn.role === "tool" ? `tool${turn.toolName ? `:${turn.toolName}` : ""}` : turn.role;
    // Tool output is execution detail, not task context. Keep only the tool
    // activity marker in the fallback history path so large read/search results
    // do not get copied into the decomposition prompt.
    const clean = turn.role === "tool"
      ? `[${label}]`
      : stripConversationHistoryTags(content);
    if (!clean) continue;
    const line = turn.role === "tool" ? clean : `[${label}] ${clean}`;
    current.transcript = current.transcript ? `${current.transcript}\n${line}` : line;

    if (turn.role === "assistant") {
      const decompose = extractDecomposeJson(clean);
      if (decompose) current.taskDecompose = decompose;
      else current.assistantReport = current.assistantReport
        ? `${current.assistantReport}\n${clean}`
        : clean;
    }
  }
  finish();

  if (excludeCurrentTurn && history.at(-1)?.role === "user" && rounds.at(-1)?.userInput === messageText(history.at(-1)!)) {
    rounds.pop();
  }
  return rounds.slice(-minRounds);
}
