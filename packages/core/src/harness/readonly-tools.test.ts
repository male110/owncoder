import { describe, expect, it } from "vitest";
import { READONLY_TOOLS, allEnhancedTools } from "./enhanced-tools.ts";

/**
 * READONLY_TOOLS 现在建表自各工具定义的 readOnly 标记。这套测试锁住两件
 * 旧手写名单出过的事故：死别名 search_code（循环检查前已被 parser 归一化，
 * 永远匹配不上），以及漏掉 list_specs / list_sdd / list_memories /
 * list_session_changes（调其中任意一个会清零只读迭代计数，卡住的探索
 * 检测不到）。
 */
describe("READONLY_TOOLS 由工具定义派生", () => {
  it("覆盖清单类只读工具（旧名单漏掉的四个）", () => {
    expect(READONLY_TOOLS.has("list_specs")).toBe(true);
    expect(READONLY_TOOLS.has("list_sdd")).toBe(true);
    expect(READONLY_TOOLS.has("list_memories")).toBe(true);
    expect(READONLY_TOOLS.has("list_session_changes")).toBe(true);
  });

  it("不含死别名与有副作用的工具", () => {
    // search_code 在进入只读判定前已被 parser 归一化为 search_symbols
    expect(READONLY_TOOLS.has("search_code")).toBe(false);
    for (const name of [
      "bash",
      "run_script",
      "write_file",
      "apply_patch",
      "save_spec",
      "save_design",
      "save_tasks",
      "save_experience",
      "save_memory",
      "update_memory",
      "forget_memory",
      "undo_session_change",
      "type_check",
      "analyze_issue",
      "ask_user",
      "use_skill",
      "report_blocker",
      "git_status",
      "lsp_go_to_definition",
      "lsp_find_references",
      "lsp_hover",
      "lsp_code_actions",
    ]) {
      expect(READONLY_TOOLS.has(name)).toBe(false);
    }
  });

  it("清单中标记 readOnly 的工具全部在集合里，且数量符合预期（19 个内置只读工具）", () => {
    const marked = allEnhancedTools({ mode: "agent" })
      .filter((t) => t.readOnly)
      .map((t) => t.function.name);
    for (const name of marked) {
      expect(READONLY_TOOLS.has(name)).toBe(true);
    }
    expect(READONLY_TOOLS.size).toBe(19);
  });
});

/**
 * 工具顺序是产品行为，不是实现细节：受控搜索应排在脚本之前，
 * 让模型优先使用跨平台且自动遵守 .gitignore 的搜索工具。
 */
describe("工具列表顺序：受控搜索优先于 run_script", () => {
  const names = (mode: "agent" | "spec", opts?: Record<string, unknown>) =>
    allEnhancedTools({ mode, ...opts }).map((t) => t.function.name);

  it("两种模式下 grep、glob、search_symbols 排在 run_script 之前", () => {
    for (const mode of ["agent", "spec"] as const) {
      expect(names(mode).slice(0, 3)).toEqual(["glob", "grep", "search_symbols"]);
    }
    expect(names("agent")[3]).toBe("run_script");
  });

  it("agent 模式在搜索和脚本后提供 read_file / bash / apply_patch", () => {
    expect(names("agent").slice(4, 7)).toEqual(["read_file", "bash", "apply_patch"]);
  });

  it("spec 模式写工具降级为 plan_* 变体，仍在编辑位置", () => {
    const specNames = names("spec", { allowSpecFiles: true, planBashReadonly: true });
    expect(specNames.slice(4, 7)).toEqual(["read_file", "bash", "apply_patch"]);
    // plan_* 变体与 agent 原生版同名，覆盖同一槽位
    expect(specNames.filter((n) => n === "write_file").length).toBe(1);
    expect(specNames.filter((n) => n === "append_file").length).toBe(1);
  });

  it("关闭开关时对应工具从列表消失，其余顺序不变", () => {
    const closed = names("agent", { allowBash: false, enableLsp: false, enableWebSearch: false });
    expect(closed.slice(0, 4)).toEqual(["glob", "grep", "search_symbols", "run_script"]);
    expect(closed.slice(4, 6)).toEqual(["read_file", "apply_patch"]);
    expect(closed).not.toContain("bash");
    expect(closed).not.toContain("lsp_diagnostics");
    expect(closed).not.toContain("web_search");
    expect(closed).not.toContain("web_fetch");
  });

  it("受控搜索工具出现在两种模式，内部 list_dir 仍不暴露", () => {
    for (const mode of ["agent", "spec"] as const) {
      const list = names(mode, { allowSpecFiles: true, planBashReadonly: true });
      expect(list).toContain("grep");
      expect(list).toContain("glob");
      expect(list).not.toContain("list_dir");
    }
  });
});
