/**
 * 受管 git worktree 管理器。
 *
 * 移植自 codex-rs/worktree/src/lib.rs。布局契约：所有受管 worktree 落在
 * 统一分配根 <root>/<4位hex>/<仓库名> 下，分离 HEAD、默认远端主分支，
 * 只写 worktree 自己的 config（不改源仓库共享配置）。
 *
 * create 流程：rev-parse 基准 commit → 分配桶 → worktree add --detach
 * --no-checkout → 写 per-worktree core.worktree → reset --hard 物化文件 →
 * 校验 cwd → 任何中途失败都回滚 worktree 与空桶。
 *
 * list 的过滤链（桶布局 4 位 hex + .git 是文件 + common-dir 属于本仓库 +
 * gitdir 反向回链）保证只列出本仓库的受管 worktree。
 */

import { promises as fs } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { gitOutput, gitPath, gitStdout } from "./git-runner.ts";
import { allocateWorktreeRoot, joinGitPath, removeEmptyBucket, simplifyWindowsPath, toNativePath } from "./paths.ts";
import * as metadata from "./metadata.ts";
import type { WorktreeSettings } from "./settings.ts";

/** 与 Desktop 兼容的 checkout 描述 + 启动线程用的 cwd。 */
export interface ManagedWorktree {
  /** worktree 根目录。 */
  root: string;
  /** 线程应在的 cwd（源仓库相对子目录平移过来）。 */
  cwd: string;
  /** 源仓库根目录。 */
  sourceRoot: string;
  /** 源仓库的 cwd。 */
  sourceCwd: string;
  /** worktree 的 HEAD commit。 */
  headSha: string;
  /** UTF-8 分支标签；缺失不代表分离 HEAD。 */
  branch: string | null;
}

export interface CreateWorktree {
  /** 派发任务时所在的 cwd。 */
  sourceCwd: string;
  /** 基准（分支/commit）；缺省解析为远端默认分支。 */
  base?: string;
}

export class WorktreeManager {
  readonly settings: WorktreeSettings;

  constructor(settings: WorktreeSettings) {
    this.settings = { ...settings, root: simplifyWindowsPath(settings.root) };
  }

  /** 在 sourceCwd 所属仓库里创建一个受管 worktree。 */
  async create(request: CreateWorktree): Promise<ManagedWorktree> {
    if (!isAbsolute(this.settings.root)) {
      throw new Error("managed worktree root must be an absolute path");
    }

    const sourceCwd = await realpathErr(request.sourceCwd, `cannot resolve ${request.sourceCwd}`);
    const sourceRoot = await repositoryRoot(sourceCwd);
    const relativeCwd = stripRootPrefix(sourceCwd, sourceRoot);
    const repositoryName = basename(sourceRoot);
    const revision = `${request.base ?? "HEAD"}^{commit}`;
    const headSha = await gitStdout(sourceRoot, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      revision,
    ]);
    const root = await allocateWorktreeRoot(this.settings.root, repositoryName);

    try {
      await gitOutput(sourceRoot, "working-tree", [
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        root,
        headSha,
      ]);
    } catch (error) {
      await removeEmptyBucket(root);
      throw wrap(error, "cannot create managed worktree");
    }

