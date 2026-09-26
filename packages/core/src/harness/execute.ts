import { type ParsedToolCall } from "./parser.ts";
import type { ToolContext, ToolResult } from "./tools/types.ts";
import { redactSecrets, isRedactionEnabled } from "./redact.ts";
import { bool, cap, fail, num, ok, str } from "./tools/shared.ts";
import { statusEntry } from "./tools/shared.ts";
import type { TerminalEntry } from "./terminal.ts";
import { writeEventLog } from "@owncoder/llm";
import {
  toolBash,
  toolGitStatus,
  toolGrep,
  toolList,
  toolPatch,
  toolRead,
  toolReadSymbol,
  toolReadOutline,
  READ_FILE_OUTPUT_BUDGET,
  toolRepoMap,
  toolSaveExperience,
  toolSavePlan,
  toolSaveSpec,
  toolSaveDesign,
  toolListSdd,
  toolAnalyzeIssue,
  toolGraphSearch,
  toolSearchSymbols,
  toolWrite,
  toolAppend,
  toolProjectDeps,
} from "./tools/fs.ts";
import { toolCodemapImpact, toolCodemapSearch } from "./tools/codemap.ts";
import {
  toolLspAction,
  toolLspDiagnostics,
  toolLspDocSymbols,
  toolLspWorkspaceSymbols,
} from "./tools/lsp.ts";
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
import {
  historyRecallBeforeTurn,
  historyRecallQuery,
  toolRecallHistory,
  toolRecallHistoryBefore,
  toolRecallHistoryForTaskDecompose,
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

function modelOutputLimit(ctx: ToolContext, toolName: string): number {
  if (["bash", "type_check", "lsp_diagnostics"].includes(toolName)) {
    return ctx.bashMaxChars;
  }
  // read_file returns whole files by design (see toolRead); keep the egress cap
  // in sync with its render budget so the promised line range isn't re-cut.
  if (toolName === "read_outline") {
    return Number.MAX_SAFE_INTEGER;
  }
  if (toolName === "read_file" || toolName === "read_symbol") {
    return Math.max(ctx.maxOutputChars, READ_FILE_OUTPUT_BUDGET);
  }
  return ctx.maxOutputChars;
}

export async function executeTool(ctx: ToolContext, call: ParsedToolCall): Promise<ToolResult> {
  if (ctx.signal?.aborted) return fail("操作已停止");

  const name = call.name;
  const args = call.arguments;

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
          output: cap(
            redactToolOutput(ctx, rawResult.output),
            modelOutputLimit(ctx, name),
          ),
        };
    // Final egress guard: every built-in and MCP result is redacted and then
    // capped before it can be appended to model context. Tool-specific paths
    // may already redact earlier; this second pass is intentionally idempotent.
    /* result is already normalized above */
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
    case "save_plan":
    case "save_spec":
    case "save_design":
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
  if (args._truncated) {
    return fail(truncatedPayloadMessage(name));
  }

  try {
    switch (name) {
      // ── Original tools ──
      case "read_file":
        // By default returns the entire file. When offset/limit are provided
        // (continuation of a truncated read), returns only the requested window.
        return await toolRead(ctx, str(args.path), num(args.offset, 0), num(args.limit, 0));
      case "read_symbol":
        return await toolReadSymbol(ctx, str(args.path), str(args.symbol), num(args.padding, 12));
      case "read_outline":
        return await toolReadOutline(ctx, str(args.path));
      case "list_dir":
        return await toolList(ctx, str(args.path ?? "."), bool(args.recursive));
      case "grep":
        return await toolGrep(
          ctx,
          str(args.pattern),
          str(args.path ?? "."),
          num(args.maxResults, 40),
        );
      case "graph_search":
        return await toolGraphSearch(ctx, str(args.query), num(args.depth, 2));
      case "search_code":
      case "search_symbols":
        return await toolSearchSymbols(
          ctx,
          str(args.query || args.pattern),
          num(args.limit, 20),
        );
      case "codemap_search":
        return await toolCodemapSearch(ctx, str(args.query), num(args.limit, 12));
      case "codemap_impact":
        return await toolCodemapImpact(ctx, str(args.nodeId), num(args.depth, 3));
      case "repo_map":
        return await toolRepoMap(ctx, str(args.hint ?? ""));
      case "save_plan":
        return await toolSavePlan(ctx, str(args.content), str(args.title ?? ""), str(args.filename ?? ""));
      // Truncated payloads for these are rejected before dispatch — see the
      // `args._truncated` guard at the top of runTool().
      case "apply_patch":
        return await toolPatch(ctx, str(args.path), str(args.patch));
      case "write_file":
        return await toolWrite(ctx, str(args.path), str(args.content), bool(args.allow_shrink));
      case "append_file":
        return await toolAppend(ctx, str(args.path), str(args.content));
      case "bash":
        return await toolBash(ctx, str(args.command));
      case "git_status":
        return await toolGitStatus(ctx);
      case "project_deps":
        return await toolProjectDeps(ctx);
      case "recall_history":
        return await toolRecallHistory(ctx, historyRecallQuery(args));
      case "recall_history_before":
        return await toolRecallHistoryBefore(ctx, historyRecallQuery(args), historyRecallBeforeTurn(args));
      case "recall_history_for_task_decompose":
        return await toolRecallHistoryForTaskDecompose(ctx, historyRecallQuery(args), historyRecallBeforeTurn(args) ?? 0);
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
      case "list_sdd":
        return await toolListSdd(ctx, args.feature ? str(args.feature) : undefined);
      case "analyze_issue":
        return await toolAnalyzeIssue(ctx, str(args.description));

      // ── NEW: LSP tools ──
      case "lsp_go_to_definition":
        return await toolLspAction(ctx, "goToDefinition", str(args.filePath), num(args.line, 1), num(args.column, 1));
      case "lsp_find_references":
        return await toolLspAction(ctx, "findReferences", str(args.filePath), num(args.line, 1), num(args.column, 1));
      case "lsp_hover":
        return await toolLspAction(ctx, "hover", str(args.filePath), num(args.line, 1), num(args.column, 1));
      case "lsp_document_symbols":
        return await toolLspDocSymbols(ctx, str(args.filePath));
      case "lsp_workspace_symbols":
        return await toolLspWorkspaceSymbols(ctx, str(args.query));
      case "lsp_diagnostics":
        return await toolLspDiagnostics(ctx, str(args.filePath ?? ""));
      case "lsp_code_actions":
        return await toolLspAction(ctx, "codeActions", str(args.filePath), num(args.line, 1), num(args.column, 1));

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
        return await toolUndoSessionChange(ctx, str(args.path));

      // ── MCP tools ──
      default:
        if (name.startsWith("mcp__") && ctx.mcp) {
          try {
            if (mcpToolNeedsConfirmation(name)) {
              if (!ctx.workflow.modes.agent.dangerousBashConfirm || !ctx.confirmDangerousBash) {
                return fail(`Blocked potentially mutating MCP tool: ${name}`);
              }
              const allowed = await ctx.confirmDangerousBash(`MCP tool: ${name}\nArguments: ${JSON.stringify(args)}`);
              if (!allowed) return fail(`MCP tool denied by user: ${name}`);
            }
            const out = await ctx.mcp.call(name, args as Record<string, unknown>);
            return ok(cap(redactToolOutput(ctx, out), ctx.maxOutputChars));
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
