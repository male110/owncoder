import { type ParsedToolCall } from "./parser.ts";
import type { ToolContext, ToolResult } from "./tools/types.ts";
import { redactSecrets, isRedactionEnabled } from "./redact.ts";
import { bool, fail, num, ok, str } from "./tools/shared.ts";
import { statusEntry } from "./tools/shared.ts";
import type { TerminalEntry } from "./terminal.ts";
import { writeEventLog } from "@owncoder/llm";
import {
  toolBash,
  toolList,
  toolPatch,
  toolRead,
  toolReadSymbol,
  toolReadOutline,
  toolRepoMap,
  toolSaveExperience,
  toolSaveSpec,
  toolSaveTasks,
  toolListSpecs,
  toolSaveDesign,
  toolAnalyzeIssue,
  toolGraphSearch,
  toolSearchSymbols,
  toolSearchSemantic,
  toolGlob,
  toolWrite,
  toolAppend,
  toolProjectDeps,
  toolGrep,
} from "./tools/fs.ts";

import { toolLspDiagnostics } from "./tools/lsp.ts";
import { toolTypeCheck } from "./tools/verify.ts";
import { toolAskUser, toolReportBlocker, toolSemanticDiff, toolWebFetch, toolWebSearch } from "./tools/misc.ts";
import {
  toolForgetMemory,
  toolListMemories,
  toolSaveMemory,
  toolUpdateMemory,
} from "./tools/memories.ts";
import {
  toolListSessionChanges,
  toolUndoSessionChange,
} from "./tools/session-changes.ts";
import { toolUseSkill } from "./tools/skills.ts";
import { toolRunScript } from "./tools/run-script.ts";
import { toolAddTasks } from "./tools/add-tasks.ts";
import { toolUpdateTasks } from "./tools/update-tasks.ts";
import {
  historyRecallBeforeTurn,
  historyRecallQuery,
  toolRecallHistory,
} from "./tools/history.ts";

export type { ToolContext, ToolResult, ToolEventSink } from "./tools/types.ts";

const MUTATING_MCP_WORD = /(?:^|_)(?:write|create|update|delete|remove|move|rename|patch|edit|execute|exec|run|shell|command|deploy|publish|send|add|set|upload|post|put|click|fill|submit|query|insert|upsert|grant|revoke)(?:_|$)/i;
const READ_ONLY_MCP_PREFIX = /^(?:get|list|read|search|find|fetch|describe|inspect|view|status|check|lookup|resolve)(?:_|$)/i;

function normalizeMcpToolName(qualifiedName: string): string {
  const toolName = qualifiedName.split("__").pop() ?? qualifiedName;
  return toolName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s.-]+/g, "_");
}

function mcpToolNeedsConfirmation(qualifiedName: string): boolean {
  const normalized = normalizeMcpToolName(qualifiedName);
  if (MUTATING_MCP_WORD.test(normalized)) return true;
  // MCP annotations are not available in this client yet. Unknown operations
  // therefore require confirmation; only clearly read-only names pass directly.
  return !READ_ONLY_MCP_PREFIX.test(normalized);
}

function redactToolOutput(ctx: ToolContext, output: string): string {
  if (!isRedactionEnabled(ctx.workflow)) return output;
  return redactSecrets(output, "", {
    sensitiveFiles: ctx.workflow.secrets?.sensitiveFiles,
    patterns: ctx.workflow.secrets?.patterns,
  }).text;
}

