/**
 * 弱模型在工具执行后常输出行动宣言（"现在运行类型检查："）却不发起工具调用。
 * 用两套轻量启发式区分「还要做事」和「最终报告」，决定是否注入 nudge。
 * 强模型（Sonnet / Opus / GPT-4 / Gemini Pro 等）不注入 nudge，信任其结束意图。
 */

/** 需要引导的弱小模型：工具后常停在纯文本，或只探索不落地。 */
const WEAK_MODEL_NUDGE_PATTERN =
  /(flash|haiku|\bmini\b|nano|lite|tiny|small|gpt-3\.5|qwen|llama|mistral|phi-|gemma|yi-|glm-|command-r(?!-plus))/i;

/** 不需要引导的强模型。弱模式（mini/flash/haiku）优先于本规则。 */
const STRONG_MODEL_NO_NUDGE_PATTERN =
  /(opus|sonnet|gpt-4|gpt-5|o1|o3|o4|gemini[\w.-]*pro|deepseek-r1|reasoner|codex)/i;

/**
 * 该模型是否需要循环 nudge（工具后纯文本 / 只读探索转实现）。
 * 未知模型默认需要：本地小模型更常提前停。
 */
export function modelNeedsLoopNudge(modelId: string): boolean {
  const id = modelId.trim();
  if (!id) return true;
  if (WEAK_MODEL_NUDGE_PATTERN.test(id)) return true;
  if (STRONG_MODEL_NO_NUDGE_PATTERN.test(id)) return false;
  return true;
}

/** 未来行动标记。只收「还要去做」的词，不收运行/测试等过去时里也常见的动词。 */
const CONTINUATION_INTENT_PATTERN =
  /(接下来|下一步|然后|现在|让我|还要|继续|再来|马上|即将|我会|接着|进一步|查一下|看一下|确认一下|\blet me\b|\bnow i\b|\bi will\b|\bi'll\b|\bnext i\b|\bthen i\b)/i;

/** 报告式收尾。命中即视为最终报告，优先于续作判断。
 *  不收录"已完成/已经完成"：行动宣言里也常出现。 */
const FINAL_REPORT_PATTERN =
  /(总结|汇总|报告如下|以上就是|以上为|综上所述|变更摘要|最终结论|最终报告|完成情况|任务完成|工作完成|修复完成|问题已解决|改动如下|修改如下|完毕|搞定|\bin summary\b|\bhere(?:'s| is) (?:the|a) (?:summary|fix|report|result)\b|\bconclusion\b|\ball tests pass\b|\ball checks pass\b|\beverything is done\b|\bfix(?: is)? complete\b|\bthe (?:fix|change|patch) (?:is|was) (?:complete|applied)\b)/i;

/** 是否表达"还要继续行动"。以冒号结尾是最强信号。 */
export function looksLikeContinuationIntent(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  if (/[：:]\s*$/.test(text)) return true;
  return CONTINUATION_INTENT_PATTERN.test(text);
}

/** 是否读起来像最终报告。 */
export function looksLikeFinalReport(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  return FINAL_REPORT_PATTERN.test(text);
}

/**
 * 工具执行后的纯文本是否注入 nudge。
 * 1. 报告式收尾 → 不 nudge
 * 2. 冒号结尾或未来行动词 → nudge
 * 3. 探索未完成 → nudge
 * 4. 其余 → 不 nudge
 */
export function shouldInjectPostToolTextNudge(content: string, explorationComplete: boolean): boolean {
  if (looksLikeFinalReport(content)) return false;
  if (looksLikeContinuationIntent(content)) return true;
  return !explorationComplete;
}
