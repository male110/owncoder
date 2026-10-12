import { spawn } from "node:child_process";
import { simpleGit } from "simple-git";

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  dirty: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  summary: string;
}

export function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 8_000,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 1, out, err: err || "git timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      err += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, out, err: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

export async function isGitRepo(workspaceRoot: string): Promise<boolean> {
  try {
    return await simpleGit(workspaceRoot).checkIsRepo();
  } catch {
    return false;
  }
}

export async function getGitStatus(workspaceRoot: string): Promise<GitStatus> {
  const empty: GitStatus = {
    isRepo: false,
    branch: null,
    dirty: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    summary: "非 Git 仓库",
  };

  if (!(await isGitRepo(workspaceRoot))) return empty;

  try {
    const git = simpleGit(workspaceRoot);
    const status = await git.status();

    const staged = status.staged.length;
    const unstaged = status.modified.length + status.deleted.length + status.renamed.length;
    const untracked = status.not_added.length;
    const ahead = status.ahead;
    const behind = status.behind;
    const dirty = status.files.length > 0;
    const branch = status.current ?? "HEAD";

    const parts = [branch];
    if (dirty) {
      const bits: string[] = [];
      if (staged) bits.push(`${staged} staged`);
      if (unstaged) bits.push(`${unstaged} 已改`);
      if (untracked) bits.push(`${untracked} 未跟踪`);
      parts.push(bits.join(" · ") || "有改动");
    } else {
      parts.push("干净");
    }
    if (ahead) parts.push(`↑${ahead}`);
    if (behind) parts.push(`↓${behind}`);

    return {
      isRepo: true,
      branch,
      dirty,
      staged,
      unstaged,
      untracked,
      ahead,
      behind,
      summary: parts.join(" · "),
    };
  } catch {
    return { ...empty, isRepo: true, summary: "Git 状态获取失败" };
  }
}
