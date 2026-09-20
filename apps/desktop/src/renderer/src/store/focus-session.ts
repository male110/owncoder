import { useChatStore } from "./chat-store";
import { useSessionStore } from "./session-store";

/**
 * UI 展示会话与读写路径上的当前 sessionId 必须是同一个值。
 *
 * 侧栏高亮读 session-store；Composer / AskUser / 危险命令 / 缺省 mutator
 * 读 chat-store；发送与任务栏读 session-store。两边分叉时就会出现
 * 「界面已是 B1，后续读写仍认 A1」。
 */
export function syncFocusSession(id: string | null): string | null {
  useSessionStore.getState().setActiveSessionId(id);
  useChatStore.getState().setActiveSession(id);
  return id;
}

/** 界面当前展示的会话。两边短暂分叉时以 session-store（侧栏）为准。 */
export function getFocusSessionId(): string | null {
  return useSessionStore.getState().activeSessionId
    ?? useChatStore.getState().activeSessionId;
}
