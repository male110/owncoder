import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chatCompletion } from "@owncoder/llm";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { contextBudgets } from "../../../budget.ts";
import type { AgentLoopOpts } from "../../types.ts";
import { buildDecomposeContext } from "../task-decompose.ts";
import { loadDecomposeHistory, persistDecomposeHistory, persistRoundReport, dropLastRound, deleteDecomposeRound, roundsFilePath } from "../../../../turn-rounds.ts";

vi.mock("@owncoder/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@owncoder/llm")>(),
  chatCompletion: vi.fn(),
}));

let root: string;
const sessionId = "semantic-history";
const budgets = { ...contextBudgets(BUILTIN_WORKFLOW), total: 16000 };
const prefix = "s".repeat(14000);
const opts = (): AgentLoopOpts => ({
  mode: "agent", workspaceRoot: root, sessionId, workflow: BUILTIN_WORKFLOW,
  index: {} as AgentLoopOpts["index"], history: [], userMessage: "继续", llmApiKey: "test-key",
});
const response = (content: string) => ({
  choices: [{ message: { role: "assistant", content } }],
}) as Awaited<ReturnType<typeof chatCompletion>>;
const add = async (n: number, size = 50) => {
  await persistRoundReport(root, sessionId, `input-${n}-${"x".repeat(size)}`, `report-${n}`);
};
const seed = async () => { for (let i = 1; i <= 7; i++) await add(i, 4000); };

