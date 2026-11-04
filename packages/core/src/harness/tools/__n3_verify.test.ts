import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import { toolRunScript } from "./run-script.ts";
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

function ctxFor(root: string): ToolContext {
  return {
    workspaceRoot: root,
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    index: stubIndex(),
    readSet: new Set(),
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
  };
}

// 用户原始脚本（root 换成环境变量注入的临时工作区根）
const USER_SCRIPT = `const fs = require('fs');
const path = require('path');
const root = process.env.ROOT_DIR;
function walk(dir, out, depth=0){
  let entries;
  try { entries = fs.readdirSync(dir, {withFileTypes:true}); } catch(e){ return; }
  for (const e of entries){
    const p = path.join(dir, e.name);
    if (e.isDirectory()){
      if (['node_modules','.git','dist','build','vendor','.next','target','out','coverage','.owncoder'].includes(e.name)) continue;
      walk(p, out, depth+1);
    } else {
      out.push(p);
    }
  }
}
const files = [];
walk(root, files);
console.log('total files:', files.length);
console.log(files.slice(0, 200).join('\\n'));
`;

test("n3-verify: 用户原始目录遍历脚本（含 fs.readdirSync + require('fs')）", async () => {
  const root = join(tmpdir(), "owncoder-n3-verify-" + Date.now().toString(36));
  await mkdir(join(root, "src", "deep"), { recursive: true });
  await writeFile(join(root, "README.md"), "# hi\n");
  await writeFile(join(root, "src", "a.ts"), "const a = 1;\n");
  await writeFile(join(root, "src", "deep", "b.ts"), "const b = 2;\n");
  const ctx = ctxFor(root);
  const code = `const process = { env: { ROOT_DIR: ${JSON.stringify(root)} } };\n` + USER_SCRIPT;
  const result = await toolRunScript(ctx, code);
  console.log("=== RESULT ok:", result.ok);
  console.log("=== OUTPUT (first 1500 chars):");
  console.log(result.output.slice(0, 1500));
  assert.equal(result.ok, true, result.output);
  // 不再报"拒绝执行"
  assert.doesNotMatch(result.output, /拒绝执行/);
  // 目录遍历结果：3 个文件（README.md、src/a.ts、src/deep/b.ts）
  assert.match(result.output, /total files: 3/);
  assert.match(result.output, /README\.md/);
  assert.match(result.output, /src\/a\.ts/);
  assert.match(result.output, /src\/deep\/b\.ts/);
  // 自动改写注记
  assert.match(result.output, /已自动改写/);
});

test("n3-verify: 普通无 fs 脚本（纯算术/字符串处理）未回归", async () => {
  const root = join(tmpdir(), "owncoder-n3-verify-nofs-" + Date.now().toString(36));
  await mkdir(root, { recursive: true });
  const ctx = ctxFor(root);
  const code = `
    const s = "hello world";
    const n = [1, 2, 3, 4].reduce((a, b) => a + b, 0);
    console.log("upper=" + s.toUpperCase());
    console.log("sum=" + n);
  `;
  const result = await toolRunScript(ctx, code);
  console.log("=== RESULT ok:", result.ok);
  console.log("=== OUTPUT:", result.output.slice(0, 500));
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /upper=HELLO WORLD/);
  assert.match(result.output, /sum=10/);
});

test("n3-verify: readdirSync 无 withFileTypes 选项（返回字符串数组）", async () => {
  const root = join(tmpdir(), "owncoder-n3-verify-plain-" + Date.now().toString(36));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "a.txt"), "x\n");
  await writeFile(join(root, "src", "b.ts"), "y\n");
  const ctx = ctxFor(root);
  const code = `
    const fs = require('fs');
    const names = fs.readdirSync('.');
    console.log('names=' + names.sort().join(','));
  `;
  const result = await toolRunScript(ctx, code);
  console.log("=== RESULT ok:", result.ok);
  console.log("=== OUTPUT:", result.output.slice(0, 800));
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /names=a\.txt,src/);
});

test("n3-verify: 写操作仍被拒绝（fs.writeFileSync 不改写）", async () => {
  const root = join(tmpdir(), "owncoder-n3-verify-write-" + Date.now().toString(36));
  await mkdir(root, { recursive: true });
  const ctx = ctxFor(root);
  const code = `
    const fs = require('fs');
    fs.writeFileSync('b.txt', 'data');
  `;
  const result = await toolRunScript(ctx, code);
  console.log("=== RESULT ok:", result.ok);
  console.log("=== OUTPUT (first 400):", result.output.slice(0, 400));
  assert.equal(result.ok, false, result.output);
  assert.match(result.output, /拒绝执行/);
});
