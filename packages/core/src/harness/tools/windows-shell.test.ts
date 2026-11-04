import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveWindowsShell } from "./windows-shell.ts";

test("resolveWindowsShell: 始终选择 PowerShell", () => {
  assert.deepEqual(resolveWindowsShell(), { kind: "powershell" });
});

test("resolveWindowsShell: 结果缓存（同一次会话内复用同一对象）", () => {
  const a = resolveWindowsShell();
  const b = resolveWindowsShell();
  assert.equal(a, b);
});
