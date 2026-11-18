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

/**
 * Anchor of a turn's pre-write snapshot inside the user's own repository:
 * the hidden ref name and the commit it points at. Carried from the ReAct loop
 * (which takes the snapshot before the first file-modifying tool) to
 * `persistCheckpoint` (which records it in the checkpoint metadata).
 */
export interface GitSnapshotAnchor {
  ref: string;
  commit: string;
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
  /**
   * Hidden ref in the user's own repository (refs/owncoder-checkpoint/<id>)
   * anchoring the pre-turn snapshot commit. When set, `files` is materialized
   * from that ref on load instead of being copied at persist time (ZCode 式：
   * 零拷贝，对象由 git 自身 GC 通过 ref 删除回收）。
   */
  ref?: string;
}

/**
 * Metadata JSON stored under `.owncoder/checkpoints/<sid>/metadata/<id>.json`.
 * Three storage shapes, in order of introduction:
 * 1. `ref`/`commit` — ZCode 式：内容在用户仓库的 hidden ref 上，零拷贝；
 * 2. `files` — 非 git 工作区退化路径：内容内联进 JSON；
 * 3. `commitHash` — legacy：内容在 session 私有的 isomorphic-git 仓库里，
 *    仅保留读取兼容。
 */
interface CheckpointMetadata {
  id: string;
  createdAt: string;
  historyLen: number;
  history: CheckpointChatTurn[];
  sessionId?: string | null;
  /** legacy: commit in the session-private isomorphic-git repo */
  commitHash?: string;
  touched?: string[];
  /** refs/owncoder-checkpoint/<id> anchoring the snapshot commit in the user repo */
  ref?: string;
  /** Snapshot commit oid backing `ref`. */
  commit?: string;
  /** Non-git fallback: file contents inlined */
  files?: FileSnapshot[];
}

const CHECKPOINTS_DIR = ".owncoder/checkpoints";
/** Checkpoints kept per session */
const MAX_KEEP = 12;

/** Get session-specific checkpoint directory */
function sessionCheckpointDir(workspaceRoot: string, sessionId: string): string {
  return resolve(workspaceRoot, CHECKPOINTS_DIR, sessionId);
}

/** Get git dir for session (legacy isomorphic-git repo only) */
function gitDir(workspaceRoot: string, sessionId: string): string {
  return join(sessionCheckpointDir(workspaceRoot, sessionId), ".git");
}

/** Get work tree (where files are checked out; legacy isomorphic-git repo only) */
function workTree(workspaceRoot: string, sessionId: string): string {
  return join(sessionCheckpointDir(workspaceRoot, sessionId), "workspace");
}

