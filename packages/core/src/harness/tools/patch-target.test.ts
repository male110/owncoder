import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { allEnhancedTools } from "../enhanced-tools.ts";
import { executeTool } from "../execute.ts";
import { resolvePatchTarget } from "./patch-target.ts";
import type { ToolContext } from "./types.ts";

const block = "<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE";
const diff = "--- a/target.txt\n+++ b/target.txt\n@@ -1 +1 @@\n-old\n+new\n";

describe("补丁目标解析", () => {
  it.each([
    ["target.txt", block],
    ["./target.txt", diff],
  ])("使用显式 path %s", (path, patch) => {
    expect(resolvePatchTarget(path, patch)).toEqual({ path });
  });

  it.each([
    ["", block],
    [" ", block],
    ["target.txt", ""],

  ])("拒绝缺失、冲突或多文件目标 %s", (path, patch) => {
    expect(resolvePatchTarget(path, patch)).toHaveProperty("error");
  });

  it.each([
    `other.txt\n${block}`,
    diff.replaceAll("target.txt", "other.txt"),
    `target.txt\n${block}\nother.txt\n${block}`,
  ])("忽略补丁正文中的路径，只使用显式 path", (patch) => {
    expect(resolvePatchTarget("target.txt", patch)).toEqual({ path: "target.txt" });
  });

  it("agent 和 plan 的参数契约一致", () => {
    for (const options of [{ mode: "agent" as const }, { mode: "spec" as const, planCanEdit: true }]) {
      const tool = allEnhancedTools(options).find((entry) => entry.function.name === "apply_patch");
      // old_string / new_string 是首选编辑方式，二者均非 schema 级必填——
      // 工具运行时要求 old_string 或 patch 至少提供一个。
      expect(tool?.function.parameters.required).toEqual(["file_path"]);
      const props = tool?.function.parameters.properties as Record<string, unknown>;
      for (const key of ["file_path", "old_string", "new_string", "replace_all", "patch"]) {
        expect(props).toHaveProperty(key);
      }
    }
  });
});

it("多文件读取后的执行链路：只修改明确目标，拒绝无路径和截断调用", async () => {
  const root = await mkdtemp(join(process.cwd(), ".patch-target-test-"));
  const ctx = {
    workspaceRoot: root,
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    index: { invalidate() {} },
    readSet: new Set(["target.txt", "other.txt"]),
    touchedPaths: [],
    fileSnapshots: [],
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
  } as unknown as ToolContext;
  const run = (args: Record<string, unknown>) => executeTool(ctx, {
    id: "patch-test", name: "apply_patch", arguments: args, rawArguments: JSON.stringify(args),
  });
  try {
    await writeFile(join(root, "target.txt"), "old\n");
    await writeFile(join(root, "other.txt"), "old\n");
    expect((await run({ patch: block })).ok).toBe(false);
    expect((await run({ patch: diff, _truncated: true })).ok).toBe(false);
    expect((await run({ file_path: "other.txt", patch: diff })).ok).toBe(true);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("old\n");
    expect(await readFile(join(root, "other.txt"), "utf8")).toBe("new\n");
    expect((await run({ file_path: "target.txt", patch: diff })).ok).toBe(true);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("new\n");
    expect(ctx.fileSnapshots).toHaveLength(2);
    expect(ctx.touchedPaths).toEqual(["other.txt", "target.txt"]);
    const otherBlock = "<<<<<<< SEARCH\nnew\n=======\nfinal\n>>>>>>> REPLACE";
    expect((await run({ file_path: "other.txt", patch: otherBlock })).ok).toBe(true);
    expect(await readFile(join(root, "other.txt"), "utf8")).toBe("final\n");
    expect((await run({ file_path: "other.txt", patch: "--- a/other.txt\n+++ b/other.txt\n@@ -1 +0,0 @@\n-final\n" })).ok).toBe(true);
    expect(await readFile(join(root, "other.txt"), "utf8")).toBe("");
    expect((await run({ patch: `../outside.txt\n${block}` })).ok).toBe(false);

    // old_string / new_string 片段改写主路径
    await writeFile(join(root, "target.txt"), "alpha\nbeta\ngamma\n");
    expect((await run({ file_path: "target.txt", old_string: "beta", new_string: "BETA" })).ok).toBe(true);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
    // replace_all 替换全部出现位置
    await writeFile(join(root, "target.txt"), "a\nx\na\n");
    expect((await run({ file_path: "target.txt", old_string: "a", new_string: "z", replace_all: true })).ok).toBe(true);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("z\nx\nz\n");
    // 不唯一且未设 replace_all → 失败且不修改文件
    await writeFile(join(root, "target.txt"), "dup\ndup\n");
    expect((await run({ file_path: "target.txt", old_string: "dup", new_string: "one" })).ok).toBe(false);
    expect(await readFile(join(root, "target.txt"), "utf8")).toBe("dup\ndup\n");
    // 两者都缺失 → 参数错误
    expect((await run({ file_path: "target.txt" })).ok).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("file editors resolve relative paths in workspace and absolute paths outside it", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-edit-root-"));
  const outside = await mkdtemp(join(tmpdir(), "owncoder-edit-outside-"));
  const target = join(outside, "target.txt");
  const ctx = {
    workspaceRoot: root,
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    index: { invalidate() {} },
    readSet: new Set<string>(),
    touchedPaths: [] as string[],
    fileSnapshots: [] as { path: string }[],
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
  } as unknown as ToolContext;
  const run = (name: string, file_path: string, args: Record<string, unknown>) => executeTool(ctx, {
    id: name, name, arguments: { file_path, ...args }, rawArguments: JSON.stringify({ file_path, ...args }),
  });
  try {
    await writeFile(target, "old\n");
    expect((await run("apply_patch", target, { patch: block })).ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("new\n");
    expect((await run("write_file", target, { content: "written\n" })).ok).toBe(true);
    expect((await run("append_file", target, { content: "appended\n" })).ok).toBe(true);
    expect(await readFile(target, "utf8")).toBe("written\nappended\n");
    expect(ctx.fileSnapshots).toHaveLength(0);
    expect(ctx.touchedPaths).toEqual([]);
    expect((await run("write_file", "local.txt", { content: "local\n" })).ok).toBe(true);
    expect((await run("append_file", "local.txt", { content: "more\n" })).ok).toBe(true);
    expect(await readFile(join(root, "local.txt"), "utf8")).toBe("local\nmore\n");
    expect(ctx.touchedPaths).toEqual(["local.txt", "local.txt"]);
    expect(ctx.fileSnapshots).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
