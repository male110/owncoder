/** 目标路径只能来自 apply_patch 工具参数中的显式 file_path。 */
export function resolvePatchTarget(path: string, patch: string): { path: string } | { error: string } {
  if (!path.trim()) return { error: 'apply_patch requires a non-empty "file_path" parameter.' };
  if (!patch.trim()) return { error: "apply_patch 的 patch 不能为空。请提交完整补丁。" };
  return { path };
}
