/**
 * 弱模型在工具执行后常输出行动宣言（"现在运行类型检查："）却不发起工具调用。
 * 默认信任 LLM 结束意图；仅当「特定小模型 allowlist + LLM 返回纯文本（无 tool_calls）
 * + 所需信息未拿到」三条件同时满足时才注入 nudge。用户输入不作为门槛（用户永远是纯文本）。
 */

/** 需要引导的特定小模型（显式 allowlist）。未命中（含未知模型）一律不引导。 */
const WEAK_MODEL_NUDGE_PATTERN =
  /(flash|haiku|\bmini\b|nano|lite|tiny|small|gpt-3\.5|qwen|llama|mistral|phi-|gemma|yi-|glm-|command-r(?!-plus))/i;

/**
 * 该模型是否属于需要循环 nudge 的特定小模型。
 * 仅 allowlist 命中为 true；空 / 未知模型默认 false（信任 LLM）。
 */
export function modelNeedsLoopNudge(modelId: string): boolean {
  const id = modelId.trim();
  if (!id) return false;
  return WEAK_MODEL_NUDGE_PATTERN.test(id);
}

/** 未来行动标记。只收「还要去做」的词，不收运行/测试等过去时里也常见的动词。 */
const CONTINUATION_INTENT_PATTERN =
  /(接下来|下一步|然后|现在|让我|还要|继续|再来|马上|即将|我会|接着|进一步|查一下|看一下|确认一下|\blet me\b|\bnow i\b|\bi will\b|\bi'll\b|\bnext i\b|\bthen i\b|幇鍦ㄨ|鎺ヤ笅鏉|鏈€鍚庡啀|椹笂|璺戜竴閬)/i;

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
 * 必要前提：所需信息尚未拿到（explorationComplete === false）。
 * 报告式收尾 → 不 nudge；其余在信息缺失时 nudge。
 */
export function shouldInjectPostToolTextNudge(
  content: string,
  explorationComplete: boolean,
): boolean {
  if (explorationComplete) return false;
  if (looksLikeFinalReport(content)) return false;
  return true;
}
