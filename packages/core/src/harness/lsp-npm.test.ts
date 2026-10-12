import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), exists: vi.fn(), realpath: vi.fn(), read: vi.fn(), readdir: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("node:fs", () => ({ existsSync: mocks.exists, realpathSync: mocks.realpath, readFileSync: mocks.read, readdirSync: mocks.readdir }));
vi.mock("node:util", () => ({ promisify: () => mocks.exec }));
import path from "node:path";
import { runLspNpmInstall, resolveLspNodeEntry } from "./lsp-npm.ts";

const args = ["install", "--prefix", "C:\\项目 & tools\\.owncoder\\lsp", "@vue/language-server"];

beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("OWNCODER_LSP_NPM_CLI", undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("LSP npm 安装进程", () => {
  it("Windows 通过 Node 启动 npm 入口，完整保留包含空格和特殊字符的参数", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.exec.mockResolvedValueOnce({ stdout: "C:\\Program Files\\nodejs\\npm.cmd\r\n" }).mockResolvedValueOnce({});
    mocks.exists.mockReturnValue(true);
    await runLspNpmInstall(args, "workspace");
    const cli = path.join(path.dirname("C:\\Program Files\\nodejs\\npm.cmd"), "node_modules", "npm", "bin", "npm-cli.js");
    expect(mocks.exec).toHaveBeenNthCalledWith(2, process.execPath, [cli, ...args], expect.objectContaining({
      cwd: "workspace", windowsHide: true, maxBuffer: 2 * 1024 * 1024,
    }));
  });

  it.each(["linux", "darwin"] as const)("%s 直接执行 npm", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    mocks.exec.mockResolvedValue({});
    await runLspNpmInstall(args, "workspace");
    expect(mocks.exec).toHaveBeenCalledWith("npm", args, expect.objectContaining({ cwd: "workspace" }));
  });

  it("npm 不在 PATH 中时给出安装和重启提示", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.exec.mockRejectedValue(new Error("where failed"));
    await expect(runLspNpmInstall(args, "workspace")).rejects.toThrow("PATH 中找不到 npm.cmd");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it("npm 安装不完整时不启动安装进程", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.exec.mockResolvedValue({ stdout: "C:\\nodejs\\npm.cmd\r\n" });
    mocks.exists.mockReturnValue(false);
    await expect(runLspNpmInstall(args, "workspace")).rejects.toThrow("请修复或重新安装");
    expect(mocks.exec).toHaveBeenCalledTimes(1);
  });

  it("启动命令缺失时提供明确提示", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mocks.exec.mockRejectedValue(Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }));
    await expect(runLspNpmInstall(args, "workspace")).rejects.toThrow("无法启动 npm");
  });

  it.each(["win32", "linux", "darwin"] as const)("%s 无系统 Node/npm 时使用内置资源", async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.stubGlobal("process", Object.defineProperty(Object.create(process), "versions", { value: { ...process.versions, electron: "43.3.0" } }));
    vi.stubEnv("PATH", "");
    vi.stubEnv("OWNCODER_LSP_NPM_CLI", "resources with spaces/npm/bin/npm-cli.js");
    mocks.exists.mockReturnValue(true);
    mocks.exec.mockResolvedValue({});
    await runLspNpmInstall(args, "workspace");
    expect(mocks.exec).toHaveBeenCalledExactlyOnceWith(process.execPath,
      ["resources with spaces/npm/bin/npm-cli.js", ...args], expect.objectContaining({
        env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: "1", PATH: "" }),
      }));
  });

  it("内置 npm 资源缺失时不回退到系统命令", async () => {
    vi.stubEnv("OWNCODER_LSP_NPM_CLI", "missing/npm-cli.js");
    mocks.exists.mockReturnValue(false);
    await expect(runLspNpmInstall(args, "workspace")).rejects.toThrow("应用内 npm 资源缺失");
    expect(mocks.exec).not.toHaveBeenCalled();
  });

  it("Windows bin 包装脚本通过包元数据解析到 JS 入口", () => {
    const bin = path.join("workspace", "node_modules", ".bin", "server.cmd");
    mocks.realpath.mockReturnValue(bin);
    mocks.readdir.mockReturnValue(["server-package"]);
    mocks.exists.mockReturnValue(true);
    mocks.read.mockReturnValue(JSON.stringify({ bin: { server: "bin/start.js" } }));
    expect(resolveLspNodeEntry(bin, "server")).toBe(path.resolve("workspace", "node_modules", "server-package", "bin/start.js"));
  });

  it("Unix 符号链接直接解析 JS 入口", () => {
    mocks.realpath.mockReturnValue("/packages/server/start.mjs");
    expect(resolveLspNodeEntry("/modules/.bin/server", "server")).toBe("/packages/server/start.mjs");
  });

  it("原生可执行文件不改用 Node 启动", () => {
    mocks.realpath.mockReturnValue("/bin/clangd");
    mocks.readdir.mockReturnValue([]);
    expect(resolveLspNodeEntry("/bin/clangd", "clangd")).toBeNull();
  });

  it("保留 npm 的退出码和 stderr，失败后仍可发起下一次安装", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const failure = Object.assign(new Error("npm install failed: E403"), { code: 1, stderr: "registry E403" });
    mocks.exec.mockRejectedValueOnce(failure).mockResolvedValueOnce({});
    await expect(runLspNpmInstall(args, "workspace")).rejects.toBe(failure);
    await expect(runLspNpmInstall(args, "workspace")).resolves.toBeUndefined();
  });
});
