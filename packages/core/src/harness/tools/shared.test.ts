import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";
import { injectOwncoderExclusion, runCommand } from "./shared.ts";
import { resetWindowsShellCacheForTest } from "./windows-shell.ts";

// runCommand 的 Windows 分支优先走随包 MSYS2 bash（OWNCODER_MSYS2_ROOT 由
// 桌面端 bootstrap 注入）。以下用例在该平台且 bundle 就绪（prepare:msys2
// 产物）时验证 POSIX 行为；bundle 缺失时跳过——回退 PowerShell 属历史
// 行为，其 UTF-8 包装语义由 bash 工具的跨平台测试与 dev 冒烟覆盖。
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

test.skipIf(!bundleReady)("bundled bash: stdout round-trips UTF-8", async () => {
  const { stdout, stderr, code } = await runCommand("echo '中文输出测试'", process.cwd(), 30_000);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "中文输出测试");
  assert.equal(stderr, "");
});

test.skipIf(!bundleReady)("bundled bash: POSIX pipes, /dev/null and exit codes", async () => {
  const { stdout, code } = await runCommand("echo pipeline-ok | wc -c", process.cwd(), 30_000);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "12"); // "pipeline-ok\n" = 12 字节

  const fail = await runCommand("ls /definitely-missing-path-xyz", process.cwd(), 30_000);
  assert.notEqual(fail.code, 0);
  assert.ok(fail.stderr.length > 0, "expected bash's own error on stderr");
  // bash 自身错误输出是 UTF-8；若按控制台代码页误解码会出现 U+FFFD
  assert.ok(!fail.stderr.includes("\u{FFFD}"), `mojibake in stderr: ${fail.stderr}`);
});

test.skipIf(!bundleReady)("bundled bash: cat reads UTF-8 BOM-less files", async () => {
  const path = join(tmpdir(), `owncoder-shared-utf8-${Date.now()}.txt`);
  try {
    await writeFile(path, "无BOM中文文件内容", "utf8");
    // bash 下双引号/单引号内的反斜杠路径不可靠，统一正斜杠（与调用点审计一致）
    const posixPath = path.split("\\").join("/");
    const { stdout, code } = await runCommand(`cat '${posixPath}'`, process.cwd(), 30_000);
    assert.equal(code, 0);
    assert.ok(stdout.includes("无BOM中文文件内容"), stdout);
  } finally {
    await unlink(path).catch(() => {});
  }
});

// ── injectOwncoderExclusion 单元测试 ──────────────────────
// 纯字符串变换，不依赖平台/子进程，全平台运行。

