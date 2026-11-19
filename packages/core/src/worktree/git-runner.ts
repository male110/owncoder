/**
 * 运行隔离的 Git 命令并解码路径。
 *
 * 移植自 codex-rs/worktree/src/git.rs（以及 codex-rs/git-utils/src/operations.rs 的
 * git_config_override_env）：
 * - 剥掉所有继承的 GIT_* 环境变量（Git 包装器会把仓库局部状态导出给子进程，
 *   这里按 cwd 选择仓库，只用我们自己的每命令配置）
 * - 禁用 hooks、fsmonitor、attributes
 * - 工作区操作额外禁用已配置的 clean/smudge/process filter
 * - stdout 保留 Buffer：worktree list --porcelain -z 的字段按字节 0x00 切分
 */

import { spawn } from "node:child_process";

const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const SAFE_BARE_REPOSITORY_CONFIG = "safe.bareRepository=explicit";
const DEFAULT_TIMEOUT_MS = 120_000;

/** 命令类别：工作区操作会额外禁用 filter 并改写文件，元数据操作只读。 */
export type GitOperation = "metadata" | "working-tree";

export interface GitOutput {
  stdout: Buffer;
  stderr: string;
}

interface GitRunOptions {
  /** 超时毫秒数，默认 120s。 */
  timeoutMs?: number;
}

/** 去掉所有以 GIT_ 开头的继承环境变量（Windows 下键名大小写不敏感），再叠加 extra。 */
function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (name.toUpperCase().startsWith("GIT_")) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** 用 GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n 编码命令局部配置。 */
function gitConfigOverrideEnv(overrides: [string, string][]): Record<string, string> {
  if (overrides.length === 0) return {};
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(overrides.length) };
  overrides.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}

function baseGitArgs(): string[] {
  return [
    "-c",
    SAFE_BARE_REPOSITORY_CONFIG,
    "-c",
    `core.hooksPath=${DISABLED_HOOKS_PATH}`,
    "-c",
    "core.fsmonitor=",
    "-c",
    "attr.tree=",
    "-c",
    "core.attributesFile=",
  ];
}

interface RawGitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** 原始 git 调用（带环境隔离与基础 -c 配置）；成功与否都返回。 */
function spawnGit(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RawGitResult> {
  const child = spawn("git", [...baseGitArgs(), ...args], {
    cwd,
    windowsHide: true,
    shell: false,
    env: scrubbedEnv(extraEnv),
  });
  return new Promise<RawGitResult>((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: 1, stdout: Buffer.concat(chunks), stderr: stderr || "git timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: Buffer.concat(chunks), stderr: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

/** 列出仓库里已配置的 filter 驱动（filter.<driver>.clean/smudge/process/required）。 */
async function configuredFilters(cwd: string): Promise<Set<string>> {
  const result = await spawnGit(cwd, ["config", "--null", "--name-only", "--get-regexp", "^filter\\."]);
  if (result.code === 1) return new Set();
  if (result.code !== 0) {
    throw new Error(`failed to inspect Git filter configuration: ${result.stderr.trim()}`);
  }
  const filters = new Set<string>();
  for (const name of result.stdout.toString("utf8").split("\0")) {
    const match = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(name);
    if (match && match[1]) filters.add(match[1]);
  }
  return filters;
}

/**
 * 运行一条 git 命令。失败抛出 Error（信息为修剪后的 stderr），
 * 成功返回原始 stdout Buffer 与 stderr 文本。
 */
export async function gitOutput(
  cwd: string,
  operation: GitOperation,
  args: string[],
  opts: GitRunOptions = {},
): Promise<GitOutput> {
  const extraEnv: Record<string, string> = {
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  if (operation === "working-tree") {
    const filters = await configuredFilters(cwd);
    const overrides: [string, string][] = [];
    for (const filter of filters) {
      overrides.push([`filter.${filter}.process`, ""]);
      overrides.push([`filter.${filter}.clean`, ""]);
      overrides.push([`filter.${filter}.smudge`, ""]);
      overrides.push([`filter.${filter}.required`, "false"]);
    }
    Object.assign(extraEnv, gitConfigOverrideEnv(overrides));
  }
  const result = await spawnGit(cwd, args, extraEnv, opts.timeoutMs);
  if (result.code !== 0) {
    throw new Error(`git command failed: ${result.stderr.trim()}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

/** 工作区操作，stdout 按 UTF-8 解码并 trim。 */
export async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await gitOutput(cwd, "working-tree", args);
  return stdout.toString("utf8").trim();
}

/** 元数据操作，stdout 去掉行尾后作为路径返回；空路径抛错。 */
export async function gitPath(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await gitOutput(cwd, "metadata", args);
  const text = stdout.toString("utf8").replace(/\r?\n$/, "");
  if (text.length === 0) throw new Error("git returned an empty path");
  return text;
}

/**
 * 解析仓库缓存的默认分支（不 fetch、不继承 Git 选择器）。
 * 优先远端 HEAD（origin 在前），其次约定的 main/master。
 */
export async function defaultWorktreeBase(cwd: string): Promise<string> {
  const { stdout } = await gitOutput(cwd, "metadata", [
    "for-each-ref",
    "--format=%(refname) %(symref)",
    "refs/remotes",
    "refs/heads",
  ]);
  const branches: [string, string][] = [];
  for (const line of stdout.toString("utf8").split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    const separator = trimmed.indexOf(" ");
    if (separator === -1) continue;
    branches.push([trimmed.slice(0, separator), trimmed.slice(separator + 1)]);
  }
  // 对应 codex 的 min_by_key(|(name, _)| (!origin, name))：origin 的 HEAD 最优先，
  // 其余远端 HEAD 按名字排序；只保留 symref 非空的目标。
  const heads = branches
    .filter(([name, target]) => name.endsWith("/HEAD") && target !== "")
    .sort(([a], [b]) => {
      const rank = (name: string) => (name.startsWith("refs/remotes/origin/") ? 0 : 1);
      const rankDiff = rank(a) - rank(b);
      return rankDiff !== 0 ? rankDiff : a < b ? -1 : a > b ? 1 : 0;
    });
  const base = heads.length > 0 ? heads[0][1] : undefined;
  if (base !== undefined) return base;
  const candidates = [
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "refs/heads/main",
    "refs/heads/master",
  ];
  const fallback = candidates.find((candidate) => branches.some(([branch]) => branch === candidate));
  if (fallback === undefined) {
    throw new Error("Could not determine the project's default branch.");
  }
  return fallback;
}
