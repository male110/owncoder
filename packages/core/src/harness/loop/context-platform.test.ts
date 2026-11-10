import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@owncoder/llm";
import type { BuildContextArgs } from "./context.ts";

vi.mock("../tools/shared.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/shared.ts")>()),
  IS_WINDOWS: true,
  PLATFORM: "win32",
  OS_RELEASE: "10.0.26200",
}));

import { buildInitialContext } from "./context.ts";

describe("平台和项目上下文", () => {
  it.each([true, false])("生成 Windows 平台信息和独立项目上下文（上下文启用：%s）", async (enabled) => {
    const messages: ChatMessage[] = [];
    const args = {
      opts: {
        workspaceRoot: process.cwd(),
        userMessage: "hello",
        mode: "agent",
        history: [],
        disableKnowledgeGraph: true,
        index: { status: () => ({ root: "E:\\owncoder", fileCount: 490, tagCount: 4232 }) },
        workflow: { context: { contextWindow: 128000, inputRatio: 80, segments: { historyRatio: 50, toolResultRatio: 40, techStackRatio: 10 } } },
      },
      memory: { getKnowledgeContext: () => "", getShortTermContext: () => "" },
      budgets: { total: 128000, system: 20000, plan: 20000, files: 20000, map: 20000 },
      systemPrompt: "",
      contextNode: { enabled, params: { contextSelection: false, injectAnchors: false } },
      anchorsNode: undefined,
      messages,
    } as unknown as BuildContextArgs;
    await buildInitialContext(args);
    const platform = messages.find((m) => typeof m.content === "string" && m.content.includes("<platform_info>"))?.content as string;
    const project = messages.find((m) => typeof m.content === "string" && m.content.includes("<project_context>"))?.content as string;
    expect(platform).toContain("- OS: Windows (win32)\n- Release: 10.0.26200\n- Path separator: `\\`");
    expect(platform).toContain("The current runtime environment is Windows. **Terminal commands are executed with PowerShell semantics; please use PowerShell syntax.**");
    expect(platform).not.toContain("run_script");
    expect(project).toContain("## Tool selection");
    expect(project).toContain("Call a single `grep`, `glob`, or `read_file` directly as a top-level tool call");
    expect(project).toContain("materially filter, aggregate, parse, or cross-match tool results");
    expect(project).toContain("Each `tools.call` inside `run_script` consumes a nested-call budget in addition to the outer call");
    expect(project).toContain("`run_script` executes JavaScript and is independent of the current project.");
    if (enabled) {
      expect(project).toContain("## Project Tech Stack");
      expect(project).toContain("## Project Size");
      expect(project.indexOf("## Project Size")).toBeLessThan(project.indexOf("## Tool selection"));
    }
  });
});
