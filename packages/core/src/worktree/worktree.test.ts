/**
 * 受管 worktree 集成测试（真实 git 仓库）。
 *
 * 移植自 codex-rs/worktree/tests/worktree.rs 的关键用例。约定与
 * checkpoint-git.test.ts 一致：每个测试一个 tmpdir 下的独立环境，
 * 用 runGit 建仓和提交，用 WorktreeManager 跑受管流程。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runGit } from "../git.ts";
import {
  WorktreeManager,
  defaultWorktreeBase,
  resolveWorktreeSettings,
} from "./index.ts";

/** 建一个带初始提交的 git 仓库（a.txt/"hello"），返回初始 commit sha。 */
async function makeGitRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  expect((await runGit(dir, ["init", "-b", "main"])).code).toBe(0);
  expect((await runGit(dir, ["config", "user.name", "Worktree Test"])).code).toBe(0);
  expect((await runGit(dir, ["config", "user.email", "test@example.invalid"])).code).toBe(0);
  await fs.writeFile(join(dir, "a.txt"), "hello", "utf8");
  expect((await runGit(dir, ["add", "-A"])).code).toBe(0);
  const commit = await runGit(dir, ["commit", "-m", "init", "--no-verify"]);
  expect(commit.code, `commit failed: ${commit.err}`).toBe(0);
  return revParseHead(dir);
}

async function revParseHead(repo: string): Promise<string> {
  const rev = await runGit(repo, ["rev-parse", "HEAD"]);
  expect(rev.code, rev.err).toBe(0);
  return rev.out.trim();
}

/** 在仓库里做一次提交，返回 commit sha。 */
async function commitAll(repo: string, message: string): Promise<string> {
  expect((await runGit(repo, ["add", "-A"])).code).toBe(0);
  const commit = await runGit(repo, ["commit", "-m", message, "--no-verify"]);
  expect(commit.code, `commit failed: ${commit.err}`).toBe(0);
  return revParseHead(repo);
}

/** 判断目录是否为空（桶清理断言用）。 */
async function isEmptyDir(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir);
  return entries.length === 0;
}

