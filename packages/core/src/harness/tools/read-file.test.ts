import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import {
  WHOLE_FILE_READ_BYTES,
  toolRead,
  toolReadOutline,
  toolList,
} from "./fs.ts";
import type { ToolContext } from "./types.ts";
import { executeTool } from "../execute.ts";

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
        arguments: { path: ".", recursive: false },
        rawArguments: JSON.stringify({ path: ".", recursive: false }),
      });
      assert.equal(result.ok, true);
      assert.match(result.output, /actual\.txt/);
      assert.notEqual(result.output, JSON.stringify({ path: ".", recursive: false }));
    },
  );
});

test("list_dir dispatch preserves failure output", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-list-"));
  try {
    const result = await executeTool(ctxFor(root), {
      id: "missing-list-call",
      name: "list_dir",
      arguments: { path: "missing", recursive: false },
      rawArguments: JSON.stringify({ path: "missing", recursive: false }),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /Directory not found/);
    assert.notEqual(result.output, JSON.stringify({ path: "missing", recursive: false }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("whole-file read at or over 10KB is rejected and asks for read_outline; ranged reads still work", async () => {
  await withWorkspace(
    async (root) => {
      const body = `${"x".repeat(WHOLE_FILE_READ_BYTES)}\nline-two\n`;
      await writeFile(join(root, "mid.ts"), body);
    },
    async (root) => {
      const whole = await toolRead(ctxFor(root), "mid.ts");
      assert.equal(whole.ok, false);
      assert.match(whole.output, /Whole-file reads are limited/);
      assert.match(whole.output, /read_outline first/);

      const ranged = await toolRead(ctxFor(root), "mid.ts", 2, 1);
      assert.equal(ranged.ok, true);
      assert.match(ranged.output, /line-two/);
    },
  );
});
