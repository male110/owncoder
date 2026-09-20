import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runGit, isGitRepo } from "../git.ts";

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

const CHECKPOINTS_DIR = ".owncoder/checkpoints";
/** Checkpoints kept per session (see pruneCheckpoints). */
const MAX_KEEP = 12;
/** Bucket for checkpoints written before `sessionId` existed. */
const UNKNOWN_SESSION = "\u0000unknown";

function checkpointDirAbs(workspaceRoot: string): string {
  return resolve(workspaceRoot, CHECKPOINTS_DIR);
}

async function ensureCheckpointDir(workspaceRoot: string): Promise<string> {
  const dir = checkpointDirAbs(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function newCheckpointId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

export async function persistCheckpoint(
  workspaceRoot: string,
  cp: TurnCheckpoint,
): Promise<void> {
  const dir = await ensureCheckpointDir(workspaceRoot);
  const file = join(dir, `${cp.id}.json`);
  // Compact JSON: pretty-print made prune/read parse multi-MB history+file
  // snapshots on every turn, which delayed sendChat / turn_complete.
  await fs.writeFile(file, JSON.stringify(cp), "utf8");
  await pruneCheckpoints(dir);
}

/**
 * Keep the newest MAX_KEEP checkpoints *per session*.
 *
 * The quota used to be per-directory, which meant two active sessions in one
 * workspace would evict each other's checkpoints — and an evicted checkpoint
 * turns the undo button into a silent no-op. Bucketing by session keeps each
 * session's undo depth independent.
 */
async function pruneCheckpoints(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return;
  }
  // Newest first: ids start with Date.now().toString(36), so name sort works.
  const jsons = entries.filter((e) => e.endsWith(".json")).sort().reverse();
  const seenPerSession = new Map<string, number>();
  for (const name of jsons) {
    const owner = await readCheckpointOwner(join(dir, name));
    const kept = seenPerSession.get(owner) ?? 0;
    if (kept >= MAX_KEEP) {
      await fs.unlink(join(dir, name)).catch(() => undefined);
      continue;
    }
    seenPerSession.set(owner, kept + 1);
  }
}

/** `sessionId` is the last field we write; only the file tail is needed. */
const SESSION_ID_TAIL = /"sessionId"\s*:\s*(null|"((?:[^"\\]|\\.)*)")\s*\}\s*$/;

async function readCheckpointOwner(file: string): Promise<string> {
  try {
    const fh = await fs.open(file, "r");
    try {
      const { size } = await fh.stat();
      if (size <= 0) return UNKNOWN_SESSION;
      const len = Math.min(1024, size);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      const match = SESSION_ID_TAIL.exec(buf.toString("utf8"));
      if (!match || match[1] === "null") return UNKNOWN_SESSION;
      return match[2] || UNKNOWN_SESSION;
    } finally {
      await fh.close();
    }
  } catch {
    return UNKNOWN_SESSION;
  }
}

export async function listCheckpoints(workspaceRoot: string): Promise<
  Array<{
    id: string;
    createdAt: string;
    touched: string[];
    historyLen: number;
    sessionId?: string | null;
  }>
> {
  const dir = checkpointDirAbs(workspaceRoot);
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{
    id: string;
    createdAt: string;
    touched: string[];
    historyLen: number;
    sessionId?: string | null;
  }> = [];
  for (const name of entries.filter((e) => e.endsWith(".json")).sort().reverse()) {
    try {
      const raw = await fs.readFile(join(dir, name), "utf8");
      const cp = JSON.parse(raw) as TurnCheckpoint;
      out.push({
        id: cp.id,
        createdAt: cp.createdAt,
        touched: cp.touched ?? [],
        historyLen: cp.historyLen,
        sessionId: cp.sessionId ?? null,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function loadCheckpoint(
  workspaceRoot: string,
  id: string,
): Promise<TurnCheckpoint | null> {
  try {
    const raw = await fs.readFile(join(checkpointDirAbs(workspaceRoot), `${id}.json`), "utf8");
    return JSON.parse(raw) as TurnCheckpoint;
  } catch {
    return null;
  }
}

/** Restore files from checkpoint; returns restored relative paths. */
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
    .map((line) => line.slice(3).trim())
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
