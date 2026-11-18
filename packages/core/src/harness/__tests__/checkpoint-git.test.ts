import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import git from "isomorphic-git";
import {
  persistCheckpoint,
  loadCheckpoint,
  listCheckpoints,
  restoreCheckpointFiles,
  deleteCheckpoint,
  deleteSessionCheckpoints,
  newCheckpointId,
  gitAutoSnapshot,
  type TurnCheckpoint,
} from "../checkpoint.ts";
import { runGit } from "../../git.ts";

/** Snapshot refs present in the repo (helper for cleanup assertions). */
async function snapshotRefs(root: string): Promise<string[]> {
  const res = await runGit(root, ["for-each-ref", "--format=%(refname)", "refs/owncoder-checkpoint"]);
  if (res.code !== 0) return [];
  return res.out.split(/\r?\n/).filter(Boolean);
}

/** Create a real git repo (ZCode 式快照路径的前置条件). */
async function makeGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  expect((await runGit(dir, ["init", "-b", "main"])).code).toBe(0);
  expect((await runGit(dir, ["config", "user.name", "Test"])).code).toBe(0);
  expect((await runGit(dir, ["config", "user.email", "test@test.local"])).code).toBe(0);
}

function makeCheckpoint(sessionId: string, files: TurnCheckpoint["files"], touched: string[]): TurnCheckpoint {
  return {
    id: newCheckpointId(),
    createdAt: new Date().toISOString(),
    historyLen: 1,
    history: [{ role: "user", content: "hello" }],
    files,
    touched,
    sessionId,
  };
}

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

  // ── 非 git 工作区：内联内容退化路径 ──

  it("非 git 目录：内联内容 persist/load/restore", async () => {
    const sessionId = "plain-session";
    await fs.writeFile(join(testRoot, "a.txt"), "modified", "utf8");

    const cp = makeCheckpoint(
      sessionId,
      [{ path: "a.txt", existed: true, content: "original" }],
      ["a.txt"],
    );
    await persistCheckpoint(testRoot, cp);

    const loaded = await loadCheckpoint(testRoot, cp.id);
    expect(loaded).toBeTruthy();
    expect(loaded?.id).toBe(cp.id);
    expect(loaded?.history).toHaveLength(1);
    expect(loaded?.files).toHaveLength(1);
    expect(loaded?.files[0]?.content).toBe("original");

    const restored = await restoreCheckpointFiles(testRoot, loaded!);
    expect(restored).toContain("a.txt");
    expect(await fs.readFile(join(testRoot, "a.txt"), "utf8")).toBe("original");
  });

  it("非 git 目录：turn 中新建的文件在回滚时被删除", async () => {
    const sessionId = "plain-delete";
    await fs.writeFile(join(testRoot, "created.txt"), "new content", "utf8");

    const cp = makeCheckpoint(
      sessionId,
      [{ path: "created.txt", existed: false }],
      ["created.txt"],
    );
    await persistCheckpoint(testRoot, cp);

    const loaded = await loadCheckpoint(testRoot, cp.id);
    expect(loaded?.files[0]?.existed).toBe(false);

    await restoreCheckpointFiles(testRoot, loaded!);
    await expect(fs.readFile(join(testRoot, "created.txt"), "utf8")).rejects.toThrow();
  });

  // ── git 工作区：ZCode 式 hidden ref 路径（零拷贝） ──

  it("git 目录：persist 引用快照 ref，load 从 git 对象 materialize", async () => {
    const sessionId = "git-session-1";
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);
    await fs.writeFile(join(repo, "tracked.txt"), "v1", "utf8");
    await runGit(repo, ["add", "tracked.txt"]);
    await runGit(repo, ["commit", "-m", "init"]);

    // turn 前状态：修改已追踪文件 + 存在一个未追踪文件
    await fs.writeFile(join(repo, "tracked.txt"), "v2-dirty", "utf8");
    await fs.writeFile(join(repo, "untracked.txt"), "present", "utf8");

    const snapshot = await gitAutoSnapshot(repo, "before-execute");
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    const cp = makeCheckpoint(
      sessionId,
      [
        { path: "tracked.txt", existed: true, content: "v2-dirty" },
        { path: "untracked.txt", existed: true, content: "present" },
      ],
      ["tracked.txt", "untracked.txt"],
    );
    await persistCheckpoint(repo, cp, { ref: snapshot.snapshot.ref, commit: snapshot.snapshot.commit });

    // 元数据只存 ref，不复制内容；快照 ref 存在且真实
    const refs = await snapshotRefs(repo);
    expect(refs).toContain(snapshot.snapshot.ref);

    const loaded = await loadCheckpoint(repo, cp.id);
    expect(loaded).toBeTruthy();
    expect(loaded?.ref).toBe(snapshot.snapshot.ref);
    expect(loaded?.files).toHaveLength(2);
    const tracked = loaded?.files.find((f) => f.path === "tracked.txt");
    const untracked = loaded?.files.find((f) => f.path === "untracked.txt");
    expect(tracked?.existed).toBe(true);
    expect(tracked?.content).toBe("v2-dirty");
    expect(untracked?.existed).toBe(true);
    expect(untracked?.content).toBe("present");
  });

  it("git 目录：快照不污染用户真实 index", async () => {
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);
    await fs.writeFile(join(repo, "a.txt"), "v1", "utf8");
    const staged = await runGit(repo, ["add", "a.txt"]);
    expect(staged.code).toBe(0);

    await gitAutoSnapshot(repo, "before-execute");

    // 真实 index 不应被快照的临时 index 影响：暂存内容不变
    const diffCached = await runGit(repo, ["diff", "--cached", "--name-only"]);
    expect(diffCached.out.trim()).toBe("a.txt");
    // 临时 index 文件已被清理
    const gitDir = (await runGit(repo, ["rev-parse", "--absolute-git-dir"])).out.trim();
    const leftovers = (await fs.readdir(gitDir)).filter((f) => f.startsWith("owncoder-snapshot-"));
    expect(leftovers).toHaveLength(0);
  });

  it("git 目录：回滚还原修改并删除 turn 中新建的文件", async () => {
    const sessionId = "git-restore";
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);
    await fs.writeFile(join(repo, "existing.txt"), "original", "utf8");

    const snapshot = await gitAutoSnapshot(repo, "before-execute");
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    const cp = makeCheckpoint(
      sessionId,
      [{ path: "existing.txt", existed: true, content: "original" }],
      ["existing.txt", "new-file.txt"],
    );
    await persistCheckpoint(repo, cp, { ref: snapshot.snapshot.ref, commit: snapshot.snapshot.commit });

    // turn 中：修改已有文件 + 新建文件
    await fs.writeFile(join(repo, "existing.txt"), "modified", "utf8");
    await fs.writeFile(join(repo, "new-file.txt"), "created in turn", "utf8");

    const loaded = await loadCheckpoint(repo, cp.id);
    expect(loaded?.files.find((f) => f.path === "new-file.txt")?.existed).toBe(false);

    const restored = await restoreCheckpointFiles(repo, loaded!);
    expect(restored).toContain("existing.txt");
    expect(restored).toContain("new-file.txt");
    expect(await fs.readFile(join(repo, "existing.txt"), "utf8")).toBe("original");
    await expect(fs.readFile(join(repo, "new-file.txt"), "utf8")).rejects.toThrow();
  });

  it("git 目录：void 快照 ref 过期后 load 返回 null（上层报 expired）", async () => {
    const sessionId = "git-expired";
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);

    const snapshot = await gitAutoSnapshot(repo, "before-execute");
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    const cp = makeCheckpoint(sessionId, [], []);
    await persistCheckpoint(repo, cp, { ref: snapshot.snapshot.ref, commit: snapshot.snapshot.commit });

    // 手动删除 ref（模拟 prune/手动 gc）
    await runGit(repo, ["update-ref", "-d", snapshot.snapshot.ref]);

    expect(await loadCheckpoint(repo, cp.id)).toBeNull();
  });
  it("跨会话隔离：list 与互不串扰", async () => {
    const session1 = "session-a";
    const session2 = "session-b";
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);

    for (const sessionId of [session1, session2]) {
      await fs.writeFile(join(repo, `${sessionId}.txt`), "x", "utf8");
      const snapshot = await gitAutoSnapshot(repo, "before-execute");
      if (!snapshot.ok) throw new Error("snapshot failed");
      const cp = makeCheckpoint(
        sessionId,
        [{ path: `${sessionId}.txt`, existed: true, content: "x" }],
        [`${sessionId}.txt`],
      );
      await persistCheckpoint(repo, cp, { ref: snapshot.snapshot.ref, commit: snapshot.snapshot.commit });
    }

    const list1 = await listCheckpoints(repo, session1);
    const list2 = await listCheckpoints(repo, session2);
    expect(list1).toHaveLength(1);
    expect(list2).toHaveLength(1);
    expect(list1[0]?.id).not.toBe(list2[0]?.id);
  });

  it("prune：超 MAX_KEEP 的检查点连同 ref 一起删除", { timeout: 60_000 }, async () => {
    const sessionId = "git-prune";
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);

    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      await fs.writeFile(join(repo, `f${i}.txt`), `content ${i}`, "utf8");
      const snapshot = await gitAutoSnapshot(repo, `before-execute-${i}`);
      if (!snapshot.ok) throw new Error("snapshot failed");
      const cp = makeCheckpoint(
        sessionId,
        [{ path: `f${i}.txt`, existed: true, content: `content ${i}` }],
        [`f${i}.txt`],
      );
      ids.push(cp.id);
      await persistCheckpoint(repo, cp, { ref: snapshot.snapshot.ref, commit: snapshot.snapshot.commit });
      await new Promise((r) => setTimeout(r, 5));
    }

    const list = await listCheckpoints(repo, sessionId);
    expect(list.length).toBeLessThanOrEqual(12);
    const newestIds = ids.slice(-12);
    for (const id of newestIds) {
      expect(list.map((c) => c.id)).toContain(id);
    }
    // 旧检查点（被 prune）的 ref 也一并删除，避免 ref 池只增不减
    const refs = await snapshotRefs(repo);
    expect(refs.length).toBeLessThanOrEqual(12);
  });

  it("deleteCheckpoint：删元数据，并删除无引用的 ref", async () => {
    const sessionId = "git-delete";
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);
    await fs.writeFile(join(repo, "a.txt"), "x", "utf8");

    const snapshot = await gitAutoSnapshot(repo, "before-execute");
    if (!snapshot.ok) throw new Error("snapshot failed");
    const cp = makeCheckpoint(
      sessionId,
      [{ path: "a.txt", existed: true, content: "x" }],
      ["a.txt"],
    );
    await persistCheckpoint(repo, cp, { ref: snapshot.snapshot.ref, commit: snapshot.snapshot.commit });
    expect((await snapshotRefs(repo))).toContain(snapshot.snapshot.ref);

    await deleteCheckpoint(repo, sessionId, cp.id);

    const metaDir = join(repo, ".owncoder/checkpoints", sessionId, "metadata");
    expect((await fs.readdir(metaDir)).filter((f) => f.endsWith(".json"))).toHaveLength(0);
    expect((await snapshotRefs(repo))).not.toContain(snapshot.snapshot.ref);
    expect(await loadCheckpoint(repo, cp.id)).toBeNull();
  });

  it("deleteSessionCheckpoints：删整目录 + 该会话的 refs，其他会话不受影响", async () => {
    const repo = join(testRoot, "repo");
    await makeGitRepo(repo);

    const makeSessionCp = async (sessionId: string) => {
      await fs.writeFile(join(repo, `${sessionId}.txt`), "x", "utf8");
      const snapshot = await gitAutoSnapshot(repo, "before-execute");
      if (!snapshot.ok) throw new Error("snapshot failed");
      const cp = makeCheckpoint(
        sessionId,
        [{ path: `${sessionId}.txt`, existed: true, content: "x" }],
        [`${sessionId}.txt`],
      );
      await persistCheckpoint(repo, cp, { ref: snapshot.snapshot.ref, commit: snapshot.snapshot.commit });
      return cp;
    };

    const cpA = await makeSessionCp("sess-a");
    const cpB = await makeSessionCp("sess-b");

    await deleteSessionCheckpoints(repo, "sess-a");

    // a 的整个会话目录与文件内容都消失
    await expect(fs.access(join(repo, ".owncoder/checkpoints/sess-a"))).rejects.toThrow();
    expect(await loadCheckpoint(repo, cpA.id)).toBeNull();
    // b 完好
    const loadedB = await loadCheckpoint(repo, cpB.id);
    expect(loadedB?.id).toBe(cpB.id);

    // a 的 ref 没了，b 的还在
    const refs = await snapshotRefs(repo);
    expect(refs.length).toBe(1);
    expect(await loadCheckpoint(repo, cpB.id)).toBeTruthy();
  });

  // ── legacy：旧格式（isomorphic-git 独立仓库 + commitHash）读取兼容 ──

  it("legacy：从 session 私有 isomorphic-git 仓库读取旧检查点", async () => {
    const sessionId = "legacy-session";
    const root = join(testRoot, "ws");
    const sessionDir = join(root, ".owncoder/checkpoints", sessionId);
    const wt = join(sessionDir, "workspace");
    const gd = join(sessionDir, ".git");
    await fs.mkdir(wt, { recursive: true });
    await fs.mkdir(join(sessionDir, "metadata"), { recursive: true });

    await git.init({ fs, dir: wt, gitdir: gd, defaultBranch: "checkpoints" });
    await git.setConfig({ fs, dir: wt, gitdir: gd, path: "user.name", value: "OwnCoder Checkpoint" });
    await git.setConfig({ fs, dir: wt, gitdir: gd, path: "user.email", value: "checkpoint@owncoder.local" });
    await fs.mkdir(join(wt, "src"), { recursive: true });
    await fs.writeFile(join(wt, "src", "legacy.ts"), "export const old = 1;", "utf8");
    await git.add({ fs, dir: wt, gitdir: gd, filepath: "src/legacy.ts" });
    const commitHash = await git.commit({
      fs,
      dir: wt,
      gitdir: gd,
      message: "legacy checkpoint",
      author: { name: "OwnCoder Checkpoint", email: "checkpoint@owncoder.local" },
    });

    const legacyId = "legacy-0001";
    await fs.writeFile(
      join(sessionDir, "metadata", `${legacyId}.json`),
      JSON.stringify({
        id: legacyId,
        createdAt: new Date().toISOString(),
        historyLen: 1,
        history: [{ role: "user", content: "legacy" }],
        sessionId,
        commitHash,
        touched: ["src/legacy.ts"],
      }),
      "utf8",
    );

    const loaded = await loadCheckpoint(root, legacyId);
    expect(loaded?.id).toBe(legacyId);
    expect(loaded?.files).toHaveLength(1);
    expect(loaded?.files[0]?.path).toBe("src/legacy.ts");
    expect(loaded?.files[0]?.content).toBe("export const old = 1;");

    // 旧检查点仍可回滚（内容写回真实 worktree）
    await fs.mkdir(join(root, "src"), { recursive: true });
    await fs.writeFile(join(root, "src", "legacy.ts"), "corrupted", "utf8");
    await restoreCheckpointFiles(root, loaded!);
    expect(await fs.readFile(join(root, "src", "legacy.ts"), "utf8")).toBe("export const old = 1;");
  });
});
