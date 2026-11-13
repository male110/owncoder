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
    mode: "spec",
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

test("grep caps hits at maxResults and marks the result truncated", async () => {
  await withWorkspace(
    async (root) => {
      const lines = Array.from({ length: 10 }, (_, i) => `const v${i} = "needle";`).join("\n");
      await writeFile(join(root, "many.ts"), `${lines}\n`);
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "needle", ".", 3);
      assert.equal(result.ok, true);
      const hitLines = result.output.split("\n").filter((l) => /many\.ts:/.test(l));
      assert.equal(hitLines.length, 3);
      assert.match(result.output, /result truncated/);
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

test("grep searches an explicitly specified gitignored directory", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, ".gitignore"), "ignored/\n");
      await writeFile(join(root, "keep.ts"), "findme in source\n");
      await mkdir(join(root, "ignored", "nested"), { recursive: true });
      await writeFile(join(root, "ignored", "skip.ts"), "findme in ignored\n");
      await writeFile(join(root, "ignored", "nested", "deep.ts"), "findme in nested\n");
    },
    async (root) => {
      const fromRoot = await toolGrep(ctxFor(root), "findme", ".", 40);
      assert.equal(fromRoot.ok, true);
      assert.doesNotMatch(fromRoot.output, /ignored/);
      const explicit = await toolGrep(ctxFor(root), "findme", "ignored", 40);
      assert.equal(explicit.ok, true);
      assert.match(explicit.output, /ignored[/\\]skip\.ts:1:/);
      assert.match(explicit.output, /ignored[/\\]nested[/\\]deep\.ts:1:/);
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

test("grep is parallel-safe like glob so independent searches can batch", () => {
  assert.equal(PARALLEL_SAFE_TOOLS.has("grep"), true);
  assert.equal(PARALLEL_SAFE_TOOLS.has("glob"), true);
  assert.equal(PARALLEL_SAFE_TOOLS.has("search_symbols"), true);
  assert.equal(PARALLEL_SAFE_TOOLS.has("search_semantic"), true);
});

test("grep output_mode=files_with_matches returns paths only", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "a.ts"), "needle\n");
      await writeFile(join(root, "b.js"), "needle\n");
      await writeFile(join(root, "c.txt"), "nothing here\n");
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "needle", ".", 40, {
        outputMode: "files_with_matches",
      });
      assert.equal(result.ok, true);
      const lines = result.output.split("\n");
      assert.ok(lines.includes("a.ts"));
      assert.ok(lines.includes("b.js"));
      assert.ok(!lines.includes("c.txt"));
      for (const line of lines) {
        assert.equal(/:\d+:/.test(line), false, `files_with_matches must not emit line numbers: ${line}`);
      }
      assert.equal(result.output.includes("No files found"), false);
    },
  );
});

test("grep output_mode=count returns per-file match counts", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "a.ts"), "needle\nneedle\nneedle\n");
      await writeFile(join(root, "b.js"), "needle\n");
      await writeFile(join(root, "c.txt"), "nothing here\n");
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "needle", ".", 40, { outputMode: "count" });
      assert.equal(result.ok, true);
      const lines = result.output.split("\n");
      assert.ok(lines.includes("a.ts:3"));
      assert.ok(lines.includes("b.js:1"));
      assert.ok(!lines.some((l) => l.startsWith("c.txt")));
    },
  );
});

test("grep glob filter narrows candidates", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "needle\n");
      await writeFile(join(root, "src", "b.js"), "needle\n");
      await writeFile(join(root, "c.ts"), "needle\n");
    },
    async (root) => {
      const tsOnly = await toolGrep(ctxFor(root), "needle", ".", 40, { glob: "*.ts" });
      assert.equal(tsOnly.ok, true);
      assert.match(tsOnly.output, /src\/a\.ts:1:/);
      assert.match(tsOnly.output, /c\.ts:1:/);
      assert.doesNotMatch(tsOnly.output, /b\.js/);

      const jsUnderSrc = await toolGrep(ctxFor(root), "needle", ".", 40, { glob: "src/*.js" });
      assert.equal(jsUnderSrc.ok, true);
      assert.match(jsUnderSrc.output, /src\/b\.js:1:/);
      assert.doesNotMatch(jsUnderSrc.output, /a\.ts|c\.ts/);
    },
  );
});

test("grep glob filters match case-insensitively by default", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "Widget.TS"), "needle\n");
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "needle", ".", 40, { glob: "*.ts" });
      assert.equal(result.ok, true);
      assert.match(result.output, /Widget\.TS:1:/);
    },
  );
});

test("grep type filter matches known aliases and unknown extensions", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "a.ts"), "needle\n");
      await writeFile(join(root, "b.tsx"), "needle\n");
      await writeFile(join(root, "c.js"), "needle\n");
      await writeFile(join(root, "d.sql"), "needle\n");
    },
    async (root) => {
      const ts = await toolGrep(ctxFor(root), "needle", ".", 40, { type: "ts" });
      assert.equal(ts.ok, true);
      assert.match(ts.output, /a\.ts:1:/);
      assert.match(ts.output, /b\.tsx:1:/);
      assert.doesNotMatch(ts.output, /c\.js|d\.sql/);

      const sql = await toolGrep(ctxFor(root), "needle", ".", 40, { type: "sql" });
      assert.equal(sql.ok, true);
      assert.match(sql.output, /d\.sql:1:/);
      assert.doesNotMatch(sql.output, /a\.ts|b\.tsx|c\.js/);
    },
  );
});

