import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, test } from "vitest";
import { decodeChildOutput, wrapChildProcessModule } from "./child-process-shim.ts";
import { resetWindowsShellCacheForTest } from "./windows-shell.ts";

// cmd.exe「系统找不到指定的路径。」的 GBK(cp936) 原始字节——取自 Windows
// 主机 execSync 失败 stderr 的实测捕获。严格 UTF-8 解码非法（这正是旧代码
// 有损解码出 ϵͳҲα·汾 类乱码的字节），GBK 兜底必须逐字还原。
const GBK_PATH_NOT_FOUND = Buffer.from(
  "cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4c2b7beb6a1a30d0a",
  "hex",
);
const GBK_TEXT = "系统找不到指定的路径。\r\n";

test("decodeChildOutput: 合法 UTF-8 原样返回", () => {
  const buf = Buffer.from("中文输出 ABC\r\n", "utf8");
  assert.equal(decodeChildOutput(buf), "中文输出 ABC\r\n");
});

test("decodeChildOutput: 非法 UTF-8 的 GBK 字节按 GBK 还原", () => {
  assert.equal(decodeChildOutput(GBK_PATH_NOT_FOUND), GBK_TEXT);
});

test("decodeChildOutput: 空 Buffer/已解码字符串/空值", () => {
  assert.equal(decodeChildOutput(Buffer.alloc(0)), "");
  assert.equal(decodeChildOutput("already"), "already");
  assert.equal(decodeChildOutput(undefined), "");
  assert.equal(decodeChildOutput(null), "");
});

// ── 包装层（真实 child_process，跨平台） ──────────────────────

const wrapped = wrapChildProcessModule(childProcess as unknown as Record<string, unknown>) as typeof childProcess;

// Windows 默认壳用例需要随包 MSYS2 bundle（prepare:msys2 产物）；
// 干净环境无 bundle 时跳过 bash 默认壳用例（回退 cmd.exe 由专门用例覆盖）。
const msys2Root = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../apps/desktop/bundled-tools/msys2",
);
const bundleReady = process.platform === "win32" && existsSync(join(msys2Root, "usr/bin/bash.exe"));
const prevRoot = process.env.OWNCODER_MSYS2_ROOT;

beforeAll(() => {
  if (bundleReady) process.env.OWNCODER_MSYS2_ROOT = msys2Root;
  resetWindowsShellCacheForTest();
});
afterAll(() => {
  if (prevRoot === undefined) delete process.env.OWNCODER_MSYS2_ROOT;
  else process.env.OWNCODER_MSYS2_ROOT = prevRoot;
  resetWindowsShellCacheForTest();
});

test("包装 facade:execSync 成功输出仍是字符串（缺省行为不变）", () => {
  const out = wrapped.execSync("echo hello-shim");
  assert.equal(typeof out, "string");
  assert.ok(out.includes("hello-shim"));
});

test("包装 facade:显式 encoding:'buffer' 原样透传", () => {
  const out = wrapped.execSync("echo x", { encoding: "buffer" });
  assert.ok(Buffer.isBuffer(out));
});

test("包装 facade:execSync 失败错误消息保留文本且无 U+FFFD", () => {
  assert.throws(
    () => wrapped.execSync("node -e \"console.error('boom-stderr');process.exit(1)\""),
    (e: unknown) => {
      const err = e as { message?: string; stderr?: unknown };
      const msg = err.message ?? "";
      assert.ok(msg.includes("Command failed"), msg);
      assert.ok(msg.includes("boom-stderr"), msg);
      assert.ok(!msg.includes("�"), "mojibake replacement char in: " + JSON.stringify(msg));
      // err.stderr 仍是字符串（与 utf8 缺省语义一致），且内容干净
      assert.equal(typeof err.stderr, "string");
      assert.ok(String(err.stderr).includes("boom-stderr"));
      return true;
    },
  );
});

test("包装 facade:spawnSync 缺省仍返回 Buffer（行为不变）", () => {
  // 不用 echo：Windows 无 echo.exe，spawnSync 不走 shell
  const r = wrapped.spawnSync(process.execPath, ["-e", "console.log('spawn-buffer-default')"]);
  assert.ok(Buffer.isBuffer(r.stdout));
});

