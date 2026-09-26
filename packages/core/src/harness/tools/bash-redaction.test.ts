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
