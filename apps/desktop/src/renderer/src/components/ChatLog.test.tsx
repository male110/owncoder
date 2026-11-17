import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatTurnDto } from "../../../preload/index";
import type { LiveEvent } from "../store/chat-store";
import type { ChatItem } from "./chat-log-model";
import { ChatLog } from "./ChatLog";

vi.mock("react-virtuoso", async () => {
  const { createElement } = await import("react");
  return { Virtuoso: ({ data, itemContent }: { data: ChatItem[]; itemContent: (index: number, item: ChatItem) => React.ReactNode }) =>
    createElement("div", null, ...data.map((item, index) => itemContent(index, item))) };
});
vi.mock("../i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("./chat-log/useCopyMenu", () => ({ useCopyMenu: () => ({ copyMenu: null, copyMenuRef: { current: null }, handleContextMenu: () => {}, handleCopy: () => {} }) }));
vi.mock("./chat-log/UserBubble", async () => {
  const { createElement } = await import("react");
  return { UserBubble: ({ turn }: { turn: ChatTurnDto }) => createElement("div", null, turn.content) };
});
vi.mock("./chat-log/AssistantBubble", async () => {
  const { createElement } = await import("react");
  return { AssistantBubble: ({ turn }: { turn: ChatTurnDto }) => createElement("div", null, turn.content) };
});

const user: ChatTurnDto = { id: "u1", role: "user", content: "用户提问" };
const liveEvents = [
  { kind: "thinking", id: "think", text: "思考过程", streaming: true },
  { kind: "decompose", id: "plan", decomposition: { intent: "修复登录", userConstraints: [], relevantHistory: "", tasks: [{ id: "t1", title: "修复登录流程", executionGuidance: "改 login.ts" }], fallback: false } },
  { kind: "tool", id: "tool", tool: { id: "tool", name: "read_file", status: "running", args: {} } },
  { kind: "subagent", id: "sub", group: { id: "sub", status: "running", agentType: "Explore", task: "探索", tools: [] } },
  { kind: "text", id: "text", text: "阶段更新", streaming: true },
] as LiveEvent[];

function render(turns: ChatTurnDto[], sending: boolean) {
  return renderToStaticMarkup(createElement(ChatLog, { turns, liveEvents, liveStatus: "执行进度", sending }));
}

describe("ChatLog visible conversation", () => {
  it("shows live progress and streamed output while sending", () => {
    const html = render([user], true);
    expect(html).toContain("用户提问");
    expect(html).toContain("执行进度");
    expect(html).toContain("思考过程");
    expect(html).toContain("阶段更新");
    expect(html).toMatch(/class="chat-log-live-footer"[^>]*>.*class="chat-log-status sending"/s);
    expect(html).toMatch(/class="current-turn-bubble"[^>]*>.*class="live-event-stream"/s);
    expect(html).not.toContain('class="live-status"');
  });

  it("在回复最上方渲染任务分解折叠块，内容紧跟其后", () => {
    const html = render([user], true);
    expect(html).toContain('class="chat-log-decomposition"');
    expect(html).toContain("修复登录流程");
    expect(html).toContain("任务分解：{{count}} 个任务");
    // 分解块必须排在本轮实时事件流之前（聊天正文最上方）。
    const decomposeAt = html.indexOf('class="chat-log-decomposition"');
    const streamAt = html.indexOf('class="live-event-stream"');
    expect(decomposeAt).toBeGreaterThan(-1);
    expect(streamAt).toBeGreaterThan(decomposeAt);
  });

  it("仅有分解结果时折叠块照常渲染，不出现空壳", () => {
    const onlyDecompose = liveEvents.filter((e) => e.kind === "decompose");
    const html = renderToStaticMarkup(
      createElement(ChatLog, { turns: [user], liveEvents: onlyDecompose, sending: false }),
    );
    expect(html).toContain('class="chat-log-decomposition"');
    expect(html).toContain("修复登录流程");
    expect(html).not.toContain('class="live-event-stream"');
  });

  it("Planner 分支没有分解 payload 时仍渲染本轮内容且不出空分解壳", () => {
    const plannerEvents = liveEvents.filter((e) => e.kind !== "decompose");
    const html = renderToStaticMarkup(
      createElement(ChatLog, { turns: [user], liveEvents: plannerEvents, sending: true }),
    );
    expect(html).not.toContain('class="chat-log-decomposition"');
    expect(html).toContain('class="live-event-stream"');
    expect(html).toContain("探索");
  });

  it("keeps completed and failed tool cards inside the same live footer", () => {
    for (const status of ["done", "error"] as const) {
      const events: LiveEvent[] = [{ kind: "tool", id: "tool", tool: { id: "tool", name: "read_file", status, args: {} } }];
      const html = renderToStaticMarkup(createElement(ChatLog, { turns: [user], liveEvents: events, sending: false }));
      expect(html).toMatch(/class="chat-log-live-footer"[^>]*>.*class="current-turn-bubble"/s);
      expect(html).toContain(`tool-card live ${status}`);
    }
  });

  it("renders the completed answer and terminal error, not intermediate history", () => {
    const answer = render([user, { id: "interim", role: "assistant", content: "中间答复" }, { id: "final", role: "assistant", content: "最终答复" }], false);
    expect(answer).toContain("最终答复");
    expect(answer).not.toContain("中间答复");
    expect(render([user, { id: "error", role: "assistant", content: "Error: 最终失败" }], false)).toContain("Error: 最终失败");
  });
});
