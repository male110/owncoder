/**
 * 受管 worktree 的线程归属记录。
 *
 * 移植自 codex-rs/worktree/src/metadata.rs。每个 worktree 的 Git 元数据目录里
 * 存一个版本化 JSON 记录，把 checkout 绑定到拥有它的线程：
 * - 绑定是原子发布，不覆盖已有 owner（用 fs.link 的 EEXIST 语义实现
 *   Rust tempfile 的 persist_noclobber）
 * - 同一线程重复绑定是无操作
 * - 其他线程已经占有时拒绝绑定
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { gitPath } from "./git-runner.ts";
import { joinGitPath } from "./paths.ts";

const OWNER_FILENAME = "owncoder-thread.json";
const OWNER_VERSION = 1;

interface OwnerRecord {
  version: number;
  ownerThreadId: string;
}

interface ParsedOwner {
  record: OwnerRecord;
  /** 记录文件路径（checkout 相对或绝对，由 git rev-parse 输出决定）。 */
  path: string;
}

/** 读取并校验归属记录；不存在返回 null。 */
async function readOwnerRecord(checkout: string): Promise<ParsedOwner | null> {
  const path = await resolveOwnerPath(checkout);
  const contents = await fs.readFile(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw new Error(`cannot read worktree owner at ${path}: ${err.message}`);
  });
  if (contents === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new Error(`invalid worktree owner at ${path}`);
  }
  const record = parsed as Partial<OwnerRecord> | null;
  if (
    !record ||
    typeof record !== "object" ||
    record.version !== OWNER_VERSION ||
    typeof record.ownerThreadId !== "string" ||
    record.ownerThreadId.length === 0
  ) {
    throw new Error(`invalid worktree owner at ${path}`);
  }
  return { record: { version: OWNER_VERSION, ownerThreadId: record.ownerThreadId }, path };
}

/** 归属记录的绝对路径（rev-parse 返回相对路径时按 checkout 解析）。 */
async function resolveOwnerPath(checkout: string): Promise<string> {
  const path = await gitPath(checkout, ["rev-parse", "--git-path", OWNER_FILENAME]);
  return joinGitPath(checkout, path);
}

/** 返回 checkout 绑定的线程 id；未绑定返回 null。 */
export async function owner(checkout: string): Promise<string | null> {
  const parsed = await readOwnerRecord(checkout);
  return parsed?.record.ownerThreadId ?? null;
}

/** 把 checkout 绑定到 thread_id；已有相同绑定时幂等，其他 owner 时拒绝。 */
export async function bindThread(checkout: string, threadId: string): Promise<void> {
  if (threadId.length === 0) {
    throw new Error("worktree owner thread ID cannot be empty");
  }
  const existing = await readOwnerRecord(checkout);
  if (existing !== null) {
    if (existing.record.ownerThreadId === threadId) return;
    throw new Error(`worktree already belongs to thread ${existing.record.ownerThreadId}`);
  }

  const path = await resolveOwnerPath(checkout);
  const directory = dirname(path);
  await fs.mkdir(directory, { recursive: true }).catch(() => {
    // 目录通常是 worktree 的 git dir，已存在；创建失败时让下面的写入报错。
  });
  const temporary = join(directory, `${OWNER_FILENAME}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify({ version: OWNER_VERSION, ownerThreadId: threadId } as OwnerRecord)}\n`, "utf8");

  // link 在目标已存在时失败（EEXIST），等价于 persist_noclobber。
  try {
    await fs.link(temporary, path);
    await fs.unlink(temporary).catch(() => {
      // 临时文件残留不影响正确性。
    });
    return;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EEXIST") {
      await fs.unlink(temporary).catch(() => {
        // 清理临时文件。
      });
      const current = await readOwnerRecord(checkout);
      if (current?.record.ownerThreadId === threadId) return;
      throw new Error("worktree was concurrently assigned to another thread");
    }
    // 不支持硬链接的文件系统退化为检查后改名（非原子）。
    let occupied = false;
    try {
      await fs.stat(path);
      occupied = true;
    } catch (statErr) {
      const statE = statErr as NodeJS.ErrnoException;
      if (statE.code !== "ENOENT") {
        await fs.unlink(temporary).catch(() => {});
        throw statE;
      }
    }
    if (occupied) {
      await fs.unlink(temporary).catch(() => {});
      const current = await readOwnerRecord(checkout);
      if (current?.record.ownerThreadId === threadId) return;
      throw new Error("worktree was concurrently assigned to another thread");
    }
    await fs.rename(temporary, path);
  }
}