describe("managed worktree", () => {
  let testRoot: string;
  let repo: string;
  let repoSubdir: string;
  let initialSha: string;
  let manager: WorktreeManager;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testRoot = join(tmpdir(), `owcoder-worktree-${randomUUID()}`);
    repo = join(testRoot, "repo");
    repoSubdir = join(repo, "sub", "dir");
    initialSha = await makeGitRepo(repo);
    await fs.mkdir(repoSubdir, { recursive: true });
    manager = new WorktreeManager(resolveWorktreeSettings({ root: join(testRoot, "worktrees") }));
  });

  afterEach(async () => {
    // process.chdir 的测试必须把 cwd 还原回原处，否则 rm 当前目录后
    // 后续测试的 cwd 指向已删除的目录。
    if (process.cwd() !== originalCwd) {
      process.chdir(originalCwd);
    }
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {
      // 清理失败不影响断言。
    });
  });

  it("create：产物为分离 HEAD、文件已物化、桶布局为 <root>/<4hex>/<仓库名>", async () => {
    const checkout = await manager.create({ sourceCwd: repo });

    expect(checkout.sourceRoot).toBe(repo);
    expect(checkout.headSha).toBe(initialSha);
    expect(checkout.branch).toBeNull();
    // 桶布局：<root>/<4 位 hex>/repo
    const relative = checkout.root.slice(join(testRoot, "worktrees").length + 1);
    const [bucket, name] = relative.split(/[\\/]+/);
    expect(bucket).toMatch(/^[0-9a-fA-F]{4}$/);
    expect(name).toBe("repo");
    // 分离 HEAD：worktree 的 HEAD 指向基准 commit 而不是分支。
    expect(await revParseHead(checkout.root)).toBe(initialSha);
    const branch = await runGit(checkout.root, ["symbolic-ref", "-q", "HEAD"]);
    expect(branch.code).not.toBe(0);
    // 文件已物化（--no-checkout 之后靠 reset --hard 填充）。
    const content = await fs.readFile(join(checkout.root, "a.txt"), "utf8");
    expect(content).toBe("hello");
  });

  it("create：保留源仓库的相对子目录作为 cwd", async () => {
    await fs.writeFile(join(repoSubdir, "nested.txt"), "nested", "utf8");
    await commitAll(repo, "add nested");

    const checkout = await manager.create({ sourceCwd: repoSubdir });

    // cwd 是 root 下的同相对子目录且存在。
    expect(checkout.cwd.endsWith(join("sub", "dir"))).toBe(true);
    const stat = await fs.stat(checkout.cwd);
    expect(stat.isDirectory()).toBe(true);
    const content = await fs.readFile(join(checkout.cwd, "nested.txt"), "utf8");
    expect(content).toBe("nested");
  });

  it("create：以指定 commit 为基准", async () => {
    await fs.writeFile(join(repo, "a.txt"), "v2", "utf8");
    const second = await commitAll(repo, "second");

    const checkout = await manager.create({ sourceCwd: repo, base: initialSha });

    expect(checkout.headSha).toBe(initialSha);
    expect(await revParseHead(checkout.root)).toBe(initialSha);
    const content = await fs.readFile(join(checkout.root, "a.txt"), "utf8");
    expect(content).toBe("hello");
    expect(second).not.toBe(initialSha);
  });

  it("create：源仓库的共享配置不被改动（无 worktreeConfig）", async () => {
    await manager.create({ sourceCwd: repo });

    // 源仓库不应开启 per-worktree 配置扩展。
    const config = await runGit(repo, ["config", "--get", "extensions.worktreeConfig"]);
    expect(config.code).not.toBe(0);
  });

  it("list：只返回本仓库的受管 worktree", async () => {
    const otherRepo = join(testRoot, "other-repo");
    await makeGitRepo(otherRepo);

    const ours = await manager.create({ sourceCwd: repo });
    const theirs = await manager.create({ sourceCwd: otherRepo });

    const listed = await manager.list(repo);
    expect(listed.map((entry) => entry.root)).toEqual([ours.root]);
    const otherListed = await manager.list(otherRepo);
    expect(otherListed.map((entry) => entry.root)).toEqual([theirs.root]);
  });

  it("list：非受管 worktree 与主工作区被过滤", async () => {
    const ours = await manager.create({ sourceCwd: repo });

    // 手动建一个 worktree：不在受管根下，必须被过滤。
    const manual = join(testRoot, "manual-wt");
    expect((await runGit(repo, ["worktree", "add", "--detach", manual, "HEAD"])).code).toBe(0);

    const listed = await manager.list(repo);
    expect(listed.map((entry) => entry.root)).toEqual([ours.root]);
  });

  it("list：陈旧注册被别的目录占用时跳过", async () => {
    const ours = await manager.create({ sourceCwd: repo });

    // 删掉受管 worktree 的目录内容但保留注册（模拟路径被别的占用者夺走）。
    await runGit(repo, ["worktree", "remove", "--force", ours.root]);
    await fs.mkdir(ours.root, { recursive: true });
    // 一个没有任何 git 元数据的目录占住了注册路径：list 必须跳过它。
    const listed = await manager.list(repo);
    expect(listed).toEqual([]);
  });

  it("remove：正常删除并清理空桶", async () => {
    const ours = await manager.create({ sourceCwd: repo });

    await manager.remove(repo, ours.root);

    expect(await isEmptyDir(join(testRoot, "worktrees"))).toBe(true);
    const listed = await manager.list(repo);
    expect(listed).toEqual([]);
  });

  it("remove：含 ignored 本地文件时拒绝", async () => {
    await fs.writeFile(join(repo, ".gitignore"), "*.log\n", "utf8");
    await commitAll(repo, "add gitignore");
    const ours = await manager.create({ sourceCwd: repo });
    await fs.writeFile(join(ours.root, "debug.log"), "noise", "utf8");

    await expect(manager.remove(repo, ours.root)).rejects.toThrow(/ignored local files/);

    // 清理：删掉文件再移除，否则 afterEach 的 rm 会留下 worktree 注册。
    await fs.unlink(join(ours.root, "debug.log"));
    await manager.remove(repo, ours.root);
  });

  it("remove：当前 cwd 位于 worktree 内时拒绝", async () => {
    const ours = await manager.create({ sourceCwd: repo });

    process.chdir(ours.root);
    // remove 按"调用方所在 cwd"判定：此时 cwd 在 worktree 内，必须拒绝。
    await expect(manager.remove(ours.root, ours.root)).rejects.toThrow(/switch to another checkout/);
    process.chdir(testRoot);
    await manager.remove(repo, ours.root);
  });

  it("bindThread/owner：绑定、幂等与跨线程拒绝", async () => {
    const ours = await manager.create({ sourceCwd: repo });

    expect(await manager.owner(ours.root)).toBeNull();

    await manager.bindThread(ours.root, "thread-1");
    expect(await manager.owner(ours.root)).toBe("thread-1");

    // 同线程重入是幂等的。
    await manager.bindThread(ours.root, "thread-1");
    expect(await manager.owner(ours.root)).toBe("thread-1");

    // 其他线程不能夺走。
    await expect(manager.bindThread(ours.root, "thread-2")).rejects.toThrow(
      /already belongs to thread thread-1/,
    );

    await manager.remove(repo, ours.root);
  });

  it("bindThread：非受管目录被拒绝", async () => {
    // 主工作区不是受管 worktree；根目录未创建时也可能是
    // "cannot resolve managed worktree root"，两者都是拒绝。
    await expect(manager.bindThread(repo, "thread-1")).rejects.toThrow(/managed worktree/);
  });

  it("defaultWorktreeBase：优先 origin 的 HEAD", async () => {
    // 在没有真远端的情况下模拟 origin 的 symref 注册。
    expect((await runGit(repo, ["update-ref", "refs/remotes/origin/main", initialSha])).code).toBe(0);
    expect(
      (await runGit(repo, ["update-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])).code,
    ).toBe(0);

    await expect(defaultWorktreeBase(repo)).resolves.toBe("refs/remotes/origin/main");
  });

  it("defaultWorktreeBase：无远端时回退到本地 main/master", async () => {
    await expect(defaultWorktreeBase(repo)).resolves.toBe("refs/heads/main");
  });

  it("create：重复调用产生不同的桶（并行分配不冲突）", async () => {
    const first = await manager.create({ sourceCwd: repo });
    const second = await manager.create({ sourceCwd: repo });
    expect(first.root).not.toBe(second.root);

    const listed = await manager.list(repo);
    expect(listed.map((entry) => entry.root).sort()).toEqual([first.root, second.root].sort());
  });
});
