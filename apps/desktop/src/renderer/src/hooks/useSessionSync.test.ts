import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 在 Node 环境执行操作回调，保留真实 store 和 IPC 调用顺序。
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: vi.fn(),
}));

import { useSessionSync } from "./useSessionSync";
import { useSessionStore } from "../store/session-store";
import { useChatStore } from "../store/chat-store";
import { syncFocusSession } from "../store/focus-session";

const projectA = { root: "E:/projectA", name: "projectA" };
const projectB = { root: "E:/projectB", name: "projectB" };
const originalSession = {
  id: "A1", title: "已有对话", updatedAt: "2026-01-01", pinned: false, projectRoot: projectA.root,
};

describe("新建对话的项目归属", () => {
  let backendRoot: string;
  let api: ReturnType<typeof useSessionSync>;
  let ipc: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.useFakeTimers();
    backendRoot = projectA.root;
    useSessionStore.setState({
      workspace: projectA,
      projects: [projectA, projectB],
      sessions: [originalSession],
      sessionsByProject: { [projectA.root]: [originalSession] },
      activeSessionIdByProject: {},
      gitStatus: null,
    });
    useChatStore.setState({ bySession: {} });
    syncFocusSession("A1");
    ipc = {
      openWorkspaceDialog: vi.fn(async () => {
        backendRoot = projectB.root;
        // 模拟打开项目时，主进程先于 IPC 返回触发恢复事件。
        await api.applyOpened(undefined, { sanitize: true });
        return projectB;
      }),
      listProjects: vi.fn(async () => [projectA, projectB]),
      listChatSessions: vi.fn(async (root: string) => ({
        sessions: root === projectA.root ? [originalSession] : [],
      })),
      switchWorkspacePath: vi.fn(async (root: string) => { backendRoot = root; }),
      openWorkspacePath: vi.fn(async (root: string) => { backendRoot = root; }),
      createChatSession: vi.fn(async () => ({
        meta: { id: "new", title: "新会话", updatedAt: "2026-01-02", pinned: false, projectRoot: backendRoot },
        history: [],
      })),
      getSessionState: vi.fn(() => { throw new Error("新建草稿不应恢复旧会话"); }),
      getGitStatus: vi.fn(async (root?: string) => ({
        isRepo: true, branch: root === projectB.root ? "feature-b" : "main",
        dirty: false, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0, summary: "",
      })),
    };
    vi.stubGlobal("window", { owncoder: ipc });
    api = useSessionSync();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("选择已有项目后，首条消息在该项目创建会话", async () => {
    await api.onNewSession();
    await api.onSelectProject(projectB.root);
    expect(ipc.createChatSession).not.toHaveBeenCalled();
    await api.createPendingSession();
    expect(backendRoot).toBe(projectB.root);
    expect(useSessionStore.getState().sessionsByProject[projectB.root][0].projectRoot).toBe(projectB.root);
    expect(useSessionStore.getState().sessionsByProject[projectA.root]).toEqual([originalSession]);
  });

  it.each([false, true])("打开新项目 B 后保留草稿并归属 B（先选择 A：%s）", async (selectAFirst) => {
    await api.onNewSession();
    if (selectAFirst) await api.onSelectProject(projectA.root);
    await api.onAddProject();
    expect(api.pendingNewSessionRef.current).toBe(true);
    expect(useSessionStore.getState().workspace?.root).toBe(projectB.root);
    expect(useSessionStore.getState().activeSessionId).toBeNull();
    expect(ipc.getSessionState).not.toHaveBeenCalled();
    expect(ipc.createChatSession).not.toHaveBeenCalled();
    await api.createPendingSession();
    expect(backendRoot).toBe(projectB.root);
    expect(useSessionStore.getState().sessionsByProject[projectB.root][0].projectRoot).toBe(projectB.root);
    expect(useSessionStore.getState().sessionsByProject[projectA.root]).toEqual([originalSession]);
  });

  it("草稿切换项目后按所选路径读取分支，后端仍保留原项目", async () => {
    await api.onNewSession();
    await api.refreshGit(projectA.root);
    expect(useSessionStore.getState().gitStatus?.branch).toBe("main");
    await api.onSelectProject(projectB.root);
    expect(backendRoot).toBe(projectA.root);
    expect(ipc.getGitStatus).toHaveBeenLastCalledWith(projectB.root);
    expect(useSessionStore.getState().gitStatus?.branch).toBe("feature-b");
  });

  it("切换项目时清空旧分支，非 Git 项目不残留分支", async () => {
    await api.onNewSession();
    await api.refreshGit(projectA.root);
    let resolveStatus!: (status: unknown) => void;
    ipc.getGitStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const switching = api.onSelectProject(projectB.root);
    await Promise.resolve();
    expect(useSessionStore.getState().workspace?.root).toBe(projectB.root);
    expect(useSessionStore.getState().gitStatus).toBeNull();
    resolveStatus({ isRepo: false, branch: null });
    await switching;
    expect(useSessionStore.getState().gitStatus?.isRepo).toBe(false);
    expect(useSessionStore.getState().gitStatus?.branch).toBeNull();
  });

  it("连续切换项目后忽略旧请求的迟到分支", async () => {
    await api.onNewSession();
    let resolveOld!: (status: unknown) => void;
    ipc.getGitStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const oldRefresh = api.refreshGit(projectA.root);
    await api.onSelectProject(projectB.root);
    await api.onSelectProject(projectA.root);
    resolveOld({ isRepo: true, branch: "stale" });
    await oldRefresh;
    expect(useSessionStore.getState().workspace?.root).toBe(projectA.root);
    expect(useSessionStore.getState().gitStatus?.branch).toBe("main");
  });

  it("缓存项目切换后刷新分支", async () => {
    useSessionStore.setState({ sessionsByProject: { [projectA.root]: [originalSession], [projectB.root]: [] } });
    await api.refreshGit(projectA.root);
    await api.onSelectProject(projectB.root);
    expect(backendRoot).toBe(projectB.root);
    expect(useSessionStore.getState().gitStatus?.branch).toBe("feature-b");
  });

  it("取消打开新项目后保留原先选择的项目", async () => {
    ipc.openWorkspaceDialog.mockResolvedValue(null);
    await api.onNewSession();
    await api.onSelectProject(projectA.root);
    await api.onAddProject();
    await api.createPendingSession();
    expect(backendRoot).toBe(projectA.root);
    expect(useSessionStore.getState().sessionsByProject[projectA.root][0].id).toBe("new");
  });
});
