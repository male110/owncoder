import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import { PARALLEL_SAFE_TOOLS } from "../enhanced-tools.ts";
import { GREP_MAX_FILE_BYTES, toolGrep } from "./fs.ts";
import type { ToolContext } from "./types.ts";

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

function ctxFor(root: string, extraIgnore: string[] = []): ToolContext {
  return {
    workspaceRoot: root,
    mode: "plan",
    workflow: {
      ...BUILTIN_WORKFLOW,
      index: { ...BUILTIN_WORKFLOW.index, extraIgnore },
    },
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
  const root = await mkdtemp(join(tmpdir(), "owncoder-grep-"));
  try {
    await setup(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("grep finds matches without loading skipped trees", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "app.ts"), "export const needle = 1;\n");
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(root, "node_modules", "pkg", "index.js"), "export const needle = 2;\n");
      await mkdir(join(root, "out"), { recursive: true });
      await writeFile(join(root, "out", "bundle.js"), "const needle = 3;\n");
      await mkdir(join(root, "coverage"), { recursive: true });
      await writeFile(join(root, "coverage", "lcov.info"), "needle\n");
      await mkdir(join(root, ".hidden", "nested"), { recursive: true });
      await writeFile(join(root, ".hidden", "nested", "secret.ts"), "export const needle = 4;\n");
      await mkdir(join(root, ".next"), { recursive: true });
      await writeFile(join(root, ".next", "cache.js"), "const needle = 5;\n");
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "needle", ".", 40);
      assert.equal(result.ok, true);
      assert.match(result.output, /app\.ts:1:/);
      assert.doesNotMatch(result.output, /node_modules/);
      assert.doesNotMatch(result.output, /out[/\\]/);
      assert.doesNotMatch(result.output, /coverage/);
      assert.doesNotMatch(result.output, /\.hidden/);
      assert.doesNotMatch(result.output, /\.next/);
    },
  );
});

test("grep skips gitignored files, lockfiles, binaries, and oversized files", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, ".gitignore"), "ignored/\nsecret.log\n");
      await writeFile(join(root, "keep.ts"), "findme in source\n");
      await mkdir(join(root, "ignored"), { recursive: true });
      await writeFile(join(root, "ignored", "skip.ts"), "findme in ignored\n");
      await writeFile(join(root, "secret.log"), "findme in gitignore\n");
      await writeFile(join(root, "pnpm-lock.yaml"), "findme in lockfile\n");
      await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 70, 105, 110, 100, 109, 101]));
      const oversized = Buffer.alloc(GREP_MAX_FILE_BYTES + 8, 0x61);
      oversized.set(Buffer.from("findme oversized\n"), 0);
      await writeFile(join(root, "huge.txt"), oversized);
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "findme", ".", 40);
      assert.equal(result.ok, true);
      assert.match(result.output, /keep\.ts:1:/);
      assert.doesNotMatch(result.output, /ignored/);
      assert.doesNotMatch(result.output, /secret\.log/);
      assert.doesNotMatch(result.output, /pnpm-lock/);
      assert.doesNotMatch(result.output, /blob\.bin/);
      assert.doesNotMatch(result.output, /huge\.txt/);
    },
  );
});

test("grep 能从工作区根目录检索超过六层目录中的 39KB 源码", async () => {
  const relativeDir = "src/features/domain/services/internal/handlers/nested";
  const method = "loadDeepWorkspaceData";
  await withWorkspace(
    async (root) => {
      const dir = join(root, relativeDir);
      await mkdir(dir, { recursive: true });
      const declaration = `export function ${method}() {}\n`;
      const content = declaration + " ".repeat(39 * 1024 - Buffer.byteLength(declaration));
      await writeFile(join(dir, "service.ts"), content);
    },
    async (root) => {
      const ctx = ctxFor(root);
      const direct = await toolGrep(ctx, method, `${relativeDir}/service.ts`, 40);
      assert.equal(direct.ok, true);
      assert.match(direct.output, /service\.ts:1:/);
      const recursive = await toolGrep(ctx, method, ".", 40);
      assert.equal(recursive.ok, true);
      assert.equal(recursive.output, direct.output);
    },
  );
});

test("grep respects extraIgnore from workflow index settings", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "src.ts"), "token\n");
      await mkdir(join(root, "tmp"), { recursive: true });
      await writeFile(join(root, "tmp", "scratch.ts"), "token\n");
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root, ["tmp/"]), "token", ".", 40);
      assert.equal(result.ok, true);
      assert.match(result.output, /src\.ts:1:/);
      assert.doesNotMatch(result.output, /scratch\.ts/);
    },
  );
});

test("grep is not parallel-safe so workspace scans do not pile up", () => {
  assert.equal(PARALLEL_SAFE_TOOLS.has("grep"), false);
  assert.equal(PARALLEL_SAFE_TOOLS.has("search_symbols"), true);
});