/** Get metadata dir */
function metadataDir(workspaceRoot: string, sessionId: string): string {
  return join(sessionCheckpointDir(workspaceRoot, sessionId), "metadata");
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
 * Persist a turn checkpoint.
 *
 * With `snapshot` (the ZCode 式 git snapshot taken before the turn's first
 * file-modifying tool): only the metadata JSON is written — file contents live
 * in the user's repository at the snapshot ref, so nothing is copied.
 *
 * Without it (non-git workspace, or the git snapshot step disabled): fall back
 * to inlining `cp.files` into the metadata JSON. legacy checkpoints (separate
 * isomorphic-git repo) are no longer written, only read.
 */
export async function persistCheckpoint(
  workspaceRoot: string,
  cp: TurnCheckpoint,
  snapshot?: GitSnapshotAnchor,
): Promise<void> {
  const startTime = Date.now();
  console.log(`[checkpoint] persistCheckpoint 开始: id=${cp.id}, files=${cp.files.length}`);

  if (!cp.sessionId) {
    throw new Error("sessionId is required for git-based checkpoints");
  }

  const t0 = Date.now();
  await fs.mkdir(metadataDir(workspaceRoot, cp.sessionId), { recursive: true });
  console.log(`[checkpoint] - 元数据目录就绪: ${Date.now() - t0}ms`);

  const metadata: CheckpointMetadata = {
    id: cp.id,
    createdAt: cp.createdAt,
    historyLen: cp.historyLen,
    history: cp.history,
    sessionId: cp.sessionId,
    touched: [...new Set(cp.touched)],
  };
  if (snapshot) {
    metadata.ref = snapshot.ref;
    metadata.commit = snapshot.commit;
  } else {
    // 非 git 快照路径：内容内联，load 时按原样回放。
    metadata.files = cp.files;
  }

  const t3 = Date.now();
  const metaFile = join(metadataDir(workspaceRoot, cp.sessionId), `${cp.id}.json`);
  await fs.writeFile(metaFile, JSON.stringify(metadata), "utf8");
  console.log(`[checkpoint] - 元数据保存完成: ${Date.now() - t3}ms`);

  const t4 = Date.now();
  await pruneCheckpoints(workspaceRoot, cp.sessionId);
  console.log(`[checkpoint] - 旧检查点清理完成: ${Date.now() - t4}ms`);

  console.log(`[checkpoint] - persistCheckpoint 总耗时: ${Date.now() - startTime}ms`);
}

/**
 * Collect every snapshot ref that a live checkpoint metadata points at.
 * Refs in this set must never be pruned by the snapshot-level cleaner —
 * they anchor turn checkpoints whose metadata still exists.
 */
async function refsInUse(workspaceRoot: string): Promise<Set<string>> {
  const root = resolve(workspaceRoot, CHECKPOINTS_DIR);
  const refs = new Set<string>();
  let sessions: string[];
  try {
    sessions = await fs.readdir(root);
  } catch {
    return refs;
  }
  for (const sid of sessions) {
    let entries: string[];
    try {
      entries = await fs.readdir(join(root, sid, "metadata"));
    } catch {
      continue;
    }
    for (const name of entries.filter((n) => n.endsWith(".json"))) {
      try {
        const meta = JSON.parse(await fs.readFile(join(root, sid, "metadata", name), "utf8"));
        if (typeof meta.ref === "string") refs.add(meta.ref);
      } catch {
        // Corrupted metadata — ignore.
      }
    }
  }
  return refs;
}

/** Drop a snapshot ref once nothing anchors it, letting git gc reclaim it. */
async function deleteRefIfUnused(workspaceRoot: string, ref: string | undefined): Promise<void> {
  if (!ref) return;
  const inUse = await refsInUse(workspaceRoot);
  if (inUse.has(ref)) return;
  await runGit(workspaceRoot, ["update-ref", "-d", ref]);
}

/**
 * Keep the newest MAX_KEEP checkpoints per session.
 * Pruned checkpoints also lose their snapshot ref (unless another live
 * checkpoint still references it), so git gc can reclaim the objects.
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
    const file = join(metaDir, name);
    let ref: string | undefined;
    try {
      const meta = JSON.parse(await fs.readFile(file, "utf8"));
      ref = typeof meta.ref === "string" ? meta.ref : undefined;
    } catch {
      // Corrupted metadata — still drop the file.
    }
    await fs.unlink(file).catch(() => undefined);
    await deleteRefIfUnused(workspaceRoot, ref);
  }
}

/**
 * Delete a single checkpoint: remove its metadata JSON and, if no other
 * checkpoint references it, the snapshot ref (so git gc reclaims the commit).
 */
export async function deleteCheckpoint(
  workspaceRoot: string,
  sessionId: string,
  checkpointId: string,
): Promise<void> {
  const file = join(metadataDir(workspaceRoot, sessionId), `${checkpointId}.json`);
  let ref: string | undefined;
  try {
    const meta = JSON.parse(await fs.readFile(file, "utf8"));
    ref = typeof meta.ref === "string" ? meta.ref : undefined;
  } catch {
    // Missing or corrupted metadata — nothing else to clean.
  }
  await fs.unlink(file).catch(() => undefined);
  await deleteRefIfUnused(workspaceRoot, ref);
}

/**
 * Delete every checkpoint owned by a session: the whole
 * `.owncoder/checkpoints/<sid>/` directory plus the session's snapshot refs.
 * Called on session deletion so checkpoints don't outlive their session.
 */
export async function deleteSessionCheckpoints(workspaceRoot: string, sessionId: string): Promise<void> {
  const dir = sessionCheckpointDir(workspaceRoot, sessionId);
  let entries: string[];
  try {
    entries = await fs.readdir(join(dir, "metadata"));
  } catch {
    // No checkpoints for this session — nothing to do.
    return;
  }
  const refs: string[] = [];
  for (const name of entries.filter((n) => n.endsWith(".json"))) {
    try {
      const meta = JSON.parse(await fs.readFile(join(dir, "metadata", name), "utf8"));
      if (typeof meta.ref === "string") refs.push(meta.ref);
    } catch {
      // Corrupted metadata — the directory removal below still handles it.
    }
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  // Metadata for this session is gone, so its refs cannot be in use elsewhere
  // (each snapshot belongs to exactly one turn of one session).
  for (const ref of refs) {
    await runGit(workspaceRoot, ["update-ref", "-d", ref]).catch(() => undefined);
  }
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
        touched: meta.touched ?? [],
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

      // Found it, now load the file state
      console.log(`[checkpoint] - 元数据查找: ${Date.now() - t1}ms`);
      console.log(`[checkpoint] - 找到元数据，开始加载: session=${sessionId}`);
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
  // ZCode 式：内容在用户仓库的 hidden ref 上
  if (typeof meta.ref === "string" && meta.ref) {
    const verify = await runGit(workspaceRoot, ["rev-parse", "--verify", `${meta.ref}^{commit}`]);
    if (verify.code !== 0) {
      // ref 已被删除（会话删除/prune/手动操作）→ 检查点过期，交给上层报 expired
      throw new Error(`checkpoint ref missing: ${meta.ref}`);
    }
    const touched = meta.touched ?? [];
    const files: FileSnapshot[] = [];
    for (const path of touched) {
      const show = await runGit(workspaceRoot, ["show", `${meta.ref}:${path}`]);
      if (show.code !== 0) {
        files.push({ path, existed: false });
      } else {
        files.push({ path, existed: true, content: show.out });
      }
    }
    return {
      id: meta.id,
      createdAt: meta.createdAt,
      historyLen: meta.historyLen,
      history: meta.history,
      files,
      touched,
      sessionId: meta.sessionId,
      ref: meta.ref,
    };
  }

  // 非 git 退化路径：内容内联在元数据里
  if (Array.isArray(meta.files)) {
    return {
      id: meta.id,
      createdAt: meta.createdAt,
      historyLen: meta.historyLen,
      history: meta.history,
      files: meta.files,
      touched: meta.touched ?? [],
      sessionId: meta.sessionId,
    };
  }

  // legacy：内容在 session 私有的 isomorphic-git 仓库里（仅读取兼容）
  const wt = workTree(workspaceRoot, sessionId);
  const gd = gitDir(workspaceRoot, sessionId);

  const fileMap = new Map<string, FileSnapshot>();

  // List all files in commit recursively
  const t1 = Date.now();
  const commitObj = await git.readCommit({
    fs,
    dir: wt,
    gitdir: gd,
    oid: meta.commitHash!,
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
  console.log(`[checkpoint] - Git 树遍历与文件读取(legacy): ${Date.now() - t1}ms`);

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

/** Restore files from a snapshot ref back into the working tree (ZCode 式). */
async function restoreFromGitRef(
  workspaceRoot: string,
  ref: string,
  files: FileSnapshot[],
): Promise<string[]> {
  const restored: string[] = [];
  for (const snap of files) {
    const abs = resolve(workspaceRoot, snap.path);
    if (!snap.existed) {
      // 快照里没有此文件 → turn 中新建的 → 删除
      await fs.unlink(abs).catch(() => undefined);
      restored.push(snap.path);
      continue;
    }
    const show = await runGit(workspaceRoot, ["show", `${ref}:${snap.path}`]);
    if (show.code !== 0) {
      await fs.unlink(abs).catch(() => undefined);
      restored.push(snap.path);
      continue;
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, show.out, "utf8");
    restored.push(snap.path);
  }
  return restored;
}

/**
 * Restore files from a snapshot ref back into the working tree.
 * `files` describes the touched paths: entries absent from the snapshot tree
 * (`existed: false`) are unlinked — they were created after the snapshot.
 * Never touches the user's index (uses `git show`, not `git checkout`).
 */
export async function gitRestoreSnapshot(
  workspaceRoot: string,
  ref: string,
  files: FileSnapshot[],
): Promise<string[]> {
  return restoreFromGitRef(workspaceRoot, ref, files);
}

/** Restore files from checkpoint; returns restored relative paths */
export async function restoreCheckpointFiles(
  workspaceRoot: string,
  cp: TurnCheckpoint,
): Promise<string[]> {
  const startTime = Date.now();
  console.log(`[checkpoint] restoreCheckpointFiles 开始: id=${cp.id}, files=${cp.files.length}`);

  const restored =
    cp.ref
      ? await restoreFromGitRef(workspaceRoot, cp.ref, [...cp.files].reverse())
      : await restoreFromContents(workspaceRoot, [...cp.files].reverse());
  console.log(`[checkpoint] - restoreCheckpointFiles 总耗时: ${Date.now() - startTime}ms`);
  return restored;
}

async function restoreFromContents(
  workspaceRoot: string,
  files: FileSnapshot[],
): Promise<string[]> {
  const restored: string[] = [];
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

// ── Git Snapshot Safety Net ────────────────────────

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
 * Outcome of a snapshot attempt. "not-a-repo" is a normal no-op;
 * "failed" means the safety net the caller is relying on does NOT exist and the
 * user needs to hear about it.
 */
export type GitSnapshotResult =
  | { ok: true; snapshot: GitSnapshot }
  | { ok: false; reason: "not-a-repo" | "failed"; error?: string };

/**
 * Snapshot the working tree into a hidden ref of the user's own repository
 * (ZCode 式：零拷贝复用 git 对象存储)。
 *
 * NON-DESTRUCTIVE BY CONSTRUCTION: the working tree and the real index are
 * never touched. We build the snapshot in a throwaway index file
 * (`GIT_INDEX_FILE`), write a tree from it, and record that tree as a commit
 * under `refs/owncoder-checkpoint/<id>`.
 *
 * 预热策略（对齐 ZCode）：优先复制用户真实 index（stat cache 命中时未改动
 * 文件直接跳过读取与写对象，Windows + Defender 下大仓库 add 从数秒降到亚秒），
 * 失败再回落 read-tree HEAD，最差才是空 index。
 *
 * 与旧 stash 实现的历史教训：不要回到 `git stash push`，它会把脏状态从
 * 工作区"拿走"，每次快照都静默回滚上一迭代的改动（"我的改动消失了" bug）。
 *
 * Recover with `gitRestoreSnapshot()`, or manually:
 *   git diff <ref> -- <path>
 *   git show <ref>:<path>
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

  // Get list of dirty files for tracking
  const t1 = Date.now();
  const status = await runGit(workspaceRoot, ["status", "--porcelain"]);

  if (status.code !== 0) {
    console.log(`[checkpoint] gitAutoSnapshot 失败: git status 失败`);
    return { ok: false, reason: "failed", error: status.err || "git status failed" };
  }
  const dirtyFiles = status.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line: string) => line.slice(3).trim())
    .filter(Boolean);
  console.log(`[checkpoint] - Git status 检查完成: ${Date.now() - t1}ms（${dirtyFiles.length} 个变更文件）`);

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

    // 预热临时 index：优先复制用户真实 index（复用 stat cache）
    let primed = false;
    const t4 = Date.now();
    const indexPathResult = await runGit(workspaceRoot, ["rev-parse", "--git-path", "index"]);
    if (indexPathResult.code === 0) {
      const indexRelPath = indexPathResult.out.trim();
      if (indexRelPath.length > 0) {
        const userIndexPath = resolve(workspaceRoot, indexRelPath);
        try {
          await fs.copyFile(userIndexPath, tmpIndex);
          primed = true;
        } catch {
          // 用户 index 不存在（刚 init 的空仓）或无权限，降级处理。
        }
      }
    }
    console.log(`[checkpoint] - index 预热(copy ${primed ? "命中" : "未命中"}): ${Date.now() - t4}ms`);

    if (!primed) {
      // 没有可复制的 index 时，用 HEAD tree 填充临时 index，至少让已追踪文件
      // 走 hash-match 路径。HEAD 不存在（全新仓库）时允许回落到空 index。
      const t5 = Date.now();
      const readTree = parent
        ? await runGit(workspaceRoot, ["read-tree", parent], 15_000, env)
        : { code: 1 };
      if (readTree.code === 0) {
        primed = true;
      }
      console.log(`[checkpoint] - index 预热(read-tree 回落 ${primed ? "成功" : "跳过"}): ${Date.now() - t5}ms`);
    }

    // Stage everything (tracked edits, deletions and untracked files) into the
    // throwaway index. .gitignore is still respected, matching `stash -u`.
    const t6 = Date.now();
    const add = await runGit(workspaceRoot, ["add", "-A", "--", "."], 60_000, env);
    if (add.code !== 0) return step("add", add.err);
    console.log(`[checkpoint] - git add 完成: ${Date.now() - t6}ms`);

    const t7 = Date.now();
    const writeTree = await runGit(workspaceRoot, ["write-tree"], 30_000, env);
    if (writeTree.code !== 0 || !writeTree.out.trim()) return step("write-tree", writeTree.err);
    const tree = writeTree.out.trim();
    console.log(`[checkpoint] - write-tree 完成: ${Date.now() - t7}ms`);

    const t8 = Date.now();
    const commitArgs = ["commit-tree", tree, "-m", message];
    if (parent) commitArgs.push("-p", parent);
    const commitTree = await runGit(workspaceRoot, commitArgs, 15_000, env);
    if (commitTree.code !== 0 || !commitTree.out.trim()) return step("commit-tree", commitTree.err);
    const commit = commitTree.out.trim();
    console.log(`[checkpoint] - commit-tree 完成: ${Date.now() - t8}ms`);

    // Anchor the commit to a ref so gc/prune can never reclaim it.
    const t9 = Date.now();
    const ref = `${GIT_SNAPSHOT_REF_NS}/${id}`;
    const updateRef = await runGit(workspaceRoot, ["update-ref", ref, commit], 15_000, env);
    if (updateRef.code !== 0) return step("update-ref", updateRef.err);
    console.log(`[checkpoint] - update-ref 完成: ${Date.now() - t9}ms`);

    console.log("[checkpoint] git snapshot created:", id, dirtyFiles.length, "files ->", ref);

    // Prune old snapshots
    const t10 = Date.now();
    await pruneGitSnapshots(workspaceRoot);
    console.log(`[checkpoint] - 旧快照清理完成: ${Date.now() - t10}ms`);

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
 * Prune old auto-snapshots so the ref namespace doesn't grow without bound.
 * Refs still anchored by a live checkpoint metadata are never pruned — those
 * are owned by `pruneCheckpoints` / `deleteCheckpoint`.
 */
async function pruneGitSnapshots(workspaceRoot: string): Promise<void> {
  const [snapshots, inUse] = await Promise.all([
    listGitSnapshots(workspaceRoot),
    refsInUse(workspaceRoot),
  ]);
  const stale = snapshots.filter((s) => !inUse.has(s.ref)).slice(MAX_GIT_SNAPSHOTS);
  for (const snap of stale) {
    await runGit(workspaceRoot, ["update-ref", "-d", snap.ref]);
  }
  if (stale.length > 0) {
    console.log("[checkpoint] pruned", stale.length, "old git snapshots");
  }
}
