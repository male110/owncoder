/**
 * Verify 阶段：单次 LLM 校验报告。
 *
 * 从 react.ts 拆分。Verify 报告是轮次结束时（所有 verify 节点完成后）
 * 发出的单次 LLM 调用，由端点统一执行并将 `### Verification` 段落
 * 追加到最终 assistantText。
 */
import { assertLlmAuth, chatCompletionStream, type ChatMessage } from "@owncoder/llm";
import type { PipelineNode } from "@owncoder/settings";
import { resolveStageModel } from "./stages.ts";
import { normalizeUsage, type Tracer } from "../observability.ts";
import type { AgentLoopOpts, ChatTurn } from "./types.ts";

export const DEFAULT_VERIFY_PROMPT =
  "Audit the completed work against the user request using the conversation, tool results, and recorded checks. " +
  "Write your report in Markdown with this structure:\n" +
  "## Verdict\n" +
  "One of: **Verified**, **Partially verified**, or **Not verified**.\n" +
  "## Evidence\n" +
  "Bullets citing the concrete requirement evidence (files, symbols, commands, checks) that supports the verdict.\n" +
  "## Gaps\n" +
  "Bullets describing anything missing, unverified, or risky; write `None` when there are no gaps.";

export async function runVerifyReport(
  opts: AgentLoopOpts,
  verifyNode: PipelineNode,
  messages: ChatMessage[],
  assistantText: string,
  tracer?: Tracer,
): Promise<string> {
  const verifyModel = resolveStageModel(opts.workflow, opts.mode, verifyNode);
  assertLlmAuth(verifyModel, opts.llmApiKey);
  const verifyPrompt = verifyNode.prompt?.trim() || DEFAULT_VERIFY_PROMPT;

  const verifyOutput = assistantText;

  const verifyMessages: ChatMessage[] = [
    ...messages,
    { role: "system", content: `## Verify stage\n${verifyPrompt}` },
    {
      role: "user",
      content: `Verify the work so far. Last assistant output:\n\n${verifyOutput}`,
    },
  ];
  const response = await chatCompletionStream(verifyModel, verifyMessages, {
    signal: opts.signal,
    apiKey: opts.llmApiKey,
    purpose: `verify_report#${verifyNode.id}`,
    taskId: opts.sessionId,
    onDelta: (text: string) => opts.onEvent?.({ type: "assistant_delta", text }),
    thinking: { effort: "none" },
  });
  const content = response.choices[0]!.message.content ?? "";
  if (tracer) {
    const usage = normalizeUsage(
      response.usage,
      verifyMessages.map((message) => String(message.content ?? "")).join("\n"),
      content,
    );
    tracer.recordTokenUsage(usage.promptTokens, usage.completionTokens);
  }
  return content;
}

/**
 * Merge a verification paragraph into the final assistantText and reflect it
 * back into history so persistence keeps the merged version. Used by the
 * single endpoint after all stages have run.
 */
export function mergeVerificationIntoAssistant(
  assistantText: string,
  verifyText: string,
  history: ChatTurn[],
): string {
  if (!verifyText.trim()) return assistantText;
  const combined = `${assistantText.trim()}\n\n---\n### Verification\n${verifyText.trim()}`;
  const last = history[history.length - 1];
  if (last?.role === "assistant") {
    last.content = combined;
  } else {
    history.push({ role: "assistant", content: combined });
  }
  return combined;
}
