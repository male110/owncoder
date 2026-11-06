import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import { PARALLEL_SAFE_TOOLS } from "../enhanced-tools.ts";
import { createGlobMatcher, toolGlob } from "./glob.ts";
import type { ToolContext } from "./types.ts";

function stubIndex(): IndexClient {
  return {
    async open() {},
    async getTags() { return []; },
    async buildRepoMap() { return ""; },
    invalidate() {},
    async rebuildAll() {},
    status() { return { kind: "ready", fileCount: 0, tagCount: 0 }; },
  };
}

function ctxFor(root: string, extraIgnore: string[] = []): ToolContext {
  return {
    workspaceRoot: root,
    mode: "agent",
    workflow: { ...BUILTIN_WORKFLOW, index: { ...BUILTIN_WORKFLOW.index, extraIgnore } },
    index: stubIndex(),
    readSet: new Set(),
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
  };
}

async function withWorkspace(setup: (root: string) => Promise<void>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "owncoder-glob-"));
  try {
    await setup(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("glob finds workspace files and filters generated, dot, and gitignored paths", async () => {
  await withWorkspace(async root => {
    await writeFile(join(root, ".gitignore"), "secrets/\nignored.java\n");
    await writeFile(join(root, "TaskStudentPaperMarketEntity.java"), "class Entity {}\n");
    await writeFile(join(root, "ignored.java"), "class Ignored {}\n");
    await mkdir(join(root, "src", "nested"), { recursive: true });
    await writeFile(join(root, "src", "nested", "Other.java"), "class Other {}\n");
    await mkdir(join(root, "secrets"), { recursive: true });
    await writeFile(join(root, "secrets", "Hidden.java"), "class Hidden {}\n");
    await mkdir(join(root, "target"), { recursive: true });
    await writeFile(join(root, "target", "Generated.java"), "class Generated {}\n");
    await mkdir(join(root, ".hidden"), { recursive: true });
    await writeFile(join(root, ".hidden", "Dot.java"), "class Dot {}\n");
  }, async root => {
    const result = await toolGlob(ctxFor(root), "**/*.java", ".", 100);
    assert.equal(result.ok, true);
    assert.match(result.output, /TaskStudentPaperMarketEntity\.java/);
    assert.match(result.output, /src\/nested\/Other\.java/);
    assert.doesNotMatch(result.output, /ignored|secrets|target|\.hidden/);
  });
});

test("glob searches an explicitly specified gitignored directory", async () => {
  await withWorkspace(async root => {
    await writeFile(join(root, ".gitignore"), "secrets/\n");
    await mkdir(join(root, "secrets", "nested"), { recursive: true });
    await writeFile(join(root, "secrets", "Hidden.java"), "class Hidden {}\n");
    await writeFile(join(root, "secrets", "nested", "Deep.java"), "class Deep {}\n");
  }, async root => {
    const fromRoot = await toolGlob(ctxFor(root), "**/*.java", ".", 100);
    assert.doesNotMatch(fromRoot.output, /secrets/);
    const explicit = await toolGlob(ctxFor(root), "**/*.java", "secrets", 100);
    assert.equal(explicit.ok, true);
    assert.match(explicit.output, /secrets\/Hidden\.java/);
    assert.match(explicit.output, /secrets\/nested\/Deep\.java/);
  });
});

test("glob basename patterns match at any depth and respect extraIgnore", async () => {
  await withWorkspace(async root => {
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "Thing.java"), "");
    await writeFile(join(root, "keep.ts"), "");
    await mkdir(join(root, "tmp"), { recursive: true });
    await writeFile(join(root, "tmp", "drop.ts"), "");
  }, async root => {
    const java = await toolGlob(ctxFor(root), "*.java", ".", 100);
    assert.match(java.output, /a\/b\/Thing\.java/);
    const ts = await toolGlob(ctxFor(root, ["tmp/"]), "*.ts", ".", 100);
    assert.doesNotMatch(ts.output, /drop\.ts/);
    assert.match(ts.output, /keep\.ts/);
  });
});

test("glob matcher can explicitly require case-sensitive matches", () => {
  assert.equal(createGlobMatcher("*.ts", false)("Widget.TS", "Widget.TS"), false);
  assert.equal(createGlobMatcher("*.ts", true)("Widget.TS", "Widget.TS"), true);
});

test("glob matches paths case-insensitively by default", async () => {
  await withWorkspace(async root => {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "Widget.TS"), "");
  }, async root => {
    const result = await toolGlob(ctxFor(root), "**/*.ts", ".", 100);
    assert.equal(result.ok, true);
    assert.match(result.output, /src\/Widget\.TS/);
  });
});

test("glob is parallel-safe", () => {
  assert.equal(PARALLEL_SAFE_TOOLS.has("glob"), true);
});
