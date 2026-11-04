import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "vitest";
import { injectOwncoderExclusion, runCommand } from "./shared.ts";

test.skipIf(process.platform !== "win32")("runCommand: PowerShell 执行变量、管道、重定向、UTF-8 和退出码", async () => {
  const root = await mkdtemp(join(tmpdir(), "owncoder-powershell-"));
  const input = join(root, "input.txt");
  const output = join(root, "output.txt");
  try {
    await writeFile(input, "中文输入", "utf8");
    const command = `$value = (Get-Content '${input}' -Raw).Trim(); $value | Set-Content '${output}' -Encoding utf8; Get-Content '${output}' -Raw`;
    const result = await runCommand(command, root, 30_000);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), "中文输入");
    assert.equal(result.stderr, "");

    const piped = await runCommand("Write-Output pipeline-ok | ForEach-Object { $_.ToUpperInvariant() }", root, 30_000);
    assert.equal(piped.code, 0);
    assert.equal(piped.stdout.trim(), "PIPELINE-OK");

    const failed = await runCommand("Write-Error 'powershell-failure'; exit 7", root, 30_000);
    assert.equal(failed.code, 7);
    assert.match(failed.stderr, /powershell-failure/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("runCommand: 空命令由 PowerShell 稳定返回", async () => {
  const result = await runCommand("", process.cwd(), 30_000);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
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
