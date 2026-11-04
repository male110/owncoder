import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import { allEnhancedTools } from "../enhanced-tools.ts";
import { executeTool } from "../execute.ts";
import { toolRunScript } from "./run-script.ts";
import { EXPLORE_SUBAGENT_ALLOWED_TOOLS } from "../subagent/explore-subagent.ts";
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

async function withWorkspace(
  setup: (root: string) => Promise<void>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "owncoder-run-script-"));
  try {
    await setup(root);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("run_script executes JS and returns console output", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const result = await toolRunScript(ctxFor(root), 'console.log("hello", 1 + 2);');
    assert.equal(result.ok, true);
    assert.match(result.output, /hello 3/);
    assert.match(result.output, /run_script: 0 次工具调用/);
  });
});

test("run_script aggregates multiple read_file calls and prints only the summary", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "line1\nline2\nline3\n");
      await writeFile(join(root, "src", "b.ts"), "only\n");
      // 干扰项：一个大文件，其内容绝不应进入返回结果
      await writeFile(join(root, "src", "big.ts"), "x".repeat(50_000) + "\n");
    },
    async (root) => {
      const code = `
        let total = 0;
        for (const f of ["src/a.ts", "src/b.ts", "src/big.ts"]) {
          const r = await tools.call("read_file", { file_path: f });
          if (!r.ok) throw new Error("read failed: " + f);
          total += r.output.split("\\n").length;
        }
        console.log("total lines:", total);
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /total lines:/);
      // 大文件的内容没有泄漏进对话
      assert.doesNotMatch(result.output, /x{100}/);
      assert.match(result.output, /run_script: 3 次工具调用/);
    },
  );
});

test("run_script can call bash", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "list.txt"), "alpha\nbeta\ngamma\n");
    },
    async (root) => {
      const code = `
        const r = await tools.call("bash", { command: "echo done" });
        console.log("ok=" + r.ok, "|", r.output.trim());
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /ok=true/);
    },
  );
});

test("Explore scripts see exactly the tools this role was given", async () => {
  await withWorkspace(async root => {
    await writeFile(join(root, "source.ts"), "const relevant = 1;\nconst unrelated = 2;\n");
  }, async root => {
    for (const mode of ["agent", "spec"] as const) {
      const ctx = ctxFor(root);
      ctx.mode = mode;
      const allowed = new Set(EXPLORE_SUBAGENT_ALLOWED_TOOLS);
      ctx.availableTools = new Set(allEnhancedTools({ mode, enableWebSearch: false }).filter(t => allowed.has(t.function.name)).map(t => t.function.name));
      const result = await toolRunScript(ctx, `
        console.log("TOOLS=" + JSON.stringify(tools.list()));
        const r = await tools.call("read_file", { file_path: "source.ts" });
        if (!r.ok) throw new Error(r.output);
        console.log(r.output.split("\\n").filter(l => l.includes("relevant = 1")).join("\\n"));
      `);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /relevant = 1/);
      assert.doesNotMatch(result.output, /unrelated = 2/);
      const listed = JSON.parse(result.output.split("\n")[0]!.slice("TOOLS=".length)) as string[];
      assert.ok(listed.includes("read_file"));
      for (const name of ["bash", "web_fetch", "web_search", "recall_history", "list_memories", "type_check", "run_script"]) {
        assert.ok(!listed.includes(name), name);
      }
    }
  });
});

test("tools.list falls back to empty when availableTools is absent", async () => {
  await withWorkspace(async () => {}, async root => {
    const result = await toolRunScript(ctxFor(root), "console.log(JSON.stringify(tools.list()));");
    assert.equal(result.ok, true);
    assert.match(result.output, /^\[\]/);
  });
});

test("run_script refuses recursive calls of itself", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const result = await toolRunScript(ctxFor(root), `
      try {
        await tools.call("run_script", { code: "console.log(1)" });
        console.log("SHOULD_NOT_PASS");
      } catch (e) {
        console.log("refused:", e instanceof Error ? e.message : e);
      }
    `);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.output, /SHOULD_NOT_PASS/);
    assert.match(result.output, /refused:/);
  });
});

