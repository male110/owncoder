import { describe, expect, it } from "vitest";
import {
  appendGeneratedFileLinks,
  collectGeneratedFiles,
  formatGeneratedFileLinks,
} from "./generated-files.ts";

const tool = (toolName: string, content: string) => ({ role: "tool", toolName, content });

describe("collectGeneratedFiles", () => {
  it("提取 write_file / apply_patch / append_file 结果中的路径并保持顺序", () => {
    const turns = [
      tool("write_file", "Wrote docs/requirement.md (1200 chars) - created"),
      tool("apply_patch", "Patched src/app.ts (3 changes)"),
      tool("append_file", "Appended to logs/run.log (added 10 chars, total now 20 bytes)"),
    ];
    expect(collectGeneratedFiles(turns)).toEqual([
      "docs/requirement.md",
      "src/app.ts",
      "logs/run.log",
    ]);
  });

  it("提取 save_spec / save_design / save_tasks / save_plan / save_experience 的文档路径", () => {
    const turns = [
      tool("save_spec", "Spec saved to docs/login-requirement.md.\nThis phase now PAUSES for the user's review"),
      tool("save_design", "Design saved to docs/login-design.md."),
      tool("save_tasks", "Tasks saved to .owncoder/specs/sessions/hash/login/tasks.md."),
      tool("save_plan", "Saved plan: .owncoder/plans/p1.md"),
      tool("save_experience", "Experience saved to .owncoder/experiences/e1.md."),
    ];
    expect(collectGeneratedFiles(turns)).toEqual([
      "docs/login-requirement.md",
      "docs/login-design.md",
      ".owncoder/specs/sessions/hash/login/tasks.md",
      ".owncoder/plans/p1.md",
      ".owncoder/experiences/e1.md",
    ]);
  });

  it("失败结果与非写文件工具不产生链接；重复路径去重", () => {
    const turns = [
      tool("write_file", "Error: write_file requires non-empty content"),
      tool("read_file", "Wrote nothing (this is a read result)"),
      tool("write_file", "Wrote src/a.ts (5 chars) - created"),
      tool("write_file", "Wrote src/a.ts (8 chars) - overwritten"),
    ];
    expect(collectGeneratedFiles(turns)).toEqual(["src/a.ts"]);
  });

  it("Windows 反斜杠路径归一为正斜杠", () => {
    const turns = [tool("write_file", "Wrote docs\\spec\\plan.md (3 chars) - created")];
    expect(collectGeneratedFiles(turns)).toEqual(["docs/spec/plan.md"]);
  });
});

describe("formatGeneratedFileLinks", () => {
  it("无文件时返回空串（不输出空链接列表）", () => {
    expect(formatGeneratedFileLinks([])).toBe("");
  });

  it("每行一个可点击的 Markdown 文件链接，并仅显示文件名", () => {
    const block = formatGeneratedFileLinks(["a.md", "src/b.ts", ".owncoder/specs/sessions/hash/feature/requirement.md"]);
    expect(block).toBe("### 📄 生成文件\n- [a.md](a.md)\n- [b.ts](src/b.ts)\n- [requirement.md](.owncoder/specs/sessions/hash/feature/requirement.md)");
  });
});

describe("appendGeneratedFileLinks", () => {
  const block = formatGeneratedFileLinks(["a.md"]);

  it("空链接块不改动原文", () => {
    expect(appendGeneratedFileLinks("报告", "")).toBe("报告");
  });

  it("链接块追加在生成结果之后", () => {
    expect(appendGeneratedFileLinks("已完成修改", block)).toBe(`已完成修改\n\n${block}`);
  });

  it("plan_saved 标记前插入，避免渲染端剥离标记时裁掉链接", () => {
    const text = "计划已生成\n\n<!--plan_saved:/plans/p1.md-->";
    const out = appendGeneratedFileLinks(text, block);
    expect(out.endsWith("<!--plan_saved:/plans/p1.md-->")).toBe(true);
    expect(out).toBe(`计划已生成\n\n${block}\n\n<!--plan_saved:/plans/p1.md-->`);
  });

  it("重复调用不追加重复链接块", () => {
    const once = appendGeneratedFileLinks("报告", block);
    expect(appendGeneratedFileLinks(once, block)).toBe(once);
  });
});
