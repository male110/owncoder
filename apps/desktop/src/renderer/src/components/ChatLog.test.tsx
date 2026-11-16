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
  { kind: "decompose", id: "plan", decomposition: { title: "任务计划" } },
  { kind: "tool", id: "tool", tool: { id: "tool", name: "read_file", status: "running" } },
  { kind: "subagent", id: "sub", group: { id: "sub", status: "running" } },
  { kind: "text", id: "text", text: "阶段更新", streaming: true },
] as LiveEvent[];

function render(turns: ChatTurnDto[], sending: boolean) {
  return renderToStaticMarkup(createElement(ChatLog, { turns, liveEvents, liveStatus: "执行进度", sending }));
}

describe("ChatLog visible conversation", () => {
  it("excludes plan, progress, tools, thoughts, subagent stages and streamed text", () => {
    const html = render([user, { id: "interim", role: "assistant", content: "中间答复" }], true);
    expect(html).toContain("用户提问");
    for (const hidden of ["中间答复", "思考过程", "任务计划", "执行进度", "read_file", "阶段更新", "sub"]) {
      expect(html).not.toContain(hidden);
    }
  });

  it("renders the completed answer and terminal error, not intermediate history", () => {
    const answer = render([user, { id: "interim", role: "assistant", content: "中间答复" }, { id: "final", role: "assistant", content: "最终答复" }], false);
    expect(answer).toContain("最终答复");
    expect(answer).not.toContain("中间答复");
    expect(render([user, { id: "error", role: "assistant", content: "Error: 最终失败" }], false)).toContain("Error: 最终失败");
  });
});
