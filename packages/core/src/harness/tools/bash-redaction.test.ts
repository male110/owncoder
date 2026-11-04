import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import { toolBash } from "./fs.ts";
import type { ToolContext } from "./types.ts";
import type { TerminalEntry } from "../terminal.ts";

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

test("bash file redaction uses the same output for model results and terminal events", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-bash-redaction-"));
  const terminal: TerminalEntry[] = [];
  try {
    await writeFile(join(root, ".env"), "PASSWORD=hunter2\nUSER=alice@example.com\n");
    const ctx: ToolContext = {
      workspaceRoot: root,
      mode: "agent",
      workflow: BUILTIN_WORKFLOW,
      index: stubIndex(),
      readSet: new Set(),
      maxOutputChars: 24_000,
      bashMaxChars: 10_000,
      onTerminal: (entry) => terminal.push(entry),
    };

    const result = await toolBash(ctx, "cat .env");
    const completed = terminal.at(-1);

    assert.equal(result.ok, true);
    assert.ok(completed);
    assert.ok(!result.output.includes("hunter2"));
    assert.ok(!result.output.includes("alice@example.com"));
    assert.ok(!completed.stdout?.includes("hunter2"));
    assert.ok(!completed.stdout?.includes("alice@example.com"));
    assert.ok(result.output.includes(`stdout:\n${completed.stdout}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("PowerShell variables, file reads and redirected logs reach both tool results and terminal events", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-bash-posix-"));
  const terminal: TerminalEntry[] = [];
  const classpath = "target/classes;dependency.jar";
  try {
    await writeFile(join(root, "mapper-check-classpath.txt"), classpath);
    await writeFile(join(root, ".env"), "PASSWORD=hunter2\n");
    const ctx: ToolContext = {
      workspaceRoot: root,
      mode: "agent",
      workflow: BUILTIN_WORKFLOW,
      index: stubIndex(),
      readSet: new Set(),
      maxOutputChars: 24_000,
      bashMaxChars: 10_000,
      onTerminal: (entry) => terminal.push(entry),
    };
    // 测试仅在隔离目录写日志，通过现有确认回调授权重定向。
    ctx.confirmDangerousBash = async () => true;
    const cases = [
      { command: "$probeValue = 'probe-variable-ok'; Write-Output $probeValue", expected: "probe-variable-ok" },
      { command: "Get-Content mapper-check-classpath.txt", expected: classpath },
      {
        command: "(Get-Content mapper-check-classpath.txt -Raw).Trim().Length | Set-Content mapper-check.log; Get-Content mapper-check.log",
        expected: String(classpath.length),
      },
      { command: "Get-Content mapper-check.log", expected: String(classpath.length) },
    ];
    for (const { command, expected } of cases) {
      const result = await toolBash(ctx, command);
      const completed = terminal.at(-1);
      assert.equal(result.ok, true, result.output);
      assert.equal(completed?.exitCode, 0, result.output);
      assert.equal(completed?.stdout?.trim(), expected);
      assert.ok(result.output.includes(`stdout:\n${completed?.stdout}`));
      assert.ok(!result.output.includes("source could not be verified"));
    }
    // 敏感文件：静态读取与管道/命令替换形态都必须被脱敏
    const sensitive = await toolBash(ctx, "Get-Content .env | Select-Object -First 1");
    assert.equal(terminal.at(-1)?.exitCode, 0, sensitive.output);
    assert.ok(!sensitive.output.includes("hunter2"));
    assert.ok(!terminal.at(-1)?.stdout?.includes("hunter2"));
    assert.match(sensitive.output, /source could not be verified/);
    const sensitiveNested = await toolBash(ctx, "$value = Get-Content .env -Raw; Write-Output $value");
    assert.equal(terminal.at(-1)?.exitCode, 0, sensitiveNested.output);
    assert.ok(!sensitiveNested.output.includes("hunter2"));
    assert.match(sensitiveNested.output, /source could not be verified/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
