import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import git from "isomorphic-git";
import { isGitRepo, runGit } from "../git.ts";

interface CheckpointChatTurn {
  role: string;
  content: string;
  toolName?: string;
}

export interface FileSnapshot {
  path: string;
  existed: boolean;
  content?: string;
}

export interface TurnCheckpoint {
  id: string;
  createdAt: string;
  historyLen: number;
  history: CheckpointChatTurn[];
  files: FileSnapshot[];
  /** Paths mutated during the turn (filled as edits happen). */
  touched: string[];
  /**
   * Owning session. `.owncoder/checkpoints/` is workspace-global, so without this
   * a rollback could restore another session's snapshot and — worse — replace
   * the current conversation with that session's history. Absent on checkpoints
   * written before this field existed; treat those as unknown ownership.
   */
  sessionId?: string | null;
}

/** Metadata stored separately from git commit */
interface CheckpointMetadata {
  id: string;
  createdAt: string;
  historyLen: number;
  history: CheckpointChatTurn[];
  sessionId?: string | null;
  commitHash: string;
  touched?: string[];
}

const CHECKPOINTS_DIR = ".owncoder/checkpoints";
/** Checkpoints kept per session */
const MAX_KEEP = 12;

/** Get session-specific checkpoint directory */
function sessionCheckpointDir(workspaceRoot: string, sessionId: string): string {
  return resolve(workspaceRoot, CHECKPOINTS_DIR, sessionId);
}

/** Get git dir for session */
function gitDir(workspaceRoot: string, sessionId: string): string {
  return join(sessionCheckpointDir(workspaceRoot, sessionId), ".git");
}

/** Get work tree (where files are checked out) */
function workTree(workspaceRoot: string, sessionId: string): string {
  return join(sessionCheckpointDir(workspaceRoot, sessionId), "workspace");
}

/** Get metadata dir */
function metadataDir(workspaceRoot: string, sessionId: string): string {
  return join(sessionCheckpointDir(workspaceRoot, sessionId), "metadata");
}

