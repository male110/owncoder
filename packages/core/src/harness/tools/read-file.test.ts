import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { getCodec } from "@owncoder/llm";
import type { IndexClient } from "@owncoder/index";
import {
  WHOLE_FILE_READ_BYTES,
  toolRead,
  toolReadOutline,
  toolList,
} from "./fs.ts";
import type { ToolContext } from "./types.ts";
import { executeTool } from "../execute.ts";
import { allEnhancedTools } from "../enhanced-tools.ts";

function stubIndex(): IndexClient {
  return {
    async open() {},
    async getTags() {
      return [];
    },
    async buildRepoMap() {
      return "";
    },
    invalidate() {},
    async rebuildAll() {},
    status() {
      return { kind: "ready", fileCount: 0, tagCount: 0 };
    },
  };
}

function ctxFor(root: string): ToolContext {
  return {
    workspaceRoot: root,
    mode: "plan",
    workflow: BUILTIN_WORKFLOW,
    index: stubIndex(),
    readSet: new Set(),
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
  };
}

async function withWorkspace(
  setup: (root: string) => Promise<void>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "owncoder-read-"));
  try {
    await setup(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("list_dir lists ordinary and recursive directories", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "nested"));
      await writeFile(join(root, "top.txt"), "top");
      await writeFile(join(root, "nested", "child.txt"), "child");
    },
    async (root) => {
      const flat = await toolList(ctxFor(root), ".", false);
      assert.equal(flat.ok, true);
      assert.match(flat.output, /top\.txt/);
      assert.doesNotMatch(flat.output, /nested[\\/]child\.txt/);

      const recursive = await toolList(ctxFor(root), ".", true);
      assert.equal(recursive.ok, true);
      assert.match(recursive.output, /nested[\\/]child\.txt/);
    },
  );
});

test("list_dir dispatch returns output instead of its arguments", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "actual.txt"), "actual");
    },
    async (root) => {
      const result = await executeTool(ctxFor(root), {
        id: "list-call",
        name: "list_dir",
        arguments: { file_path: ".", recursive: false },
        rawArguments: JSON.stringify({ file_path: ".", recursive: false }),
      });
      assert.equal(result.ok, true);
      assert.match(result.output, /actual\.txt/);
      assert.notEqual(result.output, JSON.stringify({ file_path: ".", recursive: false }));
    },
  );
});

test("list_dir dispatch preserves failure output", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-list-"));
  try {
    const result = await executeTool(ctxFor(root), {
      id: "missing-list-call",
      name: "list_dir",
      arguments: { file_path: "missing", recursive: false },
      rawArguments: JSON.stringify({ file_path: "missing", recursive: false }),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /Directory not found/);
    assert.notEqual(result.output, JSON.stringify({ file_path: "missing", recursive: false }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read_file 在访问文件前拒绝缺失路径和错误参数", async () => {
  const invalidArgs = [
    {}, { file_path: "" }, { file_path: "   " },
    { file_path: 123 }, { file_path: { name: "small.ts" } },
    { parameters: { file_path: "small.ts" } },
    { file_path: "small.ts", offset: "2", limit: 1 },
    { file_path: "small.ts", offset: 0 }, { file_path: "small.ts", offset: 1.5 },
    { file_path: "small.ts", limit: -1 }, { file_path: "small.ts", limit: null },
  ];
  for (const args of invalidArgs) {
    const ctx = ctxFor("unused-workspace");
    const result = await executeTool(ctx, {
      id: "invalid-read", name: "read_file", arguments: args,
      rawArguments: JSON.stringify(args),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /read_file 参数错误/);
    assert.equal(ctx.readSet.size, 0);
  }
});

test("read_file 执行入口接受正常路径和合法行范围", async () => {
  for (const mode of ["agent", "plan"] as const) {
    const tool = allEnhancedTools({ mode }).find((entry) => entry.function.name === "read_file");
    assert.deepEqual(tool?.function.parameters.required, ["file_path"]);
    const properties = tool?.function.parameters.properties as Record<string, unknown>;
    assert.ok(properties.file_path);
    assert.equal(properties.path, undefined);
  }
  await withWorkspace(
    async (root) => { await writeFile(join(root, "small.ts"), "first\nsecond\nthird"); },
    async (root) => {
      for (const args of [{ file_path: "small.ts" }, { file_path: "small.ts", offset: 2, limit: 1 }]) {
        const result = await executeTool(ctxFor(root), {
          id: "valid-read", name: "read_file", arguments: args,
          rawArguments: JSON.stringify(args),
        });
        assert.equal(result.ok, true);
        assert.match(result.output, /second/);
        if ("offset" in args) assert.doesNotMatch(result.output, /first|third/);
      }
    },
  );
});

test("两种反代协议保留实际读取工具说明和行范围参数", async () => {
  for (const mode of ["agent", "plan"] as const) {
    const tools = allEnhancedTools({ mode }).filter((tool) =>
      ["read_file", "read_outline", "read_symbol"].includes(tool.function.name),
    );
    assert.equal(tools.length, 3);
    for (const format of ["anthropic-messages", "openai-chat"] as const) {
      const body = await getCodec(format).encodeRequest({
        model: "claude-sonnet-4", messages: [{ role: "user", content: "读取目标文件" }],
        tools, stream: false,
      }) as { tools: Array<Record<string, any>> };
      for (const tool of tools) {
        const encoded = body.tools.find((entry) =>
          (format === "anthropic-messages" ? entry.name : entry.function.name) === tool.function.name,
        );
        assert.ok(encoded);
        const definition = format === "anthropic-messages" ? encoded : encoded.function;
        assert.equal(definition.description, tool.function.description);
        assert.deepEqual(format === "anthropic-messages" ? definition.input_schema : definition.parameters, tool.function.parameters);
      }
    }
  }
});

test("read_file 文件不存在时直接返回错误，不读取大纲", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      const ctx = ctxFor(root);
      const getTags = vi.spyOn(ctx.index, "getTags");
      const result = await executeTool(ctx, {
        id: "missing-read", name: "read_file",
        arguments: { file_path: "missing.ts" },
        rawArguments: JSON.stringify({ file_path: "missing.ts" }),
      });
      assert.equal(result.ok, false);
      assert.match(result.output, /File not found/);
      assert.doesNotMatch(result.output, /已自动尝试|head lines/);
      assert.equal(getTags.mock.calls.length, 0);
      assert.equal(ctx.readSet.size, 0);
    },
  );
});

test("whole-file read is allowed under 10KB", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "small.ts"), "export const ok = 1;\n");
    },
    async (root) => {
      const result = await toolRead(ctxFor(root), "small.ts");
      assert.equal(result.ok, true);
      assert.match(result.output, /export const ok = 1/);
    },
  );
});