// 只模拟模型输出；预算计算、原始轮次及检查点均使用真实实现。
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "compact-test-"));
  vi.mocked(chatCompletion).mockReset();
  vi.mocked(chatCompletion).mockResolvedValue(response("合并摘要：目标与验证结果"));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("预算触发语义压缩", () => {
  it("预算充足时超过13轮也不摘要，保留全部未压缩原文", async () => {
    for (let i = 1; i <= 15; i++) await add(i);
    const result = await buildDecomposeContext(opts(), budgets);
    expect(result.match(/## Round /g)).toHaveLength(15);
    expect(chatCompletion).not.toHaveBeenCalled();
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint).toBeUndefined();
  });

  it("复用检查点并带上所有未覆盖轮次，不重新提取旧摘要", async () => {
    for (let i = 1; i <= 9; i++) await add(i);
    await persistDecomposeHistory(root, sessionId, 0, 2, "已有摘要");
    const result = await buildDecomposeContext(opts(), budgets);
    expect(result).toContain("已有摘要");
    expect(result).not.toContain("input-2-");
    expect(result.match(/## Round /g)).toHaveLength(7);
    expect(await buildDecomposeContext(opts(), budgets)).toBe(result);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("接近预算才压缩，保留最近五轮及附件，重载复用摘要且原始存储不变", async () => {
    await seed();
    const input = { ...opts(), attachments: [{ url: "https://example.com/image.png" }] } as AgentLoopOpts;
    const result = await buildDecomposeContext(input, budgets, prefix);
    const saved = await loadDecomposeHistory(root, sessionId);
    expect(saved.checkpoint?.throughIndex).toBe(2);
    expect(saved.checkpoint?.summary).toBe("合并摘要：目标与验证结果");
    expect(saved.rounds).toHaveLength(7);
    expect(result.match(/## Round /g)).toHaveLength(5);
    expect(result).toContain("https://example.com/image.png");
    expect(result).not.toContain("input-1-");
    for (let i = 3; i <= 7; i++) expect(result).toContain(`input-${i}-${"x".repeat(4000)}`);
    expect(await buildDecomposeContext(input, budgets, prefix)).toBe(result);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("把旧摘要与新增原文交给模型覆盖合并，明确按新决定纠正冲突", async () => {
    await seed();
    await add(8, 4000);
    // 纠正必须落在本次压缩覆盖的新增历史中。
    await persistRoundReport(root, sessionId, "改用方案B，撤销方案A", "已确认新决定");
    for (let i = 10; i <= 14; i++) await add(i);
    await persistDecomposeHistory(root, sessionId, 0, 1, "旧决定：方案A");
    vi.mocked(chatCompletion).mockResolvedValueOnce(response("当前决定：方案B，方案A已撤销"));
    const result = await buildDecomposeContext(opts(), budgets, prefix);
    const [, messages, config] = vi.mocked(chatCompletion).mock.calls[0];
    expect(JSON.stringify(messages)).toContain("旧决定：方案A");
    // 合并指令不再含消歧引导：旧决定与新决定作为数据交给模型自行裁决。
    expect(JSON.stringify(messages)).not.toContain("a newer explicit decision supersedes an older one");
    expect(JSON.stringify(messages)).toContain("input-2-");
    expect(JSON.stringify(messages)).toContain("改用方案B，撤销方案A");
    expect(config?.purpose).toBe("history_compact");
    expect(result).not.toContain("旧决定：方案A");
    const saved = (await loadDecomposeHistory(root, sessionId)).checkpoint;
    expect(saved?.throughIndex).toBe(9);
    expect(saved?.summary).toBe("当前决定：方案B，方案A已撤销");
  });

  // 摘要上限按 token 计量（1632 token）；"摘" 每字约 1 token，故 2000 字超限。
  it.each(["", "摘".repeat(2000)])("空或超长摘要安全回退且不推进检查点", async (text) => {
    await seed();
    vi.mocked(chatCompletion).mockResolvedValueOnce(response(text));
    const result = await buildDecomposeContext(opts(), budgets, prefix);
    expect(result.match(/## Round /g)).toHaveLength(7);
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint).toBeUndefined();
  });

  it("压缩接口失败且原文超限时显式失败", async () => {
    await seed();
    vi.mocked(chatCompletion).mockRejectedValueOnce(new Error("service unavailable"));
    await expect(buildDecomposeContext(opts(), budgets, "s".repeat(40000))).rejects.toThrow("service unavailable");
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint).toBeUndefined();
  });

  it("近期原文仍超预算时不提交检查点", async () => {
    await seed();
    await expect(buildDecomposeContext(opts(), budgets, "s".repeat(40000))).rejects.toThrow("压缩后上下文仍超预算");
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint).toBeUndefined();
  });

  it("并发更新检查点时不覆盖较新的摘要", async () => {
    await seed();
    vi.mocked(chatCompletion).mockImplementationOnce(async () => {
      await persistDecomposeHistory(root, sessionId, 0, 1, "并发摘要");
      return response("本次摘要");
    });
    const result = await buildDecomposeContext(opts(), budgets, prefix);
    expect(result.match(/## Round /g)).toHaveLength(7);
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint?.summary).toBe("并发摘要");
  });

  it("旧历史超过单次压缩预算时分批合并，所有批次完成后才推进检查点", async () => {
    for (let i = 1; i <= 20; i++) await add(i, 4000);
    const result = await buildDecomposeContext(opts(), budgets);
    expect(chatCompletion).toHaveBeenCalledTimes(2);
    const secondPayload = JSON.stringify(vi.mocked(chatCompletion).mock.calls[1][1]);
    expect(secondPayload).toContain("合并摘要：目标与验证结果");
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint?.throughIndex).toBe(15);
    expect(result.match(/## Round /g)).toHaveLength(5);
  });

  it("遗留超大摘要无法装入压缩请求时不截断或推进检查点", async () => {
    await seed();
    await persistDecomposeHistory(root, sessionId, 0, 1, "大".repeat(20000));
    await expect(buildDecomposeContext(opts(), budgets)).rejects.toThrow("单轮历史超过语义压缩输入预算");
    expect(chatCompletion).not.toHaveBeenCalled();
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint?.throughIndex).toBe(1);
  });

  it.each([false, true])("超过50轮后原文在磁盘完整保留（已有摘要：%s）", async (compressed) => {
    for (let i = 1; i <= 60; i++) await add(i);
    const original = (await loadDecomposeHistory(root, sessionId)).rounds;
    if (compressed) {
      expect(await persistDecomposeHistory(root, sessionId, 0, 55, "前55轮摘要")).toBe(true);
    }
    // 检查点写入和后续追加都不能裁掉任何已压缩原文。
    await add(61);
    const disk = JSON.parse(await fs.readFile(roundsFilePath(root, sessionId), "utf8"));
    expect(disk.rounds).toHaveLength(61);
    expect(disk.rounds.slice(0, 60)).toEqual(original);
    expect((await loadDecomposeHistory(root, sessionId)).rounds).toEqual(disk.rounds);
  });

  it.each([1, 30, 60])("超过50轮后删除第%s轮，其余历史仍可完整恢复", async (deleted) => {
    for (let i = 1; i <= 60; i++) await add(i, 0);
    const original = (await loadDecomposeHistory(root, sessionId)).rounds;
    const checkpoint = { throughIndex: 55, summary: "前55轮摘要" };
    await persistDecomposeHistory(root, sessionId, 0, checkpoint.throughIndex, checkpoint.summary);
    expect(await deleteDecomposeRound(root, sessionId, "legacy-id", `input-${deleted}-`)).toBe(true);
    const saved = await loadDecomposeHistory(root, sessionId);
    expect(saved.rounds).toEqual(original.filter((round) => round.index !== deleted));
    expect(saved.checkpoint).toEqual(deleted <= 55 ? undefined : checkpoint);
    // 大预算下直接检查原文回退；预算触发、摘要合并行为由其余用例覆盖。
    const context = await buildDecomposeContext(opts(), { ...budgets, total: 1000000 });
    expect(context).not.toContain(`input-${deleted}-`);
    if (deleted <= 55) {
      expect(context).not.toContain(checkpoint.summary);
      for (const round of saved.rounds) {
        expect(context).toContain(round.userInput);
        expect(context).toContain(round.assistantReport);
      }
    } else {
      expect(context).toContain(checkpoint.summary);
      for (let i = 56; i < 60; i++) expect(context).toContain(`input-${i}-`);
    }
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it("删除不存在的轮次不会清空检查点或改变磁盘原文", async () => {
    await seed();
    await persistDecomposeHistory(root, sessionId, 0, 2, "保留摘要");
    const before = await fs.readFile(roundsFilePath(root, sessionId), "utf8");
    expect(await deleteDecomposeRound(root, sessionId, "missing-turn")).toBe(false);
    expect(await fs.readFile(roundsFilePath(root, sessionId), "utf8")).toBe(before);
  });

  it("回退轮次会清除越界检查点", async () => {
    await seed();
    await buildDecomposeContext(opts(), budgets, prefix);
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint).toBeDefined();
    for (let i = 0; i < 7; i++) await dropLastRound(root, sessionId);
    expect((await loadDecomposeHistory(root, sessionId)).checkpoint).toBeUndefined();
  });
});
