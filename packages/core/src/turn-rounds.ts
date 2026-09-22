/**
 * Per-session turn rounds: user input + task decomposition + final report.
 *
 * Stored next to the session file as `.owncoder/sessions/{id}.rounds.json` so
 * deleting a chat session can drop the rounds file in the same step.
 *
 * This is the source of truth for the task_decompose stage's "recent rounds"
 * context. Chat history does not contain the decomposition JSON, so reading
 * history alone can never reconstruct it.
 */

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const SESSIONS_DIR = ".owncoder/sessions";
const FILE_VERSION = 1 as const;
const MAX_ROUNDS = 50;
const MAX_USER_INPUT_CHARS = 8_000;
const MAX_REPORT_CHARS = 16_000;
const MAX_UNDERSTANDING_CHARS = 4_000;
const MAX_STEP_DESCRIPTION_CHARS = 500;
const MAX_NEED_QUESTION_CHARS = 400;
const MAX_STEPS = 20;
const MAX_NEEDS_PER_STEP = 10;
const MAX_EVIDENCE_PER_ROUND = 200;
const MAX_FILE_CHANGES_PER_ROUND = 30;
const MAX_TOOL_CALLS_PER_ROUND = 100;
const MAX_FILE_CHANGE_PATH_CHARS = 500;
const MAX_FILE_CHANGE_SUMMARY_CHARS = 500;
const MAX_SUMMARY_CHARS = 300;
const SOURCE_READ_TOOLS = new Set(["read_file", "read_symbol", "read_outline"]);

/** 完整、可复用的文件证据；content 只在成功的结构化读取中保存。 */
export interface FileEvidence {
  path: string;
  content: string;
  contentHash: string;
  version: string;
  complete: boolean;
  capturedAt: string;
}

export interface Finding {
  id: string;
  summary: string;
  evidenceIds: string[];
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  stepId?: string;
  status: "started" | "completed" | "interrupted";
  createdAt: string;
}

export type TaskRelation = "continue" | "new";

export interface TaskState {
  taskId: string;
  relation: TaskRelation;
  goal: string;
  scope: string[];
  completedSteps: string[];
  pendingSteps: string[];
  fileEvidence: FileEvidence[];
  findings: Finding[];
  checkpoints: Checkpoint[];
  /** 统一执行状态；旧持久化数据可能缺失，读取时按可选处理。 */
  runState?: import("./task-run.ts").TaskRunState;
}

export interface PersistedEvidence {
  needId: string;
  summary: string;
  kind?: "source" | "navigation";
  path?: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  excerpt?: string;
  sourceHash?: string;
  /** 原始读取内容及完整性，支持续接时直接复用而非按路径重读。 */
  fileEvidence?: FileEvidence;
}

export interface PersistedDecompose {
  understanding: string;
  relevantHistory?: string;
  /** 原任务目标和范围必须显式保留，不能只依赖 understanding。 */
  goal?: string;
  scope?: string[];
  relation?: TaskRelation;
  completedSteps?: string[];
  pendingSteps?: string[];
  findings?: Finding[];
  checkpoints?: Checkpoint[];
  userConstraints: string[];
  steps: Array<{
    id: string;
    description: string;
    dependsOn: string[];
    informationNeeds: Array<{
      id: string;
      question: string;
      source?: "file" | "search" | "command";
      priority?: "blocking" | "important" | "nice-to-have";
      fallback?: string;
    }>;
    stopReadingWhen: Array<{ condition: string; requiredEvidenceIds: string[] }>;
    verificationCriteria?: {
      command: string;
      expectedOutput: string;
      exitCode?: number;
    };
    rollbackStrategy?: string;
    estimatedComplexity?: "low" | "medium" | "high";
  }>;
  progressStatus?: string;
  /** 跨新任务共享，但不继承执行状态的证据池。 */
  sharedEvidence?: FileEvidence[];
}

export interface PersistedFileChange {
  toolName: string;
  path?: string;
  summary: string;
}

export interface PersistedToolCall {
  id?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: string;
}

export interface TurnRoundRecord {
  index: number;
  createdAt: string;
  updatedAt: string;
  userInput: string;
  taskDecompose?: PersistedDecompose;
  assistantReport?: string;
  evidence?: PersistedEvidence[];
  fileChanges?: PersistedFileChange[];
  toolCalls?: PersistedToolCall[];
}