test("grep ignores case by default and -i:false enables exact matching", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "mixed.ts"), "Needle here\nneedle there\n");
    },
    async (root) => {
      const insensitive = await toolGrep(ctxFor(root), "needle", ".", 40);
      assert.equal(insensitive.ok, true);
      assert.equal((insensitive.output.match(/mixed\.ts:\d+:/g) ?? []).length, 2);

      const exact = await toolGrep(ctxFor(root), "needle", ".", 40, { ignoreCase: false });
      assert.equal(exact.ok, true);
      assert.match(exact.output, /mixed\.ts:2:/);
      assert.equal((exact.output.match(/mixed\.ts:\d+:/g) ?? []).length, 1);
    },
  );
});

test("grep -A/-B/-C context lines fold overlapping windows without duplicates", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "ctx.ts"), "line0\nfindMe\nline2\nline3\nfindMe\nline5\n");
    },
    async (root) => {
      const overlap = await toolGrep(ctxFor(root), "findMe", ".", 40, { context: 2 });
      assert.equal(overlap.ok, true);
      const hits = overlap.output.split("\n").filter((l) => /ctx\.ts:/.test(l));
      // 两条匹配各带 2 行上下文，窗口重叠后折叠为 1-6 行连续输出，无重复行号
      assert.deepEqual(
        hits.map((l) => l.slice("ctx.ts:".length).split(":")[0]),
        ["1", "2", "3", "4", "5", "6"],
      );

      const ab = await toolGrep(ctxFor(root), "findMe", ".", 40, { beforeContext: 1, afterContext: 1 });
      assert.equal(ab.ok, true);
      const abHits = ab.output.split("\n").filter((l) => /ctx\.ts:/.test(l));
      assert.deepEqual(
        abHits.map((l) => l.slice("ctx.ts:".length).split(":")[0]),
        ["1", "2", "3", "4", "5", "6"],
      );
    },
  );
});

test("grep -o prints only matched parts", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "tokens.ts"), 'const a = "abc123";\nconst b = "abc456";\nplain\n');
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "abc\\d+", ".", 40, { onlyMatching: true });
      assert.equal(result.ok, true);
      const lines = result.output.split("\n").filter((l) => /tokens\.ts:/.test(l));
      assert.deepEqual(lines, ["tokens.ts:1:abc123", "tokens.ts:2:abc456"]);
    },
  );
});

test("grep multiline matches patterns spanning lines", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "multi.ts"), 'fetchData(\n  "http://example.com"\n)\n');
    },
    async (root) => {
      const disabled = await toolGrep(ctxFor(root), "fetchData\\(.*?\\)", ".", 40);
      assert.equal(disabled.ok, true);
      assert.equal(disabled.output, "No matches");

      const enabled = await toolGrep(ctxFor(root), "fetchData\\(.*?\\)", ".", 40, { multiline: true });
      assert.equal(enabled.ok, true);
      const lines = enabled.output.split("\n").filter((l) => /multi\.ts:/.test(l));
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /^multi\.ts:1:fetchData\($/);
    },
  );
});

test("grep -n:false omits line numbers", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "app.ts"), "export const needle = 1;\n");
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "needle", ".", 40, { showLineNumbers: false });
      assert.equal(result.ok, true);
      assert.match(result.output, /^app\.ts:export const needle = 1;$/);
      assert.doesNotMatch(result.output, /app\.ts:\d+:/);
    },
  );
});

test("grep head_limit + offset paginate results", async () => {
  await withWorkspace(
    async (root) => {
      const lines = Array.from({ length: 10 }, (_, i) => `const v${i} = "needle";`).join("\n");
      await writeFile(join(root, "many.ts"), `${lines}\n`);
    },
    async (root) => {
      const page1 = await toolGrep(ctxFor(root), "needle", ".", 40, { headLimit: 3, offset: 2 });
      assert.equal(page1.ok, true);
      const page1Lines = page1.output.split("\n").filter((l) => /many\.ts:/.test(l));
      assert.deepEqual(
        page1Lines.map((l) => l.slice("many.ts:".length).split(":")[0]),
        ["3", "4", "5"],
      );

      const unlimited = await toolGrep(ctxFor(root), "needle", ".", 40, { headLimit: 0 });
      assert.equal(unlimited.ok, true);
      assert.equal((unlimited.output.match(/many\.ts:\d+:/g) ?? []).length, 10);
      assert.doesNotMatch(unlimited.output, /result truncated/);
    },
  );
});

test("grep rejects invalid output_mode and non-integer head_limit", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "app.ts"), "needle\n");
    },
    async (root) => {
      const badMode = await toolGrep(ctxFor(root), "needle", ".", 40, {
        outputMode: "bogus" as "content",
      });
      assert.equal(badMode.ok, false);
      assert.match(badMode.output, /output_mode/);

      const badLimit = await toolGrep(ctxFor(root), "needle", ".", 40, {
        headLimit: -1,
      });
      assert.equal(badLimit.ok, false);
      assert.match(badLimit.output, /head_limit/);
    },
  );
});

test("grep redacts matched and context lines in sensitive files", async () => {
  const secret = "sk-proj-abcdefghijklmnopqrst0123456789";
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "application.properties"), `api.key=${secret}\nother=plain\n`);
    },
    async (root) => {
      const result = await toolGrep(ctxFor(root), "sk-proj", ".", 40, { context: 1 });
      assert.equal(result.ok, true);
      assert.match(result.output, /\*\*\*/);
      assert.equal(result.output.includes(secret), false);
      // 上下文行不属于敏感内容，原样保留
      assert.match(result.output, /other=plain/);
      assert.match(result.output, /application\.properties:1:api\.key=/);
    },
  );
});
