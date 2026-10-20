/**
 * P5 Windows smoke: index + harness (parser/patch/plan/checkpoint/compact).
 * No live LLM required.
 *
 *   pnpm smoke
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(here, "../packages/core/dist/index.js")).href);
const { createIndexClient } = await import(
  pathToFileURL(join(here, "../packages/index/dist/index.js")).href
);
const checkpoint = await import(
  pathToFileURL(join(here, "../packages/core/dist/harness/checkpoint.js")).href
);

const {
  applySearchReplacePatch,
  parseToolCallsFromAssistant,

  isPlanPath,
  writePlanFile,
  compactHistory,
  looksDangerous,
  createSession,
} = core;

console.log("— parser / patch / writable —");
{
  const calls = parseToolCallsFromAssistant({
    content: `<tool_call name="save_plan">{"title":"T","content":"# Hi"}</tool_call>`,
  });
  assert.equal(calls[0]?.name, "save_plan");

  const r = applySearchReplacePatch(
    "a\nb\nc\n",
    `<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE`,
  );
  assert.equal(r.ok, true);
  assert.ok(r.content?.includes("B"));

  // PRD / markdown resilience: heading level drift (## vs ###) should still apply.
  const prd = applySearchReplacePatch(
    "# PRD\n\n## 待用户确认\n\n等待用户确认。\n",
    `<<<<<<< SEARCH\n### 待用户确认\n\n等待用户确认。\n=======\n### 用户确认\n\n已确认。\n>>>>>>> REPLACE`,
  );
  assert.equal(prd.ok, true, "markdown heading level drift should be tolerated");
  assert.ok(prd.content?.includes("## 用户确认"), prd.content);

  // PRD / markdown resilience: indentation / leading-whitespace drift.
  const indented = applySearchReplacePatch(
    "- item\n  - sub\n    detail\n",
    `<<<<<<< SEARCH\n  - sub\n    detail\n=======\n  - sub\n    updated detail\n>>>>>>> REPLACE`,
  );
  assert.equal(indented.ok, true, "indentation drift should be tolerated");
  assert.ok(indented.content?.includes("updated detail"), indented.content);

  // PRD / markdown resilience: CRLF file with LF patch.
  const crlf = applySearchReplacePatch(
    "line one\r\nline two\r\nline three\r\n",
    `<<<<<<< SEARCH\nline two\r\n=======\nLINE 2\n>>>>>>> REPLACE`,
  );
  assert.equal(crlf.ok, true, "CRLF content with LF patch should apply");
  assert.ok(crlf.content?.includes("LINE 2"), crlf.content);

  assert.equal(isPlanPath(".owncoder/plans/x.md"), true);

  assert.equal(looksDangerous("rm -rf /"), true);
  assert.equal(looksDangerous("pnpm test"), false);
}

console.log("— parser: rescue path for apply_patch —");
{
  // patch payload with raw newlines + unescaped quotes breaks JSON.parse;
  // path must still be rescued so apply_patch doesn't reject with empty path.
  const calls = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      {
        id: "1",
        type: "function",
        function: {
          name: "apply_patch",
          arguments:
            '{"path":"src/foo.ts","patch":"<<<<<<< SEARCH\nconst x = "bug";\n=======\n"}',
        },
      },
    ],
  });
  assert.equal(calls[0]?.name, "apply_patch");
  assert.equal(calls[0]?.arguments.path, "src/foo.ts");

  // bare key (no quotes) + unescaped quote in another field → extract fallback
  const calls2 = parseToolCallsFromAssistant({
    content: null,
    toolCalls: [
      {
        id: "2",
        type: "function",
        function: {
          name: "apply_patch",
          arguments: '{path:"src/a.ts",patch:"a"b"}',
        },
      },
    ],
  });
  assert.equal(calls2[0]?.arguments.path, "src/a.ts");
}

console.log("— compact —");
{
  const hist = [];
  for (let i = 0; i < 20; i++) {
    hist.push({ role: "user", content: `u${i} ` + "x".repeat(200) });
    hist.push({ role: "assistant", content: `a${i}` });
    hist.push({
      role: "tool",
      content: "OUT".repeat(2000),
      toolName: "read_file",
    });
  }
  const c = compactHistory(hist, { maxChars: 5000, keepRecentTurns: 2, toolMaxChars: 100 });
  const chars = c.reduce((n, t) => n + t.content.length, 0);
  assert.ok(chars < 12_000, `compacted size ${chars}`);
  assert.ok(c.length < hist.length);
}

console.log("— plan + checkpoint rollback —");
{
  const dir = await mkdtemp(join(tmpdir(), "owncoder-p5-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "hello.ts"), "export const n = 1;\n", "utf8");

    const session = createSession();
    const wf = session.getState().workflow;
    session.setWorkflow({
      ...wf,
      harness: { ...wf.harness, checkpoint: true },
    });
    await session.openWorkspace(dir, "p5");

    const rel = await writePlanFile(dir, "# Demo\n1. Edit src/hello.ts\n", { title: "Demo" });
    assert.ok(rel.startsWith(".owncoder/plans/"));

    const files = [];
    await checkpoint.snapshotFileBeforeWrite(dir, "src/hello.ts", files);
    await writeFile(join(dir, "src", "hello.ts"), "export const n = 2;\n", "utf8");
    const cp = {
      id: checkpoint.newCheckpointId(),
      createdAt: new Date().toISOString(),
      historyLen: 0,
      history: [],
      files,
      touched: ["src/hello.ts"],
    };
    await checkpoint.persistCheckpoint(dir, cp);
    const restored = await checkpoint.restoreCheckpointFiles(dir, cp);
    assert.deepEqual(restored, ["src/hello.ts"]);
    const body = await readFile(join(dir, "src", "hello.ts"), "utf8");
    assert.equal(body, "export const n = 1;\n");

    const listed = await session.listCheckpoints();
    assert.ok(listed.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("— index / RepoMap —");
{
  const dir = await mkdtemp(join(tmpdir(), "owncoder-idx-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "src", "main.ts"),
      "export function helloWorld() { return 1; }\nexport class Foo {}\n",
      "utf8",
    );
    const client = createIndexClient();
    await client.open(dir);
    const status = client.status();
    console.log("  index status:", status.kind, "files=", status.fileCount, "tags=", status.tagCount);
    assert.ok(["ready", "building", "idle", "error"].includes(status.kind));
    const map = await client.buildRepoMap({ mapTokens: 800 });
    console.log("  repoMap chars:", map.length);
    if (status.kind === "ready" && (status.tagCount ?? 0) > 0) {
      assert.ok(map.length > 0, "expected non-empty RepoMap");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("— session persist / restore —");
{
  const dir = await mkdtemp(join(tmpdir(), "owncoder-sess-"));
  try {
    const { createSession: cs, loadPersistedSession, savePersistedSession } = core;
    await savePersistedSession(dir, {
      mode: "agent",
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: "1. do x",
      lastCheckpointId: null,
      documentWorkflow: {
        stage: "awaiting_prd_confirmation",
        documentPath: "PRD.md",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    });
    const loaded = await loadPersistedSession(dir);
    assert.equal(loaded?.history.length, 2);
    assert.equal(loaded?.mode, "agent");
    assert.equal(loaded?.todoAnchor, "1. do x");
    assert.equal(loaded?.documentWorkflow?.stage, "awaiting_prd_confirmation");

    const s2 = cs();
    await s2.openWorkspace(dir, "sess");
    assert.equal(s2.getState().sessionRestored, true);
    assert.equal(s2.getState().mode, "agent");
    assert.equal(s2.getHistory().length, 2);
    assert.equal(s2.getState().todoAnchor, "1. do x");

    // persist via session API then reopen
    s2.setTodoAnchor("2. do y");
    await s2.persist();
    const s3 = cs();
    await s3.openWorkspace(dir, "sess");
    assert.equal(s3.getState().todoAnchor, "2. do y");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("— project rules —");
{
  const dir = await mkdtemp(join(tmpdir(), "owncoder-rules-"));
  try {
    const { writeRule, loadCombinedRules, listRules, createSession: cs } = core;
    await writeRule(dir, "00-style.md", "# Style\nUse TypeScript.\n");
    await writeRule(dir, "testing.md", "# Test\nRun pnpm test.\n");
    const listed = await listRules(dir);
    assert.equal(listed.length, 2);
    const combined = await loadCombinedRules(dir);
    assert.ok(combined.includes("TypeScript"));
    assert.ok(combined.includes("pnpm test"));

    const s = cs();
    await s.openWorkspace(dir, "rules");
    assert.ok(s.getProjectRulesText().includes("TypeScript"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log("— workflow diff / summary —");
{
  const settings = await import(
    pathToFileURL(join(here, "../packages/settings/dist/index.js")).href
  );
  const {
    BUILTIN_WORKFLOW,
    diffWorkflow,
    summarizeEffectiveWorkflow,
    updatePipelineNode,
    orderedEnabledNodes,
    isNodeEnabled,
    modePipeline,
    mergeWorkflow,
    addModePipelineNode,
    removeModePipelineNode,
    moveModePipelineNode,
  } = settings;
  assert.equal(diffWorkflow(BUILTIN_WORKFLOW).length, 0);
  const tweaked = structuredClone(BUILTIN_WORKFLOW);

  tweaked.providers = [
    {
      id: "local",
      name: "Local",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: "",
      models: [{ id: "qwen2.5", name: "qwen2.5" }],
    },
  ];
  tweaked.selectedModels = [{ id: "qwen2.5", name: "qwen2.5", providerId: "local" }];
  const diffs = diffWorkflow(tweaked);

  assert.ok(diffs.some((d) => d.path === "selectedModels"));
  assert.ok(diffs.some((d) => d.path === "providers"));
  const sum = summarizeEffectiveWorkflow(tweaked);

  assert.ok(sum.defaultModel.includes("qwen2.5"));

  // Dual-mode pipelines: context → call model → (review)
  const planPipe = modePipeline(BUILTIN_WORKFLOW, "plan");
  const agentPipe = modePipeline(BUILTIN_WORKFLOW, "agent");
  assert.ok(planPipe.nodes.some((n) => n.type === "explore_tools"));
  assert.ok(planPipe.nodes.some((n) => n.type === "document_intent_router"));
  assert.ok(agentPipe.nodes.some((n) => n.type === "execute_tools"));
  assert.ok(agentPipe.nodes.some((n) => n.type === "present_changes"));
  assert.ok(!planPipe.nodes.some((n) => n.type === "intent"));
  assert.ok(!agentPipe.nodes.some((n) => n.type === "load_anchors"));
  assert.ok(!agentPipe.nodes.some((n) => n.type === "verify"));
  assert.ok(isNodeEnabled(planPipe, "explore_tools"));
  const ctx = agentPipe.nodes.find((n) => n.type === "context_gather");
  assert.equal(ctx?.params?.injectAnchors, true);

  // Disable llm node → ordered list skips it
  let withDisabled = updatePipelineNode(BUILTIN_WORKFLOW, "plan", "llm", {
    enabled: false,
  });
  const ordered = orderedEnabledNodes(withDisabled.modes.plan.pipeline);
  assert.ok(!ordered.some((n) => n.type === "explore_tools"));

  // Merge overlay restores / overlays pipeline node
  const merged = mergeWorkflow(BUILTIN_WORKFLOW, {
    version: 1,
    modes: {
      plan: {
        pipeline: {
          nodes: [{ id: "llm", type: "explore_tools", enabled: false }],
          edges: BUILTIN_WORKFLOW.modes.plan.pipeline.edges,
        },
      },
    },
  });
  assert.equal(isNodeEnabled(merged.modes.plan.pipeline, "explore_tools"), false);

  // Agent llm prompt change shows in diff
  const execNode = BUILTIN_WORKFLOW.modes.agent.pipeline.nodes.find(
    (n) => n.type === "execute_tools",
  );
  withDisabled = updatePipelineNode(BUILTIN_WORKFLOW, "agent", execNode.id, {
    prompt: "Custom agent prompt for smoke",
  });
  const pDiffs = diffWorkflow(withDisabled);
  assert.ok(pDiffs.some((d) => String(d.path).includes("llm") && d.section === "pipeline"));

  // Add / remove / move middle nodes (Dify-style); spine fixed
  let edited = removeModePipelineNode(BUILTIN_WORKFLOW, "agent", "present");
  assert.ok(!edited.modes.agent.pipeline.nodes.some((n) => n.type === "present_changes"));
  assert.ok(edited.modes.agent.pipeline.nodes.some((n) => n.type === "context_gather"));
  assert.ok(edited.modes.agent.pipeline.nodes.some((n) => n.type === "end"));
  edited = addModePipelineNode(edited, "agent", "verify", "llm");
  assert.ok(edited.modes.agent.pipeline.nodes.some((n) => n.type === "verify"));
  edited = addModePipelineNode(edited, "agent", "present_changes", "llm");
  const midIds = edited.modes.agent.pipeline.nodes
    .filter((n) => !["start", "end"].includes(n.type))
    .map((n) => n.type);
  assert.ok(midIds.includes("present_changes"));
  const present = edited.modes.agent.pipeline.nodes.find((n) => n.type === "present_changes");
  edited = moveModePipelineNode(edited, "agent", present.id, "down");
  assert.throws(() => removeModePipelineNode(edited, "agent", "context"), /fixed|required/i);
  // Same type can be added multiple times
  edited = addModePipelineNode(edited, "agent", "execute_tools", "llm");
  const execCount = edited.modes.agent.pipeline.nodes.filter(
    (n) => n.type === "execute_tools",
  ).length;
  assert.ok(execCount >= 2);

  // Builtin prompts are baked into the builtin pipeline nodes (English,
  // canonical); resolvePrompts reads them straight from the nodes.
  const { resolvePrompts } = settings;
  const resolved = resolvePrompts(BUILTIN_WORKFLOW);
  assert.ok(resolved.plan.includes("Plan Mode"));
  assert.ok(resolved.agent.includes("Agent Mode"));
}

console.log("smoke-p5: ok");
// The always-on workspace file watcher keeps the event loop alive; exit
// explicitly now that all assertions have passed.
process.exit(0);
