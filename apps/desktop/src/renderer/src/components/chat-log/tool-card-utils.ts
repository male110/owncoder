// ── 工具卡片参数/结果格式化辅助 ─────────────────────────────────────────────

export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const pick = (k: string) => (typeof args[k] === "string" ? String(args[k]) : undefined);
  if (name === "read_file" || name === "write_file" || name === "apply_patch" || name === "read_outline" || name === "read_symbol") {
    const p = pick("path") ?? pick("filePath") ?? pick("file_path") ?? "";
    // Show only the last 2 path segments to keep it compact
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  }
  if (name === "bash") return (pick("command") ?? pick("cmd") ?? "").slice(0, 80);
  if (name === "run_script") {
    // 脚本可能几十行，卡片摘要只显示一行：首行内容 + 总行数提示。
    // 首行通常是注释（说明意图），去掉 // 后就是一句话意图；否则是第一条语句。
    const code = pick("code") ?? "";
    const lines = code.split("\n").filter((l) => l.trim().length > 0);
    if (!lines.length) return "";
    const first = lines[0]!.trim().replace(/^\/\/\s*/, "").replace(/\s+/g, " ");
    const preview = first.length > 70 ? first.slice(0, 70) + "…" : first;
    return lines.length > 1 ? `${preview} (+${lines.length - 1} 行)` : preview;
  }
  if (name === "grep") {
    const pattern = pick("pattern") ?? "";
    const path = pick("file_path")?.trim() || ".";
    const fields = [`${pattern} in ${path}`];
    const optionKeys = [
      "glob",
      "type",
      "output_mode",
      "max_results",
      "head_limit",
      "offset",
      "ignore_case",
      "multiline",
      "before_context",
      "after_context",
      "context",
      "show_line_numbers",
      "only_matching",
    ];
    for (const key of optionKeys) {
      const value = args[key];
      if (value !== undefined && value !== null) fields.push(`${key}=${String(value)}`);
    }
    const summary = fields.join(" · ");
    return summary.length > 120 ? summary.slice(0, 119) + "…" : summary;
  }
  if (name === "search_code" || name === "search_symbols") {
    const q = pick("query") ?? pick("pattern") ?? "";
    // 搜索范围（glob 优先；path 为具体目录时才显示，避免 "in ." 这类噪音）
    let where = pick("glob") ?? "";
    if (!where) {
      const p = pick("path") ?? pick("file_path") ?? "";
      if (p && p !== "." && p !== "./") where = p;
    }
    if (where) where = where.length > 60 ? where.slice(0, 60) + "…" : where;
    return where ? `${q} in ${where}` : q;
  }
  const first = Object.values(args).find((v) => typeof v === "string");
  return first ? String(first) : "";
}

/** Read params for read_file: Limit and Offset */
export function readFileParams(args: Record<string, unknown>): string {
  const limit  = args.limit  != null ? `Limit:${args.limit}`  : null;
  const offset = args.offset != null ? `Offset:${args.offset}` : null;
  if (limit || offset) return [limit, offset].filter(Boolean).join(" | ");
  return "";
}

/** Diff stat for write/patch results. */
export function parseDiffStat(output: string): { added: number; removed: number } | null {
  // Output format from write_file / apply_patch: "Wrote path (+N -M)"
  const m = output.match(/\(\+(\d+)\s+-(\d+)\)/);
  if (m) return { added: Number(m[1]), removed: Number(m[2]) };
  // Count raw +/- lines if full diff is emitted
  let added = 0; let removed = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return added + removed > 0 ? { added, removed } : null;
}

// ── 工具参数格式化：处理 omitted 标记 ────────────────────────────────────────

export function formatToolArgs(args: Record<string, unknown>): string {
  // 递归处理参数，将 omitted 标记替换为友好提示
  function processValue(value: unknown): unknown {
    if (value == null) return value;
    if (typeof value !== "object") return value;

    // 检查是否是 omitted 标记
    if (
      typeof (value as { omitted?: unknown }).omitted === "boolean" &&
      (value as { omitted: boolean }).omitted === true
    ) {
      const reason = (value as { reason?: string }).reason;
      if (reason === "nested_arg_omitted") return "<嵌套对象已省略>";
      if (reason === "deeply_nested") return "<深层嵌套已省略>";
      return "<内容已省略>";
    }

    // 处理数组
    if (Array.isArray(value)) {
      return value.map(processValue);
    }

    // 处理对象
    const processed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      processed[key] = processValue(val);
    }
    return processed;
  }

  const processed = processValue(args);
  return JSON.stringify(processed, null, 2);
}