interface TurnRoundsFile {
  version: 1;
  sessionId: string;
  rounds: TurnRoundRecord[];
}

const writeQueues = new Map<string, Promise<unknown>>();

function sessionsDirAbs(workspaceRoot: string): string {
  return resolve(workspaceRoot, SESSIONS_DIR);
}

export function roundsFilePath(workspaceRoot: string, sessionId: string): string {
  return join(sessionsDirAbs(workspaceRoot), `${sessionId}.rounds.json`);
}

export function isSafeSessionId(sessionId: string): boolean {
  return (
    sessionId.length > 0 &&
    sessionId.length < 128 &&
    !/[\\/]/.test(sessionId) &&
    !sessionId.includes("..")
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function queueKey(workspaceRoot: string, sessionId: string): string {
  return `${workspaceRoot}::${sessionId}`;
}

function withSessionLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

function emptyFile(sessionId: string): TurnRoundsFile {
  return { version: FILE_VERSION, sessionId, rounds: [] };
}

function sanitizeDecompose(raw: unknown): PersistedDecompose | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const understanding =
    typeof obj.understanding === "string" ? clip(obj.understanding.trim(), MAX_UNDERSTANDING_CHARS) : "";
  const userConstraints = Array.isArray(obj.userConstraints)
    ? obj.userConstraints
        .filter((c): c is string => typeof c === "string")
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const rawSteps = Array.isArray(obj.steps) ? obj.steps.slice(0, MAX_STEPS) : [];
  const steps: PersistedDecompose["steps"] = rawSteps.flatMap((step, i) => {
    if (!step || typeof step !== "object") return [];
    const s = step as Record<string, unknown>;
    const description = typeof s.description === "string" ? clip(s.description.trim(), MAX_STEP_DESCRIPTION_CHARS) : "";
    if (!description) return [];
    const relevantHistory =
      typeof s.relevantHistory === "string" && s.relevantHistory.trim()
        ? clip(s.relevantHistory.trim(), MAX_UNDERSTANDING_CHARS)
        : undefined;
    const informationNeeds: PersistedDecompose["steps"][number]["informationNeeds"] = Array.isArray(s.informationNeeds)
      ? s.informationNeeds
          .slice(0, MAX_NEEDS_PER_STEP)
          .flatMap((need, ni) => {
            if (!need || typeof need !== "object") return [];
            const n = need as Record<string, unknown>;
            const question = typeof n.question === "string" ? clip(n.question.trim(), MAX_NEED_QUESTION_CHARS) : "";
            if (!question) return [];
            const id = typeof n.id === "string" && n.id.trim() ? n.id.trim() : `need_${ni + 1}`;
            const source = n.source === "file" ? "file" : n.source === "search" ? "search" : n.source === "command" ? "command" : undefined;
            const priority = n.priority === "blocking" ? "blocking" : n.priority === "important" ? "important" : n.priority === "nice-to-have" ? "nice-to-have" : undefined;
            const fallback = typeof n.fallback === "string" ? n.fallback.trim() : "";
            return [{
              id,
              question,
              source,
              priority,
              fallback: fallback || undefined,
            }];
          })
      : [];
    const stopReadingWhen = Array.isArray(s.stopReadingWhen)
      ? s.stopReadingWhen.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const c = item as Record<string, unknown>;
          const condition = typeof c.condition === "string" ? c.condition.trim() : "";
          const requiredEvidenceIds = Array.isArray(c.requiredEvidenceIds)
            ? c.requiredEvidenceIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
            : [];
          if (!condition || !requiredEvidenceIds.length) return [];
          return [{ condition, requiredEvidenceIds: [...new Set(requiredEvidenceIds)] }];
        })
      : [];
    return [
      {
        id: typeof s.id === "string" && s.id.trim() ? s.id.trim() : `step_${i + 1}`,
        description,
        dependsOn: Array.isArray(s.dependsOn)
          ? s.dependsOn.filter((d): d is string => typeof d === "string")
          : [],
        informationNeeds,
        stopReadingWhen,
        verificationCriteria: (() => {
          if (!s.verificationCriteria || typeof s.verificationCriteria !== "object") return undefined;
          const vc = s.verificationCriteria as Record<string, unknown>;
          if (typeof vc.command !== "string" || typeof vc.expectedOutput !== "string") return undefined;
          const command = vc.command.trim();
          const expectedOutput = vc.expectedOutput.trim();
          if (!command || !expectedOutput) return undefined;
          return {
            command,
            expectedOutput,
            exitCode: typeof vc.exitCode === "number" ? vc.exitCode : undefined,
          };
        })(),
        rollbackStrategy: typeof s.rollbackStrategy === "string"
          ? s.rollbackStrategy.trim() || undefined
          : undefined,
        estimatedComplexity: s.estimatedComplexity === "low" || s.estimatedComplexity === "medium" || s.estimatedComplexity === "high"
          ? s.estimatedComplexity
          : undefined,
        relevantHistory,
      },
    ];
  });
  if (!understanding && steps.length === 0) return undefined;
  const progressStatus =
    typeof obj.progressStatus === "string" && obj.progressStatus.trim()
      ? clip(obj.progressStatus.trim(), 500)
      : undefined;
  return {
    understanding,
    relevantHistory:
      typeof obj.relevantHistory === "string" && obj.relevantHistory.trim()
        ? clip(obj.relevantHistory.trim(), MAX_UNDERSTANDING_CHARS)
        : undefined,
    userConstraints, steps, progressStatus,
    goal: typeof obj.goal === "string" ? clip(obj.goal.trim(), MAX_UNDERSTANDING_CHARS) : undefined,
    scope: Array.isArray(obj.scope) ? obj.scope.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 50) : undefined,
    relation: obj.relation === "continue" ? "continue" : obj.relation === "new" ? "new" : undefined,
    completedSteps: Array.isArray(obj.completedSteps) ? obj.completedSteps.filter((x): x is string => typeof x === "string") : undefined,
    pendingSteps: Array.isArray(obj.pendingSteps) ? obj.pendingSteps.filter((x): x is string => typeof x === "string") : undefined,
    findings: Array.isArray(obj.findings) ? obj.findings.filter((x): x is Finding => Boolean(x && typeof x === "object")) as Finding[] : undefined,
    checkpoints: Array.isArray(obj.checkpoints) ? obj.checkpoints.filter((x): x is Checkpoint => Boolean(x && typeof x === "object")) as Checkpoint[] : undefined,
    sharedEvidence: Array.isArray(obj.sharedEvidence) ? obj.sharedEvidence.map(sanitizeFileEvidence).filter((x): x is FileEvidence => Boolean(x)) : undefined,
  };
}

