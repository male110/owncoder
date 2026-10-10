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
  if (!cp.sessionId) {
    throw new Error("sessionId is required for git-based checkpoints");
  }

  await ensureGitRepo(workspaceRoot, cp.sessionId);

  const wt = workTree(workspaceRoot, cp.sessionId);
  const gd = gitDir(workspaceRoot, cp.sessionId);

  // Write files to work tree and stage them
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

  // Create commit
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

  // Save metadata separately
  const metadata: CheckpointMetadata = {
    id: cp.id,
    createdAt: cp.createdAt,
    historyLen: cp.historyLen,
    history: cp.history,
    sessionId: cp.sessionId,
    commitHash,
  };

  const metaFile = join(metadataDir(workspaceRoot, cp.sessionId), `${cp.id}.json`);
  await fs.writeFile(metaFile, JSON.stringify(metadata), "utf8");

  await pruneCheckpoints(workspaceRoot, cp.sessionId);
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
  // Need to find which session owns this checkpoint
  const checkpointsRoot = resolve(workspaceRoot, CHECKPOINTS_DIR);
  
  let sessions;
  try {
    sessions = await fs.readdir(checkpointsRoot);
  } catch {
    return null;
  }

  // Search all sessions for this checkpoint ID
  for (const sessionId of sessions) {
    const metaFile = join(metadataDir(workspaceRoot, sessionId), `${id}.json`);
    
    try {
      const raw = await fs.readFile(metaFile, "utf8");
      const meta = JSON.parse(raw) as CheckpointMetadata;

      // Found it, now load from git
      return await loadCheckpointFromMeta(workspaceRoot, sessionId, meta);
    } catch {
      // Not in this session, continue searching
      continue;
    }
  }

  return null;
}

async function loadCheckpointFromMeta(
  workspaceRoot: string,
  sessionId: string,
  meta: CheckpointMetadata,
): Promise<TurnCheckpoint> {
  const wt = workTree(workspaceRoot, sessionId);
  const gd = gitDir(workspaceRoot, sessionId);

  const files: FileSnapshot[] = [];
  
  // List all files in commit recursively
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
        files.push({
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

  return {
    id: meta.id,
    createdAt: meta.createdAt,
    historyLen: meta.historyLen,
    history: meta.history,
    files,
    touched: [], // Not tracked in git version
    sessionId: meta.sessionId,
  };
}

/** Restore files from checkpoint; returns restored relative paths */
export async function restoreCheckpointFiles(
  workspaceRoot: string,
  cp: TurnCheckpoint,
): Promise<string[]> {
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
  if (!(await isGitRepo(workspaceRoot))) return { ok: false, reason: "not-a-repo" };

  // Check if there's anything to save
  const status = await runGit(workspaceRoot, ["status", "--porcelain"]);
  if (status.code !== 0) {
    return { ok: false, reason: "failed", error: status.err || "git status failed" };
  }
  if (!status.out.trim()) {
    return { ok: false, reason: "clean" }; // Clean working tree, nothing to snapshot
  }

  // Get list of dirty files for tracking
  const dirtyFiles = status.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line: string) => line.slice(3).trim())
    .filter(Boolean);

  const gitDir = await runGit(workspaceRoot, ["rev-parse", "--absolute-git-dir"]);
  if (gitDir.code !== 0 || !gitDir.out.trim()) {
    return { ok: false, reason: "failed", error: gitDir.err || "cannot resolve git dir" };
  }

  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const message = `${GIT_SNAPSHOT_PREFIX}:${id}:${label}`;
  const tmpIndex = join(gitDir.out.trim(), `owncoder-snapshot-${id}.index`);
  const env: Record<string, string> = { ...SNAPSHOT_COMMIT_ENV, GIT_INDEX_FILE: tmpIndex };

  try {
    // A fresh repo with zero commits has no HEAD — snapshot as a root commit.
    const head = await runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"]);
    const parent = head.code === 0 ? head.out.trim() : null;

    const step = (what: string, err: string): GitSnapshotResult => {
      const detail = err.trim() || `git ${what} failed`;
      console.log(`[checkpoint] git ${what} failed:`, detail);
      return { ok: false, reason: "failed", error: detail };
    };

    if (parent) {
      const readTree = await runGit(workspaceRoot, ["read-tree", parent], 15_000, env);
      if (readTree.code !== 0) return step("read-tree", readTree.err);
    }

    // Stage everything (tracked edits, deletions and untracked files) into the
    // throwaway index. .gitignore is still respected, matching `stash -u`.
    const add = await runGit(workspaceRoot, ["add", "-A", "--", "."], 60_000, env);
    if (add.code !== 0) return step("add", add.err);

    const writeTree = await runGit(workspaceRoot, ["write-tree"], 30_000, env);
    if (writeTree.code !== 0 || !writeTree.out.trim()) return step("write-tree", writeTree.err);
    const tree = writeTree.out.trim();

    const commitArgs = ["commit-tree", tree, "-m", message];
    if (parent) commitArgs.push("-p", parent);
    const commitTree = await runGit(workspaceRoot, commitArgs, 15_000, env);
    if (commitTree.code !== 0 || !commitTree.out.trim()) return step("commit-tree", commitTree.err);
    const commit = commitTree.out.trim();

    // Anchor the commit to a ref so gc/prune can never reclaim it.
    const ref = `${GIT_SNAPSHOT_REF_NS}/${id}`;
    const updateRef = await runGit(workspaceRoot, ["update-ref", ref, commit], 15_000, env);
    if (updateRef.code !== 0) return step("update-ref", updateRef.err);

    console.log("[checkpoint] git snapshot created:", id, dirtyFiles.length, "files ->", ref);

    // Prune old snapshots
    await pruneGitSnapshots(workspaceRoot);

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
