/**
 * applyTaskListOps（动态任务清单纯函数核心）单元测试。
 *
 * 锁住的语义：
 * - add：自动 id 分配、显式 id、同批依赖引用、重复/空描述拒绝
 * - update：字段合并、未知 id / 非法 status / 自环 / 悬空依赖拒绝
 * - remove：未知 id / in_progress 拒绝、删除后剥离悬空依赖
 * - 原子性：任一校验失败整体不应用；成功后保持原数组引用
 * - 成环检测：跨任务环与自环
 */
import { describe, expect, it } from "vitest";
import {
  applyTaskListOps,
  formatTaskList,
  type TaskItem,
} from "./plans.ts";

function makeTask(overrides: Partial<TaskItem> & Pick<TaskItem, "id" | "description">): TaskItem {
  return {
    status: "pending",
    dependsOn: [],
    retryCount: 0,
    maxRetries: 2,
    ...overrides,
  };
}

describe("applyTaskListOps — add", () => {
  it("省略 id 时自动分配 t{n}，避开现有 id", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    const outcome = applyTaskListOps(tasks, { add: [{ description: "新任务" }] });
    expect(outcome.ok).toBe(true);
    expect(tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(tasks[1]!.status).toBe("pending");
  });

  it("显式 id + 同批 add 的依赖引用合法", () => {
    const tasks: TaskItem[] = [];
    const outcome = applyTaskListOps(tasks, {
      add: [
        { id: "parse", description: "解析" },
        { id: "exec", description: "执行", dependsOn: ["parse"] },
      ],
    });
    expect(outcome.ok).toBe(true);
    expect(tasks[1]!.dependsOn).toEqual(["parse"]);
  });

  it("同批 add 的前向依赖引用合法（统一校验阶段所有 add 已落地）", () => {
    const tasks: TaskItem[] = [];
    const outcome = applyTaskListOps(tasks, {
      add: [
        { id: "exec", description: "执行", dependsOn: ["parse"] },
        { id: "parse", description: "解析" },
      ],
    });
    expect(outcome.ok).toBe(true);
    expect(tasks[0]!.dependsOn).toEqual(["parse"]);
  });

  it("add 的悬空依赖 → 拒绝（防永不就绪任务把图卡进 deadlock 暂停）", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    const outcome = applyTaskListOps(tasks, {
      add: [{ description: "新任务", dependsOn: ["ghost"] }],
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("ghost");
    expect(tasks).toHaveLength(1); // 原子性
  });

  it("连续自动 id：从空清单 t1/t2；从已有 t1/t2 接续 t3/t4", () => {
    const empty: TaskItem[] = [];
    const r1 = applyTaskListOps(empty, { add: [{ description: "a" }, { description: "b" }] });
    expect(r1.ok).toBe(true);
    expect(empty.map((t) => t.id)).toEqual(["t1", "t2"]);

    const existing: TaskItem[] = [makeTask({ id: "t1", description: "a" }), makeTask({ id: "t2", description: "b" })];
    const r2 = applyTaskListOps(existing, { add: [{ description: "c" }, { description: "d" }] });
    expect(r2.ok).toBe(true);
    expect(existing.map((t) => t.id)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("id 与现有或同批冲突 → 拒绝且数组不变（原子性）", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    expect(applyTaskListOps(tasks, { add: [{ id: "t1", description: "x" }] }).ok).toBe(false);
    expect(
      applyTaskListOps(tasks, {
        add: [{ id: "n1", description: "x" }, { id: "n1", description: "y" }],
      }).ok,
    ).toBe(false);
    expect(tasks).toHaveLength(1);
  });

  it("description 为空 → 拒绝", () => {
    const tasks: TaskItem[] = [];
    const outcome = applyTaskListOps(tasks, { add: [{ description: "  " }] });
    expect(outcome.ok).toBe(false);
    expect(tasks).toHaveLength(0);
  });
});

describe("applyTaskListOps — update", () => {
  it("合并字段：description/status/dependsOn 更新，未提供字段不变", () => {
    const tasks: TaskItem[] = [
      makeTask({ id: "t1", description: "旧描述", guidance: "旧指导" }),
    ];
    const outcome = applyTaskListOps(tasks, {
      update: [{ id: "t1", description: "新描述", status: "in_progress", dependsOn: [] }],
    });
    expect(outcome.ok).toBe(true);
    expect(tasks[0]!.description).toBe("新描述");
    expect(tasks[0]!.status).toBe("in_progress");
    expect(tasks[0]!.guidance).toBe("旧指导");
  });

  it("update 空 description → 拒绝", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    const outcome = applyTaskListOps(tasks, { update: [{ id: "t1", description: "   " }] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("description 不能为空");
    expect(tasks[0]!.description).toBe("a"); // 原子性
  });

  it("update 的 prompt 映射到 TaskItem.guidance（与 add 同源，无双字段）", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    const outcome = applyTaskListOps(tasks, { update: [{ id: "t1", prompt: "从 validateToken 入手" }] });
    expect(outcome.ok).toBe(true);
    expect(tasks[0]!.guidance).toBe("从 validateToken 入手");
  });

  it("未知 id / 非法 status / 自环 / 悬空依赖 → 拒绝且数组不变", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    expect(applyTaskListOps(tasks, { update: [{ id: "nope", status: "completed" }] }).ok).toBe(false);
    expect(
      applyTaskListOps(tasks, { update: [{ id: "t1", status: "done" as TaskItem["status"] }] }).ok,
    ).toBe(false);
    expect(applyTaskListOps(tasks, { update: [{ id: "t1", dependsOn: ["t1"] }] }).ok).toBe(false);
    expect(applyTaskListOps(tasks, { update: [{ id: "t1", dependsOn: ["ghost"] }] }).ok).toBe(false);
    expect(tasks[0]!.status).toBe("pending");
  });
});

describe("applyTaskListOps — remove", () => {
  it("未知 id / in_progress → 拒绝", () => {
    const tasks: TaskItem[] = [
      makeTask({ id: "t1", description: "a" }),
      makeTask({ id: "t2", description: "b", status: "in_progress" }),
    ];
    expect(applyTaskListOps(tasks, { remove: [{ id: "ghost" }] }).ok).toBe(false);
    expect(applyTaskListOps(tasks, { remove: [{ id: "t2" }] }).ok).toBe(false);
    expect(tasks).toHaveLength(2);
  });

  it("删除后剥离依赖方的悬空 dependsOn，summary 说明剥离事实", () => {
    const tasks: TaskItem[] = [
      makeTask({ id: "t1", description: "a" }),
      makeTask({ id: "t2", description: "b", dependsOn: ["t1"] }),
      makeTask({ id: "t3", description: "c", dependsOn: ["t1"] }),
    ];
    const outcome = applyTaskListOps(tasks, { remove: [{ id: "t1" }] });
    expect(outcome.ok).toBe(true);
    expect(tasks.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(tasks[0]!.dependsOn).toEqual([]);
    expect(tasks[1]!.dependsOn).toEqual([]);
    if (outcome.ok) expect(outcome.summary).toContain("stripped removed ids from dependsOn");
  });
});

describe("applyTaskListOps — 依赖图校验", () => {
  it("更新使依赖成环（t1→t2→t1）→ 拒绝，原数组不被污染", () => {
    const tasks: TaskItem[] = [
      makeTask({ id: "t1", description: "a" }),
      makeTask({ id: "t2", description: "b", dependsOn: ["t1"] }),
    ];
    const outcome = applyTaskListOps(tasks, { update: [{ id: "t1", dependsOn: ["t2"] }] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("依赖成环");
    expect(tasks[0]!.dependsOn).toEqual([]);
  });

  it("同批 add 构造成环 → 拒绝", () => {
    const tasks: TaskItem[] = [];
    const outcome = applyTaskListOps(tasks, {
      add: [
        { id: "a", description: "a", dependsOn: ["b"] },
        { id: "b", description: "b", dependsOn: ["a"] },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(tasks).toHaveLength(0);
  });

  it("自环（add 的任务依赖自己）→ 拒绝", () => {
    const tasks: TaskItem[] = [];
    const outcome = applyTaskListOps(tasks, {
      add: [{ id: "a", description: "a", dependsOn: ["a"] }],
    });
    expect(outcome.ok).toBe(false);
    expect(tasks).toHaveLength(0);
  });
});

describe("applyTaskListOps — 通用语义", () => {
  it("空操作（无任何数组）→ 拒绝并给出指引", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    const outcome = applyTaskListOps(tasks, {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("add / update / remove 至少提供一个");
  });

  it("成功后保持原数组引用（原地修改，调用方持有同一份）", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    const ref = tasks;
    const outcome = applyTaskListOps(tasks, { add: [{ description: "b" }] });
    expect(outcome.ok).toBe(true);
    expect(tasks).toBe(ref);
    expect(tasks).toHaveLength(2);
  });

  it("summary 含 added/updated 计数与当前清单渲染（自动 id 用真实值，不用占位符）", () => {
    const tasks: TaskItem[] = [makeTask({ id: "t1", description: "a" })];
    const outcome = applyTaskListOps(tasks, {
      add: [{ description: "b" }],
      update: [{ id: "t1", status: "completed" }],
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.summary).toContain("added t2");
      expect(outcome.summary).not.toContain("(auto)");
      expect(outcome.summary).toContain("updated t1");
      expect(outcome.summary).toContain("[completed] t1");
    }
  });
});

describe("formatTaskList", () => {
  it("渲染状态/id/描述/依赖，超过 40 个截断标注", () => {
    const tasks: TaskItem[] = [
      makeTask({ id: "t1", description: "做 A", status: "completed" }),
      makeTask({ id: "t2", description: "做 B", dependsOn: ["t1"] }),
    ];
    const text = formatTaskList(tasks);
    expect(text).toContain("[completed] t1: 做 A");
    expect(text).toContain("[pending] t2: 做 B (dependsOn: t1)");

    const many: TaskItem[] = Array.from({ length: 45 }, (_, i) =>
      makeTask({ id: `t${i + 1}`, description: `任务${i + 1}` }),
    );
    expect(formatTaskList(many)).toContain("共 45 个任务，仅显示前 40 个");
  });
});
