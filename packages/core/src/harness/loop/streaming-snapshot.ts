/**
 * 流式文本事件的累积快照语义。
 *
 * LLM codec（openai-chat / openai-responses / anthropic / gemini）下发的
 * `assistant_delta` / `thinking_delta` 事件携带的是「截至目前」的完整文本
 * 快照（渲染端 upsertThinkingFn / upsertTextFn 按替换语义消费），而不是
 * 增量片段。消费端若直接 `current += incoming`，同一个字符会被重复保留
 * O(n²) 次：一份 300KB 的思考分 4000 个 chunk 到达时，会累积出数百 MB
 * 的字符串（内存转储中曾观察到同一段开头被反复叠加的异常模式）。
 *
 * `applyStreamSnapshot` 按「新旧互为前缀」识别同一文本段的下一个快照并
 * 替换；尾部的 think 标签剥离会让快照变短，同样按前缀关系处理。其余
 * 情况（一次性整段文本，如 finalReport / 门禁失败后缀）保持追加语义。
 */

/**
 * 用一个新的流式文本事件更新当前累积值。
 * 快照（互为前缀）则替换，否则视为新文本段追加。
 */
export function applyStreamSnapshot(current: string, incoming: string): string {
  if (!current) return incoming;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return incoming;
  return current + incoming;
}

/**
 * 同上，但用于「按段累积的 chunk 数组」（MessageProjector 的
 * thinkingChunks / textChunks）：快照替换最后一段，新文本段 push。
 */
export function pushStreamSnapshot(chunks: string[], incoming: string): void {
  const last = chunks[chunks.length - 1];
  if (last !== undefined && (incoming.startsWith(last) || last.startsWith(incoming))) {
    chunks[chunks.length - 1] = incoming;
    return;
  }
  chunks.push(incoming);
}
