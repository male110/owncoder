/**
 * Pure IPC chat-event applicator (single source of truth for chat:event apply).
 * Kept free of React so IPC subscription / streaming updates can be
 * integration-tested without mounting the hook.
 *
 * useChatEvents is a thin subscriber that delegates here.
 */
import { isVerificationGateError, toAppError } from "../components/ErrorBanner";
import {
  upsertThinkingFn,
  sealThinkingFn,
  sealTextFn,
  pushToolFn,
  updateToolFn,
  ensureSubagentGroupFn,
  pushSubagentToolFn,
  updateSubagentToolFn,
  setSubagentGroupStatusFn,
  upsertTextFn,
  type useChatStore,
} from "../store/chat-store";
import type { useSessionStore } from "../store/session-store";
import type { ChatEventDto } from "../../../preload/index";
import { t } from "../../../shared/i18n/core";

type ChatStore = ReturnType<typeof useChatStore.getState>;
type SessionStore = ReturnType<typeof useSessionStore.getState>;

/** Returns a label for the live-status line during tool execution. */
export function toolStatusLabel(
  status: "running" | "done" | "error" | "skipped",
  name: string,
  args?: Record<string, unknown>,
): string {
  if (status === "running") {
    const hint =
      name === "read_file" || name === "read_symbol" || name === "write_file" || name === "apply_patch"
        ? ` → ${String(args?.path ?? args?.file ?? "")}`
        : name === "bash" || name === "run_command"
          ? ` → ${String(args?.command ?? "").slice(0, 60)}`
          : name === "search_code" || name === "search_symbols"
            ? ` → ${String(args?.pattern ?? args?.query ?? "")}${args?.glob ? ` in ${String(args.glob)}` : ""}`
            : "";
    return t("工具调用：{{name}}{{hint}}", { name, hint });
  }
  if (status === "done") return t("已完成：{{name}}", { name });
  if (status === "skipped") return t("已跳过：{{name}}", { name });
  return t("失败：{{name}}", { name });
}

function isDecomposing(chat: ChatStore, sid: string | undefined): boolean {
  // Prefer the target session runtime so multi-session apply stays correct.
  if (sid && sid !== chat.activeSessionId) {
    return chat.bySession[sid]?.liveStatus === t("正在分解任务…");
  }
  return chat.liveStatus === t("正在分解任务…");
}

