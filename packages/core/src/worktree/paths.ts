/**
 * 受管 worktree 的桶分配与空桶清理。
 *
 * 移植自 codex-rs/worktree/src/paths.rs。布局为 <root>/<4位hex>/<仓库名>：
 * 4 位 hex 桶让单个根目录下可以放大量不同仓库的 worktree，同仓库的多个
 * worktree 靠 UUID 桶区分。
 *
 * 附带一个 Windows 路径简化工具，对应 Rust 的 dunce::simplified：仅当
 * \\?\ 前缀后确实是盘符路径时才剥掉前缀，否则原样保留（UNC 等路径不能剥）。
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { isAbsolute, join } from "node:path";

/** 分配次数上限，与 codex 的 u16::MAX 一致。 */
const ALLOCATION_ATTEMPTS = 65_536;

/**
 * 在 root 下分配一个新的 worktree 目录：<root>/<4位hex>/<仓库名>。
 * 桶 create_dir 冲突（已存在）时重试，耗尽时抛错。
 */
export async function allocateWorktreeRoot(root: string, repositoryName: string): Promise<string> {
  await fs.mkdir(root, { recursive: true }).catch((err: NodeJS.ErrnoException) => {
    throw new Error(`cannot create worktree root ${root}: ${err.message}`);
  });

  if (process.platform === "darwin") {
    // 与 codex 一致：禁止 Spotlight 索引 worktree 根目录。
    const marker = join(root, ".metadata_never_index");
    await fs.writeFile(marker, "").catch((err: NodeJS.ErrnoException) => {
      throw new Error(`cannot disable Spotlight indexing at ${marker}: ${err.message}`);
    });
  }

  for (let attempt = 0; attempt <= ALLOCATION_ATTEMPTS; attempt++) {
    const identifier = randomUUID().replace(/-/g, "");
    const bucket = join(root, identifier.slice(0, 4));
    try {
      await fs.mkdir(bucket);
      return join(bucket, repositoryName);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") continue;
      throw new Error(`cannot create worktree bucket ${bucket}: ${e.message}`);
    }
  }
  throw new Error("all managed worktree identifiers are in use");
}

/** 尝试删除桶目录；桶非空（还有别的 worktree）时静默失败。 */
export async function removeEmptyBucket(checkout: string): Promise<void> {
  // path.posix.dirname 不可靠，用自实现的 parent：取到最后一个分隔符之前。
  const parent = parentDir(checkout);
  if (parent !== undefined) {
    await fs.rmdir(parent).catch(() => {
      // 桶非空或已不存在：与 codex 的 let _ = fs::remove_dir 一致，忽略。
    });
  }
}

function parentDir(path: string): string | undefined {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator <= 0) return undefined;
  // Windows 盘符根（C:\）不应再上溯。
  if (separator === 2 && path[1] === ":") return undefined;
  return path.slice(0, separator);
}

/**
 * 剥掉 \\?\ 前缀（当且仅当它是 \\?\C:\ 形式时）。其他扩展长度前缀
 * （如 UNC 的 \\?\UNC\）原样保留。对应 dunce::simplified 的核心语义。
 */
export function simplifyWindowsPath(path: string): string {
  if (path.startsWith("\\\\?\\")) {
    const rest = path.slice(4);
    if (/^[A-Za-z]:[\\/]/.test(rest)) return rest;
  }
  return path;
}

/**
 * git 在 Windows 上输出正斜杠路径（worktree list --porcelain、rev-parse），
 * 转回本机分隔符以便与已注册路径做字符串比较（Rust 的 Path::eq 在 Windows 上
 * 把 / 与 \ 视作等价，字符串比较没有这个待遇）。
 */
export function toNativePath(path: string): string {
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(path)) {
    return path.replace(/\//g, "\\");
  }
  return path;
}

/**
 * 连接 base 与 git 输出的路径。Rust 的 Path::join 在 path 为绝对路径时会
 * 整体替换 base，Node 的 join 只是拼接，这里补上这个语义。
 */
export function joinGitPath(base: string, path: string): string {
  return isAbsolute(path) ? toNativePath(path) : join(base, toNativePath(path));
}
