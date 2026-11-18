import { describe, expect, it } from "vitest";
import { PARALLEL_SAFE_TOOLS, allEnhancedTools } from "./enhanced-tools.ts";

/**
 * 探索外包契约（ZCode 式）：主 executor 循环（delegateExploration）不注册
 * 任何发现类搜索工具——定位文件/符号/调用链/外部资料必须走 dispatch_agent
 * （Explore 子代理），主循环只保留已知路径直读与执行工具。
 * 工具集在同一装配点过滤，模型可见列表、toolCtx.availableTools 执行边界、
 * run_script 嵌套调用三个口径同时收紧。
 */
const DISCOVERY_TOOLS = [
  "glob",
  "grep",
  "search_semantic",
  "search_symbols",
  "read_symbol",
  "read_outline",
  "repo_map",
  "graph_search",
  "project_deps",
  "web_search",
  "web_fetch",
  "lsp_diagnostics",
] as const;

const EXECUTION_TOOLS = [
  "read_file",
  "run_script",
  "bash",
  "apply_patch",
  "write_file",
  "append_file",
  "type_check",
  "dispatch_agent",
  "recall_history",
  "semantic_diff",
  "list_session_changes",
  "ask_user",
  "report_blocker",
] as const;

describe("探索外包：主 executor 工具集", () => {
  const names = allEnhancedTools({ mode: "agent", delegateExploration: true }).map((t) => t.function.name);

  it("不注册任何发现类搜索工具", () => {
    for (const name of DISCOVERY_TOOLS) {
      expect(names).not.toContain(name);
    }
  });

  it("保留执行必需工具：已知路径直读 / 编辑 / 验证 / 派发 / 自有改动审查", () => {
    for (const name of EXECUTION_TOOLS) {
      expect(names).toContain(name);
    }
  });

  it("read_file 仍在 run_script 之后（保留原频率顺序）", () => {
    expect(names.indexOf("run_script")).toBeLessThan(names.indexOf("read_file"));
  });
});

describe("探索外包不影响其他装配路径", () => {
  it("默认装配（不传 delegateExploration）保留全部发现类工具", () => {
    const names = allEnhancedTools({ mode: "agent" }).map((t) => t.function.name);
    for (const name of DISCOVERY_TOOLS) {
      expect(names).toContain(name);
    }
  });

  it("Explore 子代理循环（exploreLoop）仍解析出白名单所需的全部搜索工具", () => {
    const names = allEnhancedTools({ mode: "agent", exploreLoop: true }).map((t) => t.function.name);
    for (const name of DISCOVERY_TOOLS) {
      expect(names).toContain(name);
    }
    expect(names).toContain("submit_report");
    expect(names).not.toContain("submit_plan");
  });

  it("spec 模式默认装配不变（explore_tools 阶段保持内联探索）", () => {
    const specNames = allEnhancedTools({ mode: "spec" }).map((t) => t.function.name);
    expect(specNames).toContain("grep");
    expect(specNames).toContain("read_outline");
    expect(specNames).toContain("web_search");
  });
});

describe("并行派发", () => {
  it("dispatch_agent 属于并行安全集合：一批可并发多个 Explore 子循环", () => {
    expect(PARALLEL_SAFE_TOOLS.has("dispatch_agent")).toBe(true);
  });
});