describe("injectOwncoderExclusion", () => {
  test("grep: 命令名后注入 --exclude-dir=.owncoder", () => {
    assert.equal(
      injectOwncoderExclusion("grep -rn 'x' ."),
      "grep --exclude-dir=.owncoder -rn 'x' .",
    );
  });

  test("grep: 前导空白被 trim，注入仍生效", () => {
    assert.equal(
      injectOwncoderExclusion("  grep -rn 'x' ."),
      "grep --exclude-dir=.owncoder -rn 'x' .",
    );
  });

  test("rg: 注入 --glob=!.owncoder/**", () => {
    assert.equal(
      injectOwncoderExclusion("rg 'pattern' src/"),
      "rg --glob=!.owncoder/** 'pattern' src/",
    );
  });

  test("find: 排除谓词注入到最后一个路径参数之后", () => {
    assert.equal(
      injectOwncoderExclusion("find . -name '*.ts'"),
      "find . -not -path '*/.owncoder/*' -name '*.ts'",
    );
  });

  test("find: 显式路径参数时注入到路径之后", () => {
    assert.equal(
      injectOwncoderExclusion("find src -name '*.ts'"),
      "find src -not -path '*/.owncoder/*' -name '*.ts'",
    );
  });

  test("find: 多路径时注入到最后一个路径之后", () => {
    assert.equal(
      injectOwncoderExclusion("find . src -name '*.ts'"),
      "find . src -not -path '*/.owncoder/*' -name '*.ts'",
    );
  });

  test("find: 无路径参数时注入到末尾（find 默认搜索 .）", () => {
    assert.equal(
      injectOwncoderExclusion("find -name '*.ts'"),
      "find -name '*.ts' -not -path '*/.owncoder/*'",
    );
  });

  test("ls -R: 注入 --ignore=.owncoder", () => {
    assert.equal(
      injectOwncoderExclusion("ls -R"),
      "ls --ignore=.owncoder -R",
    );
    assert.equal(
      injectOwncoderExclusion("ls -R src"),
      "ls --ignore=.owncoder -R src",
    );
  });

  test("ls: 组合短选项 -laR 也被识别为递归", () => {
    assert.equal(
      injectOwncoderExclusion("ls -laR"),
      "ls --ignore=.owncoder -laR",
    );
  });

  test("ls: 非递归（无 -R）不注入", () => {
    assert.equal(injectOwncoderExclusion("ls -la"), "ls -la");
    assert.equal(injectOwncoderExclusion("ls src"), "ls src");
  });

  test("grep: 已含 --exclude-dir 时不注入（尊重显式意图）", () => {
    assert.equal(
      injectOwncoderExclusion("grep -rn --exclude-dir=foo 'x' ."),
      "grep -rn --exclude-dir=foo 'x' .",
    );
    assert.equal(
      injectOwncoderExclusion("grep -rn --exclude-dir foo 'x' ."),
      "grep -rn --exclude-dir foo 'x' .",
    );
  });

  test("grep: 已含 --exclude 时不注入", () => {
    assert.equal(
      injectOwncoderExclusion("grep -rn --exclude='*.min.js' 'x' ."),
      "grep -rn --exclude='*.min.js' 'x' .",
    );
  });

  test("rg: 已含 --glob 时不注入", () => {
    assert.equal(
      injectOwncoderExclusion("rg --glob='!dist/**' pattern"),
      "rg --glob='!dist/**' pattern",
    );
  });

  test("管道场景：只处理最开头段落，下游命令不受影响", () => {
    // grep 在管道开头 → 注入到 grep 自身；wc 不受影响。
    assert.equal(
      injectOwncoderExclusion("grep -rn 'x' . | wc -l"),
      "grep --exclude-dir=.owncoder -rn 'x' . | wc -l",
    );
    // grep 不在开头（echo | grep）→ 整条命令原样。
    assert.equal(
      injectOwncoderExclusion("echo hi | grep foo"),
      "echo hi | grep foo",
    );
  });

  test("git grep 等带前缀命令不匹配，原样返回", () => {
    assert.equal(injectOwncoderExclusion("git grep 'foo'"), "git grep 'foo'");
    assert.equal(injectOwncoderExclusion("xargs grep foo"), "xargs grep foo");
  });

  test("非搜索命令原样返回", () => {
    assert.equal(injectOwncoderExclusion("cat file.txt"), "cat file.txt");
    assert.equal(injectOwncoderExclusion("npm test"), "npm test");
    assert.equal(injectOwncoderExclusion("echo hi"), "echo hi");
  });

  test("引号未闭合时安全降级（原样返回）", () => {
    assert.equal(injectOwncoderExclusion("grep -rn 'unterminated ."), "grep -rn 'unterminated .");
  });

  test("自定义排除列表", () => {
    assert.equal(
      injectOwncoderExclusion("grep -rn 'x' .", ["dist", "build"]),
      "grep --exclude-dir=dist --exclude-dir=build -rn 'x' .",
    );
  });

  test("空排除列表 = 关闭注入", () => {
    assert.equal(injectOwncoderExclusion("grep -rn 'x' .", []), "grep -rn 'x' .");
  });

  test("含不安全字符的排除条目被丢弃", () => {
    // "; rm -rf /" 不符合安全字符集，被过滤；剩余 .owncoder 正常注入。
    assert.equal(
      injectOwncoderExclusion("grep -rn 'x' .", [".owncoder", "bad;rm"]),
      "grep --exclude-dir=.owncoder -rn 'x' .",
    );
  });

  test("find: 用户已用 -path 排除时幂等（不重复注入）", () => {
    const cmd = "find . -path '*/.owncoder/*' -prune -o -name '*.ts' -print";
    assert.equal(injectOwncoderExclusion(cmd), cmd);
  });

  test("ls: 用户已 --ignore 该目录时幂等", () => {
    const cmd = "ls -R --ignore=.owncoder";
    assert.equal(injectOwncoderExclusion(cmd), cmd);
  });

  test("find: 取值型谓词的值不被误判为路径参数", () => {
    // -newer 的值 src/a.ts 是"取值"，不是路径参数；注入点仍在 '.' 之后。
    assert.equal(
      injectOwncoderExclusion("find . -newer src/a.ts -name '*.ts'"),
      "find . -not -path '*/.owncoder/*' -newer src/a.ts -name '*.ts'",
    );
  });

  test("find: -type f 等无值谓词不影响注入点", () => {
    assert.equal(
      injectOwncoderExclusion("find . -type f -name '*.ts'"),
      "find . -not -path '*/.owncoder/*' -type f -name '*.ts'",
    );
  });
});
