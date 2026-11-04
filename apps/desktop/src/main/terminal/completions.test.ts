import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CompletionProviders, completionTarget, shellLiteral } from "./completions";

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "owncoder-completion-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("literal-only completion contexts", () => {
  it.each([
    ["git checkout fe", "branch", "fe"],
    ["git switch --track origin/fe", "branch", "origin/fe"],
    ["git switch --detach fe", "branch", "fe"],
    ["git checkout -- src/", "path", "src/"],
    ["cd 'child f", "path", "child f"],
    ['Set-Location "my folder"', "path", "my folder"],
    ["Get-Content ./sr", "path", "./sr"],
    ["gi", "command", "gi"],
  ])("parses %s", (line, provider, prefix) => {
    expect(completionTarget(line, line.length)).toMatchObject({ provider, prefix });
  });

  it.each(["git switch -c new", "git checkout foo bar", "git -C repo switch fe", "cd $HOME", "cd a;write-output b", "cd $(pwd)", "git switch a|cmd", "cd `a", "Get-Content @args", "cd a\nb"])('fails closed for %s', line => {
    expect(completionTarget(line, line.length)).toBeNull();
  });

  it("rejects mid-token edit ambiguity and quotes shell metacharacters as literals", () => {
    expect(completionTarget("git switch feature", 14)).toBeNull();
    expect(shellLiteral("feature/a")).toBe("feature/a");
    expect(shellLiteral("a'b $c;d")).toBe("'a''b $c;d'");
  });
});

describe("local providers", () => {
  it("lists local and remote branches, omits symbolic HEAD, bounds and caches requests", async () => {
    const cwd = temp();
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, stdio: "pipe" });
    git("init", "--initial-branch=main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
    git("branch", "feature/local");
    git("tag", "feature/local");
    git("branch", "unsafe’;Write-Output_PWN;‘rest");
    git("remote", "add", "origin", ".");
    git("update-ref", "refs/remotes/origin/feature/remote", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature/remote");
    const providers = new CompletionProviders(1000, 60000);
    const labels = (await providers.branches(cwd)).map(i => i.label);
    expect(labels).toEqual(["feature/local", "main", "origin/feature/remote"]);
    git("branch", "later");
    expect((await providers.branches(cwd)).map(i => i.label)).toEqual(labels);
    const result = await providers.complete({ revision: 7, active: true, cwd, line: "git switch fe", cursor: 13 });
    expect(result).toMatchObject({ revision: 7, from: 11, to: 13 });
    expect(result!.items.map(i => i.label)).toEqual(["feature/local"]);
    const completeLine = (line: string) => providers.complete({ revision: 1, active: true, cwd, line, cursor: line.length });
    expect((await completeLine("git switch "))!.items.map(i => i.label)).toEqual(["feature/local", "main"]);
    expect((await completeLine("git switch --track "))!.items.map(i => i.label)).toEqual(["origin/feature/remote"]);
    expect((await completeLine("git switch --detach "))!.items.map(i => i.label)).toEqual(labels);
    expect((await completeLine("git checkout "))!.items.map(i => i.label)).toEqual(labels);
    expect((await completeLine("git switch fe"))!.items[0].insertText).toBe("feature/local");
    git("switch", "feature/local"); // Same-named tag must not produce heads/feature/local.
    git("switch", "--track", "origin/feature/remote");
    expect(await new CompletionProviders().branches(temp())).toEqual([]);
  });

  it("completes directories/files with literal quoting and excludes unsafe paths", async () => {
    const cwd = temp();
    mkdirSync(path.join(cwd, "child folder"));
    mkdirSync(path.join(cwd, "child's folder"));
    writeFileSync(path.join(cwd, "child.txt"), "test");
    writeFileSync(path.join(cwd, "-flag"), "test");
    writeFileSync(path.join(cwd, "a[1].txt"), "test");
    mkdirSync(path.join(cwd, "a[1]"));
    for (const quote of ["‘", "’", "‚", "‛", "“", "”"]) {
      writeFileSync(path.join(cwd, `payload${quote}; Write-Output PWN; ${quote}rest.txt`), "test");
      expect(() => shellLiteral(`payload${quote}; Write-Output PWN; ${quote}rest.txt`)).toThrow();
    }
    const provider = new CompletionProviders();
    const dirsOnly = await provider.paths(cwd, "child", true);
    expect(dirsOnly.map(i => i.kind)).toEqual(["directory", "directory"]);
    expect(dirsOnly.find(i => i.label.includes("'"))!.insertText).toBe("'child''s folder/'");
    expect((await provider.paths(cwd, "child", false)).some(i => i.kind === "file")).toBe(true);
    expect((await provider.paths(cwd, "", false)).find(i => i.label.endsWith("-flag"))!.insertText).toBe("./-flag");
    const all = await provider.paths(cwd, "", false);
    expect(all.some(item => /[\u2018-\u201f\[\]]/.test(item.label))).toBe(false);
    for (const unsafe of ["\\\\server\\share\\", "//server/share/", "Registry::a", "C:relative", "./*", "./?", "./[abc]"]) {
      expect(await provider.paths(cwd, unsafe, false)).toEqual([]);
    }
  });

  it("doesn't reissue an unchanged completion", async () => {
    const result = await new CompletionProviders().complete({ revision: 1, active: true, cwd: temp(), line: "git", cursor: 3 });
    expect(result!.items).toEqual([]);
  });
});