/** Apply one ChatEventDto to the chat (and optionally session) store. */
export function applyChatEvent(
  chat: ChatStore,
  session: SessionStore,
  sessionId: string | null,
  ev: ChatEventDto,
): void {
  // 事件体上的 sessionId 优先，信封仅作兜底。
  const sid = ev.sessionId || sessionId || undefined;

  // 用户已在「正在停止…」窗口删除本轮：中止轮收尾时仍会补发 turn_complete
  // （以及迟到的 tool_end / error）。这些事件会把已清除的助手内容重新塞回
  // liveEvents 造成回闪，故在 pendingDelete 窗口内一律忽略，落盘轮由
  // applyChatResult 物理删除。
  if (sid && chat.bySession[sid]?.pendingDelete === true) return;

  // ── thinking_delta ────────────────────────────────────────────────────
  if (ev.type === "thinking_delta") {
    // 任务分解阶段的思考过程：允许前端展示渐进反馈，让用户知道
    // 模型正在工作（而非长时间无输出）。思考内容通过独立的
    // ThinkingBlock 渲染，不会混入 intent/tasks 等结构化字段。
    chat.patchLiveState((rt) => ({
      liveEvents: upsertThinkingFn(rt.liveEvents, ev.text, rt.currentStage || undefined),
      liveStatus: "",
    }), sid);
    return;
  }

  // ── assistant_delta ───────────────────────────────────────────────────
  if (ev.type === "assistant_delta") {
    if (isDecomposing(chat, sid)) return;
    chat.patchLiveState((rt) => ({
      liveEvents: upsertTextFn(sealThinkingFn(rt.liveEvents), ev.text),
      liveStatus: "",
    }), sid);
    return;
  }

  // ── tool_start ────────────────────────────────────────────────────────
  if (ev.type === "tool_start") {
    // 子智能体的工具调用：归入对应分组卡片，不与主循环工具混排。
    if (ev.subagent) {
      const { id: groupId, agentType, task } = ev.subagent;
      chat.patchLiveState((rt) => ({
        liveEvents: pushSubagentToolFn(
          ensureSubagentGroupFn(rt.liveEvents, { id: groupId, agentType, task }),
          groupId,
          { id: ev.id, name: ev.name, args: ev.args, status: "running" },
        ),
        liveStatus: toolStatusLabel("running", ev.name, ev.args),
      }), sid);
      return;
    }
    chat.patchLiveState((rt) => ({
      liveEvents: pushToolFn(sealTextFn(sealThinkingFn(rt.liveEvents)), {
        id: ev.id,
        name: ev.name,
        args: ev.args,
        status: "running",
      }),
      liveStatus: toolStatusLabel("running", ev.name, ev.args),
    }), sid);
    return;
  }

  // ── tool_end ──────────────────────────────────────────────────────────
  if (ev.type === "tool_end") {
    const status = ev.skipped ? "skipped" : ev.ok ? "done" : "error";
    if (ev.subagent) {
      chat.patchLiveState((rt) => ({
        liveEvents: updateSubagentToolFn(rt.liveEvents, ev.subagent!.id, ev.id, {
          status,
          output: ev.output,
        }),
        liveStatus: toolStatusLabel(status, ev.name),
      }), sid);
      return;
    }
    chat.patchLiveState((rt) => ({
      liveEvents: updateToolFn(rt.liveEvents, ev.id, { status, output: ev.output }),
      liveStatus: toolStatusLabel(status, ev.name),
    }), sid);
    return;
  }

  // ── task_decomposition ────────────────────────────────────────────────
  // 仅 pnpm dev（Vite DEV）推入 liveEvents 供调试卡片展示；生产包不展示。
  if (ev.type === "task_decomposition") {
    chat.sealThinking(sid ?? undefined);
    chat.setLiveStatus("", sid ?? undefined);
    if (import.meta.env.DEV) {
      chat.pushDecompose(
        {
          intent: ev.intent,
          userConstraints: ev.userConstraints,
          tasks: ev.tasks,
          relevantHistory: ev.relevantHistory,
          fallback: ev.fallback,
        },
        sid,
      );
    }
    return;
  }

  // ── stage_start / stage_done ──────────────────────────────────────────
  if (ev.type === "stage_start") {
    const stage = ev.nodeType === "task_decompose" ? "decompose" : "react";
    if (ev.nodeType === "task_decompose") {
      chat.setLiveStatus(t("正在分解任务…"), sid);
    } else {
      chat.setLiveStatus(t("阶段：{{label}}", { label: ev.label }), sid);
    }
    chat.patchLiveState(() => ({ currentStage: stage }), sid);
    return;
  }
  if (ev.type === "stage_done") {
    chat.setLiveStatus("", sid);
    chat.patchLiveState(() => ({ currentStage: null }), sid);
    // 子智能体阶段结束：终态由节点成败（stage_done.ok）决定并附带文字报告；
    // 单个工具失败不作为组失败依据（LLM 下一步会自行修正重试）。
    if (ev.nodeType === "subagent") {
      chat.patchLiveState((rt) => {
        let nextStatus: "done" | "error";
        if (ev.ok === undefined) {
          // 无 ok 字段（如 Explore 子智能体）：回退旧规则，检查组内是否已被标记 error
          nextStatus = rt.liveEvents.some(
            (event) =>
              event.kind === "subagent" &&
              event.group.id === ev.id &&
              event.group.status === "error",
          )
            ? "error"
            : "done";
        } else {
          nextStatus = ev.ok ? "done" : "error";
        }
        return {
          liveEvents: setSubagentGroupStatusFn(rt.liveEvents, ev.id, nextStatus, ev.report),
        };
      }, sid);
    }
    return;
  }

  // ── Context-control telemetry (no chat UI) ────────────────────────────
  if (ev.type === "minimum_context_decision" || ev.type === "minimum_context_read_follow_up") {
    return;
  }

  // ── task_update ───────────────────────────────────────────────────────
  if (ev.type === "task_update") {
    session.patchActivePlanMetaBySession(ev.sessionId, ev.tasks, ev.currentTaskId);
    return;
  }

  // ── task_run_state ────────────────────────────────────────────────────
  // Mirror unified TaskRunState into the session runtime + live status line.
  if (ev.type === "task_run_state") {
    chat.setTaskRun(
      {
        phase: ev.phase,
        taskId: ev.taskId,
        verificationStatus: ev.verificationStatus,
        verificationPassed: ev.verificationPassed,
        verificationSummary: ev.verificationSummary,
        repairAttempts: ev.repairAttempts,
        maxRepairAttempts: ev.maxRepairAttempts,
        label: ev.label,
        metrics: ev.metrics,
        totalDurationMs: ev.totalDurationMs,
      },
      sid,
    );
    chat.setLiveStatus(ev.label, sid);
    return;
  }

  // ── terminal ──────────────────────────────────────────────────────────
  if (ev.type === "terminal") {
    chat.setTerminal((prev) => {
      const i = prev.findIndex((t) => t.id === ev.entry.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = ev.entry;
        return next;
      }
      return [...prev, ev.entry];
    }, sid);
    return;
  }

  // ── warning ───────────────────────────────────────────────────────────
  if (ev.type === "warning") {
    // 验证门禁失败只在 LLM 正文区提示，不弹顶部错误条。
    if (isVerificationGateError(ev.message)) return;
    chat.setErrorAlert(toAppError(ev.message), sid);
    return;
  }

  // ── error ─────────────────────────────────────────────────────────────
  if (ev.type === "error") {
    chat.sealAllStreaming(sid);
    // 验证门禁失败只在 LLM 正文区提示，不弹顶部错误条 / 弹窗。
    if (!isVerificationGateError(ev.message)) {
      chat.setErrorAlert(toAppError(ev.message), sid);
    }
    chat.setLiveStatus("", sid);
    return;
  }

  // ── turn_complete ─────────────────────────────────────────────────────
  // 阶段三架构：接收完整的结构化消息，然后标记 session 完成。
  // The committed history is applied by the send IPC result. This event can
  // cross that result in flight, so sealing the old stream is not enough:
  // it would render the same assistant reply twice.
  if (ev.type === "turn_complete") {
    // 被用户中止的轮次：其 cancelled 结果（含「[用户已中止]」与工具过程）
    // 已由 sendChat 返回的持久化 history 交付，不再把 structured 内容灌进
    // liveEvents，否则会与历史重复；在「停止后删除」场景还会造成已删内容
    // 延迟回闪（turn_complete 经主进程缓冲可能晚于结果数秒到达）。
    if (ev.metadata?.aborted === true) {
      chat.markSessionCompleted(sid);
      chat.setSending(false, sid);
      return;
    }
    // 正文由 sendChat 的已提交 history 渲染；structured 只在实时结果先于 history 时暂存。
    chat.pushStructuredMessage(ev.parts, ev.metadata, sid);
    // 清除流式正文、旧过程快照和结构化临时副本。完成的工具过程从 history 构造折叠块。
    // 保留 decompose 事件：任务分解折叠条在回合结束后仍常驻，
    // 下一次分解会经 pushDecompose 替换旧的。
    chat.setLiveEvents(
      (events) => events.filter((event) => event.kind !== "structured" && event.kind !== "text" && event.kind !== "thinking"),
      sid,
    );
    chat.markSessionCompleted(sid);
    chat.setSending(false, sid);
  }
}
