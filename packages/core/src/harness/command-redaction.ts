import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_SENSITIVE_FILES } from "@owncoder/settings";
import { normalizeRel } from "./tools/shared.ts";
import { isSensitiveFile, redactSecrets } from "./redact.ts";

export interface CommandRedactionOptions {
  sensitiveFiles?: readonly string[];
  patterns?: readonly string[];
}

interface StaticFileRead {
  path: string;
}

const UNSAFE_SHELL_SYNTAX = /[|&;`<>]|\$\(|\$[A-Za-z_{]|%[^%]+%|[*?\[\]]|\r|\n/;
const READ_COMMANDS = new Set([
  "cat",
  "type",
  "more",
  "head",
  "tail",
  "less",
  "bat",
  "get-content",
  "gc",
  "get-itemcontent",
  "grep",
  "rg",
  "select-string",
  "findstr",
  "cut",
  "sort",
  "uniq",
  "tr",
  "jq",
  "yq",
  "xmllint",
  "plutil",
]);
const SEARCH_COMMANDS = new Set(["grep", "rg", "select-string", "findstr"]);
const UNTRUSTED_READ_LAUNCHERS = new Set([
  "command", "env", "sudo", "nice", "nohup",
  "sh", "bash", "zsh", "fish", "python", "python3", "node", "perl", "ruby", "php", "awk",
  "powershell", "powershell.exe", "pwsh",
]);

function splitArguments(command: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) args.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (quote) return null;
  if (current) args.push(current);
  return args;
}

function isOption(token: string): boolean {
  // Unix absolute paths start with `/`; only short cmd.exe switches use it.
  return token.startsWith("-") || /^\/[A-Za-z?]$/.test(token);
}

function fileArguments(executable: string, args: readonly string[]): string[] {
  const countOptions = executable === "head" || executable === "tail"
    ? new Set(["-n", "--lines", "-c", "--bytes"])
    : executable === "get-content" || executable === "gc" || executable === "get-itemcontent"
      ? new Set(["-totalcount", "-tail", "-readcount", "-encoding"])
      : executable === "grep" || executable === "rg" || executable === "select-string"
        ? new Set(["-e", "--regexp", "-pattern"])
        : new Set<string>();
  const pathOptions = new Set(["-path", "-literalpath"]);
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const lower = arg.toLowerCase();
    if (pathOptions.has(lower)) {
      if (args[++i]) files.push(args[i]!);
    } else if (countOptions.has(lower)) {
      i++;
    } else if (!isOption(arg)) {
      files.push(arg);
    }
  }
  if (SEARCH_COMMANDS.has(executable) && files.length === 2) return [files[1]!];
  if ((executable === "jq" || executable === "yq" || executable === "plutil") && files.length >= 2) {
    return [files.at(-1)!];
  }
  return files;
}

function parseStaticFileRead(command: string, rejectUnsafe = true): StaticFileRead | "untrusted" | null {
  if (rejectUnsafe && UNSAFE_SHELL_SYNTAX.test(command)) return "untrusted";
  const args = splitArguments(command.trim());
  if (!args?.length) return null;

  const executable = args[0]?.toLowerCase();
  if (!executable) return null;
  if (UNTRUSTED_READ_LAUNCHERS.has(executable)) return "untrusted";

  if (executable === "sed") {
    const fileArgs = args.slice(1).filter((arg) => !isOption(arg) && !/^\d+(?:,\d+)?[pqd]$/i.test(arg));
    return fileArgs.length === 1 && args.slice(1).some((arg) => /^-n$|^\d+(?:,\d+)?p$/i.test(arg))
      ? { path: fileArgs[0]! }
      : fileArgs.length ? "untrusted" : null;
  }

  if (!READ_COMMANDS.has(executable)) return null;
  const fileArgs = fileArguments(executable, args.slice(1));
  if (fileArgs.length !== 1) return fileArgs.length ? "untrusted" : null;
  return { path: fileArgs[0]! };
}

function splitShellCommands(command: string): string[] {
  return command.split(/\|\||&&|[|&;`<>\r\n]/).map((part) => part.trim()).filter(Boolean);
}

function hasSensitiveReadInUnsafeCommand(
  command: string,
  options?: CommandRedactionOptions,
): boolean {
  const patterns = [...BUILTIN_SENSITIVE_FILES, ...(options?.sensitiveFiles ?? [])];
  for (const part of splitShellCommands(command)) {
    // 去掉赋值和读取表达式的外壳，保留文件路径用于敏感文件归因。
    const expression = part.replace(/^\$[A-Za-z_][\w]*\s*=\s*/, "");
    const nested = expression.match(/^\(\s*(Get-Content|gc)\s+(.+?)\)\s*(?:\.\w+\(\))?$/i);
    const candidate = nested ? `${nested[1]} ${nested[2]}` : expression;
    if (/\$[A-Za-z_]|\$\{|%[A-Za-z_][A-Za-z0-9_]*%|[*?\[\]]/.test(candidate)) continue;
    const read = parseStaticFileRead(candidate, false);
    if (read && read !== "untrusted" && isSensitiveFile(read.path, patterns)) return true;
    if (read === "untrusted") {
      const args = splitArguments(candidate);
      const executable = args?.[0]?.toLowerCase();
      if (executable && READ_COMMANDS.has(executable) &&
          fileArguments(executable, args!.slice(1)).some((path) => isSensitiveFile(path, patterns))) return true;
    }
  }
  return false;
}

function mask(text: string): string {
  return text ? "*** command output redacted: file source could not be verified ***" : text;
}

/**
 * Redact output only when a configured sensitive file read is identified.
 * Ambiguous reads without an identified sensitive path leave output unchanged.
 */
export async function redactCommandReadOutput(
  command: string,
  workspaceRoot: string,
  stdout: string,
  stderr: string,
  options?: CommandRedactionOptions,
): Promise<{ stdout: string; stderr: string }> {
  const read = parseStaticFileRead(command);
  if (read === null) return { stdout, stderr };
  if (read === "untrusted") {
    // Only positively identified reads of configured files trigger redaction.
    const sensitive = hasSensitiveReadInUnsafeCommand(command, options);
    if (sensitive === false) return { stdout, stderr };
    return { stdout: mask(stdout), stderr: mask(stderr) };
  }

  if (!isSensitiveFile(read.path, [...BUILTIN_SENSITIVE_FILES, ...(options?.sensitiveFiles ?? [])])) {
    return { stdout, stderr };
  }
  const absolute = resolve(workspaceRoot, read.path);
  const root = resolve(workspaceRoot);
  // 标准化路径比较：统一转换为正斜杠以支持跨平台路径判断
  const normalizedAbsolute = absolute.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/");
  if (normalizedAbsolute !== normalizedRoot && !normalizedAbsolute.startsWith(`${normalizedRoot}/`)) {
    return { stdout: mask(stdout), stderr: mask(stderr) };
  }

  try {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) return { stdout: mask(stdout), stderr: mask(stderr) };
  } catch {
    // A missing static file does not make stderr a file-content leak.
    return { stdout, stderr };
  }

  const rel = normalizeRel(workspaceRoot, absolute);
  return {
    stdout: redactSecrets(stdout, rel, options).text,
    stderr: redactSecrets(stderr, rel, options).text,
  };
}