test("run_script reports tool failure without throwing", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const code = `
      const r = await tools.call("read_file", { file_path: "definitely-missing.ts" });
      console.log("ok=" + r.ok);
    `;
    const result = await toolRunScript(ctxFor(root), code);
    assert.equal(result.ok, true);
    assert.match(result.output, /ok=false/);
  });
});

test("run_script fails with the script error message", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const result = await toolRunScript(ctxFor(root), 'throw new Error("boom");');
    assert.equal(result.ok, false);
    assert.match(result.output, /Error: boom/);
  });
});

test("run_script rejects broken syntax up front", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const result = await toolRunScript(ctxFor(root), "const x = ;");
    assert.equal(result.ok, false);
    assert.match(result.output, /语法错误/);
  });
});

test("run_script rejects truncated payload before vm compilation", async () => {
  await withWorkspace(async () => {}, async (root) => {
    // 模拟 code 参数在字符串中间被截断（输出 token 上限）
    const result = await toolRunScript(ctxFor(root), 'const s = "truncated mid');
    assert.equal(result.ok, false);
    assert.match(result.output, /载荷未完整到达/);
    assert.match(result.output, /从未闭合/);
    assert.match(result.output, /问题位置：第 1 行/);
    assert.match(result.output, /附近原文/);
    // 修复建议：拆分多步 + 引号配对自检
    assert.match(result.output, /每步 code 不超过 200 字符/);
  });
});

test("run_script rejects unclosed-bracket payload before vm compilation", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const result = await toolRunScript(ctxFor(root), 'const o = {"a": 1');
    assert.equal(result.ok, false);
    assert.match(result.output, /载荷未完整到达/);
    assert.match(result.output, /没有闭合/);
  });
});

test("run_script stops on timeout and returns partial output", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const code = `
      for (let i = 0; i < 10; i++) {
        await sleep(60);
        console.log("tick", i);
      }
      console.log("done");
    `;
    const result = await toolRunScript(ctxFor(root), code, { timeoutMs: 200 });
    assert.equal(result.ok, false);
    assert.match(result.output, /超时/);
    assert.match(result.output, /tick/);
    assert.doesNotMatch(result.output, /done/);
  });
});

test("run_script rejects non-object args", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const code = `
      try {
        await tools.call("read_file", ["not", "an", "object"]);
        console.log("SHOULD_NOT_PASS");
      } catch (e) {
        console.log("refused");
      }
    `;
    const result = await toolRunScript(ctxFor(root), code);
    assert.equal(result.ok, true);
    assert.doesNotMatch(result.output, /SHOULD_NOT_PASS/);
    assert.match(result.output, /refused/);
  });
});

test("run_script works via executeTool dispatch", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "count.ts"), "a\nb\nc\n");
    },
    async (root) => {
      const result = await executeTool(ctxFor(root), {
        id: "t1",
        name: "run_script",
        arguments: {
          code: 'const r = await tools.call("read_file", { file_path: "count.ts" }); console.log("lines", r.output.split("\\n").length);',
        },
        rawArguments: "{}",
      });
      assert.equal(result.ok, true);
      assert.match(result.output, /lines/);
    },
  );
});

