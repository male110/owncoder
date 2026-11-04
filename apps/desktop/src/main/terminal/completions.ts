import { execFile } from "node:child_process";
import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { TerminalCompletionItem, TerminalCompletionResult, TerminalShellContext } from "../../shared/terminal-completion";

// PowerShell treats typographic quotes as syntax, including inside ASCII-quoted
// strings. Do not offer names containing them; ASCII apostrophe doubling alone
// is NOT a safe PowerShell encoder for these characters.
export const UNSAFE_SHELL_QUOTES = /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f]/;

interface Word { text: string; from: number; to: number }
export interface CompletionTarget {
  from: number;
  to: number;
  prefix: string;
  provider: "branch" | "path" | "command";
  directoriesOnly?: boolean;
  branches?: "local" | "remote" | "all";
}

/** Intentionally a small literal-only PowerShell grammar, NOT a shell parser/evaluator. */
export function completionTarget(line: string, cursor: number): CompletionTarget | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > line.length || line.length > 32768 ||
      /[\x00-\x1f\x7f`$;|&<>(){}@]/.test(line) || UNSAFE_SHELL_QUOTES.test(line)) return null;
  const words: Word[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue; }
    const from = i;
    let text = "";
    let quote = "";
    while (i < line.length) {
      const c = line[i];
      if (quote) {
        if (c === quote) {
          if (quote === "'" && line[i + 1] === "'") { text += "'"; i += 2; continue; }
          quote = ""; i++; continue;
        }
        text += c; i++; continue;
      }
      if (/\s/.test(c)) break;
      if (c === "'" || c === '"') { quote = c; i++; continue; }
      text += c; i++;
    }
    words.push({ text, from, to: i });
  }
  const index = words.findIndex(w => cursor >= w.from && cursor <= w.to);
  const position = index < 0 ? words.filter(w => w.to < cursor).length : index;
  const word = index < 0 ? { text: "", from: cursor, to: cursor } : words[index];
  // Mid-token completion replaces the whole token. Do not decode a partially quoted prefix.
  if (index >= 0 && cursor !== word.to) return null;
  const base = { from: word.from, to: word.to, prefix: word.text };
  if (position === 0) return { ...base, provider: "command" };
  const command = words[0]?.text.toLowerCase();
  if (["cd", "chdir", "sl", "set-location"].includes(command)) {
    if (position !== 1 || word.text.startsWith("-")) return null;
    return { ...base, provider: "path", directoriesOnly: true };
  }
  if (command === "git") {
    const subcommand = words[1]?.text.toLowerCase();
    if (["checkout", "switch"].includes(subcommand)) {
      const preceding = words.slice(2, position).map(w => w.text);
      if (subcommand === "checkout" && preceding.includes("--")) return { ...base, provider: "path" };
      if (preceding.every(w => ["--track", "-t", "--detach", "-d", "--guess", "--no-guess"].includes(w)) &&
          !word.text.startsWith("-")) {
        const track = preceding.some(w => w === "--track" || w === "-t");
        const detach = preceding.some(w => w === "--detach" || w === "-d");
        if (track && detach) return null;
        return { ...base, provider: "branch", branches: track ? "remote" : subcommand === "switch" && !detach ? "local" : "all" };
      }
      return null;
    }
    return null;
  }
  if (word.text.startsWith("-")) return null;
  return { ...base, provider: "path" };
}

export function shellLiteral(text: string): string {
  if (UNSAFE_SHELL_QUOTES.test(text) || /[\x00-\x1f\x7f]/.test(text)) throw new Error("Unsupported PowerShell literal");
  return /^[a-zA-Z0-9_./\\:~+-]+$/.test(text) ? text : `'${text.replace(/'/g, "''")}'`;
}

const commands = ["git", "cd", "Set-Location", "Get-ChildItem", "Get-Content", "Get-Item", "Copy-Item", "Move-Item", "New-Item", "Remove-Item", "Select-String", "Write-Output", "Clear-Host"];

interface GitBranch extends TerminalCompletionItem { remote: boolean }
interface GitCacheEntry { expires: number; value: Promise<GitBranch[]> }
export class CompletionProviders {
  private readonly gitCache = new Map<string, GitCacheEntry>();

  constructor(private readonly gitTimeout = 750, private readonly cacheMs = 1500) {}

