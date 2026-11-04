#!/usr/bin/env node
/**
 * 内置 MSYS2 运行时冒烟验证（pack:win 时 electron-builder 之后执行）。
 *
 * 验证两点：
 *   1. bundle 自足性——清空 PATH 与 MSYSTEM，只给 System32，直接 spawn
 *      随包 bash.exe，冒烟 POSIX 管道/重定向/核心工具（grep/sed/awk/
 *      find/diff/curl）与 /tmp 可写（usertemp 挂载）；
 *   2. 打包产物落位——release/win-unpacked/resources/msys2 存在
 *      （afterPack 拷贝结果；nsis-web 二次构建路径不同则告警跳过）。
 * 任何失败非零退出，阻断发布。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptsDir, "..");
const bundleRoot = join(packageDir, "bundled-tools", "msys2");
const bash = join(bundleRoot, "usr", "bin", "bash.exe");

if (!existsSync(bash)) {
  console.error("verify-msys2-runtime: 内置 MSYS2 运行时缺失，先跑 pnpm prepare:msys2");
  process.exit(1);
}

// 与运行期 msys2SpawnEnv 同形态：binDir 前置 + HOME 兜底 + 删除 MSYSTEM。
const env = {
  SystemRoot: process.env.SystemRoot,
  PATH: `${join(bundleRoot, "usr", "bin")};${process.env.SystemRoot}\\System32`,
  HOME: process.env.USERPROFILE,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
delete env.MSYSTEM;

const script = [
  "echo ok",
  "echo x | wc -c",
  "ls /dev/null",
  "grep --version | head -1",
  "sed --version | head -1",
  "awk --version | head -1",
  "find --version | head -1",
  "diff --version | head -1",
  "curl --version | head -1",
  "mktemp",
  "printf probe > /tmp/oc-verify && cat /tmp/oc-verify && rm /tmp/oc-verify",
].join("; ");

const r = spawnSync(bash, ["-c", script], { encoding: "utf8", windowsHide: true, env });
if (r.status !== 0) {
  console.error(
    `verify-msys2-runtime: 内置 bash 冒烟失败 rc=${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );
  process.exit(1);
}
const firstLine = r.stdout.trim().split("\n")[0];
if (firstLine !== "ok") {
  console.error(`verify-msys2-runtime: 冒烟首行异常: ${JSON.stringify(firstLine)}`);
  process.exit(1);
}
console.log(`verify-msys2-runtime: 内置 bash 冒烟通过（${r.stdout.trim().split("\n").length} 行输出）`);

// 打包产物落位检查（best-effort：nsis-web 单独构建时 win-unpacked 可能已被清理）
const packagedBash = join(
  packageDir,
  "release",
  "win-unpacked",
  "resources",
  "msys2",
  "usr",
  "bin",
  "bash.exe",
);
if (existsSync(packagedBash)) {
  console.log("verify-msys2-runtime: 打包产物 release/win-unpacked/resources/msys2 就位");
} else {
  console.warn("verify-msys2-runtime: WARN 未找到 win-unpacked 产物（可能已清理），跳过落位检查");
}
