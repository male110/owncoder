import { describe, expect, it } from "vitest";
import type { ChatTurnDto } from "../../../preload/index";
import type { LiveEvent } from "../store/chat-store";
import {
  buildChatItems,
  buildLogBlocks,
  deriveLiveStatus,
  toolLabel,
} from "./chat-log-model";

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

  it("omits collapsed tools/process summary blocks from the list", () => {
    const items = buildChatItems([
      { kind: "user", turn: userTurn("修 bug") },
      {
        kind: "process",
        items: [
          { id: "t1", role: "tool", toolName: "read_file", content: "ok" },
          { id: "t2", role: "tool", toolName: "grep", content: "ok" },
        ],
      },
      { kind: "assistant", turn: { id: "a1", role: "assistant", content: "已修好" } },
      {
        kind: "tools",
        items: [{ id: "t3", role: "tool", toolName: "bash", content: "ok" }],
      },
    ]);
    expect(items.map((it) => (it.kind === "block" ? it.block.kind : it.kind))).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("does not inject status/current rows into the virtual list", () => {
    const items = buildChatItems([]);
    expect(items).toEqual([]);
    // live status + thinking/text are rendered by ChatLog Footer, not list data
    void text;
  });
});

describe("buildLogBlocks process panel", () => {
  it("keeps all tool steps in a completed round process block", () => {
    const turns: ChatTurnDto[] = [
      userTurn("fix bug"),
      { id: "t1", role: "tool", toolName: "bash", content: "ok" },
      { id: "t2", role: "tool", toolName: "web_fetch", content: "html" },
      { id: "t3", role: "tool", toolName: "ask_user", content: "answered" },
      { id: "a1", role: "assistant", content: "最终结论", parts: [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "git status" } },
        { type: "tool_use", id: "t2", name: "web_fetch", input: { url: "https://example.com" } },
        { type: "tool_use", id: "t3", name: "ask_user", input: { question: "继续？" } },
      ] },
    ];
    const blocks = buildLogBlocks(turns, false, 0);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "process", "assistant"]);
    const process = blocks[1];
    expect(process?.kind).toBe("process");
    if (process?.kind === "process") {
      expect(process.items).toHaveLength(3);
      expect(process.items.map((t) => t.toolName)).toEqual(["bash", "web_fetch", "ask_user"]);
      expect(process.items.map((t) => t.toolArgs)).toEqual([
        { command: "git status" },
        { url: "https://example.com" },
        { question: "继续？" },
      ]);
    }
  });
});

describe("toolLabel", () => {
  it("localizes previously missing tool names", () => {
    expect(toolLabel("read_outline")).toBe("读取大纲");
    expect(toolLabel("ask_user")).toBe("询问用户");
    expect(toolLabel("lsp_diagnostics")).toBe("LSP 诊断");
    expect(toolLabel("save_memory")).toBe("保存记忆");
  });
});
