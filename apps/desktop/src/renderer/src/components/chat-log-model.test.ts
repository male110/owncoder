import { describe, expect, it } from "vitest";
import type { ChatTurnDto } from "../../../preload/index";
import type { LiveEvent } from "../store/chat-store";
import {
  buildChatItems,
  buildLogBlocks,
  deriveLiveStatus,
  isActivationEdge,
  isInitialScrollReady,
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

describe("切换会话后虚拟列表贴底", () => {
  it("异步加载 B 的消息后，必须等最后一条虚拟行渲染且容器贴底才结束定位", () => {
    const lastB = 100_019;
    // 首屏只有前几条；即使外层容器暂时认为自己已贴底也不能停止。
    expect(isInitialScrollReady(100_003, lastB, true, true, true, 3)).toBe(false);
    expect(isInitialScrollReady(lastB, lastB, false, true, true, 4)).toBe(false);
    expect(isInitialScrollReady(lastB, lastB, true, false, true, 5)).toBe(false);
    expect(isInitialScrollReady(lastB, lastB, true, true, true, 6)).toBe(true);
  });

  it("空会话无需等待虚拟行；短会话等待布局稳定", () => {
    expect(isInitialScrollReady(null, null, true, true, false, 11)).toBe(false);
    expect(isInitialScrollReady(null, null, true, true, false, 12)).toBe(true);
  });

  it("面板常驻挂载：只有 active 的 false→true 边沿才重新触发钉底", () => {
    // 从会话 A 切到正在 streaming 的会话 B：B 的 active 由 false 变 true
    expect(isActivationEdge(false, true)).toBe(true);
    // 首次挂载即为激活态（无前序状态），不应重复触发
    expect(isActivationEdge(true, true)).toBe(false);
    // 切走：true→false 不触发
    expect(isActivationEdge(true, false)).toBe(false);
    // 持续隐藏不触发
    expect(isActivationEdge(false, false)).toBe(false);
  });
});

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

  it("omits process and tools while rendering saved-plan notices and final replies", () => {
    const items = buildChatItems([
      { kind: "user", turn: userTurn("修 bug") },
      { kind: "process", items: [{ id: "t1", role: "tool", content: "ok" }] },
      { kind: "tools", items: [{ id: "t2", role: "tool", content: "ok" }] },
      { kind: "assistant", turn: { id: "p1", role: "assistant", content: "<!--plan_saved:plan.md-->" } },
      { kind: "assistant", turn: { id: "a1", role: "assistant", content: "已修好" } },
    ]);
    expect(items.map((it) => it.block.kind)).toEqual(["user", "assistant", "assistant"]);
    expect(items[1]?.block).toMatchObject({ turn: { content: "<!--plan_saved:plan.md-->" } });
    expect(items[2]?.block).toMatchObject({ turn: { content: "已修好" } });
  });

  it("does not inject status/current rows into the virtual list", () => {
    const items = buildChatItems([]);
    expect(items).toEqual([]);
    // live status + thinking/text are rendered by ChatLog Footer, not list data
    void text;
  });
});

describe("buildLogBlocks process panel", () => {
  it("turn_complete 后残留分解快照不阻止历史过程折叠或重复渲染报告", () => {
    const turns: ChatTurnDto[] = [
      userTurn("修复问题"),
      { id: "a1", role: "assistant", content: "正在检查代码" },
      { id: "t1", role: "tool", toolName: "read_file", content: "完成" },
      { id: "a2", role: "assistant", content: "发现问题，准备修复" },
      { id: "t2", role: "tool", toolName: "apply_patch", content: "完成" },
      { id: "a3", role: "assistant", content: "最终报告：修复完成" },
    ];
    const blocks = buildLogBlocks(turns, false, 1);
    expect(blocks.map((block) => block.kind)).toEqual(["user", "process", "assistant"]);
    const process = blocks[1];
    expect(process?.kind).toBe("process");
    if (process?.kind === "process") {
      expect(process.items.map((item) => item.content)).toEqual([
        "正在检查代码", "完成", "发现问题，准备修复", "完成",
      ]);
    }
    const reports = blocks.filter((block) => block.kind === "assistant");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "assistant", turn: { content: "最终报告：修复完成" } });
  });

  it("任务结束移除实时事件后仍使用 history 参数，包括合法空参数", () => {
    const turns: ChatTurnDto[] = [
      userTurn("检查参数"),
      { id: "outline", role: "tool", toolName: "read_outline", toolArgs: { path: "src/index.ts" }, content: "完成" },
      { id: "status", role: "tool", toolName: "git_status", toolArgs: {}, content: "完成" },
      { role: "assistant", content: "检查结束" },
    ];
    for (const [sending, liveCount] of [[true, 2], [false, 0]] as const) {
      const blocks = buildLogBlocks(turns, sending, liveCount);
      const tools = blocks.flatMap((block) => block.kind === "tools" || block.kind === "process" ? block.items : []);
      expect(tools.map((turn) => ({ id: turn.id, args: turn.toolArgs }))).toEqual([
        { id: "outline", args: { path: "src/index.ts" } },
        { id: "status", args: {} },
      ]);
    }
  });

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

describe("conversation visibility", () => {
  it("hides in-progress thoughts and tools while sending; completed plan notices stay visible", () => {
    const turns: ChatTurnDto[] = [
      userTurn("修复问题"),
      { id: "a1", role: "assistant", content: "思考及执行进度" },
      { id: "p1", role: "assistant", content: "<!--plan_saved:plan.md-->" },
      { id: "t1", role: "tool", content: "工具结果" },
    ];
    expect(buildChatItems(buildLogBlocks(turns, true, 4)).map((item) => item.block.kind)).toEqual(["user"]);
    turns.push({ id: "a2", role: "assistant", content: "最终答复" });
    expect(buildChatItems(buildLogBlocks(turns, false, 0)).map((item) => item.block.kind)).toEqual(["user", "assistant", "assistant"]);
  });

  it("renders the plan notice as the round's reply when it is the only assistant turn", () => {
    // 计划轮：planner deliverPlan 是该轮唯一助手回复，结束后必须可见，
    // 否则「计划已保存」在会话里什么都不显示（9ddc097 曾把它过滤掉）。
    const turns: ChatTurnDto[] = [
      userTurn("帮我规划这个功能"),
      { id: "t1", role: "tool", toolName: "dispatch_agent", content: "计划报告" },
      { id: "p1", role: "assistant", content: "计划已保存：uuid，版本 v1\n\n<!--plan_saved:.owncoder/plans/sessions/abc/uuid-v1.md-->" },
    ];
    const blocks = buildLogBlocks(turns, false, 0);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "tools", "assistant"]);
    expect(blocks[2]).toMatchObject({ kind: "assistant", turn: { content: expect.stringContaining("<!--plan_saved:") } });
    expect(buildChatItems(blocks).map((item) => item.block.kind)).toEqual(["user", "assistant"]);
  });

  it("keeps a terminal error when no final reply is available", () => {
    const turns: ChatTurnDto[] = [userTurn("修复问题"), { id: "e1", role: "assistant", content: "Error: execution failed" }];
    expect(buildChatItems(buildLogBlocks(turns, false, 0))[1]?.block).toMatchObject({ turn: { content: "Error: execution failed" } });
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
