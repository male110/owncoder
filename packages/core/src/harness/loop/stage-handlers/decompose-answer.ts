/**
 * Parsing and normalization of the decomposition LLM answer.
 *
 * Tolerant JSON extraction and task schema normalization. The decomposition
 * produces a set of execution tasks: a task is {id, title, description,
 * prompt, dependsOn} and reusable history sits at the top level
 * (relevantHistory), so even undecomposed turns keep their history. Legacy
 * outputs are tolerated on read — an older `nodes` array (same fields) and a
 * legacy `tasks` array are accepted, and their per-task `guidance`/`steps`
 * fold into `prompt`; legacy task-level relevantHistory folds up to the top
 * level.
 */

import { jsonrepair } from "jsonrepair";
import { generatePlan } from "../../agent-reasoning.ts";
import { isExplicitCodeChangeRequest, isCurrentCodeBehaviorInquiry, isPreciseLocatedRequest } from "./decompose-history.ts";

// ── Decompose Answer Parsing ───────────────────────────────────────

/**
 * Parsed shape of the decomposition answer: the user's intent, the limits the
 * user has set, and the execution tasks that follow from both. Each task
 * carries what to do (description), how to execute it (prompt), its kind, and
 * the other tasks it depends on — no detailed steps.
 */
interface DecomposeTask {
  id: string;
  title?: string;
  description: string;
  prompt: string;
  dependsOn?: string[];
  kind?: "implementation" | "verification";
  /** 仅供分解归一化判定：true 表示没有独立交付物的认知子步骤。 */
  cognitiveOnly?: boolean;
}

interface DecomposeAnswer {
  /** 用户意图目的（旧格式 understanding 兜底映射）。 */
  intent: string;
  userConstraints: string[];
  tasks: DecomposeTask[];
  /** 任务相关历史：与 tasks 同级；旧输出的任务级历史读时折叠到此处。 */
  relevantHistory: string;
}

/**
 * 本地兜底分解。
 * - intent：只用用户原话（截断保护），禁止把模型散文整段写入 intent
 * - 若有模型纯文本（解析失败时的 planText）：收成单个任务，避免丢弃有用内容
 * - 无模型纯文本（网络/中止等）：用本地 generatePlan 的启发式步骤描述
 *   拼成 prompt，保证兜底任务仍可执行
 * Exported for testing.
 */
export function buildFallbackRawDecompose(userMessage: string, modelPlainText?: string) {
  const seed = userMessage.trim() || "(empty request)";
  // 截断异常长输入，避免把整段粘贴内容当 intent 展示
  const intent = seed.length > 500 ? `${seed.slice(0, 500)}…` : seed;
  const prose = (modelPlainText ?? "").trim();

  if (prose) {
    // 保留模型纯文本作为单个任务；过长时截断，避免 UI/持久化膨胀
    const taskBody = prose.length > 8000 ? `${prose.slice(0, 8000)}…` : prose;
    return {
      intent,
      userConstraints: [] as string[],
      tasks: [{
        id: "task_1",
        description: taskBody,
        prompt: "Execute the model reply above directly.",
      }],
      relevantHistory: "",
    };
  }

  const plan = generatePlan(intent, "");
  const heuristic = plan.steps.map((step, index) => `${index + 1}. ${step.description}`).join("\n");
  return {
    intent,
    userConstraints: [] as string[],
    tasks: [{
      id: "task_1",
      description: intent,
      prompt: `Local heuristic plan (an approximation used when the decomposition call is unavailable):\n${heuristic}`,
    }],
    relevantHistory: "",
  };
}

/**
 * 模型把改码或查代码请求判成 discuss 并输出空任务时，按用户原话补回任务。
 * 任务只携带“做什么”（用户原话），不写“怎么读/怎么找/怎么验证”——执行端
 * 不被引导，按基础提示词的少读原则自行决定。精确定位请求（路径+行号/原文）
 * 不补：它自身已是完整指令，直接走执行端快速路径。
 * Exported for testing.
 */
export function recoverEmptyDecomposeTasks(
  answer: DecomposeAnswer,
  userMessage: string,
): DecomposeAnswer {
  if (answer.tasks.length > 0) return answer;
  if (isPreciseLocatedRequest(userMessage)) return answer;
  if (isExplicitCodeChangeRequest(userMessage)) {
    return {
      ...answer,
      intent: answer.intent || `The user asked to modify code directly: ${userMessage}`,
      tasks: [{
        id: "task_1",
        description: userMessage.trim() || "Apply the user's requested code change",
        prompt: "",
      }],
    };
  }
  if (isCurrentCodeBehaviorInquiry(userMessage)) {
    return {
      ...answer,
      intent: answer.intent || `The user asked how the current code or current step should be handled: ${userMessage}`,
      tasks: [{
        id: "task_1",
        description: userMessage.trim() || "Answer the user's question about the current implementation",
        prompt: "",
      }],
    };
  }
  return answer;
}

