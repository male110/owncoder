import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { findSearchScopeViolation } from "./terminal.ts";

// 平台无关的工作区根：win32 下 resolve("/ws") → C:\ws，越界判定同样成立。
const ROOT = resolve("/ws");
const INSIDE = join(ROOT, "src");
const OUTSIDE = resolve("/outside");

test("findSearchScopeViolation: 工作区内搜索放行", () => {
  for (const cmd of [
    "find . -name '*.ts'",
    `find ${INSIDE} -name 'x'`,
    "grep -rnE --exclude-dir=node_modules 'pattern' .",
    "grep -rnE x src/main",
    "rg 'getUser\\(' src",
    "ls",
    "ls -la",
    "ls -R .",
    `ls ${INSIDE}`,
    "find . -name 'x' -not -path '*/node_modules/*' 2>/dev/null",
    "grep -r x . | head -5",
  ]) {
    assert.equal(findSearchScopeViolation(cmd, ROOT), null, cmd);
  }
});

test("findSearchScopeViolation: 全盘/绝对路径越界拦截", () => {
  for (const cmd of [
    "find / -name 'AdminVerifyTaskController.java'",
    `find ${OUTSIDE} -name 'x'`,
    "grep -rnE x /etc",
    `grep -rn "x" "${OUTSIDE}"`,
    `ls ${OUTSIDE}`,
    "ls -la /",
  ]) {
    const v = findSearchScopeViolation(cmd, ROOT);
    assert.ok(v, cmd);
    assert.ok(v!.includes("confined to the workspace"), cmd);
  }
});

test("findSearchScopeViolation: 相对路径逃逸与家目录拦截", () => {
  for (const cmd of [
    "ls ..",
    "find ../ -name 'x'",
    "grep -rn x ../foo",
    "ls ~",
    "grep -rn x ~/file",
  ]) {
    assert.ok(findSearchScopeViolation(cmd, ROOT), cmd);
  }
  // 工作区内部回绕不算逃逸
  assert.equal(findSearchScopeViolation("ls src/..", ROOT), null);
});

test("findSearchScopeViolation: 复合命令逐段检查", () => {
  assert.ok(findSearchScopeViolation(`echo "---"; find / -name 'x' 2>/dev/null`, ROOT));
  assert.ok(findSearchScopeViolation("ls . && ls ..", ROOT));
  assert.ok(findSearchScopeViolation(`ls ${INSIDE} || ls ${OUTSIDE}`, ROOT));
  assert.equal(findSearchScopeViolation("grep -rn x . ; echo done", ROOT), null);
});

test("findSearchScopeViolation: 读类命令与非搜索命令不受限", () => {
  for (const cmd of [
    "cat /etc/passwd",
    "head -20 /var/log/syslog",
    "git status",
    "echo '---'",
    "pwd",
  ]) {
    assert.equal(findSearchScopeViolation(cmd, ROOT), null, cmd);
  }
});

test("findSearchScopeViolation: 2>/dev/null 等设备引用不误伤", () => {
  assert.equal(
    findSearchScopeViolation("find . -name 'x' 2>/dev/null; echo done", ROOT),
    null,
  );
  assert.ok(findSearchScopeViolation("find / -name 'x' 2>/dev/null", ROOT));
});

test("findSearchScopeViolation: 工作区根自身的绝对路径放行", () => {
  assert.equal(findSearchScopeViolation(`ls ${ROOT}`, ROOT), null);
  assert.ok(findSearchScopeViolation(`ls ${ROOT}/..`, ROOT));
});

test.skipIf(process.platform !== "win32")(
  "findSearchScopeViolation: MSYS2 盘符风格 /e/… 按盘符解析",
  () => {
    assert.equal(findSearchScopeViolation("ls /e/ws/src", "E:\\ws"), null);
    assert.ok(findSearchScopeViolation("ls /e/other", "E:\\ws"));
    assert.equal(findSearchScopeViolation("grep -rn x /e/ws", "e:\\ws"), null);
  },
);
