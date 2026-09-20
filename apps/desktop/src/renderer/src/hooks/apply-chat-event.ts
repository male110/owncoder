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
  upsertTextFn,
  type useChatStore,
} from "../store/chat-store";
import type { useSessionStore } from "../store/session-store";
import type { ChatEventDto } from "../../../preload/index";

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
          : "";
    return `工具调用：${name}${hint}`;
  }
  if (status === "done") return `已完成：${name}`;
  if (status === "skipped") return `已跳过：${name}`;
  return `失败：${name}`;
}

function isDecomposing(chat: ChatStore, sid: string | undefined): boolean {
  // Prefer the target session runtime so multi-session apply stays correct.
  if (sid && sid !== chat.activeSessionId) {
    return chat.bySession[sid]?.liveStatus === "正在分解任务…";
  }
  return chat.liveStatus === "正在分解任务…";
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

  // ── thinking_delta ────────────────────────────────────────────────────
  if (ev.type === "thinking_delta") {
    // 任务分解是内部 JSON 协议，不应把任何 reasoning 泄露到用户聊天。
    if (isDecomposing(chat, sid)) return;
    // Atomic upsert — judgment and mutation happen inside one Zustand setter.
    chat.patchLiveState((rt) => ({
      liveEvents: upsertThinkingFn(rt.liveEvents, ev.text),
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
    chat.patchLiveState((rt) => ({
      liveEvents: updateToolFn(rt.liveEvents, ev.id, { status, output: ev.output }),
      liveStatus: toolStatusLabel(status, ev.name),
    }), sid);
    return;
  }

  // ── task_decomposition ────────────────────────────────────────────────
  if (ev.type === "task_decomposition") {
    chat.sealThinking(sid ?? undefined);
    chat.setLiveStatus("", sid ?? undefined);
    return;
  }

  // ── stage_start / stage_done ──────────────────────────────────────────
  if (ev.type === "stage_start") {
    if (ev.nodeType === "task_decompose") {
      chat.setLiveStatus("正在分解任务…", sid);
    } else {
      chat.setLiveStatus(`阶段：${ev.label}`, sid);
    }
    return;
  }
  if (ev.type === "stage_done") {
    chat.setLiveStatus("", sid);
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
    chat.pushStructuredMessage(ev.parts, ev.metadata, sid);
    chat.setLiveEvents(
      (events) => events.filter((event) => event.kind === "structured" || event.kind === "decompose"),
      sid,
    );
    chat.markSessionCompleted(sid);
    chat.setSending(false, sid);
  }
}
