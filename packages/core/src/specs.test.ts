import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTasksFromMarkdown } from "./plans.ts";
import { featureDirRel, saveDesign, saveSpec, saveTasks, validateDesignContent, validateSpecContent, validateTasksContent } from "./specs.ts";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(join(tmpdir(), "owncoder-specs-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const SID = "s1";

const validSpec = [
  "# 需求：登录流程",
  "",
  "## 目标",
  "用户可以安全登录。",
  "",
  "## 用户故事",
  "- 作为用户，我希望登录后进入首页。",
  "",
  "## 需求",
  "- R1: WHEN 用户提交有效凭证 THE SYSTEM SHALL 完成登录并跳转首页",
  "- R2: WHEN 用户提交无效凭证 THE SYSTEM SHALL 提示错误且不跳转",
  "",
  "## 验收标准",
  "- 登录成功进入首页。",
].join("\n");

const validDesign = [
  "# 设计：登录流程",
  "",
  "## 架构",
  "会话层 + 认证服务。",
  "",
  "## 需求追踪矩阵",
  "| 需求 | 设计章节 |",
  "| --- | --- |",
  "| R1 | 登录流程 |",
  "| R2 | 错误提示 |",
].join("\n");

const validTasks = [
  "# 任务：登录流程",
  "",
  "- [ ] 实现登录流程",
  "  - 依赖: 无",
  "  - 文件: src/login.ts",
  "  - 实现: 登录主流程",
  "  - 验收: 登录成功进入首页",
  "  - 需求: R1",
  "- [ ] 实现错误提示",
  "  - 依赖: task_1",
  "  - 文件: src/login.ts",
  "  - 实现: 错误提示分支",
  "  - 验收: 无效凭证提示错误",
  "  - 需求: R2",
].join("\n");

describe("validateSpecContent", () => {
  it("接受纯需求文档", () => {
    expect(() => validateSpecContent(validSpec)).not.toThrow();
  });

  it("拒绝空文档", () => {
    expect(() => validateSpecContent("   \n  ")).toThrow(/empty/i);
  });

  it("接受不带固定编号或 EARS 句式的自然语言需求", () => {
    expect(() => validateSpecContent("# 需求\n\n用户需要在登录失败时看到清晰提示。")).not.toThrow();
  });

  it("支持 FR 编号并允许设计追踪", () => {
    expect(() => validateSpecContent("# 需求\n\n- FR1: 用户可以登录\n- R2: 管理员可以退出登录")).not.toThrow();
    expect(() => validateDesignContent("# 设计\n\nFR1 在认证模块实现，R2 在会话模块实现。", "FR1: 用户可以登录\nR2: 管理员可以退出登录")).not.toThrow();
  });

  it("中文 feature 使用 docs 根目录扁平文件名", async () => {
    await saveSpec(root, "养生馆", "# 需求\n\n用户可以预约课程。", SID);
    await saveDesign(root, "养生馆", "# 设计\n\n## 预约流程\n预约服务接收课程请求，并调用课程模块完成预约。", SID);
    expect(await fs.readFile(join(root, "docs/养生馆-requirement.md"), "utf8")).toContain("预约课程");
    expect(await fs.readFile(join(root, "docs/养生馆-design.md"), "utf8")).toContain("预约服务");
  });

  it("拒绝重复需求编号", () => {
    const dup = validSpec.replace("- R2:", "- R1:");
    expect(() => validateSpecContent(dup)).toThrow(/duplicated/i);
  });

  it("拒绝混入技术设计章节", () => {
    const tech = `${validSpec}\n\n## 架构\n\n分层架构。\n`;
    expect(() => validateSpecContent(tech)).toThrow(/pure requirements/i);
  });

  it("拒绝混入接口签名", () => {
    const tech = `${validSpec}\n\n\`\`\`ts\ninterface LoginRequest { user: string }\n\`\`\`\n`;
    expect(() => validateSpecContent(tech)).toThrow(/technical design/i);
  });

  it("拒绝混入文件实现清单", () => {
    const tech = `${validSpec}\n\n- src/login.ts: 登录实现\n`;
    expect(() => validateSpecContent(tech)).toThrow(/technical design/i);
  });
});

describe("validateDesignContent", () => {
  it("接受带追踪矩阵和中文技术设计的设计", () => {
    expect(() => validateDesignContent(validDesign, validSpec)).not.toThrow();
  });

  it("接受英文技术设计和不同标题表达", () => {
    const design = [
      "# Design",
      "## System components",
      "The authentication module calls the session API and stores a session data model.",
      "## Requirement mapping",
      "R1 is handled by authentication; R2 returns an error response.",
    ].join("\n");
    expect(() => validateDesignContent(design, "R1: Login\nR2: Invalid credentials")).not.toThrow();
  });

  it("拒绝只有需求追踪而没有技术设计内容", () => {
    const traceOnly = "# 设计\n\n## 需求追踪矩阵\n| R1 | R1 |\n| R2 | R2 |";
    expect(() => validateDesignContent(traceOnly, validSpec)).toThrow(/substantive technical design/i);
  });

  it("拒绝空文档", () => {
    expect(() => validateDesignContent(" ")).toThrow(/empty/i);
  });

  it("拒绝缺少需求引用", () => {
    expect(() => validateDesignContent("# 设计\n\n只有架构描述。", validSpec)).toThrow(/R1/i);
  });

  it("拒绝未知需求编号", () => {
    const unknown = validDesign.replace("R2", "R9");
    expect(() => validateDesignContent(unknown, validSpec)).toThrow(/unknown/i);
  });

  it("拒绝缺失需求覆盖", () => {
    const missing = validDesign.replace("| R2 | 错误提示 |", "");
    expect(() => validateDesignContent(missing, validSpec)).toThrow(/does not cover/i);
  });
});

describe("validateTasksContent", () => {
  it("接受 Kiro 风格任务列表", () => {
    expect(() => validateTasksContent(validTasks, validDesign)).not.toThrow();
  });

  it("拒绝空文档", () => {
    expect(() => validateTasksContent("")).toThrow(/empty/i);
  });

  it("拒绝无 checkbox 任务", () => {
    expect(() => validateTasksContent("# 任务\n\n1. 先做登录\n2. 再做提示\n", validDesign)).toThrow(/checkbox/i);
  });

  it("拒绝任务字段缺失", () => {
    const missing = validTasks.replace("  - 验收: 登录成功进入首页\n", "");
    expect(() => validateTasksContent(missing, validDesign)).toThrow(/missing required fields.*verification/i);
  });

  it("拒绝未知需求引用", () => {
    const unknown = validTasks.replace("需求: R1", "需求: R7");
    expect(() => validateTasksContent(unknown, validDesign)).toThrow(/unknown/i);
  });

  it("拒绝未覆盖设计中的需求", () => {
    const missing = validTasks.split("\n").filter((l) => !l.includes("R2") && l !== "- [ ] 实现错误提示" && !l.includes("错误提示分支") && !l.includes("无效凭证提示错误")).join("\n");
    expect(() => validateTasksContent(missing, validDesign)).toThrow(/does not cover/i);
  });
});

describe("三阶段落盘校验", () => {
  it("有效三阶段文档全部落盘", async () => {
    await saveSpec(root, "login", validSpec, SID);
    await saveDesign(root, "login", validDesign, SID);
    await saveTasks(root, "login", validTasks, SID);
    const privateDir = join(root, featureDirRel("login", SID));
    expect(await fs.readFile(join(root, "docs/login-requirement.md"), "utf8")).toBeTruthy();
    expect(await fs.readFile(join(root, "docs/login-design.md"), "utf8")).toBeTruthy();
    expect(await fs.readFile(join(privateDir, "tasks.md"), "utf8")).toBeTruthy();
  });

  it("需求阶段拒绝技术内容，不落盘", async () => {
    await expect(saveSpec(root, "login", `${validSpec}\n\n## 架构\n分层。\n`, SID)).rejects.toThrow(/pure requirements/i);
    await expect(fs.access(join(root, "docs/login-requirement.md"))).rejects.toThrow();
  });

  it("设计阶段拒绝缺失追踪，不落盘", async () => {
    await saveSpec(root, "login", validSpec, SID);
    const missing = validDesign.replace("| R2 | 错误提示 |", "");
    await expect(saveDesign(root, "login", missing, SID)).rejects.toThrow(/does not cover/i);
    await expect(fs.access(join(root, "docs/login-design.md"))).rejects.toThrow();
  });

  it("设计阶段拒绝只有需求追踪的内容，不落盘", async () => {
    await saveSpec(root, "login", validSpec, SID);
    const traceOnly = "# 设计\n\n## 需求追踪矩阵\n| R1 | 已覆盖 |\n| R2 | 已覆盖 |";
    await expect(saveDesign(root, "login", traceOnly, SID)).rejects.toThrow(/substantive technical design/i);
    await expect(fs.access(join(root, "docs/login-design.md"))).rejects.toThrow();
  });

  it("任务阶段拒绝字段缺失，不落盘", async () => {
    await saveSpec(root, "login", validSpec, SID);
    await saveDesign(root, "login", validDesign, SID);
    const missing = validTasks.replace("  - 依赖: 无\n", "");
    await expect(saveTasks(root, "login", missing, SID)).rejects.toThrow(/missing required fields/i);
    await expect(fs.access(join(root, featureDirRel("login", SID), "tasks.md"))).rejects.toThrow();
  });
});

describe("与计划执行接口兼容", () => {
  it("Kiro 风格 tasks.md 可被 parseTasksFromMarkdown 解析为可执行任务", () => {
    const tasks = parseTasksFromMarkdown(validTasks);
    expect(tasks.length).toBe(2);
    expect(tasks[0]!.id).toBe("task_1");
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[0]!.executionGuidance).toContain("实现登录流程");
    expect(tasks[0]!.executionGuidance).toContain("文件/模块: src/login.ts");
    expect(tasks[0]!.executionGuidance).toContain("需求: R1");
    expect(tasks[0]!.acceptance).toContain("登录成功进入首页");
    expect(tasks[1]!.dependsOn).toEqual(["task_1"]);
  });

  it("保留多行字段、显式依赖和 checkbox 状态", () => {
    const body = [
      "# 任务",
      "- [x] 准备数据",
      "  - 文件: data/seed.ts",
      "  - 实现: 创建测试数据",
      "    并保证重复运行幂等",
      "  - 验收: 脚本可重复执行",
      "  - 需求: R1",
      "- [ ] 执行迁移",
      "  - 依赖: task_1",
      "  - 文件: db/migrate.ts",
      "  - 实现: 应用迁移",
      "  - 验收: 数据库结构正确",
      "  - 需求: R2",
    ].join("\n");
    const tasks = parseTasksFromMarkdown(body);
    expect(tasks[0]!.status).toBe("completed");
    expect(tasks[0]!.executionGuidance).toContain("并保证重复运行幂等");
    expect(tasks[1]!.dependsOn).toEqual(["task_1"]);
    expect(tasks[1]!.acceptance).toBe("数据库结构正确");
  });
});
