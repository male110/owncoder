/**
 * 受管 git worktree：移植自 codex-rs/worktree crate。
 *
 * 公开入口：WorktreeManager / ManagedWorktree / CreateWorktree /
 * WorktreeSettings / resolveWorktreeSettings / defaultWorktreeBase。
 */

export { WorktreeManager, type CreateWorktree, type ManagedWorktree } from "./manager.ts";
export { defaultWorktreeBase } from "./git-runner.ts";
export {
  DEFAULT_WORKTREE_KEEP_COUNT,
  type WorktreeSettings,
  defaultWorktreeRoot,
  resolveWorktreeSettings,
} from "./settings.ts";
