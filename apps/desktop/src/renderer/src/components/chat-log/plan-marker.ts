/** plan_saved 标记：assistant 文本末尾附带计划文件路径，渲染前剥离并单独展示。 */

const PLAN_MARKER = "\n\n<!--plan_saved:";

export function extractPlanPath(content: string): string | null {
  const idx = content.lastIndexOf(PLAN_MARKER);
  if (idx < 0) return null;
  const rest = content.slice(idx + PLAN_MARKER.length);
  const endIdx = rest.indexOf("-->");
  if (endIdx < 0) return null;
  return rest.slice(0, endIdx).trim();
}

export function stripPlanMarker(content: string): string {
  const idx = content.lastIndexOf(PLAN_MARKER);
  if (idx < 0) return content;
  return content.slice(0, idx).trimEnd();
}