test("executeTool rejects empty run_script code", async () => {
  await withWorkspace(async () => {}, async (root) => {
    const result = await executeTool(ctxFor(root), {
      id: "t2",
      name: "run_script",
      arguments: { code: "  " },
      rawArguments: "{}",
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /参数错误/);
  });
});

test("run_script tool is registered for both modes", async () => {
  const agentTools = allEnhancedTools({ mode: "agent" });
  const planTools = allEnhancedTools({ mode: "spec" });
  assert.ok(agentTools.some((t) => t.function.name === "run_script"));
  assert.ok(planTools.some((t) => t.function.name === "run_script"));
});

test("run_script code 参数描述携带防截断、搜索工具和路径纪律", () => {
  const def = allEnhancedTools({ mode: "agent" }).find(t => t.function.name === "run_script")!;
  const codeDesc = (def.function.parameters as { properties: { code?: { description?: string } } }).properties.code?.description ?? "";
  for (const text of [
    "引号配对",
    "引号总数为偶数",
    "每步 code 不超过 200 字符",
    "Unexpected token",
    "tools.call(\"glob\"",
    "tools.call(\"grep\"",
    ".gitignore",
    "/workspace",
    "/e/...",
  ]) {
    assert.ok(codeDesc.includes(text), text);
  }
});

test("executeTool exposes grep and glob as controlled workspace searches", async () => {
  await withWorkspace(async root => {
    await writeFile(join(root, ".gitignore"), "ignored.java\n");
    await writeFile(join(root, "TaskStudentPaperMarketEntity.java"), "class TaskStudentPaperMarketEntity {}\n");
    await writeFile(join(root, "ignored.java"), "class TaskStudentPaperMarketEntity {}\n");
  }, async root => {
    const ctx = ctxFor(root);
    ctx.availableTools = new Set(["grep", "glob"]);
    const glob = await executeTool(ctx, {
      id: "glob-test",
      name: "glob",
      arguments: { pattern: "**/*TaskStudentPaperMarketEntity.java" },
      rawArguments: "{}",
    });
    assert.equal(glob.ok, true, glob.output);
    assert.match(glob.output, /TaskStudentPaperMarketEntity\.java/);
    assert.doesNotMatch(glob.output, /ignored\.java/);

    const grep = await executeTool(ctx, {
      id: "grep-test",
      name: "grep",
      arguments: { pattern: "TaskStudentPaperMarketEntity", output_mode: "files_with_matches" },
      rawArguments: "{}",
    });
    assert.equal(grep.ok, true, grep.output);
    assert.match(grep.output, /TaskStudentPaperMarketEntity\.java/);
    assert.doesNotMatch(grep.output, /ignored\.java/);

    const blankPath = await executeTool(ctx, {
      id: "glob-blank-path-test",
      name: "glob",
      arguments: { pattern: "**/*TaskStudentPaperMarketEntity.java", file_path: "   " },
      rawArguments: "{}",
    });
    assert.equal(blankPath.ok, true, blankPath.output);
    assert.match(blankPath.output, /TaskStudentPaperMarketEntity\.java/);
  });
});

test("经典用法：find 列文件 + 循环 read_file 统计全仓库代码行数", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "a\nb\nc\n");
      await writeFile(join(root, "src", "b.ts"), "x\ny\n");
      await writeFile(join(root, "src", "c.ts"), "z\n");
      await writeFile(join(root, "README.md"), "not ts\n");
    },
    async (root) => {
      const code = `
        const files = await tools.call("glob", { pattern: "src/**/*.ts", file_path: "." });
        // glob 输出每行是一个 workspace-relative 路径；截断提示行不带 .ts 后缀，按后缀过滤掉
        const list = files.output.split("\\n").map(s => s.trim()).filter(l => l.endsWith(".ts"));
        let total = 0;
        for (const f of list) {
          const r = await tools.call("read_file", { file_path: f });
          // read_file 输出首行是 "[lines 1-N of T]"，T 即文件总行数
          const m = r.output.match(/of (\\d+)\\]/);
          if (m) total += Number(m[1]);
        }
        console.log(list.length + " ts files, " + total + " lines");
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      // 4 + 3 + 2（末尾换行各贡献一行）
      assert.match(result.output, /3 ts files, 9 lines/);
    },
  );
});

test("经典用法：Promise.all 并行取数", async () => {
  await withWorkspace(
    async (root) => {
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ dependencies: { vue: "1", zustand: "2" } }) + "\n",
      );
      await writeFile(join(root, "README.md"), "# Title\n## Section\nbody\n");
    },
    async (root) => {
      const code = `
        const [pkg, outline] = await Promise.all([
          tools.call("read_file", { file_path: "package.json" }),
          tools.call("read_outline", { file_path: "README.md" }),
        ]);
        // read_file 的每行带 "N|" 前缀，剥掉再解析
        const body = pkg.output.split("\\n").map(l => l.replace(/^\\s*\\d+\\|/, "")).slice(1).join("\\n");
        const deps = Object.keys(JSON.parse(body).dependencies).length;
        const headings = outline.output.split("\\n").filter(l => l.includes("#")).length;
        console.log("deps=" + deps + " headings=" + headings);
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /deps=2 headings=2/);
    },
  );
});

