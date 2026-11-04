import { promises as fs } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { executeTool } from "../execute.ts";
import type { ToolContext } from "./types.ts";

/**
 * 读取过期自愈：探针在正文中完全落空时，apply_patch 会重读一次文件并按
 * 最新内容重试。这覆盖了"首次读取与定位之间的短暂窗口里，文件被格式化
 * 工具 / lint / 用户改写"的情形。通过监听 fs.readFile 把竞态固定下来：
 * 第一次读取返回过期内容（探针缺失），第二次（自愈重读）返回最新内容
 * （探针存在）。
 */
describe("apply_patch 读取过期自愈", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeCtx(root: string, events: unknown[]) {
    return {
      workspaceRoot: root,
      mode: "agent",
      workflow: BUILTIN_WORKFLOW,
      index: { invalidate() {} },
      readSet: new Set(["svc.java"]),
      touchedPaths: [] as string[],
      fileSnapshots: [],
      maxOutputChars: 24_000,
      bashMaxChars: 10_000,
      onEvent: (ev: unknown) => events.push(ev),
    } as unknown as ToolContext;
  }

  it("首次读取后文件发生变化时，重读并重试一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncoder-reread-"));
    const abs = join(root, "svc.java");
    // 磁盘上的真实内容（也是自愈重读时返回的内容）。
    const fresh = [
      "interface Svc {",
      "    void clearUploadStatus(List<Integer> ids);",
      "",
      "    void clearUploadStatus(Integer taskId);",
      "}",
      "",
    ].join("\n");
    // 工具首次读取拿到的过期快照（此时 lint 尚未运行）。
    const stale = fresh.replace("    void clearUploadStatus(Integer taskId);", "    void oldMethod();");
    await writeFile(abs, fresh);

    const events: unknown[] = [];
    const ctx = makeCtx(root, events);

    const realReadFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, "readFile");
    let call = 0;
    spy.mockImplementation(((...args: unknown[]) => {
      call += 1;
      if (call === 1) return Promise.resolve(stale);
      // 第 2 次为自愈重读；其后是写前快照等读取，走真实磁盘。
      return realReadFile(...(args as [never, never]));
    }) as typeof fs.readFile);

    const old_string =
      "    void clearUploadStatus(List<Integer> ids);\n\n    void clearUploadStatus(Integer taskId);";
    const new_string = `${old_string}\n\n    void clearReviewedAndSubmitStatus(List<Integer> ids);`;

    const result = await executeTool(ctx, {
      id: "reread-1",
      name: "apply_patch",
      arguments: { file_path: "svc.java", old_string, new_string },
      rawArguments: "{}",
    });

    expect(result.ok).toBe(true);
    const written = await readFile(abs, "utf8");
    expect(written).toContain("void clearReviewedAndSubmitStatus(List<Integer> ids);");
    expect(written).toContain("void clearUploadStatus(Integer taskId);");
    expect(events.some((e) => (e as { type?: string }).type === "tool_refresh_retry")).toBe(true);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);

    await rm(root, { recursive: true, force: true });
  });

  it("首次读取即唯一命中时不触发重读", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncoder-noreread-"));
    const abs = join(root, "svc.java");
    await writeFile(abs, "alpha\nbeta\ngamma\n");
    const events: unknown[] = [];
    const ctx = makeCtx(root, events);

    const spy = vi.spyOn(fs, "readFile");

    const result = await executeTool(ctx, {
      id: "reread-2",
      name: "apply_patch",
      arguments: { file_path: "svc.java", old_string: "beta", new_string: "BETA" },
      rawArguments: "{}",
    });

    expect(result.ok).toBe(true);
    expect(await readFile(abs, "utf8")).toBe("alpha\nBETA\ngamma\n");
    // 首次读取 + 一次写前快照读取；没有自愈重读。
    expect(spy.mock.calls.length).toBe(2);
    expect(events.some((e) => (e as { type?: string }).type === "tool_refresh_retry")).toBe(false);

    await rm(root, { recursive: true, force: true });
  });

  it("截断参数在执行前拒绝且不写入文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncoder-truncated-"));
    const abs = join(root, "svc.java");
    const original = "interface Svc {\n    void keep();\n}\n";
    await writeFile(abs, original);
    const events: unknown[] = [];
    const ctx = makeCtx(root, events);

    const result = await executeTool(ctx, {
      id: "truncated-1",
      name: "apply_patch",
      arguments: {
        file_path: "svc.java",
        old_string: "void keep();",
        new_string: "void keep();\n    void partial(",
        _truncated: true,
      },
      rawArguments: '{"file_path":"svc.java","old_string":"void keep();","new_string":"void partial(\\"',
    });

    expect(result.ok).toBe(false);
    expect(await readFile(abs, "utf8")).toBe(original);
    expect(ctx.touchedPaths).toEqual([]);

    await rm(root, { recursive: true, force: true });
  });
  it("多目标歧义时不触发重读（重读无法补充上下文）", async () => {
    const root = await mkdtemp(join(tmpdir(), "owncoder-ambig-"));
    const abs = join(root, "svc.java");
    await writeFile(abs, "dup\ndup\n");
    const events: unknown[] = [];
    const ctx = makeCtx(root, events);

    const spy = vi.spyOn(fs, "readFile");

    const result = await executeTool(ctx, {
      id: "reread-3",
      name: "apply_patch",
      arguments: { file_path: "svc.java", old_string: "dup", new_string: "one" },
      rawArguments: "{}",
    });

    expect(result.ok).toBe(false);
    expect(spy.mock.calls.length).toBe(1);
    expect(events.some((e) => (e as { type?: string }).type === "tool_refresh_retry")).toBe(false);
    expect(await readFile(abs, "utf8")).toBe("dup\ndup\n");

    await rm(root, { recursive: true, force: true });
  });
});
