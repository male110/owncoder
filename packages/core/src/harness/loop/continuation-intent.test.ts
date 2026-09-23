import assert from "node:assert/strict";
import { test } from "vitest";
import {
  looksLikeContinuationIntent,
  looksLikeFinalReport,
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

test("nudges after tool text when exploration is complete but the model announces more work", () => {
  assert.equal(
    shouldInjectPostToolTextNudge("根据我的分析，任务实际上已经完成。让我验证一下实现是否正确：", true),
    true,
  );
  assert.equal(
    shouldInjectPostToolTextNudge("完美！所有测试通过。现在运行类型检查确保没有类型错误：", true),
    true,
  );
  assert.equal(
    shouldInjectPostToolTextNudge("好的，我已经确认了 scanner.ts 的修改内容。现在运行类型检查来验证修改是否正确。", true),
    true,
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
