import assert from "node:assert/strict";
import { test } from "vitest";
import { BUILTIN_WORKFLOW } from "@owncoder/settings";
import type { IndexClient } from "@owncoder/index";
import { normalizeAskUserQuestion, toolAskUser } from "./misc.ts";
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

function makeCtx(askUser: ToolContext["askUser"], cache = new Map<string, string>()): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    mode: "agent",
    workflow: BUILTIN_WORKFLOW,
    index: stubIndex(),
    readSet: new Set(),
    maxOutputChars: 24_000,
    bashMaxChars: 10_000,
    askUser,
    askUserTurnCache: cache,
  };
}

test("normalizeAskUserQuestion collapses whitespace and case", () => {
  assert.equal(normalizeAskUserQuestion("  Hello   World  "), "hello world");
});

test("toolAskUser caches answer and replays same-turn duplicate question", async () => {
  let calls = 0;
  const ctx = makeCtx(async () => {
    calls += 1;
    return "选 A";
  });

  const first = await toolAskUser(ctx, "继续吗？", [{ label: "是", value: "yes" }], false, "");
  const second = await toolAskUser(ctx, "  继续吗？  ", [{ label: "是", value: "yes" }], false, "");

  assert.equal(first.ok, true);
  assert.equal(first.output, "选 A");
  assert.equal(second.ok, true);
  assert.match(second.output, /复用本轮已有回答/);
  assert.match(second.output, /选 A/);
  assert.equal(calls, 1);
});

test("toolAskUser still prompts for a different question in the same turn", async () => {
  const answers = ["第一题", "第二题"];
  let calls = 0;
  const ctx = makeCtx(async () => answers[calls++]!);

  const first = await toolAskUser(ctx, "问题一", [], true, "");
  const second = await toolAskUser(ctx, "问题二", [], true, "");

  assert.equal(first.output, "第一题");
  assert.equal(second.output, "第二题");
  assert.equal(calls, 2);
});
