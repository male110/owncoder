/**
 * P5 Windows smoke: index + harness (parser/patch/plan/checkpoint/compact).
 * No live LLM required.
 *
 *   pnpm smoke
 *
 * harness 内部工具（parser / search-replace / plans / compact / terminal /
 * checkpoint / rules / session-store）不在 @owncoder/core 的根导出面上，按 dist
 * 深路径加载——与下方 checkpoint 的既有做法一致。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = (pkg, rel = "index.js") =>
  pathToFileURL(join(here, `../packages/${pkg}/dist/${rel}`)).href;

const core = await import(dist("core"));
const { createIndexClient } = await import(dist("index"));
const checkpoint = await import(dist("core", "harness/checkpoint.js"));
const { parseToolCallsFromAssistant } = await import(dist("core", "harness/parser.js"));
const { applySearchReplace } = await import(dist("core", "harness/tools/search-replace.js"));
const { isPlanPath, writePlanFile } = await import(dist("core", "plans.js"));
const { compactHistory } = await import(dist("core", "history-compact.js"));
const { looksDangerous } = await import(dist("core", "harness/terminal.js"));
const { writeRule, loadCombinedRules, listRules } = await import(dist("core", "rules.js"));
const { createSessionFile, saveSessionById, loadSessionById } = await import(
  dist("core", "session-store.js")
);

const { createSession } = core;

console.log("— parser / patch / writable —");
{
  const calls = parseToolCallsFromAssistant({
    content: `<tool_call name="save_plan">{"title":"T","content":"# Hi"}</tool_call>`,  });
  assert.equal(calls[0]?.name, "save_plan");

  const r = applySearchReplace(
    "a\nb\nc\n",
    `<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE`,
  );
  assert.equal(r.success, true);
  assert.ok(r.content?.includes("B"));

  // PRD / markdown: heading level drift (## vs ###) is NOT tolerated any more.
  // Character-level fuzzy matching was removed on purpose (it could land an edit
  // in a structurally similar but wrong place), so a drifted heading must fail
  // loudly with a diagnostic instead of silently rewriting the wrong section.
  const prd = applySearchReplace(
    "# PRD\n\n## 待用户确认\n\n等待用户确认。\n",
    `<<<<<<< SEARCH\n### 待用户确认\n\n等待用户确认。\n=======\n### 用户确认\n\n已确认。\n>>>>>>> REPLACE`,
  );
  assert.equal(prd.success, false, "heading level drift must not be applied fuzzily");
  assert.match(prd.error ?? "", /Could not find SEARCH text/);
  assert.ok(!prd.content, "failed patch must not return content");

  // PRD / markdown resilience: indentation / leading-whitespace drift.
  const indented = applySearchReplace(
    "- item\n  - sub\n    detail\n",
    `<<<<<<< SEARCH\n  - sub\n    detail\n=======\n  - sub\n    updated detail\n>>>>>>> REPLACE`,
  );
  assert.equal(indented.success, true, "indentation drift should be tolerated");
  assert.ok(indented.content?.includes("updated detail"), indented.content);

  // PRD / markdown resilience: CRLF file with LF patch.
  const crlf = applySearchReplace(
    "line one\r\nline two\r\nline three\r\n",
    `<<<<<<< SEARCH\nline two\r\n=======\nLINE 2\n>>>>>>> REPLACE`,
  );
  assert.equal(crlf.success, true, "CRLF content with LF patch should apply");
  assert.ok(crlf.content?.includes("LINE 2"), crlf.content);
  assert.ok(crlf.content?.includes("line one\r\n"), "surrounding CRLF endings preserved");

  assert.equal(isPlanPath(".owncoder/plans/x.md"), true);
  assert.equal(isPlanPath(".owncoder/specs/feature/tasks.md"), true);
  assert.equal(isPlanPath("src/main.ts"), false);

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
  const charsOf = (turns) => turns.reduce((n, t) => n + t.content.length, 0);
  const before = charsOf(hist);
  // compactHistory(history, { recentWindow, budgetBytes, reason }) →
  // { history, compacted, oldCount }: older turns collapse into one summary turn.
  const c = compactHistory(hist, { recentWindow: 6, budgetBytes: 5000, reason: "manual" });
  assert.equal(c.compacted, true);
  assert.ok(c.oldCount > 0, `oldCount ${c.oldCount}`);
  assert.ok(c.history.length < hist.length, `${c.history.length} < ${hist.length}`);
  assert.ok(charsOf(c.history) < before, `compacted ${charsOf(c.history)} < ${before}`);
  assert.equal(c.history[0]?.metadata?.isCompressed, true);
  assert.equal(c.history[0]?.metadata?.compressionReason, "manual");

  // Under budget → returned untouched.
  const noop = compactHistory(hist.slice(0, 2), {
    recentWindow: 6,
    budgetBytes: 5000,
    reason: "auto",
  });
  assert.equal(noop.compacted, false);
  assert.equal(noop.history.length, 2);
}

console.log("— plan + checkpoint rollback —");
{
  const dir = await mkdtemp(join(tmpdir(), "owncoder-p5-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "hello.ts"), "export const n = 1;\n", "utf8");

    // Checkpoints are git-based and scoped per session, so a session file must
    // exist before the orchestrator can report an active session id.
    const { meta } = await createSessionFile(dir, { mode: "agent" });

    const session = createSession();
    const wf = session.getState().workflow;
    session.setWorkflow({
      ...wf,
      harness: { ...wf.harness, checkpoint: true },
    });
    await session.openWorkspace(dir, "p5");
    const sessionId = session.getState().activeSessionId;
    assert.equal(sessionId, meta.id);

    const rel = await writePlanFile(dir, "# Demo\n1. Edit src/hello.ts\n", { title: "Demo" });
    assert.ok(rel.startsWith(".owncoder/plans/"));
    assert.ok(isPlanPath(rel));

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
      sessionId,
    };
    await checkpoint.persistCheckpoint(dir, cp);
    const restored = await checkpoint.restoreCheckpointFiles(dir, cp);
    assert.deepEqual(restored, ["src/hello.ts"]);
    const body = await readFile(join(dir, "src", "hello.ts"), "utf8");
    assert.equal(body, "export const n = 1;\n");

    const listed = await session.listCheckpoints();
    assert.ok(listed.length >= 1);
    assert.ok(listed.some((c) => c.id === cp.id));

    // A checkpoint without a session id cannot be persisted (git worktree is
    // per-session), so the guard must reject rather than write to a stray dir.
    await assert.rejects(
      () => checkpoint.persistCheckpoint(dir, { ...cp, id: checkpoint.newCheckpointId(), sessionId: null }),
      /sessionId is required/,
    );
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
    const { createSession: cs } = core;
    // Sessions are stored per-id under .owncoder/sessions/, so create the file
    // first and then save the snapshot against that id.
    const { meta } = await createSessionFile(dir, { mode: "agent" });
    await saveSessionById(dir, meta.id, {
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
        stage: "awaiting_spec_confirmation",
        documentPath: "PRD.md",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    });
    const loaded = await loadSessionById(dir, meta.id);
    assert.equal(loaded?.history.length, 2);
    assert.equal(loaded?.mode, "agent");
    assert.equal(loaded?.todoAnchor, "1. do x");
    assert.equal(loaded?.documentWorkflow?.stage, "awaiting_spec_confirmation");

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
    const { createSession: cs } = core;
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

console.log("— workflow fingerprint / effective model / pipeline editing —");
{
  const settings = await import(dist("settings"));
  const {
    BUILTIN_WORKFLOW,
    workflowFingerprint,
    getActiveModelRef,
    updatePipelineNode,
    modePipeline,
    walkLinearNodes,
    removePipelineNode,
    movePipelineNode,
    positionConstraintsOf,
    isFixedPipelineNode,
    resolvePrompts,
  } = settings;

  // diffWorkflow() → workflowFingerprint(): unchanged config hashes identically.
  assert.equal(workflowFingerprint(BUILTIN_WORKFLOW), workflowFingerprint(structuredClone(BUILTIN_WORKFLOW)));

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
  // summarizeEffectiveWorkflow() → getActiveModelRef(): the effective model.
  const active = getActiveModelRef(tweaked);
  assert.equal(active.model, "qwen2.5");
  assert.equal(active.providerId, "local");
  assert.equal(active.baseUrl, "http://127.0.0.1:11434/v1");
  // A provider/model change must move the fingerprint (it used to show up as
  // `providers` / `selectedModels` diff entries).
  assert.notEqual(workflowFingerprint(tweaked), workflowFingerprint(BUILTIN_WORKFLOW));

  // Dual-mode pipelines: context → call model → (review)
  const specPipe = modePipeline(BUILTIN_WORKFLOW, "spec");
  const agentPipe = modePipeline(BUILTIN_WORKFLOW, "agent");
  assert.ok(specPipe.nodes.some((n) => n.type === "explore_tools"));
  // document_intent_router is a legacy node type, no longer in the builtin spec pipeline
  assert.ok(agentPipe.nodes.some((n) => n.type === "execute_tools"));
  assert.ok(agentPipe.nodes.some((n) => n.type === "present_changes"));
  assert.ok(!specPipe.nodes.some((n) => n.type === "intent"));
  assert.ok(!agentPipe.nodes.some((n) => n.type === "load_anchors"));
  assert.ok(!agentPipe.nodes.some((n) => n.type === "verify"));
  const ctx = agentPipe.nodes.find((n) => n.type === "context_gather");
  assert.equal(ctx?.params?.injectAnchors, true);

  // Agent llm prompt change shows in the fingerprint
  const execNode = agentPipe.nodes.find((n) => n.type === "execute_tools");
  const withPrompts = updatePipelineNode(BUILTIN_WORKFLOW, "agent", execNode.id, {
    prompt: "Custom agent prompt for smoke",
  });
  assert.equal(
    withPrompts.modes.agent.pipeline.nodes.find((n) => n.id === execNode.id)?.prompt,
    "Custom agent prompt for smoke",
  );
  assert.notEqual(workflowFingerprint(withPrompts), workflowFingerprint(BUILTIN_WORKFLOW));

  // Remove / move middle nodes (Dify-style); spine fixed.
  // addModePipelineNode/removeModePipelineNode/moveModePipelineNode(workflow, mode, …)
  // → removePipelineNode/movePipelineNode(pipeline, …) operating on the pipeline.
  const typesOf = (pipe) => walkLinearNodes(pipe).map((n) => n.type);
  assert.deepEqual(typesOf(agentPipe), [
    "start",
    "context_gather",
    "task_decompose",
    "execute_tools",
    "post_verify",
    "present_changes",
    "end",
  ]);

  const withoutPresent = removePipelineNode(agentPipe, "present");
  assert.ok(!withoutPresent.nodes.some((n) => n.type === "present_changes"));
  assert.ok(withoutPresent.nodes.some((n) => n.type === "context_gather"));
  assert.ok(withoutPresent.nodes.some((n) => n.type === "end"));
  // The deletion is recorded so the factory node is not merged back on reload.
  assert.ok(withoutPresent.removed?.some((r) => r === "id:present"));
  assert.ok(withoutPresent.removed?.some((r) => r === "type:present_changes"));
  // Source pipeline is untouched (pure function).
  assert.ok(agentPipe.nodes.some((n) => n.type === "present_changes"));

  // Fixed spine cannot be removed.
  assert.equal(isFixedPipelineNode({ type: "context_gather" }), true);
  assert.throws(() => removePipelineNode(agentPipe, "context"), /fixed|required/i);
  // The last model-calling node is protected too.
  const onlyLlm = removePipelineNode(
    removePipelineNode(removePipelineNode(agentPipe, "present"), "postverify"),
    "decompose",
  );
  assert.throws(() => removePipelineNode(onlyLlm, "llm"), /模型调用|at least one/i);

  // Moving within one slot region is allowed; crossing regions is rejected.
  const moved = movePipelineNode(agentPipe, "present", "up");
  assert.deepEqual(typesOf(moved), [
    "start",
    "context_gather",
    "task_decompose",
    "execute_tools",
    "present_changes",
    "post_verify",
    "end",
  ]);
  assert.equal(positionConstraintsOf("present_changes")?.slot, "post-model");
  assert.throws(() => movePipelineNode(agentPipe, "postverify", "up"), /跨槽位|slot/i);
  // Fixed nodes never move.
  assert.equal(movePipelineNode(agentPipe, "context", "down"), agentPipe);

  // Builtin prompts are baked into the builtin pipeline nodes (English,
  // canonical); resolvePrompts reads them straight from the nodes.
  const resolved = resolvePrompts(BUILTIN_WORKFLOW);
  assert.ok(resolved.spec.includes("Spec Mode"), resolved.spec.slice(0, 40));
  assert.ok(resolved.agent.includes("Agent Mode"), resolved.agent.slice(0, 40));
}

console.log("smoke-p5: ok");
// The always-on workspace file watcher keeps the event loop alive; exit
// explicitly now that all assertions have passed.
process.exit(0);