    // 只写目标 worktree 自己的 config：不改源仓库的共享设置，也不开启
    // worktreeConfig。
    try {
      const config = await gitPath(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "config.worktree",
      ]);
      await gitOutput(root, "metadata", [
        "config",
        "--file",
        config,
        "core.worktree",
        root,
      ]);
      // 在物化文件前发现 destination-only filter，并在 per-worktree 配置禁用时
      // 依然钉住工作区。
      await gitOutput(root, "working-tree", [
        "--work-tree=.",
        "reset",
        "--hard",
        "--no-recurse-submodules",
        headSha,
      ]);
    } catch (error) {
      await removeWorktree(sourceRoot, root);
      throw wrap(error, "cannot populate managed worktree");
    }

    const cwd = join(root, relativeCwd);
    if (!(await isSafeWorktreeCwd(root, cwd))) {
      await removeWorktree(sourceRoot, root);
      throw new Error(
        `requested base does not contain a safe working directory ${relativeCwd}`,
      );
    }

    return { cwd, root, sourceRoot, sourceCwd, headSha, branch: null };
  }

  /** 列出本仓库的所有受管 worktree（按 root 排序）。 */
  async list(sourceCwd: string): Promise<ManagedWorktree[]> {
    const resolved = await realpathErr(sourceCwd, `cannot resolve ${sourceCwd}`);
    const sourceRoot = await repositoryRoot(resolved);
    const relativeCwd = stripRootPrefix(resolved, sourceRoot);
    const managedRoot = (async () => {
      try {
        return await fs.realpath(this.settings.root).then(simplifyWindowsPath);
      } catch {
        return this.settings.root;
      }
    })();
    const managed = await managedRoot;
    const sourceCommonDir = await resolveGitPath(sourceRoot, "--git-common-dir");
    const { stdout } = await gitOutput(resolved, "metadata", [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);

    const fields = stdout.toString("utf8").split("\0");
    const worktrees: ManagedWorktree[] = [];

    for (const entry of splitOnEmpty(fields)) {
      let root: string | undefined;
      let headSha: string | undefined;
      let branch: string | null = null;

      for (const field of entry) {
        if (field.startsWith("worktree ")) {
          root = toNativePath(field.slice("worktree ".length));
        } else if (field.startsWith("HEAD ")) {
          headSha = field.slice("HEAD ".length);
        } else if (field.startsWith("branch ")) {
          const name = field.slice("branch ".length);
          branch = name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
        }
      }

      if (root === undefined) continue;
      const bucket = parentDir(root);
      if (bucket === undefined) continue;
      // 别名可能改变注册元数据的归属，先确认两个目录都真实存在。
      if (!(await isDirectory(root)) || !(await isDirectory(bucket))) continue;
      const canonicalRoot = (async () => {
        try {
          return await fs.realpath(root as string).then(simplifyWindowsPath);
        } catch {
          return root as string;
        }
      })();
      const canonical = await canonicalRoot;
      const linkedGitFile = await isRegularFile(join(canonical, ".git"));
      if (!hasManagedLayout(managed, canonical) || !linkedGitFile) continue;
      if ((await linkedWorktreeCommonDir(canonical)) !== sourceCommonDir) continue;
      // 另一个 linked checkout 可能占了某个陈旧注册的路径：要求它的管理目录指回本 checkout。
      let gitDir: string;
      let backlink: string;
      try {
        gitDir = await resolveGitPath(canonical, "--git-dir");
        const raw = await fs.readFile(join(gitDir, "gitdir"));
        backlink = raw.toString("utf8").replace(/\r?\n$/, "");
      } catch {
        continue;
      }
      let backlinkPath: string;
      let gitFile: string;
      try {
        backlinkPath = await fs.realpath(joinGitPath(gitDir, backlink)).then(simplifyWindowsPath);
        gitFile = await fs.realpath(join(canonical, ".git")).then(simplifyWindowsPath);
      } catch {
        continue;
      }
      if (backlinkPath !== gitFile) continue;

      const cwd = join(root, relativeCwd);
      if (!(await isSafeWorktreeCwd(canonical, cwd))) continue;
      if (headSha === undefined) {
        throw new Error(`managed worktree ${root} has no HEAD`);
      }
      worktrees.push({
        cwd,
        root,
        sourceRoot,
        sourceCwd: resolved,
        headSha,
        branch,
      });
    }

    return worktrees.sort((left, right) => (left.root < right.root ? -1 : left.root > right.root ? 1 : 0));
  }

  /** 把 checkout 绑定到线程 id（见 metadata.ts 的原子语义）。 */
  async bindThread(checkout: string, threadId: string): Promise<void> {
    const managed = await this.managedCheckout(checkout);
    await metadata.bindThread(managed, threadId);
  }

  /** 返回 checkout 绑定的线程 id；未绑定返回 null。 */
  async owner(checkout: string): Promise<string | null> {
    const managed = await this.managedCheckout(checkout);
    return metadata.owner(managed);
  }

  /** 从仓库里移除一个已注册的受管 worktree；有本地改动时拒绝。 */
  async remove(sourceCwd: string, root: string): Promise<void> {
    // 归一化分隔符：list 返回本机路径，调用方可能传入正斜杠形式（跨平台/JSON 来源）。
    const nativeRoot = toNativePath(root);
    const checkout = (await this.list(sourceCwd)).find((entry) => entry.root === nativeRoot);
    if (checkout === undefined) {
      throw new Error(`${nativeRoot} is not a managed worktree in this repository`);
    }
    const resolvedCwd = await realpathErr(sourceCwd, `cannot resolve current directory ${sourceCwd}`);
    const checkoutRoot = await realpathErr(checkout.root, `cannot resolve worktree ${checkout.root}`);
    if (isPathInside(resolvedCwd, checkoutRoot)) {
      throw new Error("switch to another checkout before deleting the current worktree");
    }
    const { stdout } = await gitOutput(checkout.root, "working-tree", [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ]);
    if (stdout.length > 0) {
      throw new Error("worktree contains ignored local files; remove them before deleting it");
    }
    await gitOutput(checkout.sourceRoot, "working-tree", ["worktree", "remove", nativeRoot]);
    await removeEmptyBucket(nativeRoot);
  }

  /** 校验 checkout 是本分配根下的受管 linked worktree，返回规范路径。 */
  private async managedCheckout(checkout: string): Promise<string> {
    let managedRoot: string;
    try {
      managedRoot = await fs.realpath(this.settings.root).then(simplifyWindowsPath);
    } catch {
      throw new Error(`cannot resolve managed worktree root ${this.settings.root}`);
    }
    const resolved = await realpathErr(checkout, `cannot resolve worktree ${checkout}`);
    if (!hasManagedLayout(managedRoot, resolved)) {
      throw new Error(`${resolved} is not a managed worktree`);
    }
    await linkedWorktreeCommonDir(resolved);
    return resolved;
  }
}