test("包装 facade:spawnSync 显式 utf8 时输出为解码后的字符串", () => {
  const r = wrapped.spawnSync(process.execPath, ["-e", "console.error('spawn-err-boom');process.exit(1)"], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.equal(typeof r.stderr, "string");
  assert.ok(String(r.stderr).includes("spawn-err-boom"));
  assert.ok(!String(r.stderr).includes("�"));
});

test("包装 facade:exec 回调收到解码后的 stdout/stderr", async () => {
  await new Promise<void>((resolve, reject) => {
    wrapped.exec(
      "node -e \"console.log('out-line');console.error('err-line');process.exit(1)\"",
      (err, stdout, stderr) => {
        try {
          assert.ok(err, "expected failure");
          assert.equal(stdout, "out-line\n");
          assert.equal(stderr, "err-line\n");
          resolve();
        } catch (e) {
          reject(e);
        }
      },
    );
  });
});

test("包装 facade:promisify(exec) 保持 {stdout, stderr} 语义", async () => {
  const promisified = promisify(wrapped.exec);
  const r = await promisified("echo promisify-ok");
  assert.ok(r.stdout.includes("promisify-ok"));
  assert.equal(typeof r.stderr, "string");
});

test("包装 facade:不突变原模块，其余导出保持可用", () => {
  assert.notEqual(wrapped, childProcess);
  assert.equal(typeof wrapped.spawn, "function");
  assert.equal(typeof wrapped.execFileSync, "function");
  assert.equal(typeof (childProcess as { execSync: unknown }).execSync, "function");
});

// ── 搜索范围围栏（workspace 有界） ──────────────────────────

const scopedRoot = mkdtempSync(join(tmpdir(), "owncoder-scope-"));
const scoped = wrapChildProcessModule(
  childProcess as unknown as Record<string, unknown>,
  { workspaceRoot: scopedRoot },
) as typeof childProcess;

test("包装 facade:越界搜索命令在 spawn 前抛错（execSync 字符串形态）", () => {
  assert.throws(
    () => scoped.execSync("ls .."),
    (e: unknown) => {
      const msg = String((e as Error).message);
      assert.ok(msg.includes("confined to the workspace"), msg);
      return true;
    },
  );
});

test("包装 facade:execFileSync 数组参数形态同样受限", () => {
  assert.throws(
    () => scoped.execFileSync("ls", ["..", "/"]),
    (e: unknown) => {
      assert.ok(String((e as Error).message).includes("confined to the workspace"));
      return true;
    },
  );
});

test("包装 facade:工作区内命令与无范围参数的模块不受影响", () => {
  const out = scoped.execSync("echo inside-scope-ok");
  assert.ok(String(out).includes("inside-scope-ok"));
  // 未传 workspaceRoot 的包装不做范围检查（仅编码修正），行为不变
  assert.ok(String(wrapped.execSync("echo no-scope-ok")).includes("no-scope-ok"));
});

// ── Windows 实证路径（GBK 本地化报错） ────────────────────────

test.skipIf(process.platform !== "win32")(
  "包装 facade:显式 shell 指定 cmd.exe 锁定 cmd 路径，GBK 本地化报错正确还原（用户复现命令）",
  () => {
    // 默认壳已是随包 bash（POSIX 管道可用）；显式 shell 指定 cmd.exe，
    // 用它锁定 cmd 路径验证 GBK 兜底解码仍然生效。
    assert.throws(
      () =>
        wrapped.execSync(
          'grep -r "verifyTask/list" --include="*.java" -l . 2>/dev/null | head -20',
          { encoding: "utf8", shell: "cmd.exe" },
        ),
      (e: unknown) => {
        const err = e as { message?: string; stderr?: unknown };
        const msg = err.message ?? "";
        assert.ok(msg.includes("Command failed"), msg);
        // 乱码特征消失：有损替换符（U+FFFD）、ϵͳ 类希腊/希伯来碎片
        assert.ok(!msg.includes("\u{FFFD}"), JSON.stringify(msg));
        assert.ok(!msg.includes("ϵ"), JSON.stringify(msg));
        // err.stderr 为正确解码的文本
        assert.equal(typeof err.stderr, "string");
        const locale = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
        if (locale.toLowerCase().startsWith("zh")) {
          assert.ok(msg.includes("系统找不到指定的路径"), JSON.stringify(msg));
          assert.ok(String(err.stderr).includes("系统找不到指定的路径"));
        }
        return true;
      },
    );
  },
);

test.skipIf(!bundleReady)(
  "包装 facade:Windows 字符串命令默认走随包 bash（POSIX 管道可用）",
  () => {
    const out = wrapped.execSync("printf bash-default-ok | wc -c", { encoding: "utf8" });
    assert.equal(out.trim(), "15"); // printf 不带换行，"bash-default-ok" 共 15 字节
  },
);

test.skipIf(process.platform !== "win32")(
  "包装 facade:无随包 bundle 时回退 Node 默认壳仍可执行命令（不因缺 bundle 崩溃）",
  () => {
    const saved = process.env.OWNCODER_MSYS2_ROOT;
    delete process.env.OWNCODER_MSYS2_ROOT;
    resetWindowsShellCacheForTest();
    try {
      // 回退壳（cmd.exe/宿主环境）下 echo 均可用——只验证回退路径功能正常；
      // “回退的是哪个壳”由 windows-shell.test.ts 的 resolver 用例覆盖。
      const out = wrapped.execSync("echo fallback-shell-ok", { encoding: "utf8" });
      assert.ok(out.includes("fallback-shell-ok"), out);
    } finally {
      if (saved === undefined) delete process.env.OWNCODER_MSYS2_ROOT;
      else process.env.OWNCODER_MSYS2_ROOT = saved;
      resetWindowsShellCacheForTest();
    }
  },
);
