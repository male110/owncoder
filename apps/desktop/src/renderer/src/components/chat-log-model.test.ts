import { describe, expect, it } from "vitest";
import type { ChatTurnDto } from "../../../preload/index";
import type { LiveEvent } from "../store/chat-store";
import { buildChatItems, deriveLiveStatus } from "./chat-log-model";

function thinking(text: string, streaming = true): LiveEvent {
  return { kind: "thinking", id: "t1", text, streaming };
}

function text(content: string, streaming = true): LiveEvent {
  return { kind: "text", id: "a1", text: content, streaming };
}

function userTurn(content: string): ChatTurnDto {
  return {
    id: "u1",
    role: "user",
    content,
  };
}

describe("deriveLiveStatus", () => {
  it("prefers explicit liveStatus", () => {
    expect(deriveLiveStatus(true, "正在分解任务…", [thinking("x")])).toBe("正在分解任务…");
  });

  it("shows 思考中 while streaming thinking", () => {
    expect(deriveLiveStatus(true, "", [thinking("部分思考")])).toBe("思考中…");
  });

  it("returns empty when not sending and no liveStatus", () => {
    expect(deriveLiveStatus(false, "", [thinking("done", false)])).toBe("");
  });
});

describe("buildChatItems", () => {
  it("only includes committed history blocks (live stream is Footer)", () => {
    const items = buildChatItems([
      { kind: "user", turn: userTurn("你好") },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("block");
    expect(items[0]?.key).toContain("u1");
  });

  it("does not inject status/current rows into the virtual list", () => {
    const items = buildChatItems([]);
    expect(items).toEqual([]);
    // live status + thinking/text are rendered by ChatLog Footer, not list data
    void text;
  });
});