function sanitizeFileEvidence(raw: unknown): FileEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const e = raw as Record<string, unknown>;
  const path = typeof e.path === "string" ? e.path.trim() : "";
  const content = typeof e.content === "string" ? e.content : "";
  const contentHash = typeof e.contentHash === "string" ? e.contentHash.trim() : "";
  const version = typeof e.version === "string" ? e.version.trim() : "";
  if (!path || !contentHash || !version) return undefined;
  return { path, content, contentHash, version, complete: e.complete === true, capturedAt: typeof e.capturedAt === "string" ? e.capturedAt : new Date().toISOString() };
}

function sanitizeEvidence(raw: unknown): PersistedEvidence[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_EVIDENCE_PER_ROUND)
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const e = item as Record<string, unknown>;
      const summary = typeof e.summary === "string" ? clip(e.summary.trim(), MAX_SUMMARY_CHARS) : "";
      const path = typeof e.path === "string" ? e.path.trim() : "";
      if (!summary && !path) return [];
      return [
        {
          needId: typeof e.needId === "string" ? e.needId.trim() : "",
          summary,
          kind: e.kind === "navigation" ? "navigation" : "source",
          path: path || undefined,
          symbol: typeof e.symbol === "string" && e.symbol.trim() ? clip(e.symbol.trim(), 200) : undefined,
          startLine: typeof e.startLine === "number" && Number.isFinite(e.startLine) && e.startLine > 0
            ? e.startLine
            : undefined,
          endLine: typeof e.endLine === "number" && Number.isFinite(e.endLine) && e.endLine > 0
            ? e.endLine
            : undefined,
          excerpt: typeof e.excerpt === "string" && e.excerpt.trim()
            ? e.excerpt
            : undefined,
          sourceHash: typeof e.sourceHash === "string" && e.sourceHash.trim()
            ? e.sourceHash.trim()
            : undefined,
          fileEvidence: sanitizeFileEvidence(e.fileEvidence),
        },
      ];
    });
}