  async complete(context: TerminalShellContext): Promise<TerminalCompletionResult | null> {
    const target = completionTarget(context.line, context.cursor);
    if (!target || !path.isAbsolute(context.cwd) || /^[\\/]{2}/.test(context.cwd) || /[\x00-\x1f\x7f]/.test(context.cwd)) return null;
    let items: TerminalCompletionItem[];
    if (target.provider === "branch") {
      items = (await this.branches(context.cwd)).filter(item => target.branches === "remote" ? item.remote : target.branches === "local" ? !item.remote : true)
        .map(({ remote: _remote, ...item }) => item);
    }
    else if (target.provider === "path") items = await this.paths(context.cwd, target.prefix, !!target.directoriesOnly);
    else items = commands.map(label => ({ label, insertText: label, kind: "command" as const }));
    if (target.provider !== "path") {
      items = items.filter(item => item.label.toLowerCase().startsWith(target.prefix.toLowerCase()));
    }
    items = items.filter(item => item.insertText !== context.line.slice(target.from, target.to));
    return { revision: context.revision, from: target.from, to: target.to, items: items.slice(0, 100) };
  }

  async branches(cwd: string): Promise<GitBranch[]> {
    const cached = this.gitCache.get(cwd);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = new Promise<GitBranch[]>(resolve => {
      // No shell, user expression, network, pager, hooks or credential prompts.
      execFile("git", ["--no-optional-locks", "-C", cwd, "for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"], {
        timeout: this.gitTimeout, maxBuffer: 256 * 1024, windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" },
      }, (error, stdout) => {
        if (error) { resolve([]); return; }
        const branches: GitBranch[] = [];
        for (const entry of stdout.split(/\r?\n/)) {
          const [ref, symref] = entry.split("\0");
          const remote = ref?.startsWith("refs/remotes/");
          const name = ref?.startsWith("refs/heads/") ? ref.slice(11) : remote ? ref.slice(13) : "";
          if (!name || name.startsWith("-") || symref || /(^|\/)HEAD$/.test(name) || /[\x00-\x20\x7f]/.test(name) || UNSAFE_SHELL_QUOTES.test(name)) continue;
          branches.push({ label: name, insertText: shellLiteral(name), kind: "branch", remote, detail: remote ? "Remote Git branch" : "Local Git branch" });
        }
        resolve(branches.sort((a, b) => a.label.localeCompare(b.label)).slice(0, 2000));
      });
    });
    if (this.gitCache.size >= 64) this.gitCache.delete(this.gitCache.keys().next().value!);
    this.gitCache.set(cwd, { expires: Date.now() + this.cacheMs, value });
    return value;
  }

  async paths(cwd: string, prefix: string, directoriesOnly: boolean): Promise<TerminalCompletionItem[]> {
    // Never traverse UNC/network paths, devices, wildcard expansion or provider paths.
    if (/^[\\/]{2}/.test(prefix) || /[\x00-\x1f\x7f*?\[\]]/.test(prefix) || UNSAFE_SHELL_QUOTES.test(prefix) ||
        /^[^\\/]*:/.test(prefix.replace(/^[a-zA-Z]:[\\/]/, "")) ||
        (/^[a-zA-Z]:/.test(prefix) && !/^[a-zA-Z]:[\\/]/.test(prefix)) || /^[\\/]{2}/.test(cwd)) return [];
    const lastSlash = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const parentText = lastSlash < 0 ? "" : prefix.slice(0, lastSlash + 1);
    const fragment = prefix.slice(lastSlash + 1).toLowerCase();
    const expanded = parentText.replace(/^~([\\/]|$)/, `${homedir()}$1`);
    const parent = path.resolve(cwd, expanded || ".");
    let directory;
    const items: TerminalCompletionItem[] = [];
    try {
      // Refuse symlink/junction traversal to a remote target where detectable by realpath.
      const { realpath } = await import("node:fs/promises");
      const real = await realpath(parent);
      if (/^[\\/]{2}/.test(real)) return [];
      directory = await opendir(parent);
      const deadline = Date.now() + 250;
      let scanned = 0;
      for await (const entry of directory) {
        if (++scanned > 2048 || items.length >= 100 || Date.now() > deadline) break;
        if (!entry.name.toLowerCase().startsWith(fragment) || /[\x00-\x1f\x7f*?\[\]]/.test(entry.name) || UNSAFE_SHELL_QUOTES.test(entry.name)) continue;
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          const target = await realpath(path.join(parent, entry.name));
          if (/^[\\/]{2}/.test(target)) continue;
          isDirectory = (await stat(target)).isDirectory();
        }
        if (directoriesOnly && !isDirectory) continue;
        // A literal filename starting '-' is still parsed as a parameter by
        // PowerShell; qualify it as a path even when no parent was typed.
        const safeParent = !parentText && entry.name.startsWith("-") ? "./" : parentText;
        const text = safeParent + entry.name + (isDirectory ? (prefix.includes("\\") ? "\\" : "/") : "");
        items.push({ label: text, insertText: shellLiteral(text), kind: isDirectory ? "directory" : "file" });
      }
    } catch { /* Missing/inaccessible paths simply have no completions. */ }
    return items.sort((a, b) => a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "directory" ? -1 : 1);
  }
}