/** git worktree remove --force 并清理空桶；用于 create 的失败回滚。 */
async function removeWorktree(sourceRoot: string, root: string): Promise<void> {
  const result = await gitOutput(sourceRoot, "working-tree", [
    "worktree",
    "remove",
    "--force",
    root,
  ]).catch((err) => err as Error);
  await removeEmptyBucket(root);
  if (result instanceof Error) {
    throw wrap(result, "cannot roll back an incomplete managed worktree");
  }
}

/** realpath + Windows 简化前缀；失败抛带信息的 Error。 */
async function realpathErr(path: string, message: string): Promise<string> {
  try {
    return simplifyWindowsPath(await fs.realpath(path));
  } catch {
    throw new Error(message);
  }
}

async function repositoryRoot(cwd: string): Promise<string> {
  const path = await gitPath(cwd, ["rev-parse", "--show-toplevel"]);
  return realpathErr(path, `cannot resolve repository root ${path}`);
}

/** sourceCwd 去掉 sourceRoot 前缀后的相对路径（仓库根本身返回空串）。 */
function stripRootPrefix(sourceCwd: string, sourceRoot: string): string {
  const rel = relative(sourceRoot, sourceCwd);
  if (rel === "") return "";
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("working directory is outside the repository root");
  }
  return rel;
}

/** 校验 cwd 解析后是 root 内的真实目录。 */
async function isSafeWorktreeCwd(root: string, cwd: string): Promise<boolean> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await fs.realpath(root).then(simplifyWindowsPath);
  } catch {
    return false;
  }
  try {
    const resolved = await fs.realpath(cwd).then(simplifyWindowsPath);
    return (await isDirectory(resolved)) && isPathInside(resolved, canonicalRoot);
  } catch {
    return false;
  }
}

/** checkout 是 root 下 <4位hex>/<名字> 的受管布局。 */
function hasManagedLayout(root: string, checkout: string): boolean {
  const rel = relative(root, checkout);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  const components = rel.split(/[\\/]+/).filter((part) => part !== "");
  if (components.length !== 2) return false;
  if (!/^[0-9a-fA-F]{4}$/.test(components[0])) return false;
  return components[1].length > 0;
}

/** checkout 是 linked worktree（git-dir ≠ common-dir），返回 common-dir。 */
async function linkedWorktreeCommonDir(checkout: string): Promise<string> {
  if (checkout !== (await repositoryRoot(checkout))) {
    throw new Error(`${checkout} is not a worktree root`);
  }
  const gitDir = await resolveGitPath(checkout, "--git-dir");
  const commonDir = await resolveGitPath(checkout, "--git-common-dir");
  if (gitDir === commonDir) {
    throw new Error(`${checkout} is not a linked worktree`);
  }
  return commonDir;
}

/** checkout 内 rev-parse 出的 git 路径（已规范化）。 */
async function resolveGitPath(checkout: string, argument: string): Promise<string> {
  const path = await gitPath(checkout, ["rev-parse", argument]);
  const joined = joinGitPath(checkout, path);
  return realpathErr(joined, `cannot resolve Git path ${joined}`);
}

/** 是否是目录；用 lstat 不跟随符号链接（对应 codex 的 symlink_metadata）。 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isFile();
  } catch {
    return false;
  }
}

function isPathInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function parentDir(path: string): string | undefined {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (separator <= 0) return undefined;
  if (separator === 2 && path[1] === ":") return undefined; // Windows 盘符根
  return path.slice(0, separator);
}

function basename(path: string): string {
  const parent = parentDir(path);
  return parent === undefined ? path : path.slice(parent.length + 1);
}

function wrap(error: unknown, context: string): Error {
  return error instanceof Error ? new Error(`${context}: ${error.message}`) : new Error(context);
}

function* splitOnEmpty(fields: string[]): Generator<string[]> {
  let current: string[] = [];
  for (const field of fields) {
    if (field === "") {
      if (current.length > 0) yield current;
      current = [];
    } else {
      current.push(field);
    }
  }
  if (current.length > 0) yield current;
}