/** Initialize git repo for session if not exists */
async function ensureGitRepo(workspaceRoot: string, sessionId: string): Promise<void> {
  const dir = sessionCheckpointDir(workspaceRoot, sessionId);
  const gitDirPath = gitDir(workspaceRoot, sessionId);
  
  try {
    await fs.access(gitDirPath);
    // Already exists
    return;
  } catch {
    // Need to init
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(workTree(workspaceRoot, sessionId), { recursive: true });
  await fs.mkdir(metadataDir(workspaceRoot, sessionId), { recursive: true });

  await git.init({
    fs,
    dir: workTree(workspaceRoot, sessionId),
    gitdir: gitDirPath,
    defaultBranch: "checkpoints",
  });

  // Configure git
  await git.setConfig({
    fs,
    dir: workTree(workspaceRoot, sessionId),
    gitdir: gitDirPath,
    path: "user.name",
    value: "OwnCoder Checkpoint",
  });

  await git.setConfig({
    fs,
    dir: workTree(workspaceRoot, sessionId),
    gitdir: gitDirPath,
    path: "user.email",
    value: "checkpoint@owncoder.local",
  });
}

export function newCheckpointId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export async function snapshotFileBeforeWrite(
  workspaceRoot: string,
  relPath: string,
  files: FileSnapshot[],
): Promise<void> {
  if (files.some((f) => f.path === relPath)) return;
  const abs = resolve(workspaceRoot, relPath);
  try {
    const content = await fs.readFile(abs, "utf8");
    files.push({ path: relPath, existed: true, content });
  } catch {
    files.push({ path: relPath, existed: false });
  }
}

/**
 * Persist checkpoint using git commit for files and separate JSON for metadata
 */
export async function persistCheckpoint(
  workspaceRoot: string,
  cp: TurnCheckpoint,
): Promise<void> {
  const startTime = Date.now();
  console.log(`[checkpoint] persistCheckpoint 开始: id=${cp.id}, files=${cp.files.length}`);
  
  if (!cp.sessionId) {
    throw new Error("sessionId is required for git-based checkpoints");
  }

  const t0 = Date.now();
  await ensureGitRepo(workspaceRoot, cp.sessionId);
  console.log(`[checkpoint] - 仓库初始化完成: ${Date.now() - t0}ms`);

  const wt = workTree(workspaceRoot, cp.sessionId);
  const gd = gitDir(workspaceRoot, cp.sessionId);

  // Write files to work tree and stage them
  const t1 = Date.now();
  for (const snap of cp.files) {
    const absPath = join(wt, snap.path);
    if (snap.existed) {
      // File should exist - write content
      await fs.mkdir(dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, snap.content ?? "", "utf8");
      
      // Stage the file
      await git.add({
        fs,
        dir: wt,
        gitdir: gd,
        filepath: snap.path,
      });
    } else {
      // File should be deleted - remove from work tree and stage removal
      try {
        await git.remove({
          fs,
          dir: wt,
          gitdir: gd,
          filepath: snap.path,
        });
      } catch {
        // File might not exist in git yet, that's ok
      }
    }
  }

  console.log(`[checkpoint] - 文件写入及暂存完成: ${Date.now() - t1}ms`);

  // Create commit
  const t2 = Date.now();
  const commitHash = await git.commit({
    fs,
    dir: wt,
    gitdir: gd,
    message: `Checkpoint ${cp.id} at ${cp.createdAt}`,
    author: {
      name: "OwnCoder Checkpoint",
      email: "checkpoint@owncoder.local",
    },
  });
  console.log(`[checkpoint] - Git commit 完成: ${Date.now() - t2}ms`);

  // Save metadata separately
  const t3 = Date.now();
  const metadata: CheckpointMetadata = {
    id: cp.id,
    createdAt: cp.createdAt,
    historyLen: cp.historyLen,
    history: cp.history,
    sessionId: cp.sessionId,
    commitHash,
    touched: cp.touched,
  };

  const metaFile = join(metadataDir(workspaceRoot, cp.sessionId), `${cp.id}.json`);
  await fs.writeFile(metaFile, JSON.stringify(metadata), "utf8");
  console.log(`[checkpoint] - 元数据保存完成: ${Date.now() - t3}ms`);

  const t4 = Date.now();
  await pruneCheckpoints(workspaceRoot, cp.sessionId);
  console.log(`[checkpoint] - 旧检查点清理完成: ${Date.now() - t4}ms`);

  console.log(`[checkpoint] - persistCheckpoint 总耗时: ${Date.now() - startTime}ms`);
}

/**
 * Keep the newest MAX_KEEP checkpoints per session
 */
async function pruneCheckpoints(workspaceRoot: string, sessionId: string): Promise<void> {
  const metaDir = metadataDir(workspaceRoot, sessionId);
  
  let entries;
  try {
    entries = await fs.readdir(metaDir);
  } catch {
    return;
  }

  // Newest first: ids start with Date.now().toString(36), so name sort works
  const jsons = entries.filter((e) => e.endsWith(".json")).sort().reverse();

  if (jsons.length <= MAX_KEEP) return;

  // Remove old checkpoints
  const toRemove = jsons.slice(MAX_KEEP);
  for (const name of toRemove) {
    await fs.unlink(join(metaDir, name)).catch(() => undefined);
  }

  // Note: We keep all git commits for now. In production you might want to:
  // - Use git tags for checkpoints and delete unreferenced commits
  // - Run git gc periodically
  // For now, extra commits are cheap and can be cleaned manually if needed
}

export async function listCheckpoints(
  workspaceRoot: string,
  sessionId: string,
): Promise<
  Array<{
    id: string;
    createdAt: string;
    touched: string[];
    historyLen: number;
    sessionId?: string | null;
  }>
> {
  const result: Array<{
    id: string;
    createdAt: string;
    touched: string[];
    historyLen: number;
    sessionId?: string | null;
  }> = [];

  // Only scan the specified session directory
  const metaDir = metadataDir(workspaceRoot, sessionId);
  
  let entries;
  try {
    entries = await fs.readdir(metaDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(join(metaDir, name), "utf8");
      const meta = JSON.parse(raw) as CheckpointMetadata;
      result.push({
        id: meta.id,
        createdAt: meta.createdAt,
        touched: [], // Not tracked in git version
        historyLen: meta.historyLen,
        sessionId: meta.sessionId,
      });
    } catch {
      // Skip corrupted metadata
    }
  }

  // Sort newest first
  result.sort((a, b) => b.id.localeCompare(a.id));
  return result;
}

export async function loadCheckpoint(
  workspaceRoot: string,
  id: string,
): Promise<TurnCheckpoint | null> {
  const startTime = Date.now();
  console.log(`[checkpoint] loadCheckpoint 开始: id=${id}`);
  
  // Need to find which session owns this checkpoint
  const checkpointsRoot = resolve(workspaceRoot, CHECKPOINTS_DIR);
  
  let sessions;
  const t0 = Date.now();
  try {
    sessions = await fs.readdir(checkpointsRoot);
  } catch {
    console.log(`[checkpoint] loadCheckpoint 失败: 检查点目录不存在`);
    console.log(`[checkpoint] - loadCheckpoint 总耗时: ${Date.now() - startTime}ms`);
    return null;
  } finally {
    console.log(`[checkpoint] - 会话目录扫描: ${Date.now() - t0}ms`);
  }

  // Search all sessions for this checkpoint ID
  const t1 = Date.now();
  console.log(`[checkpoint] - 搜索 ${sessions.length} 个会话目录`);
  for (const sessionId of sessions) {
    const metaFile = join(metadataDir(workspaceRoot, sessionId), `${id}.json`);
    
    try {
      const raw = await fs.readFile(metaFile, "utf8");
      const meta = JSON.parse(raw) as CheckpointMetadata;

      // Found it, now load from git
      console.log(`[checkpoint] - 元数据查找: ${Date.now() - t1}ms`);
      console.log(`[checkpoint] - 找到元数据，开始从 Git 加载: session=${sessionId}`);
      const result = await loadCheckpointFromMeta(workspaceRoot, sessionId, meta);
      console.log(`[checkpoint] - loadCheckpoint 总耗时: ${Date.now() - startTime}ms`);
      return result;
    } catch {
      // Not in this session, continue searching
      continue;
    }
  }

  console.log(`[checkpoint] - 元数据查找: ${Date.now() - t1}ms`);
  console.log(`[checkpoint] loadCheckpoint 失败: 未找到检查点 ${id}`);
  console.log(`[checkpoint] - loadCheckpoint 总耗时: ${Date.now() - startTime}ms`);
  return null;
}

async function loadCheckpointFromMeta(
  workspaceRoot: string,
  sessionId: string,
  meta: CheckpointMetadata,
): Promise<TurnCheckpoint> {
  const wt = workTree(workspaceRoot, sessionId);
  const gd = gitDir(workspaceRoot, sessionId);

  const fileMap = new Map<string, FileSnapshot>();
  
  // List all files in commit recursively
  const t1 = Date.now();
  const commitObj = await git.readCommit({
    fs,
    dir: wt,
    gitdir: gd,
    oid: meta.commitHash,
  });

  // Walk tree recursively to collect all files
  async function walkTree(treeOid: string, prefix: string = ""): Promise<void> {
    const tree = await git.readTree({
      fs,
      dir: wt,
      gitdir: gd,
      oid: treeOid,
    });

    for (const entry of tree.tree) {
      const fullPath = prefix ? `${prefix}/${entry.path}` : entry.path;
      
      if (entry.type === "blob") {
        const content = await git.readBlob({
          fs,
          dir: wt,
          gitdir: gd,
          oid: entry.oid,
        });
        fileMap.set(fullPath, {
          path: fullPath,
          existed: true,
          content: Buffer.from(content.blob).toString("utf8"),
        });
      } else if (entry.type === "tree") {
        // Recurse into subdirectory
        await walkTree(entry.oid, fullPath);
      }
    }
  }

  await walkTree(commitObj.commit.tree);
  console.log(`[checkpoint] - Git 树遍历与文件读取: ${Date.now() - t1}ms`);

  // If we have touched order, use it; otherwise use map values
  const files: FileSnapshot[] = [];
  if (meta.touched && meta.touched.length > 0) {
    for (const path of meta.touched) {
      const snap = fileMap.get(path);
      if (snap) {
        files.push(snap);
      }
    }
    // Add any remaining files not in touched list
    for (const [path, snap] of fileMap) {
      if (!meta.touched.includes(path)) {
        files.push(snap);
      }
    }
  } else {
    files.push(...fileMap.values());
  }

  return {
    id: meta.id,
    createdAt: meta.createdAt,
    historyLen: meta.historyLen,
    history: meta.history,
    files,
    touched: meta.touched ?? [],
    sessionId: meta.sessionId,
  };
}

/** Restore files from checkpoint; returns restored relative paths */
export async function restoreCheckpointFiles(
  workspaceRoot: string,
  cp: TurnCheckpoint,
): Promise<string[]> {
  const startTime = Date.now();
  console.log(`[checkpoint] restoreCheckpointFiles 开始: id=${cp.id}, files=${cp.files.length}`);
  
  const restored: string[] = [];
  // Restore in reverse touch order when possible
  const files = [...cp.files].reverse();
  for (const snap of files) {
    const abs = resolve(workspaceRoot, snap.path);
    if (!snap.existed) {
      await fs.unlink(abs).catch(() => undefined);
      restored.push(snap.path);
      continue;
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, snap.content ?? "", "utf8");
    restored.push(snap.path);
  }
  console.log(`[checkpoint] - restoreCheckpointFiles 总耗时: ${Date.now() - startTime}ms`);
  return restored;
}

// ── Git Snapshot Safety Net ────────────────────────────────

export interface GitSnapshot {
  /** Unique snapshot ID */
  id: string;
  /** Human-readable label */
  label: string;
  /** Full ref name holding the snapshot commit (refs/owncoder-checkpoint/<id>). */
  ref: string;
  /** Snapshot commit SHA. */
  commit: string;
  /** Timestamp */
  createdAt: string;
  /** Files that were dirty at snapshot time */
  touchedFiles: string[];
}

const GIT_SNAPSHOT_PREFIX = "owncoder-checkpoint";
const GIT_SNAPSHOT_REF_NS = `refs/${GIT_SNAPSHOT_PREFIX}`;
const MAX_GIT_SNAPSHOTS = 20;

/** Identity for snapshot commits — works even when the repo has no user.name/email. */
const SNAPSHOT_COMMIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "owncoder",
  GIT_AUTHOR_EMAIL: "owncoder@localhost",
  GIT_COMMITTER_NAME: "owncoder",
  GIT_COMMITTER_EMAIL: "owncoder@localhost",
};

