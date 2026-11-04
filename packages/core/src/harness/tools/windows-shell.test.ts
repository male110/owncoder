import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, test } from "vitest";
import { msys2SpawnEnv, resetWindowsShellCacheForTest, resolveWindowsShell } from "./windows-shell.ts";

const REAL_ROOT = process.env.OWNCODER_MSYS2_ROOT;
// 随包 bundle 的构建期位置（prepare:msys2 产物）；干净 CI 无产物时相应用例内部跳过断言。
const bundleRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../apps/desktop/bundled-tools/msys2",
);

beforeEach(() => resetWindowsShellCacheForTest());
afterEach(() => {
  if (REAL_ROOT === undefined) delete process.env.OWNCODER_MSYS2_ROOT;
  else process.env.OWNCODER_MSYS2_ROOT = REAL_ROOT;
  resetWindowsShellCacheForTest();
});

test("resolveWindowsShell: 未注入 env → powershell 兜底（历史行为）", () => {
  delete process.env.OWNCODER_MSYS2_ROOT;
  assert.equal(resolveWindowsShell().kind, "powershell");
});

test("resolveWindowsShell: env 指向不存在目录 → powershell 兜底", () => {
  process.env.OWNCODER_MSYS2_ROOT = "E:\\definitely-missing-msys2-root";
  assert.equal(resolveWindowsShell().kind, "powershell");
});

test("resolveWindowsShell: 结果缓存（同一次会话内复用同一对象）", () => {
  delete process.env.OWNCODER_MSYS2_ROOT;
  const a = resolveWindowsShell();
  const b = resolveWindowsShell();
  assert.equal(a, b);
});

test("resolveWindowsShell: 有效 bundle（bash.exe + msys-2.0.dll 齐全）→ msys2-bash", () => {
  if (!existsSync(join(bundleRoot, "usr/bin/bash.exe")) || !existsSync(join(bundleRoot, "usr/bin/msys-2.0.dll"))) {
    // 干净环境未跑 prepare:msys2，无法构造有效 bundle——跳过断言
    return;
  }
  process.env.OWNCODER_MSYS2_ROOT = bundleRoot;
  const shell = resolveWindowsShell();
  assert.equal(shell.kind, "msys2-bash");
  if (shell.kind === "msys2-bash") {
    assert.ok(existsSync(shell.bashPath), shell.bashPath);
    assert.ok(shell.bashPath.endsWith("bash.exe"));
    assert.ok(existsSync(shell.binDir), shell.binDir);
  }
});

test("msys2SpawnEnv: PATH 前置 bundle binDir、删除 MSYSTEM、HOME 兜底", () => {
  const prevMsystem = process.env.MSYSTEM;
  const prevHome = process.env.HOME;
  process.env.MSYSTEM = "MINGW64";
  delete process.env.HOME;
  try {
    const env = msys2SpawnEnv("C:\\fake-msys2-root");
    const binDir = join("C:\\fake-msys2-root", "usr", "bin");
    assert.ok(env.PATH?.startsWith(binDir), `PATH should prepend binDir, got ${env.PATH}`);
    assert.equal(env.MSYSTEM, undefined, "MSYSTEM must not leak into msys children");
    assert.equal(env.HOME, process.env.USERPROFILE ?? process.env.TEMP ?? "C:\\fake-msys2-root");
  } finally {
    if (prevMsystem === undefined) delete process.env.MSYSTEM;
    else process.env.MSYSTEM = prevMsystem;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
});
