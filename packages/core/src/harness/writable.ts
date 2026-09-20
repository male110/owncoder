import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  BUILTIN_SENSITIVE_FILES,
  STRICT_WRITABLE_EXTENSIONS,
  STRICT_WRITABLE_FILENAMES,
} from "@owncoder/settings";
import { isSensitiveFile } from "./redact.ts";
import type { WritePolicy } from "@owncoder/shared";

const DENY_ALWAYS = [
  /(^|[\\/])\.git([\\/]|$)/i,
  /^\.owncoder[\\/]index([\\/]|$)/i,
  // Undo/rollback data and session history. These are the very files the user
  // relies on to recover from a bad edit, so the agent must never be able to
  // overwrite them through the file tools (they are plain .json, which the
  // balanced policy would otherwise happily allow).
  /^\.owncoder[\\/](?:checkpoints|sessions)([\\/]|$)/i,
  /^\.owncoder[\\/]session\.json$/i,
  /(^|[\\/])node_modules([\\/]|$)/i,
];

const BALANCED_DENY = [
  ...DENY_ALWAYS,
  /(^|[\\/])(?:dist|build|out|\.next|\.turbo)([\\/]|$)/i,
  /(^|[\\/])pnpm-lock\.yaml$/i,
  /(^|[\\/])package-lock\.json$/i,
  /(^|[\\/])yarn\.lock$/i,
  /(^|[\\/])Cargo\.lock$/i,
];

const STRICT_ALLOW_EXT = new Set<string>(STRICT_WRITABLE_EXTENSIONS);
const STRICT_ALLOW_FILENAMES = new Set<string>(STRICT_WRITABLE_FILENAMES);

export interface WritableCheck {
  ok: boolean;
  reason?: string;
  relPath: string;
}

/** True when an absolute candidate path is lexically contained by the workspace. */
export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const root = resolve(workspaceRoot);
  const abs = resolve(candidate);
  const rel = relative(root, abs);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve path under workspace and apply write policy. */
export function checkWritable(
  workspaceRoot: string,
  inputPath: string,
  policy: WritePolicy,
): WritableCheck {
  const root = resolve(workspaceRoot);
  const abs = resolve(root, inputPath);
  const rel = relative(root, abs);
  if (!isInsideWorkspace(root, abs)) {
    return { ok: false, reason: "path escapes workspace", relPath: rel };
  }
  const norm = rel.split(/[/\\]/).join("/");

  // Dedicated credential/key/database files are never writable through built-in
  // file tools, regardless of the selected policy. Placeholder allowlists are
  // handled by isSensitiveFile().
  if (isSensitiveFile(norm, BUILTIN_SENSITIVE_FILES)) {
    return { ok: false, reason: `protected sensitive file: ${norm}`, relPath: norm };
  }

  if (policy === "loose") {
    for (const re of DENY_ALWAYS) {
      if (re.test(norm)) return { ok: false, reason: `denied by safety: ${norm}`, relPath: norm };
    }
    return { ok: true, relPath: norm };
  }

  if (policy === "strict") {
    for (const re of BALANCED_DENY) {
      if (re.test(norm)) return { ok: false, reason: `strict deny: ${norm}`, relPath: norm };
    }
    const ext = extname(norm).toLowerCase();
    const filename = (norm.split("/").pop() ?? norm).toLowerCase();
    if (!STRICT_ALLOW_EXT.has(ext) && !STRICT_ALLOW_FILENAMES.has(filename)) {
      return {
        ok: false,
        reason: `strict policy: extension ${ext || "(none)"} not allowed`,
        relPath: norm,
      };
    }
    return { ok: true, relPath: norm };
  }

  // balanced (default)
  for (const re of BALANCED_DENY) {
    if (re.test(norm)) return { ok: false, reason: `balanced deny: ${norm}`, relPath: norm };
  }
  return { ok: true, relPath: norm };
}

function extname(p: string): string {
  const base = p.split("/").pop() ?? p;
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i) : "";
}

export function toAbs(workspaceRoot: string, relOrAbs: string): string {
  return resolve(workspaceRoot, relOrAbs);
}
