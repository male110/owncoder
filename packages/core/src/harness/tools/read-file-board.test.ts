/**
 * toolRead × EvidenceStore 集成测试（真实临时工作区）。
 *
 * 锁住的语义（对齐 ZCode read.ts 的 file_unchanged 护栏）：
 * - 首次读走磁盘；同范围二次读命中缓存 → 只回一行 wasted-call 提示，
 *   不再把正文第二次灌进上下文（readSet 照常登记，先读后写不受影响）
 * - 文件追加后 size 变化 → 新鲜度事实不等 → 缓存失效走磁盘
 * - 未注入板时行为不变（两次都走磁盘）
 * - 范围读与整文件读键不同，互不命中
 * - wasted-call 提示仍带 read_file metadata（下游 freshReceipts/evidence 链路可用）
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolRead } from "./read-file.ts";
import { EvidenceStore } from "../evidence-store.ts";
import type { ToolContext } from "./types.ts";

let workspaceRoot: string;
let board: EvidenceStore;

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "owncoder-board-"));
  board = new EvidenceStore();
});

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

function makeCtx(): ToolContext {
  return {
    workspaceRoot,
    mode: "agent",
    workflow: {} as never,
    index: {} as never,
    readSet: new Set(),
    maxOutputChars: 100_000,
    bashMaxChars: 10_000,
    evidenceStore: board,
  };
}

describe("toolRead × 共享证据板", () => {
  it("首次读走磁盘；同范围二次读命中护栏，只回 wasted-call 提示不重放正文", async () => {
    const path = "a.ts";
    await writeFile(join(workspaceRoot, path), "line1\nline2\nline3\n");
    const ctx = makeCtx();

    const first = await toolRead(ctx, path);
    expect(first.ok).toBe(true);
    expect(first.output).toContain("line1");
    expect(first.output).not.toContain("Wasted call");

    const second = await toolRead(ctx, path);
    expect(second.ok).toBe(true);
    expect(second.output).toContain("Wasted call");
    expect(second.output).toContain("Refer to that earlier read_file result");
    // 护栏的核心价值：正文不再第二次进入上下文。
    expect(second.output).not.toContain("line1");
    // readSet 照常登记，先读后写约束不受影响。
    expect(ctx.readSet.has("a.ts")).toBe(true);
  });

  it("文件追加后 size 变化 → 缓存失效，走磁盘拿到新内容", async () => {
    const path = "b.ts";
    await writeFile(join(workspaceRoot, path), "v1\n");
    const ctx = makeCtx();

    const first = await toolRead(ctx, path);
    expect(first.output).toContain("v1");

    await appendFile(join(workspaceRoot, path), "v2\n");
    const second = await toolRead(ctx, path);
    expect(second.output).toContain("v2");
    expect(second.output).not.toContain("Wasted call");
  });

  it("未注入板时行为不变（两次都走磁盘，无护栏提示）", async () => {
    const path = "c.ts";
    await writeFile(join(workspaceRoot, path), "x\n");
    const ctx = makeCtx();
    ctx.evidenceStore = undefined;

    const first = await toolRead(ctx, path);
    const second = await toolRead(ctx, path);
    expect(first.output).toContain("x");
    expect(second.output).toContain("x");
    expect(second.output).not.toContain("Wasted call");
  });

  it("范围读与整文件读键不同：范围命中不影响整文件读走磁盘", async () => {
    const path = "d.ts";
    await writeFile(join(workspaceRoot, path), "l1\nl2\nl3\nl4\n");
    const ctx = makeCtx();

    await toolRead(ctx, path, 1, 2); // 范围读入板
    const whole = await toolRead(ctx, path); // 整文件：未命中 → 磁盘
    expect(whole.output).not.toContain("Wasted call");

    const ranged = await toolRead(ctx, path, 1, 2); // 同范围：命中护栏
    expect(ranged.output).toContain("Wasted call");
    expect(ranged.output).not.toContain("l1");
  });

  it("wasted-call 提示仍带 read_file metadata（下游 freshReceipts/evidence 链路可用）", async () => {
    const path = "e.ts";
    await writeFile(join(workspaceRoot, path), "content\n");
    const ctx = makeCtx();
    await toolRead(ctx, path);
    const stubbed = await toolRead(ctx, path);
    expect(stubbed.metadata?.kind).toBe("read_file");
    const meta = stubbed.metadata;
    if (meta?.kind === "read_file") {
      expect(meta.path).toBe("e.ts");
    }
  });
});
