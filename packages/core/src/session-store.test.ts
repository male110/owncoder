import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionFile,
  loadSessionById,
  saveSessionById,
} from "./session-store.ts";

const roots: string[] = [];
async function root() {
  const r = await mkdtemp(join(tmpdir(), "session-store-"));
  roots.push(r);
  return r;
}
afterEach(async () => {
  for (const r of roots.splice(0)) {
    await rm(r, { recursive: true, force: true });
  }
});

describe("session store history sanitization", () => {
  it("strips tool result bodies on save and load while keeping ids", async () => {
    const r = await root();
    const { meta } = await createSessionFile(r, { title: "t" });
    const huge = "TOOL_BODY_" + "x".repeat(50_000);

    await saveSessionById(r, meta.id, {
      title: "t",
      mode: "agent",
      history: [
        { role: "user", content: "run ls" },
        { role: "tool", id: "c1", toolName: "bash", content: huge },
        { role: "assistant", content: "done" },
      ],
      terminalLog: [],
      lastPlanPath: null,
      todoAnchor: null,
      lastCheckpointId: null,
      documentWorkflow: null,
    });

    const loaded = await loadSessionById(r, meta.id);
    expect(loaded?.history).toEqual([
      { role: "user", content: "run ls" },
      { role: "tool", id: "c1", toolName: "bash", content: "" },
      { role: "assistant", content: "done" },
    ]);
    expect(JSON.stringify(loaded)).not.toContain("TOOL_BODY_");
  });
});
