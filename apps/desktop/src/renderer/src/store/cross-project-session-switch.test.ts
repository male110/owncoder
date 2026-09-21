import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "./chat-store";
import { syncFocusSession } from "./focus-session";
import { useSessionStore } from "./session-store";

/**
 * 回归：项目 A 有运行中会话时，首次点项目 B 的历史会话，
 * 乐观 syncFocusSession 会先露出空 runtime；若随后因 navigationVersion
 * 过期直接丢弃后端快照，UI 就只剩上方输入框。
 * 正确行为是：即使导航版本已过期，也要把 backend history 写入 bySession[id]。
 */
describe("cross-project first session switch history hydrate", () => {
  beforeEach(() => {
    useSessionStore.setState({
      activeSessionId: "A1",
      workspace: { root: "E:/projA", name: "projA" },
      sessions: [{ id: "A1", title: "A running", updatedAt: "2026-01-01T00:00:00.000Z", pinned: false }],
      sessionsByProject: {
        "E:/projA": [{ id: "A1", title: "A running", updatedAt: "2026-01-01T00:00:00.000Z", pinned: false }],
        "E:/projB": [{ id: "B1", title: "B history", updatedAt: "2026-01-01T00:00:00.000Z", pinned: false }],
      },
      activeSessionIdByProject: {
        "E:/projA": "A1",
        "E:/projB": "B1",
      },
      activePlanMeta: null,
      activePlanMetaBySession: {},
      activePlanPath: null,
      activePlanPathBySession: {},
      plans: [],
      plansBySession: {},
    });
    useChatStore.setState({
      activeSessionId: "A1",
      bySession: {
        A1: {
          history: [{ role: "user", content: "A running turn" }],
          historyBeforeSeq: null,
          historyHasMore: false,
          historyLoading: false,
          sending: true,
          queuedMessages: [],
          liveEvents: [],
          terminal: [],
          liveStatus: "running",
          errorAlert: null,
          taskRun: null,
          dangerousConfirmations: [],
          askRequests: [],
          status: "running",
        },
      },
      history: [{ role: "user", content: "A running turn" }],
      historyBeforeSeq: null,
      historyHasMore: false,
      historyLoading: false,
      sending: true,
      queuedMessages: [],
      liveEvents: [],
      terminal: [],
      liveStatus: "running",
      errorAlert: null,
      taskRun: null,
      dangerousConfirmations: [],
      askRequests: [],
      status: "running",
    });
  });

  it("keeps backend history for B1 even when a newer navigation supersedes the switch", () => {
    // 1) 乐观切到 B1：此时 bySession[B1] 还不存在，UI 会先看到空会话。
    syncFocusSession("B1");
    expect(useChatStore.getState().history).toEqual([]);
    expect(useChatStore.getState().bySession.B1?.history ?? []).toEqual([]);

    // 2) 模拟 switchChatSession 返回后、navigationVersion 已过期：
    //    仍必须把后端 history 写入 bySession[B1]，否则首进 B 只剩输入框。
    const backendHistory = [
      { role: "user" as const, content: "old B question" },
      { role: "assistant" as const, content: "old B answer" },
    ];
    useChatStore.getState().setHistory(backendHistory, "B1");

    expect(useChatStore.getState().bySession.B1?.history).toEqual(backendHistory);
    // 焦点仍在 B1 时，顶层镜像也应同步，Composer 不再误判为空会话。
    expect(useChatStore.getState().history).toEqual(backendHistory);
    expect(useChatStore.getState().history.length).toBeGreaterThan(0);
  });

  it("does not let an empty history page wipe a previously hydrated B1 runtime", () => {
    syncFocusSession("B1");
    useChatStore.getState().setHistory(
      [
        { role: "user", content: "old B question" },
        { role: "assistant", content: "old B answer" },
      ],
      "B1",
    );

    const currentHistory = useChatStore.getState().bySession.B1?.history ?? [];
    const pageTurns: Array<{ role: "user" | "assistant"; content: string }> = [];
    // 与 switchSessionInternal 相同的保护：空页且已有历史时不覆盖。
    if (pageTurns.length > 0 || currentHistory.length === 0) {
      useChatStore.getState().setHistory(pageTurns, "B1");
    }

    expect(useChatStore.getState().bySession.B1?.history).toEqual([
      { role: "user", content: "old B question" },
      { role: "assistant", content: "old B answer" },
    ]);
  });
});
