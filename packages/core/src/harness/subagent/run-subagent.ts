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
import {
  buildPlannerSubagentPrompt,
  PLANNER_SUBAGENT_ALLOWED_TOOLS,
  PLANNER_SUBAGENT_TYPE,
} from "./planner-subagent.ts";
import { queryIndexNavigation, renderNavigationBlock } from "../index-navigation.ts";
import { isRedactionEnabled, redactPromptSecrets } from "../redact.ts";

export interface DispatchSubagentRequest {
  /** 支持 "Explore"（通用只读调研）与 "Planner"（任务分解阶段计划子代理）；其他值由调用方提前拒绝。 */
  agentType: string;
  /** 派给子智能体的具体调研问题，原样作为它的 user 消息。 */
  task: string;
  /** 搜索广度："medium"（默认）或 "very thorough"。 */
  thoroughness?: string;
  /** 任务分解阶段提取的背景证据；仅注入提示词，不作为子代理指令。 */
  relevantHistory?: string;
  /**
   * 续接：由父循环（loop.ts 的 dispatchSubagent 闭包）解析 continueAgentId 后
   * 注入的既有子代理消息转录。携带时跳过系统提示/导航块构建与历史注入，
   * userMessage 作为新 user 消息追加到转录末尾——子代理读过的内容全部保留。
   */
  initialMessages?: import("@owncoder/llm").ChatMessage[];
  /** 父循环解析的续接 id；runExploreSubagent 自身不解析，仅原样透传给 loop。 */
  continueAgentId?: string;
}

/** 子代理一次运行的完整产出：报告文本 + 可注册为续接线程的消息转录。 */
export interface SubagentRunResult {
  report: string;
  /** 本轮结束时的 LLM 消息转录；无 agentMessages 的旧调用方为 undefined。 */
  transcript?: import("@owncoder/llm").ChatMessage[];
}

/** 续接解析结果：拒绝（带原因串）/ 续接（带种子转录）/ 全新派发。 */
export type ContinuationResolution =
  | { kind: "refused"; message: string }
  | { kind: "continue"; initialMessages: import("@owncoder/llm").ChatMessage[] }
  | { kind: "fresh" };

/**
 * 解析 dispatch_agent 的 continueAgentId：仅 Explore 可续接（Planner 结构性
 * 一次性）；未知 id 拒绝而不是静默新起——父智能体必须明确看到续接失败。
 * 纯函数，由 loop.ts 的 dispatcher 传入当前轮次线程表调用。
 */