test("经典用法：读大测试输出文件，JS 过滤归类出失败项", async () => {
  const lines: string[] = [];
  for (let i = 0; i < 800; i++) lines.push("PASS test " + i);
  lines.push("FAIL test 800 expected true got false");
  lines.push("FAIL test 801 timeout");
  const fixture = lines.join("\n");
  await withWorkspace(
    async (root) => {
      await writeFile(join(root, "test-output.txt"), fixture);
    },
    async (root) => {
      const code = `
        const r = await tools.call("read_file", { file_path: "test-output.txt" });
        // read_file 每行带 "N|" 前缀，先剥掉再匹配标记
        const all = r.output.split("\\n").map(l => l.replace(/^\\s*\\d+\\|/, ""));
        const passed = all.filter(l => l.startsWith("PASS")).length;
        const failed = all.filter(l => l.startsWith("FAIL"));
        console.log("passed=" + passed + " failed=" + failed.length);
        for (const f of failed) console.log("  - " + f);
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /passed=800 failed=2/);
      assert.match(result.output, /- FAIL test 800 expected true got false/);
      // 800 行原文没有泄漏进对话
      assert.doesNotMatch(result.output, /PASS test 500/);
    },
  );
});

test("经典用法：grep count 模式输出二次加工取 Top N", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "a.ts"), "TODO one\nTODO two\nTODO three\n");
      await writeFile(join(root, "src", "b.ts"), "TODO one\n");
    },
    async (root) => {
      const code = `
        const r = await tools.call("grep", { pattern: "TODO", file_path: "src", glob: "*.ts", output_mode: "count", ignore_case: false });
        // count 模式每行形如 "src/a.ts:3"，直接解析
        const rows = r.output.split("\\n")
          .map(l => l.match(/^(.+?):(\\d+)$/))
          .filter(Boolean)
          .map(m => ({ file: m[1], count: Number(m[2]) }))
          .sort((a, b) => b.count - a.count);
        console.log(rows.map(r => r.file + "=" + r.count).join(", "));
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /src\/a\.ts=3, src\/b\.ts=1/);
    },
  );
});

test("经典用法：工具失败时换备用路径重试", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "pkg"), { recursive: true });
      await writeFile(join(root, "pkg", "index.ts"), "export const x = 1;\n");
    },
    async (root) => {
      const code = `
        let content = null;
        // 路径猜错不致命：失败就换一个
        for (const f of ["index.ts", "pkg/index.ts", "src/index.ts"]) {
          const r = await tools.call("read_file", { file_path: f });
          if (r.ok) { content = r.output; console.log("found at " + f); break; }
        }
        if (content === null) throw new Error("三处候选路径都没有找到文件");
        console.log("chars=" + content.length);
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /found at pkg\/index.ts/);
    },
  );
});

// ── 定位/探索用法验证 ──────────────────────────────────────

test("探索用法：grep 定位符号 → read_file 定点精读本体", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(
        join(root, "src", "server.ts"),
        "import { parse } from './parse.js';\n\nexport function handleRequest(req) {\n  const body = parse(req);\n  return body;\n}\n",
      );
    },
    async (root) => {
      const code = `
        const hits = await tools.call("grep", { pattern: "function handleRequest", file_path: "src" });
        // grep content 模式输出形如 "src/server.ts:3:export function handleRequest(req) {"，取第一条命中
        const first = hits.output.split("\\n").map(s => s.trim()).find(l => /.+:\\d+:/.test(l));
        console.log("HIT:", first);
        const m = first.match(/^(.+?):(\\d+):/);
        if (!m) throw new Error("grep 未定位到符号");
        const [_, file, line] = m;
        const r = await tools.call("read_file", { file_path: file, offset: Number(line), limit: 3 });
        console.log("BODY_OF:", r.output.split("\\n").slice(1, 3).join(" | "));
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /HIT: src\/server\.ts:3:/);
      assert.match(result.output, /BODY_OF: .*function handleRequest/);
    },
  );
});