function sanitizeFileChanges(raw: unknown): PersistedFileChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_FILE_CHANGES_PER_ROUND).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const toolName = typeof value.toolName === "string" ? value.toolName.trim() : "";
    const path = typeof value.path === "string" ? clip(value.path.trim(), MAX_FILE_CHANGE_PATH_CHARS) : undefined;
    const summary = typeof value.summary === "string"
      ? clip(value.summary.trim(), MAX_FILE_CHANGE_SUMMARY_CHARS)
      : "";
    if (!toolName || !summary) return [];
    return [{ toolName, path: path || undefined, summary }];
  });
}

function sanitizeToolCalls(raw: unknown): PersistedToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_TOOL_CALLS_PER_ROUND).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const toolName = typeof value.toolName === "string" ? value.toolName.trim() : "";
    if (!toolName || !value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) return [];
    return [{
      id: typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined,
      toolName,
      arguments: value.arguments as Record<string, unknown>,
      result: typeof value.result === "string" && value.result.trim() ? clip(value.result.trim(), MAX_SUMMARY_CHARS) : undefined,
    }];
  });
}

function sanitizeRound(raw: unknown, fallbackIndex: number): TurnRoundRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const userInput = typeof obj.userInput === "string" ? obj.userInput.trim() : "";
  if (!userInput) return null;
  const index = typeof obj.index === "number" && Number.isFinite(obj.index) ? obj.index : fallbackIndex;
  const createdAt = typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString();
  const updatedAt = typeof obj.updatedAt === "string" ? obj.updatedAt : createdAt;
  const evidence = sanitizeEvidence(obj.evidence);
  const fileChanges = sanitizeFileChanges(obj.fileChanges);
  const toolCalls = sanitizeToolCalls(obj.toolCalls);
  return {
    index,
    createdAt,
    updatedAt,
    userInput: clip(userInput, MAX_USER_INPUT_CHARS),
    taskDecompose: sanitizeDecompose(obj.taskDecompose),
    assistantReport:
      typeof obj.assistantReport === "string" && obj.assistantReport.trim()
        ? clip(obj.assistantReport.trim(), MAX_REPORT_CHARS)
        : undefined,
    evidence: evidence.length > 0 ? evidence : undefined,
    fileChanges: fileChanges.length > 0 ? fileChanges : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

async function readFile(workspaceRoot: string, sessionId: string): Promise<TurnRoundsFile> {
  try {
    const raw = await fs.readFile(roundsFilePath(workspaceRoot, sessionId), "utf8");
    const data = JSON.parse(raw) as TurnRoundsFile;
    if (data?.version !== FILE_VERSION || !Array.isArray(data.rounds)) {
      return emptyFile(sessionId);
    }
    const rounds = data.rounds
      .map((r, i) => sanitizeRound(r, i + 1))
      .filter((r): r is TurnRoundRecord => r !== null);
    return { version: FILE_VERSION, sessionId, rounds };
  } catch {
    return emptyFile(sessionId);
  }
}

async function writeFile(workspaceRoot: string, file: TurnRoundsFile): Promise<void> {
  const dir = sessionsDirAbs(workspaceRoot);
  await fs.mkdir(dir, { recursive: true });
  const trimmed: TurnRoundsFile = {
    version: FILE_VERSION,
    sessionId: file.sessionId,
    rounds: file.rounds.length > MAX_ROUNDS ? file.rounds.slice(-MAX_ROUNDS) : file.rounds,
  };
  await fs.writeFile(roundsFilePath(workspaceRoot, file.sessionId), JSON.stringify(trimmed, null, 2) + "\n", "utf8");
}

function nextIndex(rounds: TurnRoundRecord[]): number {
  if (rounds.length === 0) return 1;
  const last = rounds[rounds.length - 1]!;
  return last.index + 1;
}

export function formatDecomposeSummary(d: PersistedDecompose): string {
  // Output the full decomposition result as JSON so the next decompose call
  // can see understanding, userConstraints, steps with informationNeeds and
  // stopReadingWhen — not just a lossy text summary.
  return JSON.stringify(d, null, 2);
}

export function formatRoundBlock(
  round: TurnRoundRecord,
  displayIndex: number,
  options?: { includeProcessInfo?: boolean },
): string {
  const includeProcessInfo = options?.includeProcessInfo ?? true;
  const parts: string[] = [`## Round ${displayIndex}`, `[user] ${round.userInput}`];
  if (round.taskDecompose) {
    parts.push(`[decompose] ${formatDecomposeSummary(round.taskDecompose)}`);
  }
  if (includeProcessInfo && round.evidence && round.evidence.length > 0) {
    const lines = round.evidence.map((e) => {
      const source = [e.path ?? "unknown", e.symbol ? `#${e.symbol}` : ""].filter(Boolean).join(" ");
      const range =
        e.startLine && e.endLine
          ? ` L${e.startLine}${e.endLine !== e.startLine ? `-${e.endLine}` : ""}`
          : "";
      const kind = e.kind === "navigation" ? "navigation" : "source";
      // Pointers only: file bodies are packed locally after decompose.
      // Pasting excerpts here inflates the decompose prompt and thinking time.
      return `- [${kind}] ${e.summary} (${source}${range})`;
    });
    parts.push(`[evidence]\n${lines.join("\n")}`);
  }
  if (includeProcessInfo && round.fileChanges && round.fileChanges.length > 0) {
    const lines = round.fileChanges.map((change) =>
      `- ${change.toolName}${change.path ? ` ${change.path}` : ""}: ${change.summary}`,
    );
    parts.push(`[file changes]\n${lines.join("\n")}`);
  }
  if (includeProcessInfo && round.toolCalls && round.toolCalls.length > 0) {
    // Tool calls are included as a compact activity summary. Keep arguments so
    // the next decomposition can understand the operation and its target, but
    // omit results because read/search output can be very large.
    parts.push(`[tool calls]\n${round.toolCalls.map((call) =>
      `- ${call.toolName} ${JSON.stringify(call.arguments)}`,
    ).join("\n")}`);
  }
  if (round.assistantReport) {
    parts.push(`[assistant] ${round.assistantReport}`);
  }
  return parts.join("\n");
}

/**
 * Format persisted rounds for task_decompose history (newest first).
 *
 * Only the newest round keeps full process info (evidence / fileChanges) by
 * default. If newer rounds were interrupted (no assistantReport) — e.g. user
 * sent "continue" after a break, possibly twice — those consecutive no-report
 * suffix rounds also keep process info. Once a round with a report is reached,
 * that round and all older ones omit evidence/fileChanges (user + decompose +
 * report only). No per-round truncation — callers already limit how many
 * rounds are loaded.
 */
export function formatRoundsForDecomposeHistory(roundsOldestFirst: TurnRoundRecord[]): string[] {
  const newestFirst = roundsOldestFirst.slice().reverse();
  let stillInInterruptedSuffix = true;
  return newestFirst.map((round, idx) => {
    const includeProcessInfo =
      idx === 0 || (stillInInterruptedSuffix && !round.assistantReport);
    if (round.assistantReport) {
      stillInInterruptedSuffix = false;
    }
    return formatRoundBlock(round, idx + 1, { includeProcessInfo });
  });
}

/**
 * Compact path list for the next ReAct turn: last two rounds' reads/writes,
 * without file bodies. The model can `read_file` these paths directly.
 */
export function formatRecentFileHints(roundsOldestFirst: TurnRoundRecord[]): string {
  const newestFirst = roundsOldestFirst.slice().reverse();
  const minProcessRounds = 2;
  let includeProcessInfo = true;
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [idx, round] of newestFirst.entries()) {
    const keepProcess = idx < minProcessRounds || includeProcessInfo;
    if (round.assistantReport) includeProcessInfo = false;
    if (!keepProcess) continue;
    for (const evidence of round.evidence ?? []) {
      if (!evidence.path) continue;
      const key = `r:${evidence.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const range =
        evidence.startLine && evidence.endLine ? ` L${evidence.startLine}-${evidence.endLine}` : "";
      lines.push(`- ${evidence.path}${range}`);
    }
    for (const change of round.fileChanges ?? []) {
      if (!change.path) continue;
      const key = `w:${change.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${change.path} (${change.toolName})`);
    }
  }
  if (lines.length === 0) return "";
  return `**Recently read/edited files (call read_file on these paths directly; do not search for them again)**:\n${lines.join("\n")}`;
}

/**
 * Rebuild file-read evidence from this turn's chat history.
 * Source-read tool output is stored in full; this is what the next
 * task_decompose round should see, not a truncated excerpt.
 */
/** 续接判断只依据已持久化任务状态和语义信号，不依赖固定的 continue 文本。 */
export function classifyTaskRelation(
  message: string,
  previous: TaskState | PersistedDecompose | null | undefined,
): TaskRelation {
  if (!previous) return "new";
  const text = message.trim().toLowerCase();
  const continuation = /继续|接着|上次|刚才|未完成|中断|恢复|前面|progress|resume|pick up|same task/.test(text);
  return continuation ? "continue" : "new";
}

export function makeFileEvidence(path: string, content: string, version: string, complete = true): FileEvidence {
  return { path, content, contentHash: createHash("sha256").update(content).digest("hex"), version, complete, capturedAt: new Date().toISOString() };
}

export function isReusableFileEvidence(evidence: FileEvidence, currentVersion: string, requireComplete = true): boolean {
  return Boolean(evidence.complete || !requireComplete) && evidence.version === currentVersion && evidence.contentHash === createHash("sha256").update(evidence.content).digest("hex");
}

export function collectToolCallsFromTurns(
  turns: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
): PersistedToolCall[] {
  const calls: PersistedToolCall[] = [];
  for (const turn of turns) {
    for (const rawPart of turn.parts ?? []) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (part.type === "tool_use" && typeof part.name === "string" && part.input && typeof part.input === "object") {
        const call: PersistedToolCall = {
          id: typeof part.id === "string" ? part.id : undefined,
          toolName: part.name,
          arguments: part.input as Record<string, unknown>,
        };
        calls.push(call);
      }
    }
  }
  return calls.slice(-MAX_TOOL_CALLS_PER_ROUND);
}

export function collectToolCallsFromMessages(
  messages: ReadonlyArray<{
    role?: string;
    tool_call_id?: string;
    tool_calls?: ReadonlyArray<{
      id?: string;
      function?: { name?: string; arguments?: string };
    }>;
    content?: unknown;
  }>,
): PersistedToolCall[] {
  const calls: PersistedToolCall[] = [];
  const byId = new Map<string, PersistedToolCall>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const raw of message.tool_calls) {
        const toolName = raw.function?.name?.trim();
        if (!toolName) continue;
        let arguments_: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(raw.function?.arguments ?? "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            arguments_ = parsed as Record<string, unknown>;
          }
        } catch {
          // Preserve the call even if a provider returned malformed arguments.
        }
        const call: PersistedToolCall = {
          id: raw.id?.trim() || undefined,
          toolName,
          arguments: arguments_,
        };
        calls.push(call);
        if (call.id) byId.set(call.id, call);
      }
    } else if (message.role === "tool" && message.tool_call_id) {
      const call = byId.get(message.tool_call_id);
      const result = typeof message.content === "string" ? message.content.trim() : "";
      if (call && result) call.result = result;
    }
  }
  return calls.slice(-MAX_TOOL_CALLS_PER_ROUND);
}

export async function persistRoundToolCalls(
  workspaceRoot: string,
  sessionId: string,
  userInput: string,
  roundIndex: number | undefined,
  toolCalls: PersistedToolCall[],
): Promise<void> {
  if (!isSafeSessionId(sessionId) || toolCalls.length === 0) return;
  await withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    const file = await readFile(workspaceRoot, sessionId);
    const clippedInput = clip(userInput.trim(), MAX_USER_INPUT_CHARS);
    const target =
      (typeof roundIndex === "number" ? file.rounds.find((r) => r.index === roundIndex) : undefined) ??
      (file.rounds.at(-1)?.userInput === clippedInput ? file.rounds.at(-1) : undefined);
    if (!target) return;
    target.toolCalls = sanitizeToolCalls(toolCalls);
    target.updatedAt = new Date().toISOString();
    await writeFile(workspaceRoot, file);
  });
}

export function collectReadEvidenceFromTurns(
  turns: ReadonlyArray<{ role: string; toolName?: string; content?: string }>,
): PersistedEvidence[] {
  const items: PersistedEvidence[] = [];
  for (const turn of turns) {
    if (turn.role !== "tool" || !turn.toolName || !SOURCE_READ_TOOLS.has(turn.toolName)) continue;
    const content = turn.content?.trim();
    if (!content) continue;
    const head = content.slice(0, 240);
    if (
      /^Error:/i.test(head) ||
      /^Failed /i.test(head) ||
      new RegExp(`^${turn.toolName}\\s+failed\\b`, "i").test(head) ||
      /\bfailed to read\b/i.test(head)
    ) continue;
    const readHeader = content.match(/^Read (.+?) \(lines (\d+)-(\d+) of \d+\)/);
    const namedHeader = content.match(/^(read_symbol|read_outline)\s+(\S+)/);
    const linesHeader = content.match(/\[lines (\d+)-(\d+) of (\d+)\]/);
    const path = readHeader?.[1] ?? namedHeader?.[2];
    const startLine = readHeader
      ? Number(readHeader[2])
      : linesHeader
        ? Number(linesHeader[1])
        : undefined;
    const endLine = readHeader
      ? Number(readHeader[3])
      : linesHeader
        ? Number(linesHeader[2])
        : undefined;
    items.push({
      needId: "",
      summary: path
        ? `Read ${path}${startLine && endLine ? ` lines ${startLine}-${endLine}` : ""}`
        : `Read via ${turn.toolName}`,
      kind: turn.toolName === "read_outline" ? "navigation" : "source",
      path,
      startLine,
      endLine,
      excerpt: content,
      fileEvidence: path ? makeFileEvidence(path, content, createHash("sha256").update(content).digest("hex"), true) : undefined,
    });
  }
  return items;
}

/** Last `limit` rounds, oldest-first. Waits for in-flight writes to the same session. */
export async function loadRecentRounds(
  workspaceRoot: string,
  sessionId: string,
  limit: number,
): Promise<TurnRoundRecord[]> {
  if (!isSafeSessionId(sessionId) || limit <= 0) return [];
  return withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    const file = await readFile(workspaceRoot, sessionId);
    return file.rounds.slice(-limit);
  });
}

export async function persistDecomposeRound(
  workspaceRoot: string,
  sessionId: string,
  userInput: string,
  decompose: PersistedDecompose,
  toolCalls: PersistedToolCall[] = [],
): Promise<TurnRoundRecord | null> {
  const input = userInput.trim();
  const cleaned = sanitizeDecompose(decompose);
  if (!isSafeSessionId(sessionId) || !input || !cleaned) return null;

  return withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    const file = await readFile(workspaceRoot, sessionId);
    const now = new Date().toISOString();
    const last = file.rounds[file.rounds.length - 1];
    // Same user turn still open (decompose ran, report not written yet) → update in place.
    if (last && last.userInput === clip(input, MAX_USER_INPUT_CHARS) && !last.assistantReport) {
      last.taskDecompose = cleaned;
      if (toolCalls.length > 0) last.toolCalls = sanitizeToolCalls(toolCalls);
      last.updatedAt = now;
      await writeFile(workspaceRoot, file);
      return last;
    }
    const record: TurnRoundRecord = {
      index: nextIndex(file.rounds),
      createdAt: now,
      updatedAt: now,
      userInput: clip(input, MAX_USER_INPUT_CHARS),
      taskDecompose: cleaned,
      toolCalls: toolCalls.length > 0 ? sanitizeToolCalls(toolCalls) : undefined,
    };
    file.rounds.push(record);
    await writeFile(workspaceRoot, file);
    return record;
  });
}

export async function persistRoundReport(
  workspaceRoot: string,
  sessionId: string,
  userInput: string,
  assistantReport: string,
  roundIndex?: number,
): Promise<TurnRoundRecord | null> {
  const input = userInput.trim();
  const report = assistantReport.trim();
  if (!isSafeSessionId(sessionId) || !input || !report) return null;

  return withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    const file = await readFile(workspaceRoot, sessionId);
    const now = new Date().toISOString();
    const clippedReport = clip(report, MAX_REPORT_CHARS);
    const clippedInput = clip(input, MAX_USER_INPUT_CHARS);

    const byIndex =
      typeof roundIndex === "number"
        ? file.rounds.find((r) => r.index === roundIndex)
        : undefined;
    const last = file.rounds[file.rounds.length - 1];
    const target = byIndex ?? (last && last.userInput === clippedInput ? last : undefined);

    if (target) {
      target.assistantReport = clippedReport;
      target.updatedAt = now;
      await writeFile(workspaceRoot, file);
      return target;
    }

    const record: TurnRoundRecord = {
      index: nextIndex(file.rounds),
      createdAt: now,
      updatedAt: now,
      userInput: clippedInput,
      assistantReport: clippedReport,
    };
    file.rounds.push(record);
    await writeFile(workspaceRoot, file);
    return record;
  });
}

/**
 * Append verified evidence to the round identified by roundIndex.
 * If roundIndex is omitted, falls back to the last round matching userInput.
 * Called after the ReAct loop finishes so the next decompose can see what was read.
 */
export async function persistRoundEvidence(
  workspaceRoot: string,
  sessionId: string,
  userInput: string,
  roundIndex: number | undefined,
  evidenceItems: PersistedEvidence[],
): Promise<void> {
  if (!isSafeSessionId(sessionId) || evidenceItems.length === 0) return;

  await withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    const file = await readFile(workspaceRoot, sessionId);
    const clippedInput = clip(userInput.trim(), MAX_USER_INPUT_CHARS);
    const last = file.rounds[file.rounds.length - 1];
    const target =
      (typeof roundIndex === "number"
        ? file.rounds.find((r) => r.index === roundIndex)
        : undefined) ??
      (last && last.userInput === clippedInput ? last : undefined);
    if (!target) return;

    const bySlot = new Map<string, PersistedEvidence>();
    for (const item of target.evidence ?? []) {
      bySlot.set(evidenceSlotKey(item), item);
    }
    for (const item of evidenceItems) {
      bySlot.set(evidenceSlotKey(item), item);
    }
    const merged = [...bySlot.values()];
    target.evidence = merged.length > MAX_EVIDENCE_PER_ROUND
      ? merged.slice(-MAX_EVIDENCE_PER_ROUND)
      : merged;
    target.updatedAt = new Date().toISOString();
    await writeFile(workspaceRoot, file);
  });
}

function evidenceSlotKey(
  item: Pick<PersistedEvidence, "needId" | "path" | "startLine" | "endLine">,
): string {
  if (item.needId) return `need:${item.needId}`;
  return `snippet:${item.path ?? ""}:${item.startLine ?? "?"}-${item.endLine ?? "?"}`;
}

export async function persistRoundFileChanges(
  workspaceRoot: string,
  sessionId: string,
  userInput: string,
  roundIndex: number | undefined,
  changes: PersistedFileChange[],
): Promise<void> {
  if (!isSafeSessionId(sessionId) || changes.length === 0) return;
  await withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    const file = await readFile(workspaceRoot, sessionId);
    const clippedInput = clip(userInput.trim(), MAX_USER_INPUT_CHARS);
    const last = file.rounds[file.rounds.length - 1];
    const target =
      (typeof roundIndex === "number" ? file.rounds.find((r) => r.index === roundIndex) : undefined) ??
      (last && last.userInput === clippedInput ? last : undefined);
    if (!target) return;
    const existing = target.fileChanges ?? [];
    const merged = [...existing, ...changes]
      .slice(-MAX_FILE_CHANGES_PER_ROUND)
      .map((change) => ({
        toolName: change.toolName.trim(),
        path: change.path ? clip(change.path.trim(), MAX_FILE_CHANGE_PATH_CHARS) : undefined,
        summary: clip(change.summary.trim(), MAX_FILE_CHANGE_SUMMARY_CHARS),
      }))
      .filter((change) => change.toolName && change.summary);
    target.fileChanges = merged.length > 0 ? merged : undefined;
    target.updatedAt = new Date().toISOString();
    await writeFile(workspaceRoot, file);
  });
}

/** Drop the last round, used when regenerating the last reply. */
export async function dropLastRound(
  workspaceRoot: string,
  sessionId: string,
  userInput?: string,
): Promise<boolean> {
  if (!isSafeSessionId(sessionId)) return false;
  return withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    const file = await readFile(workspaceRoot, sessionId);
    const last = file.rounds[file.rounds.length - 1];
    if (!last) return false;
    if (userInput && last.userInput !== clip(userInput.trim(), MAX_USER_INPUT_CHARS)) return false;
    file.rounds.pop();
    await writeFile(workspaceRoot, file);
    return true;
  });
}

export async function deleteSessionRounds(workspaceRoot: string, sessionId: string): Promise<void> {
  if (!isSafeSessionId(sessionId)) return;
  await withSessionLock(queueKey(workspaceRoot, sessionId), async () => {
    try {
      await fs.unlink(roundsFilePath(workspaceRoot, sessionId));
    } catch {
      /* missing is fine */
    }
  });
}