export async function executeTool(ctx: ToolContext, call: ParsedToolCall): Promise<ToolResult> {
  if (ctx.signal?.aborted) return fail("操作已停止");

  const name = call.name;
  const args = call.arguments;
  // Enforce the effective tool surface at the execution boundary as well as
  // when building the model tool list. This closes nested run_script bypasses.
  const internalNestedTool = ctx.internalToolCall && name === "list_dir";
  if (ctx.availableTools && !ctx.availableTools.has(name) && !internalNestedTool) {
    return fail(`Tool not allowed in this role: ${name}`);
  }
  const budget = ctx.budget;
  if (budget) {
    const charge = budget.chargeTool(name, ctx.nestedToolCall === true);
    if (!charge.ok) return fail(`Tool budget exhausted before ${name}: ${charge.reason ?? "tool call limit"}`);
  }

  // Emit a live status entry so the UI shows "reading/writing file" progress
  // instead of appearing frozen. bash emits its own terminal entry internally,
  // so skip it here to avoid a duplicate.
  const status = name === "bash" ? null : statusEntry(name, args);
  const termId = `tool-${call.id}`;
  if (status && ctx.onTerminal) {
    ctx.onTerminal({
      id: termId,
      command: status.command,
      status: "running",
      at: new Date().toISOString(),
    } as TerminalEntry);
  }

  try {
    const rawResult = await runTool(ctx, call);
    // If the underlying operation completed just after cancellation, do not
    // allow its result to drive another model iteration.
    const result = ctx.signal?.aborted
      ? fail("操作已停止")
      : {
          ...rawResult,
          output: redactToolOutput(ctx, rawResult.output),
        };
    // 工具出口保留完整脱敏结果，供模型消息、事件和历史使用。
    if (status && ctx.onTerminal) {
      ctx.onTerminal({
        id: termId,
        command: status.command,
        status: result.ok ? "ok" : "error",
        stderr: result.ok ? undefined : result.output.slice(0, 4000),
        at: new Date().toISOString(),
      } as TerminalEntry);
    }
    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeEventLog({
      category: "tool_error",
      message: `工具 ${name} 执行抛出未捕获异常: ${message}`,
      details: {
        sessionId: ctx.sessionId,
        tool: name,
        args,
        error: message,
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    if (status && ctx.onTerminal) {
      ctx.onTerminal({
        id: termId,
        command: status.command,
        status: "error",
        stderr: message,
        at: new Date().toISOString(),
      } as TerminalEntry);
    }
    return fail(message);
  }
}

/**
 * Guidance for a tool call whose JSON arguments did not arrive intact.
 *
 * Two causes produce the same evidence (an unterminated string or unclosed
 * bracket in the raw payload): the model hit its output-token limit part-way
 * through, or it emitted an unescaped quote/brace inside a long field. Either
 * way the argument values cannot be trusted, so the message covers both rather
 * than asserting a cause.
 */
function truncatedPayloadMessage(name: string): string {
  const common =
    `The JSON arguments for \`${name}\` did not arrive intact — a string or bracket was left ` +
    `open, meaning the payload was either cut off by the output-token limit or contains an ` +
    `unescaped quote/brace. Nothing was written; the workspace is untouched.`;
  switch (name) {
    case "write_file":
      return (
        `${common} Refusing to overwrite the file with what may be a fragment.\n` +
        `Solutions: (1) Use write_file for the first part (<50KB), then append_file for the rest. ` +
        `(2) Split the document into several smaller files. ` +
        `(3) If the content contains quotes or backslashes, make sure they are properly escaped.`
      );
    case "apply_patch":
      return (
        `${common}\n` +
        `Solutions: (1) Split into multiple smaller SEARCH/REPLACE blocks, each targeting one section. ` +
        `(2) Use write_file if creating a new file from scratch. ` +
        `(3) Make incremental edits rather than one large patch.`
      );
    case "append_file":
      return `${common} Keep each append under 50KB and split into multiple calls if needed.`;
    case "save_spec":
    case "save_design":
    case "save_tasks":
      return (
        `${common}\n` +
        `Write the document in smaller pieces: save the first section, then extend it with append_file.`
      );
    default:
      return `${common} Retry with a shorter payload, or split the work across several calls.`;
  }
}

async function runTool(ctx: ToolContext, call: ParsedToolCall): Promise<ToolResult> {
  const name = call.name;
  const args = call.arguments;

  // A truncated/malformed payload means we do not reliably know this call's
  // arguments. For content-carrying tools acting on a fragment silently destroys
  // the rest of the file, so refuse before dispatch.
  if (args._truncated || args._invalid_json) {
    return fail(truncatedPayloadMessage(name));
  }

  try {
    switch (name) {
      // ── Original tools ──
      case "read_file": {
        if (typeof args.file_path !== "string" || !args.file_path.trim()) {
          return fail('read_file 参数错误：必须提供非空字符串 file_path，例如 {"file_path":"src/main.ts"}；参数名是 file_path。');
        }
        for (const key of ["offset", "limit"] as const) {
          const value = args[key];
          if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) {
            return fail(`read_file 参数错误：${key} 必须是大于等于 1 的整数，不能使用字符串或 null。`);
          }
        }
        return await toolRead(ctx, args.file_path, num(args.offset, 0), num(args.limit, 0));
      }
      case "read_symbol":
        return await toolReadSymbol(ctx, str(args.file_path), str(args.symbol), num(args.padding, 12));
      case "read_outline":
        return await toolReadOutline(ctx, str(args.file_path));
      // list_dir remains an internal compatibility helper for run_script.
      case "list_dir":
        return await toolList(ctx, str(args.file_path ?? "."), bool(args.recursive));
      case "glob":
        return await toolGlob(
          ctx,
          str(args.pattern),
          str(args.file_path).trim() || ".",
          num(args.max_results ?? args.maxResults, 100),
        );
      case "grep":
        return await toolGrep(
          ctx,
          str(args.pattern),
          str(args.file_path).trim() || ".",
          num(args.max_results ?? args.maxResults, 40),
          {
            glob: args.glob === undefined ? undefined : str(args.glob),
            type: args.type === undefined ? undefined : str(args.type),
            outputMode: args.output_mode === undefined ? undefined : str(args.output_mode) as "content" | "files_with_matches" | "count",
            beforeContext: num(args.before_context, 0),
            afterContext: num(args.after_context, 0),
            context: num(args.context, 0),
            showLineNumbers: args.show_line_numbers === undefined ? undefined : bool(args.show_line_numbers),
            onlyMatching: args.only_matching === undefined ? undefined : bool(args.only_matching),
            ignoreCase: args.ignore_case === undefined ? undefined : bool(args.ignore_case),
            headLimit: args.head_limit === undefined ? undefined : num(args.head_limit, 0),
            offset: args.offset === undefined ? undefined : num(args.offset, 0),
            multiline: args.multiline === undefined ? undefined : bool(args.multiline),
          },
        );
      case "graph_search":
        return await toolGraphSearch(ctx, str(args.query), num(args.depth, 1));
      case "search_code":
      case "search_symbols":
        return await toolSearchSymbols(ctx, str(args.query || args.pattern), num(args.limit, 20));
      case "search_semantic":
        return await toolSearchSemantic(ctx, str(args.query), num(args.limit, 20));
      case "repo_map":
        return await toolRepoMap(ctx, str(args.hint ?? ""));
      // Truncated payloads for these are rejected before dispatch — see the
      // `args._truncated` guard at the top of runTool().
      case "apply_patch":
        return await toolPatch(
          ctx,
          str(args.file_path),
          str(args.patch),
          str(args.old_string),
          str(args.new_string),
          bool(args.replace_all),
        );
      case "write_file":
        return await toolWrite(ctx, str(args.file_path), str(args.content), bool(args.allow_shrink));
      case "append_file":
        return await toolAppend(ctx, str(args.file_path), str(args.content));
      case "bash":
        return await toolBash(ctx, str(args.command));
      case "dispatch_agent": {
        const agentType = str(args.agent_type ?? "Explore");
        const task = str(args.task ?? args.prompt ?? "");
        if (!task) {
          return fail("dispatch_agent 参数错误：必须提供非空字符串 task，描述要子智能体完成的调研问题。");
        }
        if (!ctx.dispatchSubagent) {
          return fail("dispatch_agent 当前不可用：宿主未提供子智能体运行环境。");
        }
        const thoroughness = str(args.thoroughness ?? "medium");
        if (agentType !== "Explore") {
          return fail(`dispatch_agent 暂不支持 agent_type="${agentType}"，目前只支持 "Explore"（只读代码调研）。`);
        }
        const report = await ctx.dispatchSubagent({ agentType, task, thoroughness });
        return ok(report);
      }
      case "add_tasks":
        return await toolAddTasks(ctx, args);
      case "update_tasks":
        // 闭包由顺序路径（react.ts）或任务图调度器注入，并统一负责原子校验。
        return await toolUpdateTasks(ctx, args);
      case "project_deps":
        return await toolProjectDeps(ctx);
      case "recall_history":
        return await toolRecallHistory(ctx, historyRecallQuery(args), historyRecallBeforeTurn(args));
      case "save_experience":
        return await toolSaveExperience(
          ctx,
          str(args.symptom),
          str(args.rootCause),
          str(args.fix),
          Array.isArray(args.files) ? (args.files as string[]) : [],
          Array.isArray(args.tags) ? (args.tags as string[]) : [],
        );
      case "save_spec":
        if (args.content == null)
          return fail(
            "save_spec: `content` field is missing from the tool call arguments — " +
              "the JSON parser could not recover it (likely a malformed LLM response). " +
              "Please retry and ensure the full spec markdown is provided in the `content` parameter.",
          );
        return await toolSaveSpec(ctx, str(args.feature), str(args.content));
      case "save_design":
        if (args.content == null)
          return fail(
            "save_design: `content` field is missing from the tool call arguments — " +
              "the JSON parser could not recover it. Please retry with the full design markdown in `content`.",
          );
        return await toolSaveDesign(ctx, str(args.feature), str(args.content));
      case "save_tasks":
        if (args.content == null)
          return fail(
            "save_tasks: `content` field is missing from the tool call arguments — " +
              "the JSON parser could not recover it. Please retry with the full tasks markdown in `content`.",
          );
        return await toolSaveTasks(ctx, str(args.feature), str(args.content));
      case "list_sdd":
      case "list_specs":
        return await toolListSpecs(ctx, args.feature ? str(args.feature) : undefined);
      case "analyze_issue":
        return await toolAnalyzeIssue(ctx, str(args.description));

      // ── LSP tools ──
      case "lsp_diagnostics":
        return await toolLspDiagnostics(ctx, str(args.filePath ?? ""));

      // ── Verification tools ──
      case "type_check":
        return await toolTypeCheck(ctx);

      // ── NEW: Semantic diff ──
      case "semantic_diff":
        return await toolSemanticDiff(ctx, str(args.filePath), str(args.against ?? "HEAD"));

      // ── Handoff: end the turn and return control to the user ──
      case "report_blocker":
        return await toolReportBlocker(
          ctx,
          str(args.reason ?? ""),
          str(args.summary ?? ""),
          str(args.userAction ?? ""),
          str(args.completed ?? ""),
        );

      // ── Ask the user a blocking question (options or free text) ──
      case "ask_user": {
        const rawOpts = (args.options as Array<{ label?: string; value?: string; description?: string }> | undefined) ?? [];
        const options = rawOpts
          .map((o) => ({ label: str(o?.label ?? ""), value: str(o?.value ?? ""), description: o?.description ? str(o.description) : undefined }))
          .filter((o) => o.label && o.value);
        return await toolAskUser(ctx, str(args.question ?? ""), options, bool(args.allowFreeText), str(args.placeholder ?? ""));
      }

      // ── NEW: Web search ──
      case "web_search":
        return await toolWebSearch(ctx, str(args.query), num(args.maxResults, 5), str(args.language ?? ""));

      // ── NEW: Fetch URL content ──
      case "web_fetch":
        return await toolWebFetch(ctx, str(args.url), num(args.maxChars, 50_000));

      // ── NEW: User memories ──
      case "save_memory":
        return await toolSaveMemory(
          ctx,
          str(args.title),
          str(args.content),
          str(args.category ?? "general"),
          Array.isArray(args.keywords) ? args.keywords : [],
          str(args.scope ?? "global"),
        );
      case "update_memory":
        return await toolUpdateMemory(
          ctx,
          str(args.id),
          args.title !== undefined ? str(args.title) : undefined,
          args.content !== undefined ? str(args.content) : undefined,
          args.category !== undefined ? str(args.category) : undefined,
          Array.isArray(args.keywords) ? args.keywords : undefined,
          str(args.scope ?? "global"),
        );
      case "forget_memory":
        return await toolForgetMemory(ctx, str(args.id), str(args.scope ?? "global"));
      case "list_memories":
        return await toolListMemories(ctx, args.scope ? str(args.scope) : undefined);

      // ── Session pending changes (UI Changes bar parity) ──
      case "list_session_changes":
        return await toolListSessionChanges(ctx);
      case "undo_session_change":
        return await toolUndoSessionChange(ctx, str(args.file_path));

      // ── Skills ──
      case "use_skill": {
        if (typeof args.skill !== "string" || !args.skill.trim()) {
          return fail('use_skill 参数错误：必须提供非空字符串 skill，例如 {"skill":"code-review"}；参数名是 skill。');
        }
        const skillArgs = typeof args.args === "string" ? args.args : "";
        return await toolUseSkill(ctx, args.skill, skillArgs);
      }

      // ── 沙箱脚本（Think-in-Code）：模型写 JS 编排只读工具 + bash，只有 console 输出进对话 ──
      case "run_script": {
        if (typeof args.code !== "string" || !args.code.trim()) {
          return fail('run_script 参数错误：必须提供非空字符串 code，例如 {"code":"const r = await tools.call(\\"read_file\\", {file_path:\\"src/x.ts\\"}); console.log(r.output.split(\\"\\\\n\\").length + \\" lines\\")"}；参数名是 code。');
        }
        return await toolRunScript(ctx, args.code, {
          timeoutMs: args.timeout_ms === undefined ? undefined : num(args.timeout_ms, 120_000),
          intent: typeof args.intent === "string" ? args.intent : undefined,
        });
      }

      // ── MCP tools ──
      default:
        if (name.startsWith("mcp__") && ctx.mcp) {
          try {
            if (mcpToolNeedsConfirmation(name)) {
              if (!ctx.workflow.modes.agent.dangerousBashConfirm || !ctx.confirmDangerousBash) {
                return fail(
                  `Blocked potentially mutating MCP tool (no confirmation path: dangerousBashConfirm off or confirmer not wired): ${name}`,
                );
              }
              const allowed = await ctx.confirmDangerousBash(`MCP tool: ${name}\nArguments: ${JSON.stringify(args)}`);
              if (!allowed) return fail(`MCP tool denied by user: ${name}`);
            }
            const out = await ctx.mcp.call(name, args as Record<string, unknown>);
            // MCP 原始输出在统一出口脱敏；不在工具执行阶段裁剪。
            return ok(out);
          } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            writeEventLog({
              category: "tool_error",
              message: `MCP 工具 ${name} 调用失败: ${err}`,
              details: {
                sessionId: ctx.sessionId,
                tool: name,
                args,
                error: err,
              },
            });
            return fail(err);
          }
        }
        return fail(
          `Unknown tool: ${name}. Use built-in tools or configured MCP tools (mcp__server__tool).`,
        );
    }
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    writeEventLog({
      category: "tool_error",
      message: `工具 dispatch 抛出未捕获异常: ${err}`,
      details: {
        sessionId: ctx.sessionId,
        tool: name,
        args,
        error: err,
        stack: e instanceof Error ? e.stack : undefined,
      },
    });
    return fail(err);
  }
}
