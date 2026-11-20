import { beforeEach, describe, expect, it, vi } from "vitest";

// queue-controller 依赖渲染进程全局 window.owncoder（preload 注入），
// 这里用最小桩替换：记录 setQueuedMessages 的写入即可验证持久化。
const persisted = new Map<string, unknown[]>();
vi.stubGlobal("window", {
  owncoder: {
    setQueuedMessages: async (messages: unknown[], sid?: string) => {
      persisted.set(sid ?? "default", messages);
      return messages;
    },
  },
});

import { useChatStore } from "../store/chat-store";
import {
  dropQueue,
  editMessage,
  enqueueMessage,
  hydrateQueue,
  isQueueRunning,
  removeMessage,
  sendQueuedMessage,
} from "./queue-controller";

const SID = "queue-test-session";

function queueOf(sid = SID) {
  return useChatStore.getState().bySession[sid]?.queuedMessages ?? [];
}

describe("待执行队列编辑（editMessage）", () => {
  beforeEach(() => {
    persisted.clear();
    useChatStore.setState({ bySession: {} });
    dropQueue(SID);
    hydrateQueue(SID, []);
  });

  it("原地保位编辑，附件保留", () => {
    enqueueMessage(SID, "第一条");
    enqueueMessage(SID, "第二条");
    enqueueMessage(SID, "第三条");

    expect(editMessage(SID, 1, "第二条（改）")).toBe(true);

    const q = queueOf();
    expect(q.map((m) => m.text)).toEqual(["第一条", "第二条（改）", "第三条"]);
    // 位置保持不变
    expect(q[1]).toEqual({ text: "第二条（改）" });
    // 立即持久化
    expect(persisted.get(SID)).toEqual(q);
  });

  it("编辑不改附件", () => {
    const attachments = [{ name: "a.txt", mimeType: "text/plain", url: "file:///a.txt" }];
    enqueueMessage(SID, "带附件", attachments);
    expect(editMessage(SID, 0, "新文案")).toBe(true);
    expect(queueOf()[0]).toEqual({ text: "新文案", attachments });
  });

  it("空文本拒绝编辑", () => {
    enqueueMessage(SID, "原文本");
    expect(editMessage(SID, 0, "   ")).toBe(false);
    expect(queueOf()[0]!.text).toBe("原文本");
  });

  it("越界与未修改", () => {
    enqueueMessage(SID, "原文本");
    expect(editMessage(SID, 5, "x")).toBe(false);
    // 未修改直接成功（无写入副作用）
    expect(editMessage(SID, 0, "原文本")).toBe(true);
  });

  it("运行中也可编辑（只作用于仍处于队列的条目）", () => {
    enqueueMessage(SID, "正在执行");
    enqueueMessage(SID, "待执行");
    // 模拟运行中：不影响编辑路径（sendQueuedMessage 的抢占逻辑由其它测试覆盖）。
    expect(editMessage(SID, 1, "待执行（纠正）")).toBe(true);
    expect(queueOf()[1]!.text).toBe("待执行（纠正）");
  });
});

describe("立即发送（sendQueuedMessage）", () => {
  let runnerCalls: { sid: string; oneOnly?: boolean }[];
  let cancelCalls: string[];

  beforeEach(() => {
    persisted.clear();
    useChatStore.setState({ bySession: {} });
    dropQueue(SID);
    hydrateQueue(SID, []);
    runnerCalls = [];
    cancelCalls = [];
    (window.owncoder as { cancelChat: (sid?: string) => Promise<void> }).cancelChat = async (sid) => {
      cancelCalls.push(sid ?? "default");
    };
  });

  it("空闲时把目标条目移到队首并发送", async () => {
    enqueueMessage(SID, "A");
    enqueueMessage(SID, "B");
    enqueueMessage(SID, "C");
    const { setQueueRunner } = await import("./queue-controller");
    const owner = setQueueRunner(async (sid, oneOnly) => {
      runnerCalls.push({ sid, oneOnly });
    });

    await sendQueuedMessage(SID, 2);

    expect(queueOf().map((m) => m.text)).toEqual(["C", "A", "B"]);
    expect(runnerCalls).toEqual([{ sid: SID, oneOnly: true }]);
    expect(cancelCalls).toEqual([]);
    const { clearQueueRunner } = await import("./queue-controller");
    clearQueueRunner(owner);
  });

  it("运行中触发时中止当前轮次，等收口后发送", async () => {
    vi.useFakeTimers();
    try {
      enqueueMessage(SID, "A（在飞）");
      enqueueMessage(SID, "B");
      const { setQueueRunner, markQueueRunning, clearQueueRunner, requestStop, isStopRequested } =
        await import("./queue-controller");
      const owner = setQueueRunner(async (sid, oneOnly) => {
        runnerCalls.push({ sid, oneOnly });
      });
      // 模拟在飞轮次：队列正在运行且已请求停止（runQueue 的常见状态）。
      markQueueRunning(SID, true);
      requestStop(SID);

      const promise = sendQueuedMessage(SID, 1);
      // 抢占应已先请求停止并触发后端中止。
      expect(isStopRequested(SID)).toBe(true);
      // 让 cancelChat 的微任务/计时推进。
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelCalls).toEqual([SID]);
      // 轮次尚未收口：此时不应发送。
      expect(runnerCalls).toEqual([]);
      // 模拟 runQueue finally：清掉 running 标志。
      markQueueRunning(SID, false);
      await vi.advanceTimersByTimeAsync(200);

      expect(queueOf().map((m) => m.text)).toEqual(["B", "A（在飞）"]);
      expect(runnerCalls).toEqual([{ sid: SID, oneOnly: true }]);
      expect(isStopRequested(SID)).toBe(false);
      clearQueueRunner(owner);
    } finally {
      vi.useRealTimers();
    }
  });

  it("无 runner 或空队列时安全无操作", async () => {
    enqueueMessage(SID, "A");
    // 不注册 runner：函数应直接返回而不抛错。
    await expect(sendQueuedMessage(SID, 0)).resolves.toBeUndefined();
    expect(queueOf().map((m) => m.text)).toEqual(["A"]);
  });

  it("重复点击被抢占锁拦截", async () => {
    vi.useFakeTimers();
    try {
      enqueueMessage(SID, "A");
      enqueueMessage(SID, "B");
      const { setQueueRunner, markQueueRunning, clearQueueRunner } = await import("./queue-controller");
      const owner = setQueueRunner(async (sid, oneOnly) => {
        runnerCalls.push({ sid, oneOnly });
      });
      markQueueRunning(SID, true);

      const first = sendQueuedMessage(SID, 0);
      // 在第一次抢占进行中再次点击：应被忽略。
      await expect(sendQueuedMessage(SID, 0)).resolves.toBeUndefined();
      markQueueRunning(SID, false);
      await vi.advanceTimersByTimeAsync(200);
      await first;

      expect(runnerCalls).toHaveLength(1);
      expect(cancelCalls).toHaveLength(1);
      clearQueueRunner(owner);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("删除条目时的编辑态边界", () => {
  it("removeMessage 后队列仍一致", () => {
    useChatStore.setState({ bySession: {} });
    dropQueue(SID);
    hydrateQueue(SID, []);
    enqueueMessage(SID, "A");
    enqueueMessage(SID, "B");
    removeMessage(SID, 0);
    expect(queueOf().map((m) => m.text)).toEqual(["B"]);
    expect(isQueueRunning(SID)).toBe(false);
  });
});
