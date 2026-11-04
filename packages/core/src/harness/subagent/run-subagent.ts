/**
 * 子智能体调度。
 *
 * 父智能体通过 dispatch_agent 工具把一个只读调研任务派发给 Explore 子
 * 智能体。子智能体在独立的 runAgentLoop 里运行：独立的 system prompt、
 * 空历史、白名单沙箱（仅只读工具）。它在探索中产生的 grep 命中和整
 * 文件内容只存在于它自己的上下文，父智能体只收到最终结论文本——从
 * 架构上消除探索噪声对主上下文的污染。
 *
 * 子循环与父循环共享 workspace、索引、codemap 和中止信号；不共享
 * history、memory、checkpoint 和 MCP，保证子调研无副作用。
 */
import type { IndexClient } from "@owncoder/index";
import type { SystemWorkflowConfig } from "@owncoder/settings";
import type { AgentMode } from "@owncoder/shared";
import type { ToolContext } from "../execute.ts";
import type { SubagentProvenance, TurnEventInput } from "../loop/types.ts";
import { isGitRepo } from "../../git.ts";
import {
  buildExploreSubagentPrompt,
  type ExplorePromptEnv,
  EXPLORE_SUBAGENT_ALLOWED_TOOLS,
  EXPLORE_SUBAGENT_TYPE,
} from "./explore-subagent.ts";
import { queryIndexNavigation, renderNavigationBlock } from "../index-navigation.ts";

export interface DispatchSubagentRequest {
  /** 目前只支持 "Explore"；其他值由调用方提前拒绝。 */
  agentType: string;
  /** 派给子智能体的具体调研问题，原样作为它的 user 消息。 */
  task: string;
  /** 搜索广度："medium"（默认）或 "very thorough"。 */
  thoroughness?: string;
}

export interface DispatchSubagentDeps {
  workspaceRoot: string;
  sessionId: string;
  workflow: SystemWorkflowConfig;
  mode: AgentMode;
  index: IndexClient;
  codemap?: ToolContext["codemap"];
  llmApiKey?: string | null;
  signal?: AbortSignal;
  renderPage?: ToolContext["renderPage"];
  /** 危险 bash 命令确认回调；缺失时子循环内危险命令会被硬拦截且无法弹窗确认。 */
  confirmDangerousBash?: (command: string) => Promise<boolean>;
  /** Auto-approve dangerous bash commands (settings modes.agent.autoApproveBash). */
  autoApproveDangerousBash?: boolean;
  onEvent?: (ev: TurnEventInput) => void;
  /** Parent request ledger shared by this isolated child loop. */
  budget?: import("../budget-ledger.ts").BudgetLedger;
}

/**
 * 迭代预算按搜索广度分级。预算只统计模型往返：纯工具调用轮同样计数，
 * 因此这里要为"最后写报告"留出余量。very thorough 需要更多搜索轮次。
 */
const EXPLORE_MEDIUM_MAX_ITERATIONS = 40;
const EXPLORE_VERY_THOROUGH_MAX_ITERATIONS = 70;

/** 转发给父回合的事件：工具执行流（用于状态展示）与 warning/error。 */
const FORWARDED_EVENT_TYPES = new Set(["tool_start", "tool_end", "warning", "error"]);
/** 镜像工具事件 id 前缀，避免与父循环自己的工具调用 id 冲突。 */
const SUBAGENT_TOOL_ID_PREFIX = "subagent-tool";

/**
 * 运行一个 Explore 子智能体并返回它的最终结论文本。
 * 通过依赖注入 runAgentLoop，避免 subagent → loop 的静态导入环。
 */
