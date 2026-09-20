import { promises as fs } from "node:fs";
import upath from "upath";
import { relative, resolve } from "node:path";

const MENTION_RE = /(?:^|[\s([{])@([^\s@]+)/g;
const MAX_FILES = 8;
const MAX_CHARS_PER_FILE = 4000;
const MAX_TOTAL_CHARS = 12_000;

export function extractMentionPaths(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    let p = upath.normalize(m[1]!.replace(/[.,;:!?)]+$/, ""));
    if (!p || p.startsWith("http")) continue;
    if (p.startsWith("./")) p = p.slice(2);
    if (seen.has(p)) continue;
    seen.add(p);
    found.push(p);
  }
  return found;
}

export interface MentionFile {
  path: string;
  content: string;
  truncated: boolean;
}

/** Load mentioned files for context injection. */
export async function loadMentionedFiles(
  workspaceRoot: string,
  paths: string[],
): Promise<MentionFile[]> {
  const out: MentionFile[] = [];
  let total = 0;
  for (const p of paths.slice(0, MAX_FILES)) {
    if (total >= MAX_TOTAL_CHARS) break;
    const abs = resolve(workspaceRoot, p);
    const rel = relative(workspaceRoot, abs).split(/[/\\]/).join("/");
    if (rel.startsWith("..")) continue;
    try {
      const raw = await fs.readFile(abs, "utf8");
      const budget = Math.min(MAX_CHARS_PER_FILE, MAX_TOTAL_CHARS - total);
      const truncated = raw.length > budget;
      const content = truncated ? `${raw.slice(0, budget)}\n…(截断)` : raw;
      total += content.length;
      out.push({ path: rel, content, truncated });
    } catch {
      /* missing path — skip */
    }
  }
  return out;
}

export function formatMentionsBlock(files: MentionFile[]): string {
  if (!files.length) return "";
  const parts = files.map(
    (f) => `### @${f.path}${f.truncated ? " (truncated)" : ""}\n\`\`\`\n${f.content}\n\`\`\``,
  );
  return `## User @ mentions (injected)\nThe user referenced these files. Prefer them when answering.\n\n${parts.join("\n\n")}`;
}