export function resolveContinuation(
  request: { continueAgentId?: string; agentType: string },
  threads: Map<string, import("@owncoder/llm").ChatMessage[]>,
): ContinuationResolution {
  if (!request.continueAgentId) return { kind: "fresh" };
  if (request.agentType !== EXPLORE_SUBAGENT_TYPE) {
    return {
      kind: "refused",
      message: `[Explore continuation refused: continueAgentId is only supported for "Explore", not "${request.agentType}"; dispatch a fresh agent without it.]`,
    };
  }
  const thread = threads.get(request.continueAgentId);
  if (!thread) {
    return {
      kind: "refused",
      message: `[Explore continuation refused: unknown continueAgentId "${request.continueAgentId}" (threads live for one parent turn); dispatch a fresh agent without it.]`,
    };
  }
  return { kind: "continue", initialMessages: thread };
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
/**
 * Planner 的小预算（结构性收口之后不再需要大迭代数）：
 * dispatch_agent 的任务描述已携带"已知锚点"，调研只补齐未知点；
 * submit_plan 让计划一次调用直达终态，收尾区提示 + 契约强制总结兜底。
 * 100 次的旧预算只会在"模型永不自发停止"的失败模式上烧满 token 后
 * 以 partial result 判死刑——预算大小不解决收口，机制才解决。
 */
const PLANNER_MAX_ITERATIONS = 25;

/** 转发给父回合的事件：工具执行流（用于状态展示）与 warning/error。 */
const FORWARDED_EVENT_TYPES = new Set(["tool_start", "tool_end", "warning", "error"]);
/** 镜像工具事件 id 前缀，避免与父循环自己的工具调用 id 冲突。 */
const SUBAGENT_TOOL_ID_PREFIX = "subagent-tool";
/**
 * stageId 单调序号：dispatch_agent 是并行安全工具，一批可并发多个子循环；
 * 只用 Date.now() 时同一毫秒并发派发会生成相同 stageId，导致
 * stage_start/stage_done 配对错乱与转发工具事件 id 冲突。
 */
let subagentStageSeq = 0;

/**
 * 运行一个 Explore 子智能体并返回它的最终结论文本与消息转录。
 * 通过依赖注入 runAgentLoop，避免 subagent → loop 的静态导入环。
 */
export async function runExploreSubagent(
  request: DispatchSubagentRequest,
  deps: DispatchSubagentDeps,
): Promise<SubagentRunResult> {
  const { runAgentLoop } = await import("../loop.ts");
  const isPlanner = request.agentType === PLANNER_SUBAGENT_TYPE;
  if (deps.budget) {
    const reservation = deps.budget.charge("subagents");
    if (!reservation.ok) {
      // Planner 的产出要过计划结构校验；占位报告会让父级报出
      // “缺少全部章节”的误导性错误。改用 partial-result 前缀，
      // 让父级直接以“未完成计划”的明确原因暂停。
      const reason = reservation.reason ?? "subagent budget exhausted";
      return {
        report: isPlanner
          ? `[Planner partial result: ${reason}; no plan was produced]`
          : `## Final Report\n\nExplore suppressed: ${reason}.`,
      };
    }
  }
  const thoroughness = request.thoroughness === "very thorough" ? "very thorough" : "medium";
  const maxIterations = isPlanner
    ? PLANNER_MAX_ITERATIONS
    : thoroughness === "very thorough"
      ? EXPLORE_VERY_THOROUGH_MAX_ITERATIONS
      : EXPLORE_MEDIUM_MAX_ITERATIONS;

  // start/done 共用同一个 id，保证阶段条能正确配对收口。
  // 追加单调序号：并行派发（同一批多个 dispatch_agent）即使落在同一毫秒
  // 也不会生成相同 id。
  const stageId = `subagent-${isPlanner ? "planner" : "explore"}-${Date.now()}-${++subagentStageSeq}`;

  const env: ExplorePromptEnv = {
    workingDirectory: deps.workspaceRoot,
    isGitRepository: await isGitRepo(deps.workspaceRoot).catch(() => undefined),
    platform: process.platform,
  };

  // 续接（initialMessages）：跳过系统提示与导航块构建——转录头部已含系统提示，
  // 续接的追问不重复冷启动检索；userMessage 由 loop 追加到转录末尾。
  const isContinuation = Boolean(request.initialMessages);
  const navBlock = isContinuation ? "" : await queryIndexNavigation(deps.index, request.task).then((navHits) =>
    navHits?.length
      ? "\n\n" + renderNavigationBlock(
          "Starting points from the index — go straight to the named file and range",
          navHits,
        )
      : "");

  const userMessage = request.task;
  const basePrompt = isPlanner
    ? buildPlannerSubagentPrompt(env, request.relevantHistory)
    : buildExploreSubagentPrompt(thoroughness, env, request.relevantHistory);
  const systemPromptOverride = isContinuation ? undefined : basePrompt + navBlock;
  const redact = (text: string) => isRedactionEnabled(deps.workflow)
    ? redactPromptSecrets(text, deps.workflow.secrets?.patterns)
    : text;
  deps.onEvent?.({
    type: "stage_start",
    id: stageId,
    nodeType: "subagent",
    label: `${isPlanner ? "Planner" : "Explore"}: ${redact(userMessage).slice(0, 60)}`,
    ...(isPlanner ? { subagentInput: { userMessage: redact(userMessage), systemPromptOverride: redact(systemPromptOverride ?? ""), thoroughness } } : {}),
  });

  let plannerSucceeded = false;
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
      userMessage,
      signal: deps.signal,
      llmApiKey: deps.llmApiKey ?? null,
      renderPage: deps.renderPage,
      confirmDangerousBash: deps.confirmDangerousBash,
      autoApproveDangerousBash: deps.autoApproveDangerousBash,
      maxIterations,
      // 机制层只读沙箱：白名单之外的工具全部不可用。
      allowedTools: [...(isPlanner ? PLANNER_SUBAGENT_ALLOWED_TOOLS : EXPLORE_SUBAGENT_ALLOWED_TOOLS)],
      readOnly: true,
      systemPromptOverride,
      // 续接种子：预置转录替代从零构建消息；userMessage 追加到转录末尾，
      // scheduler 的历史注入由 userMessageInjected 初值置位跳过。
      ...(request.initialMessages ? { initialMessages: request.initialMessages } : {}),
      // 预算耗尽时追加一次无工具强制总结，保证父智能体拿到已收集的发现。
      forcedFinalReportOnLimit: true,
      budget: deps.budget,
      // 子代理结构性收口：注册对应提交工具（Planner→submit_plan /
      // Explore→submit_report）、子代理版预算提示、报告契约的强制总结。
      // 主循环两者皆不设置，永远看不到提交工具。
      ...(isPlanner
        ? { plannerLoop: true as const }
        : { exploreLoop: true as const }),
      // 跳过 context_gather / task_decompose / verify / present_changes，
      // 只跑工具循环并产出纯文本报告。
      leanPipeline: true,
      // 转发工具执行流与 warning/error；工具事件打上子智能体来源、改写
      // id 避免与父循环冲突，其余事件（delta/气泡）不污染主 UI。
      onEvent: (ev: TurnEventInput) => {
        if (!FORWARDED_EVENT_TYPES.has(ev.type)) return;
        if (ev.type === "tool_start" || ev.type === "tool_end") {
          const provenance: SubagentProvenance = {
            agentType: isPlanner ? PLANNER_SUBAGENT_TYPE : EXPLORE_SUBAGENT_TYPE,
            id: stageId,
            task: redact(userMessage).slice(0, 80),
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
      // 空报告时优先透传子循环的真实失败原因（如 LLM HTTP 429 配额耗尽），
      // 而不是一句无信息量的占位语——用户此前只能看到"未产出报告"，
      // 无法定位是配额/网络问题还是模型行为问题。
      const failureReason = result.blockedReason?.trim();
      return {
        report: isPlanner
          ? `[Planner partial result: ${failureReason ?? "subagent finished without producing a report"}]`
          : `## Final Report\n\nExplore subagent finished without producing a report${failureReason ? ` (${failureReason})` : ""}.`,
      };
    }
    plannerSucceeded =
      !result.blocked && result.aborted !== true && !report.startsWith("[Planner partial result");
    // 硬限制终态：显式标注为部分结果，让父智能体知道发现可能不完整，
    // 而不是把它误当成完整结论。
    // aborted 同样标注：工具循环检测（no-progress）与用户/LLM 中断原本
    // 不带 blocked，会被误当成完整报告交付（过渡文本 + 无 partial 标注的
    // 假成功）——这里统一按未完成处理。
    if (result.blocked || result.aborted === true) {
      const reason = result.blockedReason?.trim()
        ?? (result.aborted ? "loop terminated early" : "reached the iteration limit");
      const notice = `[${isPlanner ? "Planner" : "Explore"} partial result: ${reason}; findings below may be incomplete]`;
      const raw = report.startsWith("[Explore partial result") || report.startsWith("[Planner partial result")
        ? report
        : `${notice}\n\n${report.startsWith("## Final Report") ? report : `## Final Report\n\n${report}`}`;
      return { report: raw, transcript: result.agentMessages };
    }
    // Ensure the report starts with a Final Report heading so the parent LLM
    // knows this is the complete exploration output to use directly for the next step.
    return {
      report: report.startsWith("## Final Report") ? report : `## Final Report\n\n${report}`,
      transcript: result.agentMessages,
    };
  } finally {
    deps.onEvent?.({
      type: "stage_done",
      id: stageId,
      nodeType: "subagent",
      label: `${isPlanner ? "Planner" : "Explore"} finished`,
      ...(isPlanner ? { ok: plannerSucceeded } : {}),
    });
  }
}

export { EXPLORE_SUBAGENT_TYPE, PLANNER_SUBAGENT_TYPE };
