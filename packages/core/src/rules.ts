import { promises as fs } from "node:fs";
import upath from "upath";
import { join, resolve } from "node:path";

const RULES_DIR = ".owncoder/rules";
const MAX_COMBINED_CHARS = 3500;

export interface RuleFileInfo {
  /** Filename only, e.g. `style.md` */
  name: string;
  /** Workspace-relative path */
  path: string;
  size: number;
  mtimeMs: number;
}


export function rulesDirAbs(workspaceRoot: string): string {
  return resolve(workspaceRoot, RULES_DIR);
}

export async function ensureRulesDir(workspaceRoot: string): Promise<string> {
  const dir = rulesDirAbs(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function safeRuleName(name: string): string {
  let n = upath.basename(name.trim());
  if (!n) throw new Error("empty rule name");
  if (n.startsWith(".")) throw new Error("rule name cannot start with .");
  if (!n.endsWith(".md")) n += ".md";
  if (!/^[\w.-]+\.md$/i.test(n)) {
    throw new Error("rule name may only contain letters, digits, _ - .");
  }
  return n;
}

export async function listRules(workspaceRoot: string): Promise<RuleFileInfo[]> {
  const dir = rulesDirAbs(workspaceRoot);
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RuleFileInfo[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".md") || ent.name.startsWith(".")) continue;
    const abs = join(dir, ent.name);
    const st = await fs.stat(abs);
    out.push({
      name: ent.name,
      path: `${RULES_DIR}/${ent.name}`,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readRule(workspaceRoot: string, name: string): Promise<string> {
  const safe = safeRuleName(name);
  const abs = join(rulesDirAbs(workspaceRoot), safe);
  return fs.readFile(abs, "utf8");
}

export async function writeRule(
  workspaceRoot: string,
  name: string,
  content: string,
): Promise<RuleFileInfo> {
  await ensureRulesDir(workspaceRoot);
  const safe = safeRuleName(name);
  const abs = join(rulesDirAbs(workspaceRoot), safe);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  await fs.writeFile(abs, body, "utf8");
  const st = await fs.stat(abs);
  return {
    name: safe,
    path: `${RULES_DIR}/${safe}`,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

export async function deleteRule(workspaceRoot: string, name: string): Promise<void> {
  const safe = safeRuleName(name);
  const abs = join(rulesDirAbs(workspaceRoot), safe);
  await fs.unlink(abs);
}

/** Load all rules sorted by filename into one markdown block for system injection. */
export async function loadCombinedRules(
  workspaceRoot: string,
  maxChars = MAX_COMBINED_CHARS,
): Promise<string> {
  const files = await listRules(workspaceRoot);
  if (files.length === 0) return "";

  const parts: string[] = [];
  let used = 0;
  for (const f of files) {
    let text: string;
    try {
      text = (await readRule(workspaceRoot, f.name)).trim();
    } catch {
      continue;
    }
    if (!text) continue;
    const chunk = `### ${f.name}\n${text}`;
    if (used + chunk.length + 2 > maxChars) {
      const remain = maxChars - used - 40;
      if (remain > 80) {
        parts.push(chunk.slice(0, remain) + "\n…[rules truncated]");
      } else {
        parts.push("…[additional rules omitted for context budget]");
      }
      break;
    }
    parts.push(chunk);
    used += chunk.length + 2;
  }
  return parts.join("\n\n");
}
