import type { TaskItem } from "../../plans.ts";

/**
 * Plan / task state for the Agent pipeline, rendered for prompt context.
 *
 * This used to feed a dedicated intent-classifier node. That node is gone: a
 * separate call that answered with one label out of three could not express what
 * the user actually meant, and its verdict was invisible to task decomposition,
 * so the two could contradict each other. The state itself is still needed —
 * decomposition reads it to tell "continue the approved task" apart from "here is
 * new work".
 */

export function selectAgentCurrentTask(
  tasks: readonly TaskItem[] | undefined,
  currentTaskId: string | null | undefined,
): TaskItem | null {
  if (!tasks?.length) return null;
  const runnable = (task: TaskItem) => task.status === "pending" || task.status === "in_progress";
  const selected = currentTaskId ? tasks.find((task) => task.id === currentTaskId) : undefined;
  return selected && runnable(selected) ? selected : tasks.find(runnable) ?? null;
}

/** Read-only plan-progress block for prompt context. Returns null when there is
 * no active plan, so the caller can omit the section entirely instead of
 * emitting a placeholder that confuses downstream stages. */
export function agentIntentContext(
  activePlan: { path: string; content: string } | null | undefined,
  tasks: readonly TaskItem[] | undefined,
  currentTaskId: string | null | undefined,
): string | null {
  if (!activePlan || !tasks?.length) {
    return null;
  }
  const completed = tasks.filter(
    (task) => task.status === "completed" || task.status === "skipped",
  ).length;
  const current = selectAgentCurrentTask(tasks, currentTaskId);
  return [
    `Active plan: ${activePlan.path}`,
    `Progress: ${completed}/${tasks.length} tasks completed.`,
    current
      ? `Current task: ${current.id} — ${current.description}` +
        (current.acceptance ? `\nAcceptance: ${current.acceptance}` : "")
      : "No runnable task remains in the plan.",
  ].join("\n");
}