test("探索用法：陌生模块速览——批量 read_outline 摸 API 面", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "services"), { recursive: true });
      await writeFile(join(root, "services", "auth.ts"), "export function login() {}\nexport function logout() {}\n");
      await writeFile(join(root, "services", "billing.ts"), "export function charge() {}\n");
    },
    async (root) => {
      const code = `
        const files = await tools.call("glob", { pattern: "services/*.ts", file_path: "." });
        // glob 输出每行是 workspace-relative 路径；截断提示行不带 .ts 后缀，按后缀过滤掉
        const list = files.output.split("\\n").map(s => s.trim()).filter(l => l.endsWith(".ts"));
        for (const f of list) {
          const o = await tools.call("read_outline", { file_path: f });
          // outline 首行是 "file: x.ts (N bytes ...)"，其余行带 "N|" 前缀
          const exportsList = o.output.split("\\n")
            .map(l => l.replace(/^\\s*\\d+\\|/, ""))
            .filter(l => l.includes("export"));
          console.log(f + " => " + exportsList.join("; "));
        }
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /services\/auth\.ts => export function login\(\) \{\}; export function logout\(\) \{\}/);
      assert.match(result.output, /services\/billing\.ts => export function charge\(\) \{\}/);
    },
  );
});

test("探索用法：search_symbols 定位符号定义位置（含兜底）", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "parse.ts"), "export function parseBody(input) {\n  return JSON.parse(input);\n}\n");
    },
    async (root) => {
      const code = `
        const r = await tools.call("search_symbols", { query: "parseBody", limit: 10 });
        console.log("FIRST_LINE:", r.output.split("\\n")[0].slice(0, 60));
        const files = [...r.output.matchAll(/([^:\\s]+\\.ts):/g)].map(m => m[1]);
        console.log("FILES:", [...new Set(files)].join(","));
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /parse\.ts/);
    },
  );
});

