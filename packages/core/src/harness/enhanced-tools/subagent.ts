import type { ToolDef } from "@owncoder/llm";

/**
 * dispatch_agent —— 把子任务派发给独立子智能体。
 *
 * 子智能体在隔离的上下文里运行自己的 agent 循环：它的 glob/grep 搜索
 * 命中与整文件内容只留在自己的上下文，父智能体只收到最终结论文本。
 * 探索外包架构下这是 executor 的唯一探索入口：主循环不注册任何发现类
 * 搜索工具，定位文件/符号/调用链/外部资料都必须派发 Explore。
 *
 * 「探索不跑题」的第一道防线在委派侧而非子代理侧（对齐 Codex 的
 * well-scoped delegation）：子代理的范围完全由 task 措辞决定，因此
 * 工具描述要求点名锚点、声明 in-scope 文件、把任务收窄到下一步需要
 * 的具体产出，并禁止重复派发已有 path:line 引用答案的问题。
 */
export const DISPATCH_AGENT_TOOL_DEF: ToolDef = {
  type: "function",
  readOnly: true,
  function: {
    name: "dispatch_agent",
    description:
      "Dispatch a read-only research task to a subagent that runs in an isolated context. " +
      "The subagent runs in an isolated context: its search hits and full-file reads stay there, and only its final report returns to this context. " +
      "This is your only exploration path: you have no search tools of your own (no grep/glob/symbol search, no web search). " +
      "Dispatch \"Explore\" whenever a fact you need is not already established in context — locating files, finding symbols, tracing call chains, or looking up external errors/docs. " +
      "It reads excerpts rather than whole files, so it locates code and evidence; it does not review or audit code. " +
      "The subagent is read-only: implementation work cannot be delegated. " +
      "Use read_file only for paths already established (edit targets, plan references, Explore report citations); never dispatch as a pre-flight before an edit whose site is already known. " +
      "Designing the brief — the subagent's scope comes entirely from how you word the `task`, so narrow the ask to the concrete output you need next: " +
      "name the anchors you already know (exact symbols, file paths, identifiers) so it goes straight there instead of searching; " +
      "declare the in-scope files or modules when the question touches a broad area, since anything you leave unnamed may be treated as out of scope; " +
      "make the brief concrete and self-contained and state what the answer must establish. " +
      "Do not duplicate work: when a returned Explore report already establishes a fact with path:line citations, act on those citations instead of dispatching the same question again. " +
      "Keep each brief tight and scoped: one deliverable per dispatch — a research or review assignment that ends in a single report is ONE consolidated brief enumerating all its unknowns (locate, read, then audit stays one dispatch); do not split it into parallel briefs that re-search the same entry points and merge back into one report. " +
      "Dispatch parallel subagents only for genuinely independent questions with disjoint areas and separate deliverables.",
    parameters: {
      type: "object",
      properties: {
        agent_type: {
          type: "string",
          enum: ["Explore"],
          description: 'Subagent type. "Explore" (read-only codebase research). Default "Explore". "Planner" is unavailable here — it is only invoked by the task-decompose stage.',
        },
        task: {
          type: "string",
          description:
            "The concrete research question or search request for the subagent. Include exact symbols, file paths, or identifiers when known, and what the answer must establish. " +
            "Name the in-scope files or modules when the question touches a broad area — the subagent goes there directly and treats the rest of the repository as out of scope.",
        },
        relevantHistory: {
          type: "string",
          description:
            "Optional. The relevant history produced by the task-decompose step (the decompose output's relevantHistory field). " +
            "It is passed to the subagent as background evidence only; never substitute other content. " +
            "Omit it when the task-decompose step produced none — the existing automatic injection and fallback stay unchanged.",
        },
        continueAgentId: {
          type: "string",
          description:
            "Optional. Continue a previously dispatched Explore agent with its context intact — its prior reads, tool results, and findings stay in its context, so follow-up questions build on them without re-searching. " +
            "The id is printed at the end of that agent's report. Only Explore agents can be continued; never combine it with a different agent_type or with relevantHistory substitution. " +
            "Threads live for one parent turn; an unknown id is refused rather than silently starting fresh.",
        },
      },
      required: ["task"],
    },
  },
};
