/**
 * Unified-diff 启发式：识别真正被删/增的导出，避免把同名导出的内容修改误报成增删。
 */

const EXPORT_DECL_RE =
  /^export\s+(default\s+)?(interface|type|class|function|const)\s+(\w+)/;

export function extractExportDecl(code: string): { name: string; code: string } | null {
  const trimmed = code.trim();
  const match = trimmed.match(EXPORT_DECL_RE);
  const name = match?.[3];
  if (!name) return null;
  return { name, code: trimmed };
}

function pushNamed(map: Map<string, string[]>, name: string, code: string): void {
  const list = map.get(name);
  if (list) list.push(code);
  else map.set(name, [code]);
}

/**
 * 扫描 unified diff：同名导出在删除行与新增行同时出现时视为内容修改，不计入增删。
 */
export function unmatchedExportChanges(diffText: string): { removed: string[]; added: string[] } {
  const removedByName = new Map<string, string[]>();
  const addedByName = new Map<string, string[]>();

  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      const decl = extractExportDecl(line.slice(1));
      if (decl) pushNamed(addedByName, decl.name, decl.code);
    } else if (line.startsWith("-")) {
      const decl = extractExportDecl(line.slice(1));
      if (decl) pushNamed(removedByName, decl.name, decl.code);
    }
  }

  const removed: string[] = [];
  const added: string[] = [];

  for (const [name, codes] of removedByName) {
    const paired = addedByName.get(name)?.length ?? 0;
    if (codes.length > paired) removed.push(...codes.slice(paired));
  }
  for (const [name, codes] of addedByName) {
    const paired = removedByName.get(name)?.length ?? 0;
    if (codes.length > paired) added.push(...codes.slice(paired));
  }

  return { removed, added };
}
