import { findSearchScopeViolation, isReadonlyBash, looksDangerous } from "../terminal.ts";
import { isRedactionEnabled } from "../redact.ts";
import { redactCommandReadOutput } from "../command-redaction.ts";
import type { ToolContext, ToolResult } from "./types.ts";
import { fail, ok, runCommand } from "./shared.ts";

export async function toolBash(ctx: ToolContext, command: string): Promise<ToolResult> {
  if (!command || !command.trim()) {
    return fail("bash requires a non-empty command");
  }
  // 搜索范围围栏（先于模式与危险命令检查）：搜索/列目录类命令不得把范围
  // 扩到工作区之外——find /、grep -r x /、ls ..、ls ~ 一律拒绝，堵死
  // "read_file 失败 → 全盘 find 定位"的兜底路径。
  const scopeViolation = findSearchScopeViolation(command, ctx.workspaceRoot);
  if (scopeViolation) {
    const id = `bash_${Date.now().toString(36)}`;
    const at = new Date().toISOString();
    ctx.onTerminal?.({
      id,
      command,
      cwd: ctx.workspaceRoot,
      status: "denied",
      at,
    });
    return fail(scopeViolation);
  }
  if (ctx.mode !== "agent") {
    if (ctx.workflow.modes.spec.bash !== "readonly") {
      return fail("bash denied in Spec mode (hard read-only)");
    }
    if (!isReadonlyBash(command)) {
      return fail(
        "Spec mode bash is readonly-only (ls/dir/git status/diff/log、type/Get-Content 等)。拒绝执行写操作命令。",
      );
    }
  }
  const id = `bash_${Date.now().toString(36)}`;
  const at = new Date().toISOString();

  if (looksDangerous(command)) {
    // 自动批准开关（设置 → modes.agent.autoApproveBash）：勾选后危险命令
    // 不再弹确认，直接执行。未勾选时维持原有确认/硬拦截行为。
    if (ctx.workflow.modes.agent.autoApproveBash) {
      ctx.onTerminal?.({
        id,
        command,
        cwd: ctx.workspaceRoot,
        status: "ok",
        at,
      });
    } else {
      const needConfirm = ctx.workflow.modes.agent.dangerousBashConfirm;
      if (needConfirm && ctx.confirmDangerousBash) {
        ctx.onTerminal?.({
          id,
          command,
          cwd: ctx.workspaceRoot,
          status: "pending_confirm",
          at,
        });
        const allowed = await ctx.confirmDangerousBash(command);
        if (!allowed) {
          ctx.onTerminal?.({
            id,
            command,
            cwd: ctx.workspaceRoot,
            status: "denied",
            at: new Date().toISOString(),
          });
          return fail(`Dangerous command denied by user: ${command.slice(0, 120)}`);
        }
      } else {
        ctx.onTerminal?.({
          id,
          command,
          cwd: ctx.workspaceRoot,
          status: "denied",
          at,
        });
        return fail(
          `Blocked potentially dangerous command: no confirmation path available (modes.agent.dangerousBashConfirm is off, or the host did not inject confirmDangerousBash). Soften the command or wire a confirmer: ${command.slice(0, 120)}`,
        );
      }
    }
  }

  ctx.onTerminal?.({
    id,
    command,
    cwd: ctx.workspaceRoot,
    status: "running",
    at: new Date().toISOString(),
  });
  // 注入 .owncoder 等目录排除（仅 POSIX 壳分支生效；PowerShell 回退跳过）。
  // 排除列表来自 settings（harness.searchExclusions，默认 [".owncoder"]）。
  const { stdout, stderr, code } = await runCommand(command, ctx.workspaceRoot, 300_000, ctx.signal, {
    searchExclusions: ctx.workflow.harness.searchExclusions,
  });
  const safeOutput = isRedactionEnabled(ctx.workflow)
    ? await redactCommandReadOutput(command, ctx.workspaceRoot, stdout, stderr, {
        sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
        patterns: ctx.workflow.secrets?.patterns,
      })
    : { stdout, stderr };
  ctx.onTerminal?.({
    id,
    command,
    cwd: ctx.workspaceRoot,
    exitCode: code,
    stdout: safeOutput.stdout,
    stderr: safeOutput.stderr,
    status: code === 0 ? "ok" : "error",
    at: new Date().toISOString(),
  });
  const body = [
    `exit ${code}`,
    safeOutput.stdout && `stdout:\n${safeOutput.stdout}`,
    safeOutput.stderr && `stderr:\n${safeOutput.stderr}`,
  ]
    .filter(Boolean)
    .join("\n");
  const safeBody = body || "(no output)";
  return ok(safeBody);
}
