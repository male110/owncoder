import assert from "node:assert/strict";
import { test } from "vitest";
import {
  looksLikeContinuationIntent,
  looksLikeFinalReport,
  modelNeedsLoopNudge,
  shouldInjectPostToolTextNudge,
} from "./continuation-intent.ts";

// 用户报告的"总中断"场景：模型输出行动宣言却不发起工具调用，循环随之结束。
// 这三类文本必须识别为"还要继续行动"，从而注入 nudge。
test("treats action announcements ending with a colon as continuation intent", () => {
  assert.equal(
    looksLikeContinuationIntent("根据我的分析，任务实际上已经完成。让我验证一下实现是否正确："),
    true,
  );
  assert.equal(
    looksLikeContinuationIntent("完美！所有测试通过。现在运行类型检查确保没有类型错误："),
    true,
  );
});

test("treats action announcements with future-action words as continuation intent", () => {
  assert.equal(
    looksLikeContinuationIntent("好的，我已经确认了 scanner.ts 的修改内容。现在运行类型检查来验证修改是否正确。"),
    true,
  );
  assert.equal(looksLikeContinuationIntent("接下来我会补充测试用例。"), true);
  assert.equal(looksLikeContinuationIntent("Let me verify the implementation."), true);
});

test("does not treat plain concluding reports as continuation intent", () => {
  assert.equal(looksLikeContinuationIntent("以上是本次修改的总结。"), false);
  assert.equal(looksLikeContinuationIntent("好的，任务完成。"), false);
});

test("does not treat past-tense status updates as continuation intent", () => {
  assert.equal(looksLikeContinuationIntent("我已经运行了测试，全部通过。"), false);
  assert.equal(looksLikeContinuationIntent("类型检查已通过。"), false);
});

test("detects report-style closings", () => {
  assert.equal(looksLikeFinalReport("以上是本次修改的总结。"), true);
  assert.equal(looksLikeFinalReport("报告如下：修改了 scanner.ts 并补充了测试。"), true);
  assert.equal(looksLikeFinalReport("现在运行类型检查："), false);
  assert.equal(looksLikeFinalReport("修复完成：已为未满足分支增加报告出口。"), true);
  assert.equal(looksLikeFinalReport("The fix is complete and the loop stops after the report."), true);
});

// 默认信任 LLM：所需信息已拿到（explorationComplete === true）时一律不 nudge，
// 即使文本是"行动宣言"也不引导。
test("does not nudge action announcements when exploration is already complete", () => {
  assert.equal(
    shouldInjectPostToolTextNudge("根据我的分析，任务实际上已经完成。让我验证一下实现是否正确：", true),
    false,
  );
  assert.equal(
    shouldInjectPostToolTextNudge("完美！所有测试通过。现在运行类型检查确保没有类型错误：", true),
    false,
  );
  assert.equal(
    shouldInjectPostToolTextNudge("好的，我已经确认了 scanner.ts 的修改内容。现在运行类型检查来验证修改是否正确。", true),
    false,
  );
});

test("does not nudge a final report when exploration is complete", () => {
  assert.equal(
    shouldInjectPostToolTextNudge("以上是本次修改的总结。", true),
    false,
  );
  assert.equal(
    shouldInjectPostToolTextNudge("好的，任务完成。", true),
    false,
  );
});

test("nudges by default while exploration is still incomplete", () => {
  assert.equal(shouldInjectPostToolTextNudge("好的。", false), true);
  // 报告式收尾优先于默认 nudge：未满足的信息需求交给下游探索引导分支处理
  assert.equal(shouldInjectPostToolTextNudge("好的，任务完成。", false), false);
  assert.equal(shouldInjectPostToolTextNudge("以上是本次修改的总结。", false), false);
});

// 没有 tasks / 没有 turn information plan 时，react 循环把 explorationComplete 视为 true。
// 普通收尾文本不得再被默认 nudge 拖住，否则会出现「该结束却不结束」。
test("does not nudge plain completion text when there is no exploration work left", () => {
  assert.equal(shouldInjectPostToolTextNudge("好的。", true), false);
  assert.equal(shouldInjectPostToolTextNudge("已按你的要求处理完毕。", true), false);
  assert.equal(shouldInjectPostToolTextNudge("Done.", true), false);
});

test("nudges only allowlisted small models; unknown models are trusted by default", () => {
  assert.equal(modelNeedsLoopNudge("gemini-2.5-flash"), true);
  assert.equal(modelNeedsLoopNudge("claude-3-5-haiku-20241022"), true);
  assert.equal(modelNeedsLoopNudge("gpt-4o-mini"), true);
  assert.equal(modelNeedsLoopNudge("qwen2.5-coder"), true);
  // 明确的强模型不引导
  assert.equal(modelNeedsLoopNudge("claude-sonnet-4"), false);
  assert.equal(modelNeedsLoopNudge("claude-opus-4"), false);
  assert.equal(modelNeedsLoopNudge("gpt-4o"), false);
  assert.equal(modelNeedsLoopNudge("gemini-2.5-pro"), false);
  // 空 / 未知模型默认信任 LLM，不引导
  assert.equal(modelNeedsLoopNudge(""), false);
  assert.equal(modelNeedsLoopNudge("   "), false);
  assert.equal(modelNeedsLoopNudge("some-proprietary-model-v2"), false);
  assert.equal(modelNeedsLoopNudge("deepseek-v3"), false);
});

// 三条件：特定小模型 allowlist + LLM 返回纯文本（由 react 注入路径保证无 tool_calls）
// + 所需信息未获取。用户输入不作为门槛。
test("documents three-gate nudge rule: allowlist + LLM text-only + pending info", () => {
  // 信息已齐 → 不 nudge（即使是行动宣言）
  assert.equal(
    shouldInjectPostToolTextNudge("现在运行类型检查：", true),
    false,
  );
  // 信息未齐 + 非报告收尾 → 可 nudge（模型 allowlist 与 LLM 纯文本路径由调用方保证）
  assert.equal(
    shouldInjectPostToolTextNudge("现在运行类型检查：", false),
    true,
  );
});
