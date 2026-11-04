import type { ToolContext, ToolResult } from "./types.ts";
import { cap, fail, ok, runCommand, toAbs } from "./shared.ts";
import { detectProjectTypeForLsp } from "./verify.ts";
import { LspClientManager, createDefaultLspManager } from "../lsp-client.ts";

// ── LSP Client Singleton ─────────────────────────────────────

const lspManagers = new Map<string, LspClientManager>();
const lspManagerInitPromises = new Map<string, Promise<LspClientManager>>();

/** Shared LSP manager for tools and automatic verification. */
export async function getLspManager(workspaceRoot: string): Promise<LspClientManager> {
  const root = toAbs(workspaceRoot, ".");
  const existing = lspManagers.get(root);
  if (existing) return existing;
  const pending = lspManagerInitPromises.get(root);
  if (pending) return pending;

  const initPromise = (async () => {
    // Discover the project's languages, then install missing servers on demand.
    const manager = await createDefaultLspManager(workspaceRoot);
    await manager.startAll();
    lspManagers.set(root, manager);
    return manager;
  })().finally(() => {
    lspManagerInitPromises.delete(root);
  });

  lspManagerInitPromises.set(root, initPromise);
  return initPromise;
}

export async function toolLspDiagnostics(ctx: ToolContext, filePath: string): Promise<ToolResult> {
  try {
    let files: string[];
    if (filePath) {
      files = [filePath];
    } else {
      files = ctx.touchedPaths ?? [];
    }

    if (!files.length) {
      return ok("No files specified. Run type_check to check all files.");
    }

    // Quick type check
    // bash 下双引号内反斜杠会被吞：文件路径统一正斜杠（防御：模型可能传
    // Windows 绝对路径；相对路径不受影响）。
    const posixFiles = files.map((f) => f.split("\\").join("/"));
    const pt = await detectProjectTypeForLsp(ctx);
    if (pt.typeChecker === "tsc") {
      try {
        const result = await runCommand(`npx tsc --noEmit ${posixFiles.join(" ")} 2>&1`, ctx.workspaceRoot, 30_000, ctx.signal);
        if (result.code === 0 && !result.stdout.trim() && !result.stderr.trim()) {
          return ok("No diagnostics found — all clear!");
        }
        const output = (result.stdout + "\n" + result.stderr).trim();
        return ok(cap(output || "No diagnostics", ctx.bashMaxChars));
      } catch {
        return fail("TypeScript compiler not available");
      }
    }

    // Generic: try running the project's linter
    const pt2 = await detectProjectTypeForLsp(ctx);
    if (pt2.linter === "eslint") {
      try {
        const result = await runCommand(`npx eslint ${posixFiles.join(" ")} --format compact 2>&1`, ctx.workspaceRoot, 30_000, ctx.signal);
        return ok(cap(result.stdout.trim() || result.stderr.trim() || "No issues", ctx.bashMaxChars));
      } catch {
        return fail("ESLint not available");
      }
    }

    return ok("No LSP diagnostics available for this project type. Try type_check instead.");
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

// ── Symbol outline helper (used by read-file outline output) ─

export function extractDocumentSymbols(text: string): Array<{
  name: string;
  kind: string;
  line: number;
  parent?: string;
}> {
  const symbols: Array<{ name: string; kind: string; line: number; parent?: string }> = [];
  const lines = text.split(/\r?\n/);

  let currentClass = "";
  const defPatterns: Array<{ pattern: RegExp; kind: string }> = [
    { pattern: /^(export\s+)?class\s+(\w+)/, kind: "class" },
    { pattern: /^(export\s+)?interface\s+(\w+)/, kind: "interface" },
    { pattern: /^(export\s+)?type\s+(\w+)/, kind: "type" },
    { pattern: /^(export\s+)?enum\s+(\w+)/, kind: "enum" },
    { pattern: /^(export\s+)?(async\s+)?function\s+(\w+)/, kind: "function" },
    { pattern: /^(export\s+)?const\s+(\w+)\s*[:=]/, kind: "const" },
    { pattern: /^\s*(public\s+|private\s+|protected\s+)?(async\s+)?(\w+)\s*\(/, kind: "method" },
  ];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    for (const dp of defPatterns) {
      const m = l.match(dp.pattern);
      if (m) {
        const name = m[2] || m[3] || "";
        if (!name || ["if", "for", "while", "switch", "return", "new"].includes(name)) continue;
        if (dp.kind === "class") currentClass = name;
        symbols.push({
          name,
          kind: dp.kind,
          line: i + 1,
          parent: dp.kind === "method" ? currentClass || undefined : undefined,
        });
        break;
      }
    }
  }

  return symbols;
}
