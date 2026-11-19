/**
 * 受管 worktree 设置。
 *
 * 移植自 codex-rs/worktree/src/settings.rs。去掉 Desktop 配置来源，
 * 默认根目录改为全局的 ~/.owncoder/worktrees（与 codex 的 codex_home 语义一致：
 * worktree 落在仓库之外，多个仓库共用同一个分配根）。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 旧 worktree 自动清理时默认保留的数量。 */
export const DEFAULT_WORKTREE_KEEP_COUNT = 15;

/** Effective host-local settings for managed worktrees. */
export interface WorktreeSettings {
  /** 受管 worktree 的分配根目录，必须是绝对路径。 */
  root: string;
  /** 是否自动清理多余的旧 worktree；本次移植只保留字段，清理逻辑随集成再补。 */
  autoCleanupEnabled: boolean;
  /** 自动清理时保留的 worktree 数量。 */
  keepCount: number;
}

/** 默认受管 worktree 根目录：~/.owncoder/worktrees。 */
export function defaultWorktreeRoot(): string {
  return join(homedir(), ".owncoder", "worktrees");
}

/** 以默认值构造设置。传入部分字段覆盖默认值。 */
export function resolveWorktreeSettings(
  overrides: Partial<WorktreeSettings> = {},
): WorktreeSettings {
  return {
    root: overrides.root ?? defaultWorktreeRoot(),
    autoCleanupEnabled: overrides.autoCleanupEnabled ?? true,
    keepCount: overrides.keepCount ?? DEFAULT_WORKTREE_KEEP_COUNT,
  };
}
