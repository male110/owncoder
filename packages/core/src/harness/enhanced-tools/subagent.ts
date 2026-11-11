import type { ToolDef } from "@owncoder/llm";

/**
 * dispatch_agent —— 把子任务派发给独立子智能体。
 *
 * 子智能体在隔离的上下文里运行自己的 agent 循环：它的 glob/grep 搜索
 * 命中与整文件内容只留在自己的上下文，父智能体只收到最终结论文本。适合需要
 * 广泛翻阅多个文件/目录/命名约定、但只需要结论的只读调研。
 */
export const DISPATCH_AGENT_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "dispatch_agent",
    description:
      "Dispatch a read-only research task to an Explore subagent that runs in an isolated context. " +
      "The subagent runs in an isolated context: its search hits and full-file reads stay there, and only its final report returns to this context. " +
      "The subagent is read-only: implementation work cannot be delegated. " +
      "Do not dispatch Explore for a request resolvable with <=2 targeted reads, and never as a pre-flight before an edit whose site is already known.",
    parameters: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          enum: ["Explore"],
          description: 'Subagent type. Only "Explore" (read-only codebase research) is supported. Default "Explore".',
        },
        task: {
          type: "string",
          description:
            "The concrete research question or search request for the subagent. Include exact symbols, file paths, or identifiers when known, and what the answer must establish.",
        },
        thoroughness: {
          type: "string",
          enum: ["medium", "very thorough"],
          description: 'Search breadth. "medium" for likely-location-first exploration (default); "very thorough" only for cross-cutting questions whose answer genuinely spans multiple directories or naming conventions.',
        },
      },
      required: ["task"],
    },
  },
};