/**
 * Outcome of a snapshot attempt. "not-a-repo" and "clean" are normal no-ops;
 * "failed" means the safety net the caller is relying on does NOT exist and the
 * user needs to hear about it.
 */
export type GitSnapshotResult =
  | { ok: true; snapshot: GitSnapshot }
  | { ok: false; reason: "not-a-repo" | "clean" | "failed"; error?: string };

/**
 * Auto-snapshot the working tree before the agent modifies files.
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION: the working tree and the real index are
 * never touched. We build the snapshot in a throwaway index file
 * (`GIT_INDEX_FILE`), write a tree from it, and record that tree as a commit
 * under `refs/owncoder-checkpoint/<id>`.
 *
 * Do NOT go back to `git stash push` here: stash *moves* the dirty state out of
 * the working tree, so every snapshot silently reverted the edits made by the
 * previous ReAct iteration (the "my changes keep disappearing" bug).
 *
 * Recover with `gitRestoreSnapshot()`, or manually:
 *   git diff <ref> -- <path>
 *   git checkout <ref> -- <path>
 */
export async function gitAutoSnapshot(
  workspaceRoot: string,
  label = "auto-snapshot",
): Promise<GitSnapshotResult> {
  const startTime = Date.now();
  console.log(`[checkpoint] gitAutoSnapshot 开始: label=${label}`);
  
  const t0 = Date.now();
  if (!(await isGitRepo(workspaceRoot))) {
    console.log(`[checkpoint] gitAutoSnapshot 跳过: 非 Git 仓库`);
    return { ok: false, reason: "not-a-repo" };
  }
  console.log(`[checkpoint] - Git 仓库检查完成: ${Date.now() - t0}ms`);

  // Check if there's anything to save
  const t1 = Date.now();
  const status = await runGit(workspaceRoot, ["status", "--porcelain"]);
  console.log(`[checkpoint] - Git status 检查完成: ${Date.now() - t1}ms`);
  
  if (status.code !== 0) {
    console.log(`[checkpoint] gitAutoSnapshot 失败: git status 失败`);
    return { ok: false, reason: "failed", error: status.err || "git status failed" };
  }
  if (!status.out.trim()) {
    console.log(`[checkpoint] gitAutoSnapshot 跳过: 工作区干净，无需快照`);
    return { ok: false, reason: "clean" }; // Clean working tree, nothing to snapshot
  }

  // Get list of dirty files for tracking
  const dirtyFiles = status.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line: string) => line.slice(3).trim())
    .filter(Boolean);
  console.log(`[checkpoint] - 发现 ${dirtyFiles.length} 个变更文件`);

  const t2 = Date.now();
  const gitDir = await runGit(workspaceRoot, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.code !== 0 || !gitDir.out.trim()) {
    console.log(`[checkpoint] gitAutoSnapshot 失败: 无法解析 Git 目录`);
    return { ok: false, reason: "failed", error: gitDir.err || "cannot resolve git dir" };
  }
  console.log(`[checkpoint] - Git 目录解析完成: ${Date.now() - t2}ms`);

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const message = `${GIT_SNAPSHOT_PREFIX}:${id}:${label}`;
  const tmpIndex = join(gitDir.out.trim(), `owncoder-snapshot-${id}.index`);
  const env: Record<string, string> = { ...SNAPSHOT_COMMIT_ENV, GIT_INDEX_FILE: tmpIndex };

  try {
    // A fresh repo with zero commits has no HEAD — snapshot as a root commit.
    const t3 = Date.now();
    const head = await runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"]);
    const parent = head.code === 0 ? head.out.trim() : null;
    console.log(`[checkpoint] - HEAD 解析完成: ${Date.now() - t3}ms`);

    const step = (what: string, err: string): GitSnapshotResult => {
      const detail = err.trim() || `git ${what} failed`;
      console.log(`[checkpoint] git ${what} failed:`, detail);
      return { ok: false, reason: "failed", error: detail };
    };

    if (parent) {
      const t4 = Date.now();
      const readTree = await runGit(workspaceRoot, ["read-tree", parent], 15_000, env);
      if (readTree.code !== 0) return step("read-tree", readTree.err);
      console.log(`[checkpoint] - read-tree 完成: ${Date.now() - t4}ms`);
    }

    // Stage everything (tracked edits, deletions and untracked files) into the
    // throwaway index. .gitignore is still respected, matching `stash -u`.
    const t5 = Date.now();
    const add = await runGit(workspaceRoot, ["add", "-A", "--", "."], 60_000, env);
    if (add.code !== 0) return step("add", add.err);
    console.log(`[checkpoint] - git add 完成: ${Date.now() - t5}ms`);

    const t6 = Date.now();
    const writeTree = await runGit(workspaceRoot, ["write-tree"], 30_000, env);
    if (writeTree.code !== 0 || !writeTree.out.trim()) return step("write-tree", writeTree.err);
    const tree = writeTree.out.trim();
    console.log(`[checkpoint] - write-tree 完成: ${Date.now() - t6}ms`);

    const t7 = Date.now();
    const commitArgs = ["commit-tree", tree, "-m", message];
    if (parent) commitArgs.push("-p", parent);
    const commitTree = await runGit(workspaceRoot, commitArgs, 15_000, env);
    if (commitTree.code !== 0 || !commitTree.out.trim()) return step("commit-tree", commitTree.err);
    const commit = commitTree.out.trim();
    console.log(`[checkpoint] - commit-tree 完成: ${Date.now() - t7}ms`);

    // Anchor the commit to a ref so gc/prune can never reclaim it.
    const t8 = Date.now();
    const ref = `${GIT_SNAPSHOT_REF_NS}/${id}`;
    const updateRef = await runGit(workspaceRoot, ["update-ref", ref, commit], 15_000, env);
    if (updateRef.code !== 0) return step("update-ref", updateRef.err);
    console.log(`[checkpoint] - update-ref 完成: ${Date.now() - t8}ms`);

    console.log("[checkpoint] git snapshot created:", id, dirtyFiles.length, "files ->", ref);

    // Prune old snapshots
    const t9 = Date.now();
    await pruneGitSnapshots(workspaceRoot);
    console.log(`[checkpoint] - 旧快照清理完成: ${Date.now() - t9}ms`);
    
    return {
      ok: true,
      snapshot: {
        id,
        label,
        ref,
        commit,
        createdAt: new Date().toISOString(),
        touchedFiles: dirtyFiles,
      },
    };
  } finally {
    await fs.unlink(tmpIndex).catch(() => undefined);
    console.log(`[checkpoint] - gitAutoSnapshot 总耗时: ${Date.now() - startTime}ms`);
  }
}