test("探索用法：按特征找文件——筛出超过 N 行的大文件", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "big.ts"), Array.from({ length: 120 }, () => "x").join("\n") + "\n");
      await writeFile(join(root, "src", "small.ts"), "a\nb\n");
    },
    async (root) => {
      const code = `
        const files = await tools.call("glob", { pattern: "src/*.ts", file_path: "." });
        const big = [];
        for (const f of files.output.split("\\n").map(s => s.trim()).filter(l => l.endsWith(".ts"))) {
          const r = await tools.call("read_file", { file_path: f });
          const m = r.output.match(/of (\\d+)\\]/);
          if (m && Number(m[1]) > 50) big.push(f + ":" + m[1]);
        }
        console.log("BIG:", big.join(", ") || "none");
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /BIG: src\/big\.ts:121/);
    },
  );
});

test("探索用法：反向依赖——谁引用了这个模块", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src", "utils.ts"), "export function id(x) { return x; }\n");
      await writeFile(join(root, "src", "a.ts"), "import { id } from './utils.js';\nexport const A = id(1);\n");
      await writeFile(join(root, "src", "b.ts"), "import { id } from '../src/utils.js';\nexport const B = id(2);\n");
      await writeFile(join(root, "src", "c.ts"), "export const C = 3;\n");
    },
    async (root) => {
      const code = `
        const r = await tools.call("grep", { pattern: "utils", file_path: "src", output_mode: "files_with_matches" });
        // files_with_matches 每行是一个 workspace-relative 路径，剔除自身
        const refs = r.output.split("\\n").map(s => s.trim()).filter(l => l.endsWith(".ts") && !l.endsWith("utils.ts")).sort();
        console.log("REFERENCED_BY(" + refs.length + "): " + refs.join(", "));
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.match(result.output, /REFERENCED_BY\(2\): src\/a\.ts, src\/b\.ts/);
    },
  );
});
test("探索用法：表加字段——定位该表对应的 Entity / VO / Mapper 类", async () => {
  await withWorkspace(
    async (root) => {
      const base = join(root, "marking-core/src/main/java/com/modi");
      await mkdir(join(base, "entity"), { recursive: true });
      await mkdir(join(base, "vo"), { recursive: true });
      await mkdir(join(base, "mapper"), { recursive: true });
      await writeFile(join(base, "entity/ExamTaskTopicTeacherPaper.java"), "package com.modi.entity;\npublic class ExamTaskTopicTeacherPaper {\n  private Long id;\n}");
      await writeFile(join(base, "vo/ExamTaskTopicTeacherPaperVO.java"), "package com.modi.vo;\npublic class ExamTaskTopicTeacherPaperVO {\n  private Long id;\n}");
      await writeFile(join(base, "mapper/ExamTaskTopicTeacherPaperMapper.java"), "package com.modi.mapper;\npublic interface ExamTaskTopicTeacherPaperMapper {\n}");
    },
    async (root) => {
      const code = `
        // 表加字段：先定位该表对应的 Entity / VO / Mapper 类
        const r = await tools.call("grep", { pattern: "ExamTaskTopicTeacherPaper", file_path: ".", glob: "**/*.java", output_mode: "files_with_matches" });
        if (!r.ok) throw new Error(r.output);
        const found = r.output.split("\\n").map(s => s.trim()).filter(f => f.endsWith(".java"));
        if (!found.length) throw new Error("未找到该表对应的类");
        const items = await Promise.all(found.map(async f => {
          const d = await tools.call("grep", { pattern: "(class|interface) ExamTaskTopicTeacherPaper", file_path: f });
          const role = /entity/i.test(f) ? "Entity" : /vo/i.test(f) ? "VO" : "其他";
          const decl = /(?:class|interface)\\s+\\w+/.exec(d.output)?.[0] ?? "(无类声明)";
          return role + " " + f + " — " + decl;
        }));
        console.log(items.join("\\n"));
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /Entity .*entity\/ExamTaskTopicTeacherPaper\.java — class/);
      assert.match(result.output, /VO .*vo\/ExamTaskTopicTeacherPaperVO\.java — class/);
      assert.match(result.output, /\u5176\u4ed6 .*mapper\/ExamTaskTopicTeacherPaperMapper\.java — interface/);
    },
  );
});

test("require 内建模块完全放开（含 node:fs/node:child_process）", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      // 只加载模块、不调用文件 API，避免触发源码预检；动态拼说明符验证解析
      const code = `
        const path = require("node:path");
        const fsKeys = Object.keys(require("node:" + "fs")).length;
        const cp = require("node:child_process");
        console.log("sep=" + path.sep + " fs-keys=" + fsKeys + " cp-exec=" + typeof cp.execSync);
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /fs-keys=\d+/);
      assert.match(result.output, /cp-exec=function/);
    },
  );
});

test("require 可导入工作区已安装的三方库", async () => {
  await withWorkspace(
    async (root) => {
      await mkdir(join(root, "node_modules", "tiny-helpers"), { recursive: true });
      await writeFile(
        join(root, "node_modules", "tiny-helpers", "package.json"),
        JSON.stringify({ name: "tiny-helpers", version: "1.0.0", main: "index.js" }) + "\n",
      );
      await writeFile(
        join(root, "node_modules", "tiny-helpers", "index.js"),
        "exports.add = (a, b) => a + b;\n",
      );
    },
    async (root) => {
      const code = `
        const h = require("tiny-helpers");
        console.log("sum=" + h.add(2, 3));
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /sum=5/);
    },
  );
});

test("require 未安装的包给出模块未找到错误", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      const code = `
        try {
          require("definitely-not-installed-xyz");
          console.log("SHOULD_NOT_PASS");
        } catch (e) {
          console.log("not found:", String(e).split("\\n")[0]);
        }
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true);
      assert.doesNotMatch(result.output, /SHOULD_NOT_PASS/);
      assert.match(result.output, /not found: Error: Cannot find module/);
    },
  );
});

