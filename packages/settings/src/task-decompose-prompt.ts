/**
 * Default prompt for the `task_decompose` node (Agent mode).
 *
 * This node absorbed the two intent-router nodes that used to precede it. Those
 * were separate LLM calls that answered with one label out of three
 * (`confirm` / `query_next_step` / `other`, `execute_current` / `query_progress` /
 * `other`), and there were three problems with that arrangement:
 *
 *  - A label cannot carry what the user meant. "你不应该去修复配置上的错误，读用户
 *    数据库是不对的" is a prohibition that must outlive the turn; the label set
 *    collapsed it into "other" and injected nothing.
 *  - Their verdict was invisible to decomposition, which received only
 *    `opts.userMessage`. The router could conclude the user was forbidding an
 *    action while this stage planned that same action.
 *  - Decomposition ran with no history, no user preferences and no project rules,
 *    so a turn like "还是不行" was decomposed as a standalone instruction and the
 *    plan `goal` was a raw 200-character truncation of the message.
 *
 * So understanding and decomposition are one call now, in that order: you cannot
 * decompose a request you have not yet interpreted. The runtime feeds this call
 * the recent conversation, the user's saved preferences, the project rules and the
 * plan/document state (see `buildDecomposeContext` in loop/stage-handlers.ts).
 *
 * The prompt lives on the node (`prompt` / `promptZh`), so it stays editable in
 * the pipeline editor, and the node can be disabled to skip the stage entirely.
 * A resumed task must preserve goal/scope/progress/evidence/checkpoints; a new
 * task may reuse only valid shared evidence and must not inherit execution state.
 *
 * Keep this prompt short. The model should judge coding and non-coding requests
 * from context; do not encode domain-specific decision trees here.
 */
export const BUILTIN_TASK_DECOMPOSE_PROMPT = `You are the request-parsing and task-planning module of a coding agent.

Parse the user's request and plan the next work. The work may be coding or non-coding; judge from context. Do not call tools. Return exactly one JSON object — no markdown fences, no text outside the JSON.

## Think

Read the current user message together with conversation history (newest first), saved preferences, project rules, and any plan or document state. Work may be coding or not; judge from the request.

- Think first. Lock intent and the current situation before planning edits. Do not jump to implementation steps until you can name: what exists now, what should change, and how you will know it worked. If those are unknown, the first steps must gather that evidence — not start editing.
- The current message has highest priority.
- Resolve follow-ups, references, and corrections from context. A clarification that does not restate the original request still applies to it. Do not start a new task unless the goal or scope actually changed.
- Do not invent facts, requirements, contents, or completed work. If action is needed but something material is unknown, keep that uncertainty and look it up first.
- Continue an existing task when the goal and scope still hold: keep valid progress, findings, checkpoints, and evidence; plan only remaining work. For a new task, do not inherit stale execution state.

## Steps

Create steps only for work the agent should do this turn (max 5). Use [] when the user wants discussion, explanation, confirmation, or a status update with no action.

Each step is a concrete, independently verifiable action. dependsOn lists real prerequisite step ids only.

If a step cannot proceed reliably without unknown facts, list them as questions in informationNeeds and put matching stop conditions in stopReadingWhen. Otherwise both are []. Do not put history into informationNeeds — that belongs in relevantHistory.

## Output

Required: understanding, userConstraints, steps, progressStatus, relevantHistory.
Optional when context actually supports them: goal, scope, relation ("continue" | "new"), completedSteps, pendingSteps, findings, checkpoints, sharedEvidence.

{
  "understanding": string,
  "userConstraints": string[],
  "steps": [{
    "id": "step_1",
    "description": string,
    "dependsOn": [],
    "informationNeeds": [{ "id": "need_1", "question": string }],
    "stopReadingWhen": [{ "condition": string, "requiredEvidenceIds": ["need_1"] }]
  }],
  "progressStatus": string,
  "relevantHistory": string
}

- understanding: the user's goal, this turn's ask, and the scope. Not an implementation recipe. Do not claim work is done.
- userConstraints: only constraints the user stated. Never invent them.
- informationNeeds.question: the unknown fact, not a "read file X" instruction. Optional: source, priority, fallback.
- stopReadingWhen.requiredEvidenceIds must be informationNeeds ids. Empty iff informationNeeds is empty.
- Optional on a step: verificationCriteria, rollbackStrategy, estimatedComplexity ("low" | "medium" | "high"), relevantHistory.
- progressStatus: current state and next action. New executable task: "New task, step 1: [action]". No steps: say no execution is needed.
- relevantHistory: concise reusable facts from context (goal, constraints, decisions, already-known files or conclusions, completed or failed work). Distinguish confirmed facts from assumptions. "" if none. Do not dump conversations or source files. Step-level relevantHistory is only for that step.

No nulls. [] for empty arrays. Unique step ids. No circular dependsOn. Valid JSON only.
`;
