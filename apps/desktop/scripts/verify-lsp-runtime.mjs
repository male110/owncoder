import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 清空 PATH，验证 Electron 可以独立完成 npm 安装和 LSP 初始化。
const require = createRequire(import.meta.url);
const executable = process.argv[2] ?? require("electron");
const npmCli = process.argv[3] ?? join(dirname(require.resolve("npm")), "bin", "npm-cli.js");
const env = { ...process.env, PATH: "", ELECTRON_RUN_AS_NODE: "1" };
const root = await mkdtemp(join(tmpdir(), "owncoder lsp "));
let server;
try {
  const exec = promisify(execFile);
  const { stdout } = await exec(executable, [npmCli, "--version"], { env, windowsHide: true, timeout: 30000 });
  console.log(`内置 npm：${stdout.trim()}`);
  await exec(executable, [npmCli, "install", "--prefix", root, "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "yaml-language-server"], {
    cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024,
  });
  const packageRoot = join(root, "node_modules", "yaml-language-server");
  const pkg = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  server = spawn(executable, [join(packageRoot, pkg.bin["yaml-language-server"]), "--stdio"], {
    cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LSP 初始化超时")), 15000);
    let buffer = "";
    server.on("error", reject);
    server.on("exit", (code) => reject(new Error(`LSP 提前退出：${code}`)));
    server.stderr.on("data", (data) => process.stderr.write(data));
    server.stdout.on("data", (data) => {
      buffer += data.toString();
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const length = Number(/Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd))?.[1]);
        if (!length || Buffer.byteLength(buffer.slice(headerEnd + 4)) < length) return;
        const bytes = Buffer.from(buffer.slice(headerEnd + 4));
        const message = JSON.parse(bytes.subarray(0, length).toString());
        buffer = bytes.subarray(length).toString();
        if (message.id === 1) {
          clearTimeout(timer);
          if (message.error || !message.result?.capabilities) reject(new Error("LSP 初始化失败"));
          else resolve();
          return;
        }
      }
    });
    const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
    server.stdin.write(`Content-Length: ${Buffer.byteLength(request)}\r\n\r\n${request}`);
  });
  console.log("PATH 为空：npm 安装成功，语言服务器初始化成功。");
} finally {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill();
    await exited;
  }
  await rm(root, { recursive: true, force: true });
}