test("Python 误用：语法错误旁附 JS-only 与替代工具提示", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      const result = await toolRunScript(ctxFor(root), "import subprocess, sys, shutil\nprint(sys.version)");
      assert.equal(result.ok, false);
      assert.match(result.output, /语法错误/);
      assert.match(result.output, /只执行 JavaScript/);
      assert.match(result.output, /tools\.call\("bash"/);
    },
  );
});
test("输出管制：大输出 + intent 按关键词开窗，无关片段不进对话", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      const code = `
        for (let i = 0; i < 300; i++) console.log("padding line " + i + " filler ".repeat(20));
        console.log("NEEDLE the answer is here");
        for (let i = 0; i < 300; i++) console.log("tail padding " + i + " filler ".repeat(20));
      `;
      const result = await toolRunScript(ctxFor(root), code, { intent: "NEEDLE the answer" });
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /按 intent 开窗提取/);
      assert.match(result.output, /NEEDLE the answer is here/);
      // 远离关键词的行不应进入对话
      assert.doesNotMatch(result.output, /tail padding 250/);
    },
  );
});

test("输出管制：大输出无 intent，字节兜底截断并标记", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      const code = `
        for (let i = 0; i < 300; i++) console.log("padding line " + i + " filler ".repeat(20));
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /已截断/);
      assert.match(result.output, /padding line 0/);
    },
  );
});

test("输出管制：小输出原样返回，intent 不触发开窗", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      const result = await toolRunScript(ctxFor(root), 'console.log("short answer");', { intent: "anything" });
      assert.equal(result.ok, true);
      assert.match(result.output, /short answer/);
      assert.doesNotMatch(result.output, /开窗|截断/);
    },
  );
});

// ── 沙箱内 child_process 输出编码修正（Windows GBK 乱码修复） ──────

test("run_script 内 child_process 失败输出保持可解码文本（无 U+FFFD）", async () => {
  await withWorkspace(
    async () => {},
    async (root) => {
      // 失败命令带 ASCII stderr：任何平台都验证包装层接管了解码路径
      const code = `
        const { execSync } = require("child_process");
        try {
          execSync("node -e \\"console.error('pipe-boom');process.exit(2)\\"");
        } catch (e) {
          console.log("CAUGHT " + e.message.split("\\n")[0]);
          console.log("STDERR_TYPE=" + typeof e.stderr);
        }
      `;
      const result = await toolRunScript(ctxFor(root), code);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /CAUGHT Command failed/);
      assert.match(result.output, /pipe-boom/);
      assert.match(result.output, /STDERR_TYPE=string/);
      assert.ok(!result.output.includes("�"), "replacement char in output");
    },
  );
});

test.skipIf(process.platform !== "win32")(
  "run_script 内 cmd.exe 的 GBK 报错不再乱码（用户复现命令）",
  async () => {
    await withWorkspace(
      async () => {},
      async (root) => {
        // 用户原始场景：Unix 重定向/管道写法在 cmd.exe 下失败，stderr 是 GBK 字节。
        // 默认壳已是随包 bash（POSIX 管道可用），显式 shell:true 锁定 cmd.exe
        // 路径，验证 GBK 兜底解码仍然生效。
        const code = `
          const { execSync } = require("child_process");
          try {
            execSync('grep -r "verifyTask/list" --include="*.java" -l . 2>/dev/null | head -20', { encoding: "utf8", shell: true });
          } catch (e) {
            console.log("MSG=" + e.message);
          }
        `;
        const result = await toolRunScript(ctxFor(root), code);
        assert.equal(result.ok, true, result.output);
        // 旧行为：ϵͳҲα·汾 类乱码 + U+FFFD（字节已丢失，不可逆）
        assert.ok(!result.output.includes("�"), result.output);
        assert.ok(!result.output.includes("ϵ"), result.output);
        const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
        if (locale.toLowerCase().startsWith("zh")) {
          assert.match(result.output, /系统找不到指定的路径/);
        }
      },
    );
  },
);