test("read_outline returns structured metadata without a symbol cap", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "outline.ts"), "export const value = 1;\n");
    },
    async (root) => {
      const result = await toolReadOutline(ctxFor(root), "outline.ts");
      assert.equal(result.ok, true);
      assert.match(result.output, /file: outline\.ts/);
      assert.equal(result.metadata?.kind, "read_outline");
      if (result.metadata?.kind === "read_outline") {
        assert.equal(result.metadata.path, "outline.ts");
        assert.equal(result.metadata.outline, true);
        assert.equal(result.metadata.hasMore, false);
      }
    },
  );
});

test("whole-file read at or over 10KB is now allowed without limit", async () => {
  await withWorkspace(
    async (root) => {
      const body = `${"x".repeat(WHOLE_FILE_READ_BYTES)}\nline-two\n`;
      await writeFile(join(root, "mid.ts"), body);
    },
    async (root) => {
      const ctx = ctxFor(root);
      const whole = await toolRead(ctx, "mid.ts");
      assert.equal(whole.ok, true);
      assert.ok(whole.output.includes("x".repeat(100))); // 验证大文件内容确实被读取
      assert.match(whole.output, /line-two/);
      assert.equal(ctx.readSet.size, 1);

      const ranged = await toolRead(ctx, "mid.ts", 2, 1);
      assert.equal(ranged.ok, true);
      assert.match(ranged.output, /line-two/);
    },
  );
});

test("CSS 大文件可以整读成功；按行读取也能正常工作", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "styles.css"), Array.from({ length: 400 }, (_, i) => `.item-${i} { color: red; padding: 10px; }`).join("\n"));
    },
    async (root) => {
      const ctx = ctxFor(root);
      const result = await executeTool(ctx, { id: "whole-read", rawArguments: '{}', name: "read_file", arguments: { file_path: "styles.css" } });
      assert.equal(result.ok, true);
      assert.match(result.output, /\.item-0/);
      assert.match(result.output, /\.item-399/);
      assert.equal(result.metadata?.kind, "read_file");
      
      const recovered = await executeTool(ctx, { id: "ranged", rawArguments: '{}', name: "read_file", arguments: { file_path: "styles.css", offset: 100, limit: 2 } });
      assert.equal(recovered.ok, true);
      assert.equal(recovered.metadata?.kind, "read_file");
      assert.match(recovered.output, /item-99/);
      assert.doesNotMatch(recovered.output, /item-101/);
    },
  );
});
