import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadDecomposeHistory,
  persistRoundReport,
  persistDecomposeHistory,
  roundsFilePath,
} from "./turn-rounds.ts";

let root: string;
const sessionId = "trim-rounds";

const add = async (n: number) => {
  await persistRoundReport(root, sessionId, `input-${n}`, `report-${n}`);
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "turn-rounds-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("rounds.json 体积上限", () => {
  it("未达上限时原文全量保留，不产生摘要", async () => {
    for (let i = 1; i <= 10; i++) await add(i);
    const saved = await loadDecomposeHistory(root, sessionId);
    expect(saved.rounds).toHaveLength(10);
    expect(saved.checkpoint).toBeUndefined();
  });

  it("超过上限时最旧轮次折叠进摘要，最近轮保留原文", async () => {
    for (let i = 1; i <= 61; i++) await add(i);
    const saved = await loadDecomposeHistory(root, sessionId);
    // 最近 60 轮保留原文，索引不重排
    expect(saved.rounds).toHaveLength(60);
    expect(saved.rounds[0]!.index).toBe(2);
    expect(saved.rounds[59]!.index).toBe(61);
    // 被折叠的第 1 轮进入摘要
    expect(saved.checkpoint?.throughIndex).toBe(1);
    expect(saved.checkpoint?.summary).toContain("input-1");
  });

  it("再次超过上限时在已有摘要上累计，且摘要有字符上限", async () => {
    for (let i = 1; i <= 121; i++) await add(i);
    const saved = await loadDecomposeHistory(root, sessionId);
    expect(saved.rounds).toHaveLength(60);
    expect(saved.rounds[0]!.index).toBe(62);
    expect(saved.checkpoint?.throughIndex).toBe(61);
    // 两段折叠都进入摘要：旧段（1 轮）+ 新段（60 轮）
    expect(saved.checkpoint?.summary).toContain("input-1");
    expect(saved.checkpoint?.summary).toContain("input-61");
    expect(saved.checkpoint!.summary.length).toBeLessThanOrEqual(8_000);
  });

  it("已被现有摘要覆盖的被逐轮次不再重复提取", async () => {
    for (let i = 1; i <= 61; i++) await add(i);
    const first = await loadDecomposeHistory(root, sessionId);
    expect(first.checkpoint?.summary).toContain("input-1");
    // 模拟 LLM 压缩产出的检查点覆盖到第 30 轮
    await persistDecomposeHistory(root, sessionId, first.checkpoint!.throughIndex, 30, "语义摘要A");
    for (let i = 62; i <= 121; i++) await add(i);
    const saved = await loadDecomposeHistory(root, sessionId);
    expect(saved.rounds[0]!.index).toBe(62);
    expect(saved.checkpoint?.throughIndex).toBe(61);
    // 已覆盖的 2..30 不重新进入启发式摘要；新折叠段从 31 轮开始
    expect(saved.checkpoint?.summary).toContain("语义摘要A");
    expect(saved.checkpoint?.summary).toContain("input-31");
    expect(saved.checkpoint?.summary).not.toContain("input-25");
  });

  it("磁盘文件确实只写最近 60 轮", async () => {
    for (let i = 1; i <= 61; i++) await add(i);
    const raw = JSON.parse(await fs.readFile(roundsFilePath(root, sessionId), "utf8"));
    expect(raw.rounds).toHaveLength(60);
    expect(raw.decomposeHistory.throughIndex).toBe(1);
  });
});
