import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  persistCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  restoreCheckpointFiles,
  newCheckpointId,
  type TurnCheckpoint,
} from "../checkpoint.ts";

describe("checkpoint-git", () => {
  let testRoot: string;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testRoot = join(tmpdir(), `checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    // Clean up
    try {
      await fs.rm(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should create and load a checkpoint with files", async () => {
    const sessionId = "test-session-1";
    const cp: TurnCheckpoint = {
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

    await persistCheckpoint(testRoot, cp);

    const loaded = await loadCheckpoint(testRoot, cp.id);
    expect(loaded).toBeTruthy();
    expect(loaded?.id).toBe(cp.id);
    expect(loaded?.historyLen).toBe(2);
    expect(loaded?.history).toHaveLength(2);
    expect(loaded?.files).toHaveLength(2);
    expect(loaded?.files[0].content).toBe("original content");
  });

  it("should handle file deletions", async () => {
    const sessionId = "test-session-2";
    const cp: TurnCheckpoint = {
      id: newCheckpointId(),
      createdAt: new Date().toISOString(),
      historyLen: 1,
      history: [{ role: "user", content: "delete file" }],
      files: [
        { path: "deleted.txt", existed: false }, // File was deleted
      ],
      touched: ["deleted.txt"],
      sessionId,
    };

    await persistCheckpoint(testRoot, cp);

    const loaded = await loadCheckpoint(testRoot, cp.id);
    expect(loaded).toBeTruthy();
    // Deleted files won't appear in git tree
    expect(loaded?.files).toHaveLength(0);
  });

  it("should list checkpoints across sessions", async () => {
    const session1 = "session-a";
    const session2 = "session-b";

    const cp1: TurnCheckpoint = {
      id: newCheckpointId(),
      createdAt: new Date().toISOString(),
      historyLen: 1,
      history: [{ role: "user", content: "msg1" }],
      files: [{ path: "file1.txt", existed: true, content: "content1" }],
      touched: ["file1.txt"],
      sessionId: session1,
    };

    const cp2: TurnCheckpoint = {
      id: newCheckpointId(),
      createdAt: new Date().toISOString(),
      historyLen: 1,
      history: [{ role: "user", content: "msg2" }],
      files: [{ path: "file2.txt", existed: true, content: "content2" }],
      touched: ["file2.txt"],
      sessionId: session2,
    };

    await persistCheckpoint(testRoot, cp1);
    await persistCheckpoint(testRoot, cp2);

    const list1 = await listCheckpoints(testRoot, session1);
    expect(list1).toHaveLength(1);
    expect(list1[0].id).toBe(cp1.id);
    
    const list2 = await listCheckpoints(testRoot, session2);
    expect(list2).toHaveLength(1);
    expect(list2[0].id).toBe(cp2.id);
  });

  it("should prune old checkpoints per session", async () => {
    const sessionId = "prune-test";

    // Create 15 checkpoints (MAX_KEEP is 12)
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const cp: TurnCheckpoint = {
        id: newCheckpointId(),
        createdAt: new Date().toISOString(),
        historyLen: i,
        history: [{ role: "user", content: `msg ${i}` }],
        files: [{ path: `file${i}.txt`, existed: true, content: `content ${i}` }],
        touched: [`file${i}.txt`],
        sessionId,
      };
      ids.push(cp.id);
      await persistCheckpoint(testRoot, cp);
      // Small delay to ensure different IDs
      await new Promise((r) => setTimeout(r, 5));
    }

    const list = await listCheckpoints(testRoot, sessionId);
    // Should keep only 12 newest
    expect(list.length).toBeLessThanOrEqual(12);
    
    // Newest ones should still be there
    const newestIds = ids.slice(-12);
    for (const id of newestIds) {
      expect(list.map((c) => c.id)).toContain(id);
    }
  });

  it("should restore files to workspace", async () => {
    const sessionId = "restore-test";
    
    // Create some actual files in workspace
    const file1 = join(testRoot, "restore-me.txt");
    const file2 = join(testRoot, "subdir", "nested.ts");
    
    await fs.writeFile(file1, "before", "utf8");
    await fs.mkdir(join(testRoot, "subdir"), { recursive: true });
    await fs.writeFile(file2, "before nested", "utf8");

    const cp: TurnCheckpoint = {
      id: newCheckpointId(),
      createdAt: new Date().toISOString(),
      historyLen: 1,
      history: [{ role: "user", content: "checkpoint" }],
      files: [
        { path: "restore-me.txt", existed: true, content: "original" },
        { path: "subdir/nested.ts", existed: true, content: "original nested" },
      ],
      touched: ["restore-me.txt", "subdir/nested.ts"],
      sessionId,
    };

    await persistCheckpoint(testRoot, cp);

    // Modify files
    await fs.writeFile(file1, "modified", "utf8");
    await fs.writeFile(file2, "modified nested", "utf8");

    // Load and restore
    const loaded = await loadCheckpoint(testRoot, cp.id);
    expect(loaded).toBeTruthy();
    
    const restored = await restoreCheckpointFiles(testRoot, loaded!);
    expect(restored).toContain("restore-me.txt");
    expect(restored).toContain("subdir/nested.ts");

    // Verify content restored
    const content1 = await fs.readFile(file1, "utf8");
    const content2 = await fs.readFile(file2, "utf8");
    expect(content1).toBe("original");
    expect(content2).toBe("original nested");
  });
});
