import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import { toolRunScript } from "./run-script.ts";
import type { ToolContext } from "./types.ts";

function context(root: string, allowed: string[]): ToolContext {
  return {
    workspaceRoot: root,
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    index: {} as ToolContext["index"],
    readSet: new Set(),
    maxOutputChars: 24000,
    bashMaxChars: 10000,
    availableTools: new Set(allowed),
  };
}

test("nested scripts cannot widen an Explore tool allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-auth-"));
  try {
    const result = await toolRunScript(
      context(root, ["run_script", "read_file"]),
      'const r = await tools.call("bash", { command: "printf nope" }); console.log(r.output);',
    );
    assert.equal(result.ok, true);
    assert.match(result.output, /Tool not allowed in this role: bash/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