export async function runExploreSubagent(
  request: DispatchSubagentRequest,
  deps: DispatchSubagentDeps,
): Promise<string> {
  const { runAgentLoop } = await import("../loop.ts");
  if (deps.budget) {
    const reservation = deps.budget.charge("subagents");
    if (!reservation.ok) return `## Final Report\n\nExplore suppressed: ${reservation.reason ?? "subagent budget exhausted"}.`;
  }
  const thoroughness = request.thoroughness === "very thorough" ? "very thorough" : "medium";
  const maxIterations =
    thoroughness === "very thorough"
      ? EXPLORE_VERY_THOROUGH_MAX_ITERATIONS
      : EXPLORE_MEDIUM_MAX_ITERATIONS;

  // start/done 共用同一个 id，保证阶段条能正确配对收口。
  const stageId = `subagent-explore-${Date.now()}`;

  const env: ExplorePromptEnv = {
    workingDirectory: deps.workspaceRoot,
    isGitRepository: await isGitRepo(deps.workspaceRoot).catch(() => undefined),
    platform: process.platform,
  };

  deps.onEvent?.({
    type: "stage_start",
    id: stageId,
    nodeType: "subagent",
    label: `Explore: ${request.task.slice(0, 60)}`,
  });

  // 检索优先的探索起点（Cursor 式 auto-context）：任务文本 → 索引符号
  // 召回 → 引导块拼进子代理 system prompt，替掉"冷启动先 grep 找入口"的
  // 头几轮。best-effort——索引不可用 / 空结果时 prompt 与现状逐字一致。
  // 注意：标题只标明"导航指针"，不强令"先 read_file 再依赖"——那会把
  // 每个召回文件变成一次强制重读，与"按需读"的纪律互相抵消。
  const navHits = await queryIndexNavigation(deps.index, request.task);
  const navBlock = navHits?.length
    ? "\n\n" + renderNavigationBlock(
        "Starting points from the index — go straight to the named file and range",
        navHits,
      )
    : "";

  try {
    const result = await runAgentLoop({
      mode: deps.mode === "spec" ? "spec" : "agent",
      workspaceRoot: deps.workspaceRoot,
      sessionId: deps.sessionId,
      workflow: deps.workflow,
      index: deps.index,
      codemap: deps.codemap,
      // 隔离的关键：空历史 + 不注入父级计划/任务/记忆。
      history: [],
      userMessage: request.task,
      signal: deps.signal,
      llmApiKey: deps.llmApiKey ?? null,
      renderPage: deps.renderPage,
      confirmDangerousBash: deps.confirmDangerousBash,
      autoApproveDangerousBash: deps.autoApproveDangerousBash,
      maxIterations,
      // 机制层只读沙箱：白名单之外的工具全部不可用。
      allowedTools: [...EXPLORE_SUBAGENT_ALLOWED_TOOLS],
      readOnly: true,
      systemPromptOverride: buildExploreSubagentPrompt(thoroughness, env) + navBlock,
      // 预算耗尽时追加一次无工具强制总结，保证父智能体拿到已收集的发现。
      forcedFinalReportOnLimit: true,
      budget: deps.budget,
      // 跳过 context_gather / task_decompose / verify / present_changes，
      // 只跑工具循环并产出纯文本报告。
      leanPipeline: true,
      // 转发工具执行流与 warning/error；工具事件打上子智能体来源、改写
      // id 避免与父循环冲突，其余事件（delta/气泡）不污染主 UI。
      onEvent: (ev: TurnEventInput) => {
        if (!FORWARDED_EVENT_TYPES.has(ev.type)) return;
        if (ev.type === "tool_start" || ev.type === "tool_end") {
          const provenance: SubagentProvenance = {
            agentType: EXPLORE_SUBAGENT_TYPE,
            id: stageId,
            task: request.task.slice(0, 80),
          };
          ev = {
            ...ev,
            id: `${SUBAGENT_TOOL_ID_PREFIX}-${stageId}-${ev.id}`,
            subagent: provenance,
          };
        }
        deps.onEvent?.(ev);
      },
    });

    const report = result.assistantText?.trim();
    if (!report) {
      return "## Final Report\n\nExplore subagent finished without producing a report.";
    }
    // 硬限制终态：显式标注为部分结果，让父智能体知道发现可能不完整，
    // 而不是把它误当成完整结论。
    if (result.blocked) {
      const notice = `[Explore partial result: ${result.blockedReason ?? "reached the iteration limit"}; findings below may be incomplete]`;
      const wrappedReport = report.startsWith("## Final Report") ? report : `## Final Report\n\n${report}`;
      return report.startsWith("[Explore partial result") ? report : `${notice}\n\n${wrappedReport}`;
    }
    // Ensure the report starts with a Final Report heading so the parent LLM
    // knows this is the complete exploration output to use directly for the next step.
    if (!report.startsWith("## Final Report")) {
      return `## Final Report\n\n${report}`;
    }
    return report;
  } finally {
    deps.onEvent?.({
      type: "stage_done",
      id: stageId,
      nodeType: "subagent",
      label: "Explore finished",
    });
  }
}

export { EXPLORE_SUBAGENT_TYPE };
