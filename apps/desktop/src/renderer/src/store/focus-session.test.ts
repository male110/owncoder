import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore } from "./chat-store";
import { getFocusSessionId, syncFocusSession } from "./focus-session";
import { useSessionStore } from "./session-store";

describe("focus session sync", () => {
  beforeEach(() => {
    useSessionStore.setState({
      activeSessionId: null,
      activePlanMeta: null,
      activePlanMetaBySession: {},
      activePlanPath: null,
      activePlanPathBySession: {},
      plans: [],
      plansBySession: {},
      workspace: { root: "E:/proj", name: "proj" },
      activeSessionIdByProject: {},
    });
    useChatStore.setState({
      activeSessionId: null,
      bySession: {},
      history: [],
      sending: false,
      queuedMessages: [],
      liveEvents: [],
      terminal: [],
      liveStatus: "",
      errorAlert: null,
      taskRun: null,
      dangerousConfirmations: [],
      askRequests: [],
      status: "idle",
    });
  });

  it("keeps UI and current sessionId on B1 after A1 → B1", () => {
    syncFocusSession("A1");
    expect(useSessionStore.getState().activeSessionId).toBe("A1");
    expect(useChatStore.getState().activeSessionId).toBe("A1");

    syncFocusSession("B1");

    expect(useSessionStore.getState().activeSessionId).toBe("B1");
    expect(useChatStore.getState().activeSessionId).toBe("B1");
    expect(getFocusSessionId()).toBe("B1");
  });

  it("does not let a stale backend A1 overwrite renderer B1", () => {
    syncFocusSession("B1");
    const staleBackendId = "A1";
    const rendererFocus = getFocusSessionId();
    if (rendererFocus) syncFocusSession(rendererFocus);
    else syncFocusSession(staleBackendId);

    expect(getFocusSessionId()).toBe("B1");
    expect(useSessionStore.getState().activeSessionId).toBe("B1");
    expect(useChatStore.getState().activeSessionId).toBe("B1");
  });

  it("prefers the sidebar session-store when the two stores briefly diverge", () => {
    useSessionStore.getState().setActiveSessionId("B1");
    useChatStore.getState().setActiveSession("A1");
    expect(getFocusSessionId()).toBe("B1");
  });
});
