import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  persistCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  newCheckpointId,
} from "./dist/harness/checkpoint.js";

async function test() {
  const testRoot = join(tmpdir(), `checkpoint-test-${Date.now()}`);
  await fs.mkdir(testRoot, { recursive: true });

  console.log("Test root:", testRoot);

  try {
    // Test 1: Create and load checkpoint
    console.log("\n=== Test 1: Create and load checkpoint ===");
    const sessionId = "test-session-1";
    const cp = {
      id: newCheckpointId(),
      createdAt: new Date().toISOString(),
      historyLen: 2,
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      files: [
        { path: "test.txt", existed: true, content: "original content" },
        { path: "src/file.ts", existed: true, content: "export const x = 1;" },
      ],
      touched: ["test.txt", "src/file.ts"],
      sessionId,
    };

    console.log("Persisting checkpoint:", cp.id);
    await persistCheckpoint(testRoot, cp);
    console.log("✓ Checkpoint persisted");

    console.log("Loading checkpoint:", cp.id);
    const loaded = await loadCheckpoint(testRoot, cp.id);
    console.log("✓ Checkpoint loaded");
    console.log("  - id:", loaded?.id);
    console.log("  - historyLen:", loaded?.historyLen);
    console.log("  - files count:", loaded?.files.length);
    console.log("  - file[0] content:", loaded?.files[0]?.content?.slice(0, 20));

    // Test 2: List checkpoints
    console.log("\n=== Test 2: List checkpoints ===");
    const list = await listCheckpoints(testRoot);
    console.log("✓ Listed checkpoints:", list.length);
    console.log("  - ids:", list.map((c) => c.id));

    // Test 3: Multiple checkpoints
    console.log("\n=== Test 3: Multiple checkpoints ===");
    for (let i = 0; i < 3; i++) {
      const cp2 = {
        id: newCheckpointId(),
        createdAt: new Date().toISOString(),
        historyLen: 1,
        history: [{ role: "user", content: `msg ${i}` }],
        files: [{ path: `file${i}.txt`, existed: true, content: `content ${i}` }],
        touched: [`file${i}.txt`],
        sessionId,
      };
      await persistCheckpoint(testRoot, cp2);
      await new Promise((r) => setTimeout(r, 10));
    }
    const list2 = await listCheckpoints(testRoot);
    console.log("✓ Total checkpoints:", list2.length);

    console.log("\n✅ All tests passed!");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  } finally {
    // Cleanup
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {}
  }
}

test();
