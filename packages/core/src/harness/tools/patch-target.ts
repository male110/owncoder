/** 目标路径只能来自 apply_patch 工具参数中的显式 file_path。 */
export function resolvePatchTarget(
  path: string,
  patch: string,
  oldString = "",
): { path: string } | { error: string } {
  if (!path.trim()) return { error: 'apply_patch requires a non-empty "file_path" parameter.' };
  // old_string 路径不需要 patch 正文；只有旧的 SEARCH/REPLACE / diff 路径才需要。
  if (!oldString.trim() && !patch.trim()) {
    return {
      error:
        'apply_patch requires "old_string" and "new_string" (the exact text to replace and its ' +
        "replacement), or a legacy patch body. Neither was provided.",
    };
  }
  return { path };
}
