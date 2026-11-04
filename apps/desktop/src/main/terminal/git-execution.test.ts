import { describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { CompletionProviders } from "./completions";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

describe("bounded Git execution", () => {
  it("uses literal argv, enforces timeout/output bounds, and caches timeout failures", async () => {
    const run = vi.mocked(execFile);
    run.mockImplementation(((_file: unknown, _args: unknown, _opts: unknown, callback: (error: Error) => void) => {
      callback(Object.assign(new Error("timeout"), { killed: true, code: "ETIMEDOUT" }));
    }) as typeof execFile);
    const providers = new CompletionProviders(35, 10000);
    const cwd = "C:\\repo with 'quotes'; not-a-command";
    expect(await providers.branches(cwd)).toEqual([]);
    expect(await providers.branches(cwd)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    const [file, args, options] = run.mock.calls[0];
    expect(file).toBe("git");
    expect(args).toEqual(["--no-optional-locks", "-C", cwd, "for-each-ref", "--format=%(refname)%00%(symref)", "refs/heads", "refs/remotes"]);
    expect(options).toMatchObject({ timeout: 35, maxBuffer: 262144, windowsHide: true });
    expect(options).not.toHaveProperty("shell");
    expect(options?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
  });
});