/** Snapshot refs, newest first. */
export async function listGitSnapshots(
  workspaceRoot: string,
): Promise<Array<{ id: string; ref: string; commit: string; label: string; createdAt: string }>> {
  const res = await runGit(workspaceRoot, [
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)",
    GIT_SNAPSHOT_REF_NS,
  ]);
  if (res.code !== 0) return [];
  const out: Array<{ id: string; ref: string; commit: string; label: string; createdAt: string }> = [];
  for (const line of res.out.split(/\r?\n/).filter(Boolean)) {
    const [ref, commit, createdAt, subject = ""] = line.split("\t");
    if (!ref || !commit) continue;
    const id = ref.slice(`${GIT_SNAPSHOT_REF_NS}/`.length);
    const label = subject.startsWith(`${GIT_SNAPSHOT_PREFIX}:${id}:`)
      ? subject.slice(`${GIT_SNAPSHOT_PREFIX}:${id}:`.length)
      : subject;
    out.push({ id, ref, commit, label, createdAt: createdAt ?? "" });
  }
  return out;
}

/**
 * Restore files from a snapshot ref back into the working tree.
 * With no `paths`, restores every path recorded in the snapshot.
 */
export async function gitRestoreSnapshot(
  workspaceRoot: string,
  id: string,
  paths?: string[],
): Promise<{ ok: boolean; error?: string }> {
  const ref = `${GIT_SNAPSHOT_REF_NS}/${id}`;
  const verify = await runGit(workspaceRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (verify.code !== 0) return { ok: false, error: `snapshot not found: ${id}` };
  const targets = paths?.length ? paths : ["."];
  const res = await runGit(workspaceRoot, ["checkout", ref, "--", ...targets], 60_000);
  if (res.code !== 0) return { ok: false, error: res.err || "git checkout failed" };
  return { ok: true };
}

/** Prune old auto-snapshots so the ref namespace doesn't grow without bound. */
async function pruneGitSnapshots(workspaceRoot: string): Promise<void> {
  const snapshots = await listGitSnapshots(workspaceRoot);
  const stale = snapshots.slice(MAX_GIT_SNAPSHOTS);
  for (const snap of stale) {
    await runGit(workspaceRoot, ["update-ref", "-d", snap.ref]);
  }
  if (stale.length > 0) {
    console.log("[checkpoint] pruned", stale.length, "old git snapshots");
  }
}