/**
 * 折叠「伪线性分解」：模型把一个单目标需求拆成认知阶段链
 * （定位 → 分析 → 输出结论），每个任务只是为下一个积累同一份理解，
 * 没有独立产物。整链无分叉、无 verification 任务时合成单个任务，
 * 原任务内容保留进 description/prompt，不丢信息。
 *
 * 触发条件（全部满足才折叠）：
 * 1. 任务数 ≥ 2；
 * 2. 除末任务外每个任务恰好一个后继，且后继只依赖前一个（无分叉线性链）；
 * 3. 无任何任务带 kind: "verification"；
 * 4. 每个任务都显式带 cognitiveOnly: true。字段缺失/为 false 时默认保留，
 *    避免将独立交付物串行链误合并。
 *
 * 真 DAG（分支/汇合、多交付物、含 verification）原样返回。
 * Exported for testing.
 */
export function collapsePseudoLinearTasks(answer: DecomposeAnswer): DecomposeAnswer {
  const { tasks } = answer;
  if (!tasks || tasks.length < 2) return answer;
  if (tasks.some((task) => task.kind === "verification")) return answer;
  if (tasks.some((task) => task.cognitiveOnly !== true)) return answer;

  // 每个任务的后继集合（被谁依赖）。线性链：首任务无前驱，末任务无后继，
  // 中间任务恰好一进一出，且后继的 dependsOn 只引用当前任务。
  const successors = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.dependsOn ?? []) {
      const list = successors.get(dep);
      if (list) list.push(task.id);
      else successors.set(dep, [task.id]);
    }
  }
  // 任一节点有多个后继（分叉）或多依赖（汇合）即非线性链。
  for (const ids of successors.values()) {
    if (ids.length > 1) return answer;
  }
  for (const task of tasks) {
    if ((task.dependsOn ?? []).length > 1) return answer;
  }
  // 首任务不得有前驱，其余任务必须恰好依赖链上的前一个。
  if ((tasks[0]!.dependsOn ?? []).length > 0) return answer;
  for (let i = 1; i < tasks.length; i++) {
    const deps = tasks[i]!.dependsOn ?? [];
    if (deps.length !== 1 || deps[0] !== tasks[i - 1]!.id) return answer;
  }

  const first = tasks[0]!;
  const mergedDescription = [
    answer.intent || first.title || first.description,
    `(merged from ${tasks.length} linear sub-tasks)`,
    ...tasks.map((task, index) => {
      const label = task.title?.trim() || `Part ${index + 1}`;
      return `- ${label}: ${task.description.trim()}`;
    }),
  ].join("\n");
  const mergedPrompt = tasks
    .map((task, index) => {
      const label = task.title?.trim() || `Part ${index + 1}`;
      const parts = [
        `- ${label}: ${task.description.trim()}`,
        task.prompt?.trim() ? `  note: ${task.prompt.trim()}` : "",
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n");

  return {
    ...answer,
    tasks: [{
      id: first.id,
      ...(first.title ? { title: first.title } : {}),
      description: mergedDescription,
      prompt: mergedPrompt,
      dependsOn: [],
    }],
  };
}

/** 把旧形状 steps[].description 折叠成 prompt 文本（读兼容）。 */
function promptFromSteps(rawSteps: unknown): string {
  if (!Array.isArray(rawSteps)) return "";
  return rawSteps.slice(0, 20)
    .map((step, index) => {
      const description = step && typeof step === "object"
        ? (step as Record<string, unknown>).description
        : "";
      return typeof description === "string" && description.trim()
        ? `${index + 1}. ${description.trim()}`
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Parse the answer. Tolerant by design — a malformed field degrades to a safe
 * default rather than failing the turn.
 *
 * Current shape: top-level `intent`, `userConstraints`, `tasks[{id, title,
 * description, prompt, dependsOn}]` and top-level `relevantHistory`.
 * Legacy shapes are normalized on read: an older `nodes` array (same fields)
 * and a legacy `tasks` array (whose items carry `guidance` instead of
 * `prompt`) are accepted; a top-level `steps` array (or bare JSON array) is
 * wrapped into a single task with the step descriptions folded into `prompt`;
 * a legacy `understanding` fills `intent`.
   * Removed legacy execution-state keys are ignored without migration.
 *
 * Exported for testing.
 */
export function parseDecomposeAnswer(text: string): DecomposeAnswer | null {
  // 防止无限循环：限制最大任务数
  const MAX_TASKS = 20;

  // 先剥 Markdown 围栏，再取 JSON；避免模型「解释 + ```json ... ```」时整段失败
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const normalized = fenced || text;

  const objectMatch = normalized.match(/\{[\s\S]*\}/);
  const arrayMatch = normalized.match(/\[[\s\S]*\]/);
  // Prefer whichever encloses the other: an object wrapping "tasks" starts before
  // the array it contains.
  const source =
    objectMatch && (!arrayMatch || objectMatch.index! < arrayMatch.index!)
      ? objectMatch[0]
      : arrayMatch?.[0];
  if (!source) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(jsonrepair(source));
  } catch {
    return null;
  }

  const obj = (Array.isArray(raw) ? {} : raw ?? {}) as Record<string, unknown>;
  // 明确失败不能被宽松解析器归一化成成功，也不把内部错误内容当作任务执行。
  if (obj.ok === false || obj.success === false || obj.status === "failed" || obj.status === "error" || obj.error) {
    return null;
  }
  if (![obj.tasks, obj.nodes, obj.steps, raw].some(Array.isArray)) return null;

  // 当前格式 tasks[] 优先（字段为 prompt/kind/dependsOn）；旧格式 nodes[]
  // （同字段）次之；更旧的 tasks[]（字段为 guidance）由下方字段折叠兼容；
  // 最旧的格式（顶层 steps / 裸数组）包成单个 task_1，步骤描述折叠进 prompt。
  const rawTasks: unknown[] = Array.isArray(obj.tasks)
    ? obj.tasks.slice(0, MAX_TASKS)
    : Array.isArray(obj.nodes)
      ? obj.nodes.slice(0, MAX_TASKS)
      : [{
          id: "task_1",
          description: "",
          prompt: promptFromSteps(Array.isArray(raw) ? raw : Array.isArray(obj.steps) ? obj.steps : []),
        }];

  const usedTaskIds = new Set<string>();
  const uniqueId = (base: string, used: Set<string>): string => {
    const seed = base || "task";
    if (!used.has(seed)) {
      used.add(seed);
      return seed;
    }
    let suffix = 2;
    while (used.has(`${seed}_${suffix}`)) suffix++;
    const id = `${seed}_${suffix}`;
    used.add(id);
    return id;
  };

  const tasks: DecomposeTask[] = rawTasks.flatMap((rawTask) => {
    const taskObj = (rawTask ?? {}) as Record<string, unknown>;
    const id = typeof taskObj.id === "string" && taskObj.id.trim() ? taskObj.id.trim() : "";
    const title = typeof taskObj.title === "string" && taskObj.title.trim()
      ? taskObj.title.trim()
      : undefined;
    const description = typeof taskObj.description === "string" ? taskObj.description.trim() : "";
    // prompt 优先；旧字段 guidance 读兼容；更旧的 steps 描述折叠进 prompt。
    let prompt = typeof taskObj.prompt === "string" ? taskObj.prompt.trim() : "";
    if (!prompt) {
      prompt = typeof taskObj.guidance === "string" ? taskObj.guidance.trim() : "";
    }
    if (!prompt) {
      prompt = promptFromSteps(Array.isArray(taskObj.steps) ? taskObj.steps : []);
    }
    const dependsOn = Array.isArray(taskObj.dependsOn)
      ? taskObj.dependsOn.filter((dep): dep is string => typeof dep === "string" && dep.trim() !== "")
          .map((dep) => dep.trim())
      : undefined;
    const kind = taskObj.kind === "implementation" || taskObj.kind === "verification"
      ? taskObj.kind
      : undefined;
    const cognitiveOnly = typeof taskObj.cognitiveOnly === "boolean"
      ? taskObj.cognitiveOnly
      : undefined;
    if (!description && !title && !prompt) return [];
    return [{
      id: uniqueId(id || `task_${usedTaskIds.size + 1}`, usedTaskIds),
      title,
      description,
      prompt,
      ...(dependsOn !== undefined ? { dependsOn } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(cognitiveOnly !== undefined ? { cognitiveOnly } : {}),
    }];
  });

  // 兼容旧格式：understanding 兜底填充 intent。
  const intent = typeof obj.intent === "string" && obj.intent.trim()
    ? obj.intent.trim()
    : typeof obj.understanding === "string" ? obj.understanding.trim() : "";

  // 有意的「无需计划」必须带有效意图；非空但完全不可用的任务列表仍属失败。
  const explicitTasks = Array.isArray(obj.tasks) ? obj.tasks : Array.isArray(obj.nodes) ? obj.nodes : undefined;
  if (tasks.length === 0 && (!intent || (explicitTasks && explicitTasks.length > 0))) return null;

  const topLevelConstraints = Array.isArray(obj.userConstraints)
    ? obj.userConstraints.map((c) => (typeof c === "string" ? c.trim() : "")).filter(Boolean)
    : [];
  // 当前格式历史与任务同级；旧格式（任务级 relevantHistory）折叠到顶层。
  const foldedHistory = rawTasks
    .map((rawTask) => {
      const taskObj = (rawTask ?? {}) as Record<string, unknown>;
      return typeof taskObj.relevantHistory === "string" ? taskObj.relevantHistory.trim() : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const relevantHistory =
    typeof obj.relevantHistory === "string" && obj.relevantHistory.trim()
      ? obj.relevantHistory.trim()
      : foldedHistory;
  return {
    intent,
    userConstraints: topLevelConstraints,
    tasks,
    relevantHistory,
  };
}
