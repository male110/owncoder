import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySearchReplacePatch,
  checkWritable,
  extractPathsFromPlan,
  isPlanPath,
  parseToolCallsFromAssistant,
  writePlanFile,
  listPlans,
} from "../dist/index.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// execute helpers aren't all exported — test plan gate via plans module + writable

{
  const orig = "line1\nhello world\nline3\n";
  const patch = `<<<<<<< SEARCH
hello world
=======
hello OwnCoder
>>>>>>> REPLACE`;
  const r = applySearchReplacePatch(orig, patch);
  assert.equal(r.ok, true);
}

{
  const calls = parseToolCallsFromAssistant({
    content: `<tool_call name="save_plan">{"title":"T","content":"# Hi"}</tool_call>`,
  });
  assert.equal(calls[0]?.name, "save_plan");
}

{
  assert.equal(isPlanPath(".owncoder/plans/foo.md"), true);
  assert.equal(isPlanPath("src/a.ts"), false);
  assert.equal(isPlanPath(".owncoder/index/x"), false);
}

{
  const root = "C:\\\\repo";
  assert.equal(checkWritable(root, ".owncoder/plans/a.md", "balanced").ok, true);
  assert.equal(checkWritable(root, "src/a.ts", "balanced").ok, true);
}

{
  const paths = extractPathsFromPlan(
    "# Plan\n1. Edit `packages/core/src/index.ts`\n2. Touch apps/desktop/src/main/index.ts\n",
  );
  assert.ok(paths.some((p) => p.includes("packages/core")));
}

{
  const dir = await mkdtemp(join(tmpdir(), "owncoder-plan-"));
  try {
    const rel = await writePlanFile(dir, "## Steps\n1. do thing\n", { title: "Demo" });
    assert.ok(rel.startsWith(".owncoder/plans/"));
    const body = await readFile(join(dir, rel), "utf8");
    assert.ok(body.includes("Demo") || body.includes("Steps"));
    const list = await listPlans(dir);
    assert.equal(list.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void require;
console.log("harness-smoke: ok (incl. plans)");
